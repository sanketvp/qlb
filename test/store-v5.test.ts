import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  it('backs up and corrects user_version=5 databases missing a §3.2 table or column', () => {
    const tablePath = join(mkdtempSync(join(tmpdir(), 'qlb-v5-table-correct-')), 'qlb.db');
    const columnPath = join(mkdtempSync(join(tmpdir(), 'qlb-v5-column-correct-')), 'qlb.db');

    for (const [path, change] of [
      [tablePath, 'DROP TABLE active_login'],
      [columnPath, 'ALTER TABLE decisions DROP COLUMN provider'],
    ] as const) {
      const initial = openStore(path);
      initial.upsertAccount('fixture-account', 'anthropic', 'fixture');
      initial.close();
      const db = new DatabaseSync(path);
      db.exec(change);
      db.close();

      const backupsDir = join(dirname(path), 'backups');
      const beforeBackups = new Set(readdirSync(backupsDir));
      const corrected = openStore(path);
      corrected.close();

      const newBackups = readdirSync(backupsDir).filter((name) => !beforeBackups.has(name) && name.endsWith('.sqlite'));
      assert.equal(newBackups.length, 1, 'the correction must take a backup first');
      const backup = dbAt(join(backupsDir, newBackups[0]));
      try {
        assert.equal((backup.prepare('SELECT provider FROM accounts WHERE id = ?').get('fixture-account') as { provider: string }).provider, 'anthropic');
      } finally { backup.close(); }
    }

    const tableCheck = dbAt(tablePath);
    const columnCheck = dbAt(columnPath);
    try {
      assert.ok(tableCheck.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'active_login'").get());
      assert.ok(columns(columnCheck, 'decisions').includes('provider'));
      for (const db of [tableCheck, columnCheck]) {
        assert.equal((db.prepare('SELECT provider FROM accounts WHERE id = ?').get('fixture-account') as { provider: string }).provider, 'anthropic');
      }
    } finally {
      tableCheck.close();
      columnCheck.close();
    }
  });

  it('adds repairable missing columns without losing extra columns, indexes, or triggers', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-v5-safe-repair-')), 'qlb.db');
    const initial = openStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.exec(`ALTER TABLE decisions DROP COLUMN provider;
      ALTER TABLE decisions ADD COLUMN forward_compatible TEXT;
      CREATE INDEX decisions_forward_compatible ON decisions(forward_compatible);
      CREATE TABLE decision_audit (value TEXT);
      CREATE TRIGGER decisions_audit AFTER INSERT ON decisions BEGIN
        INSERT INTO decision_audit VALUES (NEW.forward_compatible);
      END;
      INSERT INTO decisions (ts, requested_model, mode, reason, snapshot_json, forward_compatible)
        VALUES (1, 'model', 'headroom', 'fixture', '{}', 'retain-me')`);
    db.close();

    const corrected = openStore(path);
    corrected.close();
    const check = dbAt(path);
    try {
      assert.deepEqual(
        (check.prepare('SELECT forward_compatible FROM decisions').all() as Array<{ forward_compatible: string }>).map((row) => ({ ...row })),
        [{ forward_compatible: 'retain-me' }],
      );
      assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'decisions_forward_compatible'").get());
      assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'decisions_audit'").get());
    } finally { check.close(); }
  });

  it('refuses populated tables missing required v5 columns but repairs empty ones', () => {
    const populatedPath = join(mkdtempSync(join(tmpdir(), 'qlb-v5-required-populated-')), 'qlb.db');
    const emptyPath = join(mkdtempSync(join(tmpdir(), 'qlb-v5-required-empty-')), 'qlb.db');
    for (const [path, populated] of [[populatedPath, true], [emptyPath, false]] as const) {
      const initial = openStore(path);
      initial.close();
      const db = new DatabaseSync(path);
      db.exec('ALTER TABLE claude_slots DROP COLUMN config_json');
      if (populated) db.exec("INSERT INTO claude_slots (account_id, added_at) VALUES ('fixture', 1)");
      db.close();
    }

    assert.throws(() => openStore(populatedPath), /populated table is missing required column\(s\) config_json/);
    const populated = dbAt(populatedPath);
    try {
      assert.equal(columns(populated, 'claude_slots').includes('config_json'), false);
      assert.deepEqual(
        (populated.prepare('SELECT account_id, added_at FROM claude_slots').all() as Array<{ account_id: string; added_at: number }>).map((row) => ({ ...row })),
        [{ account_id: 'fixture', added_at: 1 }],
      );
    } finally { populated.close(); }

    const repaired = openStore(emptyPath);
    repaired.close();
    const empty = dbAt(emptyPath);
    try {
      assert.ok(columns(empty, 'claude_slots').includes('config_json'));
    } finally { empty.close(); }
  });

  it('rebuilds a canonical pre-release table missing slot_num UNIQUE and preserves data, indexes, and triggers', () => {
    for (const populated of [false, true]) {
      const path = join(mkdtempSync(join(tmpdir(), `qlb-v5-rebuild-${populated ? 'populated' : 'empty'}-`)), 'qlb.db');
      const initial = openStore(path);
      initial.close();
      const db = new DatabaseSync(path);
      db.exec(`DROP TABLE claude_slots;
        CREATE TABLE claude_slots (
          account_id TEXT PRIMARY KEY, slot_num INTEGER, email TEXT, alias TEXT, org_uuid TEXT, config_json TEXT NOT NULL,
          fingerprint TEXT, prev_fingerprint TEXT, threshold REAL, dead INTEGER NOT NULL DEFAULT 0,
          dead_reason TEXT, dead_at INTEGER, healed_at INTEGER, added_at INTEGER NOT NULL,
          last_active_at INTEGER, source TEXT, archived_at INTEGER
        );
        CREATE INDEX claude_slots_alias ON claude_slots(alias);
        CREATE TABLE claude_slot_audit (value TEXT);
        CREATE TRIGGER claude_slots_audit AFTER INSERT ON claude_slots BEGIN
          INSERT INTO claude_slot_audit VALUES (NEW.alias);
        END;`);
      if (populated) {
        db.exec("INSERT INTO claude_slots (account_id, slot_num, alias, config_json, added_at) VALUES ('fixture', 1, 'retain-me', '{}', 1)");
      }
      db.close();

      const corrected = openStore(path);
      corrected.close();
      const check = dbAt(path);
      try {
        assert.ok(columns(check, 'claude_slots').includes('slot_num'));
        assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'claude_slots_alias'").get());
        assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'claude_slots_audit'").get());
        const uniqueIndexes = check.prepare('PRAGMA index_list(claude_slots)').all() as Array<{ name: string; unique: number }>;
        assert.ok(uniqueIndexes.some((index) => index.unique === 1 && (check.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).some((column) => column.name === 'slot_num')));
        if (populated) assert.equal((check.prepare('SELECT alias FROM claude_slots').get() as { alias: string }).alias, 'retain-me');
      } finally { check.close(); }
    }
  });

  it('refuses inexact rebuilds after verifying a backup and keeps the database unchanged', () => {
    const cases = [
      {
        name: 'a plain extra column',
        extra: 'forward_compatible TEXT',
        dependent: '',
        reason: /column forward_compatible is not in the canonical definition/,
      },
      {
        name: 'an extra generated column',
        extra: 'forward_compatible TEXT GENERATED ALWAYS AS (upper(alias)) VIRTUAL',
        dependent: '',
        reason: /column forward_compatible is not in the canonical definition/,
      },
      {
        name: 'an extra PRIMARY KEY column',
        accountId: 'account_id TEXT',
        extra: 'forward_compatible INTEGER PRIMARY KEY',
        dependent: '',
        reason: /column forward_compatible is not in the canonical definition/,
      },
      {
        name: 'an extra column with a comma-bearing default and CHECK',
        extra: "forward_compatible TEXT DEFAULT 'a,b' CHECK (forward_compatible <> 'x')",
        dependent: '',
        reason: /column forward_compatible is not in the canonical definition/,
      },
      {
        name: 'different primary-key columns',
        accountId: 'account_id TEXT',
        extra: '',
        dependent: '',
        reason: /primary-key columns differ from the canonical definition/,
      },
      {
        name: 'a foreign key declared by the table',
        extra: 'FOREIGN KEY (account_id) REFERENCES accounts(id)',
        dependent: '',
        reason: /foreign-key definition differs from the canonical definition/,
      },
      {
        name: 'a foreign key on another table that references it',
        extra: '',
        dependent: `CREATE TABLE claude_slot_children (account_id TEXT REFERENCES claude_slots(account_id) ON DELETE CASCADE);
          INSERT INTO claude_slots (account_id, config_json, added_at) VALUES ('fixture', '{}', 1);
          INSERT INTO claude_slot_children VALUES ('fixture')`,
        reason: /foreign key on claude_slot_children references claude_slots/,
        childRows: true,
      },
      {
        name: 'a view that references the table',
        extra: '',
        dependent: 'CREATE VIEW claude_slots_view AS SELECT account_id FROM claude_slots',
        reason: /view claude_slots_view references claude_slots/,
      },
      {
        name: 'a trigger on another table that references the table',
        extra: '',
        dependent: `CREATE TABLE slot_audit (id INTEGER PRIMARY KEY);
          CREATE TRIGGER slot_audit_touch AFTER INSERT ON slot_audit BEGIN
            SELECT account_id FROM claude_slots;
          END`,
        reason: /trigger slot_audit_touch on another table references claude_slots/,
      },
    ];

    for (const fixture of cases) {
      const path = join(mkdtempSync(join(tmpdir(), 'qlb-v5-inexact-rebuild-')), 'qlb.db');
      const initial = openStore(path);
      initial.close();
      const db = new DatabaseSync(path);
      db.exec(`DROP TABLE claude_slots;
        CREATE TABLE claude_slots (
          ${fixture.accountId ?? 'account_id TEXT PRIMARY KEY'}, email TEXT, alias TEXT, org_uuid TEXT, config_json TEXT NOT NULL,
          fingerprint TEXT, prev_fingerprint TEXT, threshold REAL, dead INTEGER NOT NULL DEFAULT 0,
          dead_reason TEXT, dead_at INTEGER, healed_at INTEGER, added_at INTEGER NOT NULL,
          last_active_at INTEGER, source TEXT, archived_at INTEGER${fixture.extra ? `, ${fixture.extra}` : ''}
        );
        ${fixture.dependent}`);
      db.close();
      const before = readFileSync(path);

      assert.throws(
        () => openStore(path),
        (error: unknown) => error instanceof Error
          && error.message.includes('cannot correct pre-release v5 claude_slots')
          && error.message.includes('verified backup:')
          && fixture.reason.test(error.message),
        fixture.name,
      );
      assert.deepEqual(readFileSync(path), before, `${fixture.name} must leave the database byte-for-byte unchanged`);
      if (fixture.childRows) {
        const check = dbAt(path);
        try {
          assert.equal((check.prepare('SELECT count(*) AS count FROM claude_slot_children').get() as { count: number }).count, 1);
        } finally { check.close(); }
      }
    }
  });

  it('repairs a lifecycle table missing state before creating its partial index', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-v5-lifecycle-state-')), 'qlb.db');
    const initial = openStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.exec("INSERT INTO lifecycle (id, state, began_at) VALUES (5, 'closed', 1); DELETE FROM lifecycle; DROP INDEX lifecycle_one_open; ALTER TABLE lifecycle DROP COLUMN state; DELETE FROM sqlite_sequence WHERE name = 'lifecycle'; INSERT INTO sqlite_sequence (name, seq) VALUES ('lifecycle', 5)");
    db.close();
    const corrected = openStore(path);
    corrected.close();
    const check = new DatabaseSync(path);
    try {
      assert.ok(columns(check, 'lifecycle').includes('state'));
      assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'lifecycle_one_open'").get());
      check.exec("INSERT INTO lifecycle (state, began_at) VALUES ('closed', 2)");
      assert.equal((check.prepare('SELECT id FROM lifecycle').get() as { id: number }).id, 6);
    } finally { check.close(); }
  });

  it('corrects mismatched v5 column constraints and refuses duplicate values that violate new uniqueness', () => {
    const repairedPath = join(mkdtempSync(join(tmpdir(), 'qlb-v5-shape-repair-')), 'qlb.db');
    const duplicatePath = join(mkdtempSync(join(tmpdir(), 'qlb-v5-duplicate-refusal-')), 'qlb.db');
    for (const [path, duplicate] of [[repairedPath, false], [duplicatePath, true]] as const) {
      const initial = openStore(path);
      initial.close();
      const db = new DatabaseSync(path);
      db.exec('DROP TABLE claude_slots');
      db.exec(`CREATE TABLE claude_slots (
        account_id TEXT PRIMARY KEY, slot_num INTEGER, email TEXT, alias TEXT, org_uuid TEXT,
        config_json TEXT${duplicate ? ' NOT NULL' : ''}, fingerprint TEXT, prev_fingerprint TEXT, threshold REAL,
        dead INTEGER NOT NULL DEFAULT 0, dead_reason TEXT, dead_at INTEGER, healed_at INTEGER,
        added_at INTEGER NOT NULL, last_active_at INTEGER, source TEXT, archived_at INTEGER
      )`);
      if (duplicate) {
        db.exec("INSERT INTO claude_slots (account_id, slot_num, config_json, added_at) VALUES ('one', 1, '{}', 1), ('two', 1, '{}', 2)");
      } else {
        db.exec("INSERT INTO claude_slots (account_id, config_json, added_at) VALUES ('fixture', '{}', 1)");
      }
      db.close();
    }

    const repaired = openStore(repairedPath);
    repaired.close();
    const repairedCheck = dbAt(repairedPath);
    try {
      const config = repairedCheck.prepare('PRAGMA table_info(claude_slots)').all() as Array<{ name: string; notnull: number }>;
      assert.equal(config.find((column) => column.name === 'config_json')?.notnull, 1);
      const uniqueIndexes = repairedCheck.prepare('PRAGMA index_list(claude_slots)').all() as Array<{ name: string; unique: number }>;
      assert.equal(uniqueIndexes.some((index) => index.unique === 1 && (repairedCheck.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).some((column) => column.name === 'slot_num')), true);
    } finally { repairedCheck.close(); }

    assert.throws(() => openStore(duplicatePath), /cannot correct pre-release v5 claude_slots: copied rows violate new constraints/);
    const duplicateCheck = dbAt(duplicatePath);
    try {
      assert.equal((duplicateCheck.prepare('SELECT count(*) AS count FROM claude_slots WHERE slot_num = 1').get() as { count: number }).count, 2);
      const uniqueIndexes = duplicateCheck.prepare('PRAGMA index_list(claude_slots)').all() as Array<{ name: string; unique: number }>;
      assert.equal(uniqueIndexes.some((index) => index.unique === 1 && (duplicateCheck.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).some((column) => column.name === 'slot_num')), false, 'slot_num remains non-unique after rollback');
    } finally { duplicateCheck.close(); }
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

  it('redacts sensitive recordSwitch JSON keys at every depth while preserving valid JSON', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-v5-switch-redact-')), 'qlb.db');
    const store = openStore(path);
    const payload = {
      password: 'hunter2',
      nested: [{ authorization: 'Basic abc', cookie: 'session=value' }],
      credentials: { refresh_token: 'refresh-value', access_token: 'access-value' },
    };
    store.recordSwitch({
      ts: 1,
      provider: 'anthropic',
      toAccount: 'id',
      trigger: 'manual',
      outcome: 'failed',
      bindingJson: JSON.stringify(payload),
      stepsJson: JSON.stringify(payload),
      openSessionsJson: JSON.stringify(payload),
    });
    store.close();

    const db = dbAt(path);
    try {
      const row = db.prepare('SELECT binding_json, steps_json, open_sessions_json FROM switch_log').get() as Record<string, string>;
      for (const value of Object.values(row)) {
        for (const secret of ['hunter2', 'Basic abc', 'session=value', 'refresh-value', 'access-value']) assert.equal(value.includes(secret), false);
        assert.deepEqual(JSON.parse(value), {
          password: '[redacted]',
          nested: [{ authorization: '[redacted]', cookie: '[redacted]' }],
          credentials: '[redacted]',
        });
      }
    } finally { db.close(); }
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
