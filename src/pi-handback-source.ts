import { createHash } from 'node:crypto';

import type { Grant } from './types';

export type SingleGrantSourceKind = 'keychain' | 'exact-backup' | 'legacy-backup' | 'none';

/** The restore-relevant portion of a Pi auth backup. */
export interface SingleGrantBackup {
  entryPresent: boolean;
  entry?: unknown;
}

export interface RankSingleGrantSourceInput {
  keychainGrant: unknown;
  storeGeneration: number;
  /** Undefined identifies journals committed before this field existed (OD-1). */
  commitGeneration?: number;
  exactBackup: SingleGrantBackup | null;
  legacyBackup: SingleGrantBackup | null;
  nativeEntryPresent: boolean;
  nativeEntry: unknown;
}

export interface KeychainSingleGrantSource {
  kind: 'keychain';
  generation: number;
  fingerprint: string;
  grant: Grant;
}

export interface BackupSingleGrantSource {
  kind: 'exact-backup' | 'legacy-backup';
  generation: 0;
  fingerprint: string;
  backup: SingleGrantBackup;
}

export interface NoneSingleGrantSource {
  kind: 'none';
  generation: 0;
  fingerprint: string;
}

export type RankedSingleGrantSource =
  | KeychainSingleGrantSource
  | BackupSingleGrantSource
  | NoneSingleGrantSource;

export class NoSingleGrantRestoreSourceError extends Error {
  readonly code = 'no-restore-source';

  constructor() {
    super('no-restore-source');
    this.name = 'NoSingleGrantRestoreSourceError';
  }
}

function fingerprint(refresh: string): string {
  return createHash('sha256').update(refresh, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrustedGrant(value: unknown, storeGeneration: number): Grant | null {
  if (!isRecord(value)
    || typeof value.access !== 'string'
    || typeof value.refresh !== 'string'
    || value.refresh.length === 0
    || typeof value.generation !== 'number'
    || !Number.isInteger(value.generation)
    || value.generation < storeGeneration
    || value.writtenBy === 'native-resync') {
    return null;
  }

  const grant: Grant = {
    access: value.access,
    refresh: value.refresh,
    expires: typeof value.expires === 'number' && Number.isFinite(value.expires) ? value.expires : 0,
    generation: value.generation,
  };
  if (typeof value.writtenBy === 'string') grant.writtenBy = value.writtenBy;
  if (isRecord(value.extra)) grant.extra = value.extra;
  return grant;
}

function isPlaceholder(entry: Record<string, unknown>): boolean {
  return entry.access === 'qlb-managed'
    && entry.refresh === ''
    && entry.type === 'oauth';
}

function isValidEntry(entry: unknown): boolean {
  return isRecord(entry)
    && !isPlaceholder(entry)
    && typeof entry.refresh === 'string'
    && entry.refresh.length > 0;
}

function validBackup(backup: SingleGrantBackup | null): SingleGrantBackup | null {
  return backup && (!backup.entryPresent || isValidEntry(backup.entry)) ? backup : null;
}

/** RefreshLease stamps writes with `${processUuid}:${operationUuid}`. */
function isRefreshLeaseWriter(value: string | undefined): boolean {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function backupFingerprint(backup: SingleGrantBackup): string {
  return fingerprint(backup.entryPresent ? (backup.entry as { refresh: string }).refresh : '');
}

/**
 * Pure §5.1 source ranking. The caller supplies only previously read values;
 * this function performs no I/O and never exposes credential values in errors.
 */
export function rankSingleGrantSource(input: RankSingleGrantSourceInput): RankedSingleGrantSource {
  const keychain = asTrustedGrant(input.keychainGrant, input.storeGeneration);
  const exact = validBackup(input.exactBackup);
  const legacy = validBackup(input.legacyBackup);
  const refreshed = keychain && (
    input.commitGeneration === undefined
      ? isRefreshLeaseWriter(keychain.writtenBy)
      : keychain.generation > input.commitGeneration
  );

  if (refreshed) {
    return { kind: 'keychain', generation: keychain.generation, fingerprint: fingerprint(keychain.refresh), grant: keychain };
  }
  if (exact) {
    return { kind: 'exact-backup', generation: 0, fingerprint: backupFingerprint(exact), backup: exact };
  }
  if (legacy) {
    return { kind: 'legacy-backup', generation: 0, fingerprint: backupFingerprint(legacy), backup: legacy };
  }
  if (keychain) {
    return { kind: 'keychain', generation: keychain.generation, fingerprint: fingerprint(keychain.refresh), grant: keychain };
  }
  if (input.nativeEntryPresent && isValidEntry(input.nativeEntry)) {
    return { kind: 'none', generation: 0, fingerprint: fingerprint('') };
  }
  throw new NoSingleGrantRestoreSourceError();
}
