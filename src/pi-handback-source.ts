import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type { PiAuthBackup } from './pi-auth-backup';
import type { Grant } from './types';

export type SingleGrantSourceKind = 'keychain' | 'exact-backup' | 'legacy-backup' | 'none';

/** Digest used for a missing Keychain item (§2 S2). */
export const ABSENT = 'ABSENT';
/** @deprecated Use ABSENT. Kept as a descriptive alias for callers. */
export const ABSENT_KEYCHAIN_DIGEST = ABSENT;

export interface RestoreRecordInput {
  authPath: string;
  key: string;
  decidedAt: number;
  filePresent: boolean;
  entryPresent: boolean;
  entry?: unknown;
}

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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical digest requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('canonical digest requires JSON data');
}

/** SHA-256 of a recursively key-sorted JSON value. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** §5.2 fence calculation. An absent Keychain grant is represented by -1. */
export function fencedGeneration(storeGeneration: number, keychainGeneration: number): number {
  if (!Number.isSafeInteger(storeGeneration) || storeGeneration < 0
    || !Number.isSafeInteger(keychainGeneration) || keychainGeneration < -1) {
    throw new RangeError('invalid grant generation');
  }
  return Math.max(storeGeneration, keychainGeneration) + 1;
}

/**
 * The S2(ii) comparison digest. Its fields deliberately exclude incidental
 * Keychain payload data while binding the token lineage and write generation.
 */
export function keychainDigest(grant: Grant | null | undefined): string {
  if (grant === null || grant === undefined) return ABSENT;
  return canonicalDigest([
    grant.generation,
    grant.writtenBy ?? null,
    fingerprint(grant.refresh),
    fingerprint(grant.access),
  ]);
}

/** Build the normalized restore record whose canonical digest is journaled. */
export function restoreRecordFor(input: RestoreRecordInput): PiAuthBackup {
  if (!Number.isFinite(input.decidedAt)) throw new TypeError('restore record requires a finite decision time');
  if (input.entryPresent && !input.filePresent) throw new TypeError('restore record cannot contain an entry from an absent file');
  if (input.entryPresent && !Object.prototype.hasOwnProperty.call(input, 'entry')) {
    throw new TypeError('restore record requires an entry');
  }
  return {
    version: 1,
    authPath: resolve(input.authPath),
    key: input.key,
    cycleId: `handback:${input.decidedAt}`,
    filePresent: input.filePresent,
    entryPresent: input.entryPresent,
    ...(input.entryPresent ? { entry: input.entry } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrustedGrant(value: unknown, storeGeneration: number): Grant | null {
  if (!isRecord(value)
    || typeof value.generation !== 'number'
    || !Number.isInteger(value.generation)
    || value.generation < storeGeneration
    || value.writtenBy === 'native-resync') {
    return null;
  }

  const entry = piEntryFromKeychainGrant(value);
  if (!entry) return null;

  const grant: Grant = {
    access: entry.access,
    refresh: entry.refresh,
    expires: entry.expires,
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

interface ValidPiOAuthEntry {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
}

function isValidEntry(entry: unknown): entry is ValidPiOAuthEntry {
  return isRecord(entry)
    && !isPlaceholder(entry)
    && entry.type === 'oauth'
    && typeof entry.access === 'string'
    && typeof entry.refresh === 'string'
    && entry.refresh.length > 0
    && typeof entry.expires === 'number'
    && Number.isFinite(entry.expires);
}

function piEntryFromKeychainGrant(grant: Record<string, unknown>): ValidPiOAuthEntry | null {
  const entry = {
    type: 'oauth' as const,
    access: grant.access,
    refresh: grant.refresh,
    expires: grant.expires,
  };
  return isValidEntry(entry) ? entry : null;
}

export interface HandbackVerdict {
  piFingerprint: string | null;
  keychainDisposition: 'delete' | 'keep';
}

function keychainRefreshFingerprint(value: unknown): string | null {
  if (!isRecord(value)
    || typeof value.generation !== 'number'
    || !Number.isSafeInteger(value.generation)
    || value.generation < 0
    || (value.writtenBy !== undefined && typeof value.writtenBy !== 'string')) {
    return null;
  }
  const entry = piEntryFromKeychainGrant(value);
  return entry ? fingerprint(entry.refresh) : null;
}

/**
 * Pure S5 / OD-2 verdict. A malformed Keychain payload is deliberately a
 * non-match: only a well-formed copy of Pi's final refresh-token lineage can
 * be deleted.
 */
export function handbackVerdict(kmRead: unknown, piEntry: unknown): HandbackVerdict {
  const piFingerprint = isValidEntry(piEntry) ? fingerprint(piEntry.refresh) : null;
  const keychainFingerprint = keychainRefreshFingerprint(kmRead);
  return {
    piFingerprint,
    keychainDisposition: piFingerprint !== null && keychainFingerprint === piFingerprint
      ? 'delete'
      : 'keep',
  };
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
