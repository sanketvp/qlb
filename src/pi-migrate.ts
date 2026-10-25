// Pi single-provider credential migration (S28, S49, S58, S63).
//
// This P7a implementation deliberately keeps its journal metadata value-free:
// credential bytes live only in the Keychain and the 0600 baseline file.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { atomicWriteText } from './fsutil';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from './keychain';
import { qlbHomeDir } from './home';
import type { Store } from './store';

export const PI_SINGLE_PROVIDERS = ['xai', 'kimi-coding', 'openrouter'] as const;
export type PiSingleProvider = (typeof PI_SINGLE_PROVIDERS)[number];
type OAuthProvider = Exclude<PiSingleProvider, 'openrouter'>;
type JournalPhase = 'started' | 'baseline' | 'credential-saved' | 'published' | 'committed';
type CrashPoint = 'baseline' | 'credential-saved' | 'placeholder' | 'owner-entry' | 'before-committed';

export interface PiMigratePaths {
  authJsonPath: string;
  ownerPath: string;
  journalPath: string;
  baselineDir: string;
}

export interface PiMigrateDeps {
  keychain: Pick<KeychainBackend, 'getSync' | 'setSync' | 'deleteSync'>;
  store?: Pick<Store, 'setConfig' | 'recordLineage' | 'upsertAccount'>;
  readNativeOpenRouterKey?: () => string;
  withAuthLock?: <T>(path: string, fn: () => T) => T;
  afterWrite?: (point: CrashPoint) => void;
  checkWritablePath?: (path: string) => void;
}

export interface PiMigrateResult {
  provider: PiSingleProvider;
  state: 'migrated' | 'not-applicable';
  resumed: boolean;
  wouldWrite: string[];
}

interface Journal {
  provider: PiSingleProvider;
  phase: JournalPhase;
  ownerPid: number;
  updatedAt: number;
}

type JsonObject = Record<string, unknown>;

function isProvider(value: string): value is PiSingleProvider {
  return (PI_SINGLE_PROVIDERS as readonly string[]).includes(value);
}

export function assertPiSingleProvider(value: string): asserts value is PiSingleProvider {
  if (!isProvider(value)) throw new Error('provider must be xai, kimi-coding, or openrouter');
}

export function defaultPiMigratePaths(home: string = qlbHomeDir()): PiMigratePaths {
  const agent = join(home, '.pi', 'agent');
  return {
    authJsonPath: join(agent, 'auth.json'),
    ownerPath: join(agent, 'qlb-owner.json'),
    journalPath: join(home, '.qlb', 'journal'),
    baselineDir: join(home, '.qlb', 'backups', 'pi-auth'),
  };
}

export function piPlaceholder(now = Date.now()): JsonObject {
  return { type: 'oauth', access: 'qlb-managed', refresh: '', expires: now + 10 * 365 * 24 * 60 * 60 * 1000 };
}

function asObject(value: unknown, message: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as JsonObject;
}

function readAuth(path: string): JsonObject {
  if (!existsSync(path)) return {};
  return asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi auth.json is not an object');
}

function readOwner(path: string): JsonObject {
  if (!existsSync(path)) return { providers: {} };
  const owner = asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi owner file is not an object');
  const providers = owner.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) throw new Error('Pi owner file is malformed');
  return owner;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeJournal(path: string, journal: Journal): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteText(path, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
}

function journalPath(paths: PiMigratePaths, provider: PiSingleProvider): string {
  return join(paths.journalPath, `pi-migrate-${provider}.json`);
}

function baselinePath(paths: PiMigratePaths, provider: PiSingleProvider): string {
  return join(paths.baselineDir, `${provider}.json`);
}

function readJournal(paths: PiMigratePaths, provider: PiSingleProvider): Journal | null {
  const path = journalPath(paths, provider);
  if (!existsSync(path)) return null;
  const parsed = asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi migration journal is malformed');
  if (parsed.provider !== provider || typeof parsed.phase !== 'string') throw new Error('Pi migration journal is malformed');
  const phases: JournalPhase[] = ['started', 'baseline', 'credential-saved', 'published', 'committed'];
  if (!phases.includes(parsed.phase as JournalPhase)) throw new Error('Pi migration journal has an unknown phase');
  return { provider, phase: parsed.phase as JournalPhase, ownerPid: Number(parsed.ownerPid) || 0, updatedAt: Number(parsed.updatedAt) || 0 };
}

