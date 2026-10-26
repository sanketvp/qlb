// Anthropic-pool inventory for the D-R4 hand-off (S39, S61).
// This module derives only fingerprints and expiry horizons from pool data;
// credential bytes never leave the parser or appear in its result types.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { credentialFingerprint } from './anthropic-oauth';
import { parsePoolFile } from './migration';
import type { KeychainBackend } from './keychain';
import type { Store } from './store';

export interface PoolInventoryEntry {
  /** Stable `anthropic-pool` account identifier; never a credential value. */
  target: string;
  lineageFp: string;
  expiresAt: number | null;
}

export interface SourceLineage {
  /** C-swap/QLB slot identifier used later for an undo export target. */
  slotAccountId: string;
  lineageFp: string;
  /** Multiple fingerprints are permitted only for a recorded QLB slot chain. */
  lineageChain?: boolean;
}

export interface PiExportTarget {
  provider: 'anthropic';
  target: string;
  slotAccountId: string;
  lineageFp: string;
  recordedAt: number;
}

export interface PoolInventoryEntryReport {
  target: string;
  lineageShared: boolean;
  /** Null means that the pool entry has no finite expiry horizon. */
  expiresInMs: number | null;
}

export interface PoolInventoryResult {
  entries: PoolInventoryEntryReport[];
  targets: PiExportTarget[];
}

/** Typed, redaction-safe failures at this credential-classification boundary. */
export class PoolInventoryError extends Error {
  constructor(readonly code: string) {
    super(code.replaceAll('-', ' '));
    this.name = 'PoolInventoryError';
  }
}

/** The small persistence boundary makes every test effect injectable. */
export interface PoolInventoryStore {
  replacePiExportTargets(provider: string, targets: PiExportTarget[]): void;
}

function fail(code: string): never {
  throw new PoolInventoryError(code);
}

function isRefreshLineage(lineage: string): boolean {
  return /^sha256:[0-9a-f]{64}$/i.test(lineage);
}

function assertLineage(lineage: string, kind: string): void {
  if (!isRefreshLineage(lineage)) fail(`${kind}-lineage-invalid`);
}

/**
 * Classify native pool entries against a source set. A target may contain a
 * current pool refresh plus its durable LKG predecessors/successors. It maps
 * to at most one source lineage: choosing among two is unsafe for undo.
 */
export function classify(
  entries: readonly PoolInventoryEntry[],
  lineages: readonly SourceLineage[],
  now: number = Date.now(),
): PoolInventoryResult {
  const sources = new Map<string, SourceLineage>();
  const sourceSlotLineages = new Map<string, string>();
  for (const source of lineages) {
    if (!source.slotAccountId) fail('source-slot-id-invalid');
    assertLineage(source.lineageFp, 'source');
    if (sources.has(source.lineageFp)) fail('ambiguous-source-lineage');
    const prior = sourceSlotLineages.get(source.slotAccountId);
    if (prior !== undefined && prior !== source.lineageFp && !source.lineageChain) {
      fail('duplicate-slot-account-id');
    }
    sourceSlotLineages.set(source.slotAccountId, source.lineageFp);
    sources.set(source.lineageFp, source);
  }

  const targetEntries = new Map<string, { expiresAt: number | null; shared: SourceLineage[] }>();
  const lineageTargets = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.target) fail('pool-target-invalid');
    assertLineage(entry.lineageFp, 'pool');
    if (entry.expiresAt != null && (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= 0)) {
      fail('pool-expiry-invalid');
    }
    const previousTarget = lineageTargets.get(entry.lineageFp);
    if (previousTarget !== undefined && previousTarget !== entry.target) fail('ambiguous-pool-lineage');
    lineageTargets.set(entry.lineageFp, entry.target);

    const existing = targetEntries.get(entry.target);
    if (existing === undefined) {
      targetEntries.set(entry.target, { expiresAt: entry.expiresAt, shared: [] });
    } else if (existing.expiresAt !== entry.expiresAt && entry.expiresAt != null && existing.expiresAt != null) {
      fail('pool-target-expiry-ambiguous');
    } else if (existing.expiresAt == null && entry.expiresAt != null) {
      existing.expiresAt = entry.expiresAt;
    }

    const source = sources.get(entry.lineageFp);
    if (source) targetEntries.get(entry.target)!.shared.push(source);
  }

  const reports: PoolInventoryEntryReport[] = [];
  const targets: PiExportTarget[] = [];
  for (const [target, value] of targetEntries) {
    const source = value.shared[0];
    if (source && value.shared.some((candidate) => (
      candidate.slotAccountId !== source.slotAccountId || candidate.lineageFp !== source.lineageFp
    ))) {
      // A target can be restored only once. This includes two members of one
      // slot chain: recording either would erase evidence of the other.
      fail('duplicate-slot-account-id');
    }
    reports.push({
      target,
      lineageShared: source !== undefined,
      expiresInMs: value.expiresAt == null ? null : Math.max(0, value.expiresAt - now),
    });
    if (source) {
      targets.push({
        provider: 'anthropic', target, slotAccountId: source.slotAccountId,
        lineageFp: source.lineageFp, recordedAt: now,
      });
    }
  }
  return { entries: reports, targets };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function fingerprintRefresh(refresh: string): string {
  return `sha256:${createHash('sha256').update(refresh, 'utf8').digest('hex')}`;
}

