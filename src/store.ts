// SQLite backend: Node's built-in `node:sqlite` (DatabaseSync).
// Verified available in this environment (Node v26.5.0). Spec §4.1 mentions
// better-sqlite3 for the same synchronous BEGIN IMMEDIATE style; node:sqlite
// provides that without a native addon, so we use it instead of adding a
// dependency. If `node:sqlite` is ever unavailable, switch to `better-sqlite3`.
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertStoredReloginFields, isReloginEvidenceClass, reloginDetailFingerprint, reloginDetailValue } from './relogin-fields';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync, type StatementSync } from 'node:sqlite';
import { inspectAccountSafety, safetyRefusalMessage } from './accounts-prune';
import { config } from './config';
import { redactSecrets } from './redact';
import type { BucketReading, Confidence } from './types';

export const DEFAULT_DB_PATH = config.dbPath;

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

/** Immutable lineage edge retained for successor proofs (S46). */
export interface LineageTransitionRow {
  from_fp: string | null;
  to_fp: string;
}

/** Current slot lineage and its immediate predecessor, when this provider has slots. */
export interface SlotLineageRow {
  fingerprint: string | null;
  prev_fingerprint: string | null;
}

/** Credential-migration journal (§4.8.3). One row per native store. */
export interface MigrationRow {
  store: string;
  state: string;
  updated_at: number;
  detail_json: string;
}

/** Virtual-model policy lookup (§4.9.2b). */
export interface PolicyRow {
  harness: string;
  virtual_model: string;
  real_model: string;
  effort: string;
  fallback_json: string;
  session_mode: string;
  created_at: number;
}

export function refreshLeaseName(accountId: string): string {
  return `refresh:${accountId}`;
}

export interface AutoswitchSettings {
  threshold: number;
  weeklyThreshold: number | null;
  intervalSeconds: number;
  cooldownSeconds: number;
  hysteresisPct: number;
  unhealthyTicks: number;
  strategy: 'best' | 'consume-first';
}

function clampedConfigNumber(raw: string | null, fallback: number, minimum: number, maximum: number, integer = false): number {
  const parsed = raw == null || raw.trim() === '' ? NaN : Number(raw);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  const bounded = Math.min(maximum, Math.max(minimum, value));
  return integer ? Math.trunc(bounded) : bounded;
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

export const ROUTING_DECISION_MODES = [
  'headroom',
  'all-in',
  'fallback',
  'fallback-all-in',
  'pin',
  'spread',
  'round-robin',
  'failover',
  'pin_unavailable',
  'exhausted',
] as const;

const ROUTING_MODE_SQL = ROUTING_DECISION_MODES.map((mode) => `'${mode}'`).join(', ');

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
  strategy?: string | null;
  provider?: string | null;
}

/** Row shape of `decisions` as stored today (no `outcome` column). */
export interface DecisionRow {
  id: number;
  ts: number;
  session: string | null;
  harness: string | null;
  requested_model: string;
  effort: string | null;
  served_model: string | null;
  account_id: string | null;
  mode: string;
  reason: string;
  snapshot_json: string;
  strategy: string | null;
  provider: string | null;
}

export interface DecisionsReader {
  listRoutingDecisions(limit: number): DecisionRow[];
  getAccountProvider(accountId: string): string | null;
  close(): void;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function ensureDecisionColumnsOn(db: DatabaseSync): void {
  if (!hasColumn(db, 'decisions', 'strategy')) {
    db.exec('ALTER TABLE decisions ADD COLUMN strategy TEXT');
  }
  if (!hasColumn(db, 'decisions', 'provider')) {
    db.exec('ALTER TABLE decisions ADD COLUMN provider TEXT');
  }
}

const DECISION_SELECT = `id, ts, session, harness, requested_model, effort, served_model,
                account_id, mode, reason, snapshot_json, strategy, provider`;

/** Thrown by openDecisionsReader when a read-only open cannot create WAL sidecars. */
export const WAL_SIDECAR_UNREADABLE = 'WAL_SIDECAR_UNREADABLE';

export function isWalSidecarUnreadableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const extra =
    err && typeof err === 'object'
      ? `${'code' in err ? String((err as { code: unknown }).code) : ''} ${
          'errstr' in err ? String((err as { errstr: unknown }).errstr) : ''
        } ${'errcode' in err ? String((err as { errcode: unknown }).errcode) : ''}`
      : '';
  const combined = `${msg} ${extra}`.toLowerCase();
  const errcode =
    err && typeof err === 'object' && 'errcode' in err
      ? Number((err as { errcode: unknown }).errcode)
      : NaN;
  // SQLITE_PERM=3, SQLITE_READONLY=8, SQLITE_CANTOPEN=14, SQLITE_IOERR=10
  if (errcode === 3 || errcode === 8 || errcode === 14 || errcode === 10) return true;
  return (
    combined.includes('attempt to write a readonly database') ||
    combined.includes('readonly database') ||
    combined.includes('unable to open database file') ||
    combined.includes('cantopen') ||
    combined.includes('disk i/o error') ||
    combined.includes('permission denied')
  );
}

