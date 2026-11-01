// Pi single-provider credential migration (S28, S49, S58, S63).
// Credential bytes live only in the Keychain and the 0600 baseline file.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { atomicWriteText } from './fsutil';
import { ADAPTER_ACCOUNT_IDS } from './migration';
import { isCredentialNotFound } from './credential-backends';
import { isNativeOpenRouterKeyNotFound, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from './keychain';
import { qlbHomeDir } from './home';
import { genericHoldsSharedItem, resolveSingleGrantKeychain, sharedSingleGrantCoords, singleJournalAccount } from './single-grant-ownership';
import type { Store } from './store';

export const PI_SINGLE_PROVIDERS = ['xai', 'kimi-coding', 'openrouter'] as const;
export type PiSingleProvider = (typeof PI_SINGLE_PROVIDERS)[number];
export const PI_MIGRATE_PROVIDERS = [...PI_SINGLE_PROVIDERS, 'openai-codex', 'anthropic'] as const;
export type PiMigrateProvider = (typeof PI_MIGRATE_PROVIDERS)[number];
export const ENABLED_PI_MIGRATE_PROVIDERS: ReadonlySet<PiMigrateProvider> = new Set(PI_SINGLE_PROVIDERS);
type OAuthProvider = Exclude<PiMigrateProvider, 'openrouter'>;
const JOURNAL_PHASES = ['started', 'baseline', 'credential-saved', 'consumption-recorded', 'pool-moved', 'publishing', 'published', 'committed'] as const;
type JournalPhase = (typeof JOURNAL_PHASES)[number];
type CrashPoint = 'baseline' | 'credential-saved' | 'placeholder' | 'publishing' | 'owner-entry' | 'before-committed' | 'phase-dropped' | 'consumption-recorded' | 'pool-moved' | 'migrated-at' | 'entry-restored' | 'pool-rewritten' | 'rows-deleted' | 'pool-dir-restored';

export interface PiMigratePaths { authJsonPath: string; ownerPath: string; journalPath: string; baselineDir: string; }
export interface AuthLockTiming { staleMs?: number; retries?: number; retryMs?: number; now?: () => number; }
export interface PiMigrateDeps {
  keychain: Pick<KeychainBackend, 'getSync' | 'setSync' | 'deleteSync'>;
  store?: Pick<Store, 'getMigration' | 'getConfig' | 'setConfig' | 'recordLineage' | 'upsertAccount' | 'getAccount' | 'setAccountStatus' | 'listAnthropicSlotLineageChains' | 'replacePiExportTargets' | 'listPiExportTargets' | 'getActiveLogin'>;
  enabledProviders?: ReadonlySet<PiMigrateProvider>;
  readNativeOpenRouterKey?: () => string;
  withAuthLock?: <T>(path: string, fn: (refresh: () => void) => T) => T;
  authLockTiming?: AuthLockTiming;
  afterWrite?: (point: CrashPoint) => void;
  checkWritablePath?: (path: string) => void;
}
export interface PiMigrateResult { provider: PiMigrateProvider; state: 'migrated' | 'not-applicable'; resumed: boolean; wouldWrite: string[]; reason?: 'no-pi-credential'; warnings?: string[]; }
interface Journal { provider: PiMigrateProvider; phase: JournalPhase; ownerPid: number; updatedAt: number; priorBaselineConsumedBy?: string; }
type JsonObject = Record<string, unknown>;

function isPiSingleProvider(value: string): value is PiSingleProvider { return (PI_SINGLE_PROVIDERS as readonly string[]).includes(value); }
function isProvider(value: string): value is PiMigrateProvider { return (PI_MIGRATE_PROVIDERS as readonly string[]).includes(value); }
export function assertPiSingleProvider(value: string): asserts value is PiSingleProvider { if (!isPiSingleProvider(value)) throw new Error('provider must be xai, kimi-coding, or openrouter'); }
export function assertPiMigrateProvider(value: string): asserts value is PiMigrateProvider { if (!isProvider(value)) throw new Error('provider must be xai, kimi-coding, openrouter, openai-codex, or anthropic'); }
function isNoImportProvider(provider: PiMigrateProvider): provider is 'openai-codex' | 'anthropic' { return provider === 'openai-codex' || provider === 'anthropic'; }
function refusal(code: string, detail?: string): Error { return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, exitCode: 3 }); }
function assertEnabledProvider(provider: PiMigrateProvider, enabled: ReadonlySet<PiMigrateProvider>): void {
  if (!enabled.has(provider)) throw refusal('provider-not-enabled');
}
function assertProviderImplemented(provider: PiMigrateProvider): void {
  // P7-1a implements only the legacy single-provider path. The test seam may
  // enable future providers, but it must not expose that incomplete path.
  if (!isPiSingleProvider(provider)) throw refusal('provider-not-enabled');
}
function requireStore(provider: PiMigrateProvider, deps: PiMigrateDeps): void { if (isNoImportProvider(provider) && !deps.store) throw refusal('store-required'); }

