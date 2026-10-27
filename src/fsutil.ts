/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/fsutil.py:106-131,134-246.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
const TEMP_PREFIX_CHARS = 40;
const MAX_SYMLINKS = 40;
// This exactly mirrors createTemp(): a basename prefix (at most 40 code units),
// then the decimal owner PID and a 16-character lowercase-hex random suffix.
const STRAY_TEMP = /^\.qlb-([\s\S]{0,40})\.([1-9]\d*)\.([a-f0-9]{16})\.tmp$/;
// QLB addition: retain recent temps so a concurrent writer can finish.
const STRAY_TEMP_MIN_AGE_MS = 60_000;

export type AtomicWriteOptions = {
  mode?: number;
  followSymlinks?: boolean;
};

function errno(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function eloop(path: string): NodeJS.ErrnoException {
  const error = new Error(`too many symbolic links resolving '${path}'`) as NodeJS.ErrnoException;
  error.code = 'ELOOP';
  return error;
}

function splitPath(path: string): string[] {
  return path.split(sep).filter(Boolean);
}

/**
 * Resolve a symlink chain while allowing only its final referent to be absent.
 * Node's realpath is used for the ordinary case; this fallback preserves the
 * upstream ALLOW_MISSING behavior for a dangling final link.
 */
function resolveAllowMissing(path: string): string {
  const absolute = resolve(path);
  let resolved = parse(absolute).root;
  let pending = splitPath(absolute.slice(resolved.length));
  let links = 0;

  while (pending.length > 0) {
    const segment = pending.shift()!;
    if (segment === '.') continue;
    if (segment === '..') {
      resolved = dirname(resolved);
      continue;
    }

    const candidate = join(resolved, segment);
    let entry;
    try {
      entry = lstatSync(candidate);
    } catch (error) {
      if (errno(error) === 'ENOENT') return join(candidate, ...pending);
      throw error;
    }

    if (!entry.isSymbolicLink()) {
      resolved = candidate;
      continue;
    }

    if (++links > MAX_SYMLINKS) throw eloop(path);
    const target = readlinkSync(candidate);
    if (isAbsolute(target)) {
      resolved = parse(target).root;
      pending = [...splitPath(target.slice(resolved.length)), ...pending];
    } else {
      pending = [...splitPath(target), ...pending];
    }
  }

  return resolved;
}

/**
 * Return the actual destination for a publish. A symlink is written through,
 * not replaced, because rename replaces directory entries rather than follows
 * their links.
 */
export function publishTarget(path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) return path;
  } catch (error) {
    if (errno(error) === 'ENOENT') return path;
    throw error;
  }

  try {
    return realpathSync.native(path);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
    return resolveAllowMissing(path);
  }
}

function createTemp(target: string): { fd: number; path: string } {
  const parent = dirname(target);
  const stem = basename(target).slice(0, TEMP_PREFIX_CHARS);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const path = join(parent, `.qlb-${stem}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      // The temp is private from creation, before fchmod applies the requested
      // final mode. O_EXCL also prevents a pre-existing path from being reused.
      return {
        fd: openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600),
        path,
      };
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
    }
  }
  throw new Error(`could not allocate unique temporary file beside '${target}'`);
}

function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writeSync(fd, data, offset, data.byteLength - offset);
    if (written === 0) {
      const error = new Error('write made no progress') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    }
    offset += written;
  }
}

/**
 * Atomically publish bytes beside `path` and return the inode of the published
 * file. Failures before rename leave the destination untouched and remove the
 * private temporary file. No ordinary fallible operation follows rename: the
 * content is fsynced before publish, but durability of the rename itself is
 * the directory's business and is not promised.
 */
export function atomicWriteBytes(path: string, data: Uint8Array, options: AtomicWriteOptions = {}): number {
  const { mode = 0o600, followSymlinks = true } = options;
  const target = followSymlinks ? publishTarget(path) : path;
  const temp = createTemp(target);
  let fd = temp.fd;

  try {
    writeAll(fd, data);
    fchmodSync(fd, mode);
    try {
      fsyncSync(fd);
    } catch (error) {
      if (!FSYNC_UNSUPPORTED.has(errno(error) ?? '')) throw error;
    }
    const inode = fstatSync(fd).ino;
    closeSync(fd);
    fd = -1;
    renameSync(temp.path, target);
    return inode;
  } catch (error) {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      unlinkSync(temp.path);
    } catch {
      // It may already have been removed by a failed or successful rename.
    }
    throw error;
  }
}

/**
 * Make prior directory-entry updates durable. Call this after an atomic rename
 * when the caller's recovery protocol requires the rename itself to survive a
 * power loss.
 */
export function fsyncDirSync(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicWriteText(path: string, text: string, options: AtomicWriteOptions = {}): number {
  return atomicWriteBytes(path, Buffer.from(text, 'utf8'), options);
}

export type SweepStrayTempsOptions = {
  /** Injectable for tests; false means that the owner PID is known to be dead. */
  isProcessAlive?: (pid: number) => boolean;
};

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM and unexpected errors are conservatively treated as live; only
    // ESRCH establishes that an old temp's owner is gone.
    return errno(error) !== 'ESRCH';
  }
}

/**
 * Remove QLB atomic-write temps older than 60 seconds immediately below `dir`.
 * This is a QLB addition (the upstream helper has no sweep); lstat avoids
 * following symlinks. The owner PID is checked instead of extending the grace
 * period so an indefinitely stalled live writer is never swept.
 */
export function sweepStrayTemps(dir: string, options: SweepStrayTempsOptions = {}): number {
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  let removed = 0;
  const oldestAllowed = Date.now() - STRAY_TEMP_MIN_AGE_MS;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const match = STRAY_TEMP.exec(entry.name);
    if (match === null) continue;
    const ownerPid = Number(match[2]);
    if (!Number.isSafeInteger(ownerPid)) continue;
    const path = join(dir, entry.name);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if (errno(error) === 'ENOENT') continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.mtimeMs > oldestAllowed) continue;
    let ownerIsAlive: boolean;
    try {
      ownerIsAlive = isProcessAlive(ownerPid);
    } catch {
      // A failed custom probe cannot prove the owner dead.
      ownerIsAlive = true;
    }
    if (ownerIsAlive) continue;
    try {
      unlinkSync(path);
      removed += 1;
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
  }
  return removed;
}
