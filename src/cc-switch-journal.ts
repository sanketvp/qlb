import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { type JsonObject } from './anthropic-oauth';
import { type ClaudeSlotBackend } from './cc-slots';
import { withProperLockfile, type HeldProperLockfile } from './cc-locks';
import { isCredentialNotFound } from './credential-backends';
import { atomicWriteText, fsyncDirSync } from './fsutil';
import { qlbHomeDir } from './home';
import { QLB_KEYCHAIN_ACCOUNT } from './keychain';

const JOURNAL_FILE = 'switch-anthropic.json';
const OWNER_LOCK_STALENESS_MS = 300_000;
const OWNER_LOCK_TIMEOUT_MS = 10_000;
const STAGED_PREFIX = 'qlb:anthropic:staged-rollback:';
const journalOwnerHandle = Symbol('claude-switch-journal-owner');

export type ClaudeSwitchDecision = {
  leftHeadroom: number | null;
  leftRecoveryAt: number | null;
  leftTrigger: string | null;
};

export interface ClaudeSwitchJournal {
  v: 1;
  provider: 'anthropic';
  attemptId: string;
  from: string;
  to: string;
  trigger: string;
  by: string;
  republish: boolean;
  injected: boolean;
  detail: string | null;
  decision: ClaudeSwitchDecision;
  outgoingKind: string | null;
  bindingJson: string | null;
  step: 6 | 7 | 8;
  stagedBlobService: string;
  stagedAccount: 'qlb';
  stagedWritten: boolean;
  keychainService: string;
  configPath: string;
  configText: string | null;
  configWrittenHash: string | null;
  fromOauthAccount: JsonObject | null;
  credentialsWrittenHash: string | null;
  credentialsWriteStarted: boolean;
  credentialsWritten: boolean;
  configWriteStarted: boolean;
  configWritten: boolean;
  closed: 'rolled-back' | 'stage-failed' | null;
  publishedAt?: number;
  committed?: number;
  startedAt: number;
  owner: { pid: number; lstart: string };
}

export type ClaudeSwitchJournalRead =
  | { state: 'absent' }
  | { state: 'ok'; journal: ClaudeSwitchJournal }
  | { state: 'malformed' };

export interface ClaudeSwitchJournalExpected {
  configPath: string;
  keychainService: string;
}

