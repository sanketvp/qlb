import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { qlbHomeDir } from './home';

/**
 * A reading older than this has not been refreshed recently enough for consumers
 * to treat it as current. Export remains cache-only regardless of freshness.
 */
export const CACHE_EXPORT_STALE_AFTER_MS = 15 * 60 * 1000;
const SUPPORTED_SCHEMA_VERSION = 5;

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
  source: 'poll' | 'headers' | 'error';
  confidence: 'authoritative' | 'advisory' | 'stale' | 'unknown';
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
  source: 'poll' | 'headers' | 'error';
  confidence: 'authoritative' | 'advisory' | 'stale' | 'unknown';
  stale: boolean;
};

export type CacheExport = {
  exportedAt: number;
  readings: CacheExportReading[];
};

function exportDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.QLB_DB_PATH) return env.QLB_DB_PATH;
  return join(qlbHomeDir(env), '.qlb', 'qlb.db');
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | number | undefined;
  return typeof row === 'number' ? row : row?.user_version ?? 0;
}

function parseArgs(args: string[]): boolean {
  if (args.length === 1 && args[0] === '--cache-only') return true;
  if (args.length === 2 && args.includes('--cache-only') && args.includes('--json')) return true;
  return false;
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
    const version = readUserVersion(db);
    if (version > SUPPORTED_SCHEMA_VERSION) {
      throw new Error(`qlb export: qlb.db schema user_version=${version} is newer than this binary (${SUPPORTED_SCHEMA_VERSION}); upgrade qlb`);
    }
    const rows = db.prepare(`
      SELECT s.account_id, a.provider, a.label, s.bucket, s.used_pct, s.used,
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
        stale: now - row.fetched_at > CACHE_EXPORT_STALE_AFTER_MS,
      })),
    };
  } finally {
    db.close();
  }
}

export function runCacheOnlyExport(args: string[]): number {
  if (!parseArgs(args) || !args.includes('--json')) {
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
