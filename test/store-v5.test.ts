import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { openStore } from '../src/store';

const support = join(__dirname, '..', '..', 'test', 'support');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildV4Store } = require(join(support, 'v4-fixture.cjs')) as {
  buildV4Store: (path: string, rows?: Array<Record<string, unknown>>) => string;
};

function dbAt(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function v4Snapshot(path: string): { tables: string[]; columns: Record<string, string[]>; rows: Record<string, unknown[]> } {
  const db = dbAt(path);
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    return {
      tables,
      columns: Object.fromEntries(tables.map((table) => [table, columns(db, table)])),
      rows: Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    };
  } finally { db.close(); }
}

describe('store v5 schema (AC38)', () => {
  it('creates the §3.2 v5 tables and columns on a fresh database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-v5-')), 'qlb.db');
    const store = openStore(path);
    store.close();
    const db = dbAt(path);
    try {
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5);
      assert.deepEqual(columns(db, 'lineage_log'), ['id', 'ts', 'provider', 'account_id', 'from_fp', 'to_fp', 'cause', 'by', 'evidence']);
      assert.deepEqual(columns(db, 'lifecycle'), ['id', 'state', 'began_at', 'cutover_at', 'window_end', 'extended_at', 'undo_began_at', 'rollback_at', 'retired_at', 'closed_at', 'release_sha', 'drill_done_at', 'note', 'pre_fence_state']);
      assert.ok(columns(db, 'switch_log').includes('injected'));
      assert.ok(columns(db, 'switch_log').includes('detail'));
      assert.ok(columns(db, 'switch_log').includes('published_at'));
      assert.ok(columns(db, 'switch_log').includes('committed_at'));
      assert.ok(columns(db, 'codex_slots').includes('pending_adopt'));
      assert.ok(columns(db, 'codex_slots').includes('archived_at'));
      assert.ok(columns(db, 'claude_slots').includes('archived_at'));
      assert.ok(columns(db, 'relogin_events').includes('evidence'));
      assert.ok(columns(db, 'relogin_events').includes('user_denied_at'));
      for (const table of ['codex_watch', 'import_runs', 'pi_export_targets', 'codex_live_observations']) {
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
      }
      const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'lifecycle_one_open'").get() as { sql: string };
      assert.match(index.sql, /aborted/);
    } finally { db.close(); }
  });

  it('corrects a v5 database missing poll_interval_s after a verified backup, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-v5-poll-interval-correct-'));
    const path = join(dir, 'qlb.db');
    const initial = openStore(path);
    initial.close();
    const backupsBefore = readdirSync(join(dir, 'backups')).filter((file) => file.endsWith('.sqlite'));
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE usage_polls DROP COLUMN poll_interval_s');
    db.close();

    const corrected = openStore(path);
    corrected.close();
    const backups = readdirSync(join(dir, 'backups')).filter((file) => file.endsWith('.sqlite'));
    assert.equal(backups.length, backupsBefore.length + 1);
    const correctionBackup = backups.find((file) => !backupsBefore.includes(file));
    assert.ok(correctionBackup);
    const backup = dbAt(join(dir, 'backups', correctionBackup));
    try { assert.ok(!columns(backup, 'usage_polls').includes('poll_interval_s')); } finally { backup.close(); }
    const check = dbAt(path);
    try { assert.ok(columns(check, 'usage_polls').includes('poll_interval_s')); } finally { check.close(); }

    const reopened = openStore(path);
    reopened.close();
    assert.equal(readdirSync(join(dir, 'backups')).filter((file) => file.endsWith('.sqlite')).length, backups.length);
  });

  it('rebuilds a pre-release lifecycle index whose predicate omits aborted', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-v5-index-correct-')), 'qlb.db');
    const initial = openStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.exec(`DROP INDEX lifecycle_one_open;
      CREATE UNIQUE INDEX lifecycle_one_open ON lifecycle ((1))
      WHERE state IN ('cutting-over','cutover','undoing','rolled-back','retired')`);
    db.close();

    const corrected = openStore(path);
    corrected.close();
    const check = dbAt(path);
    try {
      const index = check.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'lifecycle_one_open'").get() as { sql: string };
      assert.equal(index.sql.replace(/\s+/g, ' ').toLowerCase(), "create unique index lifecycle_one_open on lifecycle ((1)) where state in ('cutting-over','cutover','undoing','rolled-back','retired','aborted')");
    } finally { check.close(); }
  });

  it('corrects a pre-release v5 usage_polls shape in place and preserves unambiguous rows', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-v5-correct-')), 'qlb.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT, label TEXT, status TEXT, created_at INTEGER, grant_generation INTEGER DEFAULT 0);
      CREATE TABLE leases (name TEXT PRIMARY KEY, holder_pid INTEGER, holder_id TEXT, until INTEGER, generation INTEGER);
      CREATE TABLE migrations (store TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL, detail_json TEXT);
      CREATE TABLE policies (harness TEXT, virtual_model TEXT, real_model TEXT, effort TEXT, fallback_json TEXT, session_mode TEXT, created_at INTEGER, PRIMARY KEY (harness, virtual_model));
      CREATE TABLE usage_polls (account_id TEXT PRIMARY KEY, last_fetch_at INTEGER, last_attempt_at INTEGER, next_due_at INTEGER, last_status TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, backoff_until INTEGER, last_429_at INTEGER, held_until INTEGER);
      INSERT INTO accounts VALUES ('a', 'anthropic', 'a', 'active', 1, 0);
      INSERT INTO usage_polls (account_id, last_fetch_at) VALUES ('a', 9);
      PRAGMA user_version = 5`);
    db.close();
    const store = openStore(path);
    store.close();
    const check = dbAt(path);
    try {
      assert.deepEqual(columns(check, 'usage_polls').slice(0, 2), ['provider', 'account_id']);
      const row = check.prepare('SELECT provider, account_id, last_fetch_at FROM usage_polls').get() as { provider: string; account_id: string; last_fetch_at: number };
      assert.equal(row.provider, 'anthropic');
      assert.equal(row.account_id, 'a');
      assert.equal(row.last_fetch_at, 9);
    } finally { check.close(); }
  });

  it('a v4→v5 migration that fails partway rolls back completely', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-v5-rollback-')), 'qlb.db');
    buildV4Store(path, [{
      ts: 7,
      requested_model: 'claude-sonnet-5',
      account_id: 'fixture-account',
      account_provider: 'anthropic',
      mode: 'headroom',
      reason: 'fixture-row',
      snapshot_json: '{"fixture":true}',
    }]);
    const db = new DatabaseSync(path);
    // This view conflicts with a later v5 CREATE TABLE, after decision-column DDL ran.
    db.exec(`
      CREATE TABLE usage_polls (account_id TEXT PRIMARY KEY, last_fetch_at INTEGER);
      INSERT INTO usage_polls VALUES ('fixture-account', 7);
      CREATE VIEW usage_polls_v5 AS SELECT 1 AS fixture_usage_poll;
    `);
    db.close();
    const before = v4Snapshot(path);
    const beforeUsagePollColumns = (() => {
      const check = dbAt(path);
      try { return columns(check, 'usage_polls'); } finally { check.close(); }
    })();

    // The constructor closes its connection after a failed open, which would
    // otherwise implicitly roll back an uncommitted transaction. Commit there
    // only in this fixture so this assertion proves migrateIfNeeded rolled back.
    const close = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function (this: DatabaseSync): void {
      try { this.exec('COMMIT'); } catch { /* an explicit rollback leaves nothing to commit */ }
      close.call(this);
    };
    try {
      assert.throws(() => openStore(path));
    } finally {
      DatabaseSync.prototype.close = close;
    }

    const check = dbAt(path);
    try {
      assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
      assert.deepEqual(v4Snapshot(path), before);
      assert.deepEqual(columns(check, 'usage_polls'), beforeUsagePollColumns);
      assert.equal((check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      const rows = check.prepare('SELECT account_id, reason, snapshot_json FROM decisions').all() as Array<{
        account_id: string;
        reason: string;
        snapshot_json: string;
      }>;
      assert.deepEqual(
        rows.map(({ account_id, reason, snapshot_json }) => ({ account_id, reason, snapshot_json })),
        [{ account_id: 'fixture-account', reason: 'fixture-row', snapshot_json: '{"fixture":true}' }],
      );
    } finally { check.close(); }
  });

  it('clamps autoswitch settings to the settings.py bounds', () => {
    const store = openStore(':memory:');
    try {
      store.setConfig('autoswitch.threshold', '101');
      store.setConfig('autoswitch.intervalSeconds', '1');
      store.setConfig('autoswitch.unhealthyTicks', '999');
      const settings = store.getAutoswitchSettings();
      assert.equal(settings.threshold, 99.9);
      assert.equal(settings.intervalSeconds, 15);
      assert.equal(settings.unhealthyTicks, 100);
    } finally { store.close(); }
  });

  it('redacts token-shaped detail and evidence text without changing ids or fingerprints', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-v5-redact-')), 'qlb.db');
    const store = openStore(path);
    store.recordSwitch({ ts: 1, provider: 'anthropic', toAccount: 'id-sk-abcdefghijklmnop', trigger: 'manual', outcome: 'failed', detail: 'Bearer abcdefghijklmnopqrstuvwx' });
    store.recordLineage({ ts: 2, provider: 'anthropic', accountId: 'id', toFp: 'fp-sk-abcdefghijklmnop', cause: 'adopt', by: 'tool', evidence: 'sk-abcdefghijklmnop' });
    store.close();
    const db = dbAt(path);
    try {
      assert.match((db.prepare('SELECT detail FROM switch_log').get() as { detail: string }).detail, /\[redacted\]/);
      const row = db.prepare('SELECT account_id, to_fp, evidence FROM lineage_log').get() as { account_id: string; to_fp: string; evidence: string };
      assert.equal(row.account_id, 'id');
      assert.equal(row.to_fp, 'fp-sk-abcdefghijklmnop');
      assert.equal(row.evidence, '[redacted]');
    } finally { db.close(); }
  });
});