function assertPoolAccounts(raw: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail('pool-file-invalid'); }
  const file = asRecord(parsed);
  if (!file || !Array.isArray(file.accounts)) fail('pool-file-invalid');
  for (const account of file.accounts) {
    const record = asRecord(account);
    const credentials = record && asRecord(record.credentials);
    if (!credentials || typeof credentials.access !== 'string' || typeof credentials.refresh !== 'string') {
      fail('pool-account-invalid');
    }
  }
}

function isLkgCredential(value: unknown): value is Record<string, unknown> {
  const credential = asRecord(value);
  return credential !== null
    && credential.type === 'oauth'
    && typeof credential.access === 'string'
    && typeof credential.refresh === 'string'
    && typeof credential.expires === 'number'
    && Number.isFinite(credential.expires);
}

function lkgLineages(value: unknown, allowConflict = true): string[] {
  const record = asRecord(value);
  if (!record) fail('pool-lkg-invalid');
  if (Object.hasOwn(record, 'refresh') && !Object.hasOwn(record, 'credential')) {
    if (typeof record.refresh !== 'string') fail('pool-lkg-invalid');
    return [record.refresh];
  }
  if (!isLkgCredential(record.credential) || typeof record.expectedPredecessor !== 'string'
    || typeof record.poolGeneration !== 'number' || typeof record.txId !== 'string'
    || typeof record.acceptedAt !== 'number'
    || (record.source !== 'refresher' && record.source !== 'external_auth')) {
    fail('pool-lkg-invalid');
  }
  const refreshes = [record.credential.refresh as string, record.expectedPredecessor];
  if (record.conflict === undefined) return refreshes;
  if (!allowConflict) fail('pool-lkg-invalid');
  const conflict = asRecord(record.conflict);
  if (!conflict || conflict.kind !== 'concurrent_acceptance' || conflict.status !== 'unresolved'
    || typeof conflict.preferredTxId !== 'string' || !Array.isArray(conflict.candidates)) {
    fail('pool-lkg-invalid');
  }
  for (const candidate of conflict.candidates) refreshes.push(...lkgLineages(candidate, false));
  return refreshes;
}

/** Parse pool plus optional LKG credentials into a fingerprint-only inventory view. */
export function loadPoolEntries(raw: string, lkgRaw?: string): PoolInventoryEntry[] {
  assertPoolAccounts(raw);
  let accounts: ReturnType<typeof parsePoolFile>['accounts'];
  try { ({ accounts } = parsePoolFile(raw)); } catch { fail('pool-file-invalid'); }
  const byTarget = new Map<string, PoolInventoryEntry[]>();
  const poolTargets = new Set<string>();
  for (const account of accounts) {
    if (!account.id || poolTargets.has(account.id)) fail('pool-target-invalid');
    poolTargets.add(account.id);
    const entry = {
      target: account.id,
      lineageFp: `sha256:${account.fingerprint}`,
      expiresAt: account.grant.expires > 0 ? account.grant.expires : null,
    };
    const current = byTarget.get(entry.target) ?? [];
    current.push(entry);
    byTarget.set(entry.target, current);
  }
  if (lkgRaw !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(lkgRaw); } catch { fail('pool-lkg-invalid'); }
    const lkg = asRecord(parsed);
    const lkgAccounts = lkg && asRecord(lkg.accounts);
    if (!lkgAccounts) fail('pool-lkg-invalid');
    for (const [target, lkg] of Object.entries(lkgAccounts)) {
      const current = byTarget.get(target) ?? [];
      for (const refresh of lkgLineages(lkg)) {
        const lineageFp = fingerprintRefresh(refresh);
        if (!current.some((entry) => entry.lineageFp === lineageFp)) {
          current.push({ target, lineageFp, expiresAt: null });
        }
      }
      byTarget.set(target, current);
    }
  }
  return [...byTarget.values()].flat();
}

