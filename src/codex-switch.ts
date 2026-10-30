import { mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CodexAuthStableWithStatResult, CodexIdentity } from './codex-auth';
import { ClaudeCodeLockTimeout, type HeldProperLockfile, withProperLockfile } from './cc-locks';
import { fsyncDirSync, atomicWriteText } from './fsutil';
import { qlbHomeDir } from './home';
import { stillTheSameProcess, type CodexProcess } from './codex-sessions';
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
    openSessions: value.openSessions.map((process) => ({ ...process })),
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

/** Atomically write mode-0600 journal bytes, then fsync the containing directory. */
export function writeCodexSwitchJournal(journal: CodexSwitchJournal, options: CodexSwitchJournalOptions = {}): void {
  if (parseCodexSwitchJournal(journal) === null) throw new Error('Invalid Codex switch journal');
  const path = codexSwitchJournalPath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteText(path, `${JSON.stringify(journal)}\n`, { mode: 0o600, followSymlinks: false });
  (options.fsyncDirectory ?? fsyncDirSync)(dirname(path));
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
  }, (proper: HeldProperLockfile) => fn({ [journalOwnerHandle]: true, journalDir, assertHeld: () => proper.assertNotCompromised() }));
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
  writeCodexSwitchJournal({ ...current.journal, unresolved: { reason,
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
  writeCodexSwitchJournal({ ...current.journal, adoptingTarget: [...current.journal.adoptingTarget, fingerprint] }, resolved);
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

/** Re-acquire a ten-second owner lease and change only matching owner.state to released. */
export async function releaseCodexSwitchJournal(attemptId: string, options: CodexSwitchJournalOptions = {}): Promise<boolean> {
  return withCodexSwitchJournalOwner({ ...options, ownerLockTimeoutMs: CODEX_SWITCH_JOURNAL_TIMEOUT_MS }, () => {
    const current = readCodexSwitchJournal(options);
    if (current.state !== 'ok' || current.journal.attemptId !== attemptId) return false;
    writeCodexSwitchJournal({ ...current.journal, owner: { ...current.journal.owner, state: 'released' } }, options);
    return true;
  });
}

export type CodexSwitchJournalProbe =
  | { state: 'absent' } | { state: 'malformed' }
  | { state: 'in-progress'; journal: CodexSwitchJournal }
  | { state: 'orphaned'; journal: CodexSwitchJournal }
  | { state: 'owner-lock-not-yet-stale'; journal: CodexSwitchJournal; retryAt: number };
function ownerLockRetryAt(options: CodexSwitchJournalOptions): number {
  try { return statSync(codexSwitchJournalOwnerLockPath(options)).mtimeMs + (options.ownerLockStalenessMs ?? CODEX_SWITCH_JOURNAL_STALENESS_MS); }
  catch { return (options.now ?? Date.now)() + (options.ownerLockStalenessMs ?? CODEX_SWITCH_JOURNAL_STALENESS_MS); }
}

/** Probe under the caller's switch→auth locks; a live active owner wins at any lock age. */
export async function probeCodexSwitchJournal(options: CodexSwitchJournalOptions = {}): Promise<CodexSwitchJournalProbe> {
  const initial = readCodexSwitchJournal(options);
  if (initial.state !== 'ok') return initial;
  const ownerAlive = initial.journal.owner.state === 'active'
    && await (options.sameProcess ?? stillTheSameProcess)(initial.journal.owner);
  if (ownerAlive && !(initial.journal.owner.pid === process.pid && !executingCodexAttempts.has(initial.journal.attemptId))) {
    return { state: 'in-progress', journal: initial.journal };
  }
  try {
    return await withCodexSwitchJournalOwner(options, () => {
      const reread = readCodexSwitchJournal(options);
      return reread.state === 'ok' ? { state: 'orphaned', journal: reread.journal } : reread;
    });
  } catch (error) {
    if (error instanceof ClaudeCodeLockTimeout) return { state: 'owner-lock-not-yet-stale', journal: initial.journal, retryAt: ownerLockRetryAt(options) };
    throw error;
  }
}
