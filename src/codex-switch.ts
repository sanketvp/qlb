import { mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accessExpiry, codexFingerprint, codexIdentity, writeCodexAuthAtomic, type CodexAuthDocument, type CodexAuthStableWithStatResult, type CodexIdentity } from './codex-auth';
import { attributeLiveDocument, type AttributeLiveDocumentInput, type CodexAttributionResult, type CodexAttributionStore } from './codex-attribution';
import { ClaudeCodeLockTimeout, CodexAuthLockCompromised, ProperLockfileCompromised, withCodexAuthLock, type CodexAuthLockOptions, type HeldProperLockfile, withProperLockfile } from './cc-locks';
import { consumeCodexSlot, hasCodexSlotIdentity, withCodexConsumeThenSwitchLocks, withCodexSwitchLock, type CodexConsumeOptions, type CodexConsumeResult } from './codex-consume';
import { fsyncDirSync, atomicWriteText, publishTarget } from './fsutil';
import { qlbHomeDir } from './home';
import {
  codexIdentityParts,
  holderSets,
  parseCodexRecoveryFence,
  processLstart,
  readCodexSwitchHistory,
  renewers,
  stillTheSameProcess,
  type CodexProcess,
} from './codex-sessions';
import type { CswapProcess } from './cswap-processes';
import { CodexStashUnverifiable, type CodexSlots } from './codex-slots';
import type { KeychainBackend } from './keychain';
import type { Store } from './store';

const PROVIDER = 'openai-codex';

export type CodexSwitchPreflightResult =
  | { kind: 'go' }
  | { kind: 'refused'; reason: 'codex-logged-out' | 'codex-auth-unreadable'; write: false };

export type CodexSwitchPreconditionReason =
  | 'cswap-process-alive'
  | 'cswap-process-check-failed'
  | 'target-missing'
  | 'target-dead'
  | 'target-pending-adopt'
  | 'codex-l13-unverified';

export type CodexSwitchPreconditionsResult =
  | { kind: 'go' }
  | { kind: 'refused'; reason: CodexSwitchPreconditionReason };

/** All external effects are injected; the production caller binds readLive to auth.json. */
type CodexObservationSlots = Pick<CodexSlots, 'readSlot' | 'ensureUnclaimedStash'>;
type CodexObservationKeychain = Pick<KeychainBackend, 'getSync' | 'setSync' | 'deleteSync'>;