export function walSidecarUnreadableMessage(dir: string): string {
  return `qlb audit: store is not readable without write access to ${dir} (WAL sidecar); run from a writable location or vacuum the store`;
}

function throwIfWalSidecar(err: unknown): never {
  if (isWalSidecarUnreadableError(err) || (err instanceof Error && err.message === WAL_SIDECAR_UNREADABLE)) {
    throw new Error(WAL_SIDECAR_UNREADABLE);
  }
  throw err;
}

export function openDecisionsReader(path: string): DecisionsReader | null {
  if (!existsSync(path)) return null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    throwIfWalSidecar(err);
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const version = readUserVersion(db);
    if (version > 5) {
      throw new Error(
        `qlb.db schema user_version=${version} is newer than this binary (5); upgrade qlb`,
      );
    }
    const strategySelect = hasColumn(db, 'decisions', 'strategy')
      ? 'strategy, provider'
      : 'NULL AS strategy, NULL AS provider';
    const listStmt = db.prepare(`
      SELECT id, ts, session, harness, requested_model, effort, served_model,
             account_id, mode, reason, snapshot_json, ${strategySelect}
      FROM decisions
      WHERE mode IN (${ROUTING_MODE_SQL})
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `);
    let accountStmt: ReturnType<DatabaseSync['prepare']> | null = null;
    try {
      accountStmt = db.prepare('SELECT provider FROM accounts WHERE id = ?');
    } catch {
      accountStmt = null;
    }
    return {
      listRoutingDecisions(limit: number): DecisionRow[] {
        const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
        try {
          return listStmt.all(n) as unknown as DecisionRow[];
        } catch (err) {
          throwIfWalSidecar(err);
        }
      },
      getAccountProvider(accountId: string): string | null {
        if (!accountStmt) return null;
        try {
          const row = accountStmt.get(accountId) as { provider: string } | undefined;
          return row?.provider ?? null;
        } catch {
          return null;
        }
      },
      close(): void {
        db.close();
      },
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      // preserve the original error
    }
    throwIfWalSidecar(err);
  }
}

/** Opens a short-lived store connection with the same lock contract as Store. */
export function openStoreConnection(dbPath: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    // Match Store: install the busy handler before a lock-taking WAL request.
    db.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly && dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    return db;
  } catch (error) {
    try { db.close(); } catch { /* preserve the open error */ }
    throw error;
  }
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

type BackupVerifier = (source: DatabaseSync, copy: DatabaseSync) => boolean;

function userTableCounts(db: DatabaseSync): Map<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  const counts = new Map<string, number>();
  for (const { name } of tables) {
    // Names originate in sqlite_master, not caller input.
    const row = db.prepare(`SELECT count(*) AS count FROM "${name.replace(/"/g, '""')}"`).get() as { count: number };
    counts.set(name, row.count);
  }
  return counts;
}

function tableContentDigest(db: DatabaseSync, table: string): string {
  // Table names are read from sqlite_master. rowid gives a deterministic order
  // for the rowid tables used by this store; the column-order fallback supports
  // callers of the exported backup helper with WITHOUT ROWID tables.
  const quoted = `"${table.replace(/"/g, '""')}"`;
  let rows: unknown[];
  try {
    rows = db.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).all();
  } catch {
    const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>;
    const order = columns.map(({ name }) => `"${name.replace(/"/g, '""')}"`).join(', ');
    rows = db.prepare(`SELECT * FROM ${quoted}${order ? ` ORDER BY ${order}` : ''}`).all();
  }
  return createHash('sha256').update(JSON.stringify(rows, (_key, value) => (
    value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value
  ))).digest('hex');
}

export function verifyBackup(source: DatabaseSync, copy: DatabaseSync): boolean {
  const integrity = copy.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | string | undefined;
  const result = typeof integrity === 'string' ? integrity : integrity?.integrity_check;
  if (result !== 'ok') return false;
  const sourceCounts = userTableCounts(source);
  const copyCounts = userTableCounts(copy);
  if (sourceCounts.size !== copyCounts.size) return false;
  for (const [table, count] of sourceCounts) {
    if (copyCounts.get(table) !== count || tableContentDigest(source, table) !== tableContentDigest(copy, table)) return false;
  }
  return true;
}

/**
 * Creates an online SQLite backup before migration and verifies the copy before
 * the caller changes the source. `verify` exists solely to make the abort path
 * testable without corrupting a fixture.
 */
export async function backupBeforeMigrate(
  dbPath: string,
  backupPath: string = join(dirname(dbPath), 'backups', `db-${Date.now()}.sqlite`),
  verify: BackupVerifier = verifyBackup,
): Promise<string> {
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(dbPath);
  try {
    await backup(source, backupPath);
    const copy = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (!verify(source, copy)) throw new Error('backup verification failed; migration aborted');
    } finally {
      copy.close();
    }
    try { chmodSync(backupPath, 0o600); } catch { /* best effort */ }
    return backupPath;
  } catch (err) {
    try { rmSync(backupPath, { force: true }); } catch { /* preserve original error */ }
    throw err;
  } finally {
    source.close();
  }
}

