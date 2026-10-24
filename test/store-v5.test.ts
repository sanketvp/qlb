import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { openStore } from '../src/store';

function dbAt(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
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
