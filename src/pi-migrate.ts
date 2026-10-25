// Pi single-provider credential migration (S28, S49, S58, S63).
// Credential bytes live only in the Keychain and the 0600 baseline file.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { atomicWriteText } from './fsutil';
import { isNativeOpenRouterKeyNotFound, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from './keychain';
import { qlbHomeDir } from './home';
import type { Store } from './store';

export const PI_SINGLE_PROVIDERS = ['xai', 'kimi-coding', 'openrouter'] as const;
export type PiSingleProvider = (typeof PI_SINGLE_PROVIDERS)[number];
type OAuthProvider = Exclude<PiSingleProvider, 'openrouter'>;
type JournalPhase = 'started' | 'baseline' | 'credential-saved' | 'published' | 'committed';
type CrashPoint = 'baseline' | 'credential-saved' | 'placeholder' | 'owner-entry' | 'before-committed';

export interface PiMigratePaths { authJsonPath: string; ownerPath: string; journalPath: string; baselineDir: string; }
export interface AuthLockTiming { staleMs?: number; retries?: number; retryMs?: number; }
export interface PiMigrateDeps {
  keychain: Pick<KeychainBackend, 'getSync' | 'setSync' | 'deleteSync'>;
  store?: Pick<Store, 'setConfig' | 'recordLineage' | 'upsertAccount'>;
  readNativeOpenRouterKey?: () => string;
  withAuthLock?: <T>(path: string, fn: (refresh: () => void) => T) => T;
  authLockTiming?: AuthLockTiming;
  afterWrite?: (point: CrashPoint) => void;
  checkWritablePath?: (path: string) => void;
}
export interface PiMigrateResult { provider: PiSingleProvider; state: 'migrated' | 'not-applicable'; resumed: boolean; wouldWrite: string[]; }
interface Journal { provider: PiSingleProvider; phase: JournalPhase; ownerPid: number; updatedAt: number; }
type JsonObject = Record<string, unknown>;

function isProvider(value: string): value is PiSingleProvider { return (PI_SINGLE_PROVIDERS as readonly string[]).includes(value); }
export function assertPiSingleProvider(value: string): asserts value is PiSingleProvider { if (!isProvider(value)) throw new Error('provider must be xai, kimi-coding, or openrouter'); }

/** authJsonPath may be overridden; QLB state always stays below qlbHome. */
export function defaultPiMigratePaths(home: string = qlbHomeDir(), authJsonPath = join(home, '.pi', 'agent', 'auth.json')): PiMigratePaths {
  return { authJsonPath, ownerPath: join(dirname(authJsonPath), 'qlb-owner.json'), journalPath: join(home, '.qlb', 'journal'), baselineDir: join(home, '.qlb', 'backups', 'pi-auth') };
}
export function piPlaceholder(now = Date.now()): JsonObject { return { type: 'oauth', access: 'qlb-managed', refresh: '', expires: now + 10 * 365 * 24 * 60 * 60 * 1000 }; }
function asObject(value: unknown, message: string): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message); return value as JsonObject; }
function readAuth(path: string): JsonObject { return existsSync(path) ? asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi auth.json is not an object') : {}; }
function readOwner(path: string): JsonObject { if (!existsSync(path)) return { providers: {} }; const owner = asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi owner file is not an object'); if (!owner.providers || typeof owner.providers !== 'object' || Array.isArray(owner.providers)) throw new Error('Pi owner file is malformed'); return owner; }
function writeJson(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function writeJournal(path: string, journal: Journal, refresh?: () => void): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); atomicWriteText(path, `${JSON.stringify(journal)}\n`, { mode: 0o600 }); refresh?.(); }
function journalPath(paths: PiMigratePaths, provider: PiSingleProvider): string { return join(paths.journalPath, `pi-migrate-${provider}.json`); }
function baselinePath(paths: PiMigratePaths, provider: PiSingleProvider): string { return join(paths.baselineDir, `${provider}.json`); }
function readJournal(paths: PiMigratePaths, provider: PiSingleProvider): Journal | null { const path = journalPath(paths, provider); if (!existsSync(path)) return null; const parsed = asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi migration journal is malformed'); const phases: JournalPhase[] = ['started', 'baseline', 'credential-saved', 'published', 'committed']; if (parsed.provider !== provider || typeof parsed.phase !== 'string' || !phases.includes(parsed.phase as JournalPhase)) throw new Error('Pi migration journal is malformed'); return { provider, phase: parsed.phase as JournalPhase, ownerPid: Number(parsed.ownerPid) || 0, updatedAt: Number(parsed.updatedAt) || 0 }; }
function phaseAtLeast(actual: JournalPhase, expected: JournalPhase): boolean { return ['started', 'baseline', 'credential-saved', 'published', 'committed'].indexOf(actual) >= ['started', 'baseline', 'credential-saved', 'published', 'committed'].indexOf(expected); }
function updatePhase(paths: PiMigratePaths, provider: PiSingleProvider, phase: JournalPhase, refresh?: () => void): void { writeJournal(journalPath(paths, provider), { provider, phase, ownerPid: process.pid, updatedAt: Date.now() }, refresh); }
function fingerprint(value: string): string { return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`; }
function managedService(provider: PiSingleProvider): string { return qlbKeychainService(provider, 'default'); }
function parseOAuth(entry: unknown, provider: OAuthProvider): JsonObject { const credential = asObject(entry, `Pi auth.json has no ${provider} credential`); if (typeof credential.access !== 'string' || !credential.access || typeof credential.refresh !== 'string' || !credential.refresh || typeof credential.expires !== 'number' || !Number.isFinite(credential.expires)) throw new Error(`Pi auth.json ${provider} credential is invalid`); return credential; }
export function isPiPlaceholder(entry: unknown): boolean { return !!entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as JsonObject).access === 'qlb-managed' && (entry as JsonObject).refresh === '' && (entry as JsonObject).type === 'oauth'; }

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function lockedError(): Error { return Object.assign(new Error('pi-auth-locked'), { code: 'pi-auth-locked', name: 'PiAuthLockedError' }); }
function defaultAuthLock<T>(authPath: string, fn: (refresh: () => void) => T, timing: AuthLockTiming = {}): T {
  const lock = `${authPath}.lock`; const staleMs = timing.staleMs ?? 10_000; const retries = timing.retries ?? 20; const retryMs = timing.retryMs ?? 250;
  let acquired = false;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try { mkdirSync(lock, { recursive: false, mode: 0o700 }); acquired = true; break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { recursive: true, force: true });
          try { mkdirSync(lock, { recursive: false, mode: 0o700 }); acquired = true; break; } catch { continue; }
        }
      } catch { continue; }
      if (attempt === retries) throw lockedError(); sleepSync(retryMs);
    }
  }
  if (!acquired) throw lockedError();
  const refresh = () => utimesSync(lock, new Date(), new Date());
  try { refresh(); return fn(refresh); } finally { rmSync(lock, { recursive: true, force: true }); }
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
  try { const top = String(execFileSync('git', ['-C', dirname(resolved), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); if (top) throw new Error(`refusing Pi migration write inside git work tree: ${resolved}`); } catch (error) { if (error instanceof Error && error.message.startsWith('refusing Pi migration')) throw error; }
}
function checkPaths(paths: PiMigratePaths, deps: PiMigrateDeps): void { for (const path of [paths.authJsonPath, paths.ownerPath]) { deps.checkWritablePath?.(path); assertOutsideGitWorktree(path, qlbHomeDir()); } }
function ownerFor(provider: PiSingleProvider, previous: JsonObject): JsonObject { return { providers: { ...(previous.providers as JsonObject), [provider]: { mode: 'qlb', since: Date.now() } } }; }
function baselineValue(provider: PiSingleProvider, auth: JsonObject, deps: PiMigrateDeps): unknown {
  if (provider !== 'openrouter') return auth[provider];
  if (!deps.readNativeOpenRouterKey) throw new Error('native OpenRouter reader is required');
  try { const key = deps.readNativeOpenRouterKey(); return key ? { type: 'api-key', access: key } : undefined; } catch (error) {
    if (isNativeOpenRouterKeyNotFound(error)) return undefined;
    throw error;
  }
}
function keychainPayload(provider: PiSingleProvider, baseline: unknown): string { if (provider === 'openrouter') { const value = asObject(baseline, 'openrouter credential is invalid'); if (typeof value.access !== 'string' || !value.access) throw new Error('openrouter credential is invalid'); return JSON.stringify({ type: 'api-key', access: value.access }); } return JSON.stringify(parseOAuth(baseline, provider)); }
function managedValue(provider: PiSingleProvider, deps: PiMigrateDeps): unknown | undefined { try { return JSON.parse(deps.keychain.getSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT)); } catch { return undefined; } }

/** P7a migration with S58's credential-first publication order. */
export function migratePiSingleProvider(provider: PiSingleProvider, paths: PiMigratePaths = defaultPiMigratePaths(), deps: PiMigrateDeps, options: { dryRun?: boolean } = {}): PiMigrateResult {
  assertPiSingleProvider(provider); const existing = readJournal(paths, provider); const wouldWrite = [managedService(provider), `placeholder:${provider}`, `owner:${provider}`];
  if (options.dryRun) return { provider, state: 'migrated', resumed: existing !== null, wouldWrite };
  checkPaths(paths, deps);
  const lock = deps.withAuthLock ?? ((path, fn) => defaultAuthLock(path, fn, deps.authLockTiming));
  let journal = existing ?? { provider, phase: 'started' as JournalPhase, ownerPid: process.pid, updatedAt: Date.now() }; let migrated = false; let notApplicable = false;
  lock(paths.authJsonPath, (refresh) => {
    if (!existing) updatePhase(paths, provider, 'started', refresh);
    const auth = readAuth(paths.authJsonPath); const currentOwner = readOwner(paths.ownerPath);
    if (!existing && (provider === 'openrouter' || isPiPlaceholder(auth[provider])) && (currentOwner.providers as JsonObject)[provider]) { migrated = true; return; }
    let baseline: unknown; const baselineFile = baselinePath(paths, provider);
    if (phaseAtLeast(journal.phase, 'baseline') && existsSync(baselineFile)) baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    else { baseline = baselineValue(provider, auth, deps); if (baseline === undefined) { notApplicable = true; return; } writeJson(baselineFile, baseline); updatePhase(paths, provider, 'baseline', refresh); journal = { ...journal, phase: 'baseline' }; deps.afterWrite?.('baseline'); }
    if (provider !== 'openrouter' && phaseAtLeast(journal.phase, 'published') && !isPiPlaceholder(auth[provider])) throw new Error(`Pi ${provider} entry changed after publication`);
    if (!phaseAtLeast(journal.phase, 'published')) {
      let source: unknown = provider === 'openrouter' ? baseline : (isPiPlaceholder(auth[provider]) || auth[provider] === undefined ? baseline : auth[provider]);
      if (provider !== 'openrouter' && source !== baseline) { try { keychainPayload(provider, source); } catch { source = baseline; } }
      // Validate before refreshing a pre-publication baseline: malformed or absent Pi data must never clobber it.
      const payload = keychainPayload(provider, source);
      if (provider !== 'openrouter' && source !== baseline) { writeJson(baselineFile, source); baseline = source; }
      refresh(); deps.keychain.setSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT, payload); refresh();
      const verified = deps.keychain.getSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT); if (verified !== payload) throw new Error('managed credential verification failed');
      if (!phaseAtLeast(journal.phase, 'credential-saved')) { updatePhase(paths, provider, 'credential-saved', refresh); journal = { ...journal, phase: 'credential-saved' }; deps.afterWrite?.('credential-saved'); }
      if (provider !== 'openrouter') { auth[provider] = piPlaceholder(); writeJson(paths.authJsonPath, auth); refresh(); deps.afterWrite?.('placeholder'); }
    }
    writeJson(paths.ownerPath, ownerFor(provider, currentOwner)); refresh(); deps.afterWrite?.('owner-entry'); updatePhase(paths, provider, 'published', refresh); journal = { ...journal, phase: 'published' }; migrated = true;
  });
  if (notApplicable) { deps.store?.setConfig(`pi.${provider}.state`, 'not-applicable'); updatePhase(paths, provider, 'committed'); rmSync(journalPath(paths, provider), { force: true }); return { provider, state: 'not-applicable', resumed: existing !== null, wouldWrite }; }
  if (!migrated) return { provider, state: 'not-applicable', resumed: existing !== null, wouldWrite };
  const managed = deps.keychain.getSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT); const parsed = JSON.parse(managed) as { refresh?: string; access?: string }; const lineage = fingerprint(typeof parsed.refresh === 'string' && parsed.refresh ? parsed.refresh : String(parsed.access ?? ''));
  deps.store?.upsertAccount(`${provider}-default`, provider, provider, 'active'); deps.store?.recordLineage({ provider, accountId: 'default', toFp: lineage, cause: 'import', by: 'qlb-cli', evidence: 'import' }); deps.store?.setConfig(`single.${provider}.activeId`, 'default'); deps.store?.setConfig(`pi.${provider}.state`, 'migrated'); deps.store?.setConfig(`pi.${provider}.migratedAt`, String(Date.now())); deps.afterWrite?.('before-committed'); updatePhase(paths, provider, 'committed'); rmSync(journalPath(paths, provider), { force: true }); return { provider, state: 'migrated', resumed: existing !== null, wouldWrite };
}

/** S49 rollback for P7a's xai/kimi/openrouter subset. */
export function rollbackPiSingleProvider(provider: PiSingleProvider, paths: PiMigratePaths = defaultPiMigratePaths(), deps: PiMigrateDeps): PiMigrateResult {
  assertPiSingleProvider(provider); checkPaths(paths, deps);
  const lock = deps.withAuthLock ?? ((path, fn) => defaultAuthLock(path, fn, deps.authLockTiming));
  lock(paths.authJsonPath, (refresh) => {
    const owner = readOwner(paths.ownerPath); const providers = { ...(owner.providers as JsonObject) }; delete providers[provider]; writeJson(paths.ownerPath, { providers }); refresh(); deps.afterWrite?.('owner-entry'); // S49 first, within the same lock.
    const baselineFile = baselinePath(paths, provider); const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : undefined;
    const journal = readJournal(paths, provider); const managed = provider === 'openrouter' ? undefined : managedValue(provider, deps);
    if (provider !== 'openrouter') {
      const auth = readAuth(paths.authJsonPath); const current = auth[provider];
      // Never replace a credential Pi has freshly acquired after the migration.
      if ((current === undefined || isPiPlaceholder(current)) && (baseline !== undefined || managed !== undefined)) {
        const saved = (journal && phaseAtLeast(journal.phase, 'credential-saved')) || (isPiPlaceholder(current) && managed !== undefined);
        auth[provider] = saved && managed !== undefined ? managed : baseline;
        writeJson(paths.authJsonPath, auth); refresh();
      }
    }
    try { refresh(); deps.keychain.deleteSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT); } catch { /* absent is already rolled back */ }
  });
  deps.store?.setConfig(`pi.${provider}.state`, ''); deps.store?.setConfig(`pi.${provider}.migratedAt`, ''); rmSync(journalPath(paths, provider), { force: true }); return { provider, state: 'migrated', resumed: false, wouldWrite: [] };
}