/** authJsonPath may be overridden; QLB state always stays below qlbHome. */
export function defaultPiMigratePaths(home: string = qlbHomeDir(), authJsonPath = join(home, '.pi', 'agent', 'auth.json')): PiMigratePaths {
  return { authJsonPath, ownerPath: join(dirname(authJsonPath), 'qlb-owner.json'), journalPath: join(home, '.qlb', 'journal'), baselineDir: join(home, '.qlb', 'backups', 'pi-auth') };
}
export function piPlaceholder(now = Date.now()): JsonObject { return { type: 'oauth', access: 'qlb-managed', refresh: '', expires: now + 10 * 365 * 24 * 60 * 60 * 1000 }; }
function asObject(value: unknown, message: string): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message); return value as JsonObject; }
function readAuth(path: string): JsonObject { return existsSync(path) ? asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi auth.json is not an object') : {}; }
export class PiOwnerLegacyError extends Error {
  readonly code = 'owner-file-legacy-v1';
  readonly exitCode = 3;
  constructor() { super('owner-file-legacy-v1: run `qlb migrate resume --provider anthropic` to convert it'); this.name = 'PiOwnerLegacyError'; }
}
/** Read only the canonical v2 provider map; v1 documents must be converted by the Anthropic path. */
export function readPiOwnerProviders(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const owner = asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi owner file is not an object');
  if (Object.prototype.hasOwnProperty.call(owner, 'providers') && owner.providers && typeof owner.providers === 'object' && !Array.isArray(owner.providers)) return owner.providers as JsonObject;
  if (!Object.prototype.hasOwnProperty.call(owner, 'providers') && (Object.prototype.hasOwnProperty.call(owner, 'owner') || Object.prototype.hasOwnProperty.call(owner, 'accounts'))) throw new PiOwnerLegacyError();
  throw new Error('Pi owner file is malformed');
}
/** Whether a v1 owner record claims this provider. */
export function hasLegacyPiOwnerEntry(path: string, provider: string): boolean {
  if (!existsSync(path)) return false;
  const owner = asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi owner file is not an object');
  return !Object.prototype.hasOwnProperty.call(owner, 'providers') && owner.owner === 'qlb' && Array.isArray(owner.accounts) && owner.accounts.some((account) =>
    !!account && typeof account === 'object' && !Array.isArray(account) && (account as JsonObject).provider === provider,
  );
}
/** Atomic, caller-lock-protected mutation of the canonical v2 owner map. */
export function writePiOwnerEntry(path: string, provider: string, owned: boolean): void {
  const providers = { ...readPiOwnerProviders(path) };
  if (owned) providers[provider] = { mode: 'qlb', since: Date.now() };
  else delete providers[provider];
  if (Object.keys(providers).length === 0) { if (existsSync(path)) unlinkSync(path); return; }
  writeJson(path, { providers });
}
function writeJson(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function writeJournal(path: string, journal: Journal, refresh?: () => void): void { refresh?.(); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); atomicWriteText(path, `${JSON.stringify(journal)}\n`, { mode: 0o600 }); }
function journalPath(paths: PiMigratePaths, provider: PiMigrateProvider): string { return join(paths.journalPath, `pi-migrate-${provider}.json`); }
function baselinePath(paths: PiMigratePaths, provider: PiMigrateProvider): string { return join(paths.baselineDir, `${provider}.json`); }
function readJournal(paths: PiMigratePaths, provider: PiMigrateProvider): Journal | null {
  const path = journalPath(paths, provider); if (!existsSync(path)) return null;
  const parsed = asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi migration journal is malformed');
  if (parsed.provider !== provider || typeof parsed.phase !== 'string' || !JOURNAL_PHASES.includes(parsed.phase as JournalPhase) || (Object.prototype.hasOwnProperty.call(parsed, 'priorBaselineConsumedBy') && typeof parsed.priorBaselineConsumedBy !== 'string')) throw new Error('Pi migration journal is malformed');
  return { provider, phase: parsed.phase as JournalPhase, ownerPid: Number(parsed.ownerPid) || 0, updatedAt: Number(parsed.updatedAt) || 0, ...(typeof parsed.priorBaselineConsumedBy === 'string' ? { priorBaselineConsumedBy: parsed.priorBaselineConsumedBy } : {}) };
}
function placeholderBaselineError(provider: PiMigrateProvider): Error { return new Error(`Pi ${provider} baseline would be a placeholder; run qlb pi rollback or restore auth.json`); }
function phaseAtLeast(actual: JournalPhase, expected: JournalPhase): boolean { return JOURNAL_PHASES.indexOf(actual) >= JOURNAL_PHASES.indexOf(expected); }
function updatePhase(paths: PiMigratePaths, provider: PiMigrateProvider, phase: JournalPhase, refresh?: () => void, fields?: Pick<Journal, 'priorBaselineConsumedBy'>): void {
  const current = readJournal(paths, provider);
  writeJournal(journalPath(paths, provider), { provider, phase, ownerPid: process.pid, updatedAt: Date.now(), ...(current?.priorBaselineConsumedBy !== undefined ? { priorBaselineConsumedBy: current.priorBaselineConsumedBy } : {}), ...fields }, refresh);
}
function fingerprint(value: string): string { return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`; }
function managedService(provider: PiMigrateProvider): string { return qlbKeychainService(provider, 'default'); }
function parseOAuth(entry: unknown, provider: OAuthProvider): JsonObject { const credential = asObject(entry, `Pi auth.json has no ${provider} credential`); if (typeof credential.access !== 'string' || !credential.access || typeof credential.refresh !== 'string' || !credential.refresh || typeof credential.expires !== 'number' || !Number.isFinite(credential.expires)) throw new Error(`Pi auth.json ${provider} credential is invalid`); return credential; }
export function isPiPlaceholder(entry: unknown): boolean { return !!entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as JsonObject).access === 'qlb-managed' && (entry as JsonObject).refresh === '' && (entry as JsonObject).type === 'oauth'; }

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function lockedError(): Error { return Object.assign(new Error('pi-auth-locked'), { code: 'pi-auth-locked', name: 'PiAuthLockedError' }); }
function lockLostError(detail = '', cause?: Error): Error { return Object.assign(new Error(`pi-auth-lock-lost: another run took the auth.json lock over${detail}`, cause ? { cause } : undefined), { code: 'pi-auth-lock-lost', name: 'PiAuthLockLostError' }); }
/**
 * P7a-r-Q2: run fn under the auth lock; a lost lock exits 3 before the run's first write and 1 once a write may have landed.
 * Every write is preceded by a passing refresh(), so "a refresh passed" over-reports writes, never under-reports them.
 */
function underAuthLock(lock: NonNullable<PiMigrateDeps['withAuthLock']>, authPath: string, fn: (refresh: () => void) => void): void {
  let wrote = false;
  try {
    lock(authPath, (refresh) => fn(() => { refresh(); wrote = true; }));
  } catch (error) {
    if ((error as { code?: unknown }).code === 'pi-auth-lock-lost') Object.assign(error as object, { exitCode: wrote ? 1 : 3 });
    throw error;
  }
}
interface AuthLockOwner { pid: number; nonce: string; }
function lockOwnerPath(lock: string): string { return join(lock, 'qlb-lock-owner.json'); }
function readLockOwner(lock: string): AuthLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockOwnerPath(lock), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { pid, nonce } = parsed as { pid?: unknown; nonce?: unknown };
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof nonce === 'string' && nonce.length > 0 ? { pid, nonce } : null;
  } catch { return null; }
}
function ownerMatches(lock: string, owner: AuthLockOwner): boolean {
  const actual = readLockOwner(lock);
  return actual?.pid === owner.pid && actual.nonce === owner.nonce;
}
function ownerIsDead(owner: AuthLockOwner): boolean {
  try { process.kill(owner.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function staleLockOwner(lock: string, staleMs: number, now: () => number): AuthLockOwner | null | undefined {
  try {
    if (now() - statSync(lock).mtimeMs <= staleMs) return undefined;
    const owner = readLockOwner(lock);
    return owner === null || ownerIsDead(owner) ? owner : undefined;
  } catch { return undefined; }
}
function sameOwner(left: AuthLockOwner | null, right: AuthLockOwner | null): boolean {
  return left === null ? right === null : right?.pid === left.pid && right.nonce === left.nonce;
}
/** Atomically move a stale lock aside; only the rename winner may remove it. */
function takeOverStaleLock(lock: string, staleMs: number, nonce: string, now: () => number): boolean {
  const expected = staleLockOwner(lock, staleMs, now);
  if (expected === undefined) return false;
  const stalePath = `${lock}.stale-${nonce}`;
  try { renameSync(lock, stalePath); } catch { return false; }
  const confirmed = staleLockOwner(stalePath, staleMs, now);
  if (confirmed !== undefined && sameOwner(expected, confirmed)) {
    rmSync(stalePath, { recursive: true, force: true });
    return true;
  }
  // A live owner raced in after our initial check. Restore its lock only if
  // nobody acquired the canonical path while it was moved aside.
  if (!existsSync(lock)) {
    try { renameSync(stalePath, lock); } catch { /* another taker acquired it */ }
  }
  return false;
}
export function withPiAuthLock<T>(authPath: string, fn: (refresh: () => void) => T, timing: AuthLockTiming = {}): T {
  const lock = `${authPath}.lock`; const staleMs = timing.staleMs ?? 10_000; const retries = timing.retries ?? 20; const retryMs = timing.retryMs ?? 250; const now = timing.now ?? Date.now;
  const owner: AuthLockOwner = { pid: process.pid, nonce: randomUUID() };
  let acquired = false;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      mkdirSync(lock, { recursive: false, mode: 0o700 });
      writeFileSync(lockOwnerPath(lock), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (takeOverStaleLock(lock, staleMs, owner.nonce, now)) { attempt -= 1; continue; }
      if (attempt === retries) throw lockedError();
      sleepSync(retryMs);
    }
  }
  if (!acquired) throw lockedError();
  const refresh = () => {
    if (!ownerMatches(lock, owner)) throw lockLostError();
    // A taker may move the lock aside, or replace it, between the owner check and the touch.
    try { utimesSync(lock, new Date(now()), new Date(now())); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw lockLostError();
      throw error;
    }
    if (!ownerMatches(lock, owner)) throw lockLostError();
  };
  try { refresh(); return fn(refresh); } finally { if (ownerMatches(lock, owner)) rmSync(lock, { recursive: true, force: true }); }
}

/** Resolve symlinks even for a not-yet-created leaf, then probe its real parent. */
function realPathAllowMissing(path: string): string {
  const suffix: string[] = []; let ancestor = resolve(path);
  while (!existsSync(ancestor)) { suffix.unshift(ancestor.slice(ancestor.lastIndexOf('/') + 1)); const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
  return join(realpathSync(ancestor), ...suffix);
}
function assertOutsideGitWorktree(path: string, qlbHome: string): void {
  const resolved = realPathAllowMissing(path); const exempt = realPathAllowMissing(join(qlbHome, '.qlb'));
  if (resolved === exempt || resolved.startsWith(`${exempt}/`)) return;
  try { const top = String(execFileSync('git', ['-C', dirname(resolved), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); if (top) throw refusal('pi-path-in-git-worktree', `refusing Pi migration write inside git work tree: ${resolved}`); } catch (error) { if ((error as { code?: unknown }).code === 'pi-path-in-git-worktree') throw error; }
}
export function assertDirOutsideGitWorktree(dir: string, qlbHome: string): void {
  const resolved = realPathAllowMissing(dir); const exempt = realPathAllowMissing(join(qlbHome, '.qlb'));
  if (resolved === exempt || resolved.startsWith(`${exempt}/`)) return;
  let probe = resolved;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try { const top = String(execFileSync('git', ['-C', probe, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); if (top) throw refusal('pi-path-in-git-worktree', `refusing Pi migration write inside git work tree: ${resolved}`); } catch (error) { if ((error as { code?: unknown }).code === 'pi-path-in-git-worktree') throw error; }
}
function checkPaths(paths: PiMigratePaths, deps: PiMigrateDeps): void { for (const path of [paths.authJsonPath, paths.ownerPath]) { deps.checkWritablePath?.(path); assertOutsideGitWorktree(path, qlbHomeDir()); } }
export function isPiQlbOwnerEntry(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as JsonObject).mode === 'qlb';
}
function baselineValue(provider: PiMigrateProvider, auth: JsonObject, deps: PiMigrateDeps): unknown {
  if (provider !== 'openrouter') return auth[provider];
  if (!deps.readNativeOpenRouterKey) throw new Error('native OpenRouter reader is required');
  try { const key = deps.readNativeOpenRouterKey(); return key ? { type: 'api-key', access: key } : undefined; } catch (error) {
    if (isNativeOpenRouterKeyNotFound(error)) return undefined;
    throw error;
  }
}
function keychainPayload(provider: PiMigrateProvider, baseline: unknown): string { if (provider === 'openrouter') { const value = asObject(baseline, 'openrouter credential is invalid'); if (typeof value.access !== 'string' || !value.access) throw new Error('openrouter credential is invalid'); return JSON.stringify({ type: 'api-key', access: value.access }); } return JSON.stringify(parseOAuth(baseline, provider)); }
function managedValue(provider: PiMigrateProvider, deps: PiMigrateDeps): unknown | undefined { try { return JSON.parse(deps.keychain.getSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT)); } catch { return undefined; } }
/** Only an explicit not-found or an invalid stored value counts as unusable; any other read error fails closed. */
function usableManaged(provider: PiMigrateProvider, deps: PiMigrateDeps): boolean {
  let raw: string;
  try { raw = deps.keychain.getSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT); } catch (error) { if (isCredentialNotFound(error)) return false; throw error; }
  try { keychainPayload(provider, JSON.parse(raw)); return true; } catch { return false; }
}

/** The owner-file probes shared by the S0.6 admission and S66 delete guard. */
function genericMigrationPathFacts(
  provider: PiMigrateProvider,
  paths: PiMigratePaths,
  detail: JsonObject | undefined,
): { hasStaging: boolean; hasLegacySidecar: boolean; hasCustomOwnerFile: boolean } {
  const canonicalDir = dirname(paths.ownerPath);
  const canonicalStaging = join(canonicalDir, `qlb-owner.json.${provider}.staging`);
  const legacySidecar = join(canonicalDir, `qlb-owner-${provider}.json`);
  const ownerFilePath = typeof detail?.ownerFilePath === 'string' ? detail.ownerFilePath : undefined;
  const recordedStaging = ownerFilePath && join(dirname(ownerFilePath), `qlb-owner.json.${provider}.staging`);
  const customOwner = ownerFilePath && ownerFilePath !== paths.ownerPath ? ownerFilePath : undefined;
  return {
    hasStaging: existsSync(canonicalStaging) || !!(recordedStaging && existsSync(recordedStaging)),
    hasLegacySidecar: existsSync(legacySidecar),
    hasCustomOwnerFile: !!(customOwner && existsSync(customOwner)),
  };
}

/** S0.6: generic ownership must be quiescent before P7a may begin. */
function genericMigrationAtRest(provider: PiMigrateProvider, paths: PiMigratePaths, deps: PiMigrateDeps, ownJournal: Journal | null): boolean {
  const row = deps.store?.getMigration(`pi-${provider}`);
  let detail: JsonObject | undefined;
  if (row) {
    if (row.state !== 'NATIVE' && row.state !== 'VALIDATED') return false;
    try { detail = asObject(JSON.parse(row.detail_json), 'generic migration journal is malformed'); } catch { return false; }
  }

  const pathFacts = genericMigrationPathFacts(provider, paths, detail);
  let canonicalOwnerClaim = false;
  try { canonicalOwnerClaim = isPiQlbOwnerEntry(readPiOwnerProviders(paths.ownerPath)[provider]); } catch { /* readPiOwnerProviders fails closed before publication */ }
  const ownPublishedClaim = ownJournal?.phase === 'publishing' || ownJournal?.phase === 'published' || ownJournal?.phase === 'committed'
    || deps.store?.getConfig(`pi.${provider}.state`) === 'migrated';
  return !pathFacts.hasStaging
    && !pathFacts.hasLegacySidecar
    && !pathFacts.hasCustomOwnerFile
    && (!canonicalOwnerClaim || ownPublishedClaim)
    && detail?.intent !== 'rollback'
    && detail?.rollbackDecision == null
    && detail?.handback == null;
}

function genericMigrationOwnedError(): Error {
  return Object.assign(new Error('owned-by-generic-migrate'), { code: 'owned-by-generic-migrate', exitCode: 3 });
}

function genericRollbackOwnershipUnreadableError(provider: OAuthProvider): Error {
  return Object.assign(
    new Error(`generic-ownership-unreadable: cannot determine whether generic migration pi-${provider} owns the shared item; run \`qlb migrate rollback --provider ${provider}\` first`),
    { code: 'generic-ownership-unreadable', exitCode: 3 },
  );
}

