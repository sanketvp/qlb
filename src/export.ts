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
  source: 'provider-poll' | 'provider-headers' | 'poll' | 'headers' | 'plugin' | 'error';
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
  source: 'provider-poll' | 'provider-headers' | 'poll' | 'headers' | 'plugin' | 'error';
  confidence: 'authoritative' | 'advisory' | 'stale' | 'unknown';
  status: string;
  stale: boolean;
};

export type CacheExport = {
  exportedAt: number;
  readings: CacheExportReading[];
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
  if (!existsSync(dbPath)) return { exportedAt: now, readings: [] };

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${CACHE_EXPORT_BUSY_TIMEOUT_MS}`);
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
    return {
      exportedAt: now,
      readings: rows.map((row) => ({
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
      })),
    };
  } finally {
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
