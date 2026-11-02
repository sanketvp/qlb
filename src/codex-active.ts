import { createHash } from 'node:crypto';

import { accessExpiry, codexAuthFileSha256, codexAuthFileText, codexFingerprint, codexIdentity, needsRefresh, type CodexAuthDocument, type CodexAuthStableWithStatResult } from './codex-auth';
import { ClaudeCodeLockTimeout, CodexAuthLockCompromised, ProperLockfileCompromised, withCodexAuthLock } from './cc-locks';
import { consumeCodexSlot, withCodexConsumeThenSwitchLocks, type CodexConsumeResult } from './codex-consume';
import { codexIdentityParts, holderSets, readCodexSwitchHistory, renewers, type CodexProcess } from './codex-sessions';
import { CodexLiveChanged, attributeForPhase, codexRecoveryFenceState, observeLiveCodex, publishCodexAuth, type CodexPhaseAttribution, type CodexRecoveryFenceState, type CodexSwitchDeps } from './codex-switch';
import { CodexStashUnverifiable } from './codex-slots';

const NEAR_EXPIRY_MS = 5 * 60_000;

/** Dependencies for the active Codex renewer. All external effects are injected. */
export type CodexActiveDeps = Pick<CodexSwitchDeps,
  'store' | 'readLive' | 'cswapProcesses' | 'now' | 'attempt' | 'authLockOptions'
> & {
  dbPath: string;
  slots: NonNullable<CodexSwitchDeps['slots']>;
  keychain: NonNullable<CodexSwitchDeps['keychain']>;
  authPath: string;
  list: () => Promise<CodexProcess[]>;
  transport: NonNullable<CodexSwitchDeps['transport']>;
  journalDir: string;
  lockTimeoutMs?: number;
  withLocks?: <T>(accountId: string, fn: (assertHeld: () => void) => Promise<T> | T) => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
  autoLog?: (line: string) => void;
  /** Production signal deferral seam; it is not a test barrier. */
  signalWindow?: { enter(): void; exit(): void };
  hooks?: CodexActiveHooks;
};

export interface CodexActiveHooks {
  afterCheck?: () => void | Promise<void>;
  afterLock?: () => void | Promise<void>;
  afterObserve?: () => void | Promise<void>;
  beforeSend?: () => void | Promise<void>;
  afterPost?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
  beforeVerify?: () => void | Promise<void>;
}

export type CodexActiveInput =
  | { trigger: 'unauthorized'; accessFp: string; mode?: 'refresh' | 'reconcile' }
  | { trigger: 'proactive-expiry' | 'scheduled'; mode?: 'refresh' | 'reconcile' };

export type CodexActiveRefusalReason =
  | 'active-login-unset'
  | 'active-slot-missing'
  | 'cswap-process-alive'
  | 'cswap-process-check-failed'
  | 'codex-process-check-failed'
  | 'codex-logged-out'
  | 'codex-auth-unreadable'
  | 'wiped'
  | 'republish-failed'
  | 'unknown-live-identity'
  | 'stash-unverifiable'
  | 'slot-split'
  | 'switch-in-flight';

export type CodexActiveAction = Extract<CodexPhaseAttribution['action'], 'noop' | 'adopt' | 'republish-slot'>;
type CodexActiveExternalAction = CodexPhaseAttribution['action'];
export type CodexLiveWriteCause = 'post' | 'republish';
export type CodexLiveReadFailure = 'unstable' | 'missing' | 'wiped' | 'unreadable';
export type CodexRepublishResult = 'ok' | 'unwritten' | 'external' | 'unverified';