function genericRollbackOwnedError(provider: OAuthProvider): Error {
  return Object.assign(
    new Error(`owned-by-generic-migrate: generic migration pi-${provider} owns the shared item; run \`qlb migrate rollback --provider ${provider}\` first`),
    { code: 'owned-by-generic-migrate', exitCode: 3 },
  );
}

function keptCopyStashUnverifiedError(): Error {
  return Object.assign(new Error('kept-copy-stash-unverified'), { code: 'kept-copy-stash-unverified', exitCode: 3 });
}

function journalKeychainInvalidError(cause: unknown): Error {
  return Object.assign(new Error('journal-keychain-invalid', { cause }), { code: 'journal-keychain-invalid', exitCode: 3 });
}

/** Not-found is undefined; any other read error fails closed. */
function readKeychainItem(deps: PiMigrateDeps, service: string, account: string): string | undefined {
  try { return deps.keychain.getSync(service, account); } catch (error) { if (isCredentialNotFound(error)) return undefined; throw error; }
}

/** OQ-7 (c1): preserve a generic hand-back's kept copy under a name fixed by lastRollback.cleanedAt. */
function stashKeptGenericCopy(
  provider: PiMigrateProvider,
  deps: PiMigrateDeps,
  readOwnJournal: () => Journal | null,
  assertLockHeld: () => void,
): void {
  if (!isPiSingleProvider(provider) || provider === 'openrouter' || deps.store?.getConfig(`pi.${provider}.state`) === 'migrated') return;
  const generic = deps.store?.getMigration(`pi-${provider}`);
  if (!generic || generic.state !== 'NATIVE') return;

  const detail = asObject(JSON.parse(generic.detail_json), 'generic migration journal is malformed');
  const lastRollback = detail.lastRollback;
  if (!lastRollback || typeof lastRollback !== 'object' || Array.isArray(lastRollback)) return;
  const rollback = lastRollback as JsonObject;
  if (rollback.keychainDisposition !== 'keep') return;
  // Read Pi's own journal only once a kept copy is in play, so a malformed
  // journal never blocks the rollback that would otherwise clear it.
  if (readOwnJournal()) return;
  let coords;
  try { coords = resolveSingleGrantKeychain(provider, singleJournalAccount(detail.accounts)); } catch (error) { throw journalKeychainInvalidError(error); }
  const shared = sharedSingleGrantCoords(provider);
  if (coords.service !== shared.service || coords.account !== shared.account) return;
  if (typeof rollback.cleanedAt !== 'number' || !Number.isFinite(rollback.cleanedAt)) {
    throw new Error('generic migration lastRollback cleanedAt is invalid');
  }
  const stashService = qlbKeychainService(provider, `kept:${new Date(rollback.cleanedAt).toISOString()}`);
  if (readKeychainItem(deps, stashService, QLB_KEYCHAIN_ACCOUNT) !== undefined) return;
  const kept = readKeychainItem(deps, shared.service, shared.account);
  if (kept === undefined) return;
  assertLockHeld();
  deps.keychain.setSync(stashService, QLB_KEYCHAIN_ACCOUNT, kept);
  if (readKeychainItem(deps, stashService, QLB_KEYCHAIN_ACCOUNT) !== kept) {
    // A stash that does not hold the kept copy must not read as "already preserved" on the next run.
    try { assertLockHeld(); } catch (error) {
      // Lock lost: removing it now could delete the new holder's stash, so name what is left behind.
      if ((error as { code?: unknown }).code !== 'pi-auth-lock-lost') throw error;
      throw lockLostError(`; the unverified kept-copy stash ${stashService} (account ${QLB_KEYCHAIN_ACCOUNT}) was left in place`, keptCopyStashUnverifiedError());
    }
    try { deps.keychain.deleteSync(stashService, QLB_KEYCHAIN_ACCOUNT); } catch (error) { if (!isCredentialNotFound(error)) throw error; }
    throw keptCopyStashUnverifiedError();
  }
}