export interface ClaudeSwitchJournalPathOptions {
  journalDir?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeSwitchJournalOptions extends ClaudeSwitchJournalPathOptions, ClaudeSwitchJournalExpected {
  fsyncDirectory?: (path: string) => void;
  /** Test seam run after the temporary journal is durable but before its exclusive link. */
  beforeCreatePublish?: () => void;
  onOwnerLockCompromised?: (error: Error) => void;
}

/** Opaque capability valid only in withClaudeSwitchJournalOwner's callback. */
export interface HeldClaudeSwitchJournalOwner {
  readonly [journalOwnerHandle]: true;
  readonly journalDir: string;
  assertHeld(): void;
}

export class ClaudeSwitchJournalPresent extends Error {
  constructor() {
    super('Claude switch journal is already present');
    this.name = 'ClaudeSwitchJournalPresent';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string { return typeof value === 'string'; }
function finiteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function nullableString(value: unknown): value is string | null { return value === null || isString(value); }
function nullableFiniteNumber(value: unknown): value is number | null { return value === null || finiteNumber(value); }
function isJsonObject(value: unknown): value is JsonObject { return isRecord(value); }
function errno(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function parsedDecision(value: unknown): ClaudeSwitchDecision | null {
  if (!isRecord(value) || !nullableFiniteNumber(value.leftHeadroom)
    || !nullableFiniteNumber(value.leftRecoveryAt) || !nullableString(value.leftTrigger)) return null;
  return {
    leftHeadroom: value.leftHeadroom,
    leftRecoveryAt: value.leftRecoveryAt,
    leftTrigger: value.leftTrigger,
  };
}

/** Parse only the credential-free, allowlisted v1 journal shape. */
export function parseClaudeSwitchJournal(value: unknown, expected: ClaudeSwitchJournalExpected): ClaudeSwitchJournal | null {
  if (!isRecord(value) || value.v !== 1 || value.provider !== 'anthropic'
    || !isString(value.attemptId) || !isString(value.from) || !isString(value.to) || !isString(value.trigger)
    || !isString(value.by) || typeof value.republish !== 'boolean' || typeof value.injected !== 'boolean'
    || !nullableString(value.detail) || !nullableString(value.outgoingKind) || !nullableString(value.bindingJson)
    || !isString(value.stagedBlobService) || !value.stagedBlobService.startsWith(STAGED_PREFIX)
    || value.stagedAccount !== QLB_KEYCHAIN_ACCOUNT || value.configPath !== expected.configPath
    || value.keychainService !== expected.keychainService || !nullableString(value.configText)
    || !nullableString(value.configWrittenHash) || !nullableString(value.credentialsWrittenHash)
    || typeof value.stagedWritten !== 'boolean' || typeof value.credentialsWriteStarted !== 'boolean'
    || typeof value.credentialsWritten !== 'boolean' || typeof value.configWriteStarted !== 'boolean'
    || typeof value.configWritten !== 'boolean' || !finiteNumber(value.startedAt)
    || !isRecord(value.owner) || !Number.isSafeInteger(value.owner.pid) || (value.owner.pid as number) <= 0 || !isString(value.owner.lstart)
    || (value.step !== 6 && value.step !== 7 && value.step !== 8)
    || (value.closed !== null && value.closed !== 'rolled-back' && value.closed !== 'stage-failed')) return null;
  const decision = parsedDecision(value.decision);
  const ownerPid = value.owner.pid as number;
  if (decision === null || (value.fromOauthAccount !== null && !isJsonObject(value.fromOauthAccount))) return null;
  if (value.publishedAt !== undefined && !finiteNumber(value.publishedAt)) return null;
  if (value.committed !== undefined && !finiteNumber(value.committed)) return null;
  return {
    v: 1, provider: 'anthropic', attemptId: value.attemptId, from: value.from, to: value.to,
    trigger: value.trigger, by: value.by, republish: value.republish, injected: value.injected,
    detail: value.detail, decision, outgoingKind: value.outgoingKind, bindingJson: value.bindingJson,
    step: value.step, stagedBlobService: value.stagedBlobService, stagedAccount: 'qlb',
    stagedWritten: value.stagedWritten, keychainService: value.keychainService, configPath: value.configPath,
    configText: value.configText, configWrittenHash: value.configWrittenHash,
    fromOauthAccount: value.fromOauthAccount === null ? null : { ...value.fromOauthAccount },
    credentialsWrittenHash: value.credentialsWrittenHash, credentialsWriteStarted: value.credentialsWriteStarted,
    credentialsWritten: value.credentialsWritten, configWriteStarted: value.configWriteStarted,
    configWritten: value.configWritten, closed: value.closed,
    ...(value.publishedAt === undefined ? {} : { publishedAt: value.publishedAt }),
    ...(value.committed === undefined ? {} : { committed: value.committed }),
    startedAt: value.startedAt, owner: { pid: ownerPid, lstart: value.owner.lstart },
  };
}

export function claudeSwitchJournalDir(options: ClaudeSwitchJournalPathOptions = {}): string {
  return options.journalDir ?? join(options.home ?? qlbHomeDir(options.env), '.qlb', 'journal');
}
export function claudeSwitchJournalPath(options: ClaudeSwitchJournalPathOptions = {}): string {
  return join(claudeSwitchJournalDir(options), JOURNAL_FILE);
}
export function claudeSwitchJournalOwnerLockPath(options: ClaudeSwitchJournalPathOptions = {}): string {
  return `${claudeSwitchJournalPath(options)}.lock`;
}

function assertJournalDirNotSymlink(options: ClaudeSwitchJournalPathOptions): string {
  const dir = claudeSwitchJournalDir(options);
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error('Claude switch journal directory must not be a symlink');
    if (!stat.isDirectory()) throw new Error('Claude switch journal directory is not a directory');
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  return dir;
}

function ensureJournalDir(options: ClaudeSwitchJournalPathOptions): string {
  const dir = assertJournalDirNotSymlink(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error('Claude switch journal directory must not be a symlink');
  if (!stat.isDirectory()) throw new Error('Claude switch journal directory is not a directory');
  chmodSync(dir, 0o700);
  return dir;
}

function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Claude switch journal path must not be a symlink');
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
}

/** Persist only parsed fields. All writes reject symlink paths and are followed by a directory fsync. */
function persistClaudeSwitchJournal(journal: ClaudeSwitchJournal, options: ClaudeSwitchJournalOptions): void {
  const parsed = parseClaudeSwitchJournal(journal, options);
  if (parsed === null) throw new Error('Invalid Claude switch journal');
  const dir = ensureJournalDir(options);
  const path = claudeSwitchJournalPath({ ...options, journalDir: dir });
  assertNotSymlink(path);
  atomicWriteText(path, `${JSON.stringify(parsed)}\n`, { mode: 0o600, followSymlinks: false });
  (options.fsyncDirectory ?? fsyncDirSync)(dirname(path));
}

/** Create a new journal without ever replacing an existing entry. */
export function createClaudeSwitchJournal(journal: ClaudeSwitchJournal, options: ClaudeSwitchJournalOptions): void {
  const parsed = parseClaudeSwitchJournal(journal, options);
  if (parsed === null) throw new Error('Invalid Claude switch journal');
  const dir = ensureJournalDir(options);
  const path = claudeSwitchJournalPath({ ...options, journalDir: dir });
  assertNotSymlink(path);
  const temporary = join(dir, `.${JOURNAL_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    options.beforeCreatePublish?.();
    linkSync(temporary, path);
  } catch (error) {
    if (errno(error) === 'EEXIST') throw new ClaudeSwitchJournalPresent();
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (errno(error) !== 'ENOENT') throw error; }
  }
  (options.fsyncDirectory ?? fsyncDirSync)(dirname(path));
}

/** Read a journal without treating corrupt, mismatched, or obsolete records as absent. */
export function readClaudeSwitchJournal(options: ClaudeSwitchJournalOptions): ClaudeSwitchJournalRead {
  try {
    assertJournalDirNotSymlink(options);
    const journal = parseClaudeSwitchJournal(JSON.parse(readFileSync(claudeSwitchJournalPath(options), 'utf8')), options);
    return journal === null ? { state: 'malformed' } : { state: 'ok', journal };
  } catch (error) {
    return errno(error) === 'ENOENT' ? { state: 'absent' } : { state: 'malformed' };
  }
}

type ClaudeSwitchJournalPatch = Partial<Pick<ClaudeSwitchJournal,
  'step' | 'stagedWritten' | 'credentialsWriteStarted' | 'credentialsWritten' | 'configWriteStarted' | 'configWritten'
  | 'configText' | 'configWrittenHash' | 'fromOauthAccount' | 'credentialsWrittenHash' | 'publishedAt' | 'committed' | 'closed'>>;

const PATCH_KEYS = new Set<string>([
  'step', 'stagedWritten', 'credentialsWriteStarted', 'credentialsWritten', 'configWriteStarted', 'configWritten',
  'configText', 'configWrittenHash', 'fromOauthAccount', 'credentialsWrittenHash', 'publishedAt', 'committed', 'closed',
]);

function assertJournalOwner(held: HeldClaudeSwitchJournalOwner, options: ClaudeSwitchJournalPathOptions): void {
  if (!held || held[journalOwnerHandle] !== true || held.journalDir !== claudeSwitchJournalDir(options)) {
    throw new Error('Claude switch journal owner lock must be held');
  }
  held.assertHeld();
}

/** Read-modify-write only the progress fields while holding the owner capability. */
export function updateClaudeSwitchJournal(
  held: HeldClaudeSwitchJournalOwner,
  patch: ClaudeSwitchJournalPatch,
  options: ClaudeSwitchJournalOptions,
): ClaudeSwitchJournal {
  assertJournalOwner(held, options);
  if (!isRecord(patch) || Object.keys(patch).some((key) => !PATCH_KEYS.has(key))) {
    throw new Error('Claude switch journal patch contains immutable fields');
  }
  const current = readClaudeSwitchJournal(options);
  if (current.state !== 'ok') throw new Error('Claude switch journal is missing or malformed');
  if (Object.prototype.hasOwnProperty.call(patch, 'fromOauthAccount')
    && (!Object.prototype.hasOwnProperty.call(patch, 'configText') || patch.configText === null)) {
    throw new Error('fromOauthAccount requires non-null configText in the same journal update');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'closed') && current.journal.closed !== null
    && patch.closed !== current.journal.closed) throw new Error('Claude switch journal closed marker cannot be cleared or changed');
  if (Object.prototype.hasOwnProperty.call(patch, 'committed') && current.journal.committed !== undefined
    && patch.committed !== current.journal.committed) throw new Error('Claude switch journal committed marker cannot be cleared or changed');
  const next = parseClaudeSwitchJournal({ ...current.journal, ...patch }, options);
  if (next === null) throw new Error('Invalid Claude switch journal update');
  assertJournalOwner(held, options);
  persistClaudeSwitchJournal(next, options);
  return next;
}

/** Delete is safe to retry and requires the same owner capability as an update. */
export function deleteClaudeSwitchJournal(held: HeldClaudeSwitchJournalOwner, options: ClaudeSwitchJournalOptions): void {
  assertJournalOwner(held, options);
  assertJournalDirNotSymlink(options);
  let deleted = false;
  try {
    unlinkSync(claudeSwitchJournalPath(options));
    deleted = true;
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  if (deleted) {
    try { (options.fsyncDirectory ?? fsyncDirSync)(claudeSwitchJournalDir(options)); } catch { /* best-effort durability */ }
  }
}

/** Serialize journal mutations and fail closed if a stale holder was taken over. */
export async function withClaudeSwitchJournalOwner<T>(
  options: ClaudeSwitchJournalOptions,
  fn: (held: HeldClaudeSwitchJournalOwner) => Promise<T> | T,
): Promise<T> {
  const journalDir = ensureJournalDir(options);
  return withProperLockfile(claudeSwitchJournalOwnerLockPath({ ...options, journalDir }), {
    timeoutMs: OWNER_LOCK_TIMEOUT_MS,
    stalenessMs: OWNER_LOCK_STALENESS_MS,
    onCompromised: (error) => { options.onOwnerLockCompromised?.(error); },
  }, async (proper: HeldProperLockfile) => {
    const held: HeldClaudeSwitchJournalOwner = {
      [journalOwnerHandle]: true,
      journalDir,
      assertHeld: () => proper.assertNotCompromised(),
    };
    const result = await fn(held);
    held.assertHeld();
    return result;
  });
}

/** Observe an owner lock without acquiring or removing it. */
export function probeClaudeSwitchJournalOwner(options: ClaudeSwitchJournalPathOptions = {}): 'held' | 'free' {
  try {
    assertJournalDirNotSymlink(options);
    const stat = lstatSync(claudeSwitchJournalOwnerLockPath(options));
    return stat.isDirectory() && Date.now() - stat.mtimeMs < OWNER_LOCK_STALENESS_MS ? 'held' : 'free';
  } catch {
    return 'free';
  }
}

export function stagedRollbackService(timestamp: string): string {
  return `${STAGED_PREFIX}${timestamp}`;
}

export async function writeStagedRollback(backend: ClaudeSlotBackend, service: string, blob: string): Promise<void> {
  await backend.set(service, QLB_KEYCHAIN_ACCOUNT, blob);
}
export async function readStagedRollback(backend: ClaudeSlotBackend, service: string): Promise<string | null> {
  try { return await backend.get(service, QLB_KEYCHAIN_ACCOUNT); } catch (error) { if (isCredentialNotFound(error)) return null; throw error; }
}
export async function deleteStagedRollback(backend: ClaudeSlotBackend, service: string): Promise<void> {
  try { await backend.delete(service, QLB_KEYCHAIN_ACCOUNT); } catch (error) { if (!isCredentialNotFound(error)) throw error; }
}
