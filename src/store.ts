// SQLite backend: Node's built-in `node:sqlite` (DatabaseSync).
// Verified available in this environment (Node v26.5.0). Spec §4.1 mentions
// better-sqlite3 for the same synchronous BEGIN IMMEDIATE style; node:sqlite
// provides that without a native addon, so we use it instead of adding a
// dependency. If `node:sqlite` is ever unavailable, switch to `better-sqlite3`.
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { BucketReading, Confidence } from './types';

export const DEFAULT_DB_PATH = join(homedir(), '.qlb', 'qlb.db');

export interface AccountRow {
  id: string;
  provider: string;
  label: string;
  status: string;
  created_at: number;
}

export interface PollClaimRow {
  account_id: string;
  holder_id: string;
  claimed_at: number;
  until: number;
}

export interface OverrideRow {
  kind: string;
  account_id: string;
  session: string | null;
  until: number | null;
}

export interface DecisionInput {
  ts?: number;
  session?: string | null;
  harness?: string | null;
  requested_model: string;
  effort?: string | null;
  served_model?: string | null;
  account_id?: string | null;
  mode: string;
  reason: string;
  snapshot_json: string;
}

function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort; non-fatal on some filesystems
  }
}

function toReading(row: {
  used_pct: number | null;
  used: number | null;
  limit_val: number | null;
  remaining: number | null;
  reset_at: number | null;
  fetched_at: number | null;
  source: string;
  confidence: string;
}): BucketReading {
  const reading: BucketReading = {
    usedPct: row.used_pct,
    source: (row.source as BucketReading['source']) || 'poll',
    confidence: (row.confidence as Confidence) || 'unknown',
    fetchedAt: row.fetched_at ?? 0,
  };
  if (row.used != null) reading.used = row.used;
  if (row.limit_val != null) reading.limit = row.limit_val;
  if (row.remaining != null) reading.remaining = row.remaining;
  if (row.reset_at != null) reading.resetAt = row.reset_at;
  return reading;
}

