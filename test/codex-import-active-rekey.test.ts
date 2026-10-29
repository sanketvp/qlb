import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { runCodexImportActiveCommand, type CodexImportActiveCommandDeps } from '../src/commands/codex-import-active';
import { parseCodexAuth } from '../src/codex-auth';
import { importActiveCodexSlot, planImportActiveCodex } from '../src/codex-slots';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { beginCutover } from '../src/lifecycle';
import type { CommandContext } from '../src/registry';
import { openStore, type Store } from '../src/store';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(refresh: string, accountId = 'fixture-account') {
  const parsed = parseCodexAuth(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: accountId } }),
      access_token: jwt({ exp: 2_000_000_000 }),
      refresh_token: refresh,
      account_id: accountId,
    },
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture must parse');
  return parsed.doc;
}

interface Fixture {
  home: string;
  store: Store;
  keychain: MockKeychain;
  output: string[];
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'qlb-codex-import-active-rekey-'));
  return { home, store: openStore(join(home, 'qlb.db')), keychain: new MockKeychain(), output: [] };
}

function context(f: Fixture): CommandContext {
  return {
    stdout: (line) => f.output.push(`stdout:${line}`), stderr: (line) => f.output.push(`stderr:${line}`),
    env: { QLB_TEST_MODE: '1', QLB_HOME: f.home, HOME: f.home, CODEX_HOME: join(f.home, 'codex') },
    config: { dbPath: join(f.home, 'qlb.db'), piAuthJsonPath: join(f.home, 'pi-auth.json') } as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); }, home: f.home,
    registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
  };
}

function deps(f: Fixture, doc: ReturnType<typeof document>): CodexImportActiveCommandDeps {
  return {
    keychain: f.keychain,
    readAuth: async () => ({ status: 'ok', doc }),
    writeAuth: async () => 1,
    withAuthLock: async (_options, fn) => fn({ assertNotCompromised: () => undefined }),
  };
}

function seed(f: Fixture, doc: ReturnType<typeof document>): ReturnType<typeof planImportActiveCodex> {
  beginCutover(f.store, 1);
  return importActiveCodexSlot(doc, { store: f.store, keychain: f.keychain, now: () => 2 });
}

function db(f: Fixture): DatabaseSync {
  return new DatabaseSync(join(f.home, 'qlb.db'));
}

async function run(f: Fixture, doc: ReturnType<typeof document>): Promise<number> {
  return runCodexImportActiveCommand([], context(f), deps(f, doc));
}

function close(f: Fixture): void {
  f.store.close();
  rmSync(f.home, { recursive: true, force: true });
}

function accountRows(database: DatabaseSync): Array<Record<string, unknown>> {
  return (database.prepare('SELECT id, provider, label, status FROM accounts ORDER BY id').all() as Array<Record<string, unknown>>)
    .map((row) => ({ ...row }));
}

