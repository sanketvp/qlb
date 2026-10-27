// Durable unclaimed-successor storage for the single-account OAuth providers.
// Credential bytes are stored only in the injected Keychain or a private file.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { isCredentialNotFound } from './credential-backends';
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
}

function stashRoot(deps: Pick<SingleStashDeps, 'home' | 'env'>): string {
  return join(deps.home ?? qlbHomeDir(deps.env ?? process.env), '.qlb', 'unclaimed');
}

function stashService(provider: SingleStashProvider, stashId: string): string {
  return qlbKeychainService(provider, `unclaimed:${stashId}`);
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

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Publish a fully fsynced fallback with link(2), never replacing a contender's body. */
async function writeStashFile(root: string, stashId: string, record: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const path = join(root, `${stashId}.json`);
  const temporary = join(root, `.${stashId}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(record, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await fsyncDirectory(root);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Reserve a discoverable non-secret row before persisting a successor. A failed
 * Keychain write falls back to a create-only private file. If neither body can
 * be written, the reservation remains so a later pass can prove it absent.
 */
export async function persistStash(
  provider: SingleStashProvider,
  credential: OAuthCredential,
  consumedFp: string,
  keychain: SingleStashKeychain,
  deps: Pick<SingleStashDeps, 'home' | 'env' | 'now'>,
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
      await writeStashFile(root, stashId, record);
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

function parseStash(text: string, currentFp: string): OAuthCredential | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { credential?: unknown; consumedFp?: unknown };
  if (typeof record.consumedFp !== 'string' || record.consumedFp !== currentFp) return null;
  return parseCredential(record.credential);
}

type ReadLocation = 'keychain' | 'file';

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
    await rm(join(root, `${entry.stashId}.json`));
  }
  await removeStash(root, entry);
}

function notNewer(successor: OAuthCredential, current: OAuthCredential): boolean {
  return successor.expires != null && current.expires != null && successor.expires <= current.expires;
}

/**
 * Adopt a matching successor before another refresh POST. Reads intentionally
 * probe Keychain first regardless of the index hint, then remove only the body
 * that was actually read. An ambiguous Keychain failure is fail-closed.
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
  for (const entry of entries) {
    if (entry.consumedFp !== currentFp) continue;

    let text: string | undefined;
    let readFrom: ReadLocation | undefined;
    let keychainError: unknown;
    try {
      text = keychain.getSync(stashService(provider, entry.stashId), QLB_KEYCHAIN_ACCOUNT);
      readFrom = 'keychain';
    } catch (error) {
      keychainError = error;
    }
    if (text === undefined) {
      try {
        text = await readFile(join(root, `${entry.stashId}.json`), 'utf8');
        readFrom = 'file';
      } catch (fileError) {
        if (isCredentialNotFound(keychainError) && isMissingFile(fileError)) {
          try {
            await removeStash(root, entry);
          } catch {
            throw new SingleStashFailure('stash-unreadable');
          }
          warn(deps, `stash-lost ${entry.stashId} credential-and-file-not-found`);
          continue;
        }
        throw new SingleStashFailure('stash-unreadable');
      }
    }

    const successor = parseStash(text, currentFp);
    if (!successor || !readFrom) throw new SingleStashFailure('stash-unreadable');
    if (notNewer(successor, current)) {
      try {
        await cleanupReadBody(provider, entry, readFrom, keychain, root);
        warn(deps, `stash-obsolete ${entry.stashId} not-newer-than-primary`);
      } catch {
        warn(deps, `stash-cleanup-pending ${entry.stashId}`);
      }
      continue;
    }

    try {
      keychain.setSync(primaryService(provider), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(successor));
    } catch {
      throw new SingleStashFailure('stash-unreadable');
    }
    try {
      await cleanupReadBody(provider, entry, readFrom, keychain, root);
    } catch {
      // The primary is durable. Retaining the body is safe and the next pass
      // will clean it instead of re-installing an older successor.
      warn(deps, `stash-cleanup-pending ${entry.stashId}`);
    }
    return successor;
  }
  return null;
}