export interface CodexSwitchDeps {
  store: Pick<Store, 'getCodexActiveLogin' | 'getCodexSlot' | 'getConfig' | 'hasConfig' | 'recordSwitch'
    | 'recordCodexObservation' | 'setActiveLogin' | 'commitCodexSwitch' | 'findCodexSwitchByAttempt'
    | 'setRecoveryFence' | 'clearRecoveryFence' | 'commitFenceResolution'
    | 'codexPublishingRowsAfter' | 'commitCodexWatchRevert' | 'commitCodexWatchStop' | 'deleteCodexWatch'> & CodexAttributionStore;
  readLive: () => Promise<CodexAuthStableWithStatResult>;
  cswapProcesses: () => CswapProcess[];
  now: () => number;
  attempt: string;
  /** C6-12b seams; C6-18 supplies their production bindings. */
  dbPath?: string;
  slots?: CodexConsumeOptions['slots'] & Partial<CodexObservationSlots>;
  keychain?: CodexObservationKeychain;
  /** The native auth.json path, needed only by the pre-switch republish. */
  authPath?: string;
  authLockOptions?: CodexAuthLockOptions;
  /** Fixture-only interruption seams for the step-2 attribution transaction. */
  observationBeforeSave?: AttributeLiveDocumentInput['beforeSave'];
  observationBeforeSaveCommit?: AttributeLiveDocumentInput['beforeSaveCommit'];
  list?: () => Promise<CodexProcess[]>;
  transport?: CodexConsumeOptions['transport'];
  journalDir?: string;
  /**
   * Command-owned lifecycle admission, checked once, before the preflight (§3 step 2).
   * A watch tick passes its switch's trigger, so one binding serves manual and auto watches.
   */
  admitted?: (trigger?: string) => { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
  /** Test seams for ordered switch phases; production leaves them unset. */
  hooks?: {
    afterPost?: () => void | Promise<void>;
    afterRename?: () => void | Promise<void>;
    beforeVerify?: () => void | Promise<void>;
    beforeFreshenLock?: () => void | Promise<void>;
  };
  /** Owner identity is injected by the command/test harness; a journal only needs it if it survives this attempt. */
  journalOwner?: Pick<CodexProcess, 'pid' | 'lstart'>;
  journalOptions?: CodexSwitchJournalOptions;
  /** Fixture-only crash checkpoints in reconciliation. */
  crashAt?: (checkpoint: string) => void;
}

/**
 * Q3's read-only gate. Missing or unreadable live state is deliberately not
 * recorded: no switch request has reached a write-eligible phase yet.
 */
export async function preflightCodexLive(deps: Pick<CodexSwitchDeps, 'readLive'>): Promise<CodexSwitchPreflightResult> {
  const live = await deps.readLive();
  if (live.status === 'missing') return { kind: 'refused', reason: 'codex-logged-out', write: false };
  if (live.status === 'unreadable') return { kind: 'refused', reason: 'codex-auth-unreadable', write: false };
  return { kind: 'go' };
}

/** Write the sole phase-U refusal row, preserving its attempt provenance. */
export function recordCodexSwitchRefusal(
  deps: Pick<CodexSwitchDeps, 'store' | 'now' | 'attempt'>,
  input: { from: string | null; target: string; trigger: string; reason: CodexSwitchPreconditionReason },
): number {
  return deps.store.recordSwitch({
    ts: deps.now(),
    provider: PROVIDER,
    fromAccount: input.from,
    toAccount: input.target,
    trigger: input.trigger,
    outcome: 'refused',
    detail: input.reason,
    stepsJson: JSON.stringify({ attempt: deps.attempt, via: 'switch' }),
    publishedAt: null,
  });
}

/**
 * Phase-U switch eligibility. Admission belongs to the caller, so this only
 * applies S24, target state, and the S15 receipt in their mandated order.
 */
export function checkCodexSwitchPreconditions(
  deps: CodexSwitchDeps,
  input: { target: string; trigger: string },
): CodexSwitchPreconditionsResult {
  const refuse = (reason: CodexSwitchPreconditionReason): CodexSwitchPreconditionsResult => {
    recordCodexSwitchRefusal(deps, {
      from: deps.store.getCodexActiveLogin(), target: input.target, trigger: input.trigger, reason,
    });
    return { kind: 'refused', reason };
  };

  let cswapAlive: boolean;
  try {
    cswapAlive = deps.cswapProcesses().length > 0;
  } catch {
    // S24 treats CswapProcessCheckError and every other inspection failure alike.
    return refuse('cswap-process-check-failed');
  }
  if (cswapAlive) return refuse('cswap-process-alive');

  const target = deps.store.getCodexSlot(input.target);
  if (target === null) return refuse('target-missing');
  if (target.dead) return refuse('target-dead');
  if (target.pendingAdopt) return refuse('target-pending-adopt');
  if (input.trigger !== 'manual' && deps.store.getConfig('codex.l13VerifiedAt') === null) {
    return refuse('codex-l13-unverified');
  }
  return { kind: 'go' };
}

/** The pre-switch republish found that Codex changed auth.json after step 1. */
export class CodexLiveChanged extends Error {
  constructor() {
    super('Codex changed auth.json during the pre-switch observation. Restart the observation.');
    this.name = 'CodexLiveChanged';
  }
}

/** The only pre-switch QLB publication failed before its rename. */
export class CodexRepublishFailed extends Error {
  constructor() {
    super('Codex pre-switch republish failed before rename.');
    this.name = 'CodexRepublishFailed';
  }
}

export type CodexLiveOutgoing = {
  document: CodexAuthDocument;
  sha256: string;
  inode: number;
};

export type ObserveLiveCodexResult =
  | { outcome: 'settled'; outgoing: CodexLiveOutgoing }
  | { outcome: 'refused'; reason: 'codex-writing' | 'codex-logged-out' | 'codex-auth-unreadable' | 'wiped' | 'republish-failed' | 'unknown-live-identity' | 'stash-unverifiable' | 'slot-split' };

function observationDeps(deps: CodexSwitchDeps): {
  slots: CodexObservationSlots;
  keychain: CodexObservationKeychain;
  list: () => Promise<CodexProcess[]>;
} {
  if (!deps.slots?.ensureUnclaimedStash || !deps.keychain || !deps.list) {
    throw new Error('Codex live observation dependencies are required');
  }
  return { slots: deps.slots as CodexObservationSlots, keychain: deps.keychain, list: deps.list };
}

function sameLiveObservation(
  left: CodexAuthStableWithStatResult,
  right: CodexAuthStableWithStatResult,
): boolean {
  return left.status === 'ok' && right.status === 'ok'
    && left.sha256 === right.sha256 && left.inode === right.inode;
}

/**
 * Holds the two locks required for every phase-L Codex write.  The caller gets
 * one assertion capability so an adoption or republish can never outlive
 * either lock's owner token.
 */
export async function withCodexSwitchLocks<T>(
  deps: Pick<CodexSwitchDeps, 'dbPath' | 'authLockOptions'>,
  fn: (assertHeld: () => void) => Promise<T> | T,
): Promise<T> {
  if (!deps.dbPath) throw new Error('Codex switch lock requires dbPath');
  return withCodexSwitchLock(deps.dbPath, (switchLock) => withCodexAuthLock(deps.authLockOptions, (authLock) =>
    fn(() => {
      switchLock.assertNotCompromised();
      authLock.assertNotCompromised();
    })));
}

/**
 * Executes §4.4.1 steps 1--2 while the caller owns switch → auth.  A changed
 * file during a pre-switch republish is deliberately thrown to the enclosing
 * retry loop; it must never be overwritten with stale slot bytes.
 */
export async function observeLiveCodex(
  deps: CodexSwitchDeps,
  assertHeld: () => void,
): Promise<ObserveLiveCodexResult> {
  const configured = observationDeps(deps);
  const p0 = await configured.list();
  const live = await deps.readLive();
  const p1 = await configured.list();

  if (live.status === 'unstable') return { outcome: 'refused', reason: 'codex-writing' };
  if (live.status === 'missing') return { outcome: 'refused', reason: 'codex-logged-out' };
  if (live.status === 'unreadable') return { outcome: 'refused', reason: 'codex-auth-unreadable' };
  if (live.status === 'wiped') {
    assertHeld();
    deps.store.recordCodexObservation({ identity: null, lineageFp: null, by: 'qlb-switch', now: deps.now() });
    return { outcome: 'refused', reason: 'wiped' };
  }

  const liveIdentity = codexIdentity(live.doc);
  const activeSlotId = deps.store.getCodexActiveLogin();
  // An active id is normally established by the switch preconditions.  If an
  // earlier unknown-login refusal cleared it, a now-known live identity is the
  // only managed slot that can be adopted as active.
  const selectedSlotId = activeSlotId ?? (liveIdentity ? deps.store.getCodexSlot(liveIdentity)?.accountId ?? null : null);

  const history = deps.dbPath
    ? readCodexSwitchHistory(deps.dbPath, { journalDir: deps.journalDir })
    : { rows: [], observations: [] };
  const holderObservation = liveIdentity === null ? undefined : {
    aliveBefore: renewers(codexIdentityParts(liveIdentity), p0, history.rows, history.observations).length > 0,
    aliveAfter: renewers(codexIdentityParts(liveIdentity), p1, history.rows, history.observations).length > 0,
  };

  assertHeld();
  deps.store.recordCodexObservation({
    identity: liveIdentity,
    lineageFp: codexFingerprint(live.doc),
    by: 'qlb-switch',
    now: deps.now(),
  });

  try {
    // With no active slot and no managed slot for the live identity, there is
    // nothing S56 could attribute against: the live identity is unknown or
    // unparseable, which is step 2's unclaimed path.
    const attribution: CodexPhaseAttribution = selectedSlotId === null ? { action: 'unclaimed' } : await attributeForPhase({ assertHeld }, 'pre', {
      store: deps.store,
      keychain: configured.keychain,
      // The DB row, not the Keychain item, is the noop/CAS authority, so a
      // DB/Keychain split stays detectable (as codex import-active passes it).
      slot: {
        accountId: selectedSlotId,
        document: configured.slots.readSlot(selectedSlotId, { fresh: true }).document,
        fingerprint: deps.store.getCodexSlot(selectedSlotId)?.fingerprint ?? undefined,
      },
      activeSlotId: activeSlotId ?? undefined,
      activeSetBy: 'adopt',
      live: live.doc,
      holderObservation,
      l40Verified: deps.store.getConfig('codex.l40Verified') === '1',
      beforeSave: deps.observationBeforeSave,
      beforeSaveCommit: deps.observationBeforeSaveCommit,
      now: deps.now,
      republish: async (document) => {
        assertHeld();
        const reread = await deps.readLive();
        if (!sameLiveObservation(live, reread)) throw new CodexLiveChanged();
        if (!deps.authPath) throw new Error('Codex pre-switch republish requires authPath');
        // The re-read can wait over a second; a lock taken over meanwhile must
        // not be followed by a rename of slot bytes.
        assertHeld();
        const published = await publishCodexAuth(deps.authPath, document);
        if (published.stage === 'rename-threw') throw new CodexRepublishFailed();
      },
    });
    if (attribution.action === 'republish-slot'
      || (attribution.action === 'drift' && attribution.disposition === 'republish-slot')) {
      throw new CodexLiveChanged();
    }
    if (attribution.action === 'unclaimed') {
      assertHeld();
      try {
        await configured.slots.ensureUnclaimedStash(live.doc, deps.now());
      } catch (error) {
        if (error instanceof CodexStashUnverifiable) return { outcome: 'refused', reason: 'stash-unverifiable' };
        throw error;
      }
      assertHeld();
      deps.store.setActiveLogin(PROVIDER, null, 'adopt');
      return { outcome: 'refused', reason: 'unknown-live-identity' };
    }
    if (attribution.action === 'slot-split'
      || (attribution.action === 'drift' && attribution.disposition === 'slot-split')) {
      return { outcome: 'refused', reason: 'slot-split' };
    }
    return { outcome: 'settled', outgoing: { document: live.doc, sha256: live.sha256, inode: live.inode } };
  } catch (error) {
    if (error instanceof CodexRepublishFailed) return { outcome: 'refused', reason: 'republish-failed' };
    throw error;
  }
}

/** Result of a single atomic target publication, including post-rename durability. */
export type CodexAuthPublishResult =
  | { stage: 'rename-threw'; error: unknown }
  | { stage: 'published'; inode: number; dirFsyncError?: unknown };

/**
 * The post-rename verification classification. Non-OK stable-read results
 * remain intact so callers retain their read error details.
 */
export type CodexPostPublishClassification =
  | 'ok'
  | 'not-landed'
  | 'target-changed'
  | { status: 'external'; doc: CodexAuthDocument }
  | Exclude<CodexAuthStableWithStatResult, { status: 'ok' }>;

/**
 * Atomically replace the live auth file, then request durability of its parent
 * directory entry. A directory-sync failure happens after rename and therefore
 * remains distinguishable from a rename failure for verification.
 */
export async function publishCodexAuth(path: string, doc: CodexAuthDocument): Promise<CodexAuthPublishResult> {
  let inode: number;
  try {
    inode = await writeCodexAuthAtomic(path, doc);
  } catch (error: unknown) {
    return { stage: 'rename-threw', error };
  }
  try {
    // The atomic write follows a final-path symlink, so the rename lands beside
    // the resolved target; that is the directory entry to make durable.
    fsyncDirSync(dirname(publishTarget(path)));
    return { stage: 'published', inode };
  } catch (dirFsyncError: unknown) {
    return { stage: 'published', inode, dirFsyncError };
  }
}

/** Classify the stable post-publish read without performing any side effects. */
export function classifyPostPublish(input: {
  journal: CodexSwitchJournal;
  publish?: CodexAuthPublishResult;
  observed: CodexAuthStableWithStatResult;
  targetSlotFp: string;
}): CodexPostPublishClassification {
  const { journal, publish, observed, targetSlotFp } = input;
  if (publish?.stage === 'rename-threw') return 'not-landed';
  if (publish === undefined && observed.status === 'ok'
    && observed.inode === journal.outgoing.inode && observed.sha256 === journal.outgoing.sha256) return 'not-landed';
  if (targetSlotFp !== journal.target.fingerprint && !journal.adoptingTarget.includes(targetSlotFp)) return 'target-changed';
  if (observed.status !== 'ok') return observed;
  if (codexFingerprint(observed.doc) === journal.target.fingerprint) return 'ok';
  return { status: 'external', doc: observed.doc };
}

/**
 * Post-publish attribution is not allowed to restore auth.json.  The caller
 * turns this typed result into the appropriate §3.1 recovery verdict instead.
 */
export class CodexRepublishForbidden extends Error {
  constructor(readonly slotId: string | null) {
    super(`Codex republish is forbidden outside the pre-switch phase (${slotId ?? 'unknown'})`);
    this.name = 'CodexRepublishForbidden';
  }
}

export type CodexAttributionPhase = 'pre' | 'post' | 'recovery' | 'watch';
export type CodexRepublishForbiddenAttribution = { action: 'republish-forbidden'; slotId: string | null };
/** `stash-unverifiable` is supplied by the caller that caught CodexStashUnverifiable. */
export type CodexPhaseAttribution = CodexAttributionResult | CodexRepublishForbiddenAttribution | { action: 'stash-unverifiable' };

export interface AttributeForPhaseDeps {
  /** The switch/auth lock assertion owned by the invoking phase. */
  assertHeld: () => void;
}

/**
 * Apply S56 under a switch phase.  In particular, always pass the caller's
 * capability through to attribution: attribution writes Keychain/SQLite.
 *
 * A post/recovery/watch caller that may adopt live bytes onto the target must
 * append that fingerprint with markCodexSwitchJournalAdoptingTarget *before*
 * the adopt write, from attribution's `beforeSave` hook, so that an attribution
 * that adopts nothing onto the target records nothing.  This wrapper
 * intentionally has no journal-owner capability, so that ordering remains the
 * responsibility of those callers.
 */
export async function attributeForPhase(
  deps: AttributeForPhaseDeps,
  phase: CodexAttributionPhase,
  input: Omit<AttributeLiveDocumentInput, 'assertNotCompromised'>,
): Promise<CodexPhaseAttribution> {
  try {
    return await attributeLiveDocument({
      ...input,
      assertNotCompromised: deps.assertHeld,
      ...(phase === 'pre' ? {} : {
        // Report the slot attribution selected; the bytes it would republish
        // may carry missing or mismatched identity claims.
        republish: (_doc: CodexAuthDocument, slotId: string) => { throw new CodexRepublishForbidden(slotId); },
      }),
    });
  } catch (error) {
    if (error instanceof CodexRepublishForbidden) return { action: 'republish-forbidden', slotId: error.slotId };
    throw error;
  }
}

export type CodexRecoveryEffect =
  | { outcome: 'failed'; detail: 'not-published' | 'target-changed' | 'unknown-live-identity' | 'wiped'; activeAccountId?: null }
  | { outcome: 'ok'; adopted?: boolean }
  | { outcome: 'reverted-by-codex'; accountId: string }
  | { outcome: 'quiet'; adopted?: boolean }
  | { outcome: 'stopped'; reason: 'logged-out' | 'unknown-live-identity' | 'wiped'; activeAccountId?: null };

export type CodexRecoveryVerdict =
  | { class: 'resolvable'; effect: CodexRecoveryEffect }
  | { class: 'unresolved'; reason: 'target-changed' | 'target-ancestor' | 'slot-split' | 'stash-unverifiable' | 'logged-out'; involvedAccounts: string[] | '*' }
  | { class: 'pending'; status: 'unstable' | 'unreadable' };

export interface ResolveRecoveryVerdictContext {
  phase: Exclude<CodexAttributionPhase, 'pre'>;
  journal?: CodexSwitchJournal;
  watch?: Pick<CodexSwitchJournal, 'from' | 'to' | 'target' | 'adoptingTarget'>;
  /** The current fingerprint of slot B, read in the same locked observation. */
  targetSlotFingerprint: string;
  /**
   * Every managed slot id → its current head fingerprint, read in the same
   * locked observation.  A slot whose DB and Keychain disagree (split) has no
   * established head: it maps to `null`, so it still counts as a known slot
   * for the fenced set but never as a head live can have caught up with.
   */
  slotHeads: ReadonlyMap<string, string | null>;
  /**
   * The observed live document.  When absent it defaults to the classified
   * document for `{status:'external'}`; pass it for `target-changed`, whose
   * classification does not carry the document.
   */
  live?: CodexAuthDocument | null;
}

function recoveryContext(context: ResolveRecoveryVerdictContext): Pick<CodexSwitchJournal, 'from' | 'to' | 'target' | 'adoptingTarget'> {
  const source = context.journal ?? context.watch;
  if (!source) throw new Error('A journal or watch context is required for Codex recovery resolution');
  return source;
}

function liveDocument(
  classified: CodexPostPublishClassification,
  context: ResolveRecoveryVerdictContext,
): CodexAuthDocument | null | undefined {
  if (context.live !== undefined) return context.live;
  return typeof classified === 'object' && classified.status === 'external' ? classified.doc : undefined;
}

function unresolvedAccounts(
  context: ResolveRecoveryVerdictContext,
  live: CodexAuthDocument | null | undefined,
  attribution: CodexPhaseAttribution | undefined,
  reason: Extract<CodexRecoveryVerdict, { class: 'unresolved' }>['reason'],
): string[] | '*' {
  const state = recoveryContext(context);
  // §3.1 fails closed when the live identity, or the republished slot, cannot be established.
  if (reason === 'logged-out' || attribution?.action === 'stash-unverifiable' || live === undefined || live === null) return '*';
  if (attribution?.action === 'republish-forbidden' && attribution.slotId === null) return '*';
  const liveIdentity = codexIdentity(live);
  if (!liveIdentity) return '*';
  const accounts = new Set([state.from, state.to]);
  // The live identity's known slot is fenced whatever the attribution says.
  if (context.slotHeads.has(liveIdentity)) accounts.add(liveIdentity);
  if (attribution?.action === 'slot-split' && attribution.accountId) accounts.add(attribution.accountId);
  if (attribution?.action === 'republish-forbidden' && attribution.slotId) accounts.add(attribution.slotId);
  if (attribution?.action === 'drift' && attribution.disposition === 'slot-split' && attribution.accountId) {
    accounts.add(attribution.accountId);
  }
  // A managed live identity is reported by attribution's accountId.  An
  // unmanaged, but syntactically valid identity contributes no managed slot.
  if (attribution && 'accountId' in attribution && attribution.accountId) accounts.add(attribution.accountId);
  return [...accounts].sort();
}

/**
 * Translate the classifier plus phase-safe attribution into the closed §3.1
 * table.  `targetSlotFingerprint` is deliberately checked here as well as in
 * classifyPostPublish: a classified `ok` is not the table's ok row after QLB
 * has itself adopted B to a different fingerprint.
 */
export function resolveRecoveryVerdict(
  classified: CodexPostPublishClassification,
  attribution: CodexPhaseAttribution | undefined,
  context: ResolveRecoveryVerdictContext,
): CodexRecoveryVerdict {
  const state = recoveryContext(context);
  const isWatch = context.phase === 'watch';
  const live = liveDocument(classified, context);
  const resolved = (effect: CodexRecoveryEffect): CodexRecoveryVerdict => ({ class: 'resolvable', effect });
  const unresolved = (reason: Extract<CodexRecoveryVerdict, { class: 'unresolved' }>['reason']): CodexRecoveryVerdict =>
    ({ class: 'unresolved', reason, involvedAccounts: unresolvedAccounts(context, live, attribution, reason) });
  // Fail-closed attribution rows.  A forbidden republish onto the target, or
  // onto a slot that cannot be established, is target-ancestor: an unknown
  // slot may be the target, and that row is the unresolved one.
  const failClosed = (): CodexRecoveryVerdict | undefined => {
    if (attribution?.action === 'republish-forbidden'
      && (attribution.slotId === null || attribution.slotId === state.to)) return unresolved('target-ancestor');
    if (attribution?.action === 'slot-split'
      || (attribution?.action === 'drift' && attribution.disposition === 'slot-split')) return unresolved('slot-split');
    if (attribution?.action === 'stash-unverifiable') return unresolved('stash-unverifiable');
    return undefined;
  };

  if (classified === 'not-landed') return resolved({ outcome: 'failed', detail: 'not-published' });
  if (typeof classified === 'object' && classified.status === 'missing') {
    return isWatch ? resolved({ outcome: 'stopped', reason: 'logged-out' }) : unresolved('logged-out');
  }
  if (typeof classified === 'object' && (classified.status === 'unstable' || classified.status === 'unreadable')) {
    return { class: 'pending', status: classified.status };
  }
  // A wiped file holds no login, so the switch records none (user decision C6-Q1).
  if (typeof classified === 'object' && classified.status === 'wiped') return resolved(isWatch
    ? { outcome: 'stopped', reason: 'wiped' }
    : { outcome: 'failed', detail: 'wiped', activeAccountId: null });

  if (classified === 'target-changed') {
    // A changed B is never an ok row.  A fail-closed attribution wins; else it
    // is recoverable only once the live bytes equal a current slot head (any
    // managed slot, not only B), and remains target-changed.
    const blocked = failClosed();
    if (blocked) return blocked;
    if (live !== undefined && live !== null) {
      const liveFp = codexFingerprint(live);
      if ([...context.slotHeads.values()].some((head) => head !== null && head === liveFp)) {
        return resolved({ outcome: 'failed', detail: 'target-changed' });
      }
    }
    return unresolved('target-changed');
  }

  const targetWasMoved = context.targetSlotFingerprint !== state.target.fingerprint;
  const blocked = failClosed();
  if (blocked) return blocked;
  // failClosed() has already returned for a null slot or the target.
  if (attribution?.action === 'republish-forbidden' && attribution.slotId !== null) {
    return resolved({ outcome: 'reverted-by-codex', accountId: attribution.slotId });
  }
  if (attribution?.action === 'unclaimed') return resolved(isWatch
    ? { outcome: 'stopped', reason: 'unknown-live-identity', activeAccountId: null }
    : { outcome: 'failed', detail: 'unknown-live-identity', activeAccountId: null });

  if (classified === 'ok' && !targetWasMoved) return resolved(isWatch ? { outcome: 'quiet' } : { outcome: 'ok' });

  const disposition = attribution?.action === 'drift' ? attribution.disposition : attribution?.action;
  const accountId = attribution && 'accountId' in attribution ? attribution.accountId : undefined;
  if ((disposition === 'noop' || disposition === 'adopt') && accountId === state.to) {
    return resolved(isWatch ? { outcome: 'quiet', adopted: disposition === 'adopt' } : { outcome: 'ok', adopted: disposition === 'adopt' });
  }
  if ((disposition === 'noop' || disposition === 'adopt') && accountId) {
    return resolved({ outcome: 'reverted-by-codex', accountId });
  }

  // `ok` with B moved by a QLB-recorded adoption must be decided by its
  // attribution (normally republish-forbidden above), never treated as ok.
  if (classified === 'ok' && targetWasMoved) {
    throw new Error('§3.1 cannot resolve a classified ok with a moved target slot without attribution');
  }
  throw new Error('§3.1 cannot resolve this classified Codex observation without attribution');
}

export const CODEX_SWITCH_JOURNAL_STALENESS_MS = 5 * 60_000;
export const CODEX_SWITCH_JOURNAL_TIMEOUT_MS = 10_000;
const CODEX_SWITCH_JOURNAL_FILE = 'switch-openai-codex.json';

/** Credential-free durable record for an unfinished Codex publication. */
export interface CodexSwitchJournal {
  v: 2;
  attemptId: string;
  from: string;
  to: string;
  target: { identity: CodexIdentity; fingerprint: string };
  adoptingTarget: string[];
  trigger: string;
  decision: { leftHeadroom: number | null; leftRecoveryAtMs: number | null; leftTrigger: string | null } | null;
  openSessions: CodexProcess[];
  outgoing: { sha256: string; inode: number };
  publishedAt: number;
  owner: { pid: number; lstart: string; state: 'active' | 'released' };
  unresolved?: { reason: string; involvedAccounts: string[] | '*'; since: number };
}

export type CodexSwitchJournalRead =
  | { state: 'absent' }
  | { state: 'ok'; journal: CodexSwitchJournal }
  | { state: 'malformed' };

export interface CodexSwitchJournalOptions {
  journalDir?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sameProcess?: (owner: Pick<CodexProcess, 'pid' | 'lstart'>) => Promise<boolean>;
  fsyncDirectory?: (path: string) => void;
  ownerLockTimeoutMs?: number;
  ownerLockStalenessMs?: number;
  ownerLockRetryMinMs?: number;
  ownerLockRetryJitterMs?: number;
  onOwnerLockCompromised?: (error: Error) => void;
}

const journalOwnerHandle = Symbol('codex-switch-journal-owner');

/** Opaque capability valid only in withCodexSwitchJournalOwner's callback. */
export interface HeldCodexSwitchJournalOwner {
  readonly [journalOwnerHandle]: true;
  readonly journalDir: string;
  assertHeld(): void;
}

/** Attempts currently being executed by this Node process, keyed by attempt id. */
export const executingCodexAttempts = new Set<string>();

export function codexSwitchJournalDir(options: CodexSwitchJournalOptions = {}): string {
  if (options.journalDir) return options.journalDir;
  return join(options.home ?? qlbHomeDir(options.env), '.qlb', 'journal');
}

export function codexSwitchJournalPath(options: CodexSwitchJournalOptions = {}): string {
  return join(codexSwitchJournalDir(options), CODEX_SWITCH_JOURNAL_FILE);
}

export function codexSwitchJournalOwnerLockPath(options: CodexSwitchJournalOptions = {}): string {
  return `${codexSwitchJournalPath(options)}.lock`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function finiteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isCodexProcess(value: unknown): value is CodexProcess {
  return isRecord(value) && Number.isSafeInteger(value.pid) && (value.pid as number) > 0
    && nonEmptyString(value.lstart) && nonEmptyString(value.host);
}

/** Parse only the v2 credential-free shape; old or partial records fail closed. */
function parseCodexSwitchJournal(value: unknown): CodexSwitchJournal | null {
  if (!isRecord(value) || value.v !== 2 || !nonEmptyString(value.attemptId)
    || !nonEmptyString(value.from) || !nonEmptyString(value.to) || !nonEmptyString(value.trigger)
    || !isRecord(value.target) || !isRecord(value.target.identity)
    || !nonEmptyString(value.target.identity.chatgpt_user_id) || !nonEmptyString(value.target.identity.account_id)
    || !nonEmptyString(value.target.fingerprint) || !Array.isArray(value.adoptingTarget)
    || !value.adoptingTarget.every(nonEmptyString) || !Array.isArray(value.openSessions)
    || !value.openSessions.every(isCodexProcess) || !isRecord(value.outgoing)
    || !nonEmptyString(value.outgoing.sha256) || !Number.isSafeInteger(value.outgoing.inode)
    || !finiteNumber(value.publishedAt) || !isRecord(value.owner)
    || !Number.isSafeInteger(value.owner.pid) || (value.owner.pid as number) <= 0
    || !nonEmptyString(value.owner.lstart)
    || (value.owner.state !== 'active' && value.owner.state !== 'released')) return null;
  let decision: CodexSwitchJournal['decision'];
  if (value.decision === null) decision = null;
  else if (isRecord(value.decision)
    && (value.decision.leftHeadroom === null || finiteNumber(value.decision.leftHeadroom))
    && (value.decision.leftRecoveryAtMs === null || finiteNumber(value.decision.leftRecoveryAtMs))
    && (value.decision.leftTrigger === null || nonEmptyString(value.decision.leftTrigger))) {
    decision = { leftHeadroom: value.decision.leftHeadroom as number | null,
      leftRecoveryAtMs: value.decision.leftRecoveryAtMs as number | null,
      leftTrigger: value.decision.leftTrigger as string | null };
  } else return null;
  let unresolved: CodexSwitchJournal['unresolved'];
  if (value.unresolved !== undefined) {
    if (!isRecord(value.unresolved) || !nonEmptyString(value.unresolved.reason) || !finiteNumber(value.unresolved.since)
      || (value.unresolved.involvedAccounts !== '*' && (!Array.isArray(value.unresolved.involvedAccounts)
        || !value.unresolved.involvedAccounts.every(nonEmptyString)))) return null;
    unresolved = { reason: value.unresolved.reason,
      involvedAccounts: value.unresolved.involvedAccounts === '*' ? '*' : [...value.unresolved.involvedAccounts],
      since: value.unresolved.since };
  }
  return { v: 2, attemptId: value.attemptId, from: value.from, to: value.to,
    target: { identity: { chatgpt_user_id: value.target.identity.chatgpt_user_id, account_id: value.target.identity.account_id }, fingerprint: value.target.fingerprint },
    adoptingTarget: [...value.adoptingTarget], trigger: value.trigger, decision,
    openSessions: value.openSessions.map(({ pid, lstart, host }) => ({ pid, lstart, host })),
    outgoing: { sha256: value.outgoing.sha256, inode: value.outgoing.inode as number }, publishedAt: value.publishedAt,
    owner: { pid: value.owner.pid as number, lstart: value.owner.lstart, state: value.owner.state },
    ...(unresolved === undefined ? {} : { unresolved }) };
}

/** Read a journal without treating corrupt or obsolete content as absent. */
export function readCodexSwitchJournal(options: CodexSwitchJournalOptions = {}): CodexSwitchJournalRead {
  try {
    const journal = parseCodexSwitchJournal(JSON.parse(readFileSync(codexSwitchJournalPath(options), 'utf8')));
    return journal === null ? { state: 'malformed' } : { state: 'ok', journal };
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'malformed' };
  }
}

export type CodexRecoveryFenceState = { state: 'none' } | {
  state: 'fenced';
  accounts: Set<string> | '*';
  reason: string;
  message: string;
};

function codexRecoveryFenceMessage(reason: string): string {
  return `Codex switch recovery needs you (${reason}): log in to Codex with the account you want (codex login), then run qlb codex import-active. QLB finishes the recovery at its next check.`;
}

/** §3.1's "needs you" text is only for unresolved fences; an attempt still in flight finishes without the operator. */
function codexInFlightMessage(reason: string): string {
  return `codex refresh refused: ${reason} (a Codex switch involving this account has not finished)`;
}

/** The switch row's recorded `open_sessions_json` (§3 aliveBefore snapshot); an unreadable record names no holder. */
function recordedOpenSessions(json: string | null | undefined): CodexProcess[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter(isCodexProcess).map(({ pid, lstart, host }) => ({ pid, lstart, host })) : [];
  } catch { return []; }
}