describe('codex import-active existing-slot rekey', () => {
  it('existing slot, zero accounts rows, orphan codex-default snapshots and pins ⇒ one visible slot-id row holding them; second run changes nothing', async () => {
    const f = fixture();
    try {
      const doc = document('orphan');
      const plan = seed(f, doc);
      const database = db(f);
      database.prepare('DELETE FROM accounts').run();
      database.prepare(`INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('codex-default', 'five-hour', 10)`).run();
      database.prepare(`INSERT INTO overrides (kind, account_id, session, until) VALUES ('pin', 'codex-default', 's', 20)`).run();
      database.close();

      assert.equal(await run(f, doc), 0);
      const first = db(f);
      assert.deepEqual(accountRows(first), [{ id: plan.slotId, provider: 'openai-codex', label: plan.slotId, status: 'active' }]);
      assert.equal((first.prepare('SELECT account_id FROM snapshots').get() as { account_id: string }).account_id, plan.slotId);
      assert.equal((first.prepare('SELECT account_id FROM overrides').get() as { account_id: string }).account_id, plan.slotId);
      const before = JSON.stringify([accountRows(first), first.prepare('SELECT * FROM snapshots').all(), first.prepare('SELECT * FROM overrides').all()]);
      first.close();

      assert.equal(await run(f, doc), 0);
      const second = db(f);
      assert.equal(JSON.stringify([accountRows(second), second.prepare('SELECT * FROM snapshots').all(), second.prepare('SELECT * FROM overrides').all()]), before);
      second.close();
    } finally { close(f); }
  });

  it('existing slot with no old dependents ⇒ slot-id row ensured', async () => {
    const f = fixture();
    try {
      const doc = document('ensure');
      const plan = seed(f, doc);
      const database = db(f);
      database.prepare('DELETE FROM accounts').run();
      database.close();
      assert.equal(await run(f, doc), 0);
      const result = db(f);
      assert.deepEqual(accountRows(result), [{ id: plan.slotId, provider: 'openai-codex', label: plan.slotId, status: 'active' }]);
      result.close();
    } finally { close(f); }
  });

  it('existing slot plus a bare row ⇒ renamed in the same save as attribution', async () => {
    const f = fixture();
    try {
      const doc = document('rename');
      const plan = seed(f, doc);
      const database = db(f);
      database.prepare(`INSERT INTO accounts (id, provider, label, status, created_at) VALUES (?, 'openai-codex', 'bare', 'active', 1)`).run(plan.accountId);
      database.prepare(`INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES (?, 'five-hour', 10)`).run(plan.accountId);
      database.close();
      assert.equal(await run(f, doc), 0);
      const result = db(f);
      assert.equal(result.prepare('SELECT id FROM accounts WHERE id = ?').get(plan.accountId), undefined);
      assert.equal((result.prepare('SELECT account_id FROM snapshots').get() as { account_id: string }).account_id, plan.slotId);
      assert.equal((result.prepare("SELECT account_id FROM active_login WHERE provider = 'openai-codex'").get() as { account_id: string }).account_id, plan.slotId);
      result.close();
    } finally { close(f); }
  });

  it('first import skipped in-use, claim expires, second import merges', async () => {
    const f = fixture();
    try {
      const doc = document('in-use');
      const plan = seed(f, doc);
      const database = db(f);
      database.prepare(`INSERT INTO accounts (id, provider, label, status, created_at) VALUES (?, 'openai-codex', 'bare', 'active', 1)`).run(plan.accountId);
      database.prepare(`INSERT INTO poll_claims (account_id, holder_id, claimed_at, until) VALUES (?, 'fixture', 1, ?)`).run(plan.accountId, Date.now() + 60_000);
      database.close();
      assert.equal(await run(f, doc), 0);
      let result = db(f);
      assert.ok(result.prepare('SELECT id FROM accounts WHERE id = ?').get(plan.accountId));
      result.prepare('UPDATE poll_claims SET until = 0 WHERE account_id = ?').run(plan.accountId);
      result.close();
      assert.equal(await run(f, doc), 0);
      result = db(f);
      assert.equal(result.prepare('SELECT id FROM accounts WHERE id = ?').get(plan.accountId), undefined);
      assert.ok(result.prepare('SELECT id FROM accounts WHERE id = ?').get(plan.slotId));
      result.close();
    } finally { close(f); }
  });

  it('a rekey failure leaves slot fingerprint, active_login and Keychain unchanged', async () => {
    const f = fixture();
    try {
      const doc = document('failure');
      const plan = seed(f, doc);
      const service = qlbKeychainService('openai-codex', plan.slotId);
      const beforeKeychain = f.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
      const database = db(f);
      database.prepare(`INSERT INTO accounts (id, provider, label, status, created_at) VALUES (?, 'openai-codex', 'bare', 'active', 1)`).run(plan.accountId);
      const before = database.prepare("SELECT fingerprint FROM codex_slots WHERE account_id = ?").get(plan.slotId);
      const beforeActive = database.prepare("SELECT account_id, since, set_by FROM active_login WHERE provider = 'openai-codex'").get();
      database.exec(`CREATE TRIGGER fail_fixture_rekey BEFORE DELETE ON accounts WHEN OLD.id = '${plan.accountId}' BEGIN SELECT RAISE(ABORT, 'fixture rekey failure'); END`);
      database.close();
      await assert.rejects(run(f, doc), /fixture rekey failure/);
      const result = db(f);
      assert.deepEqual(result.prepare("SELECT fingerprint FROM codex_slots WHERE account_id = ?").get(plan.slotId), before);
      assert.deepEqual(result.prepare("SELECT account_id, since, set_by FROM active_login WHERE provider = 'openai-codex'").get(), beforeActive);
      assert.equal(f.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), beforeKeychain);
      result.close();
    } finally { close(f); }
  });

  it('legacy takeover (bare or codex-default) refuses with exit 3 before attribution writes anything', async () => {
    for (const participant of ['fixture-account', 'codex-default']) {
      const f = fixture();
      try {
        const doc = document(`legacy-${participant}`);
        const plan = seed(f, doc);
        const database = db(f);
        database.prepare(`INSERT INTO migrations (store, state, updated_at, detail_json) VALUES ('pi-openai-codex', 'QLB_OWNED', 1, ?)`).run(JSON.stringify({ qlbAccountIds: [participant] }));
        const beforeSlot = database.prepare('SELECT fingerprint, last_active_at FROM codex_slots WHERE account_id = ?').get(plan.slotId);
        const beforeActive = database.prepare("SELECT account_id, since, set_by FROM active_login WHERE provider = 'openai-codex'").get();
        database.close();
        assert.equal(await run(f, doc), 3);
        const result = db(f);
        assert.deepEqual(result.prepare('SELECT fingerprint, last_active_at FROM codex_slots WHERE account_id = ?').get(plan.slotId), beforeSlot);
        assert.deepEqual(result.prepare("SELECT account_id, since, set_by FROM active_login WHERE provider = 'openai-codex'").get(), beforeActive);
        assert.match(f.output.at(-1) ?? '', /hand the older takeover back first/);
        result.close();
      } finally { close(f); }
    }
  });

  it('slot-account-provider-mismatch refuses with exit 3 and nothing written', async () => {
    const f = fixture();
    try {
      const doc = document('mismatch');
      const plan = seed(f, doc);
      const database = db(f);
      database.prepare('DELETE FROM accounts WHERE id = ?').run(plan.slotId);
      database.prepare(`INSERT INTO accounts (id, provider, label, status, created_at) VALUES (?, 'xai', 'foreign', 'active', 1)`).run(plan.slotId);
      const before = JSON.stringify(accountRows(database));
      database.close();
      assert.equal(await run(f, doc), 3);
      const result = db(f);
      assert.equal(JSON.stringify(accountRows(result)), before);
      assert.match(f.output.at(-1) ?? '', /Codex slot id is already used by a non-Codex account/);
      result.close();
    } finally { close(f); }
  });

  it('slot-split runs no rekey', async () => {
    const f = fixture();
    try {
      const doc = document('split');
      const plan = seed(f, doc);
      const database = db(f);
      database.prepare(`INSERT INTO accounts (id, provider, label, status, created_at) VALUES (?, 'openai-codex', 'bare', 'active', 1)`).run(plan.accountId);
      database.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?').run('stale-fingerprint', plan.slotId);
      database.close();
      assert.equal(await run(f, doc), 3);
      const result = db(f);
      assert.ok(result.prepare('SELECT id FROM accounts WHERE id = ?').get(plan.accountId));
      assert.match(f.output.at(-1) ?? '', /slot-split/);
      result.close();
    } finally { close(f); }
  });

  it("two existing slots A and B with B's orphan bare dependents: importing A leaves B's account row and dependents in place, and a second import changes nothing", async () => {
    const f = fixture();
    try {
      const a = document('a', 'account-a');
      const b = document('b', 'account-b');
      const planA = seed(f, a);
      const planB = importActiveCodexSlot(b, { store: f.store, keychain: f.keychain, now: () => 3 });
      const database = db(f);
      database.prepare('DELETE FROM accounts WHERE id = ?').run(planB.slotId);
      database.prepare(`INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES (?, 'five-hour', 10)`).run(planB.accountId);
      database.close();
      assert.equal(await run(f, a), 0);
      let result = db(f);
      assert.ok(result.prepare('SELECT id FROM accounts WHERE id = ?').get(planB.slotId));
      assert.equal((result.prepare('SELECT account_id FROM snapshots WHERE bucket = ?').get('five-hour') as { account_id: string }).account_id, planB.slotId);
      assert.equal(result.prepare('SELECT id FROM accounts WHERE id = ?').get(planB.accountId), undefined);
      assert.ok(result.prepare('SELECT id FROM accounts WHERE id = ?').get(planA.slotId));
      const before = JSON.stringify([accountRows(result), result.prepare('SELECT account_id, bucket FROM snapshots ORDER BY account_id').all()]);
      result.close();
      assert.equal(await run(f, a), 0);
      result = db(f);
      assert.equal(JSON.stringify([accountRows(result), result.prepare('SELECT account_id, bucket FROM snapshots ORDER BY account_id').all()]), before);
      result.close();
    } finally { close(f); }
  });
});