/** The closed result union returned by the active Codex refresh workflow. */
export type CodexActiveOutcome =
  | { status: 'posted'; document: CodexAuthDocument }
  | { status: 'republished'; document: CodexAuthDocument }
  | { status: 'adopted'; document: CodexAuthDocument }
  | { status: 'noop'; document: CodexAuthDocument }
  | { status: 'rotated'; document: CodexAuthDocument }
  | { status: 'held'; pids: number[]; document: CodexAuthDocument; action: CodexActiveAction }
  | { status: 'codex-won'; adopted: boolean; pids: number[]; document: CodexAuthDocument }
  | { status: 'dead'; reason: string }
  | { status: 'superseded'; document: CodexAuthDocument }
  | { status: 'transient'; reason?: string }
  | { status: 'posted-live-unwritten'; document: CodexAuthDocument; cause: CodexLiveWriteCause }
  | { status: 'posted-live-external'; document: CodexAuthDocument; action: CodexActiveExternalAction; cause: CodexLiveWriteCause }
  | { status: 'posted-live-unverified'; document: CodexAuthDocument; read: CodexLiveReadFailure; cause: CodexLiveWriteCause }
  | { status: 'stashed'; stashId?: string }
  | { status: 'unpersisted' }
  | { status: 'deferred'; reason: 'codex-writing' | 'locks-held' }
  | { status: 'drift'; accountId: string | null; republish?: CodexRepublishResult }
  | { status: 'fenced'; reason: string; message: string; accounts: Extract<CodexRecoveryFenceState, { state: 'fenced' }>['accounts'] }
  | { status: 'refused'; reason: CodexActiveRefusalReason };

/** A process-list failure, deliberately without the underlying error or any credential document. */
export class CodexProcessCheckFailed extends Error {
  constructor() {
    super('Codex process check failed');
    this.name = 'CodexProcessCheckFailed';
  }
}

/** An active-refresh observation write failed; deliberately carries no document or token. */
export class CodexObservationWriteFailed extends Error {
  constructor() {
    super('Codex observation write failed');
    this.name = 'CodexObservationWriteFailed';
  }
}

/** Converts process discovery failures into the typed, credential-free active-refresh failure. */
export function listOrFail(list: () => Promise<CodexProcess[]>): () => Promise<CodexProcess[]> {
  return async () => {
    try {
      return await list();
    } catch {
      throw new CodexProcessCheckFailed();
    }
  };
}

export type CodexActiveExpiry = {
  state: 'usable' | 'near-expiry' | 'expired' | 'unknown';
  expiresAt: number | null;
  leftMs: number | null;
};

/** Classifies a live token for the active renewer without retaining its value. */
export function classifyActiveCodexExpiry(doc: CodexAuthDocument, now: number): CodexActiveExpiry {
  const expiresAt = accessExpiry(doc);
  if (expiresAt === null) return { state: 'unknown', expiresAt: null, leftMs: null };
  const leftMs = expiresAt - now;
  if (leftMs <= 0) return { state: 'expired', expiresAt, leftMs };
  if (leftMs <= NEAR_EXPIRY_MS) return { state: 'near-expiry', expiresAt, leftMs };
  return { state: 'usable', expiresAt, leftMs };
}

/** Returns processes capable of renewing an active identity, conservatively treating every listed process as a renewer when history has no holder identity evidence. */
export async function activeCodexRenewers(
  deps: Pick<CodexActiveDeps, 'dbPath' | 'journalDir' | 'list'>,
  accountId: string,
): Promise<CodexProcess[]> {
  const history = readCodexSwitchHistory(deps.dbPath, { journalDir: deps.journalDir });
  const processes = await listOrFail(deps.list)();
  if (!holderSets(history.rows, history.observations).some((set) => set.identities.length > 0)) return processes;
  return renewers(codexIdentityParts(accountId), processes, history.rows, history.observations);
}

/** Adapter used by C10 so both pre- and post-request holder checks use active eras. */
export function holdersFor(
  deps: Pick<CodexActiveDeps, 'dbPath' | 'journalDir' | 'list'>,
  accountId: string,
): (document: CodexAuthDocument) => Promise<CodexProcess[]> {
  return async (_document) => activeCodexRenewers(deps, accountId);
}

/** A non-reversible, value-free access-token identifier for 401 attribution. */
export function accessFingerprint(doc: CodexAuthDocument): string {
  return `sha256-at:${createHash('sha256').update(doc.tokens.access_token, 'utf8').digest('hex')}`;
}