function schemaNeedsV5Correction(db: DatabaseSync): boolean {
  const required: Record<string, string[]> = {
    claude_slots: ['archived_at'],
    codex_slots: ['pending_adopt', 'archived_at'],
    switch_log: ['injected', 'detail', 'published_at', 'committed_at'],
    usage_polls: ['provider', 'poll_interval_s'],
    relogin_events: ['evidence', 'user_denied_at'],
    lineage_log: ['evidence'],
    lifecycle: ['pre_fence_state'],
    codex_watch: [], import_runs: [], pi_export_targets: [], codex_live_observations: [],
  };
  for (const [table, columns] of Object.entries(required)) {
    const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!found) return true;
    if (columns.some((column) => !hasColumn(db, table, column))) return true;
  }
  return !lifecycleOneOpenIndexMatches(db);
}

function migrationNeeded(db: DatabaseSync): boolean {
  const version = readUserVersion(db);
  return version < 5 || (version === 5 && schemaNeedsV5Correction(db));
}

const LIFECYCLE_ONE_OPEN_INDEX_SQL = `CREATE UNIQUE INDEX lifecycle_one_open ON lifecycle ((1))
  WHERE state IN ('cutting-over','cutover','undoing','rolled-back','retired','aborted')`;

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function lifecycleOneOpenIndexMatches(db: DatabaseSync): boolean {
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'lifecycle_one_open'").get() as { sql?: string } | undefined;
  return Boolean(index?.sql && normalizedSql(index.sql) === normalizedSql(LIFECYCLE_ONE_OPEN_INDEX_SQL));
}

