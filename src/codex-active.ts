import { createHash } from 'node:crypto';

import { accessExpiry, codexAuthFileSha256, codexAuthFileText, codexFingerprint, codexIdentity, needsRefresh, type CodexAuthDocument, type CodexAuthStableWithStatResult } from './codex-auth';
import { ClaudeCodeLockTimeout, CodexAuthLockCompromised, ProperLockfileCompromised, withCodexAuthLock } from './cc-locks';
import { withCodexConsumeThenSwitchLocks } from './codex-consume';
import { codexIdentityParts, holderSets, readCodexSwitchHistory, renewers, type CodexProcess } from './codex-sessions';
import { CodexLiveChanged, attributeForPhase, codexRecoveryFenceState, observeLiveCodex, type CodexPhaseAttribution, type CodexRecoveryFenceState, type CodexSwitchDeps } from './codex-switch';
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
 * Observe and reconcile the active Codex document under the three active
 * locks.  This is deliberately the pre-POST half of the refresh workflow.
 */
export async function reconcileActiveCodexLive(deps: CodexActiveDeps): Promise<CodexActiveOutcome> {
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
    if (error instanceof CodexProcessCheckFailed) return { status: 'refused', reason: 'codex-process-check-failed' };
    throw error;
  }
  await deps.hooks?.afterCheck?.();

  try {
    return await withActiveCodexLocks(deps, active, async (assertHeld) => {
      await deps.hooks?.afterLock?.();
      const fence = codexRecoveryFenceState(deps.journalDir, deps.store);
      if (isFence(fence)) {
        return { status: 'fenced', reason: fence.reason, message: fence.message, accounts: fence.accounts };
      }

      let pids3: CodexProcess[];
      try {
        pids3 = await activeCodexRenewers(deps, active);
      } catch (error) {
        if (error instanceof CodexProcessCheckFailed) return { status: 'refused', reason: 'codex-process-check-failed' };
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
          if (error instanceof CodexProcessCheckFailed) return { status: 'refused', reason: 'codex-process-check-failed' };
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
          if (error instanceof CodexProcessCheckFailed) return { status: 'refused', reason: 'codex-process-check-failed' };
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
        return { status: 'drift', accountId: activeAfterObserve, ...(republish === undefined ? {} : { republish }) };
      }
      if (externalAction !== undefined) {
        return { status: 'posted-live-external', document: settled.outgoing.document, action: externalAction, cause: 'republish' };
      }
      await deps.hooks?.afterObserve?.();

      let pids3b: CodexProcess[];
      try {
        pids3b = await activeCodexRenewers(deps, active);
      } catch (error) {
        if (error instanceof CodexProcessCheckFailed) return { status: 'refused', reason: 'codex-process-check-failed' };
        throw error;
      }
      const pids = uniquePids(pids1, pids3, pids3b);
      const held = pids.length > 0;

      if (settled.action === 'republish-slot') {
        if (republish !== 'ok') return republishFailureOutcome(settled.outgoing.document, republish as Exclude<SettledRepublishClass, 'ok' | 'external'>, postPublish);
        return held
          ? { status: 'held', pids, document: settled.outgoing.document, action: 'republish-slot' }
          : { status: 'republished', document: settled.outgoing.document };
      }
      if (held) return { status: 'held', pids, document: settled.outgoing.document, action: settled.action };
      return settled.action === 'adopt'
        ? { status: 'adopted', document: settled.outgoing.document }
        : { status: 'noop', document: settled.outgoing.document };
    });
  } catch (error) {
    if (error instanceof ClaudeCodeLockTimeout || error instanceof ProperLockfileCompromised || error instanceof CodexAuthLockCompromised) {
      return { status: 'deferred', reason: 'locks-held' };
    }
    throw error;
  }
}
