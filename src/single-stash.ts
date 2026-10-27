// Durable unclaimed-successor storage for the single-account OAuth providers.
// Credential bytes are stored only in the injected Keychain or a private file.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { isCredentialNotFound } from './credential-backends';
import { fsyncDirSync, isUnsupportedDirectoryFsync } from './fsutil';
import { qlbHomeDir } from './home';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from './keychain';
import {
  listStashes,
  recordStash,
  removeStash,
  updateStash,
  type UnclaimedIndexEntry,
} from './unclaimed-index';

export type SingleStashProvider = 'xai' | 'kimi-coding';

/** The refresh modules supply known expiries; a recovered legacy stash may not. */
export interface OAuthCredential {
  type?: string;
  access: string;
  refresh: string;
  expires?: number;
}

/** Typed failures contain no credential bytes. */
export class SingleStashFailure extends Error {
  constructor(readonly code: 'stash-unreadable' | 'successor-unpersisted') {
    super(code);
    this.name = 'SingleStashFailure';
  }
}

/** All three synchronous operations are required so cleanup follows the read location. */
export type SingleStashKeychain = Pick<KeychainBackend, 'getSync' | 'setSync' | 'deleteSync'>;

export interface SingleStashDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Receives only non-secret stash identifiers and fixed reason text. */
  warn?: (message: string) => void;
  /** Injectable directory durability sync for tests. */
  directorySync?: (path: string) => Promise<void> | void;
}

/** Resolve QLB state from the process environment, never a caller's provider environment. */
export function resolveQlbHome(home?: string): string {
  const resolvedHome = home ?? qlbHomeDir();
  if (process.env.NODE_TEST_CONTEXT !== undefined && resolvedHome === qlbHomeDir({})) {
    throw new Error('an explicit home is required under node:test when QLB_HOME is unset');
  }
  return resolvedHome;
}

function stashRoot(deps: Pick<SingleStashDeps, 'home'>): string {
  return join(resolveQlbHome(deps.home), '.qlb', 'unclaimed');
}

function stashService(provider: SingleStashProvider, stashId: string): string {
  return qlbKeychainService(provider, `unclaimed:${stashId}`);
}

function stashFileDirectory(root: string, provider: SingleStashProvider): string {
  return join(root, provider);
}

function stashFilePath(root: string, provider: SingleStashProvider, stashId: string): string {
  return join(stashFileDirectory(root, provider), `${stashId}.json`);
}

function primaryService(provider: SingleStashProvider): string {
  return qlbKeychainService(provider, 'default');
}

function newStashId(now: number): string {
  return `${now}-${process.pid}-${randomBytes(12).toString('hex')}`;
}