function unionRecoveryAccounts(...accounts: Array<string[] | '*'>): Set<string> | '*' {
  if (accounts.includes('*')) return '*';
  return new Set(accounts.flat());
}

/**
 * Reads the two durable recovery artifacts as one fail-closed consumer fence.
 * Callers must invoke this while holding the shared switch lock.
 */
export function codexRecoveryFenceState(
  journalDir: string,
  store: Pick<Store, 'getConfig' | 'hasConfig'>,
): CodexRecoveryFenceState {
  const journal = readCodexSwitchJournal({ journalDir });
  const configFence = parseCodexRecoveryFence(store.getConfig('codex.recoveryFence'));
  // Clearing a fence deletes the row, so any present row that does not parse
  // (a NULL value included) fails closed, as in readCodexSwitchHistory.
  if (journal.state === 'malformed' || (store.hasConfig('codex.recoveryFence') && configFence === null)) {
    const reason = 'switch-recovery-malformed';
    return { state: 'fenced', accounts: '*', reason, message: codexRecoveryFenceMessage(reason) };
  }
  if (journal.state === 'ok') {
    const journalAccounts = journal.journal.unresolved?.involvedAccounts ?? [];
    const configAccounts = configFence?.involvedAccounts ?? [];
    const accounts = unionRecoveryAccounts(
      [journal.journal.from, journal.journal.to], journalAccounts,
      ...(configFence === null ? [] : [[configFence.from, configFence.to], configAccounts]),
    );
    const unresolved = journal.journal.unresolved;
    if (!unresolved) {
      // §3.1's "needs you" text is for unresolved fences; a journal still in
      // flight finishes or is recovered without the operator.
      const reason = 'switch-in-flight';
      return { state: 'fenced', accounts, reason, message: codexInFlightMessage(reason) };
    }
    return { state: 'fenced', accounts, reason: unresolved.reason, message: codexRecoveryFenceMessage(unresolved.reason) };
  }
  if (configFence !== null) {
    const accounts = unionRecoveryAccounts([configFence.from, configFence.to], configFence.involvedAccounts);
    return {
      state: 'fenced', accounts, reason: configFence.reason,
      message: codexRecoveryFenceMessage(configFence.reason),
    };
  }
  return { state: 'none' };
}

