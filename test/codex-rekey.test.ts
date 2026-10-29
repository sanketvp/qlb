import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { observationConfigKey } from '../src/candidates';
import { applyCodexRekey, ensureCodexSlotAccount, planCodexRekey } from '../src/codex-rekey';
import { platformKeychain, type KeychainBackend } from '../src/keychain';
import { failoverConfigKey } from '../src/overrides';
import { openStore, refreshLeaseName } from '../src/store';

function fixture(): { db: DatabaseSync; close: () => void } {
  const path = join(mkdtempSync(join(tmpdir(), 'qlb-codex-rekey-')), 'qlb.db');
  const store = openStore(path);
  return {
    db: (store as unknown as { db: DatabaseSync }).db,
    close: () => store.close(),
  };
}

function slot(db: DatabaseSync, accountId: string, chatgptAccountId: string): void {
  db.prepare(`INSERT INTO codex_slots (
    account_id, chatgpt_user_id, chatgpt_account_id, added_at
  ) VALUES (?, 'fixture-user', ?, 1)`).run(accountId, chatgptAccountId);
}

function account(db: DatabaseSync, id: string, provider: string | null): void {
  db.prepare(`INSERT INTO accounts (id, provider, label, status, created_at)
    VALUES (?, ?, 'fixture', 'active', 1)`).run(id, provider);
}

function plan(db: DatabaseSync, prospective?: { accountId: string; chatgptAccountId: string }) {
  return planCodexRekey(db, { now: 100, prospective });
}

function journal(db: DatabaseSync, store: string, state: string, detailJson: string): void {
  db.prepare(`INSERT INTO migrations (store, state, updated_at, detail_json)
    VALUES (?, ?, 1, ?)`)
    .run(store, state, detailJson);
}

function lease(db: DatabaseSync, accountId: string, until: number): void {
  db.prepare(`INSERT INTO leases (name, holder_pid, holder_id, until, generation)
    VALUES (?, 1, 'fixture', ?, 1)`)
    .run(refreshLeaseName(accountId), until);
}

