import { mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CodexAuthStableWithStatResult, CodexIdentity } from './codex-auth';
import { ClaudeCodeLockTimeout, type HeldProperLockfile, withProperLockfile } from './cc-locks';
import { fsyncDirSync, atomicWriteText } from './fsutil';
import { qlbHomeDir } from './home';
import { parseCodexRecoveryFence, stillTheSameProcess, type CodexProcess } from './codex-sessions';
import type { CswapProcess } from './cswap-processes';
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
export interface CodexSwitchDeps {
  store: Pick<Store, 'getCodexActiveLogin' | 'getCodexSlot' | 'getConfig' | 'recordSwitch'>;
  readLive: () => Promise<CodexAuthStableWithStatResult>;
  cswapProcesses: () => CswapProcess[];
  now: () => number;
  attempt: string;
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
      return { state: 'fenced', accounts, reason, message: `codex refresh refused: ${reason} (a Codex switch involving this account has not finished)` };
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