/** Synchronous bridge for Store's established synchronous constructor. Caller holds BEGIN IMMEDIATE. */
function backupBeforeMigrateSync(dbPath: string, source: DatabaseSync): void {
  const backupPath = join(dirname(dbPath), 'backups', `db-${Date.now()}-${process.pid}.sqlite`);
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  const script = `
    const { backup, DatabaseSync } = process.getBuiltinModule('node:sqlite');
    (async () => { const source = new DatabaseSync(process.argv[1]); try { await backup(source, process.argv[2]); } finally { source.close(); } })()
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script, dbPath, backupPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    try { rmSync(backupPath, { force: true }); } catch { /* preserve failure */ }
    throw new Error(`database backup failed; migration aborted: ${result.stderr.trim() || result.error?.message || 'unknown error'}`);
  }
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (!verifyBackup(source, copy)) throw new Error('backup verification failed; migration aborted');
  } catch (err) {
    try { rmSync(backupPath, { force: true }); } catch { /* preserve failure */ }
    throw err;
  } finally {
    copy.close();
  }
  try { chmodSync(backupPath, 0o600); } catch { /* best effort */ }
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
  private readonly upsertPolicyStmt: StatementSync;
  private readonly getPolicyStmt: StatementSync;
  private readonly listPoliciesStmt: StatementSync;
  private readonly listPoliciesByHarnessStmt: StatementSync;
  private readonly getConfigStmt: StatementSync;
  private readonly setConfigStmt: StatementSync;
  private readonly deleteAccountStmt: StatementSync;
  private readonly deleteSnapshotsByAccountStmt: StatementSync;
  private readonly deleteOverridesByAccountStmt: StatementSync;
  private readonly deletePollClaimsByAccountStmt: StatementSync;
  private readonly deleteLeaseByNameStmt: StatementSync;

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

    this.db = openStoreConnection(dbPath);
    try {
      this.db.exec('PRAGMA synchronous = NORMAL');
      // migrateIfNeeded takes the write lock and, when needed, backs up before
      // any constructor schema DDL is allowed to run.
      this.migrateIfNeeded();
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
        snapshot_json TEXT,
        strategy TEXT,
        provider TEXT
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
        account_id, mode, reason, snapshot_json, strategy, provider
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    this.upsertPolicyStmt = this.db.prepare(`
      INSERT INTO policies (
        harness, virtual_model, real_model, effort, fallback_json, session_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(harness, virtual_model) DO UPDATE SET
        real_model = excluded.real_model,
        effort = excluded.effort,
        fallback_json = excluded.fallback_json,
        session_mode = excluded.session_mode
    `);
    this.getPolicyStmt = this.db.prepare(
      'SELECT harness, virtual_model, real_model, effort, fallback_json, session_mode, created_at FROM policies WHERE harness = ? AND virtual_model = ?',
    );
    this.listPoliciesStmt = this.db.prepare(
      'SELECT harness, virtual_model, real_model, effort, fallback_json, session_mode, created_at FROM policies ORDER BY harness, virtual_model',
    );
    this.listPoliciesByHarnessStmt = this.db.prepare(
      'SELECT harness, virtual_model, real_model, effort, fallback_json, session_mode, created_at FROM policies WHERE harness = ? ORDER BY virtual_model',
    );
    this.getConfigStmt = this.db.prepare('SELECT value FROM config WHERE key = ?');
    this.setConfigStmt = this.db.prepare(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.deleteAccountStmt = this.db.prepare('DELETE FROM accounts WHERE id = ?');
    this.deleteSnapshotsByAccountStmt = this.db.prepare(
      'DELETE FROM snapshots WHERE account_id = ?',
    );
    this.deleteOverridesByAccountStmt = this.db.prepare(
      'DELETE FROM overrides WHERE account_id = ?',
    );
    this.deletePollClaimsByAccountStmt = this.db.prepare(
      'DELETE FROM poll_claims WHERE account_id = ?',
    );
    this.deleteLeaseByNameStmt = this.db.prepare('DELETE FROM leases WHERE name = ?');
    } catch (err) {
      try {
        this.db.close();
      } catch {
        // Best-effort cleanup; preserve the original initialization error.
      }
      throw err;
    }
  }

  /** Additive migration through the §3.2 v5 schema (including pre-release v5 correction). */
  private migrateIfNeeded(): void {
    const SCHEMA_VERSION = 5;
    const version = readUserVersion(this.db);
    if (version > SCHEMA_VERSION) {
      throw new Error(`qlb.db schema user_version=${version} is newer than this binary (${SCHEMA_VERSION}); upgrade qlb`);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (migrationNeeded(this.db)) {
        // This is deliberately inside the migration lock, after the backup.
        // It also lets a brand-new database migrate without constructor DDL.
        if (this.dbPath !== ':memory:') backupBeforeMigrateSync(this.dbPath, this.db);
        this.createCoreSchema();
        if (version < 2) {
          if (!hasColumn(this.db, 'accounts', 'grant_generation')) this.db.exec('ALTER TABLE accounts ADD COLUMN grant_generation INTEGER DEFAULT 0');
          this.db.exec('CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder_pid INTEGER, holder_id TEXT, until INTEGER, generation INTEGER)');
        }
        if (version < 3) {
          this.db.exec('CREATE TABLE IF NOT EXISTS migrations (store TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL, detail_json TEXT)');
        }
        if (version < 4) {
          this.db.exec('CREATE TABLE IF NOT EXISTS policies (harness TEXT, virtual_model TEXT, real_model TEXT, effort TEXT, fallback_json TEXT, session_mode TEXT, created_at INTEGER, PRIMARY KEY (harness, virtual_model))');
        }
        ensureDecisionColumnsOn(this.db);
        this.migrateV5Schema();
        this.db.exec('PRAGMA user_version = 5');
      }
      this.scrubReloginEvents();
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw err;
    }
  }

  /** One-time D-B23 scrub of rows predating the relogin field boundary. */
  private scrubReloginEvents(): void {
    const alreadyScrubbed = this.db.prepare("SELECT 1 FROM config WHERE key = 'relogin.scrubbedAt'").get();
    if (alreadyScrubbed) return;
    const rows = this.db.prepare('SELECT id, detail, evidence FROM relogin_events').all() as Array<{
      id: number;
      detail: unknown;
      evidence: unknown;
    }>;
    const update = this.db.prepare('UPDATE relogin_events SET detail = ?, evidence = ? WHERE id = ?');
    for (const row of rows) {
      const detail = row.detail == null
        ? null
        : typeof row.detail === 'string'
          ? reloginDetailValue(row.detail)
          : reloginDetailFingerprint(String(row.detail));
      const evidence = isReloginEvidenceClass(row.evidence) ? row.evidence : null;
      if (detail !== row.detail || evidence !== row.evidence) update.run(detail, evidence, row.id);
    }
    this.db.prepare("INSERT INTO config (key, value) VALUES ('relogin.scrubbedAt', ?)").run(String(Date.now()));
  }

  private createCoreSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, provider TEXT, label TEXT, status TEXT, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS snapshots (account_id TEXT, bucket TEXT, used_pct REAL, used REAL, limit_val REAL, remaining REAL, reset_at INTEGER, fetched_at INTEGER, source TEXT, confidence TEXT, PRIMARY KEY (account_id, bucket));
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, session TEXT, harness TEXT, requested_model TEXT, effort TEXT, served_model TEXT, account_id TEXT, mode TEXT, reason TEXT, snapshot_json TEXT, strategy TEXT, provider TEXT);
      CREATE TABLE IF NOT EXISTS overrides (kind TEXT, account_id TEXT, session TEXT, until INTEGER);
      CREATE TABLE IF NOT EXISTS poll_claims (account_id TEXT PRIMARY KEY, holder_id TEXT, claimed_at INTEGER, until INTEGER);
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  private migrateV5Schema(): void {
    if (this.tableExists('usage_polls') && !hasColumn(this.db, 'usage_polls', 'provider')) {
      const rows = this.db.prepare('SELECT account_id FROM usage_polls').all() as Array<{ account_id: string }>;
      const providerFor = this.db.prepare('SELECT provider FROM accounts WHERE id = ?');
      for (const row of rows) {
        const providers = providerFor.all(row.account_id) as Array<{ provider: string | null }>;
        if (providers.length !== 1 || !providers[0]?.provider) {
          throw new Error(`cannot correct pre-release v5 usage_polls: account_id '${row.account_id}' is ambiguous`);
        }
      }
      this.db.exec(`
        CREATE TABLE usage_polls_v5 (
          provider TEXT NOT NULL, account_id TEXT NOT NULL,
          -- Spec §3.2 usage_polls.poll_interval_s (D-B11).
          last_fetch_at INTEGER, last_attempt_at INTEGER, next_due_at INTEGER, poll_interval_s REAL,
          last_status TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
          backoff_until INTEGER, last_429_at INTEGER, held_until INTEGER,
          PRIMARY KEY (provider, account_id)
        )
      `);
      const copy = this.db.prepare(`INSERT INTO usage_polls_v5 (provider, account_id, last_fetch_at, last_attempt_at, next_due_at, last_status, consecutive_failures, backoff_until, last_429_at, held_until)
        SELECT ?, account_id, last_fetch_at, last_attempt_at, next_due_at, last_status, consecutive_failures, backoff_until, last_429_at, held_until FROM usage_polls WHERE account_id = ?`);
      for (const row of rows) {
        const provider = (providerFor.get(row.account_id) as { provider: string }).provider;
        copy.run(provider, row.account_id);
      }
      this.db.exec('DROP TABLE usage_polls; ALTER TABLE usage_polls_v5 RENAME TO usage_polls');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claude_slots (
        account_id TEXT PRIMARY KEY, slot_num INTEGER UNIQUE, email TEXT, alias TEXT, org_uuid TEXT,
        config_json TEXT NOT NULL, fingerprint TEXT, prev_fingerprint TEXT, threshold REAL,
        dead INTEGER NOT NULL DEFAULT 0, dead_reason TEXT, dead_at INTEGER, healed_at INTEGER,
        added_at INTEGER NOT NULL, last_active_at INTEGER, source TEXT, archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS codex_slots (
        account_id TEXT PRIMARY KEY, chatgpt_user_id TEXT NOT NULL, chatgpt_account_id TEXT NOT NULL,
        email TEXT, alias TEXT, fingerprint TEXT, prev_fingerprint TEXT, threshold REAL, last_refresh TEXT,
        dead INTEGER NOT NULL DEFAULT 0, dead_reason TEXT, dead_at INTEGER, healed_at INTEGER,
        pending_adopt INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, last_active_at INTEGER, source TEXT, archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS active_login (provider TEXT PRIMARY KEY, account_id TEXT, since INTEGER NOT NULL, set_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS switch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL, from_account TEXT, to_account TEXT NOT NULL,
        trigger TEXT NOT NULL, outcome TEXT NOT NULL, outgoing_kind TEXT, binding_json TEXT, steps_json TEXT, open_sessions_json TEXT, error TEXT,
        injected INTEGER NOT NULL DEFAULT 0, detail TEXT, published_at INTEGER, committed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS usage_polls (
        -- Spec §3.2 usage_polls.poll_interval_s (D-B11).
        provider TEXT NOT NULL, account_id TEXT NOT NULL, last_fetch_at INTEGER, last_attempt_at INTEGER, next_due_at INTEGER, poll_interval_s REAL,
        last_status TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, backoff_until INTEGER, last_429_at INTEGER, held_until INTEGER,
        PRIMARY KEY (provider, account_id)
      );
      CREATE TABLE IF NOT EXISTS relogin_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL, account_id TEXT,
        kind TEXT NOT NULL, detail TEXT, evidence TEXT, user_denied_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS health_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, phase TEXT NOT NULL, overall TEXT NOT NULL,
        failing_json TEXT NOT NULL, dead_slots_json TEXT NOT NULL, release_sha TEXT
      );
      CREATE TABLE IF NOT EXISTS lineage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL, account_id TEXT NOT NULL,
        from_fp TEXT, to_fp TEXT NOT NULL, cause TEXT NOT NULL, by TEXT NOT NULL, evidence TEXT
      );
      CREATE TABLE IF NOT EXISTS lifecycle (
        id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, began_at INTEGER NOT NULL, cutover_at INTEGER, window_end INTEGER,
        extended_at INTEGER, undo_began_at INTEGER, rollback_at INTEGER, retired_at INTEGER, closed_at INTEGER,
        release_sha TEXT, drill_done_at INTEGER, note TEXT, pre_fence_state TEXT
      );
      CREATE TABLE IF NOT EXISTS codex_watch (switch_id INTEGER PRIMARY KEY, provider TEXT NOT NULL, outgoing TEXT NOT NULL, target TEXT NOT NULL, next_at INTEGER NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS import_runs (run_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, committed_at INTEGER);
      CREATE TABLE IF NOT EXISTS pi_export_targets (provider TEXT NOT NULL, target TEXT NOT NULL, slot_account_id TEXT NOT NULL, lineage_fp TEXT NOT NULL, recorded_at INTEGER NOT NULL, PRIMARY KEY (provider, target));
      CREATE TABLE IF NOT EXISTS codex_live_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, identity TEXT, lineage_fp TEXT, by TEXT NOT NULL);
    `);
    // Spec §3.2 `usage_polls.poll_interval_s` (D-B11).
    this.addColumnIfMissing('usage_polls', 'poll_interval_s', 'REAL');
    this.addColumnIfMissing('claude_slots', 'archived_at', 'INTEGER');
    this.addColumnIfMissing('codex_slots', 'pending_adopt', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('codex_slots', 'archived_at', 'INTEGER');
    this.addColumnIfMissing('switch_log', 'injected', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('switch_log', 'detail', 'TEXT');
    this.addColumnIfMissing('switch_log', 'published_at', 'INTEGER');
    this.addColumnIfMissing('switch_log', 'committed_at', 'INTEGER');
    this.addColumnIfMissing('relogin_events', 'evidence', 'TEXT');
    this.addColumnIfMissing('relogin_events', 'user_denied_at', 'INTEGER');
    this.addColumnIfMissing('lineage_log', 'evidence', 'TEXT');
    this.addColumnIfMissing('lifecycle', 'pre_fence_state', 'TEXT');
    if (!lifecycleOneOpenIndexMatches(this.db)) {
      this.db.exec('DROP INDEX IF EXISTS lifecycle_one_open');
      this.db.exec(`${LIFECYCLE_ONE_OPEN_INDEX_SQL};`);
    }
  }

  private tableExists(table: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (this.tableExists(table) && !hasColumn(this.db, table, column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
      input.strategy ?? null,
      input.provider ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Read-only query over `decisions`. There is no `outcome` column — callers
   * (Phase 4 retirement) classify ok/failed from mode/reason/snapshot_json.
   */
  listDecisions(opts: {
    harnesses?: string[];
    sinceTs?: number;
  } = {}): DecisionRow[] {
    const since = opts.sinceTs ?? 0;
    const rows = this.db
      .prepare(
        `SELECT ${DECISION_SELECT}
         FROM decisions
         WHERE ts >= ?
         ORDER BY ts ASC`,
      )
      .all(since) as unknown as DecisionRow[];
    if (!opts.harnesses || opts.harnesses.length === 0) return rows;
    const allowed = new Set(opts.harnesses);
    return rows.filter((r) => r.harness != null && allowed.has(r.harness));
  }

  /** Newest-first audit read. Tie-break on id DESC. Does not change listDecisions. */
  listRecentDecisions(limit: number): DecisionRow[] {
    const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
    return this.db
      .prepare(
        `SELECT ${DECISION_SELECT}
         FROM decisions
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(n) as unknown as DecisionRow[];
  }

  listRoutingDecisions(limit: number): DecisionRow[] {
    const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
    return this.db
      .prepare(
        `SELECT ${DECISION_SELECT}
         FROM decisions
         WHERE mode IN (${ROUTING_MODE_SQL})
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(n) as unknown as DecisionRow[];
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
   * Persist next-poll plans as one short write transaction.  This deliberately
   * does not alter fetch, attempt, hold, or failure state, so the policy can
   * re-spread a wake-from-sleep cohort without claiming or polling it.
   */
  writeUsagePollPlans(
    provider: string,
    plans: Readonly<Record<string, {
      nextDueAt: number;
      pollIntervalS: number;
      expectedNextDueAt?: number | null;
      expectedPollIntervalS?: number | null;
    }>>,
    now?: number,
  ): number {
    const rows = Object.entries(plans);
    if (rows.length === 0) return 0;
    let written = 0;
    this.runImmediate(() => {
      const upsert = this.db.prepare(`
        INSERT INTO usage_polls (provider, account_id, next_due_at, poll_interval_s)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(provider, account_id) DO UPDATE SET
          next_due_at = excluded.next_due_at,
          poll_interval_s = excluded.poll_interval_s
      `);
      const repair = this.db.prepare(`
        UPDATE usage_polls SET next_due_at = ?, poll_interval_s = ?
        WHERE provider = ? AND account_id = ?
          AND next_due_at IS ? AND poll_interval_s IS ?
          AND last_status IS NOT 'token_dead'
          AND (backoff_until IS NULL OR backoff_until <= ?)
          AND (held_until IS NULL OR held_until <= ?)
      `);
      for (const [accountId, plan] of rows) {
        const isRepair = now !== undefined
          && Object.hasOwn(plan, 'expectedNextDueAt')
          && Object.hasOwn(plan, 'expectedPollIntervalS');
        const result = isRepair
          ? repair.run(plan.nextDueAt, plan.pollIntervalS, provider, accountId, plan.expectedNextDueAt ?? null, plan.expectedPollIntervalS ?? null, now, now)
          : upsert.run(provider, accountId, plan.nextDueAt, plan.pollIntervalS);
        written += Number(result.changes);
      }
    });
    return written;
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

  /**
   * Hard-delete an account and every row referencing it (`snapshots`,
   * `overrides`, `poll_claims`, refresh `leases`). No ownership check — the
   * prune path must use `pruneAccountIfUnowned` so the journal inspection
   * and this delete share one BEGIN IMMEDIATE.
   */
  deleteAccountCascade(accountId: string): {
    accounts: number;
    snapshots: number;
    overrides: number;
    pollClaims: number;
    leases: number;
  } {
    return this.runImmediate(() => this.deleteAccountCascadeUnlocked(accountId));
  }

  private deleteAccountCascadeUnlocked(accountId: string): {
    accounts: number;
    snapshots: number;
    overrides: number;
    pollClaims: number;
    leases: number;
  } {
    const snapshots = Number(this.deleteSnapshotsByAccountStmt.run(accountId).changes);
    const overrides = Number(this.deleteOverridesByAccountStmt.run(accountId).changes);
    const pollClaims = Number(this.deletePollClaimsByAccountStmt.run(accountId).changes);
    const leases = Number(this.deleteLeaseByNameStmt.run(refreshLeaseName(accountId)).changes);
    const accounts = Number(this.deleteAccountStmt.run(accountId).changes);
    return { accounts, snapshots, overrides, pollClaims, leases };
  }

  /**
   * Atomically: read the account, recovery marker, decode every journal row,
   * check provider consistency, and cascade-delete only if the account is
   * unprotected. One BEGIN IMMEDIATE covers check+delete. No filesystem,
   * Keychain, or network I/O inside this transaction.
   */
  pruneAccountIfUnowned(accountId: string):
    | {
        deleted: true;
        removed: {
          accounts: number;
          snapshots: number;
          overrides: number;
          pollClaims: number;
          leases: number;
        };
      }
    | { deleted: false; reason: string } {
    return this.runImmediate(() => {
      const account = this.getAccount(accountId);
      if (!account) {
        return { deleted: false as const, reason: 'no_such_account' };
      }
      if (this.getConfig('migrations.recovery_pending') !== null) {
        return { deleted: false as const, reason: 'recovery_pending' };
      }
      const safety = inspectAccountSafety(this.listMigrations(), accountId, (id) => {
        const row = this.getAccount(id);
        if (!row) return { present: false as const };
        return { present: true as const, provider: row.provider ?? null };
      });
      if (safety.unsafe) {
        return { deleted: false as const, reason: safetyRefusalMessage(accountId, safety) };
      }
      return { deleted: true as const, removed: this.deleteAccountCascadeUnlocked(accountId) };
    });
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

  upsertPolicy(row: {
    harness: string;
    virtualModel: string;
    realModel: string;
    effort: string;
    fallback?: string[];
    sessionMode?: string;
    createdAt?: number;
  }): void {
    this.upsertPolicyStmt.run(
      row.harness,
      row.virtualModel,
      row.realModel,
      row.effort,
      JSON.stringify(row.fallback ?? []),
      row.sessionMode ?? 'header',
      row.createdAt ?? Date.now(),
    );
  }

  getPolicy(harness: string, virtualModel: string): PolicyRow | null {
    const row = this.getPolicyStmt.get(harness, virtualModel) as PolicyRow | undefined;
    return row ?? null;
  }

  listPolicies(harness?: string): PolicyRow[] {
    const rows = harness
      ? this.listPoliciesByHarnessStmt.all(harness)
      : this.listPoliciesStmt.all();
    return rows as unknown as PolicyRow[];
  }

  getConfig(key: string): string | null {
    const row = this.getConfigStmt.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.setConfigStmt.run(key, value);
  }

  /** Settings.py:128-170 bounds; out-of-range persisted strings clamp, not reject. */
  getAutoswitchSettings(): AutoswitchSettings {
    // settings.py:128-134: threshold and weeklyThreshold are 50..99.9.
    const threshold = clampedConfigNumber(this.getConfig('autoswitch.threshold'), 90, 50, 99.9);
    const weeklyRaw = this.getConfig('autoswitch.weeklyThreshold');
    // settings.py:137-139: intervalSeconds is 15..3600 seconds.
    const intervalSeconds = clampedConfigNumber(this.getConfig('autoswitch.intervalSeconds'), 60, 15, 3600);
    // settings.py:141-143: cooldownSeconds is 0..86400 seconds.
    const cooldownSeconds = clampedConfigNumber(this.getConfig('autoswitch.cooldownSeconds'), 300, 0, 86400);
    // settings.py:145-147: hysteresisPct is 0..50.
    const hysteresisPct = clampedConfigNumber(this.getConfig('autoswitch.hysteresisPct'), 10, 0, 50);
    // settings.py:158-160: unhealthyTicks is an integer from 1..100.
    const unhealthyTicks = clampedConfigNumber(this.getConfig('autoswitch.unhealthyTicks'), 3, 1, 100, true);
    const strategyRaw = this.getConfig('autoswitch.strategy');
    return {
      threshold,
      weeklyThreshold: weeklyRaw == null || weeklyRaw.trim() === '' ? null : clampedConfigNumber(weeklyRaw, threshold, 50, 99.9),
      intervalSeconds,
      cooldownSeconds,
      hysteresisPct,
      unhealthyTicks,
      strategy: strategyRaw === 'consume-first' ? 'consume-first' : 'best',
    };
  }

  recordSwitch(row: {
    ts?: number; provider: string; fromAccount?: string | null; toAccount: string; trigger: string; outcome: string;
    outgoingKind?: string | null; bindingJson?: string | null; stepsJson?: string | null; openSessionsJson?: string | null;
    error?: string | null; injected?: boolean; detail?: string | null; publishedAt?: number | null; committedAt?: number | null;
  }): number {
    const result = this.db.prepare(`INSERT INTO switch_log (ts, provider, from_account, to_account, trigger, outcome, outgoing_kind, binding_json, steps_json, open_sessions_json, error, injected, detail, published_at, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.ts ?? Date.now(), row.provider, row.fromAccount ?? null, row.toAccount, row.trigger, row.outcome,
      row.outgoingKind ?? null, row.bindingJson ?? null, row.stepsJson ?? null, row.openSessionsJson ?? null,
      row.error == null ? null : redactSecrets(row.error, []), row.injected ? 1 : 0,
      row.detail == null ? null : redactSecrets(row.detail, []), row.publishedAt ?? null, row.committedAt ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  recordLineage(row: {
    ts?: number; provider: string; accountId: string; fromFp?: string | null; toFp: string; cause: string; by: string; evidence?: string | null;
  }): number {
    const result = this.db.prepare('INSERT INTO lineage_log (ts, provider, account_id, from_fp, to_fp, cause, by, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.ts ?? Date.now(), row.provider, row.accountId, row.fromFp ?? null, row.toFp, row.cause, row.by,
      row.evidence == null ? null : redactSecrets(row.evidence, []),
    );
    return Number(result.lastInsertRowid);
  }

  /** Read the immutable per-slot graph used by lineage-log.ts to prove successor order (S46). */
  listLineageTransitions(provider: string, accountId: string): LineageTransitionRow[] {
    return this.db.prepare(
      'SELECT from_fp, to_fp FROM lineage_log WHERE provider = ? AND account_id = ? ORDER BY id ASC',
    ).all(provider, accountId) as unknown as LineageTransitionRow[];
  }

  /** Return the slot's persisted `:prev` edge; unknown providers have no slot table. */
  getSlotLineage(provider: string, accountId: string): SlotLineageRow | null {
    const table = provider === 'anthropic'
      ? 'claude_slots'
      : provider === 'openai-codex'
        ? 'codex_slots'
        : null;
    if (!table) return null;
    const row = this.db.prepare(`SELECT fingerprint, prev_fingerprint FROM ${table} WHERE account_id = ?`).get(accountId);
    return (row as SlotLineageRow | undefined) ?? null;
  }

  recordRelogin(row: { ts?: number; provider: string; accountId?: string | null; kind: string; detail?: string | null; evidence?: string | null; userDeniedAt?: number | null }): number {
    const detail = row.detail ?? null;
    const evidence = row.evidence ?? null;
    assertStoredReloginFields(detail, evidence);
    const result = this.db.prepare('INSERT INTO relogin_events (ts, provider, account_id, kind, detail, evidence, user_denied_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      row.ts ?? Date.now(), row.provider, row.accountId ?? null, row.kind,
      detail, evidence, row.userDeniedAt ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getPinOverride(session: string, now: number = Date.now()): OverrideRow | null {
    const row = this.db
      .prepare(
        `SELECT kind, account_id, session, until FROM overrides
         WHERE kind = 'pin' AND session = ? AND (until IS NULL OR until > ?)
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(session, now) as OverrideRow | undefined;
    return row ?? null;
  }

  listActiveOverrides(now: number = Date.now()): OverrideRow[] {
    return this.db
      .prepare(
        `SELECT kind, account_id, session, until FROM overrides
         WHERE until IS NULL OR until > ?
         ORDER BY kind, account_id, session`,
      )
      .all(now) as unknown as OverrideRow[];
  }

  upsertOverride(row: {
    kind: string;
    accountId: string;
    session?: string | null;
    until: number | null;
  }): OverrideRow {
    const session = row.session ?? null;
    this.runImmediate(() => {
      if (row.kind === 'pin') {
        this.db
          .prepare(`DELETE FROM overrides WHERE kind = 'pin' AND session = ?`)
          .run(session);
      } else {
        this.db
          .prepare(
            `DELETE FROM overrides WHERE kind = ? AND account_id = ? AND (session IS NULL OR session = ?)`,
          )
          .run(row.kind, row.accountId, session);
      }
      this.db
        .prepare(
          `INSERT INTO overrides (kind, account_id, session, until) VALUES (?, ?, ?, ?)`,
        )
        .run(row.kind, row.accountId, session, row.until);
    });
    return {
      kind: row.kind,
      account_id: row.accountId,
      session,
      until: row.until,
    };
  }

  clearOverrides(opts: {
    session?: string;
    accountId?: string;
    all?: boolean;
    now?: number;
  }): number {
    return this.runImmediate(() => {
      if (opts.all) {
        const result = this.db.prepare('DELETE FROM overrides').run();
        return Number(result.changes);
      }
      if (opts.session) {
        const result = this.db
          .prepare('DELETE FROM overrides WHERE session = ?')
          .run(opts.session);
        return Number(result.changes);
      }
      if (opts.accountId) {
        const result = this.db
          .prepare('DELETE FROM overrides WHERE account_id = ?')
          .run(opts.accountId);
        return Number(result.changes);
      }
      return 0;
    });
  }

  /**
   * Atomically increment a per-provider round-robin index modulo `count`.
   * Uses BEGIN IMMEDIATE so concurrent resolvers cannot observe the same slot.
   */
  nextRoundRobinIndex(key: string, count: number): number {
    if (count <= 0) return 0;
    return this.runImmediate(() => {
      const raw = this.getConfig(key);
      const last = raw != null && /^-?\d+$/.test(raw) ? Number(raw) : -1;
      const next = (last + 1) % count;
      this.setConfig(key, String(next));
      return next;
    });
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
