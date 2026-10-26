// Anthropic-pool inventory for the D-R4 hand-off (S39, S61).
// This module derives only fingerprints and expiry horizons from pool data;
// credential bytes never leave the parser or appear in its result types.

import { readFileSync } from 'node:fs';
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

/** The small persistence boundary makes every test effect injectable. */
export interface PoolInventoryStore {
  replacePiExportTargets(provider: string, targets: PiExportTarget[]): void;
}

function assertLineage(lineage: string, kind: string): void {
  if (!/^sha256:[0-9a-f]{64}$/i.test(lineage)) throw new Error(`${kind} lineage is invalid`);
}

/**
 * Classify native pool entries against a source set.  A lineage must belong to
 * exactly one source slot: choosing arbitrarily would make rollback export a
 * token to the wrong slot.
 */
export function classify(
  entries: readonly PoolInventoryEntry[],
  lineages: readonly SourceLineage[],
  now: number = Date.now(),
): PoolInventoryResult {
  const sources = new Map<string, SourceLineage>();
  for (const source of lineages) {
    if (!source.slotAccountId) throw new Error('source slot identifier is invalid');
    assertLineage(source.lineageFp, 'source');
    if (sources.has(source.lineageFp)) throw new Error('ambiguous source lineage');
    sources.set(source.lineageFp, source);
  }

  const seenTargets = new Set<string>();
  const seenLineages = new Set<string>();
  const reports: PoolInventoryEntryReport[] = [];
  const targets: PiExportTarget[] = [];
  for (const entry of entries) {
    if (!entry.target || seenTargets.has(entry.target)) throw new Error('pool target is invalid');
    if (seenLineages.has(entry.lineageFp)) throw new Error('ambiguous pool lineage');
    assertLineage(entry.lineageFp, 'pool');
    if (entry.expiresAt != null && (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= 0)) {
      throw new Error('pool expiry is invalid');
    }
    seenTargets.add(entry.target);
    seenLineages.add(entry.lineageFp);

    const source = sources.get(entry.lineageFp);
    reports.push({
      target: entry.target,
      lineageShared: source !== undefined,
      expiresInMs: entry.expiresAt == null ? null : Math.max(0, entry.expiresAt - now),
    });
    if (source) {
      targets.push({
        provider: 'anthropic',
        target: entry.target,
        slotAccountId: source.slotAccountId,
        lineageFp: entry.lineageFp,
        recordedAt: now,
      });
    }
  }
  return { entries: reports, targets };
}

/** Parse pool credentials into a fingerprint-only inventory view. */
export function loadPoolEntries(raw: string): PoolInventoryEntry[] {
  const { accounts } = parsePoolFile(raw);
  const seen = new Set<string>();
  return accounts.map((account) => {
    if (!account.id || seen.has(account.id)) throw new Error('pool target is invalid');
    seen.add(account.id);
    return {
      target: account.id,
      lineageFp: `sha256:${account.fingerprint}`,
      expiresAt: account.grant.expires > 0 ? account.grant.expires : null,
    };
  });
}

/**
 * Read C-swap source lineages only.  The sequence file names the exact native
 * Keychain account; raw values are immediately reduced to a fingerprint.
 */
export function loadCswapSourceLineages(
  sequenceRaw: string,
  readCredential: (service: string, account: string) => string,
): SourceLineage[] {
  let parsed: unknown;
  try { parsed = JSON.parse(sequenceRaw); } catch { throw new Error('C-swap account registry is unreadable'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('C-swap account registry is unreadable');
  const file = parsed as { sequence?: unknown; accounts?: unknown };
  if (!Array.isArray(file.sequence) || !file.accounts || typeof file.accounts !== 'object' || Array.isArray(file.accounts)) {
    throw new Error('C-swap account registry is unreadable');
  }

  const records = file.accounts as Record<string, unknown>;
  const lineages: SourceLineage[] = [];
  for (const number of file.sequence) {
    if ((typeof number !== 'number' && typeof number !== 'string') || String(number).length === 0) throw new Error('C-swap account registry is unreadable');
    const record = records[String(number)];
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('C-swap account registry is unreadable');
    const { email, uuid } = record as { email?: unknown; uuid?: unknown };
    if (typeof email !== 'string' || !email || typeof uuid !== 'string' || !uuid) throw new Error('C-swap account registry is unreadable');
    const fingerprint = credentialFingerprint(readCredential('claude-swap', `account-${number}-${email}`));
    if (!fingerprint || !fingerprint.startsWith('sha256:')) throw new Error('C-swap credential is unreadable');
    lineages.push({ slotAccountId: uuid, lineageFp: fingerprint });
  }
  return lineages;
}

/** Classify and atomically replace the current anthropic undo-export rows. */
export function inventoryPool(options: {
  entries: readonly PoolInventoryEntry[];
  lineages: readonly SourceLineage[];
  store: PoolInventoryStore;
  now?: () => number;
}): PoolInventoryResult {
  const result = classify(options.entries, options.lineages, options.now?.() ?? Date.now());
  options.store.replacePiExportTargets('anthropic', result.targets);
  return result;
}

export function readPoolInventoryEntries(path: string, readFile: (path: string, encoding: 'utf8') => string = readFileSync): PoolInventoryEntry[] {
  return loadPoolEntries(readFile(path, 'utf8'));
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

/** View used by `--against slots` after P7 imports C-swap into QLB slots. */
export function slotInventoryLineages(store: Pick<Store, 'listAnthropicSlotLineages'>): SourceLineage[] {
  return store.listAnthropicSlotLineages()
    .filter((slot) => slot.fingerprint !== null)
    .map((slot) => ({ slotAccountId: slot.accountId, lineageFp: slot.fingerprint! }));
}