function phaseAtLeast(actual: JournalPhase, expected: JournalPhase): boolean {
  return ['started', 'baseline', 'credential-saved', 'published', 'committed'].indexOf(actual)
    >= ['started', 'baseline', 'credential-saved', 'published', 'committed'].indexOf(expected);
}

function updatePhase(paths: PiMigratePaths, provider: PiSingleProvider, phase: JournalPhase): void {
  writeJournal(journalPath(paths, provider), { provider, phase, ownerPid: process.pid, updatedAt: Date.now() });
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function managedService(provider: PiSingleProvider): string {
  return qlbKeychainService(provider, 'default');
}

function parseOAuth(entry: unknown, provider: OAuthProvider): JsonObject {
  const credential = asObject(entry, `Pi auth.json has no ${provider} credential`);
  if (typeof credential.access !== 'string' || credential.access.length === 0 || typeof credential.refresh !== 'string' || credential.refresh.length === 0) {
    throw new Error(`Pi auth.json ${provider} credential is invalid`);
  }
  if (typeof credential.expires !== 'number' || !Number.isFinite(credential.expires)) {
    throw new Error(`Pi auth.json ${provider} credential is invalid`);
  }
  return credential;
}

function isPlaceholder(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const candidate = entry as JsonObject;
  return candidate.access === 'qlb-managed' && candidate.refresh === '' && candidate.type === 'oauth';
}

function defaultAuthLock<T>(authPath: string, fn: () => T): T {
  const lock = `${authPath}.lock`;
  try {
    mkdirSync(lock, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('pi-auth-locked');
    throw error;
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function assertOutsideGitWorktree(path: string, qlbHome: string): void {
  const resolved = resolve(path);
  const qlb = resolve(qlbHome);
  if (resolved === qlb || resolved.startsWith(`${qlb}/`)) return;
  try {
    const top = String(execFileSync('git', ['-C', dirname(resolved), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    if (top) throw new Error(`refusing Pi migration write inside git work tree: ${resolved}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('refusing Pi migration')) throw error;
  }
}

function ownerFor(provider: PiSingleProvider, previous: JsonObject): JsonObject {
  const providers = { ...(previous.providers as JsonObject), [provider]: { mode: 'qlb', since: Date.now() } };
  return { providers };
}

function baselineValue(provider: PiSingleProvider, auth: JsonObject, deps: PiMigrateDeps): unknown {
  if (provider === 'openrouter') {
    const key = deps.readNativeOpenRouterKey?.();
    if (!key) throw new Error('no-pi-credential');
    return { type: 'api-key', access: key };
  }
  return auth[provider];
}

function keychainPayload(provider: PiSingleProvider, baseline: unknown): string {
  if (provider === 'openrouter') {
    const value = asObject(baseline, 'openrouter credential is invalid');
    if (typeof value.access !== 'string' || value.access.length === 0) throw new Error('openrouter credential is invalid');
    return JSON.stringify({ type: 'api-key', access: value.access });
  }
  return JSON.stringify(parseOAuth(baseline, provider));
}

function currentValueForRollback(provider: PiSingleProvider, deps: PiMigrateDeps, fallback: unknown): unknown {
  try {
    const managed = deps.keychain.getSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT);
    return JSON.parse(managed);
  } catch {
    return fallback;
  }
}

/**
 * P7a migration. The initial red-first implementation intentionally publishes
 * the placeholder before saving the managed copy; commit two reverses those
 * two writes to establish S58's credential-first invariant.
 */
export function migratePiSingleProvider(
  provider: PiSingleProvider,
  paths: PiMigratePaths = defaultPiMigratePaths(),
  deps: PiMigrateDeps,
  options: { dryRun?: boolean } = {},
): PiMigrateResult {
  assertPiSingleProvider(provider);
  const existing = readJournal(paths, provider);
  const wouldWrite = [managedService(provider), `placeholder:${provider}`, `owner:${provider}`];
  if (options.dryRun) return { provider, state: 'migrated', resumed: existing !== null, wouldWrite };

  for (const path of [paths.authJsonPath, paths.ownerPath]) {
    deps.checkWritablePath?.(path);
    assertOutsideGitWorktree(path, qlbHomeDir());
  }

  const lock = deps.withAuthLock ?? defaultAuthLock;
  let journal = existing ?? { provider, phase: 'started' as JournalPhase, ownerPid: process.pid, updatedAt: Date.now() };
  if (!existing) updatePhase(paths, provider, 'started');
  let migrated = false;

  lock(paths.authJsonPath, () => {
    const auth = readAuth(paths.authJsonPath);
    let baseline: unknown;
    const baselineFile = baselinePath(paths, provider);
    if (phaseAtLeast(journal.phase, 'baseline') && existsSync(baselineFile)) {
      baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    } else {
      baseline = baselineValue(provider, auth, deps);
      if (baseline === undefined) {
        updatePhase(paths, provider, 'committed');
        deps.store?.setConfig(`pi.${provider}.state`, 'not-applicable');
        return;
      }
      writeJson(baselineFile, baseline);
      updatePhase(paths, provider, 'baseline');
      journal = { ...journal, phase: 'baseline' };
      deps.afterWrite?.('baseline');
    }

    if (provider !== 'openrouter' && phaseAtLeast(journal.phase, 'published') && !isPlaceholder(auth[provider])) {
      throw new Error(`Pi ${provider} entry changed after publication`);
    }

    // REV4 ORDER (red-first): publishing this marker before Keychain save is
    // intentionally unsafe and the barrier test below proves it.
    if (provider !== 'openrouter' && !phaseAtLeast(journal.phase, 'published')) {
      auth[provider] = piPlaceholder();
      writeJson(paths.authJsonPath, auth);
      deps.afterWrite?.('placeholder');
    }

    if (!phaseAtLeast(journal.phase, 'credential-saved')) {
      const source = provider === 'openrouter' ? baseline : auth[provider] && !isPlaceholder(auth[provider]) ? auth[provider] : baseline;
      const payload = keychainPayload(provider, source);
      deps.keychain.setSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT, payload);
      const verified = deps.keychain.getSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT);
      if (verified !== payload) throw new Error('managed credential verification failed');
      updatePhase(paths, provider, 'credential-saved');
      journal = { ...journal, phase: 'credential-saved' };
      deps.afterWrite?.('credential-saved');
    }

    const owner = ownerFor(provider, readOwner(paths.ownerPath));
    writeJson(paths.ownerPath, owner);
    deps.afterWrite?.('owner-entry');
    updatePhase(paths, provider, 'published');
    journal = { ...journal, phase: 'published' };
    migrated = true;
  });

  if (!migrated) return { provider, state: 'not-applicable', resumed: existing !== null, wouldWrite };
  const managed = deps.keychain.getSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT);
  const parsed = JSON.parse(managed) as { refresh?: string; access?: string };
  const lineage = fingerprint(typeof parsed.refresh === 'string' && parsed.refresh ? parsed.refresh : String(parsed.access ?? ''));
  deps.store?.upsertAccount(`${provider}-default`, provider, provider, 'active');
  deps.store?.recordLineage({ provider, accountId: 'default', toFp: lineage, cause: 'import', by: 'qlb-cli', evidence: 'import' });
  deps.store?.setConfig(`single.${provider}.activeId`, 'default');
  deps.store?.setConfig(`pi.${provider}.state`, 'migrated');
  deps.store?.setConfig(`pi.${provider}.migratedAt`, String(Date.now()));
  deps.afterWrite?.('before-committed');
  updatePhase(paths, provider, 'committed');
  rmSync(journalPath(paths, provider), { force: true });
  return { provider, state: 'migrated', resumed: existing !== null, wouldWrite };
}

/** S49 rollback for P7a's xai/kimi/openrouter subset. */
export function rollbackPiSingleProvider(
  provider: PiSingleProvider,
  paths: PiMigratePaths = defaultPiMigratePaths(),
  deps: PiMigrateDeps,
): PiMigrateResult {
  assertPiSingleProvider(provider);
  const baselineFile = baselinePath(paths, provider);
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : undefined;
  const owner = readOwner(paths.ownerPath);
  const providers = { ...(owner.providers as JsonObject) };
  delete providers[provider];
  writeJson(paths.ownerPath, { providers }); // S49: remove ownership before native restore.

  const lock = deps.withAuthLock ?? defaultAuthLock;
  lock(paths.authJsonPath, () => {
    if (provider !== 'openrouter') {
      if (baseline === undefined) return;
      const auth = readAuth(paths.authJsonPath);
      auth[provider] = currentValueForRollback(provider, deps, baseline);
      writeJson(paths.authJsonPath, auth);
    }
  });
  if (provider === 'openrouter') {
    try { deps.keychain.deleteSync(managedService(provider), QLB_KEYCHAIN_ACCOUNT); } catch { /* absent is already rolled back */ }
  }
  deps.store?.setConfig(`pi.${provider}.state`, '');
  deps.store?.setConfig(`pi.${provider}.migratedAt`, '');
  rmSync(journalPath(paths, provider), { force: true });
  return { provider, state: 'migrated', resumed: false, wouldWrite: [] };
}