export type CodexTargetFreshenResult =
  | { kind: 'go' }
  | { kind: 'refused'; reason: string; pids?: number[] };

function freshenDeps(deps: CodexSwitchDeps): {
  dbPath: string;
  slots: CodexConsumeOptions['slots'];
  list: () => Promise<CodexProcess[]>;
  transport: CodexConsumeOptions['transport'];
  journalDir: string;
} {
  if (!deps.dbPath || !deps.slots || !deps.list || !deps.transport || !deps.journalDir) {
    throw new Error('Codex target freshen dependencies are required');
  }
  return {
    dbPath: deps.dbPath, slots: deps.slots, list: deps.list,
    transport: deps.transport, journalDir: deps.journalDir,
  };
}

/**
 * Freshens an inactive switch target only when its near expiry is not held by
 * a Codex session. The consume lock is acquired before the shared switch lock.
 */
export async function freshenCodexTarget(
  deps: CodexSwitchDeps,
  { target, now }: { target: string; now: number },
): Promise<CodexTargetFreshenResult> {
  const configured = freshenDeps(deps);
  // Same adapter guard as codex refresh: an unreadable slot, or a document
  // that is not account `target`, is never spent.
  const readTarget = (): CodexAuthDocument | null => {
    let document: CodexAuthDocument;
    try { document = configured.slots.readSlot(target, { fresh: true }).document; } catch { return null; }
    return hasCodexSlotIdentity(document, target) ? document : null;
  };
  const initial = readTarget();
  if (!initial) return { kind: 'refused', reason: 'target-freshen-slot-removed' };
  if (expiresAfter(initial, now + 10 * 60_000)) return { kind: 'go' };

  const holders = async (document: CodexAuthDocument): Promise<CodexProcess[]> => {
    const identity = codexIdentity(document);
    if (!identity) throw new Error('Codex slot identity is invalid');
    const history = readCodexSwitchHistory(configured.dbPath, { journalDir: configured.journalDir });
    return renewers(codexIdentityParts(identity), await configured.list(), history.rows, history.observations);
  };
  // The 5-minute holder rule is judged against the document it was checked on.
  const holderResult = (document: CodexAuthDocument, pids: readonly number[]): CodexTargetFreshenResult =>
    expiresAfter(document, now + 5 * 60_000)
      ? { kind: 'go' }
      : { kind: 'refused', reason: 'target-held-by-session', pids: [...pids] };

  const initialHolders = await holders(initial);
  if (initialHolders.length > 0) return holderResult(initial, initialHolders.map(({ pid }) => pid));

  let outcome: CodexConsumeResult | undefined;
  const fromConsume = (result: CodexConsumeResult, snapshot: CodexAuthDocument): CodexTargetFreshenResult => {
    if (result.status === 'refreshed' || result.status === 'fresh') return { kind: 'go' };
    if (result.status === 'held') return holderResult(snapshot, result.holders ?? []);
    return { kind: 'refused', reason: `target-freshen-${result.status}` };
  };
  let lockedSnapshot: CodexAuthDocument | undefined;
  try {
    return await withCodexConsumeThenSwitchLocks(configured.dbPath, target, async (heldConsume, heldSwitch) => {
      const fence = codexRecoveryFenceState(configured.journalDir, deps.store);
      if (fence.state === 'fenced' && (fence.accounts === '*' || fence.accounts.has(target))) {
        return { kind: 'refused', reason: fence.reason };
      }
      if (deps.store.getCodexActiveLogin() === target) return { kind: 'go' };
      const snapshot = readTarget();
      if (!snapshot) return { kind: 'refused', reason: 'target-freshen-slot-removed' };
      // Another process may have refreshed it while this call waited for the locks.
      if (expiresAfter(snapshot, now + 10 * 60_000)) return { kind: 'go' };
      lockedSnapshot = snapshot;

      outcome = await consumeCodexSlot({
        accountId: target,
        trigger: 'proactive-expiry',
        snapshot,
        slots: configured.slots,
        store: { dbPath: configured.dbPath },
        transport: configured.transport,
        now: () => now,
        holders,
        inFlightSlots: fence.state === 'fenced' ? fence.accounts : undefined,
        assertHeld: () => { heldConsume.assertNotCompromised(); heldSwitch.assertNotCompromised(); },
      });
      return fromConsume(outcome, snapshot);
    });
  } catch (error) {
    if (error instanceof ClaudeCodeLockTimeout) return { kind: 'refused', reason: 'target-freshen-busy' };
    // The lock wrapper rethrows its compromise after the callback; an issued
    // successor's fate must still reach the caller (as in codex refresh).
    if ((outcome?.status === 'stashed-lock-lost' || outcome?.status === 'successor-unpersisted') && lockedSnapshot) {
      return fromConsume(outcome, lockedSnapshot);
    }
    throw error;
  }
}

function expiresAfter(document: CodexAuthDocument, instant: number): boolean {
  const expiry = accessExpiry(document);
  return expiry !== null && expiry > instant;
}

/** Persist only the parsed, allowlisted fields, so extra caller properties never reach disk. */
function persistCodexSwitchJournal(journal: CodexSwitchJournal, options: CodexSwitchJournalOptions): void {
  const parsed = parseCodexSwitchJournal(journal);
  if (parsed === null) throw new Error('Invalid Codex switch journal');
  const path = codexSwitchJournalPath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteText(path, `${JSON.stringify(parsed)}\n`, { mode: 0o600, followSymlinks: false });
  (options.fsyncDirectory ?? fsyncDirSync)(dirname(path));
}

/** The attempt's own write: atomic mode-0600 bytes plus a dir fsync, and registers the attempt as executing. */
export function writeCodexSwitchJournal(journal: CodexSwitchJournal, options: CodexSwitchJournalOptions = {}): void {
  persistCodexSwitchJournal(journal, options);
  executingCodexAttempts.add(journal.attemptId);
}

/** Call in an attempt's finally block after its conditional release attempt. */
export function finishCodexSwitchAttempt(attemptId: string): void { executingCodexAttempts.delete(attemptId); }

/** Serialize mutations of one journal with the opt-in proper-lockfile protocol. */
export async function withCodexSwitchJournalOwner<T>(options: CodexSwitchJournalOptions, fn: (held: HeldCodexSwitchJournalOwner) => Promise<T> | T): Promise<T> {
  const journalDir = codexSwitchJournalDir(options);
  return withProperLockfile(codexSwitchJournalOwnerLockPath({ ...options, journalDir }), {
    timeoutMs: options.ownerLockTimeoutMs ?? CODEX_SWITCH_JOURNAL_TIMEOUT_MS,
    stalenessMs: options.ownerLockStalenessMs ?? CODEX_SWITCH_JOURNAL_STALENESS_MS,
    retryMinMs: options.ownerLockRetryMinMs, retryJitterMs: options.ownerLockRetryJitterMs,
    // Always opt in: a journal owner must never silently publish after takeover.
    onCompromised: (error) => { options.onOwnerLockCompromised?.(error); },
  }, async (proper: HeldProperLockfile) => {
    const result = await fn({ [journalOwnerHandle]: true, journalDir, assertHeld: () => proper.assertNotCompromised() });
    // A lease lost during fn must surface as a failure, never as a reported success.
    proper.assertNotCompromised();
    return result;
  });
}

function assertJournalOwner(held: HeldCodexSwitchJournalOwner, options: CodexSwitchJournalOptions): void {
  if (!held || held[journalOwnerHandle] !== true || held.journalDir !== codexSwitchJournalDir(options)) throw new Error('Codex switch journal owner lock must be held');
  held.assertHeld();
}
function unionAccounts(oldAccounts: string[] | '*', accounts: string[] | '*'): string[] | '*' {
  return oldAccounts === '*' || accounts === '*' ? '*' : [...new Set([...oldAccounts, ...accounts])].sort();
}

/** Conditional append-only unresolved fence update; deleted/replaced journals are untouched. */
export function markCodexSwitchJournalUnresolved(held: HeldCodexSwitchJournalOwner, attemptId: string, reason: string, involvedAccounts: string[] | '*', options: CodexSwitchJournalOptions = {}): boolean {
  const resolved = { ...options, journalDir: held.journalDir };
  assertJournalOwner(held, resolved);
  const current = readCodexSwitchJournal(resolved);
  if (current.state !== 'ok' || current.journal.attemptId !== attemptId) return false;
  const previous = current.journal.unresolved;
  persistCodexSwitchJournal({ ...current.journal, unresolved: { reason,
    involvedAccounts: unionAccounts(previous?.involvedAccounts ?? [], involvedAccounts),
    since: previous?.since ?? (options.now ?? Date.now)() } }, resolved);
  return true;
}

/** Conditional append-only target-adoption attribution; never recreates a removed journal. */
export function markCodexSwitchJournalAdoptingTarget(held: HeldCodexSwitchJournalOwner, attemptId: string, fingerprint: string, options: CodexSwitchJournalOptions = {}): boolean {
  const resolved = { ...options, journalDir: held.journalDir };
  assertJournalOwner(held, resolved);
  const current = readCodexSwitchJournal(resolved);
  if (current.state !== 'ok' || current.journal.attemptId !== attemptId) return false;
  persistCodexSwitchJournal({ ...current.journal, adoptingTarget: [...current.journal.adoptingTarget, fingerprint] }, resolved);
  return true;
}

/** Conditional deletion prevents recovery of one attempt deleting a successor's journal. */
export function deleteCodexSwitchJournalIf(journalDir: string, attemptId: string, held: HeldCodexSwitchJournalOwner, options: CodexSwitchJournalOptions = {}): boolean {
  const resolved = { ...options, journalDir };
  assertJournalOwner(held, resolved);
  const current = readCodexSwitchJournal(resolved);
  if (current.state !== 'ok' || current.journal.attemptId !== attemptId) return false;
  unlinkSync(codexSwitchJournalPath(resolved));
  (options.fsyncDirectory ?? fsyncDirSync)(journalDir);
  return true;
}

