// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — fsutil.py

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
const TEMP_PREFIX_CHARS = 40;
const MAX_SYMLINKS = 40;
const STRAY_TEMP = /^\.qlb-.+\.tmp$/;

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
    const path = join(parent, `.qlb-${stem}.${randomBytes(8).toString('hex')}.tmp`);
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

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    try {
      fsyncSync(fd);
    } catch (error) {
      if (!FSYNC_UNSUPPORTED.has(errno(error) ?? '')) throw error;
    }
  } finally {
    closeSync(fd);
  }
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
 * private temporary file.
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
    closeSync(fd);
    fd = -1;
    renameSync(temp.path, target);
    fsyncDirectory(dirname(target));
    return statSync(target).ino;
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

export function atomicWriteText(path: string, text: string, options: AtomicWriteOptions = {}): number {
  return atomicWriteBytes(path, Buffer.from(text, 'utf8'), options);
}

/** Remove abandoned QLB atomic-write temps immediately below `dir`. */
export function sweepStrayTemps(dir: string): number {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!STRAY_TEMP.test(entry.name) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    try {
      unlinkSync(join(dir, entry.name));
      removed += 1;
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
  }
  return removed;
}
