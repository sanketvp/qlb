import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config';
import { newerSchemaMessage, readUserVersion, SCHEMA_VERSION } from './schema-version';
import { STALE_OK_S } from './usage-freshness';

const CACHE_EXPORT_BUSY_TIMEOUT_MS = 150;

type SnapshotRow = {
  account_id: string;
  provider: string;
  label: string;
  bucket: string;
  used_pct: number | null;
  used: number | null;
  limit_val: number | null;
  remaining: number | null;
  reset_at: number | null;
  fetched_at: number;
  source: 'provider-poll' | 'provider-headers' | 'poll' | 'headers' | 'plugin' | 'external-cache' | 'error';
  confidence: 'authoritative' | 'advisory' | 'stale' | 'unknown';
  status: string;
};

export type CacheExportReading = {
  accountId: string;
  provider: string;
  label: string;
  bucket: string;
  usedPct: number | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
  fetchedAt: number;
  source: 'provider-poll' | 'provider-headers' | 'poll' | 'headers' | 'plugin' | 'external-cache' | 'error';
  confidence: 'authoritative' | 'advisory' | 'stale' | 'unknown';
  status: string;
  stale: boolean;
};

export type CacheExportSurfaceMember = {
  target: string;
  accountId: string | null;
  readings: CacheExportReading[];
};

export type CacheExportSurface = {
  id: 'anthropic-pi-pool';
  source: 'pool-inventory';
  recordedAt: number;
  complete: boolean;
  members: CacheExportSurfaceMember[];
};

export type CacheExport = {
  exportedAt: number;
  readings: CacheExportReading[];
  surfaces: CacheExportSurface[];
};

function exportDbPath(): string {
  return config.dbPath;
}

function parseArgs(args: string[]): boolean {
  return args.length === 2 && args.includes('--cache-only') && args.includes('--json');
}

/**
 * Reads the last persisted readings without importing the normal CLI application
 * graph, adapters, credential stores, or network clients. The SQLite connection
 * is read-only and is closed before returning.
 */
export function cacheOnlyExport(now = Date.now(), dbPath = exportDbPath()): CacheExport {
  if (!existsSync(dbPath)) return { exportedAt: now, readings: [], surfaces: [] };

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let reading = false;
  try {
    db.exec(`PRAGMA busy_timeout = ${CACHE_EXPORT_BUSY_TIMEOUT_MS}`);
    db.exec('BEGIN');
    reading = true;
    const version = readUserVersion(db);
    if (version > SCHEMA_VERSION) {
      throw new Error(`qlb export: ${newerSchemaMessage(version)}`);
    }
    const rows = db.prepare(`
      SELECT s.account_id, a.provider, a.label, a.status, s.bucket, s.used_pct, s.used,
             s.limit_val, s.remaining, s.reset_at, s.fetched_at, s.source, s.confidence
      FROM snapshots AS s
      JOIN accounts AS a ON a.id = s.account_id
      ORDER BY a.provider, a.id, s.bucket
    `).all() as SnapshotRow[];
    const readings = rows.map((row) => ({
      accountId: row.account_id,
      provider: row.provider,
      label: row.label,
      bucket: row.bucket,
      usedPct: row.used_pct,
      used: row.used,
      limit: row.limit_val,
      remaining: row.remaining,
      resetAt: row.reset_at,
      fetchedAt: row.fetched_at,
      source: row.source,
      confidence: row.confidence,
      status: row.status,
      stale: now - row.fetched_at > STALE_OK_S * 1000,
    }));
    const hasInventory = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_export_inventories'").get());
    const hasMembers = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_export_inventory_members'").get());
    const inventory = hasInventory && hasMembers
      ? db.prepare(`SELECT recorded_at, complete FROM pi_export_inventories WHERE provider = 'anthropic'`).get() as
        | { recorded_at: number; complete: number }
        | undefined
      : undefined;
    const inventoryMembers = inventory
      ? db.prepare(`SELECT target, slot_account_id FROM pi_export_inventory_members
          WHERE provider = 'anthropic' ORDER BY target`).all() as Array<{ target: string; slot_account_id: string | null }>
      : [];
    const complete = inventory !== undefined && inventory.complete !== 0;
    const hasLifecycle = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lifecycle'").get());
    const lifecycle = hasLifecycle
      ? db.prepare("SELECT state, began_at FROM lifecycle WHERE state <> 'closed' ORDER BY id DESC LIMIT 1").get() as { state: string; began_at: number } | undefined
      : undefined;
    const servingPool = (lifecycle?.state === 'cutting-over' || lifecycle?.state === 'cutover' || lifecycle?.state === 'retired')
      && inventory !== undefined
      && inventory.recorded_at >= lifecycle.began_at;
    const surfaces: CacheExportSurface[] = servingPool && inventory ? [{
      id: 'anthropic-pi-pool',
      source: 'pool-inventory',
      recordedAt: inventory.recorded_at,
      complete,
      members: inventoryMembers.map((member) => ({
        target: member.target,
        accountId: member.slot_account_id,
        readings: member.slot_account_id === null ? [] : readings.filter((reading) =>
          reading.provider === 'anthropic' && reading.accountId === member.slot_account_id),
      })),
    }] : [];
    db.exec('COMMIT');
    reading = false;
    return { exportedAt: now, readings, surfaces };
  } finally {
    if (reading) db.exec('ROLLBACK');
    db.close();
  }
}

export function runCacheOnlyExport(args: string[]): number {
  if (!parseArgs(args)) {
    console.error('Usage: qlb export --cache-only --json');
    return 1;
  }
  try {
    console.log(JSON.stringify(cacheOnlyExport()));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : `qlb export: ${String(err)}`);
    return 1;
  }
}