/** Conditional release under a held owner lock: change only a matching journal's owner.state. */
export function releaseCodexSwitchJournalHeld(held: HeldCodexSwitchJournalOwner, attemptId: string, options: CodexSwitchJournalOptions = {}): boolean {
  const resolved = { ...options, journalDir: held.journalDir };
  assertJournalOwner(held, resolved);
  const current = readCodexSwitchJournal(resolved);
  if (current.state !== 'ok' || current.journal.attemptId !== attemptId) return false;
  persistCodexSwitchJournal({ ...current.journal, owner: { ...current.journal.owner, state: 'released' } }, resolved);
  return true;
}

/** When the owner lock was lost: re-acquire a ten-second owner lease, then release conditionally. */
export async function releaseCodexSwitchJournal(attemptId: string, options: CodexSwitchJournalOptions = {}): Promise<boolean> {
  return withCodexSwitchJournalOwner({ ...options, ownerLockTimeoutMs: CODEX_SWITCH_JOURNAL_TIMEOUT_MS },
    (held) => releaseCodexSwitchJournalHeld(held, attemptId, options));
}

export type CodexSwitchJournalProbe<T = undefined> =
  | { state: 'absent' } | { state: 'malformed' }
  | { state: 'in-progress'; journal: CodexSwitchJournal }
  | { state: 'orphaned'; journal: CodexSwitchJournal; result: T | undefined }
  | { state: 'owner-lock-not-yet-stale'; journal: CodexSwitchJournal; retryAt: number };
function ownerLockRetryAt(options: CodexSwitchJournalOptions): number {
  try { return statSync(codexSwitchJournalOwnerLockPath(options)).mtimeMs + (options.ownerLockStalenessMs ?? CODEX_SWITCH_JOURNAL_STALENESS_MS); }
  catch { return (options.now ?? Date.now)() + (options.ownerLockStalenessMs ?? CODEX_SWITCH_JOURNAL_STALENESS_MS); }
}

async function journalInProgress(journal: CodexSwitchJournal, options: CodexSwitchJournalOptions): Promise<boolean> {
  return journal.owner.state === 'active'
    && await (options.sameProcess ?? stillTheSameProcess)(journal.owner)
    && !(journal.owner.pid === process.pid && !executingCodexAttempts.has(journal.attemptId));
}

export type OrphanedCodexSwitchJournal = { journal: CodexSwitchJournal; held: HeldCodexSwitchJournalOwner };

/**
 * Probe under the caller's switch→auth locks; a live active owner wins at any lock age.
 * An orphaned journal is handed to `onOrphaned` while the owner lock is still held.
 */
export async function probeCodexSwitchJournal<T = undefined>(options: CodexSwitchJournalOptions = {},
  onOrphaned?: (orphan: OrphanedCodexSwitchJournal) => Promise<T> | T): Promise<CodexSwitchJournalProbe<T>> {
  const initial = readCodexSwitchJournal(options);
  if (initial.state !== 'ok') return initial;
  if (await journalInProgress(initial.journal, options)) return { state: 'in-progress', journal: initial.journal };
  let acquired = false;
  try {
    return await withCodexSwitchJournalOwner<CodexSwitchJournalProbe<T>>(options, async (held) => {
      acquired = true;
      const reread = readCodexSwitchJournal(options);
      if (reread.state !== 'ok') return reread;
      // A successor may have replaced the journal while we waited for the owner lock.
      if (await journalInProgress(reread.journal, options)) return { state: 'in-progress', journal: reread.journal };
      return { state: 'orphaned', journal: reread.journal, result: await onOrphaned?.({ journal: reread.journal, held }) };
    });
  } catch (error) {
    // Only a timeout acquiring the owner lock is translated; onOrphaned's own errors propagate.
    if (acquired || !(error instanceof ClaudeCodeLockTimeout)) throw error;
    // A successor may hold the lock past our timeout: a live active owner wins at any lock age.
    const latest = readCodexSwitchJournal(options);
    if (latest.state !== 'ok') return latest;
    if (await journalInProgress(latest.journal, options)) return { state: 'in-progress', journal: latest.journal };
    return { state: 'owner-lock-not-yet-stale', journal: latest.journal, retryAt: ownerLockRetryAt(options) };
  }
}

export type CodexSwitchResult = {
  outcome: 'ok' | 'noop' | 'failed' | 'refused' | 'reverted-by-codex'; reason?: string; message?: string;
  switchId?: number; attemptId?: string; watch?: { state: 'pending'; until: number }; lockLostAfterCommit?: boolean;
};
export interface SwitchCodexInput {
  target: string; trigger: string;
  /** Store uses leftRecoveryAt; the durable journal deliberately says leftRecoveryAtMs. */
  decision?: { leftHeadroom?: number | null; leftRecoveryAt?: number | null; leftTrigger?: string | null };
}
const switchResult = (reason: string, message?: string): CodexSwitchResult =>
  ({ outcome: 'refused', reason, ...(message === undefined ? {} : { message }) });
function journalDecision(decision: SwitchCodexInput['decision']): CodexSwitchJournal['decision'] {
  return decision ? { leftHeadroom: decision.leftHeadroom ?? null, leftRecoveryAtMs: decision.leftRecoveryAt ?? null,
    leftTrigger: decision.leftTrigger ?? null } : null;
}
function switchRefusal(deps: CodexSwitchDeps, input: SwitchCodexInput, reason: string): CodexSwitchResult {
  deps.store.recordSwitch({ ts: deps.now(), provider: PROVIDER, fromAccount: deps.store.getCodexActiveLogin(),
    toAccount: input.target, trigger: input.trigger, outcome: 'refused', detail: reason,
    stepsJson: JSON.stringify({ attempt: deps.attempt, via: 'switch' }), publishedAt: null });
  return switchResult(reason);
}
function openSessionsJson(deps: CodexSwitchDeps, sessions: CodexProcess[]): string {
  if (!deps.dbPath) return JSON.stringify(sessions);
  const history = readCodexSwitchHistory(deps.dbPath, { journalDir: deps.journalDir });
  const sets = holderSets(history.rows, history.observations);
  return JSON.stringify(sessions.map((session) => {
    const at = Date.parse(`${session.lstart} UTC`);
    const holderSet = Number.isFinite(at) ? [...new Set(sets.filter((set) =>
      (set.startsAt === null || at >= set.startsAt) && (set.endsAt === null || at < set.endsAt))
      .flatMap((set) => set.identities))].sort() : [];
    return { ...session, holderSet };
  }));
}