/**
 * Read the paired pool/LKG state. A missing LKG is normal; all other LKG read
 * and shape failures are intentionally unavailable rather than partial.
 */
export function readPoolInventoryEntries(
  path: string,
  readFile: (path: string, encoding: 'utf8') => string = readFileSync,
): PoolInventoryEntry[] {
  let raw: string;
  try { raw = readFile(path, 'utf8'); } catch { fail('pool-file-unreadable'); }
  const lkgPath = join(dirname(path), 'anthropic-pool.lkg.json');
  let lkgRaw: string | undefined;
  try {
    lkgRaw = readFile(lkgPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('pool-lkg-unreadable');
  }
  return loadPoolEntries(raw, lkgRaw);
}

/**
 * Read C-swap source lineages only. The sequence file names the exact native
 * Keychain account; raw values are immediately reduced to a fingerprint.
 */
export function loadCswapSourceLineages(
  sequenceRaw: string,
  readCredential: (service: string, account: string) => string,
): SourceLineage[] {
  let parsed: unknown;
  try { parsed = JSON.parse(sequenceRaw); } catch { fail('cswap-registry-unreadable'); }
  const file = asRecord(parsed);
  if (!file || !Array.isArray(file.sequence) || !file.accounts || !asRecord(file.accounts)) {
    fail('cswap-registry-unreadable');
  }

  const records = file.accounts as Record<string, unknown>;
  const lineages: SourceLineage[] = [];
  for (const number of file.sequence) {
    if ((typeof number !== 'number' && typeof number !== 'string') || String(number).length === 0) fail('cswap-registry-unreadable');
    const record = asRecord(records[String(number)]);
    if (!record || typeof record.email !== 'string' || !record.email || typeof record.uuid !== 'string' || !record.uuid) {
      fail('cswap-registry-unreadable');
    }
    const fingerprint = credentialFingerprint(readCredential('claude-swap', `account-${number}-${record.email}`));
    if (!fingerprint || !fingerprint.startsWith('sha256:')) fail('cswap-credential-unreadable');
    lineages.push({ slotAccountId: record.uuid, lineageFp: fingerprint });
  }
  return lineages;
}

/** Records migration-time classification. X1/CLI reports must call classify only. */
export function recordPoolInventoryForPiMigrate(options: {
  entries: readonly PoolInventoryEntry[];
  lineages: readonly SourceLineage[];
  store: PoolInventoryStore;
  now?: () => number;
}): PoolInventoryResult {
  const result = classify(options.entries, options.lineages, options.now?.() ?? Date.now());
  options.store.replacePiExportTargets('anthropic', result.targets);
  return result;
}

/** @deprecated Use recordPoolInventoryForPiMigrate only from pi migrate anthropic. */
export function inventoryPool(options: {
  entries: readonly PoolInventoryEntry[];
  lineages: readonly SourceLineage[];
  store: PoolInventoryStore;
  now?: () => number;
}): PoolInventoryResult {
  return recordPoolInventoryForPiMigrate(options);
}

export function readCswapInventoryLineages(
  sequencePath: string,
  keychain: Pick<KeychainBackend, 'getSync'>,
  readFile: (path: string, encoding: 'utf8') => string = readFileSync,
): SourceLineage[] {
  return loadCswapSourceLineages(
    readFile(sequencePath, 'utf8'),
    (service, account) => keychain.getSync(service, account),
  );
}

/** View used by pi migrate anthropic after C-swap is imported into QLB slots. */
export function slotInventoryLineages(store: Pick<Store, 'listAnthropicSlotLineageChains'>): SourceLineage[] {
  return store.listAnthropicSlotLineageChains().flatMap((slot) => slot.lineages
    .filter(isRefreshLineage)
    .map((lineageFp) => ({ slotAccountId: slot.accountId, lineageFp, lineageChain: true })));
}
