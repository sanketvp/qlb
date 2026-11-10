/* Claude switch Phase A and the K5-5 transaction (§4.1). */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  needsFreshenBeforeSwitch,
  parseCredentialBlob,
  type JsonObject,
  type OAuthAccount,
} from './anthropic-oauth';
import {
  classifyOutgoingCredential,
  prefetchLiveIdentity,
  type ClassifyClaudeSlot,
  type PrefetchedLiveIdentity,
} from './cc-classify';
import {
  ClaudeConfigFileError,
  mergeSharedCredentialFields,
  readClaudeConfig,
  readLiveClaudeCredentials,
  sharedCredentialFields,
  SHARED_CREDENTIAL_KEYS,
  spliceOauthAccount,
  writeLiveClaudeCredentials,
  type ClaudeCredentialsOptions,
} from './cc-credentials';
import { ClaudeCodeLockTimeout, ProperLockfileCompromised, assertClaudeConfigLockHeld, withClaudeConfigPathLock, withClaudeCredentialLocks, withClaudeSwitchLock, type HeldClaudeConfigLock, type HeldClaudeCredentialLocks } from './cc-locks';
import { claudePaths } from './cc-paths';
import { consumeClaudeSlot, defaultStashTimestamp, type ConsumeGateDeps } from './cc-consume';
import {
  ClaudeSwitchJournalPresent,
  createClaudeSwitchJournal,
  deleteClaudeSwitchJournal,
  deleteStagedRollback,
  probeClaudeSwitchJournalOwner,
  readClaudeSwitchJournal,
  stagedRollbackService,
  validateClaudeSwitchJournalIdentity,
  updateClaudeSwitchJournal,
  withClaudeSwitchJournalOwner,
  writeStagedRollback,
  readStagedRollback,
  type ClaudeSwitchDecision,
  type ClaudeSwitchJournal,
  type ClaudeSwitchJournalOptions,
} from './cc-switch-journal';
import { resolveCswapCheck } from './cc-resync';
import { ClaudeSlots, type ClaudeSlot } from './cc-slots';
import { isCredentialNotFound, isSecurityTimeout } from './credential-backends';
import type { CswapProcess } from './cswap-processes';
import { atomicWriteText } from './fsutil';
import { injectionDetail } from './fault-injection';
import { processLstart, stillTheSameProcess } from './codex-sessions';
import { recordRelogin } from './relogin';
import type { Store } from './store';

export type ClaudeSwitchPreconditionReason =
  | 'active-login-unset' | 'target-missing' | 'target-dead' | 'target-archived'
  | 'breaker-open' | 'cswap-process-alive' | 'cswap-process-check-failed'
  | 'republish-not-active' | 'republish-live-not-own' | 'journal-identity-invalid';

export type ClaudeSwitchPhaseAReason = ClaudeSwitchPreconditionReason | 'claude:config-file'
  | 'live-credential-empty' | 'live-credential-unreadable' | 'target-unreadable' | `freshen-${string}`;

type ClaudeSwitchStore = Pick<Store, 'getActiveLogin' | 'getConfig' | 'setActiveLogin' | 'recordSwitch'
  | 'recordRelogin' | 'commitClaudeSwitch' | 'recordClaudeSwitchRefusal' | 'findCommittedSwitchByAttempt'>;

export interface ClaudeSwitchDeps {
  store: ClaudeSwitchStore;
  slots: ClaudeSlots;
  live: ClaudeCredentialsOptions;
  readConfig: (path: string) => JsonObject;
  resolveProfile: (accessToken: string) => Promise<OAuthAccount | null>;
  consume: Pick<ConsumeGateDeps, 'postRefresh' | 'withConsumeLock' | 'withSwitchLock' | 'stashTimestamp'>;
  cswapProcesses?: () => CswapProcess[];
  env: NodeJS.ProcessEnv;
  home?: string;
  now: () => number;
  by: 'qlb-cli' | 'qlb-auto';
  warn?: (message: string) => void;
  /** An attempt UUID is command-owned and is persisted in every durable row. */
  attempt: string;
  afterSwitch?: (to: string) => void | Promise<void>;
  locks?: {
    switch?: typeof withClaudeSwitchLock;
    credential?: typeof withClaudeCredentialLocks;
    configPath?: typeof withClaudeConfigPathLock;
    owner?: typeof withClaudeSwitchJournalOwner;
  };
  journalDir?: string;
  journalOwner?: { pid: number; lstart: string };
  /** Test seam for journal mutations; production uses the real helpers. */
  journalOps?: {
    /** Rollback-reader seam; production re-reads the on-disk journal. */
    read?: typeof readClaudeSwitchJournal;
    update: typeof updateClaudeSwitchJournal;
    remove: typeof deleteClaudeSwitchJournal;
  };
  probeOwner?: (options: { journalDir?: string; home?: string; env?: NodeJS.ProcessEnv }) => 'held' | 'free';
  stillTheSameProcess?: (owner: { pid: number; lstart: string }) => Promise<boolean>;
  stashTimestamp?: () => string;
  hooks?: { afterStep4?: () => void | Promise<void>; afterStep5?: () => void | Promise<void>; beforeStep7?: () => void | Promise<void>; afterStep7?: () => void | Promise<void>; afterStep8?: () => void | Promise<void>; beforeStep9?: () => void | Promise<void> };
  crashAt?: (checkpoint: 'before-step-6' | 'after-journal' | 'after-stage' | 'before-step-7-write' | 'after-step-7' | 'after-step-8' | 'after-commit') => void;
  /** K8's deterministic post-write rollback seam. */
  injectFailStep?: 7 | 8 | 9;
  /** Test seam for exercising fail-closed routing of an unexpected runtime kind. */
  classifyOutgoing?: typeof classifyOutgoingCredential;
}

export interface SwitchClaudeInput {
  to: string;
  trigger: string;
  decision?: ClaudeSwitchDecision;
  bindingJson?: string;
  republish?: boolean;
  injected?: boolean;
  /** Content-free fault provenance persisted in the journal and commit row. */
  detail?: string;
  probeVerdict?: boolean;
}