/** C6-20: roll a durable journal forward, but never guess through a fence. */
export async function reconcileCodexRecoveryLocked(
  deps: CodexSwitchDeps,
  assertHeld: () => void,
): Promise<{ state: 'clear' } | { state: 'fenced'; reason: string; message: string; accounts: Set<string> | '*'; retryAt?: number }> {
  if (!deps.journalDir || !deps.slots || !deps.keychain || !deps.list) throw new Error('Codex recovery dependencies are required');
  const slots = deps.slots;
  const keychain = deps.keychain;
  const list = deps.list;
  const options: CodexSwitchJournalOptions = { ...deps.journalOptions, journalDir: deps.journalDir, now: deps.now };
  const fenced = (reason: string, accounts: Set<string> | '*', retryAt?: number, message = codexRecoveryFenceMessage(reason)) => ({
    state: 'fenced' as const, reason, accounts, message,
    ...(retryAt === undefined ? {} : { retryAt }),
  });
  const accountSet = (journal: CodexSwitchJournal, involved: string[] | '*' = []): Set<string> | '*' =>
    involved === '*' ? '*' : new Set([journal.from, journal.to, ...involved]);
  /** Slot B's document, or undefined when `tolerate` and its Keychain item is missing or unreadable. */
  const readTargetSlot = (accountId: string, tolerate: boolean): CodexAuthDocument | undefined => {
    try { return slots.readSlot(accountId, { fresh: true }).document; }
    catch (error) { if (tolerate) return undefined; throw error; }
  };
  /**
   * Without attribution, a slot's SQLite head may only resolve recovery when its Keychain copy
   * backs it (read fresh): a missing, unreadable or different copy is a split and maps to null.
   */
  const verifySlotHeads = (slotHeads: Map<string, string | null>): void => {
    for (const [accountId, head] of slotHeads) {
      if (head === null) continue;
      let keychainFp: string | null;
      try { keychainFp = codexFingerprint(slots.readSlot(accountId, { fresh: true }).document); } catch { keychainFp = null; }
      if (keychainFp !== head) slotHeads.set(accountId, null);
    }
  };

  const resolveJournal = async (journal: CodexSwitchJournal, held: HeldCodexSwitchJournalOwner): Promise<ReturnType<typeof fenced> | { state: 'clear' }> => {
    assertHeld(); held.assertHeld();
    if (deps.store.findCodexSwitchByAttempt(journal.attemptId)) {
      deleteCodexSwitchJournalIf(deps.journalDir!, journal.attemptId, held, options);
      return { state: 'clear' };
    }
    const observed = await deps.readLive();
    const targetRow = deps.store.getCodexSlot(journal.to);
    const classified = classifyPostPublish({ journal, observed, targetSlotFp: targetRow?.fingerprint ?? '' });
    // §3.1: an unstable or unreadable read is pending, target-changed included; nothing is written.
    if (classified === 'target-changed' && (observed.status === 'unstable' || observed.status === 'unreadable')) {
      return fenced(`journal-verify-${observed.status}`, accountSet(journal, journal.unresolved?.involvedAccounts));
    }
    const live = observed.status === 'ok' ? observed.doc : undefined;
    const liveIdentity = live ? codexIdentity(live) : null;
    const slotHeads = new Map<string, string | null>();
    for (const accountId of [journal.from, journal.to]) slotHeads.set(accountId, deps.store.getCodexSlot(accountId)?.fingerprint ?? null);
    if (liveIdentity) slotHeads.set(liveIdentity, deps.store.getCodexSlot(liveIdentity)?.fingerprint ?? null);
    let attribution: CodexPhaseAttribution | undefined;
    // A classified ok with B moved by a recorded adoption is decided by its attribution (§3.1).
    const targetMoved = (targetRow?.fingerprint ?? '') !== journal.target.fingerprint;
    const attribute = (typeof classified === 'object' && classified.status === 'external') || classified === 'target-changed'
      || (classified === 'ok' && targetMoved);
    // With no live document (wiped, missing, unstable, unreadable) or no slot B there is nothing to
    // attribute: the verdict fences, or is pending, without it.
    // A target-changed attempt can resolve without attribution (§3.1), so an unreadable slot B
    // only makes attribution unavailable: B then has no established head.
    const target = attribute && live && targetRow ? readTargetSlot(journal.to, classified === 'target-changed') : undefined;
    if (attribute && live && targetRow && !target) {
      slotHeads.set(journal.to, null);
      verifySlotHeads(slotHeads);
    }
    if (target && live && targetRow) {
      const targetFp = codexFingerprint(target);
      const history = deps.dbPath ? readCodexSwitchHistory(deps.dbPath, { journalDir: deps.journalDir }) : { rows: [], observations: [] };
      const currentSessions = await list();
      attribution = await attributeForPhase({ assertHeld }, 'recovery', {
        store: deps.store, keychain, slot: { accountId: journal.to, document: target, fingerprint: targetRow?.fingerprint ?? undefined },
        activeSlotId: journal.from, activeSetBy: 'adopt', live,
        holderObservation: {
          aliveBefore: liveIdentity !== null && renewers(codexIdentityParts(liveIdentity), journal.openSessions, history.rows, history.observations).length > 0,
          aliveAfter: liveIdentity !== null && renewers(codexIdentityParts(liveIdentity), currentSessions, history.rows, history.observations).length > 0,
        },
        l40Verified: deps.store.getConfig('codex.l40Verified') === '1', now: deps.now,
        beforeSave: (_db, _dbPath, slotId) => {
          if (slotId !== journal.to || codexFingerprint(live) === targetFp) return undefined;
          assertHeld(); held.assertHeld();
          if (!markCodexSwitchJournalAdoptingTarget(held, journal.attemptId, codexFingerprint(live), options)) {
            throw new Error('Codex switch journal changed before recovery target adoption');
          }
          return undefined;
        },
      });
      if (attribution.action === 'unclaimed') {
        try { await slots.ensureUnclaimedStash!(live, deps.now()); }
        catch (error) {
          if (error instanceof CodexStashUnverifiable) attribution = { action: 'stash-unverifiable' };
          else throw error;
        }
      }
      slotHeads.set(journal.to, deps.store.getCodexSlot(journal.to)?.fingerprint ?? null);
      if (liveIdentity) slotHeads.set(liveIdentity, deps.store.getCodexSlot(liveIdentity)?.fingerprint ?? null);
    }
    const verdict = resolveRecoveryVerdict(classified, attribution, {
      phase: 'recovery', journal, targetSlotFingerprint: deps.store.getCodexSlot(journal.to)?.fingerprint ?? '', slotHeads, live,
    });
    if (verdict.class === 'pending') return fenced(`journal-verify-${verdict.status}`, accountSet(journal, journal.unresolved?.involvedAccounts));
    if (verdict.class === 'unresolved') {
      assertHeld(); held.assertHeld();
      if (!markCodexSwitchJournalUnresolved(held, journal.attemptId, verdict.reason, verdict.involvedAccounts, options)) {
        throw new Error('Codex switch journal changed before recovery unresolved mark');
      }
      // §3.1: the fenced set is unioned and never shrinks until cleared.
      return fenced(verdict.reason, unionRecoveryAccounts([journal.from, journal.to],
        journal.unresolved?.involvedAccounts ?? [], verdict.involvedAccounts));
    }
    const effect = verdict.effect;
    const activeAccountId = 'activeAccountId' in effect ? effect.activeAccountId : undefined;
    // C6-Q2: a resolved target-changed records the slot whose head the live file equals.
    const liveSlot = effect.outcome === 'failed' && effect.detail === 'target-changed' && live
      ? [...slotHeads].find(([, head]) => head === codexFingerprint(live))?.[0] : undefined;
    const accountId = effect.outcome === 'ok' ? journal.to : effect.outcome === 'reverted-by-codex' ? effect.accountId
      : liveSlot ?? (activeAccountId === null ? null : journal.from);
    const outcome: CodexSwitchResult['outcome'] = effect.outcome === 'quiet' ? 'ok' : effect.outcome === 'stopped' ? 'failed' : effect.outcome;
    const detail = effect.outcome === 'failed' ? effect.detail : effect.outcome === 'stopped' ? effect.reason : null;
    assertHeld(); held.assertHeld(); deps.crashAt?.('recovery-before-commit');
    // §3.1: a revert moves active_login to the slot found in the file (`adopt`); C6-Q2 likewise.
    const setBy = liveSlot || effect.outcome === 'reverted-by-codex' ? 'adopt' : 'journal';
    deps.store.commitCodexSwitch({ now: deps.now(), accountId, setBy, fromAccount: journal.from, toAccount: journal.to,
      trigger: journal.trigger, outcome, attempt: journal.attemptId, via: 'journal', openSessionsJson: openSessionsJson(deps, journal.openSessions),
      publishedAt: detail === 'not-published' ? null : journal.publishedAt, committedAt: deps.now(), detail,
      outgoing: journal.from, target: journal.to,
      observation: live ? { identity: liveIdentity, lineageFp: codexFingerprint(live) } : { identity: null, lineageFp: null },
      decision: { leftHeadroom: journal.decision?.leftHeadroom ?? null, leftRecoveryAt: journal.decision?.leftRecoveryAtMs ?? null,
        leftTrigger: journal.decision?.leftTrigger ?? null } });
    assertHeld(); held.assertHeld(); deps.crashAt?.('recovery-after-commit');
    deleteCodexSwitchJournalIf(deps.journalDir!, journal.attemptId, held, options);
    return { state: 'clear' };
  };

  const probe = await probeCodexSwitchJournal(options, ({ journal, held }) => resolveJournal(journal, held));
  if (probe.state === 'malformed') return fenced('switch-recovery-malformed', '*');
  if (probe.state === 'in-progress') {
    return fenced('journal-in-progress', accountSet(probe.journal, probe.journal.unresolved?.involvedAccounts), undefined,
      codexInFlightMessage('journal-in-progress'));
  }
  if (probe.state === 'owner-lock-not-yet-stale') {
    return fenced('journal-owner-lock-not-yet-stale', accountSet(probe.journal, probe.journal.unresolved?.involvedAccounts), probe.retryAt,
      codexInFlightMessage('journal-owner-lock-not-yet-stale'));
  }
  // A resolved journal does not clear a config fence that is also stored: go on to it.
  if (probe.state === 'orphaned' && probe.result?.state === 'fenced') return probe.result;

  const fence = parseCodexRecoveryFence(deps.store.getConfig('codex.recoveryFence'));
  if (deps.store.hasConfig('codex.recoveryFence') && fence === null) return fenced('switch-recovery-malformed', '*');
  if (fence === null) return { state: 'clear' };
  // A config fence has no credential bytes. Its switch row supplies context;
  // the current B head is deliberately re-read under these locks.
  const targetRow = deps.store.getCodexSlot(fence.to);
  const pseudoJournal: CodexSwitchJournal = { v: 2, attemptId: fence.attempt, from: fence.from, to: fence.to,
    target: { identity: codexIdentityParts(fence.to), fingerprint: targetRow?.fingerprint ?? '' }, adoptingTarget: [], trigger: 'manual', decision: null,
    openSessions: [], outgoing: { sha256: '', inode: -1 }, publishedAt: fence.publishedAt,
    owner: { pid: 1, lstart: 'fence', state: 'released' } };
  const observed = await deps.readLive();
  const live = observed.status === 'ok' ? observed.doc : undefined;
  const liveIdentity = live ? codexIdentity(live) : null;
  const slotHeads = new Map<string, string | null>([[fence.from, deps.store.getCodexSlot(fence.from)?.fingerprint ?? null], [fence.to, targetRow?.fingerprint ?? null]]);
  if (liveIdentity) slotHeads.set(liveIdentity, deps.store.getCodexSlot(liveIdentity)?.fingerprint ?? null);
  // A fence has no journaled target fingerprint, so a target-changed fence stays target-changed:
  // it resolves only once live equals a current slot head (§3.1, C6-Q2).
  // An unstable or unreadable read stays pending even for a target-changed fence (§3.1).
  const transient = observed.status === 'unstable' || observed.status === 'unreadable';
  const classified: CodexPostPublishClassification = fence.reason === 'target-changed' && !transient ? 'target-changed'
    : classifyPostPublish({ journal: pseudoJournal, observed, targetSlotFp: targetRow?.fingerprint ?? '' });
  const fencedAccounts = unionRecoveryAccounts([fence.from, fence.to], fence.involvedAccounts);
  let attribution: CodexPhaseAttribution | undefined;
  const attribute = ((typeof classified === 'object' && classified.status === 'external') || classified === 'target-changed') && live && targetRow;
  // An unreadable slot B makes attribution unavailable: B has no established head, and a fence
  // that needs attribution to resolve is kept as stored, with no write.
  const target = attribute ? readTargetSlot(fence.to, true) : undefined;
  if (attribute && !target) {
    if (classified !== 'target-changed') {
      // §3.1: the live identity's managed slot is fenced whatever the attribution says.
      if (liveIdentity && deps.store.getCodexSlot(liveIdentity) && fencedAccounts !== '*' && !fencedAccounts.has(liveIdentity)) {
        assertHeld();
        deps.store.setRecoveryFence({ ...fence, involvedAccounts: [liveIdentity] });
        const stored = parseCodexRecoveryFence(deps.store.getConfig('codex.recoveryFence'));
        return fenced(stored?.reason ?? fence.reason, unionRecoveryAccounts([fence.from, fence.to], stored?.involvedAccounts ?? '*'));
      }
      return fenced(fence.reason, fencedAccounts);
    }
    slotHeads.set(fence.to, null);
    verifySlotHeads(slotHeads);
  }
  if (target && live && targetRow) {
    // §3 holder evidence: aliveBefore from the fence's switch row snapshot, aliveAfter from the current list().
    const history = deps.dbPath ? readCodexSwitchHistory(deps.dbPath, { journalDir: deps.journalDir }) : { rows: [], observations: [] };
    const recorded = recordedOpenSessions(history.rows.find((row) => row.id === fence.switchId)?.open_sessions_json);
    const currentSessions = await list();
    attribution = await attributeForPhase({ assertHeld }, 'recovery', { store: deps.store, keychain,
      slot: { accountId: fence.to, document: target, fingerprint: targetRow.fingerprint ?? undefined }, activeSlotId: fence.from,
      activeSetBy: 'adopt', live, holderObservation: {
        aliveBefore: liveIdentity !== null && renewers(codexIdentityParts(liveIdentity), recorded, history.rows, history.observations).length > 0,
        aliveAfter: liveIdentity !== null && renewers(codexIdentityParts(liveIdentity), currentSessions, history.rows, history.observations).length > 0,
      },
      l40Verified: deps.store.getConfig('codex.l40Verified') === '1', now: deps.now });
    if (attribution.action === 'unclaimed') {
      try { await slots.ensureUnclaimedStash!(live, deps.now()); }
      catch (error) { if (error instanceof CodexStashUnverifiable) attribution = { action: 'stash-unverifiable' }; else throw error; }
    }
    slotHeads.set(fence.to, deps.store.getCodexSlot(fence.to)?.fingerprint ?? null);
    if (liveIdentity) slotHeads.set(liveIdentity, deps.store.getCodexSlot(liveIdentity)?.fingerprint ?? null);
  }
  const verdict = resolveRecoveryVerdict(classified, attribution, { phase: 'recovery', journal: pseudoJournal,
    targetSlotFingerprint: deps.store.getCodexSlot(fence.to)?.fingerprint ?? '', slotHeads, live });
  if (verdict.class === 'pending') {
    return fenced(`journal-verify-${verdict.status}`, fencedAccounts);
  }
  if (verdict.class === 'unresolved') {
    assertHeld();
    deps.store.setRecoveryFence({ ...fence, reason: verdict.reason, involvedAccounts: verdict.involvedAccounts, since: fence.since });
    // Report what was stored (the store keeps a target-changed reason and unions the set), so this
    // call and later codexRecoveryFenceState reads agree.
    const stored = parseCodexRecoveryFence(deps.store.getConfig('codex.recoveryFence'));
    return fenced(stored?.reason ?? verdict.reason,
      unionRecoveryAccounts([fence.from, fence.to], fence.involvedAccounts, verdict.involvedAccounts, stored?.involvedAccounts ?? []));
  }
  const effect = verdict.effect;
  // C6-Q2: a resolved target-changed records the slot whose head the live file equals.
  const liveSlot = effect.outcome === 'failed' && effect.detail === 'target-changed' && live
    ? [...slotHeads].find(([, head]) => head === codexFingerprint(live))?.[0] : undefined;
  const setActive = effect.outcome === 'reverted-by-codex' ? effect.accountId
    : liveSlot ?? ('activeAccountId' in effect && effect.activeAccountId === null ? null : undefined);
  deps.crashAt?.('recovery-before-fence-commit');
  assertHeld();
  deps.store.commitFenceResolution({ fence, effect: effect as Parameters<Store['commitFenceResolution']>[0]['effect'], setActive,
    attempt: fence.attempt, now: deps.now() });
  return { state: 'clear' };
}

/** Take switch → auth, then perform the sole journal/fence clearing path. */
export async function reconcileCodexRecovery(deps: CodexSwitchDeps): Promise<Awaited<ReturnType<typeof reconcileCodexRecoveryLocked>>> {
  // No durable artifact means there is nothing to clear. This fast read avoids
  // serializing ordinary switches; a journal racing in after it is still seen
  // by freshen/phase L under the switch lock.
  if (deps.journalDir && codexRecoveryFenceState(deps.journalDir, deps.store).state === 'none') return { state: 'clear' };
  return withCodexSwitchLocks(deps, (assertHeld) => reconcileCodexRecoveryLocked(deps, assertHeld));
}