function pollClaim(db: DatabaseSync, accountId: string, until: number | null): void {
  db.prepare(`INSERT INTO poll_claims (account_id, holder_id, claimed_at, until)
    VALUES (?, 'fixture', 1, ?)`)
    .run(accountId, until);
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function applyPlan(db: DatabaseSync, now = 100): void {
  inTransaction(db, () => applyCodexRekey(db, plan(db), { now }));
}

function configs(db: DatabaseSync): Array<{ key: string; value: string | null }> {
  return db.prepare('SELECT key, value FROM config ORDER BY key').all() as Array<{ key: string; value: string | null }>;
}

function rekeyState(db: DatabaseSync): unknown[] {
  return [
    db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    db.prepare('SELECT * FROM snapshots ORDER BY account_id, bucket').all(),
    db.prepare('SELECT * FROM overrides ORDER BY account_id, kind, session').all(),
    db.prepare('SELECT * FROM poll_claims ORDER BY account_id').all(),
    db.prepare('SELECT * FROM usage_polls ORDER BY provider, account_id').all(),
    db.prepare('SELECT * FROM leases ORDER BY name').all(),
    configs(db),
  ];
}

function plainRows(rows: object[]): object[] {
  return rows.map((row) => ({ ...row }));
}

function everyTableState(db: DatabaseSync): string {
  const tables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
  return JSON.stringify(tables.map(({ name }) => ({
    name,
    rows: db.prepare(`SELECT rowid, * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
  })));
}

describe('Codex rekey planner', () => {
  it('a bare row with one matching slot is a rename', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      assert.deepEqual(plan(f.db).moves, [{ from: 'bare', to: 'user:bare', kind: 'rename' }]);
    } finally { f.close(); }
  });

  it('a prospective slot counts as a slot', () => {
    const f = fixture();
    try {
      account(f.db, 'bare', 'openai-codex');
      assert.deepEqual(plan(f.db, { accountId: 'future-user:bare', chatgptAccountId: 'bare' }).moves, [
        { from: 'bare', to: 'future-user:bare', kind: 'rename' },
      ]);
    } finally { f.close(); }
  });

  it('no slot ⇒ no-slot', () => {
    const f = fixture();
    try {
      account(f.db, 'bare', 'openai-codex');
      assert.deepEqual(plan(f.db).skipped, [{ id: 'bare', reason: 'no-slot' }]);
    } finally { f.close(); }
  });

  it('a bare id shared by two slots ⇒ ambiguous', () => {
    const f = fixture();
    try {
      slot(f.db, 'first:bare', 'bare');
      slot(f.db, 'second:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      assert.deepEqual(plan(f.db).skipped, [{ id: 'bare', reason: 'ambiguous' }]);
    } finally { f.close(); }
  });

  it('codex-default maps only when exactly one slot exists', () => {
    const f = fixture();
    try {
      account(f.db, 'codex-default', 'openai-codex');
      assert.deepEqual(plan(f.db).skipped, [{ id: 'codex-default', reason: 'no-slot' }]);

      slot(f.db, 'user:bare', 'bare');
      assert.deepEqual(plan(f.db).moves, [{ from: 'codex-default', to: 'user:bare', kind: 'rename' }]);

      slot(f.db, 'other:other', 'other');
      assert.deepEqual(plan(f.db).skipped, [{ id: 'codex-default', reason: 'ambiguous' }]);
    } finally { f.close(); }
  });

  it('orphan codex-default snapshots and pins with one slot ⇒ orphan move', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      f.db.prepare(`INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('codex-default', 'primary', 1)`).run();
      f.db.prepare(`INSERT INTO overrides (kind, account_id, session, until) VALUES ('pin', 'codex-default', 'fixture', 2)`).run();
      assert.deepEqual(plan(f.db).moves, [{ from: 'codex-default', to: 'user:bare', kind: 'orphan' }]);
    } finally { f.close(); }
  });

  it('an orphan id that is not provably Codex is ignored', () => {
    const f = fixture();
    try {
      f.db.prepare(`INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('unknown', 'primary', 1)`).run();
      assert.deepEqual(plan(f.db), { moves: [], skipped: [] });
    } finally { f.close(); }
  });

  it('a NULL-provider codex row ⇒ no-provider', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', null);
      assert.deepEqual(plan(f.db).skipped, [{ id: 'bare', reason: 'no-provider' }]);
    } finally { f.close(); }
  });

  it('two candidates for one target: rename then merge', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'codex-default', 'openai-codex');
      assert.deepEqual(plan(f.db).moves, [
        { from: 'bare', to: 'user:bare', kind: 'rename' },
        { from: 'codex-default', to: 'user:bare', kind: 'merge' },
      ]);
    } finally { f.close(); }
  });

  it('recovery pending skips everything', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'codex-default', 'openai-codex');
      f.db.prepare(`INSERT INTO config (key, value) VALUES ('migrations.recovery_pending', '1')`).run();
      assert.deepEqual(plan(f.db), {
        moves: [],
        skipped: [
          { id: 'bare', reason: 'recovery-pending' },
          { id: 'codex-default', reason: 'recovery-pending' },
        ],
      });
    } finally { f.close(); }
  });

  it('a malformed journal row skips everything', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'codex-default', 'openai-codex');
      journal(f.db, 'pi-pool', 'QLB_OWNED', 'not-json');
      assert.deepEqual(plan(f.db).skipped, [
        { id: 'bare', reason: 'journal-untrusted' },
        { id: 'codex-default', reason: 'journal-untrusted' },
      ]);
    } finally { f.close(); }
  });

  it('an unknown store or state skips everything', () => {
    for (const row of [
      { store: 'unknown', state: 'QLB_OWNED' },
      { store: 'pi-pool', state: 'UNKNOWN' },
    ]) {
      const f = fixture();
      try {
        slot(f.db, 'user:bare', 'bare');
        account(f.db, 'bare', 'openai-codex');
        account(f.db, 'codex-default', 'openai-codex');
        journal(f.db, row.store, row.state, '{}');
        assert.deepEqual(plan(f.db).skipped, [
          { id: 'bare', reason: 'journal-untrusted' },
          { id: 'codex-default', reason: 'journal-untrusted' },
        ]);
      } finally { f.close(); }
    }
  });

  it('a journal provider mismatch skips everything', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'codex-default', 'openai-codex');
      journal(f.db, 'pi-pool', 'QLB_OWNED', JSON.stringify({
        accounts: [{ id: 'bare', provider: 'anthropic' }],
      }));
      assert.deepEqual(plan(f.db).skipped, [
        { id: 'bare', reason: 'journal-untrusted' },
        { id: 'codex-default', reason: 'journal-untrusted' },
      ]);
    } finally { f.close(); }
  });

  it('a trusted QLB_OWNED row naming the bare id ⇒ journal-named', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      journal(f.db, 'pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: ['bare'] }));
      assert.deepEqual(plan(f.db).skipped, [{ id: 'bare', reason: 'journal-named' }]);
    } finally { f.close(); }
  });

  it('a NATIVE row does not protect', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      journal(f.db, 'pi-pool', 'NATIVE', JSON.stringify({ qlbAccountIds: ['bare'] }));
      assert.deepEqual(plan(f.db).moves, [{ from: 'bare', to: 'user:bare', kind: 'rename' }]);
    } finally { f.close(); }
  });

  it('an orphan codex-default named by a trusted journal is skipped', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      f.db.prepare(`INSERT INTO snapshots (account_id, bucket, fetched_at)
        VALUES ('codex-default', 'primary', 1)`).run();
      journal(f.db, 'pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: ['codex-default'] }));
      assert.deepEqual(plan(f.db).skipped, [{ id: 'codex-default', reason: 'journal-named' }]);
    } finally { f.close(); }
  });

  it('an unrelated trusted cswap-consume CONSUMED row does not block', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      journal(f.db, 'cswap-anthropic', 'CONSUMED', '{}');
      assert.deepEqual(plan(f.db).moves, [{ from: 'bare', to: 'user:bare', kind: 'rename' }]);
    } finally { f.close(); }
  });

  it('a target owned by another provider ⇒ provider-mismatch', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'user:bare', 'anthropic');
      assert.deepEqual(plan(f.db).skipped, [{ id: 'bare', reason: 'provider-mismatch' }]);
    } finally { f.close(); }
  });

  it('a live lease on the source skips the account', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'codex-default', 'openai-codex');
      lease(f.db, 'bare', 101);
      assert.deepEqual(plan(f.db).skipped, [
        { id: 'bare', reason: 'in-use' },
        { id: 'codex-default', reason: 'in-use' },
      ]);
    } finally { f.close(); }
  });

  it('a poll claim with no end time counts as in use', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      pollClaim(f.db, 'bare', null);
      assert.deepEqual(plan(f.db).skipped, [{ id: 'bare', reason: 'in-use' }]);
    } finally { f.close(); }
  });

  it('a busy source skips every candidate for its target', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'codex-default', 'openai-codex');
      pollClaim(f.db, 'bare', 101);
      assert.deepEqual(plan(f.db).skipped, [
        { id: 'bare', reason: 'in-use' },
        { id: 'codex-default', reason: 'in-use' },
      ]);
    } finally { f.close(); }
  });

  it('a live poll claim on the target skips every candidate for it', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'codex-default', 'openai-codex');
      pollClaim(f.db, 'user:bare', 101);
      assert.deepEqual(plan(f.db).skipped, [
        { id: 'bare', reason: 'in-use' },
        { id: 'codex-default', reason: 'in-use' },
      ]);
    } finally { f.close(); }
  });

  it('a skipped first candidate turns the second into a rename', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'codex-default', 'openai-codex');
      journal(f.db, 'pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: ['bare'] }));
      assert.deepEqual(plan(f.db), {
        moves: [{ from: 'codex-default', to: 'user:bare', kind: 'rename' }],
        skipped: [{ id: 'bare', reason: 'journal-named' }],
      });
    } finally { f.close(); }
  });

  it('planning writes nothing (total_changes unchanged)', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      const before = (f.db.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes;
      plan(f.db);
      const after = (f.db.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes;
      assert.equal(after, before);
    } finally { f.close(); }
  });
});

describe('Codex rekey apply', () => {
  it('rename carries snapshots, pins, poll claim, usage poll and expired lease', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      f.db.prepare("UPDATE accounts SET label = 'original', status = 'disabled', created_at = 42 WHERE id = 'bare'").run();
      const originalAccount = { ...f.db.prepare("SELECT id, provider, label, status, created_at FROM accounts WHERE id = 'bare'").get() as object };
      f.db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('bare', 'primary', 1)").run();
      f.db.prepare("INSERT INTO overrides (kind, account_id, session, until) VALUES ('pin', 'bare', 'fixture', 2)").run();
      pollClaim(f.db, 'bare', 99);
      f.db.prepare("INSERT INTO usage_polls (provider, account_id, next_due_at) VALUES ('openai-codex', 'bare', 3)").run();
      lease(f.db, 'bare', 99);
      applyPlan(f.db);
      for (const [table, key] of [['snapshots', 'account_id'], ['overrides', 'account_id'], ['poll_claims', 'account_id'], ['usage_polls', 'account_id']] as const) {
        assert.equal(f.db.prepare(`SELECT 1 FROM ${table} WHERE ${key} = 'user:bare'`).get() !== undefined, true);
      }
      assert.equal(f.db.prepare('SELECT 1 FROM leases WHERE name = ?').get(refreshLeaseName('user:bare')) !== undefined, true);
      assert.deepEqual({ ...f.db.prepare("SELECT id, provider, label, status, created_at FROM accounts WHERE id = 'user:bare'").get() as object }, {
        ...originalAccount,
        id: 'user:bare',
      });
      assert.equal(f.db.prepare("SELECT 1 FROM accounts WHERE id = 'bare'").get(), undefined);
      assert.deepEqual(JSON.parse((f.db.prepare("SELECT value FROM config WHERE key = 'codex.rekey.v1'").get() as { value: string }).value), {
        bare: { to: 'user:bare', kind: 'rename', at: 100 },
      });
    } finally { f.close(); }
  });

  it('an applied orphan move ensures the destination account row', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      f.db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('bare', 'primary', 1)").run();
      applyPlan(f.db);
      assert.deepEqual({ ...f.db.prepare("SELECT id, provider, label, status, created_at FROM accounts WHERE id = 'user:bare'").get() as object }, {
        id: 'user:bare', provider: 'openai-codex', label: 'user:bare', status: 'active', created_at: 100,
      });
    } finally { f.close(); }
  });

  it("two slots A and B: B's orphan bare dependents, including a usage_polls row left by a prune, move to composite-B, B's account row exists, and a second plan+apply changes nothing", () => {
    const f = fixture();
    try {
      slot(f.db, 'composite-A', 'bare-A');
      slot(f.db, 'composite-B', 'bare-B');
      account(f.db, 'bare-A', 'openai-codex');
      f.db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('bare-B', 'primary', 1)").run();
      f.db.prepare("INSERT INTO overrides (kind, account_id, session, until) VALUES ('pin', 'bare-B', 'fixture', 2)").run();
      f.db.prepare("INSERT INTO usage_polls (provider, account_id, next_due_at) VALUES ('openai-codex', 'bare-B', 3)").run();
      applyPlan(f.db);
      for (const table of ['snapshots', 'overrides', 'usage_polls']) {
        assert.equal((f.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_id = 'composite-B'`).get() as { count: number }).count, 1);
        assert.equal((f.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_id = 'bare-B'`).get() as { count: number }).count, 0);
      }
      assert.equal(f.db.prepare("SELECT 1 FROM accounts WHERE id = 'composite-A' AND provider = 'openai-codex'").get() !== undefined, true);
      assert.equal(f.db.prepare("SELECT 1 FROM accounts WHERE id = 'bare-A'").get(), undefined);
      const before = [
        f.db.prepare('SELECT * FROM snapshots ORDER BY account_id, bucket').all(),
        f.db.prepare('SELECT * FROM overrides ORDER BY account_id, kind, session').all(),
        f.db.prepare('SELECT * FROM usage_polls ORDER BY provider, account_id').all(), configs(f.db),
      ];
      applyPlan(f.db);
      assert.equal(f.db.prepare("SELECT 1 FROM accounts WHERE id = 'composite-B' AND provider = 'openai-codex'").get() !== undefined, true);
      assert.deepEqual([
        f.db.prepare('SELECT * FROM snapshots ORDER BY account_id, bucket').all(),
        f.db.prepare('SELECT * FROM overrides ORDER BY account_id, kind, session').all(),
        f.db.prepare('SELECT * FROM usage_polls ORDER BY provider, account_id').all(), configs(f.db),
      ], before);
    } finally { f.close(); }
  });

  it('a skipped orphan (in-use, journal-named, provider-mismatch) creates no account row', () => {
    for (const setup of [
      (db: DatabaseSync) => db.prepare("UPDATE poll_claims SET until = 101 WHERE account_id = 'bare'").run(),
      (db: DatabaseSync) => journal(db, 'pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: ['bare'] })),
      (db: DatabaseSync) => account(db, 'user:bare', 'anthropic'),
    ]) {
      const f = fixture();
      try {
        slot(f.db, 'user:bare', 'bare');
        f.db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('bare', 'primary', 1)").run();
        f.db.prepare("INSERT INTO overrides (kind, account_id, session, until) VALUES ('pin', 'bare', 'fixture', 2)").run();
        pollClaim(f.db, 'bare', 99);
        f.db.prepare("INSERT INTO usage_polls (provider, account_id, next_due_at) VALUES ('openai-codex', 'bare', 3)").run();
        lease(f.db, 'bare', 99);
        setup(f.db);
        const foreignTarget = JSON.stringify(f.db.prepare("SELECT * FROM accounts WHERE id = 'user:bare'").get());
        applyPlan(f.db);
        assert.equal(f.db.prepare("SELECT 1 FROM accounts WHERE id = 'user:bare' AND provider = 'openai-codex'").get(), undefined);
        for (const table of ['snapshots', 'overrides', 'poll_claims', 'usage_polls']) {
          assert.equal((f.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_id = 'bare'`).get() as { count: number }).count, 1);
          assert.equal((f.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_id = 'user:bare'`).get() as { count: number }).count, 0);
        }
        assert.equal(f.db.prepare('SELECT 1 FROM leases WHERE name = ?').get(refreshLeaseName('bare')) !== undefined, true);
        assert.equal(f.db.prepare('SELECT 1 FROM leases WHERE name = ?').get(refreshLeaseName('user:bare')), undefined);
        assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM accounts WHERE id = 'user:bare'").get()), foreignTarget);
      } finally { f.close(); }
    }
  });

  it('ensureCodexSlotAccount inserts once and never changes an existing row', () => {
    const f = fixture();
    try {
      inTransaction(f.db, () => ensureCodexSlotAccount(f.db, 'user:bare', 100));
      f.db.prepare("UPDATE accounts SET label = 'kept', status = 'disabled', created_at = 1 WHERE id = 'user:bare'").run();
      inTransaction(f.db, () => ensureCodexSlotAccount(f.db, 'user:bare', 200));
      assert.deepEqual({ ...f.db.prepare("SELECT provider, label, status, created_at FROM accounts WHERE id = 'user:bare'").get() as object }, {
        provider: 'openai-codex', label: 'kept', status: 'disabled', created_at: 1,
      });
    } finally { f.close(); }
  });

  it("another provider's usage_polls row with the same id is untouched", () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      f.db.prepare("INSERT INTO usage_polls (provider, account_id, next_due_at) VALUES ('openai-codex', 'bare', 3)").run();
      f.db.prepare("INSERT INTO usage_polls (provider, account_id, next_due_at) VALUES ('anthropic', 'bare', 4)").run();
      applyPlan(f.db);
      assert.deepEqual({ ...f.db.prepare("SELECT provider, account_id, next_due_at FROM usage_polls WHERE provider = 'anthropic'").get() as object }, {
        provider: 'anthropic', account_id: 'bare', next_due_at: 4,
      });
    } finally { f.close(); }
  });

  it('failover pointer follows the rename', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      const key = failoverConfigKey('openai-codex');
      f.db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(key, 'bare');
      applyPlan(f.db);
      assert.equal((f.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string }).value, 'user:bare');
    } finally { f.close(); }
  });

  it('observed cache is reset only when something moved', () => {
    const f = fixture();
    try {
      const key = observationConfigKey('openai-codex');
      f.db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(key, 'cached');
      applyPlan(f.db);
      assert.equal(f.db.prepare('SELECT 1 FROM config WHERE key = ?').get(key) !== undefined, true);
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      applyPlan(f.db);
      assert.equal(f.db.prepare('SELECT 1 FROM config WHERE key = ?').get(key), undefined);
    } finally { f.close(); }
  });

  it('a second plan+apply changes nothing (dependent tables and config identical)', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      f.db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('bare', 'primary', 1)").run();
      f.db.prepare("INSERT INTO overrides (kind, account_id, session, until) VALUES ('pin', 'bare', 'fixture', 2)").run();
      pollClaim(f.db, 'bare', 99);
      f.db.prepare("INSERT INTO usage_polls (provider, account_id, next_due_at) VALUES ('openai-codex', 'bare', 3)").run();
      lease(f.db, 'bare', 99);
      const failoverKey = failoverConfigKey('openai-codex');
      const observationKey = observationConfigKey('openai-codex');
      f.db.prepare('INSERT INTO config (key, value) VALUES (?, ?), (?, ?)').run(failoverKey, 'bare', observationKey, 'cached');
      applyPlan(f.db);
      const before = rekeyState(f.db);
      applyPlan(f.db);
      assert.deepEqual(rekeyState(f.db), before);
    } finally { f.close(); }
  });

  it('refuses outside a transaction', () => {
    const f = fixture();
    try {
      assert.throws(() => applyCodexRekey(f.db, { moves: [], skipped: [] }, { now: 100 }), /rekey-needs-transaction/);
    } finally { f.close(); }
  });

  it('codex_watch, decisions, switch_log, lineage_log and migrations are unchanged', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      f.db.prepare("INSERT INTO codex_watch (switch_id, provider, outgoing, target, next_at, until) VALUES (1, 'openai-codex', 'a', 'b', 1, 2)").run();
      f.db.prepare("INSERT INTO decisions (ts, account_id) VALUES (1, 'bare')").run();
      f.db.prepare("INSERT INTO switch_log (ts, provider, to_account, trigger, outcome) VALUES (1, 'openai-codex', 'bare', 'fixture', 'ok')").run();
      f.db.prepare("INSERT INTO lineage_log (ts, provider, account_id, to_fp, cause, by) VALUES (1, 'openai-codex', 'bare', 'fp', 'fixture', 'fixture')").run();
      journal(f.db, 'pi-pool', 'NATIVE', '{}');
      const tables = ['codex_watch', 'decisions', 'switch_log', 'lineage_log', 'migrations'];
      const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      applyPlan(f.db);
      assert.deepEqual(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
    } finally { f.close(); }
  });

  it('never touches the Keychain (spy never called)', () => {
    const f = fixture();
    const keychain = platformKeychain as KeychainBackend;
    const original = {
      get: keychain.get, set: keychain.set, delete: keychain.delete,
      getSync: keychain.getSync, setSync: keychain.setSync, deleteSync: keychain.deleteSync,
    };
    let calls = 0;
    const keychainSpy = () => { calls += 1; throw new Error('unexpected Keychain access'); };
    keychain.get = keychainSpy as KeychainBackend['get'];
    keychain.set = keychainSpy as KeychainBackend['set'];
    keychain.delete = keychainSpy as KeychainBackend['delete'];
    keychain.getSync = keychainSpy as KeychainBackend['getSync'];
    keychain.setSync = keychainSpy as KeychainBackend['setSync'];
    keychain.deleteSync = keychainSpy as KeychainBackend['deleteSync'];
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      applyPlan(f.db);
      assert.equal(calls, 0);
    } finally {
      Object.assign(keychain, original);
      f.close();
    }
  });

  it('a clashing reading keeps the newer one', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'user:bare', 'openai-codex');
      f.db.prepare(`INSERT INTO snapshots (account_id, bucket, used_pct, fetched_at)
        VALUES ('bare', 'primary', 80, 20), ('user:bare', 'primary', 10, 10)`).run();
      applyPlan(f.db);
      assert.deepEqual(plainRows(f.db.prepare('SELECT * FROM snapshots ORDER BY account_id, bucket').all()), [
        { account_id: 'user:bare', bucket: 'primary', used_pct: 80, used: null, limit_val: null, remaining: null, reset_at: null, fetched_at: 20, source: null, confidence: null },
      ]);
    } finally { f.close(); }
  });

  it('a NULL fetched_at loses', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'user:bare', 'openai-codex');
      f.db.prepare(`INSERT INTO snapshots (account_id, bucket, used_pct, fetched_at)
        VALUES ('bare', 'primary', 80, NULL), ('user:bare', 'primary', 10, 10)`).run();
      applyPlan(f.db);
      assert.deepEqual(plainRows(f.db.prepare('SELECT * FROM snapshots ORDER BY account_id, bucket').all()), [
        { account_id: 'user:bare', bucket: 'primary', used_pct: 10, used: null, limit_val: null, remaining: null, reset_at: null, fetched_at: 10, source: null, confidence: null },
      ]);
    } finally { f.close(); }
  });

  it('a tie keeps the target reading', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'user:bare', 'openai-codex');
      f.db.prepare(`INSERT INTO snapshots (account_id, bucket, used_pct, fetched_at)
        VALUES ('bare', 'primary', 80, 10), ('user:bare', 'primary', 10, 10)`).run();
      applyPlan(f.db);
      assert.deepEqual(plainRows(f.db.prepare('SELECT * FROM snapshots ORDER BY account_id, bucket').all()), [
        { account_id: 'user:bare', bucket: 'primary', used_pct: 10, used: null, limit_val: null, remaining: null, reset_at: null, fetched_at: 10, source: null, confidence: null },
      ]);
    } finally { f.close(); }
  });

  it('identical pins are kept once and different pins are all kept', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'user:bare', 'openai-codex');
      f.db.prepare(`INSERT INTO overrides (kind, account_id, session, until) VALUES
        ('pin', 'bare', 'duplicate', NULL),
        ('pin', 'user:bare', 'duplicate', NULL),
        ('pin', 'bare', 'source-only', 1),
        ('pin', 'user:bare', 'target-only', 2)`).run();
      applyPlan(f.db);
      assert.deepEqual(plainRows(f.db.prepare('SELECT kind, account_id, session, until FROM overrides ORDER BY session').all()), [
        { kind: 'pin', account_id: 'user:bare', session: 'duplicate', until: null },
        { kind: 'pin', account_id: 'user:bare', session: 'source-only', until: 1 },
        { kind: 'pin', account_id: 'user:bare', session: 'target-only', until: 2 },
      ]);
    } finally { f.close(); }
  });

  it('a clashing expired lease keeps the target generation', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'user:bare', 'openai-codex');
      lease(f.db, 'bare', 99);
      f.db.prepare(`INSERT INTO leases (name, holder_pid, holder_id, until, generation)
        VALUES (?, 2, 'target', 99, 8)`).run(refreshLeaseName('user:bare'));
      applyPlan(f.db);
      assert.deepEqual(plainRows(f.db.prepare('SELECT name, holder_pid, holder_id, until, generation FROM leases ORDER BY name').all()), [
        { name: refreshLeaseName('user:bare'), holder_pid: 2, holder_id: 'target', until: 99, generation: 8 },
      ]);
    } finally { f.close(); }
  });

  it('merge deletes only the emptied source row and keeps target fields', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'user:bare', 'openai-codex');
      f.db.prepare("UPDATE accounts SET label = 'source', status = 'disabled', created_at = 2 WHERE id = 'bare'").run();
      f.db.prepare("UPDATE accounts SET label = 'target', status = 'active', created_at = 3 WHERE id = 'user:bare'").run();
      f.db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('bare', 'primary', 1)").run();
      applyPlan(f.db);
      assert.deepEqual(plainRows(f.db.prepare('SELECT id, provider, label, status, created_at FROM accounts ORDER BY id').all()), [
        { id: 'user:bare', provider: 'openai-codex', label: 'target', status: 'active', created_at: 3 },
      ]);
      assert.deepEqual(plainRows(f.db.prepare('SELECT * FROM snapshots ORDER BY account_id, bucket').all()), [
        { account_id: 'user:bare', bucket: 'primary', used_pct: null, used: null, limit_val: null, remaining: null, reset_at: null, fetched_at: 1, source: null, confidence: null },
      ]);
    } finally { f.close(); }
  });

  it('bare and codex-default into one slot: rename then merge', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'codex-default', 'openai-codex');
      f.db.prepare(`INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES
        ('bare', 'primary', 1), ('codex-default', 'secondary', 2)`).run();
      applyPlan(f.db);
      assert.deepEqual(plainRows(f.db.prepare('SELECT id, provider, label, status, created_at FROM accounts ORDER BY id').all()), [
        { id: 'user:bare', provider: 'openai-codex', label: 'fixture', status: 'active', created_at: 1 },
      ]);
      assert.deepEqual(plainRows(f.db.prepare('SELECT * FROM snapshots ORDER BY account_id, bucket').all()), [
        { account_id: 'user:bare', bucket: 'primary', used_pct: null, used: null, limit_val: null, remaining: null, reset_at: null, fetched_at: 1, source: null, confidence: null },
        { account_id: 'user:bare', bucket: 'secondary', used_pct: null, used: null, limit_val: null, remaining: null, reset_at: null, fetched_at: 2, source: null, confidence: null },
      ]);
    } finally { f.close(); }
  });

  it("another provider's usage_polls row does not block the merge count", () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'user:bare', 'openai-codex');
      f.db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('bare', 'primary', 1)").run();
      f.db.prepare("INSERT INTO usage_polls (provider, account_id, next_due_at) VALUES ('anthropic', 'bare', 4)").run();
      applyPlan(f.db);
      assert.deepEqual(plainRows(f.db.prepare('SELECT id, provider FROM accounts ORDER BY id').all()), [
        { id: 'user:bare', provider: 'openai-codex' },
      ]);
      assert.deepEqual(plainRows(f.db.prepare('SELECT * FROM usage_polls ORDER BY provider, account_id').all()), [
        { provider: 'anthropic', account_id: 'bare', last_fetch_at: null, last_attempt_at: null, next_due_at: 4, poll_interval_s: null, last_status: null, consecutive_failures: 0, backoff_until: null, last_429_at: null, held_until: null },
      ]);
    } finally { f.close(); }
  });

  it('a remaining Codex dependent aborts the merge and nothing is committed', () => {
    const f = fixture();
    try {
      slot(f.db, 'user:bare', 'bare');
      account(f.db, 'bare', 'openai-codex');
      account(f.db, 'user:bare', 'openai-codex');
      f.db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('bare', 'primary', 1)").run();
      const before = everyTableState(f.db);
      assert.throws(() => inTransaction(f.db, () => applyCodexRekey(f.db, plan(f.db), {
        now: 100,
        // Test-only seam: simulate a dependent written during a caller-owned transaction.
        testOnlyBeforeMergeCount: (db) => db.prepare(`INSERT INTO snapshots (account_id, bucket, fetched_at)
          VALUES ('bare', 'late', 2)`).run(),
      })), /rekey-dependents-remain/);
      assert.equal(everyTableState(f.db), before);
    } finally { f.close(); }
  });
});
