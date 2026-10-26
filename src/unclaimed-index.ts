// Durable, non-secret discovery index for unclaimed credential stashes.
// The credential bytes remain in the Keychain or the S36 fallback file.

import { chmod, link, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface UnclaimedIndexEntry {
  provider: string;
  /** null means a legacy file with no known account; it may match any account by lineage. */
  accountId: string | null;
  stashId: string;
  consumedFp: string;
  location: 'keychain' | 'file';
  createdAt: number;
}

export class InvalidUnclaimedIndexComponentError extends Error {
  constructor(name: string) {
    super(`invalid unclaimed index ${name}`);
    this.name = 'InvalidUnclaimedIndexComponentError';
  }
}

function assertComponent(value: string, name: string): void {
  if (!value || /[\x00-\x1F\x7F\\/:*?"<>|]|[. ]$/.test(value)) {
    throw new InvalidUnclaimedIndexComponentError(name);
  }
}

function indexDir(root: string, provider: string): string {
  assertComponent(provider, 'provider');
  return join(root, 'index', provider);
}

function indexPath(root: string, entry: UnclaimedIndexEntry): string {
  assertComponent(entry.stashId, 'stash id');
  return join(indexDir(root, entry.provider), `${entry.stashId}.json`);
}

function parseEntry(text: string): UnclaimedIndexEntry {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('unclaimed index entry is malformed'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('unclaimed index entry is malformed');
  const entry = value as Record<string, unknown>;
  if (typeof entry.provider !== 'string' || (entry.accountId !== null && typeof entry.accountId !== 'string') ||
    typeof entry.stashId !== 'string' || typeof entry.consumedFp !== 'string' ||
    (entry.location !== 'keychain' && entry.location !== 'file') ||
    typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)) {
    throw new Error('unclaimed index entry is malformed');
  }
  try {
    assertComponent(entry.provider, 'provider');
    assertComponent(entry.stashId, 'stash id');
  } catch {
    throw new Error('unclaimed index entry is malformed');
  }
  return {
    provider: entry.provider, accountId: entry.accountId, stashId: entry.stashId,
    consumedFp: entry.consumedFp, location: entry.location, createdAt: entry.createdAt,
  };
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export interface UnclaimedIndexWriteOptions {
  replace?: boolean;
  /** Injectable for Windows behavior tests; defaults to the host platform. */
  platform?: NodeJS.Platform;
  /** Injectable directory sync for tests; failures are preserved off Windows. */
  directorySync?: (path: string) => Promise<void>;
}

async function fsyncDirectory(path: string, options: UnclaimedIndexWriteOptions): Promise<void> {
  // Node cannot fsync a directory handle on Windows. Its durability contract
  // is unavailable there, while other platforms must still surface failures.
  if ((options.platform ?? process.platform) === 'win32') return;
  if (options.directorySync) return options.directorySync(path);
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Atomically write a non-secret index row. Initial creation uses link(2) so a
 * contender cannot overwrite another process's stash reservation; updates use
 * rename only after the original row has reserved that stash id.
 */
async function writeEntry(path: string, contents: string, options: UnclaimedIndexWriteOptions): Promise<void> {
  const dir = join(path, '..');
  await privateDirectory(dir);
  const temporary = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (options.replace) await rename(temporary, path);
    else await link(temporary, path);
    await chmod(path, 0o600);
    await fsyncDirectory(dir, options);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Reserve and durably record a stash before storing its secret bytes. Passing
 * `replace: true` is only for changing a previously reserved row from the
 * intended Keychain location to its S36 file fallback.
 */
export async function recordStash(
  root: string,
  entry: UnclaimedIndexEntry,
  options: UnclaimedIndexWriteOptions = {},
): Promise<string> {
  assertComponent(entry.provider, 'provider');
  assertComponent(entry.stashId, 'stash id');
  const path = indexPath(root, entry);
  await writeEntry(path, `${JSON.stringify(entry)}\n`, options);
  return path;
}

/** List only non-secret rows for one provider, optionally scoped to one account. */
export async function listStashes(root: string, provider: string, accountId?: string): Promise<UnclaimedIndexEntry[]> {
  const dir = indexDir(root, provider);
  let names: string[];
  try { names = await readdir(dir); } catch (error: unknown) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('unclaimed index unavailable');
  }
  const entries: UnclaimedIndexEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let text: string;
    try {
      const handle = await open(join(dir, name), 'r');
      try { text = await handle.readFile({ encoding: 'utf8' }); } finally { await handle.close(); }
    } catch { throw new Error('unclaimed index unavailable'); }
    const entry = parseEntry(text);
    if (entry.provider !== provider) throw new Error('unclaimed index entry is malformed');
    if (accountId == null || entry.accountId === null || entry.accountId === accountId) entries.push(entry);
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt || a.stashId.localeCompare(b.stashId));
}

/** Remove a stash reservation only after its credential bytes have been removed. */
export async function removeStash(
  root: string,
  entry: Pick<UnclaimedIndexEntry, 'provider' | 'stashId'>,
  options: UnclaimedIndexWriteOptions = {},
): Promise<void> {
  const path = indexPath(root, entry as UnclaimedIndexEntry);
  try {
    await rm(path);
    await fsyncDirectory(indexDir(root, entry.provider), options);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('unable to remove unclaimed index entry');
  }
}