/** X10b: a watch row consumed this long after its until is deleted without a verdict (C6 plan, C6-22 row). */
export const CODEX_WATCH_OVERDUE_MS = 60_000;

export interface CodexWatch {
  switchId: number;
  outgoing: string;
  target: string;
  trigger: string;
  attempt: string;
  publishedAt: number;
  openSessions: CodexProcess[];
  until: number;
}

export type CodexWatchTickResult =
  | { state: 'quiet' }
  | { state: 'reverted' }
  | { state: 'stopped'; reason: string }
  | { state: 'unresolved'; reason: string }
  | { state: 'inconclusive' };

/** One locked, phase-safe observation of a committed switch's live Codex file. */
export async function codexWatchTick(deps: CodexSwitchDeps, watch: CodexWatch): Promise<CodexWatchTickResult> {
  const admitted = await deps.admitted?.(watch.trigger) ?? { ok: true };
  if (!admitted.ok) return { state: 'stopped', reason: 'not-admitted' };
  if (!deps.slots || !deps.keychain || !deps.list || !deps.journalDir) throw new Error('Codex watch dependencies are required');
  const slots = deps.slots;
  const keychain = deps.keychain;
  const list = deps.list;
  /**
   * The generation guard (§3) with this watch's own fence resolution told apart: the row
   * commitFenceResolution writes for this switch carries its attempt and via 'fence'
   * (attempts are unique per switch). Latest row wins; an unparseable row supersedes.
   */
  const settledByRows = (): CodexWatchTickResult | undefined => {
    const latest = deps.store.codexPublishingRowsAfter(watch.switchId).at(-1);
    if (!latest) return undefined;
    let steps: { attempt?: unknown; via?: unknown } = {};
    try { steps = latest.stepsJson ? JSON.parse(latest.stepsJson) as typeof steps : {}; } catch { /* not a fence resolution */ }
    if (steps.via !== 'fence' || steps.attempt !== watch.attempt) return { state: 'stopped', reason: 'superseded' };
    if (latest.outcome === 'reverted-by-codex') return { state: 'reverted' };
    return latest.outcome === 'ok' ? { state: 'quiet' } : { state: 'stopped', reason: latest.detail ?? latest.outcome };
  };
  return withCodexSwitchLocks(deps, async (assertHeld): Promise<CodexWatchTickResult> => {
    // X10b: an overdue row is consumed without a verdict, even under a fence (the fence keeps its own context).
    if (deps.now() >= watch.until + CODEX_WATCH_OVERDUE_MS) {
      assertHeld(); deps.store.deleteCodexWatch(watch.switchId);
      return { state: 'stopped', reason: 'overdue' };
    }
    const before = settledByRows();
    if (before) return before;
    // The locked form: this tick already holds switch → auth (no re-entry).
    const recovery = await reconcileCodexRecoveryLocked(deps, assertHeld);
    if (recovery.state === 'fenced') return { state: 'quiet' };
    // A fence this recovery resolved already wrote its effect row: report it, never attribute again.
    // A later switch's orphaned journal it committed supersedes the watch.
    const after = settledByRows();
    if (after) return after;
    const observed = await deps.readLive();
    if (observed.status === 'missing') { assertHeld(); deps.store.deleteCodexWatch(watch.switchId); return { state: 'stopped', reason: 'logged-out' }; }
    if (observed.status === 'unstable' || observed.status === 'unreadable') {
      return deps.now() >= watch.until ? { state: 'inconclusive' } : { state: 'quiet' };
    }
    if (observed.status === 'wiped') {
      assertHeld(); deps.store.recordCodexObservation({ identity: null, lineageFp: null, by: 'qlb-watch', now: deps.now() });
      deps.store.deleteCodexWatch(watch.switchId);
      return { state: 'stopped', reason: 'wiped' };
    }
    const live = observed.doc;
    const liveIdentity = codexIdentity(live);
    const targetRow = deps.store.getCodexSlot(watch.target);
    if (!targetRow?.fingerprint) throw new Error('Codex watch target slot is missing');
    // Settled on target = live equals slot B's recorded head, as in recovery; anything else is attributed.
    const targetFp = targetRow.fingerprint;
    const classified: CodexPostPublishClassification = codexFingerprint(live) === targetFp ? 'ok' : { status: 'external', doc: live };
    const slotHeads = new Map<string, string | null>([
      [watch.outgoing, deps.store.getCodexSlot(watch.outgoing)?.fingerprint ?? null],
      [watch.target, targetRow.fingerprint],
    ]);
    if (liveIdentity) slotHeads.set(liveIdentity, deps.store.getCodexSlot(liveIdentity)?.fingerprint ?? null);
    let attribution: CodexPhaseAttribution | undefined;
    if (typeof classified === 'object' && classified.status === 'external') {
      let target: CodexAuthDocument;
      try { target = slots.readSlot(watch.target, { fresh: true }).document; }
      catch {
        // C6-21-R1 (from C6-20d): B's row with no readable Keychain copy is a split; fence {A, B}, no other write.
        const reason = 'slot-split';
        assertHeld(); deps.store.setRecoveryFence({ v: 1, switchId: watch.switchId, attempt: watch.attempt, from: watch.outgoing, to: watch.target,
          publishedAt: watch.publishedAt, reason, involvedAccounts: [watch.outgoing, watch.target].sort(), since: deps.now() });
        return { state: 'unresolved', reason };
      }
      const history = deps.dbPath ? readCodexSwitchHistory(deps.dbPath, { journalDir: deps.journalDir }) : { rows: [], observations: [] };
      const current = await list();
      // After the committed switch, B is the active login.
      attribution = await attributeForPhase({ assertHeld }, 'watch', { store: deps.store, keychain,
        slot: { accountId: watch.target, document: target, fingerprint: targetFp }, activeSlotId: watch.target,
        activeSetBy: 'adopt', live, holderObservation: {
          aliveBefore: liveIdentity !== null && renewers(codexIdentityParts(liveIdentity), watch.openSessions, history.rows, history.observations).length > 0,
          aliveAfter: liveIdentity !== null && renewers(codexIdentityParts(liveIdentity), current, history.rows, history.observations).length > 0,
        }, l40Verified: deps.store.getConfig('codex.l40Verified') === '1', now: deps.now });
      if (attribution.action === 'unclaimed') {
        assertHeld();
        try { await slots.ensureUnclaimedStash!(live, deps.now()); }
        catch (error) { if (error instanceof CodexStashUnverifiable) attribution = { action: 'stash-unverifiable' }; else throw error; }
      }
      slotHeads.set(watch.target, deps.store.getCodexSlot(watch.target)?.fingerprint ?? null);
      if (liveIdentity) slotHeads.set(liveIdentity, deps.store.getCodexSlot(liveIdentity)?.fingerprint ?? null);
    }
    assertHeld(); deps.store.recordCodexObservation({ identity: liveIdentity, lineageFp: codexFingerprint(live), by: 'qlb-watch', now: deps.now() });
    const journal: Pick<CodexSwitchJournal, 'from' | 'to' | 'target' | 'adoptingTarget'> = {
      from: watch.outgoing, to: watch.target, target: { identity: codexIdentityParts(watch.target), fingerprint: targetFp }, adoptingTarget: [],
    };
    const verdict = resolveRecoveryVerdict(classified, attribution, { phase: 'watch', watch: journal,
      targetSlotFingerprint: deps.store.getCodexSlot(watch.target)?.fingerprint ?? '', slotHeads, live });
    // classified is ok or external, so the verdict is never pending.
    if (verdict.class === 'pending') throw new Error('Codex watch verdict cannot be pending');
    if (verdict.class === 'unresolved') {
      assertHeld(); deps.store.setRecoveryFence({ v: 1, switchId: watch.switchId, attempt: watch.attempt, from: watch.outgoing, to: watch.target,
        publishedAt: watch.publishedAt, reason: verdict.reason, involvedAccounts: verdict.involvedAccounts, since: deps.now() });
      return { state: 'unresolved', reason: verdict.reason };
    }
    const effect = verdict.effect;
    if (effect.outcome === 'quiet') return { state: 'quiet' };
    if (effect.outcome === 'reverted-by-codex') {
      deps.crashAt?.('watch-before-revert-commit');
      assertHeld(); deps.store.commitCodexWatchRevert({ watch, setActive: effect.accountId, attempt: watch.attempt, now: deps.now() });
      return { state: 'reverted' };
    }
    if (effect.outcome === 'stopped' && effect.reason === 'unknown-live-identity') {
      assertHeld(); deps.store.commitCodexWatchStop({ watch, attempt: watch.attempt, now: deps.now() });
      return { state: 'stopped', reason: 'unknown-live-identity' };
    }
    // Missing and wiped returned above; failed/ok are post/recovery effects only.
    throw new Error(`Codex watch cannot apply the ${effect.outcome} effect`);
  });
}

