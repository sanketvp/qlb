import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { planCodexRekey } from '../src/codex-rekey';
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