export type ClaudeSwitchPreconditionsResult = { kind: 'go'; active: string; outgoingSlot: ClaudeSlot; targetSlot: ClaudeSlot } | { kind: 'refused'; reason: ClaudeSwitchPreconditionReason };
type ClaudeSwitchPreconditionsGo = Extract<ClaudeSwitchPreconditionsResult, { kind: 'go' }>;
export interface ClaudeSwitchPhaseA { active: string; outgoingSlot: ClaudeSlot; targetSlot: ClaudeSlot; liveCredential: string; config: JsonObject; prefetch: PrefetchedLiveIdentity; targetCredential: string; preFreshenTargetCredential: string | null; targetFreshened: boolean; slots: ClassifyClaudeSlot[]; }
export type PrepareClaudeSwitchResult = ClaudeSwitchPhaseA | { kind: 'refused'; reason: ClaudeSwitchPhaseAReason } | { kind: 'failed'; reason: ClaudeSwitchPhaseAReason };

export interface ClaudeSwitchResult {
  outcome: 'ok' | 'noop' | 'refused' | 'failed' | 'rolled-back';
  from: string | null;
  to: string;
  reason?: string;
  error?: string;
  switchId?: number;
  attempt: string;
  outgoingKind?: string;
  injected?: boolean;
  steps?: { failedStep?: number; started: number[]; reversed: Array<number | 'config' | 'config:resplice'>; notLanded: Array<number | 'config'>; restoreFailures: string[]; unclaimed?: string; cleanup: string[] };
  exitCode: 0 | 1 | 3;
}

/** The command and K7 use this to distinguish lifecycle admission from failures. */
export class AdmissionRefused extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'AdmissionRefused'; }
}
/** Test-only interruption signal; transaction code deliberately does not convert it to a result. */
export class CrashSignal extends Error { constructor(checkpoint: string) { super(checkpoint); this.name = 'CrashSignal'; } }
/** Internal control flow: restart Phase A only after every Phase-B lock has released. */
class RestartPhaseA extends Error { constructor() { super('restart Phase A'); this.name = 'RestartPhaseA'; } }

function refused(reason: ClaudeSwitchPreconditionReason): Extract<ClaudeSwitchPreconditionsResult, { kind: 'refused' }> { return { kind: 'refused', reason }; }
function activeAccount(deps: ClaudeSwitchDeps): string | null { const accountId = deps.store.getActiveLogin('anthropic')?.accountId; return accountId && deps.slots.getSlot(accountId) ? accountId : null; }

/** S24: share the C-swap admission check with recovery before it takes any Claude Code lock. */
export function checkClaudeCswapProcessPrecondition(
  deps: Pick<ClaudeSwitchDeps, 'cswapProcesses' | 'env'>,
): Extract<ClaudeSwitchPreconditionReason, 'cswap-process-alive' | 'cswap-process-check-failed'> | null {
  try {
    return resolveCswapCheck(deps.cswapProcesses, deps.env)().length > 0 ? 'cswap-process-alive' : null;
  } catch {
    return 'cswap-process-check-failed';
  }
}

export function checkClaudeSwitchPreconditions(deps: ClaudeSwitchDeps, input: SwitchClaudeInput): ClaudeSwitchPreconditionsResult {
  const active = deps.store.getActiveLogin('anthropic')?.accountId;
  if (!active) return refused('active-login-unset');
  const outgoingSlot = deps.slots.getSlot(active);
  if (outgoingSlot === null) return refused('active-login-unset');
  if (input.republish && input.to !== active) return refused('republish-not-active');
  const target = deps.slots.getSlot(input.to);
  if (target === null) return refused('target-missing');
  if (target.dead) return refused('target-dead');
  if (target.archivedAt != null) return refused('target-archived');
  if (input.trigger !== 'manual') {
    const suspendedUntil = deps.store.getConfig('auto.anthropic.suspendedUntil');
    if (suspendedUntil !== null) { const timestamp = Number(suspendedUntil); if (!Number.isFinite(timestamp) || timestamp > deps.now()) return refused('breaker-open'); }
  }
  const cswapProcessReason = checkClaudeCswapProcessPrecondition(deps);
  if (cswapProcessReason !== null) return refused(cswapProcessReason);
  return { kind: 'go', active, outgoingSlot, targetSlot: target };
}
function warn(deps: ClaudeSwitchDeps, message: string): void { try { deps.warn?.(message); } catch { /* diagnostics are never transaction effects */ } }
async function readSlotOrNull(deps: ClaudeSwitchDeps, accountId: string): Promise<string | null> { try { return (await deps.slots.readSlot(accountId, { fresh: true })).credential; } catch { return null; } }