/** C6-18: switch through the journaled publication; C6-20 supplies recovery. */
export async function switchCodex(deps: CodexSwitchDeps, input: SwitchCodexInput): Promise<CodexSwitchResult> {
  const admitted = await deps.admitted?.(input.trigger) ?? { ok: true };
  if (!admitted.ok) return switchResult(admitted.reason ?? 'not-admitted');
  const recovery = await reconcileCodexRecovery(deps);
  if (recovery.state === 'fenced') return switchResult(recovery.reason, recovery.message);
  const preflight = await preflightCodexLive(deps);
  if (preflight.kind === 'refused') return switchResult(preflight.reason);
  const preconditions = checkCodexSwitchPreconditions(deps, input);
  if (preconditions.kind === 'refused') return switchResult(preconditions.reason);
  if (!deps.authPath || !deps.journalDir || !deps.slots || !deps.list) throw new Error('Codex switch dependencies are required');

  const options: CodexSwitchJournalOptions = { ...deps.journalOptions, journalDir: deps.journalDir, now: deps.now };
  let freshenRound = 0;
  // One budget for the attempt: the first observation plus five restarts (§4.4.1 steps 1 and 4).
  let observeRestarts = 0;
  while (freshenRound < 2) {
    await deps.hooks?.beforeFreshenLock?.();
    const freshen = await freshenCodexTarget(deps, { target: input.target, now: deps.now() });
    if (freshen.kind === 'refused') return switchRefusal(deps, input, freshen.reason);
    let journalExists = false; let released = false; let renamed = false; let commitFailed = false;
    let committed: CodexSwitchResult | undefined;
    try {
      const result = await withCodexSwitchLocks(deps, async (assertHeld) => {
        const fence = codexRecoveryFenceState(deps.journalDir!, deps.store);
        if (fence.state === 'fenced') return { result: switchResult(fence.reason, fence.message) };
        assertHeld();
        const again = checkCodexSwitchPreconditions(deps, input);
        if (again.kind === 'refused') return { result: switchResult(again.reason) };
        // A changed file restarts at step 2 under the same locks, never at the freshen.
        for (;; observeRestarts += 1) {
          if (observeRestarts > 5) return { result: switchRefusal(deps, input, 'codex-writing') };
          let live: ObserveLiveCodexResult;
          try { live = await observeLiveCodex(deps, assertHeld); } catch (error) {
            if (error instanceof CodexLiveChanged) continue;
            throw error;
          }
          if (live.outcome === 'refused') return { result: switchRefusal(deps, input, live.reason) };
          const outgoing = live.outgoing;
          if (codexIdentity(outgoing.document) === input.target) {
            assertHeld(); const now = deps.now();
            const id = deps.store.commitCodexSwitch({ now, accountId: input.target, setBy: input.trigger === 'manual' ? 'manual' : 'auto',
              fromAccount: input.target, toAccount: input.target, trigger: input.trigger, outcome: 'noop', attempt: deps.attempt,
              via: 'switch', openSessionsJson: '[]', publishedAt: null, committedAt: now, outgoing: input.target, target: input.target,
              observation: { identity: input.target, lineageFp: codexFingerprint(outgoing.document) },
              decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null } });
            committed = { outcome: 'noop', switchId: id, attemptId: deps.attempt };
            return { result: committed };
          }
          const target = deps.slots!.readSlot(input.target, { fresh: true });
          const targetIdentity = codexIdentity(target.document); const targetRow = deps.store.getCodexSlot(input.target);
          if (!targetIdentity || targetIdentity !== input.target || targetRow?.fingerprint !== codexFingerprint(target.document)) {
            return { result: switchRefusal(deps, input, 'target-slot-split') };
          }
          if (!expiresAfter(target.document, deps.now() + 300_000)) return { retryFreshen: true };
          const sessions = await deps.list!(); const cas = await deps.readLive();
          if (!sameLiveObservation({ status: 'ok', doc: outgoing.document, sha256: outgoing.sha256, inode: outgoing.inode }, cas)) continue;
          assertHeld();
          const decision = journalDecision(input.decision);
          // C6-10 owner identity: the same `ps lstart` that stillTheSameProcess compares.
          const owner = deps.journalOwner ?? { pid: process.pid, lstart: await processLstart(process.pid) ?? '' };
          return withCodexSwitchJournalOwner(options, async (held) => {
            assertHeld(); held.assertHeld();
            const publishedAt = deps.now();
            const journal: CodexSwitchJournal = { v: 2, attemptId: deps.attempt,
              from: codexIdentity(outgoing.document) ?? deps.store.getCodexActiveLogin() ?? '', to: input.target,
              target: { identity: codexIdentityParts(targetIdentity), fingerprint: codexFingerprint(target.document) }, adoptingTarget: [], trigger: input.trigger,
              decision, openSessions: sessions, outgoing: { sha256: outgoing.sha256, inode: outgoing.inode }, publishedAt,
              owner: { ...owner, state: 'active' } };
            if (!journal.from) throw new Error('Codex switch outgoing identity is required');
            writeCodexSwitchJournal(journal, options); journalExists = true;
            try {
              assertHeld(); held.assertHeld();
              const publish = await publishCodexAuth(deps.authPath!, target.document); renamed = publish.stage === 'published';
              if (renamed) await deps.hooks?.afterRename?.();
              assertHeld(); held.assertHeld(); await deps.hooks?.beforeVerify?.();
              const observed = await deps.readLive();
              const classified = classifyPostPublish({ journal, publish, observed, targetSlotFp: targetRow.fingerprint! });
              // Missing verify reads are deliberately retried by recovery rather
              // than being turned into a logged-out fence by this first attempt.
              // A thrown rename is not-landed whatever the verify read shows (§3.1).
              if (classified !== 'not-landed'
                && (observed.status === 'missing' || observed.status === 'unstable' || observed.status === 'unreadable')) {
                assertHeld(); held.assertHeld();
                releaseCodexSwitchJournalHeld(held, deps.attempt, options); released = true;
                const pendingResult: CodexSwitchResult = { outcome: 'failed', reason: `verify-${observed.status}`, attemptId: deps.attempt };
                return { result: pendingResult };
              }

              let attribution: CodexPhaseAttribution | undefined;
              let currentTarget = deps.store.getCodexSlot(input.target);
              const slotHeads = new Map<string, string | null>();
              for (const accountId of [journal.from, journal.to]) slotHeads.set(accountId, deps.store.getCodexSlot(accountId)?.fingerprint ?? null);
              const liveDocument = observed.status === 'ok' ? observed.doc : undefined;
              const liveIdentity = liveDocument ? codexIdentity(liveDocument) : null;
              if (liveIdentity !== null) slotHeads.set(liveIdentity, deps.store.getCodexSlot(liveIdentity)?.fingerprint ?? null);

              if (typeof classified === 'object' && classified.status === 'external' || classified === 'target-changed') {
                const phaseDeps = observationDeps(deps);
                if (!currentTarget) throw new Error('Codex target slot disappeared during post-publish verification');
                const currentTargetDocument = phaseDeps.slots.readSlot(input.target, { fresh: true }).document;
                const currentTargetFp = codexFingerprint(currentTargetDocument);
                const currentSessions = await phaseDeps.list();
                const postHistory = deps.dbPath
                  ? readCodexSwitchHistory(deps.dbPath, { journalDir: deps.journalDir })
                  : { rows: [], observations: [] };
                const liveIdentityParts = liveIdentity === null ? null : codexIdentityParts(liveIdentity);
                attribution = await attributeForPhase({ assertHeld }, 'post', {
                  store: deps.store,
                  keychain: phaseDeps.keychain,
                  slot: { accountId: input.target, document: currentTargetDocument, fingerprint: currentTarget.fingerprint ?? undefined },
                  activeSlotId: journal.from,
                  activeSetBy: 'adopt',
                  live: liveDocument!,
                  // Post-publish aliveBefore comes from the journal snapshot,
                  // so a holder that exits before verification still counts.
                  holderObservation: {
                    aliveBefore: liveIdentityParts !== null && renewers(liveIdentityParts, journal.openSessions,
                      postHistory.rows, postHistory.observations).length > 0,
                    aliveAfter: liveIdentityParts !== null && renewers(liveIdentityParts, currentSessions,
                      postHistory.rows, postHistory.observations).length > 0,
                  },
                  l40Verified: deps.store.getConfig('codex.l40Verified') === '1',
                  now: deps.now,
                  // The durable acknowledgement has to precede the target-slot
                  // adoption: a crash after attribution must not reclassify B′ as
                  // an import that replaced the original target.  It is written
                  // inside attribution's save, so a verdict that adopts nothing
                  // onto B (target-ancestor, slot-split) never records it (X17).
                  beforeSave: (_db, _dbPath, slotId) => {
                    if (slotId !== input.target || !liveDocument || codexFingerprint(liveDocument) === currentTargetFp) return undefined;
                    assertHeld(); held.assertHeld();
                    if (!markCodexSwitchJournalAdoptingTarget(held, deps.attempt, codexFingerprint(liveDocument), options)) {
                      throw new Error('Codex switch journal changed before the target adoption was recorded');
                    }
                    return undefined;
                  },
                });
                if (attribution.action === 'unclaimed') {
                  assertHeld(); held.assertHeld();
                  try {
                    await phaseDeps.slots.ensureUnclaimedStash!(liveDocument!, deps.now());
                  } catch (error) {
                    if (error instanceof CodexStashUnverifiable) attribution = { action: 'stash-unverifiable' };
                    else throw error;
                  }
                }
                currentTarget = deps.store.getCodexSlot(input.target);
                slotHeads.set(input.target, currentTarget?.fingerprint ?? null);
                if (liveIdentity !== null) slotHeads.set(liveIdentity, deps.store.getCodexSlot(liveIdentity)?.fingerprint ?? null);
              }

              const verdict = resolveRecoveryVerdict(classified, attribution, {
                phase: 'post', journal, targetSlotFingerprint: currentTarget?.fingerprint ?? '',
                slotHeads, live: liveDocument,
              });
              if (verdict.class === 'pending') {
                assertHeld(); held.assertHeld();
                releaseCodexSwitchJournalHeld(held, deps.attempt, options); released = true;
                const pendingResult: CodexSwitchResult = { outcome: 'failed', reason: `verify-${verdict.status}`, attemptId: deps.attempt };
                return { result: pendingResult };
              }
              if (verdict.class === 'unresolved') {
                assertHeld(); held.assertHeld();
                if (!markCodexSwitchJournalUnresolved(held, deps.attempt, verdict.reason, verdict.involvedAccounts, options)) {
                  throw new Error('Codex switch journal changed before the unresolved verdict was recorded');
                }
                releaseCodexSwitchJournalHeld(held, deps.attempt, options); released = true;
                const unresolvedResult: CodexSwitchResult = { outcome: 'failed', reason: verdict.reason,
                  message: codexRecoveryFenceMessage(verdict.reason), attemptId: deps.attempt };
                return { result: unresolvedResult };
              }

              const effect = verdict.effect;
              assertHeld(); held.assertHeld(); const now = deps.now();
              const outcome: CodexSwitchResult['outcome'] = effect.outcome === 'quiet' || effect.outcome === 'stopped'
                ? effect.outcome === 'quiet' ? 'ok' : 'failed' : effect.outcome;
              const activeAccountId = 'activeAccountId' in effect ? effect.activeAccountId : undefined;
              const accountId = effect.outcome === 'ok' ? input.target
                : effect.outcome === 'reverted-by-codex' ? effect.accountId
                  : activeAccountId === null ? null : journal.from;
              const setBy = effect.outcome === 'reverted-by-codex' || activeAccountId === null
                ? 'adopt' : input.trigger === 'manual' ? 'manual' : 'auto';
              const detail = effect.outcome === 'failed' ? effect.detail : null;
              let id: number;
              try {
                id = deps.store.commitCodexSwitch({ now, accountId, setBy, fromAccount: journal.from, toAccount: input.target,
                  trigger: input.trigger, outcome, attempt: deps.attempt, via: 'switch', openSessionsJson: openSessionsJson(deps, sessions),
                  // I11: a not-landed row is the Q1 marker, so it never carries a publish time.
                  publishedAt: detail === 'not-published' ? null : publishedAt, committedAt: now, detail,
                  outgoing: journal.from, target: input.target,
                  // The observation describes the document actually read: a not-landed
                  // row keeps C6-18's outgoing observation, and a wiped read is null/null
                  // (as in the pre-switch step), which records the wiped event.
                  observation: detail === 'not-published'
                    ? { identity: journal.from, lineageFp: codexFingerprint(outgoing.document) }
                    : liveDocument ? { identity: liveIdentity, lineageFp: codexFingerprint(liveDocument) }
                      : { identity: null, lineageFp: null },
                  decision: { leftHeadroom: decision?.leftHeadroom ?? null, leftRecoveryAt: decision?.leftRecoveryAtMs ?? null,
                    leftTrigger: decision?.leftTrigger ?? null } });
              } catch (error) { commitFailed = true; throw error; }
              committed = { outcome, switchId: id, attemptId: deps.attempt,
                ...(outcome === 'ok' ? { watch: { state: 'pending' as const, until: now + 300_000 } } : {}) };
              assertHeld(); held.assertHeld(); deleteCodexSwitchJournalIf(deps.journalDir!, deps.attempt, held, options); journalExists = false;
              return { result: committed };
            } catch (error) {
              // C6-10: a kept journal is released before the owner lock is.
              try { releaseCodexSwitchJournalHeld(held, deps.attempt, options); released = true; } catch { /* re-acquired below */ }
              throw error;
            }
          });
        }
      });
      if ('retryFreshen' in result) { freshenRound += 1; continue; }
      return result.result;
    } catch (error) {
      if (journalExists && !released) {
        try { await releaseCodexSwitchJournal(deps.attempt, options); } catch { /* preserved journal wins */ }
      }
      if (error instanceof ClaudeCodeLockTimeout) return switchRefusal(deps, input, 'switch-busy');
      if (error instanceof ProperLockfileCompromised || error instanceof CodexAuthLockCompromised) {
        if (committed) return { ...committed, lockLostAfterCommit: true };
        if (renamed) return { outcome: 'failed', reason: 'lock-lost-after-publish', attemptId: deps.attempt };
        return switchResult('lock-lost');
      }
      // Only the commit itself maps to commit-failed; a committed attempt keeps its outcome.
      if (committed) return committed;
      if (commitFailed) return { outcome: 'failed', reason: 'commit-failed', attemptId: deps.attempt };
      throw error;
    } finally { finishCodexSwitchAttempt(deps.attempt); }
  }
  return switchRefusal(deps, input, 'target-freshen-too-close');
}
