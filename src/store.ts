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
  grant_generation: number;
}

export interface PollClaimRow {
  account_id: string;
  holder_id: string;
  claimed_at: number;
  until: number;
}

/** Credential-refresh lease (§4.7 / §4.8.2). De-duplication only — not a correctness fence. */
export interface LeaseRow {
  name: string;
  holder_pid: number;
  holder_id: string;
  until: number;
  generation: number;
}

/** Credential-migration journal (§4.8.3). One row per native store. */
export interface MigrationRow {
  store: string;
  state: string;
  updated_at: number;
  detail_json: string;
}

export function refreshLeaseName(accountId: string): string {
  return `refresh:${accountId}`;
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as
    | { user_version?: number }
    | number
    | undefined;
  if (typeof row === 'number') return row;
  if (row && typeof row.user_version === 'number') return row.user_version;
  return 0;
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
  private readonly getAccountStmt: StatementSync;
  private readonly getGenStmt: StatementSync;
  private readonly setGenCasStmt: StatementSync;
  private readonly setStatusStmt: StatementSync;
  private readonly getLeaseStmt: StatementSync;
  private readonly upsertLeaseStmt: StatementSync;
  private readonly heartbeatLeaseStmt: StatementSync;
  private readonly deleteLeaseByHolderStmt: StatementSync;
  private readonly stealLeaseStmt: StatementSync;
  private readonly getMigrationStmt: StatementSync;
  private readonly upsertMigrationStmt: StatementSync;
  private readonly listMigrationsStmt: StatementSync;

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
    `);
    this.migrateIfNeeded();

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
      'SELECT id, provider, label, status, created_at, grant_generation FROM accounts',
    );
    this.listAccountsByProviderStmt = this.db.prepare(
      'SELECT id, provider, label, status, created_at, grant_generation FROM accounts WHERE provider = ?',
    );
    this.getAccountStmt = this.db.prepare(
      'SELECT id, provider, label, status, created_at, grant_generation FROM accounts WHERE id = ?',
    );
    this.getGenStmt = this.db.prepare(
      'SELECT grant_generation FROM accounts WHERE id = ?',
    );
    this.setGenCasStmt = this.db.prepare(
      'UPDATE accounts SET grant_generation = ? WHERE id = ? AND grant_generation = ?',
    );
    this.setStatusStmt = this.db.prepare(
      'UPDATE accounts SET status = ? WHERE id = ?',
    );
    this.getLeaseStmt = this.db.prepare(
      'SELECT name, holder_pid, holder_id, until, generation FROM leases WHERE name = ?',
    );
    this.upsertLeaseStmt = this.db.prepare(`
      INSERT INTO leases (name, holder_pid, holder_id, until, generation)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        holder_pid = excluded.holder_pid,
        holder_id = excluded.holder_id,
        until = excluded.until,
        generation = excluded.generation
    `);
    this.heartbeatLeaseStmt = this.db.prepare(
      'UPDATE leases SET until = ? WHERE name = ? AND holder_id = ?',
    );
    this.deleteLeaseByHolderStmt = this.db.prepare(
      'DELETE FROM leases WHERE name = ? AND holder_id = ?',
    );
    this.stealLeaseStmt = this.db.prepare(
      'UPDATE leases SET holder_id = ? WHERE name = ?',
    );
    this.getMigrationStmt = this.db.prepare(
      'SELECT store, state, updated_at, detail_json FROM migrations WHERE store = ?',
    );
    this.upsertMigrationStmt = this.db.prepare(`
      INSERT INTO migrations (store, state, updated_at, detail_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(store) DO UPDATE SET
        state = excluded.state,
        updated_at = excluded.updated_at,
        detail_json = excluded.detail_json
    `);
    this.listMigrationsStmt = this.db.prepare(
      'SELECT store, state, updated_at, detail_json FROM migrations',
    );
  }

  /**
   * Additive schema:
   *   v1 → v2: `accounts.grant_generation` + `leases` table (§4.7 / §4.8.2).
   *   v2 → v3: `migrations` journal (§4.8.3).
   * Generation lives on `accounts` (not a side table) so the fenced CAS in
   * §4.8.2 step 5 is a single-row UPDATE on the account itself.
   */
  private migrateIfNeeded(): void {
    const SCHEMA_VERSION = 3;
    const version = readUserVersion(this.db);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `qlb.db schema user_version=${version} is newer than this binary (${SCHEMA_VERSION}); upgrade qlb`,
      );
    }
    if (version < 2) {
      const cols = this.db.prepare('PRAGMA table_info(accounts)').all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === 'grant_generation')) {
        this.db.exec(
          'ALTER TABLE accounts ADD COLUMN grant_generation INTEGER DEFAULT 0',
        );
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS leases (
          name TEXT PRIMARY KEY,
          holder_pid INTEGER,
          holder_id TEXT,
          until INTEGER,
          generation INTEGER
        );
      `);
      this.db.exec('PRAGMA user_version = 2');
    }
    if (version < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          store TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          detail_json TEXT
        );
      `);
      this.db.exec('PRAGMA user_version = 3');
    }
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

  /**
   * Run `fn` inside BEGIN IMMEDIATE. `fn` MUST be synchronous — no `await` —
   * so another coroutine cannot interleave a second BEGIN on this connection.
   * Keychain I/O inside `fn` must use the sync backend (C3: if the Keychain
   * write lands and this throws before COMMIT, SQLite rolls back and the next
   * reader repairs via kgen > gen).
   */
  runImmediate<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // BEGIN may have failed, or SQLite already rolled back
      }
      throw err;
    }
  }

  getAccount(id: string): AccountRow | null {
    const row = this.getAccountStmt.get(id) as AccountRow | undefined;
    if (!row) return null;
    return { ...row, grant_generation: Number(row.grant_generation ?? 0) };
  }

  getGrantGeneration(accountId: string): number | null {
    const row = this.getGenStmt.get(accountId) as
      | { grant_generation: number | null }
      | undefined;
    if (!row) return null;
    return Number(row.grant_generation ?? 0);
  }

  /** CAS: set generation to `toGen` only if it currently equals `fromGen`. Returns changes. */
  casGrantGeneration(accountId: string, fromGen: number, toGen: number): number {
    const result = this.setGenCasStmt.run(toGen, accountId, fromGen);
    return Number(result.changes);
  }

  bumpGrantGeneration(accountId: string, expectedGen: number): number {
    return this.casGrantGeneration(accountId, expectedGen, expectedGen + 1);
  }

  repairGrantGeneration(accountId: string, fromGen: number, toGen: number): void {
    this.runImmediate(() => {
      this.casGrantGeneration(accountId, fromGen, toGen);
    });
  }

  setAccountStatus(accountId: string, status: string): void {
    this.setStatusStmt.run(status, accountId);
  }

  getLease(name: string): LeaseRow | null {
    const row = this.getLeaseStmt.get(name) as LeaseRow | undefined;
    return row ?? null;
  }

  /**
   * Step 3 of §4.8.2: re-check generation, skip if another holder is live,
   * otherwise UPSERT the lease. Own BEGIN IMMEDIATE.
   */
  acquireRefreshLease(
    accountId: string,
    holderId: string,
    holderPid: number,
    expectedGen: number,
    ttlMs: number,
  ): 'acquired' | 'busy' | 'stale_gen' {
    const name = refreshLeaseName(accountId);
    const now = Date.now();
    return this.runImmediate(() => {
      const gen = this.getGrantGeneration(accountId);
      if (gen === null) {
        throw new Error(`unknown account ${accountId}`);
      }
      if (gen !== expectedGen) return 'stale_gen';
      const row = this.getLease(name);
      if (row && row.until > now && row.holder_id !== holderId) {
        return 'busy';
      }
      this.upsertLeaseStmt.run(name, holderPid, holderId, now + ttlMs, expectedGen);
      return 'acquired';
    });
  }

  /**
   * Step 4 heartbeat: ok iff we still hold the lease AND generation is unchanged.
   * Renews `until` when ok. Own BEGIN IMMEDIATE.
   */
  heartbeatRefreshLease(
    accountId: string,
    holderId: string,
    expectedGen: number,
    ttlMs: number,
  ): boolean {
    const name = refreshLeaseName(accountId);
    const now = Date.now();
    return this.runImmediate(() => {
      const gen = this.getGrantGeneration(accountId);
      const row = this.getLease(name);
      const ok = row?.holder_id === holderId && gen === expectedGen;
      if (ok) {
        this.heartbeatLeaseStmt.run(now + ttlMs, name, holderId);
      }
      return ok;
    });
  }

  releaseRefreshLease(accountId: string, holderId: string): void {
    const name = refreshLeaseName(accountId);
    this.runImmediate(() => {
      this.deleteLeaseByHolderStmt.run(name, holderId);
    });
  }

  /** No-txn variant for use inside an already-open write transaction (step 5). */
  deleteLeaseIfHolder(name: string, holderId: string): void {
    this.deleteLeaseByHolderStmt.run(name, holderId);
  }

  /**
   * Step 4 `invalid_grant` handler. Returns true if this is a lost race
   * (generation moved — not revocation). Otherwise marks the account
   * `auth_revoked` and returns false.
   */
  handleAuthRevoked(
    accountId: string,
    holderId: string,
    expectedGen: number,
  ): boolean {
    const name = refreshLeaseName(accountId);
    return this.runImmediate(() => {
      const gen = this.getGrantGeneration(accountId);
      this.deleteLeaseByHolderStmt.run(name, holderId);
      if (gen !== expectedGen) return true;
      this.setStatusStmt.run('auth_revoked', accountId);
      return false;
    });
  }

  /** Fault injection for T-CONC-6 (`lease:steal`). Not used in production paths. */
  stealLease(name: string, newHolderId: string): void {
    this.stealLeaseStmt.run(newHolderId, name);
  }

  getMigration(store: string): MigrationRow | null {
    const row = this.getMigrationStmt.get(store) as MigrationRow | undefined;
    return row ?? null;
  }

  listMigrations(): MigrationRow[] {
    return this.listMigrationsStmt.all() as unknown as MigrationRow[];
  }

  upsertMigration(
    store: string,
    state: string,
    detailJson: string = '{}',
    updatedAt: number = Date.now(),
  ): void {
    this.upsertMigrationStmt.run(store, state, updatedAt, detailJson);
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