export class Store {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly upsertSnapStmt: StatementSync;
  private readonly getSnapStmt: StatementSync;
  private readonly getAllSnapStmt: StatementSync;
  private readonly insertDecisionStmt: StatementSync;
  private readonly getOverrideStmt: StatementSync;
  private readonly claimPollStmt: StatementSync;
  private readonly getPollStmt: StatementSync;
  private readonly releasePollStmt: StatementSync;
  private readonly upsertAccountStmt: StatementSync;
  private readonly listAccountsStmt: StatementSync;
  private readonly listAccountsByProviderStmt: StatementSync;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (dbPath === DEFAULT_DB_PATH) {
        ensurePrivateDir(dir);
      } else if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT,
        label TEXT,
        status TEXT,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        account_id TEXT,
        bucket TEXT,
        used_pct REAL,
        used REAL,
        limit_val REAL,
        remaining REAL,
        reset_at INTEGER,
        fetched_at INTEGER,
        source TEXT,
        confidence TEXT,
        PRIMARY KEY (account_id, bucket)
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        session TEXT,
        harness TEXT,
        requested_model TEXT,
        effort TEXT,
        served_model TEXT,
        account_id TEXT,
        mode TEXT,
        reason TEXT,
        snapshot_json TEXT
      );
      CREATE TABLE IF NOT EXISTS overrides (
        kind TEXT,
        account_id TEXT,
        session TEXT,
        until INTEGER
      );
      CREATE TABLE IF NOT EXISTS poll_claims (
        account_id TEXT PRIMARY KEY,
        holder_id TEXT,
        claimed_at INTEGER,
        until INTEGER
      );
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      PRAGMA user_version = 1;
    `);

    if (dbPath !== ':memory:') {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // best-effort
      }
    }

    this.upsertSnapStmt = this.db.prepare(`
      INSERT INTO snapshots (
        account_id, bucket, used_pct, used, limit_val, remaining,
        reset_at, fetched_at, source, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, bucket) DO UPDATE SET
        used_pct = excluded.used_pct,
        used = excluded.used,
        limit_val = excluded.limit_val,
        remaining = excluded.remaining,
        reset_at = excluded.reset_at,
        fetched_at = excluded.fetched_at,
        source = excluded.source,
        confidence = excluded.confidence
      WHERE excluded.fetched_at > snapshots.fetched_at
    `);

    this.getSnapStmt = this.db.prepare(
      'SELECT * FROM snapshots WHERE account_id = ? AND bucket = ?',
    );
    this.getAllSnapStmt = this.db.prepare('SELECT * FROM snapshots WHERE account_id = ?');
    this.insertDecisionStmt = this.db.prepare(`
      INSERT INTO decisions (
        ts, session, harness, requested_model, effort, served_model,
        account_id, mode, reason, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getOverrideStmt = this.db.prepare(`
      SELECT kind, account_id, session, until FROM overrides
      WHERE account_id = ? AND (until IS NULL OR until > ?)
      ORDER BY until DESC
      LIMIT 1
    `);
    // Take the claim if none exists, or the existing one has expired.
    // `changes = 0` means a live claim by someone else still holds.
    this.claimPollStmt = this.db.prepare(`
      INSERT INTO poll_claims (account_id, holder_id, claimed_at, until)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        holder_id = excluded.holder_id,
        claimed_at = excluded.claimed_at,
        until = excluded.until
      WHERE poll_claims.until <= excluded.claimed_at
    `);
    this.getPollStmt = this.db.prepare(
      'SELECT account_id, holder_id, claimed_at, until FROM poll_claims WHERE account_id = ?',
    );
    this.releasePollStmt = this.db.prepare(
      'DELETE FROM poll_claims WHERE account_id = ? AND holder_id = ? AND claimed_at = ?',
    );
    this.upsertAccountStmt = this.db.prepare(`
      INSERT INTO accounts (id, provider, label, status, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        label = excluded.label
    `);
    this.listAccountsStmt = this.db.prepare(
      'SELECT id, provider, label, status, created_at FROM accounts',
    );
    this.listAccountsByProviderStmt = this.db.prepare(
      'SELECT id, provider, label, status, created_at FROM accounts WHERE provider = ?',
    );
  }

  close(): void {
    this.db.close();
  }

  upsertAccount(
    id: string,
    provider: string,
    label: string,
    status: string = 'active',
  ): void {
    this.upsertAccountStmt.run(id, provider, label, status, Date.now());
  }

  listAccounts(provider?: string): AccountRow[] {
    const rows = provider
      ? this.listAccountsByProviderStmt.all(provider)
      : this.listAccountsStmt.all();
    return rows as unknown as AccountRow[];
  }

  upsertSnapshot(accountId: string, bucket: string, reading: BucketReading): void {
    this.upsertSnapStmt.run(
      accountId,
      bucket,
      reading.usedPct,
      reading.used ?? null,
      reading.limit ?? null,
      reading.remaining ?? null,
      reading.resetAt ?? null,
      reading.fetchedAt,
      reading.source,
      reading.confidence,
    );
  }

  getSnapshot(accountId: string, bucket: string): BucketReading | null {
    const row = this.getSnapStmt.get(accountId, bucket) as
      | {
          used_pct: number | null;
          used: number | null;
          limit_val: number | null;
          remaining: number | null;
          reset_at: number | null;
          fetched_at: number | null;
          source: string;
          confidence: string;
        }
      | undefined;
    return row ? toReading(row) : null;
  }

  getAllSnapshots(accountId: string): Record<string, BucketReading> {
    const rows = this.getAllSnapStmt.all(accountId) as Array<{
      bucket: string;
      used_pct: number | null;
      used: number | null;
      limit_val: number | null;
      remaining: number | null;
      reset_at: number | null;
      fetched_at: number | null;
      source: string;
      confidence: string;
    }>;
    const out: Record<string, BucketReading> = {};
    for (const row of rows) {
      out[row.bucket] = toReading(row);
    }
    return out;
  }

  recordDecision(input: DecisionInput): number {
    const ts = input.ts ?? Date.now();
    const result = this.insertDecisionStmt.run(
      ts,
      input.session ?? null,
      input.harness ?? null,
      input.requested_model,
      input.effort ?? null,
      input.served_model ?? null,
      input.account_id ?? null,
      input.mode,
      input.reason,
      input.snapshot_json,
    );
    return Number(result.lastInsertRowid);
  }

  getOverride(accountId: string): OverrideRow | null {
    const row = this.getOverrideStmt.get(accountId, Date.now()) as OverrideRow | undefined;
    return row ?? null;
  }

  /**
   * BEGIN IMMEDIATE claim. Returns true iff this holder acquired (or took over
   * an expired) poll_claims row.
   */
  claimPoll(accountId: string, holderId: string, ttlMs: number): boolean {
    const now = Date.now();
    const until = now + ttlMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.claimPollStmt.run(accountId, holderId, now, until);
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * P2 under the write lock: if the cache is already fresh relative to `seen`,
   * do not claim. Otherwise try to acquire.
   */
  claimPollOrFresh(
    accountId: string,
    holderId: string,
    ttlMs: number,
    seenFetchedAt: number | null,
  ): 'acquired' | 'fresh' | 'busy' {
    const now = Date.now();
    const until = now + ttlMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cached = this.getAllSnapshots(accountId);
      const rowFetched = newestFetchedAt(cached);
      if (isFresh(rowFetched, seenFetchedAt)) {
        this.db.exec('COMMIT');
        return 'fresh';
      }
      const result = this.claimPollStmt.run(accountId, holderId, now, until);
      this.db.exec('COMMIT');
      return result.changes > 0 ? 'acquired' : 'busy';
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getPollClaim(accountId: string): PollClaimRow | null {
    const row = this.getPollStmt.get(accountId) as PollClaimRow | undefined;
    return row ?? null;
  }

  releasePollClaim(accountId: string, holderId: string, claimedAt: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.releasePollStmt.run(accountId, holderId, claimedAt);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Rule W + release in one BEGIN IMMEDIATE (spec §4.3.3 P3).
   * Writes snapshots only if poll_claims still shows (holderId, claimedAt).
   * Always deletes our claim row (no-op if taken over).
   * Returns whether the snapshot write landed.
   */
  completePoll(
    accountId: string,
    holderId: string,
    claimedAt: number,
    readings: Record<string, BucketReading> | null,
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let wrote = false;
      if (readings) {
        const claim = this.getPollStmt.get(accountId) as PollClaimRow | undefined;
        if (claim && claim.holder_id === holderId && claim.claimed_at === claimedAt) {
          for (const [bucket, reading] of Object.entries(readings)) {
            this.upsertSnapStmt.run(
              accountId,
              bucket,
              reading.usedPct,
              reading.used ?? null,
              reading.limit ?? null,
              reading.remaining ?? null,
              reading.resetAt ?? null,
              reading.fetchedAt,
              reading.source,
              reading.confidence,
            );
          }
          wrote = true;
        }
      }
      this.releasePollStmt.run(accountId, holderId, claimedAt);
      this.db.exec('COMMIT');
      return wrote;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function newestFetchedAt(buckets: Record<string, BucketReading>): number | null {
  let max: number | null = null;
  for (const reading of Object.values(buckets)) {
    if (reading.fetchedAt != null && (max === null || reading.fetchedAt > max)) {
      max = reading.fetchedAt;
    }
  }
  return max;
}

/** NULL-safe fresh(row) predicate from spec §4.3.3 v6. */
export function isFresh(rowFetchedAt: number | null, seen: number | null): boolean {
  return seen === null ? rowFetchedAt !== null : rowFetchedAt !== null && rowFetchedAt > seen;
}

let defaultStore: Store | null = null;

export function getStore(): Store {
  if (!defaultStore) defaultStore = new Store(DEFAULT_DB_PATH);
  return defaultStore;
}

export function openStore(dbPath: string): Store {
  return new Store(dbPath);
}

/** Test-only: replace the process-wide default store. */
export function setStoreForTests(store: Store | null): void {
  defaultStore = store;
}
