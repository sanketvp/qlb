import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { atomicWriteText } from './fsutil';
import { qlbHomeDir } from './home';

export interface PiAuthBackup {
  version: 1;
  authPath: string;
  key: string;
  cycleId: string;
  filePresent: boolean;
  entryPresent: boolean;
  entry?: unknown;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, message: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as JsonObject;
}

function readAuth(path: string): JsonObject {
  return existsSync(path) ? asObject(JSON.parse(readFileSync(path, 'utf8')), 'Pi auth.json is not an object') : {};
}

export function piAuthBackupPath(authPath: string, key: string): string {
  const resolved = resolve(authPath);
  const hash = createHash('sha256').update(resolved, 'utf8').digest('hex').slice(0, 16);
  return join(qlbHomeDir(), '.qlb', 'backups', 'pi-auth', 'by-auth', hash, `${key}.json`);
}

export function legacyPiAuthBackupPath(authPath: string, key: string): string {
  return `${authPath}.qlb-${key}.baseline.json`;
}

function malformed(): never {
  throw new Error('Pi auth backup is malformed');
}

function backupFrom(value: unknown, authPath: string, key: string, legacy = false): PiAuthBackup {
  const parsed = asObject(value, 'Pi auth backup is malformed');
  const entryPresent = parsed.entryPresent;
  if (typeof parsed.filePresent !== 'boolean' || typeof entryPresent !== 'boolean') return malformed();
  if (entryPresent && !Object.prototype.hasOwnProperty.call(parsed, 'entry')) return malformed();
  if (!parsed.filePresent && entryPresent) return malformed();
  if (legacy) {
    return {
      version: 1,
      authPath: resolve(authPath),
      key,
      cycleId: 'legacy',
      filePresent: parsed.filePresent,
      entryPresent,
      ...(entryPresent ? { entry: parsed.entry } : {}),
    };
  }
  if (parsed.version !== 1 || parsed.authPath !== resolve(authPath) || parsed.key !== key || typeof parsed.cycleId !== 'string') return malformed();
  return {
    version: 1,
    authPath: parsed.authPath,
    key: parsed.key,
    cycleId: parsed.cycleId,
    filePresent: parsed.filePresent,
    entryPresent,
    ...(entryPresent ? { entry: parsed.entry } : {}),
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Capture the current auth entry, replacing even a backup from the same cycle. */
export function writePiAuthBackup(authPath: string, key: string, cycleId: string): PiAuthBackup {
  const filePresent = existsSync(authPath);
  const auth = readAuth(authPath);
  const entryPresent = Object.prototype.hasOwnProperty.call(auth, key);
  const backup: PiAuthBackup = {
    version: 1,
    authPath: resolve(authPath),
    key,
    cycleId,
    filePresent,
    entryPresent,
    ...(entryPresent ? { entry: auth[key] } : {}),
  };
  writeJson(piAuthBackupPath(authPath, key), backup);
  return backup;
}

export function readPiAuthBackup(authPath: string, key: string): PiAuthBackup | null {
  const current = piAuthBackupPath(authPath, key);
  if (existsSync(current)) return backupFrom(JSON.parse(readFileSync(current, 'utf8')), authPath, key);
  const legacy = legacyPiAuthBackupPath(authPath, key);
  if (existsSync(legacy)) return backupFrom(JSON.parse(readFileSync(legacy, 'utf8')), authPath, key, true);
  return null;
}

/** Restore exactly this key and return its value after the restoration is re-read. */
export function restorePiAuthEntry(authPath: string, key: string, record: PiAuthBackup): unknown {
  const backup = backupFrom(record, authPath, key);
  const auth = readAuth(authPath);
  if (backup.entryPresent) auth[key] = backup.entry;
  else delete auth[key];
  if (!backup.filePresent && Object.keys(auth).length === 0) rmSync(authPath, { force: true });
  else writeJson(authPath, auth);
  return readAuth(authPath)[key];
}

export function removePiAuthBackup(authPath: string, key: string): void {
  rmSync(piAuthBackupPath(authPath, key), { force: true });
  rmSync(legacyPiAuthBackupPath(authPath, key), { force: true });
}