/** Whether the active document needs a refresh for this trigger. */
export function isDueForRefresh(
  doc: CodexAuthDocument,
  now: number,
  trigger: CodexActiveInput['trigger'],
): boolean {
  return trigger === 'unauthorized' || needsRefresh(doc, now);
}

/** Hold the consume, switch, and auth locks in the order required by active reconciliation. */
export async function withActiveCodexLocks<T>(
  deps: CodexActiveDeps,
  accountId: string,
  fn: (assertHeld: () => void) => Promise<T> | T,
): Promise<T> {
  if (deps.withLocks) return deps.withLocks(accountId, fn);
  return withCodexConsumeThenSwitchLocks(deps.dbPath, accountId, (consumeLock, switchLock) =>
    withCodexAuthLock({ ...deps.authLockOptions, ...(deps.lockTimeoutMs === undefined ? {} : { timeoutMs: deps.lockTimeoutMs }) }, (authLock) => fn(() => {
      consumeLock.assertNotCompromised();
      switchLock.assertNotCompromised();
      authLock.assertNotCompromised();
    })), { timeoutMs: deps.lockTimeoutMs });
}

type SettledRepublishClass = CodexRepublishResult;

/**
 * Classify the stable read made after a settled republish before treating the
 * slot document as live.  In particular, never trust outgoing's stat pair:
 * settle intentionally replaces it with the post-publish stat pair.
 */
function classifySettledRepublish(
  outgoing: CodexAuthDocument,
  postPublish: CodexAuthStableWithStatResult | undefined,
): SettledRepublishClass {
  if (!postPublish || postPublish.status !== 'ok') return 'unverified';
  return postPublish.sha256 === codexAuthFileSha256(codexAuthFileText(outgoing)) ? 'ok' : 'external';
}

function republishFailureOutcome(
  document: CodexAuthDocument,
  result: Exclude<SettledRepublishClass, 'ok' | 'external'>,
  postPublish: CodexAuthStableWithStatResult | undefined,
): Exclude<CodexActiveOutcome, { status: 'drift' }> {
  if (result === 'unwritten') return { status: 'posted-live-unwritten', document, cause: 'republish' };
  const read = postPublish?.status;
  return { status: 'posted-live-unverified', document,
    read: read === 'unstable' || read === 'missing' || read === 'wiped' || read === 'unreadable' ? read : 'unreadable', cause: 'republish' };
}

function uniquePids(...groups: CodexProcess[][]): number[] {
  return [...new Set(groups.flatMap((group) => group.map(({ pid }) => pid)))];
}

function isFence(
  fence: CodexRecoveryFenceState,
): fence is Extract<CodexRecoveryFenceState, { state: 'fenced' }> {
  return fence.state === 'fenced';
}

/**
 * The stable post-publish read is a fresh live observation, rather than a
 * confirmation of the observation made before the rename.  A write failure is
 * intentionally distinguishable from failures in the surrounding observation.
 */
function observationWriteGuard(deps: CodexActiveDeps): CodexSwitchDeps {
  // Store methods live on the class prototype, so preserve that prototype
  // rather than spreading the instance into a partial object.
  const store = Object.create(deps.store) as CodexSwitchDeps['store'];
  store.recordCodexObservation = (input) => {
    try {
      return deps.store.recordCodexObservation(input);
    } catch {
      throw new CodexObservationWriteFailed();
    }
  };
  return { ...deps, store } as CodexSwitchDeps;
}

function recordSettledRepublishObservation(
  deps: Pick<CodexSwitchDeps, 'store' | 'now'>,
  assertHeld: () => void,
  postPublish: CodexAuthStableWithStatResult | undefined,
): void {
  if (!postPublish || (postPublish.status !== 'ok' && postPublish.status !== 'wiped')) return;
  assertHeld();
  deps.store.recordCodexObservation(postPublish.status === 'ok'
    ? { identity: codexIdentity(postPublish.doc), lineageFp: codexFingerprint(postPublish.doc), by: 'qlb-active', now: deps.now() }
    : { identity: null, lineageFp: null, by: 'qlb-active', now: deps.now() });
}