/** P7a migration with S58's credential-first publication order. */
export function migratePiSingleProvider(provider: PiMigrateProvider, paths: PiMigratePaths = defaultPiMigratePaths(), deps: PiMigrateDeps, options: { dryRun?: boolean } = {}): PiMigrateResult {
  assertPiMigrateProvider(provider);
  const enabled = deps.enabledProviders ?? ENABLED_PI_MIGRATE_PROVIDERS;
  assertEnabledProvider(provider, enabled);
  requireStore(provider, deps);
  assertProviderImplemented(provider);
  const existing = readJournal(paths, provider); const wouldWrite = [managedService(provider), `placeholder:${provider}`, `owner:${provider}`];
  if (options.dryRun) return { provider, state: 'migrated', resumed: existing !== null, wouldWrite };
  checkPaths(paths, deps);
  const lock = deps.withAuthLock ?? ((path, fn) => withPiAuthLock(path, fn, deps.authLockTiming));
  let journal: Journal;
  let resumed = false;
  let state: PiMigrateResult['state'] = 'not-applicable';
  underAuthLock(lock, paths.authJsonPath, (refresh) => {
    const inLockJournal = readJournal(paths, provider);
    journal = inLockJournal ?? { provider, phase: 'started', ownerPid: process.pid, updatedAt: Date.now() };
    resumed = inLockJournal !== null;
    if (!genericMigrationAtRest(provider, paths, deps, inLockJournal)) throw genericMigrationOwnedError();
    const auth = readAuth(paths.authJsonPath); const currentOwner = readPiOwnerProviders(paths.ownerPath);
    const alreadyMigrated = !inLockJournal && (provider === 'openrouter' || isPiPlaceholder(auth[provider])) && isPiQlbOwnerEntry(currentOwner[provider]);
    if (alreadyMigrated) {
      state = 'migrated';
    } else {
      // D-B74: refuse a placeholder baseline before the first write (no stray 'started' journal).
      if (!inLockJournal && provider !== 'openrouter' && isPiPlaceholder(auth[provider])) throw placeholderBaselineError(provider);
      // OQ-7 (c1): after admission and before the first write, so a crash never leaves a P7a journal ahead of the stash.
      stashKeptGenericCopy(provider, deps, () => inLockJournal, refresh);
      if (!inLockJournal) updatePhase(paths, provider, 'started', refresh);
      let baseline: unknown; const baselineFile = baselinePath(paths, provider);
      if (phaseAtLeast(journal.phase, 'baseline') && existsSync(baselineFile)) baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
      else {
        baseline = baselineValue(provider, auth, deps);
        if (baseline === undefined) {
          refresh(); deps.store?.setConfig(`pi.${provider}.state`, 'not-applicable');
          updatePhase(paths, provider, 'committed', refresh); refresh(); rmSync(journalPath(paths, provider), { force: true });
          return;
        }
        if (isPiPlaceholder(baseline)) throw placeholderBaselineError(provider);
        refresh(); writeJson(baselineFile, baseline); updatePhase(paths, provider, 'baseline', refresh); journal = { ...journal, phase: 'baseline' }; deps.afterWrite?.('baseline');
      }
      if (provider !== 'openrouter' && phaseAtLeast(journal.phase, 'publishing') && !isPiPlaceholder(auth[provider])) throw new Error(`Pi ${provider} entry changed after publication`);
      // Install and verify the managed item on every resume before publication,
      // including 'publishing': the item may have been lost or changed in the crash window.
      // A 'publishing' journal whose owner entry is already visible was published:
      // a valid managed item may have been refreshed since, so it is never overwritten.
      // A missing or invalid one is reinstalled from the baseline like any other resume.
      const publishedItemKept = journal.phase === 'publishing' && isPiQlbOwnerEntry(currentOwner[provider]) && usableManaged(provider, deps);
      if (!phaseAtLeast(journal.phase, 'published') && !publishedItemKept) {
        let source: unknown = provider === 'openrouter' ? baseline : (isPiPlaceholder(auth[provider]) || auth[provider] === undefined ? baseline : auth[provider]);
        if (provider !== 'openrouter' && source !== baseline) { try { keychainPayload(provider, source); } catch { source = baseline; } }
        const payload = keychainPayload(provider, source);
        if (provider !== 'openrouter' && source !== baseline) { refresh(); writeJson(baselineFile, source); baseline = source; }
        refresh(); deps.keychain.setSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT, payload); refresh();
        const verified = deps.keychain.getSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT); if (verified !== payload) throw new Error('managed credential verification failed');
        if (!phaseAtLeast(journal.phase, 'credential-saved')) { updatePhase(paths, provider, 'credential-saved', refresh); journal = { ...journal, phase: 'credential-saved' }; deps.afterWrite?.('credential-saved'); }
        if (provider !== 'openrouter') { auth[provider] = piPlaceholder(); refresh(); writeJson(paths.authJsonPath, auth); refresh(); deps.afterWrite?.('placeholder'); }
        if (!phaseAtLeast(journal.phase, 'publishing')) { updatePhase(paths, provider, 'publishing', refresh); journal = { ...journal, phase: 'publishing' }; deps.afterWrite?.('publishing'); }
      }
      refresh(); writePiOwnerEntry(paths.ownerPath, provider, true); deps.afterWrite?.('owner-entry'); updatePhase(paths, provider, 'published', refresh); journal = { ...journal, phase: 'published' }; state = 'migrated';
    }
    if (state !== 'migrated') return;
    const managed = deps.keychain.getSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT); const parsed = JSON.parse(managed) as { refresh?: string; access?: string }; const lineage = fingerprint(typeof parsed.refresh === 'string' && parsed.refresh ? parsed.refresh : String(parsed.access ?? ''));
    const store = deps.store;
    const sharedAccountId = ADAPTER_ACCOUNT_IDS[provider as PiSingleProvider];
    refresh(); store?.upsertAccount(sharedAccountId, provider, provider, 'active');
    if (store && store.getAccount(sharedAccountId)?.status === 'handed-back') {
      refresh(); store.setAccountStatus(sharedAccountId, 'active');
    }
    refresh(); deps.store?.recordLineage({ provider, accountId: 'default', toFp: lineage, cause: 'import', by: 'qlb-cli', evidence: 'import' });
    refresh(); deps.store?.setConfig(`single.${provider}.activeId`, 'default');
    refresh(); deps.store?.setConfig(`pi.${provider}.state`, 'migrated');
    refresh(); deps.store?.setConfig(`pi.${provider}.migratedAt`, String(Date.now()));
    deps.afterWrite?.('before-committed'); updatePhase(paths, provider, 'committed', refresh); refresh(); rmSync(journalPath(paths, provider), { force: true });
  });
  return { provider, state, resumed, wouldWrite };
}