/** Build the lock-free, network-permitted Phase-A snapshot. */
export async function prepareClaudeSwitch(deps: ClaudeSwitchDeps, input: SwitchClaudeInput, prechecked: ClaudeSwitchPreconditionsGo | false = false): Promise<PrepareClaudeSwitchResult> {
  const checked = prechecked || checkClaudeSwitchPreconditions(deps, input);
  if (checked.kind === 'refused') return checked;
  const { active, outgoingSlot, targetSlot } = checked;
  const paths = deps.live.paths ?? claudePaths({ home: deps.live.home ?? deps.home, env: deps.live.env ?? deps.env }); const live = deps.live.paths ? deps.live : { ...deps.live, paths };
  let config: JsonObject; try { config = deps.readConfig(paths.globalConfigPath); } catch { return { kind: 'failed', reason: 'claude:config-file' }; }
  let liveCredential: string; try { liveCredential = await readLiveClaudeCredentials(live); } catch (error) { return isCredentialNotFound(error) ? { kind: 'refused', reason: 'live-credential-empty' } : { kind: 'refused', reason: 'live-credential-unreadable' }; }
  if (!liveCredential) return { kind: 'refused', reason: 'live-credential-empty' };
  let targetCredential: string; try { targetCredential = (await deps.slots.readSlot(input.to, { fresh: true })).credential; } catch { return { kind: 'failed', reason: 'target-unreadable' }; }
  const classifiedSlots: ClassifyClaudeSlot[] = [{ accountId: outgoingSlot.accountId, email: outgoingSlot.email ?? null, orgUuid: outgoingSlot.orgUuid ?? null, credential: await readSlotOrNull(deps, active) }];
  for (const slot of deps.slots.listSlots()) {
    if (slot.accountId === active) continue;
    let credential: string;
    if (slot.accountId === input.to) credential = targetCredential;
    else try { credential = (await deps.slots.readSlot(slot.accountId, { fresh: true })).credential; } catch { warn(deps, `Claude slot ${slot.accountId} could not be read during switch preparation`); continue; }
    classifiedSlots.push({ accountId: slot.accountId, email: slot.email ?? null, orgUuid: slot.orgUuid ?? null, credential });
  }
  const prefetch = await prefetchLiveIdentity({ outgoing: classifiedSlots[0], readLive: async () => { try { return await readLiveClaudeCredentials(live); } catch { return null; } }, resolveProfile: deps.resolveProfile });
  // A self-target resolves to the locked no-op path. Freshening it here would
  // rotate the active credential and then discard the successor.
  let preFreshenTargetCredential: string | null = null;
  let targetFreshened = false;
  if (!input.republish && active !== input.to && needsFreshenBeforeSwitch(parseCredentialBlob(targetCredential)?.oauth?.expiresAt, deps.now())) {
    const beforeFreshen = targetCredential;
    let consumed; try { consumed = await consumeClaudeSlot({ slots: deps.slots, postRefresh: deps.consume.postRefresh, now: deps.now, withConsumeLock: deps.consume.withConsumeLock, withSwitchLock: deps.consume.withSwitchLock, stashTimestamp: deps.stashTimestamp ?? deps.consume.stashTimestamp, warn: deps.warn }, { accountId: input.to, snapshot: targetCredential }); } catch { return { kind: 'refused', reason: 'freshen-transient' }; }
    if (consumed.kind !== 'refreshed' && consumed.kind !== 'current') return { kind: 'refused', reason: `freshen-${consumed.kind}` };
    targetCredential = consumed.credential ?? targetCredential;
    // `current` can be returned before any POST when cc-consume observes an
    // already-current slot. Only a refreshed result, or a current result with
    // a stashed successor, proves this run made the refresh POST.
    if (consumed.kind === 'refreshed' || (consumed.kind === 'current' && consumed.stashed === true)) {
      preFreshenTargetCredential = beforeFreshen;
      targetFreshened = true;
    }
    const target = classifiedSlots.find((slot) => slot.accountId === input.to); if (target) target.credential = targetCredential;
  }
  return { active, outgoingSlot, targetSlot, liveCredential, config, prefetch, targetCredential, preFreshenTargetCredential, targetFreshened, slots: classifiedSlots };
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function canonicalAccountCredential(value: unknown, removeSharedFields = false): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalAccountCredential(item));
  if (value !== null && typeof value === 'object') {
    const canonical: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      if (!removeSharedFields || !(SHARED_CREDENTIAL_KEYS as readonly string[]).includes(key)) {
        canonical[key] = canonicalAccountCredential((value as JsonObject)[key]);
      }
    }
    return canonical;
  }
  return value;
}

/** Compare account-owned credential data, ignoring machine-shared fields and JSON key order. */
export function sameAccountCredential(left: string | null, right: string | null): boolean {
  const leftCredential = left === null ? null : parseCredentialBlob(left)?.data ?? null;
  const rightCredential = right === null ? null : parseCredentialBlob(right)?.data ?? null;
  return leftCredential !== null && rightCredential !== null
    && JSON.stringify(canonicalAccountCredential(leftCredential, true)) === JSON.stringify(canonicalAccountCredential(rightCredential, true));
}

export function targetOauthAccount(configJson: string | null | undefined, accountId: string): JsonObject | null {
  try {
    const config = JSON.parse(configJson ?? '') as { oauthAccount?: unknown };
    const oauth = config.oauthAccount;
    return oauth && typeof oauth === 'object' && !Array.isArray(oauth)
      && (oauth as { accountUuid?: unknown }).accountUuid === accountId ? oauth as JsonObject : null;
  } catch { return null; }
}

function noDecision(): ClaudeSwitchDecision { return { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null }; }
function steps(): NonNullable<ClaudeSwitchResult['steps']> { return { started: [], reversed: [], notLanded: [], restoreFailures: [], cleanup: [] }; }
function isCrash(error: unknown): error is CrashSignal { return error instanceof CrashSignal; }

/** Classify only content-free categories suitable for a switch result/row. */
export function classifySwitchError(error: unknown): string {
  if (isSecurityTimeout(error)) return 'keychain-timeout';
  if (error instanceof ClaudeCodeLockTimeout || error instanceof ProperLockfileCompromised) return 'lock-timeout';
  if (error instanceof ClaudeConfigFileError) return 'config-write-failed';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('sqlite') || message.includes('database')) return 'sqlite-error';
  if (message.includes('journal')) return 'journal-io-failed';
  if (message.includes('keychain') || message.includes('security')) return 'keychain-write-failed';
  return 'switch-failed';
}

function journalOptions(deps: ClaudeSwitchDeps, paths: ReturnType<typeof claudePaths>): ClaudeSwitchJournalOptions { return { journalDir: deps.journalDir, home: deps.home, env: deps.env, configPath: paths.globalConfigPath, keychainService: paths.keychainService }; }
function refusal(deps: ClaudeSwitchDeps, input: SwitchClaudeInput, attempt: string, from: string | null, reason: string): ClaudeSwitchResult {
  // A CLI can refuse before its raw destination text is resolved to a slot.
  // Persist only a destination admitted by the Claude slot inventory; retain
  // the useful refusal result even when neither side is a durable destination.
  const durableTo = deps.slots.getSlot(input.to) === null ? from : input.to;
  if (durableTo !== null) {
    deps.store.recordClaudeSwitchRefusal({ from, to: durableTo, trigger: input.trigger, reason, republish: input.republish === true, injected: switchWasInjected(deps, input), attempt, now: deps.now() });
  }
  return { outcome: 'refused', from, to: input.to, reason, attempt, injected: switchWasInjected(deps, input), exitCode: 3 };
}
function writeError(error: unknown, fallback: 'keychain-write-failed' | 'config-write-failed'): string {
  const classified = classifySwitchError(error);
  return classified === 'switch-failed' ? fallback : classified;
}
function failed(deps: ClaudeSwitchDeps, input: SwitchClaudeInput, attempt: string, from: string | null, reason: string, error?: string, state = steps(), failedStep?: number, publishedAt?: number | null, outgoingKind?: string): ClaudeSwitchResult {
  if (failedStep !== undefined) state.failedStep = failedStep;
  const result: ClaudeSwitchResult = { outcome: 'failed', from, to: input.to, reason, ...(error ? { error } : {}), attempt, injected: switchWasInjected(deps, input), steps: state, exitCode: 1 };
  try {
    deps.store.recordSwitch({
      ts: deps.now(), provider: 'anthropic', fromAccount: from, toAccount: input.to, trigger: input.trigger,
      outcome: 'failed', error: error ?? null, detail: input.republish ? `republish:${reason}` : reason, injected: switchWasInjected(deps, input),
      outgoingKind: outgoingKind ?? null, stepsJson: JSON.stringify({ ...state, attempt }), ...(publishedAt !== undefined ? { publishedAt } : {}),
    });
  } catch { warn(deps, 'could not record failed Claude switch'); }
  return result;
}