async function attributeSettledExternal(
  deps: CodexActiveDeps,
  assertHeld: () => void,
  accountId: string,
  live: CodexAuthDocument,
): Promise<CodexActiveExternalAction> {
  const slot = deps.store.getCodexSlot(accountId);
  if (!slot) throw new Error('Codex active slot disappeared during post-publish verification');
  const document = deps.slots.readSlot(accountId, { fresh: true }).document;
  const history = readCodexSwitchHistory(deps.dbPath, { journalDir: deps.journalDir });
  const processes = await listOrFail(deps.list)();
  const liveIdentity = codexIdentity(live);
  const holders = liveIdentity === null
    ? []
    : renewers(codexIdentityParts(liveIdentity), processes, history.rows, history.observations);
  const attribution = await attributeForPhase({ assertHeld }, 'post', {
    store: deps.store,
    keychain: deps.keychain,
    slot: { accountId, document, fingerprint: slot.fingerprint ?? undefined },
    activeSlotId: deps.store.getCodexActiveLogin() ?? undefined,
    activeSetBy: 'adopt',
    live,
    holderObservation: { aliveBefore: holders.length > 0, aliveAfter: holders.length > 0 },
    l40Verified: deps.store.getConfig('codex.l40Verified') === '1',
    now: deps.now,
  });
  return attribution.action;
}

/**
 * C10 has already recorded `pending_adopt` for a reused grant.  Attribution
 * is still needed to distinguish noop from an unsafe live identity, but a
 * same-lineage noop must leave that C10 state (and active_login.set_by) alone.
 */
async function attributeCodexWon(
  deps: CodexActiveDeps,
  assertHeld: () => void,
  accountId: string,
  live: CodexAuthDocument,
): Promise<CodexActiveExternalAction> {
  const slot = deps.store.getCodexSlot(accountId);
  if (!slot) throw new Error('Codex active slot disappeared during post-reuse verification');
  const document = deps.slots.readSlot(accountId, { fresh: true }).document;
  const store = Object.create(deps.store) as CodexSwitchDeps['store'];
  // `attributeSameSlot` normally marks a noop imported/active.  Suppress only
  // that mark: C10's pending_adopt is the durable watch hand-off here.
  store.markCodexSlotImportedActive = (slotId, ...args) => slotId === accountId
    ? true
    : deps.store.markCodexSlotImportedActive(slotId, ...args);
  const attribution = await attributeForPhase({ assertHeld }, 'post', {
    store,
    keychain: deps.keychain,
    slot: { accountId, document, fingerprint: slot.fingerprint ?? undefined },
    activeSlotId: deps.store.getCodexActiveLogin() ?? undefined,
    activeSetBy: 'adopt',
    live,
    holderObservation: { aliveBefore: true, aliveAfter: true },
    l40Verified: deps.store.getConfig('codex.l40Verified') === '1',
    now: deps.now,
  });
  return attribution.action;
}

/**
 * Observe and reconcile the active Codex document under the three active
 * locks.  This is deliberately the pre-POST half of the refresh workflow.
 */
export async function reconcileActiveCodexLive(deps: CodexActiveDeps): Promise<CodexActiveOutcome> {
  return refreshActiveCodexLogin(deps, { trigger: 'proactive-expiry', mode: 'reconcile' });
}

function recordActiveObservation(
  deps: Pick<CodexActiveDeps, 'store' | 'now'>,
  live: CodexAuthStableWithStatResult,
): void {
  if (live.status !== 'ok' && live.status !== 'wiped') return;
  try {
    deps.store.recordCodexObservation(live.status === 'ok'
      ? { identity: codexIdentity(live.doc), lineageFp: codexFingerprint(live.doc), by: 'qlb-active', now: deps.now() }
      : { identity: null, lineageFp: null, by: 'qlb-active', now: deps.now() });
  } catch {
    throw new CodexObservationWriteFailed();
  }
}