/** S49 rollback for P7a's xai/kimi/openrouter subset. */
export function rollbackPiSingleProvider(provider: PiMigrateProvider, paths: PiMigratePaths = defaultPiMigratePaths(), deps: PiMigrateDeps): PiMigrateResult {
  assertPiMigrateProvider(provider);
  const enabled = deps.enabledProviders ?? ENABLED_PI_MIGRATE_PROVIDERS;
  assertEnabledProvider(provider, enabled);
  requireStore(provider, deps);
  assertProviderImplemented(provider);
  checkPaths(paths, deps);
  const lock = deps.withAuthLock ?? ((path, fn) => withPiAuthLock(path, fn, deps.authLockTiming));
  underAuthLock(lock, paths.authJsonPath, (refresh) => {
    if (isPiSingleProvider(provider) && provider !== 'openrouter') {
      if (!deps.store) throw genericRollbackOwnershipUnreadableError(provider);
      const generic = deps.store.getMigration(`pi-${provider}`);
      let genericDetail: JsonObject | undefined;
      try {
        if (generic) genericDetail = asObject(JSON.parse(generic.detail_json), 'generic migration journal is malformed');
      } catch { /* unreadable: genericHoldsSharedItem holds it without the recorded-path probes */ }
      const pathFacts = genericMigrationPathFacts(provider, paths, genericDetail);
      if (genericHoldsSharedItem(provider, {
        state: generic?.state ?? null,
        detailJson: generic?.detail_json ?? null,
        ...pathFacts,
      })) {
        throw genericRollbackOwnedError(provider);
      }
    }
    const baselineFile = baselinePath(paths, provider); const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : undefined;
    const managed = provider === 'openrouter' ? undefined : managedValue(provider, deps);
    const auth = provider === 'openrouter' ? undefined : readAuth(paths.authJsonPath);
    const current = auth?.[provider]; const needsRestore = provider !== 'openrouter' && (current === undefined || isPiPlaceholder(current));
    let restore: unknown;
    if (needsRestore) {
      const usableManaged = managed !== undefined && (() => { try { keychainPayload(provider, managed); return true; } catch { return false; } })();
      const usableBaseline = baseline !== undefined && (() => { try { keychainPayload(provider, baseline); return true; } catch { return false; } })();
      restore = usableManaged ? managed : usableBaseline ? baseline : undefined;
      if (restore === undefined) throw new Error(`no managed or baseline ${provider} credential available for rollback`);
    }
    refresh(); writePiOwnerEntry(paths.ownerPath, provider, false); refresh(); deps.afterWrite?.('owner-entry');
    if (needsRestore && auth) {
      auth[provider] = restore; refresh(); writeJson(paths.authJsonPath, auth); refresh();
      if (JSON.stringify(readAuth(paths.authJsonPath)[provider]) !== JSON.stringify(restore)) throw new Error('Pi credential rollback verification failed');
    }
    // Always release QLB's managed item once Pi has either retained its own
    // non-placeholder credential or verified a restored one. This makes a
    // retry converge after a prior delete failure.
    // The stash checks the lock before its own writes; the delete gets a fresh check after it.
    stashKeptGenericCopy(provider, deps, () => readJournal(paths, provider), refresh);
    refresh();
    try { deps.keychain.deleteSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT); } catch (error) {
      if (!isCredentialNotFound(error)) throw error;
    }
    refresh(); deps.store?.setConfig(`pi.${provider}.state`, ''); refresh(); deps.store?.setConfig(`pi.${provider}.migratedAt`, '');
    refresh(); rmSync(journalPath(paths, provider), { force: true });
  });
  return { provider, state: 'migrated', resumed: false, wouldWrite: [] };
}