class InjectedFailStep extends Error {
  constructor(readonly step: 7 | 8 | 9) { super(`fail-step-${step}`); this.name = 'InjectedFailStep'; }
}

function switchWasInjected(deps: ClaudeSwitchDeps, input: SwitchClaudeInput): boolean {
  return input.injected === true || deps.injectFailStep !== undefined;
}

/**
 * Restore a config write from the journal while the caller holds its matching
 * config-path lock. The write-intent guard deliberately precedes every read:
 * K14 may call this for a step-6/7 journal that has no config snapshot.
 */
type RollbackJournal = Pick<ClaudeSwitchJournal,
  'configPath' | 'configText' | 'configWrittenHash' | 'fromOauthAccount' | 'configWriteStarted'
  | 'credentialsWriteStarted' | 'stagedBlobService'>;

export async function restoreConfigFromJournal(
  deps: ClaudeSwitchDeps,
  journal: Pick<ClaudeSwitchJournal, 'configPath' | 'configText' | 'configWrittenHash' | 'fromOauthAccount' | 'configWriteStarted'>,
  heldConfigLock: HeldClaudeConfigLock,
): Promise<'restored' | 'resplice' | 'not-landed'> {
  if (!journal.configWriteStarted || journal.configText === null) return 'not-landed';
  assertClaudeConfigLockHeld(heldConfigLock, { configDir: dirname(journal.configPath), env: {} });
  const readText = deps.live.readText ?? ((path: string) => readFileSync(path, 'utf8'));
  const current = readText(journal.configPath);
  // Validate even a byte-equal file before classifying it. This keeps recovery
  // from accepting a malformed config supplied by a journal fixture.
  const config = readClaudeConfig(journal.configPath, () => current);
  if (current === journal.configText) return 'not-landed';
  if (journal.configWrittenHash !== null && sha256(current) === journal.configWrittenHash) {
    (deps.live.writeText ?? ((path: string, text: string) => atomicWriteText(path, text, { mode: 0o600 })))(journal.configPath, journal.configText);
    return 'restored';
  }
  if (journal.fromOauthAccount !== null) {
    await spliceOauthAccount(journal.configPath, journal.fromOauthAccount, heldConfigLock, {
      readText: () => current,
      writeText: deps.live.writeText,
    });
    return 'resplice';
  }
  if (!Object.prototype.hasOwnProperty.call(config, 'oauthAccount')) return 'not-landed';
  delete config.oauthAccount;
  (deps.live.writeText ?? ((path: string, text: string) => atomicWriteText(path, text, { mode: 0o600 })))(journal.configPath, `${JSON.stringify(config, null, 2)}\n`);
  return 'resplice';
}

/** K14 recovery seam: never overwrite a generation that no longer matches QLB's write. */
export async function restoreLiveFromStaged(
  deps: ClaudeSwitchDeps,
  journal: ClaudeSwitchJournal,
  heldCredentialLocks: HeldClaudeCredentialLocks,
): Promise<'restored' | 'not-landed' | 'staged-unreadable' | 'live-moved'> {
  let staged: string | null;
  try { staged = await readStagedRollback(deps.live.backend, journal.stagedBlobService); } catch { return 'staged-unreadable'; }
  if (staged === null) return 'staged-unreadable';
  let live: string;
  try { live = await readLiveClaudeCredentials(deps.live); } catch { return 'live-moved'; }
  if (live === staged) return 'not-landed';
  if (journal.credentialsWrittenHash === null || sha256(live) !== journal.credentialsWrittenHash) return 'live-moved';
  await writeLiveClaudeCredentials(staged, deps.live, heldCredentialLocks);
  return 'restored';
}