/** Refresh-token identity is adoption lineage only, never a byte-level CAS. */
export function credentialLineage(credential: Pick<OAuthCredential, 'access' | 'refresh'>): string {
  return `sha256:${createHash('sha256').update(credential.refresh || credential.access, 'utf8').digest('hex')}`;
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function warn(deps: Pick<SingleStashDeps, 'warn'>, message: string): void {
  try { deps.warn?.(message); } catch { /* Diagnostics cannot affect credential safety. */ }
}

async function fsyncDirectory(
  path: string,
  directorySync?: (path: string) => Promise<void> | void,
): Promise<void> {
  try {
    if (directorySync) await directorySync(path);
    else fsyncDirSync(path);
  } catch (error) {
    if (!isUnsupportedDirectoryFsync(error)) throw error;
  }
}

/** Create the provider directory before publishing body files beneath it. */
async function ensureStashFileDirectory(
  root: string,
  provider: SingleStashProvider,
  directorySync?: (path: string) => Promise<void> | void,
): Promise<string> {
  const directory = stashFileDirectory(root, provider);
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // recordStash creates root before this point. Persist its new child entry too.
  if (created !== undefined) await fsyncDirectory(root, directorySync);
  return directory;
}

/** Publish a fully fsynced fallback with link(2), never replacing a contender's body. */
async function writeStashFile(
  root: string,
  provider: SingleStashProvider,
  stashId: string,
  record: string,
  directorySync?: (path: string) => Promise<void> | void,
): Promise<void> {
  const directory = await ensureStashFileDirectory(root, provider, directorySync);
  const path = stashFilePath(root, provider, stashId);
  const temporary = join(directory, `.${stashId}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(record, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await fsyncDirectory(directory, directorySync);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Reserve a discoverable non-secret row before persisting a successor. A failed
 * Keychain write falls back to a create-only private file. If neither body can
 * be written, the reservation remains so a later pass can prove it absent.
 *
 * The caller must hold this provider's consume lock. P13-2 owns that lock, so
 * adoption cannot remove this reservation while its body is being written.
 */
export async function persistStash(
  provider: SingleStashProvider,
  credential: OAuthCredential,
  consumedFp: string,
  keychain: SingleStashKeychain,
  deps: Pick<SingleStashDeps, 'home' | 'env' | 'now' | 'directorySync'>,
): Promise<void> {
  const root = stashRoot(deps);
  const now = deps.now ?? Date.now;
  const record = JSON.stringify({ credential, consumedFp });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stashId = newStashId(now());
    const entry: UnclaimedIndexEntry = {
      provider, accountId: 'default', stashId, consumedFp, location: 'keychain', createdAt: now(),
    };
    try {
      await recordStash(root, entry);
    } catch (error: unknown) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      break;
    }

    try {
      keychain.setSync(stashService(provider, stashId), QLB_KEYCHAIN_ACCOUNT, record);
      return;
    } catch {
      // The Keychain may be locked or unavailable; its error is deliberately not exposed.
    }

    try {
      await writeStashFile(root, provider, stashId, record, deps.directorySync);
    } catch {
      // Keep this non-secret reservation for the both-absent recovery rule.
      break;
    }
    // The body is already durable. A stale keychain location still discovers
    // the file because adoption always probes Keychain then fallback.
    try { await updateStash(root, { ...entry, location: 'file' }); } catch { /* self-heals */ }
    return;
  }
  throw new SingleStashFailure('successor-unpersisted');
}

function parseCredential(value: unknown): OAuthCredential | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const credential = value as Record<string, unknown>;
  if (typeof credential.access !== 'string' || !credential.access ||
    typeof credential.refresh !== 'string' || !credential.refresh ||
    (credential.expires !== undefined && (typeof credential.expires !== 'number' || !Number.isFinite(credential.expires)))) {
    return null;
  }
  return credential as unknown as OAuthCredential;
}

interface ParsedStash {
  credential: OAuthCredential;
  consumedFp: string;
}

function parseStash(text: string): ParsedStash | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { credential?: unknown; consumedFp?: unknown };
  if (typeof record.consumedFp !== 'string') return null;
  const credential = parseCredential(record.credential);
  return credential ? { credential, consumedFp: record.consumedFp } : null;
}

type ReadLocation = 'keychain' | 'file';
type StashBodyRead = { text: string; readFrom: ReadLocation } | 'absent' | 'unreadable';

async function readStashBody(
  provider: SingleStashProvider,
  entry: UnclaimedIndexEntry,
  keychain: SingleStashKeychain,
  root: string,
): Promise<StashBodyRead> {
  let keychainError: unknown;
  try {
    return { text: keychain.getSync(stashService(provider, entry.stashId), QLB_KEYCHAIN_ACCOUNT), readFrom: 'keychain' };
  } catch (error) {
    keychainError = error;
  }
  try {
    return { text: await readFile(stashFilePath(root, provider, entry.stashId), 'utf8'), readFrom: 'file' };
  } catch (fileError) {
    return isCredentialNotFound(keychainError) && isMissingFile(fileError) ? 'absent' : 'unreadable';
  }
}

async function cleanupReadBody(
  provider: SingleStashProvider,
  entry: UnclaimedIndexEntry,
  readFrom: ReadLocation,
  keychain: SingleStashKeychain,
  root: string,
): Promise<void> {
  if (readFrom === 'keychain') {
    keychain.deleteSync(stashService(provider, entry.stashId), QLB_KEYCHAIN_ACCOUNT);
  } else {
    await rm(stashFilePath(root, provider, entry.stashId));
  }
  await removeStash(root, entry);
}

function notNewer(successor: OAuthCredential, current: OAuthCredential): boolean {
  return successor.expires != null && current.expires != null && successor.expires <= current.expires;
}

/**
 * Adopt a matching successor before another refresh POST. Reads intentionally
 * probe Keychain first regardless of the index hint, then remove only the body
 * that was actually read. An ambiguous Keychain failure is fail-closed. The
 * caller must hold this provider's consume lock; P13-2 takes that lock.
 */
export async function adoptStashedSuccessor(
  provider: SingleStashProvider,
  current: OAuthCredential,
  keychain: SingleStashKeychain,
  deps: Pick<SingleStashDeps, 'home' | 'env' | 'warn'>,
): Promise<OAuthCredential | null> {
  const root = stashRoot(deps);
  let entries: UnclaimedIndexEntry[];
  try {
    entries = await listStashes(root, provider, 'default');
  } catch {
    throw new SingleStashFailure('stash-unreadable');
  }

  const currentFp = credentialLineage(current);
  let installed = current;
  let adopted: OAuthCredential | null = null;
  for (const entry of entries) {
    const matching = entry.consumedFp === currentFp;
    const body = await readStashBody(provider, entry, keychain, root);
    if (body === 'absent') {
      try {
        await removeStash(root, entry);
      } catch {
        if (matching && !adopted) throw new SingleStashFailure('stash-unreadable');
        warn(deps, 'stash-unreadable');
        continue;
      }
      warn(deps, `stash-lost ${entry.stashId} credential-and-file-not-found`);
      continue;
    }
    if (body === 'unreadable') {
      if (matching && !adopted) throw new SingleStashFailure('stash-unreadable');
      warn(deps, 'stash-unreadable');
      continue;
    }

    const record = parseStash(body.text);
    if (!record) {
      if (matching && !adopted) throw new SingleStashFailure('stash-unreadable');
      warn(deps, 'stash-unreadable');
      continue;
    }
    if (matching && record.consumedFp !== currentFp) {
      if (!adopted) throw new SingleStashFailure('stash-unreadable');
      warn(deps, 'stash-unreadable');
      continue;
    }
    if (notNewer(record.credential, installed)) {
      try {
        await cleanupReadBody(provider, entry, body.readFrom, keychain, root);
        warn(deps, `stash-obsolete ${entry.stashId} not-newer-than-primary`);
      } catch {
        warn(deps, 'stash-cleanup-pending');
      }
      continue;
    }
    if (!matching || adopted) continue;

    try {
      keychain.setSync(primaryService(provider), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(record.credential));
    } catch {
      throw new SingleStashFailure('stash-unreadable');
    }
    installed = record.credential;
    adopted = record.credential;
    try {
      await cleanupReadBody(provider, entry, body.readFrom, keychain, root);
    } catch {
      // The primary is durable. Every later pass evaluates every row against
      // the installed primary, so a retained body is removed, never reinstalled.
      warn(deps, `stash-cleanup-pending ${entry.stashId}`);
    }
  }
  return adopted;
}