function liveReadFailure(live: CodexAuthStableWithStatResult): CodexLiveReadFailure {
  return live.status === 'unstable' || live.status === 'missing' || live.status === 'wiped' || live.status === 'unreadable'
    ? live.status
    : 'unreadable';
}

async function publishActiveDocument(
  deps: CodexActiveDeps,
  assertHeld: () => void,
  accountId: string,
  outgoing: { document: CodexAuthDocument; sha256: string; inode: number },
  document: CodexAuthDocument,
  cause: CodexLiveWriteCause,
): Promise<CodexActiveOutcome> {
  await deps.hooks?.beforeRename?.();
  assertHeld();
  const cas = await deps.readLive();
  if (cas.status !== 'ok' || cas.sha256 !== outgoing.sha256 || cas.inode !== outgoing.inode) {
    if (cas.status === 'ok') {
      recordActiveObservation(deps, cas);
      const action = await attributeSettledExternal(deps, assertHeld, accountId, cas.doc);
      return { status: 'posted-live-external', document, action, cause };
    }
    if (cas.status === 'wiped') recordActiveObservation(deps, cas);
    return { status: 'posted-live-unverified', document, read: liveReadFailure(cas), cause };
  }

  assertHeld();
  const publish = await publishCodexAuth(deps.authPath, document);
  if (publish.stage === 'rename-threw') return { status: 'posted-live-unwritten', document, cause };
  await deps.hooks?.afterRename?.();
  await deps.hooks?.beforeVerify?.();
  assertHeld();
  const verified = await deps.readLive();
  if (verified.status !== 'ok') {
    if (verified.status === 'wiped') recordActiveObservation(deps, verified);
    return { status: 'posted-live-unverified', document, read: liveReadFailure(verified), cause };
  }
  if (codexIdentity(verified.doc) === accountId && codexFingerprint(verified.doc) === codexFingerprint(document)) {
    recordActiveObservation(deps, verified);
    return cause === 'post' ? { status: 'posted', document } : { status: 'republished', document };
  }
  if (verified.sha256 === outgoing.sha256 && verified.inode === outgoing.inode) {
    return { status: 'posted-live-unwritten', document, cause };
  }
  recordActiveObservation(deps, verified);
  const action = await attributeSettledExternal(deps, assertHeld, accountId, verified.doc);
  return { status: 'posted-live-external', document, action, cause };
}

function logLiveWriteFailure(deps: CodexActiveDeps, accountId: string, outcome: CodexActiveOutcome): void {
  if (outcome.status === 'posted-live-unwritten' || outcome.status === 'posted-live-external' || outcome.status === 'posted-live-unverified') {
    deps.autoLog?.(`codex:live-write-failed provider=openai-codex account=${accountId} cause=${outcome.cause} at=${deps.now()}`);
  }
}

function processCheckFailure(deps: CodexActiveDeps): { status: 'refused'; reason: 'codex-process-check-failed' } {
  deps.autoLog?.(`codex:process-check-failed provider=openai-codex at=${deps.now()}`);
  return { status: 'refused', reason: 'codex-process-check-failed' };
}