async function rollbackClaudeSwitch(
  deps: ClaudeSwitchDeps,
  input: SwitchClaudeInput,
  from: string,
  outgoingKind: string,
  outgoingLive: string,
  options: ClaudeSwitchJournalOptions,
  ownerHeld: Parameters<typeof updateClaudeSwitchJournal>[0],
  state: NonNullable<ClaudeSwitchResult['steps']>,
  failedStep: 7 | 8 | 9,
  failure: unknown,
  publishedAt: number | null,
  configLock: typeof withClaudeConfigPathLock,
  credentialHeld: HeldClaudeCredentialLocks,
  live: ClaudeCredentialsOptions,
  inMemoryJournal: RollbackJournal | null,
): Promise<ClaudeSwitchResult> {
  state.failedStep = failedStep;
  const read = (deps.journalOps?.read ?? readClaudeSwitchJournal)(options);
  // The process already knows every rollback-relevant intent it wrote. A
  // transient journal re-read failure must not turn that knowledge into a
  // silent no-op restore.
  const journal: RollbackJournal | null = read.state === 'ok' ? read.journal : inMemoryJournal;
  const injected = switchWasInjected(deps, input) || failure instanceof InjectedFailStep;
  const detail = failure instanceof InjectedFailStep
    ? injectionDetail({ kind: 'fail-step', step: failure.step })
    : `step-${failedStep}`;
  const error = failure instanceof InjectedFailStep ? 'injected'
    : failedStep === 7 ? writeError(failure, 'keychain-write-failed')
      : failedStep === 8 ? writeError(failure, 'config-write-failed')
        : classifySwitchError(failure);

  // Reverse newest effect first. Each restore is independent, so a config
  // failure never suppresses the live credential attempt (and vice versa).
  if (journal === null) {
    state.restoreFailures.push('journal-unreadable');
  }
  if (journal?.configWriteStarted) {
    try {
      const configResult = await configLock(journal.configPath, { env: deps.env }, (held) =>
        restoreConfigFromJournal(deps, journal, held));
      if (configResult === 'not-landed') state.notLanded.push('config');
      else state.reversed.push(configResult === 'resplice' ? 'config:resplice' : 'config');
    } catch { state.restoreFailures.push('config'); }
  }
  if (journal?.credentialsWriteStarted) {
    try {
      const current = await readLiveClaudeCredentials(live);
      if (current === outgoingLive) state.notLanded.push(7);
      else { await writeLiveClaudeCredentials(outgoingLive, live, credentialHeld); state.reversed.push(7); }
    } catch { // A failed re-read is restored just like a moved live value.
      try { await writeLiveClaudeCredentials(outgoingLive, live, credentialHeld); state.reversed.push(7); }
      catch { state.restoreFailures.push('credentials'); }
    }
  }

  try {
    deps.store.recordSwitch({
      ts: deps.now(), provider: 'anthropic', fromAccount: from, toAccount: input.to, trigger: input.trigger,
      outcome: 'rolled-back', error, detail: input.republish ? `republish:${detail}` : detail, injected, outgoingKind,
      stepsJson: JSON.stringify({ ...state, attempt: deps.attempt }), ...(publishedAt === null ? {} : { publishedAt }),
    });
  } catch { warn(deps, 'could not record rolled-back Claude switch'); }

  if (state.restoreFailures.length === 0 && journal !== null) {
    const journalUpdate = deps.journalOps?.update ?? updateClaudeSwitchJournal;
    const journalRemove = deps.journalOps?.remove ?? deleteClaudeSwitchJournal;
    try { journalUpdate(ownerHeld, { closed: 'rolled-back' }, options); } catch (cleanup) { state.cleanup.push(classifySwitchError(cleanup)); }
    if (state.cleanup.length === 0) {
      try { await deleteStagedRollback(live.backend, journal.stagedBlobService); } catch (cleanup) { state.cleanup.push(classifySwitchError(cleanup)); }
    }
    if (state.cleanup.length === 0) {
      try { journalRemove(ownerHeld, options); } catch (cleanup) { state.cleanup.push(classifySwitchError(cleanup)); }
    }
  }
  return { outcome: 'rolled-back', from, to: input.to, reason: detail, error, attempt: deps.attempt,
    injected, steps: state, exitCode: 1 };
}