/** Refreshes a due active login after completing the locked live reconciliation. */
export async function refreshActiveCodexLogin(deps: CodexActiveDeps, input: CodexActiveInput): Promise<CodexActiveOutcome> {
  try {
    if (deps.cswapProcesses().length > 0) return { status: 'refused', reason: 'cswap-process-alive' };
  } catch {
    return { status: 'refused', reason: 'cswap-process-check-failed' };
  }

  const active = deps.store.getCodexActiveLogin();
  if (active === null) return { status: 'refused', reason: 'active-login-unset' };
  if (deps.store.getCodexSlot(active) === null) return { status: 'refused', reason: 'active-slot-missing' };

  let pids1: CodexProcess[];
  try {
    pids1 = await activeCodexRenewers(deps, active);
  } catch (error) {
    if (error instanceof CodexProcessCheckFailed) return processCheckFailure(deps);
    throw error;
  }
  await deps.hooks?.afterCheck?.();

  let postIssued = false;
  let postOutcome: CodexActiveOutcome | undefined;
  const finishPostOutcome = (outcome: CodexActiveOutcome): CodexActiveOutcome => {
    if (postIssued) postOutcome = outcome;
    return outcome;
  };
  try {
    return await withActiveCodexLocks(deps, active, async (assertHeld) => {
      await deps.hooks?.afterLock?.();
      const fence = codexRecoveryFenceState(deps.journalDir, deps.store);
      const inFlightSlots = fence.state === 'fenced' ? fence.accounts : undefined;
      if (isFence(fence)) {
        return { status: 'fenced', reason: fence.reason, message: fence.message, accounts: fence.accounts };
      }

      let pids3: CodexProcess[];
      try {
        pids3 = await activeCodexRenewers(deps, active);
      } catch (error) {
        if (error instanceof CodexProcessCheckFailed) return processCheckFailure(deps);
        throw error;
      }

      const observedDeps = observationWriteGuard(deps);
      observedDeps.list = listOrFail(deps.list);
      let settled: Extract<Awaited<ReturnType<typeof observeLiveCodex>>, { outcome: 'settled' }> | undefined;
      for (let restarts = 0; restarts <= 5; restarts += 1) {
        try {
          const observed = await observeLiveCodex(observedDeps, assertHeld,
            { by: 'qlb-active', onRepublish: 'settle' });
          if (observed.outcome === 'refused') {
            return observed.reason === 'codex-writing'
              ? { status: 'deferred', reason: 'codex-writing' }
              : { status: 'refused', reason: observed.reason };
          }
          settled = observed;
          break;
        } catch (error) {
          if (error instanceof CodexObservationWriteFailed) return { status: 'transient', reason: 'observation-write-failed' };
          if (error instanceof CodexProcessCheckFailed) return processCheckFailure(deps);
          if (error instanceof CodexLiveChanged) continue;
          throw error;
        }
      }
      if (!settled) return { status: 'deferred', reason: 'codex-writing' };

      // I4 is evaluated before any use of settled.outgoing beyond this
      // classification: its stat pair can describe an external successor.
      const isRepublish = settled.action === 'republish-slot'
        || (settled.action === 'drift' && settled.disposition === 'republish-slot');
      const postPublish = 'postPublish' in settled ? settled.postPublish : undefined;
      try {
        if (isRepublish) recordSettledRepublishObservation(observedDeps, assertHeld, postPublish);
      } catch (error) {
        if (error instanceof CodexObservationWriteFailed) return { status: 'transient', reason: 'observation-write-failed' };
        throw error;
      }
      const republish = isRepublish
        ? classifySettledRepublish(settled.outgoing.document, postPublish)
        : undefined;

      let externalAction: CodexActiveExternalAction | undefined;
      if (republish === 'external' && postPublish?.status === 'ok') {
        try {
          externalAction = await attributeSettledExternal(deps, assertHeld,
            settled.action === 'drift' ? settled.accountId : active, postPublish.doc);
        } catch (error) {
          if (error instanceof CodexProcessCheckFailed) return processCheckFailure(deps);
          throw error;
        }
        if (externalAction === 'unclaimed') {
          assertHeld();
          try {
            await deps.slots.ensureUnclaimedStash!(postPublish.doc, deps.now());
          } catch (error) {
            if (error instanceof CodexStashUnverifiable) return { status: 'refused', reason: 'stash-unverifiable' };
            throw error;
          }
          assertHeld();
          deps.store.setActiveLogin('openai-codex', null, 'adopt');
          return { status: 'refused', reason: 'unknown-live-identity' };
        }
      }
      const activeAfterObserve = deps.store.getCodexActiveLogin();
      if (settled.action === 'drift' || activeAfterObserve !== active || codexIdentity(settled.outgoing.document) !== active) {
        if (republish !== undefined && republish !== 'ok') {
          deps.autoLog?.(`codex:live-write-failed provider=openai-codex account=${active} cause=republish at=${deps.now()}`);
        }
        return { status: 'drift', accountId: activeAfterObserve, ...(republish === undefined ? {} : { republish }) };
      }
      if (externalAction !== undefined) {
        const outcome: CodexActiveOutcome = { status: 'posted-live-external', document: settled.outgoing.document, action: externalAction, cause: 'republish' };
        logLiveWriteFailure(deps, active, outcome);
        return outcome;
      }
      await deps.hooks?.afterObserve?.();

      let pids3b: CodexProcess[];
      try {
        pids3b = await activeCodexRenewers(deps, active);
      } catch (error) {
        if (error instanceof CodexProcessCheckFailed) return processCheckFailure(deps);
        throw error;
      }
      const pids = uniquePids(pids1, pids3, pids3b);
      const held = pids.length > 0;

      if (settled.action === 'republish-slot') {
        if (republish !== 'ok') {
          const outcome = republishFailureOutcome(settled.outgoing.document, republish as Exclude<SettledRepublishClass, 'ok' | 'external'>, postPublish);
          logLiveWriteFailure(deps, active, outcome);
          return outcome;
        }
        return held
          ? { status: 'held', pids, document: settled.outgoing.document, action: 'republish-slot' }
          : { status: 'republished', document: settled.outgoing.document };
      }
      if (input.mode === 'reconcile') {
        if (held) return { status: 'held', pids, document: settled.outgoing.document, action: settled.action };
        return settled.action === 'adopt'
          ? { status: 'adopted', document: settled.outgoing.document }
          : { status: 'noop', document: settled.outgoing.document };
      }
      if (held) return { status: 'held', pids, document: settled.outgoing.document, action: settled.action };
      if (input.trigger === 'unauthorized' && input.accessFp !== accessFingerprint(settled.outgoing.document)) {
        return { status: 'rotated', document: settled.outgoing.document };
      }
      if (!isDueForRefresh(settled.outgoing.document, deps.now(), input.trigger)) {
        return settled.action === 'adopt'
          ? { status: 'adopted', document: settled.outgoing.document }
          : { status: 'noop', document: settled.outgoing.document };
      }

      try {
      let consumed: CodexConsumeResult;
      try {
        consumed = await (async () => {
          const guardedTransport: CodexActiveDeps['transport'] = async (request) => {
            postIssued = true;
            deps.signalWindow?.enter();
            await deps.hooks?.beforeSend?.();
            const response = await deps.transport(request);
            try {
              await deps.hooks?.afterPost?.();
            } catch {
              deps.autoLog?.(`codex:after-post-hook-failed provider=openai-codex at=${deps.now()}`);
            }
            return response;
          };
          const result = await consumeCodexSlot({
            accountId: active,
            snapshot: settled.outgoing.document,
            trigger: input.trigger,
            slots: deps.slots,
            store: { dbPath: deps.dbPath },
            transport: guardedTransport,
            now: deps.now,
            holders: holdersFor(deps, active),
            inFlightSlots,
            assertHeld,
          });
          return result;
        })();
      } catch (error) {
        if (error instanceof CodexProcessCheckFailed) return processCheckFailure(deps);
        throw error;
      }

      const finish = finishPostOutcome;
      switch (consumed.status) {
        case 'refreshed': {
          if (!consumed.document) throw new Error('refreshed Codex result omitted its successor');
          const outcome = await publishActiveDocument(deps, assertHeld, active, settled.outgoing, consumed.document, 'post');
          logLiveWriteFailure(deps, active, outcome);
          return finish(outcome);
        }
        case 'fresh': {
          if (!consumed.document) throw new Error('fresh Codex result omitted its successor');
          const outcome = await publishActiveDocument(deps, assertHeld, active, settled.outgoing, consumed.document, 'republish');
          logLiveWriteFailure(deps, active, outcome);
          return finish(outcome);
        }
        case 'held':
          return finish({ status: 'held', pids: consumed.holders ?? [], document: settled.outgoing.document, action: settled.action });
        case 'dead': return finish({ status: 'dead', reason: 'refresh-token-rejected' });
        case 'superseded': return finish({ status: 'superseded', document: consumed.document ?? settled.outgoing.document });
        case 'transient': return finish({ status: 'transient' });
        case 'stashed':
        case 'stashed-lock-lost': return finish({ status: 'stashed', ...(consumed.stashId === undefined ? {} : { stashId: consumed.stashId }) });
        case 'successor-unpersisted':
          deps.autoLog?.(`codex:unpersisted-token provider=openai-codex account=${active} at=${deps.now()}`);
          return finish({ status: 'unpersisted' });
        case 'slot-removed': return finish({ status: 'refused', reason: 'active-slot-missing' });
        case 'slot-split': return finish({ status: 'refused', reason: 'slot-split' });
        case 'switch-in-flight': return finish({ status: 'refused', reason: 'switch-in-flight' });
        case 'codex-won-inactive': {
          const live = await deps.readLive();
          const pids = consumed.holders ?? [];
          if (live.status === 'wiped') {
            recordActiveObservation(deps, live);
            return finish({ status: 'refused', reason: 'wiped' });
          }
          if (live.status !== 'ok') {
            deps.autoLog?.(`codex:codex-won provider=openai-codex account=${active} adopted=0 pids=${pids.join(',')} at=${deps.now()}`);
            return finish({ status: 'codex-won', adopted: false, pids, document: settled.outgoing.document });
          }
          recordActiveObservation(deps, live);
          const action = await attributeCodexWon(deps, assertHeld, active, live.doc);
          if (action === 'drift') return finish({ status: 'drift', accountId: deps.store.getCodexActiveLogin() });
          if (action === 'unclaimed') {
            assertHeld();
            try {
              await deps.slots.ensureUnclaimedStash!(live.doc, deps.now());
            } catch (error) {
              if (error instanceof CodexStashUnverifiable) return finish({ status: 'refused', reason: 'stash-unverifiable' });
              throw error;
            }
            assertHeld();
            deps.store.setActiveLogin('openai-codex', null, 'adopt');
            return finish({ status: 'refused', reason: 'unknown-live-identity' });
          }
          if (action === 'wiped') return finish({ status: 'refused', reason: 'wiped' });
          if (action === 'slot-split') return finish({ status: 'refused', reason: 'slot-split' });
          if (action === 'stash-unverifiable') return finish({ status: 'refused', reason: 'stash-unverifiable' });
          const adopted = action === 'adopt';
          deps.autoLog?.(`codex:codex-won provider=openai-codex account=${active} adopted=${adopted ? 1 : 0} pids=${pids.join(',')} at=${deps.now()}`);
          return finish({ status: 'codex-won', adopted, pids, document: action === 'republish-forbidden' ? settled.outgoing.document : live.doc });
        }
        case 'busy':
        case 'active-slot':
        case 'c9-unavailable':
          throw new Error(`unreachable consume status: ${consumed.status}`);
      }
      } catch (error) {
        if (error instanceof CodexObservationWriteFailed) return finishPostOutcome({ status: 'transient', reason: 'observation-write-failed' });
        if (error instanceof CodexProcessCheckFailed) return finishPostOutcome(processCheckFailure(deps));
        // Once transport was invoked, callers receive the closed outcome union
        // even if a later injected/file-side operation fails unexpectedly.
        if (postIssued) return finishPostOutcome({ status: 'transient' });
        throw error;
      } finally {
        // Covers persistence and post-publish verification, not only transport.
        deps.signalWindow?.exit();
      }
    });
  } catch (error) {
    if (error instanceof ClaudeCodeLockTimeout || error instanceof ProperLockfileCompromised || error instanceof CodexAuthLockCompromised) {
      return postOutcome ?? { status: 'deferred', reason: 'locks-held' };
    }
    throw error;
  }
}