/** K5-5's transaction, with K8-2 rollback for pre-commit failures. */
async function switchClaudeAttempt(deps: ClaudeSwitchDeps, input: SwitchClaudeInput, retriedPhaseA: boolean): Promise<ClaudeSwitchResult> {
  const attempt = deps.attempt;
  const paths = deps.live.paths ?? claudePaths({ home: deps.live.home ?? deps.home, env: deps.live.env ?? deps.env });
  const live = deps.live.paths ? deps.live : { ...deps.live, paths };
  const options = journalOptions(deps, paths);
  const before = readClaudeSwitchJournal(options);
  if (before.state === 'malformed') return refusal(deps, input, attempt, activeAccount(deps), 'switch-journal-malformed');
  if (before.state === 'ok' && !validateClaudeSwitchJournalIdentity(before.journal, deps.slots.listSlots())) {
    return refusal(deps, input, attempt, activeAccount(deps), 'journal-identity-invalid');
  }
  if (before.state === 'ok') {
    const probe = (deps.probeOwner ?? probeClaudeSwitchJournalOwner)({ journalDir: deps.journalDir, home: deps.home, env: deps.env });
    const same = probe === 'held' ? true : await (deps.stillTheSameProcess ?? stillTheSameProcess)(before.journal.owner);
    const finished = before.journal.committed !== undefined || before.journal.closed !== null || deps.store.findCommittedSwitchByAttempt('anthropic', before.journal.attemptId) !== null;
    if (!same && !finished) return refusal(deps, input, attempt, activeAccount(deps), 'switch-journal-present');
  }
  const checked = checkClaudeSwitchPreconditions(deps, input);
  if (checked.kind === 'refused') return refusal(deps, input, attempt, activeAccount(deps), checked.reason);
  const prepared = await prepareClaudeSwitch(deps, input, checked);
  if ('kind' in prepared) {
    if (prepared.kind === 'refused') return refusal(deps, input, attempt, activeAccount(deps), prepared.reason);
    return failed(deps, input, attempt, activeAccount(deps), prepared.reason);
  }
  const switchLock = deps.locks?.switch ?? withClaudeSwitchLock;
  const credentialLock = deps.locks?.credential ?? withClaudeCredentialLocks;
  const ownerLock = deps.locks?.owner ?? withClaudeSwitchJournalOwner;
  const configLock = deps.locks?.configPath ?? withClaudeConfigPathLock;
  const journalUpdate = deps.journalOps?.update ?? updateClaudeSwitchJournal;
  const journalRemove = deps.journalOps?.remove ?? deleteClaudeSwitchJournal;
  const state = steps();
  let ownerResult: ClaudeSwitchResult | undefined;
  try {
    const result: ClaudeSwitchResult = await switchLock<ClaudeSwitchResult>(async () => credentialLock<ClaudeSwitchResult>({ configDir: paths.configHome, env: deps.env }, async (credentialHeld) => {
      try {
        return await ownerLock(options, async (ownerHeld) => {
          const outcome = await (async (): Promise<ClaudeSwitchResult> => {
          // Step 4: lock-authoritative journal cleanup and all mutable re-reads.
          const inside = readClaudeSwitchJournal(options);
          if (inside.state === 'malformed') return refusal(deps, input, attempt, activeAccount(deps), 'switch-journal-malformed');
          if (inside.state === 'ok' && !validateClaudeSwitchJournalIdentity(inside.journal, deps.slots.listSlots())) {
            return refusal(deps, input, attempt, activeAccount(deps), 'journal-identity-invalid');
          }
          if (inside.state === 'ok') {
            const done = inside.journal.committed !== undefined || inside.journal.closed !== null || deps.store.findCommittedSwitchByAttempt('anthropic', inside.journal.attemptId) !== null;
            if (!done) return refusal(deps, input, attempt, activeAccount(deps), 'switch-journal-present');
            try { await deleteStagedRollback(live.backend, inside.journal.stagedBlobService); journalRemove(ownerHeld, options); } catch { return refusal(deps, input, attempt, activeAccount(deps), 'switch-journal-present'); }
          }
          const from = activeAccount(deps);
          if (from === null) return refusal(deps, input, attempt, null, 'active-login-unset');
          // Phase A is lock-free. Its self-target freshen skip is valid only
          // while the same account is active under the transaction locks.
          if (prepared.active !== from && !(prepared.targetFreshened && from === input.to)) {
            if (retriedPhaseA) return refusal(deps, input, attempt, from, 'active-changed');
            if (prepared.active === input.to || from === input.to) throw new RestartPhaseA();
          }
          // Phase A has already admitted immutable inputs. Re-check mutable
          // breaker and C-swap admission while the transaction is serialized.
          const lockedCheck = checkClaudeSwitchPreconditions(deps, input);
          if (lockedCheck.kind === 'refused') return refusal(deps, input, attempt, from, lockedCheck.reason);
          const target = deps.slots.getSlot(input.to)!;
          let transactionInput = input;
          let republishSlotHead = false;
          let verifiedPredecessor: string | null = null;
          if (!input.republish && from === input.to) {
            // An empty or unreadable live store (or slot) keeps origin/main's
            // self-target noop, as decideSelfSwitchAction does.
            let liveHead: string | null = null;
            let slotHead: string | null = null;
            try {
              liveHead = await readLiveClaudeCredentials(live);
              slotHead = (await deps.slots.readSlot(input.to, { fresh: true })).credential;
            } catch { /* noop below */ }
            if (liveHead && slotHead && !sameAccountCredential(slotHead, liveHead)) {
              // Only this run's own freshen record proves live is older than
              // the slot head. prevFingerprint is not used: it hashes only the
              // refresh token and can equal the head's own fingerprint, so it
              // cannot tell an older head from a newer own rotation.
              if (prepared.targetFreshened && prepared.preFreshenTargetCredential !== null
                && sameAccountCredential(prepared.preFreshenTargetCredential, liveHead)) {
                verifiedPredecessor = liveHead;
                republishSlotHead = true;
                transactionInput = { ...input, republish: true };
              } else {
                const selfClassification = classifyOutgoingCredential({
                  outgoing: { accountId: target.accountId, email: target.email ?? null, orgUuid: target.orgUuid ?? null, credential: slotHead },
                  slots: prepared.slots,
                  liveCredential: liveHead,
                  provenance: prepared.prefetch,
                  probeVerdict: input.probeVerdict,
                });
                // Account ownership comes from profile/identity classification,
                // never from credential equality. Unknown and own rotations
                // retain the normal self-target no-op and are not adopted here.
                if (selfClassification.kind === 'foreign' || selfClassification.kind === 'foreign-synced'
                  || selfClassification.kind === 'alien' || selfClassification.kind === 'known-foreign') {
                  return refusal(deps, input, attempt, from, 'active-changed');
                }
              }
            }
            if (!republishSlotHead) {
              try {
                deps.store.recordSwitch({ ts: deps.now(), provider: 'anthropic', fromAccount: from, toAccount: input.to, trigger: input.trigger, outcome: 'noop', injected: switchWasInjected(deps, input), stepsJson: JSON.stringify({ attempt }) });
              } catch { warn(deps, 'could not record noop Claude switch'); }
              return { outcome: 'noop', from, to: input.to, attempt, injected: switchWasInjected(deps, input), steps: state, exitCode: 0 };
            }
          }
          let outgoingLive: string;
          try { outgoingLive = await readLiveClaudeCredentials(live); } catch (error) { return refusal(deps, transactionInput, attempt, from, isCredentialNotFound(error) ? 'live-credential-empty' : 'live-credential-unreadable'); }
          if (!outgoingLive) return refusal(deps, transactionInput, attempt, from, 'live-credential-empty');
          if (republishSlotHead && (verifiedPredecessor === null || !sameAccountCredential(verifiedPredecessor, outgoingLive))) {
            return refusal(deps, transactionInput, attempt, from, 'active-changed');
          }
          state.started.push(4); await deps.hooks?.afterStep4?.();

          // Step 5: preserve routed outgoing credentials before switching.
          const outgoingSlot = deps.slots.getSlot(from);
          if (outgoingSlot === null) return refusal(deps, transactionInput, attempt, from, 'active-login-unset');
          const outgoing = { accountId: outgoingSlot.accountId, email: outgoingSlot.email ?? null, orgUuid: outgoingSlot.orgUuid ?? null, credential: await readSlotOrNull(deps, from) };
          let rawClassification: ReturnType<typeof classifyOutgoingCredential>;
          try { rawClassification = (deps.classifyOutgoing ?? classifyOutgoingCredential)({ outgoing, slots: prepared.slots, liveCredential: outgoingLive, provenance: prepared.prefetch, probeVerdict: transactionInput.probeVerdict }); } catch (error) { return failed(deps, transactionInput, attempt, from, 'outgoing-backup-failed', writeError(error, 'keychain-write-failed'), state, 5); }
          // The stale predecessor is known to be the exact pre-refresh target.
          // Keep the refreshed slot head as K5b-1's publication source.
          const classified = republishSlotHead
            ? { kind: 'own-bytes' as const, foreignSlotId: null }
            : rawClassification;
          if (transactionInput.republish && classified.kind !== 'own-bytes' && classified.kind !== 'own-family' && classified.kind !== 'own-rotated') {
            return refusal(deps, transactionInput, attempt, from, 'republish-live-not-own');
          }
          const foreignSlot = prepared.slots.find((slot) => slot.accountId === classified.foreignSlotId);
          // K9-2 kinds: own-bytes, own-family, own-rotated, foreign, foreign-synced, wiped, alien, known-foreign, unresolved.
          const needsUnclaimedStash = classified.kind === 'foreign-synced' && foreignSlot?.credential !== outgoingLive;
          const stashOutgoing = async (): Promise<ClaudeSwitchResult | null> => {
            const stashId = (deps.stashTimestamp ?? (() => defaultStashTimestamp(deps.now())))();
            try {
              await deps.slots.stashUnclaimed(stashId, outgoingLive, undefined, classified.foreignSlotId ?? undefined);
              state.unclaimed = stashId;
              return null;
            } catch (error) {
              return failed(deps, transactionInput, attempt, from, 'outgoing-backup-failed', writeError(error, 'keychain-write-failed'), state, 5, undefined, classified.kind);
            }
          };
          if (classified.kind === 'own-family' || classified.kind === 'own-rotated' || classified.kind === 'unresolved') {
            try { await deps.slots.writeSlot(from, outgoingLive, { cause: 'adopt', by: deps.by, evidence: classified.kind === 'own-rotated' ? 'oracle' : classified.kind === 'unresolved' ? null : 'lineage' }); } catch (error) { return failed(deps, transactionInput, attempt, from, 'outgoing-backup-failed', writeError(error, 'keychain-write-failed'), state, 5, undefined, classified.kind); }
          } else if (classified.kind === 'foreign' || classified.kind === 'alien' || classified.kind === 'known-foreign') {
            const stashFailure = await stashOutgoing();
            if (stashFailure) return stashFailure;
          } else if (needsUnclaimedStash) {
            const stashFailure = await stashOutgoing();
            if (stashFailure) return stashFailure;
          } else if (classified.kind === 'wiped') {
            try {
              recordRelogin(deps.store, { ts: deps.now(), provider: 'anthropic', accountId: from, kind: 'wiped', evidence: 'wiped' });
            } catch (error) {
              return failed(deps, transactionInput, attempt, from, 'outgoing-backup-failed', writeError(error, 'keychain-write-failed'), state, 5, undefined, classified.kind);
            }
          } else if (classified.kind === 'own-bytes' || classified.kind === 'foreign-synced') {
            // These outgoing kinds are intentionally retained in place.
          } else {
            const unexpectedKind: never = classified.kind;
            return refusal(deps, transactionInput, attempt, from, `outgoing-unrouted:${unexpectedKind}`);
          }
          state.started.push(5); await deps.hooks?.afterStep5?.();

          // Step 6: write intent before the staged Keychain copy.
          deps.crashAt?.('before-step-6');
          let targetCredential: string;
          try { targetCredential = (await deps.slots.readSlot(transactionInput.to, { fresh: true })).credential; } catch { return failed(deps, transactionInput, attempt, from, 'target-unreadable', undefined, state, 6, undefined, classified.kind); }
          const targetOauth = targetOauthAccount(target.configJson, transactionInput.to);
          if (!parseCredentialBlob(targetCredential)?.oauth || targetOauth === null) return failed(deps, transactionInput, attempt, from, 'target-invalid', undefined, state, 6, undefined, classified.kind);
          const timestamp = (deps.stashTimestamp ?? (() => defaultStashTimestamp(deps.now())))();
          const stagedBlobService = stagedRollbackService(timestamp);
          const owner = deps.journalOwner ?? { pid: process.pid, lstart: await processLstart(process.pid) ?? '' };
          try {
            ownerHeld.assertHeld();
            createClaudeSwitchJournal({ v: 1, provider: 'anthropic', attemptId: attempt, from, to: transactionInput.to, trigger: transactionInput.trigger, by: deps.by, republish: transactionInput.republish === true, injected: switchWasInjected(deps, transactionInput), detail: transactionInput.detail ?? (transactionInput.republish ? 'republish' : null), decision: transactionInput.decision ?? noDecision(), outgoingKind: classified.kind, bindingJson: transactionInput.bindingJson ?? null, step: 6, stagedBlobService, stagedAccount: 'qlb', stagedWritten: false, keychainService: paths.keychainService, configPath: paths.globalConfigPath, configText: null, configWrittenHash: null, fromOauthAccount: null, credentialsWrittenHash: null, credentialsWriteStarted: false, credentialsWritten: false, configWriteStarted: false, configWritten: false, closed: null, startedAt: deps.now(), owner }, options);
            deps.crashAt?.('after-journal');
            await writeStagedRollback(live.backend, stagedBlobService, outgoingLive);
            journalUpdate(ownerHeld, { stagedWritten: true }, options);
            deps.crashAt?.('after-stage');
          } catch (error) {
            if (isCrash(error)) throw error;
            if (error instanceof ClaudeSwitchJournalPresent) return refusal(deps, transactionInput, attempt, from, 'switch-journal-present');
            try { journalUpdate(ownerHeld, { closed: 'stage-failed' }, options); } catch (cleanup) { state.cleanup.push(classifySwitchError(cleanup)); return failed(deps, transactionInput, attempt, from, 'stage-failed', classifySwitchError(error), state, 6, undefined, classified.kind); }
            try { await deleteStagedRollback(live.backend, stagedBlobService); } catch (cleanup) { state.cleanup.push(classifySwitchError(cleanup)); return failed(deps, transactionInput, attempt, from, 'stage-failed', classifySwitchError(error), state, 6, undefined, classified.kind); }
            try { journalRemove(ownerHeld, options); } catch (cleanup) { state.cleanup.push(classifySwitchError(cleanup)); }
            return failed(deps, transactionInput, attempt, from, 'stage-failed', classifySwitchError(error), state, 6, undefined, classified.kind);
          }
          state.started.push(6); await deps.hooks?.beforeStep7?.();
          // This process's rollback source remains usable even if a journal
          // update succeeds on disk but its later re-read fails.
          const rollbackJournal: RollbackJournal = {
            configPath: paths.globalConfigPath, configText: null, configWrittenHash: null, fromOauthAccount: null,
            configWriteStarted: false, credentialsWriteStarted: false, stagedBlobService,
          };
          // Step 7: hash-before-effect live credentials write.
          let publishedAt: number | null = null;
          try {
            const composed = mergeSharedCredentialFields(targetCredential, sharedCredentialFields(outgoingLive) ?? {});
            rollbackJournal.credentialsWriteStarted = true;
            journalUpdate(ownerHeld, { step: 7, credentialsWriteStarted: true, credentialsWrittenHash: sha256(composed) }, options);
            deps.crashAt?.('before-step-7-write');
            await writeLiveClaudeCredentials(composed, live, credentialHeld);
            publishedAt = deps.now();
            journalUpdate(ownerHeld, { credentialsWritten: true, publishedAt }, options);
            state.started.push(7); if (deps.injectFailStep === 7) throw new InjectedFailStep(7);
            await deps.hooks?.afterStep7?.(); deps.crashAt?.('after-step-7');
          } catch (error) {
            if (isCrash(error)) throw error;
            return rollbackClaudeSwitch(deps, transactionInput, from, classified.kind, outgoingLive, options, ownerHeld, state, 7, error, publishedAt, configLock, credentialHeld, live, rollbackJournal);
          }
          // Step 8: config lock covers raw read, planning splice, journal intent, and write only.
          try {
            await configLock(paths.globalConfigPath, { env: deps.env }, async (configHeld) => {
              const raw = (live.readText ?? ((path: string) => readFileSync(path, 'utf8')))(paths.globalConfigPath);
              const original = readClaudeConfig(paths.globalConfigPath, () => raw).oauthAccount;
              const fromOauthAccount = original && typeof original === 'object' && !Array.isArray(original) ? original as JsonObject : null;
              let planned: string | undefined;
              await spliceOauthAccount(paths.globalConfigPath, targetOauth!, configHeld, { readText: () => raw, writeText: (_path, text) => { planned = text; } });
              if (planned === undefined) throw new ClaudeConfigFileError(paths.globalConfigPath, 'could not plan file');
              rollbackJournal.configText = raw;
              rollbackJournal.fromOauthAccount = fromOauthAccount;
              rollbackJournal.configWrittenHash = sha256(planned);
              rollbackJournal.configWriteStarted = true;
              journalUpdate(ownerHeld, { step: 8, configText: raw, fromOauthAccount, configWrittenHash: rollbackJournal.configWrittenHash, configWriteStarted: true }, options);
              (live.writeText ?? ((path: string, text: string) => { atomicWriteText(path, text, { mode: 0o600 }); }))(paths.globalConfigPath, planned);
              journalUpdate(ownerHeld, { configWritten: true }, options);
              state.started.push(8);
              if (deps.injectFailStep === 8) throw new InjectedFailStep(8);
            });
            await deps.hooks?.afterStep8?.(); deps.crashAt?.('after-step-8');
          } catch (error) {
            if (isCrash(error)) throw error;
            return rollbackClaudeSwitch(deps, transactionInput, from, classified.kind, outgoingLive, options, ownerHeld, state, 8, error, publishedAt, configLock, credentialHeld, live, rollbackJournal);
          }
          // Step 9 plus the finished-marker cleanup sequence.
          let switchId: number;
          try {
            await deps.hooks?.beforeStep9?.();
            switchId = deps.store.commitClaudeSwitch({ now: deps.now(), fromAccount: from, toAccount: transactionInput.to, trigger: transactionInput.trigger, setBy: transactionInput.trigger === 'manual' ? 'manual' : 'auto', attempt, outgoingKind: classified.kind, bindingJson: transactionInput.bindingJson ?? null, stepsJson: JSON.stringify(state), publishedAt, injected: switchWasInjected(deps, transactionInput), detail: transactionInput.detail ?? (transactionInput.republish ? 'republish' : null), republish: transactionInput.republish === true, decision: transactionInput.decision ?? noDecision(), beforeCommit: () => { if (deps.injectFailStep === 9) throw new InjectedFailStep(9); } });
            state.started.push(9); deps.crashAt?.('after-commit');
          } catch (error) {
            if (isCrash(error)) throw error;
            return rollbackClaudeSwitch(deps, transactionInput, from, classified.kind, outgoingLive, options, ownerHeld, state, 9, error, publishedAt, configLock, credentialHeld, live, rollbackJournal);
          }
          try { journalUpdate(ownerHeld, { committed: deps.now() }, options); } catch (error) { state.cleanup.push(classifySwitchError(error)); }
          if (state.cleanup.length === 0) try { await deleteStagedRollback(live.backend, stagedBlobService); } catch (error) { state.cleanup.push(classifySwitchError(error)); }
          if (state.cleanup.length === 0) try { journalRemove(ownerHeld, options); } catch (error) { state.cleanup.push(classifySwitchError(error)); }
          return { outcome: 'ok', from, to: transactionInput.to, switchId, attempt, outgoingKind: classified.kind, injected: transactionInput.injected === true, steps: state, exitCode: 0 };
          })();
          ownerResult = outcome;
          return outcome;
        });
      } catch (error) {
        if (isCrash(error)) throw error;
        if ((error instanceof ClaudeCodeLockTimeout || error instanceof ProperLockfileCompromised) && ownerResult !== undefined) {
          if (ownerResult.outcome === 'ok' && !ownerResult.steps?.cleanup.includes('lock-timeout')) {
            ownerResult.steps?.cleanup.push('lock-timeout');
          }
          return ownerResult;
        }
        const reason = error instanceof ClaudeCodeLockTimeout || error instanceof ProperLockfileCompromised
          ? (readClaudeSwitchJournal(options).state === 'absent' ? 'lock-timeout' : 'switch-journal-present') : undefined;
        if (reason) return refusal(deps, input, attempt, activeAccount(deps), reason);
        throw error;
      }
    }), { home: deps.home, env: deps.env });
    if (result.outcome === 'ok') {
      if (result.steps?.cleanup.length) warn(deps, `Claude switch completed with cleanup warnings: ${result.steps.cleanup.join(', ')}`);
      try { await deps.afterSwitch?.(input.to); } catch { warn(deps, 'Claude switch post-switch hook failed'); }
    }
    return result;
  } catch (error) {
    if (isCrash(error)) throw error;
    if (error instanceof RestartPhaseA) return switchClaudeAttempt(deps, input, true);
    if (error instanceof ClaudeCodeLockTimeout || error instanceof ProperLockfileCompromised) return refusal(deps, input, attempt, activeAccount(deps), 'lock-timeout');
    throw error;
  }
}

export async function switchClaude(deps: ClaudeSwitchDeps, input: SwitchClaudeInput): Promise<ClaudeSwitchResult> {
  return switchClaudeAttempt(deps, input, false);
}
