import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, mock } from 'node:test';

import { createCodexAdapter } from '../src/adapters/codex';
import { addCodexAccount, CodexAddError, type CodexAddDeps } from '../src/codex-add';
import { parseCodexAuth } from '../src/codex-auth';
import { importActiveCodexSlot } from '../src/codex-slots';
import { CodexAdmissionRefused } from '../src/codex-rekey';
import { checkRestorePrecondition } from '../src/codex-restore-baseline';
import { MockKeychain } from '../src/keychain';
import { createSingleGrantMigration, defaultRehearseFn } from '../src/migration';
import { backupBeforeMigrateSync, openStore } from '../src/store';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(withUser = true, user = 'fixture-user', account = 'fixture-account') {
  const claims: Record<string, string> = { chatgpt_account_id: account };
  if (withUser) claims.chatgpt_user_id = user;
  const parsed = parseCodexAuth(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': claims }),
      access_token: jwt({ 'https://api.openai.com/auth': claims }),
      refresh_token: 'fixture-refresh',
      account_id: account,
    },
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture must parse');
  return parsed.doc;
}

function addDeps(store: ReturnType<typeof openStore>, keychain: MockKeychain, doc = document()): CodexAddDeps {
  return {
    store, keychain, env: {}, now: () => 1_700_000_000_000,
    createTemp: () => '/tmp/codex-activation-add', writeConfig: () => undefined, removeTemp: () => undefined,
    hashFile: () => 'native-auth-unchanged', login: async () => 0,
    readAuth: async () => ({ status: 'ok', doc }), installCleanup: () => () => undefined,
    withDb: (_store, fn) => fn((store as unknown as { db: DatabaseSync }).db),
    withAuthLock: async (_options, fn) => fn({ assertNotCompromised: () => undefined }),
  };
}

function tableState(store: ReturnType<typeof openStore>): string {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return JSON.stringify(tables.map(({ name }) => ({ name, rows: db.prepare(`SELECT rowid, * FROM "${name}" ORDER BY rowid`).all() })));
}

function migration(db: DatabaseSync, state: string, ids: string[]): void {
  db.prepare(`INSERT INTO migrations (store, state, updated_at, detail_json) VALUES ('pi-openai-codex', ?, 1, ?)`)
    .run(state, JSON.stringify({ qlbAccountIds: ids }));
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
}

class TrackingMockKeychain extends MockKeychain {
  private readonly coordinates = new Set<string>();
  /** Every set or delete, kept even when a later delete removes the item. */
  mutations = 0;

  override setSync(service: string, account: string, value: string): void {
    this.mutations += 1;
    super.setSync(service, account, value);
    this.coordinates.add(`${service}\0${account}`);
  }

  override deleteSync(service: string, account: string): void {
    this.mutations += 1;
    super.deleteSync(service, account);
    this.coordinates.delete(`${service}\0${account}`);
  }

  recordedItems(): string[] {
    return [...this.coordinates].sort();
  }
}

function stageHarness(withUser: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-codex-stage-'));
  const agentDir = join(dir, 'agent');
  const authPath = join(agentDir, 'auth.json');
  const ownerPath = join(agentDir, 'qlb-owner-openai-codex.json');
  const claims: Record<string, string> = { chatgpt_account_id: 'fixture-account' };
  if (withUser) claims.chatgpt_user_id = 'fixture-user';
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(authPath, JSON.stringify({
    'openai-codex': {
      type: 'oauth',
      access: jwt({ 'https://api.openai.com/auth': claims }),
      refresh: 'fixture-refresh',
      expires: 2_000_000_000_000,
      accountId: 'fixture-account',
    },
  }), { mode: 0o600 });
  const store = openStore(join(dir, 'qlb.db'));
  const keychain = new TrackingMockKeychain();
  return {
    dir,
    agentDir,
    ownerPath,
    store,
    keychain,
    migration: createSingleGrantMigration(store, keychain, 'openai-codex', authPath, ownerPath),
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('Codex S29 activation', () => {
  it('the adapter reports the slot id and writes no accounts row', async () => {
    const adapter = createCodexAdapter({ readAuth: async () => JSON.stringify(document()) });
    assert.deepEqual(await adapter.fetchSnapshots(), [{
      accountId: 'fixture-user:fixture-account',
      provider: 'openai-codex',
      label: 'fixture-user:fixture-account',
      buckets: {},
    }]);
  });

  it('a login without chatgpt_user_id: adapter error result; import and add write nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-activation-'));
    const store = openStore(join(home, 'qlb.db'));
    const keychain = new MockKeychain();
    try {
      const missing = document(false);
      const adapter = createCodexAdapter({ readAuth: async () => JSON.stringify(missing) });
      const [snapshot] = await adapter.fetchSnapshots();
      assert.equal(snapshot?.accountId, 'codex-default');
      assert.equal(snapshot?.error, 'Codex login has no S29 identity');
      assert.throws(() => importActiveCodexSlot(missing, { store, keychain }), /S29 identity/);
      const add = addDeps(store, keychain, missing);
      await assert.rejects(addCodexAccount({ home, nativeAuthPath: join(home, 'native-auth') }, add), CodexAddError);
      const db = (store as unknown as { db: DatabaseSync }).db;
      assert.equal((db.prepare('SELECT count(*) AS count FROM accounts').get() as { count: number }).count, 0);
      assert.throws(() => keychain.getSync('qlb:openai-codex:fixture-user:fixture-account', 'qlb'));
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('openai-codex stage keys journal, account and Keychain item by the slot id', () => {
    const h = stageHarness(true);
    try {
      h.migration.stage();
      const slotId = 'fixture-user:fixture-account';
      const migration = h.store.getMigration('pi-openai-codex');
      assert.deepEqual(JSON.parse(migration?.detail_json ?? '{}').qlbAccountIds, [slotId]);
      const db = (h.store as unknown as { db: DatabaseSync }).db;
      assert.equal((db.prepare('SELECT id FROM accounts').get() as { id: string }).id, slotId);
      assert.deepEqual(h.keychain.recordedItems(), [`qlb:openai-codex:${slotId}\0${slotId}`]);
      assert.equal(count(db, "accounts WHERE id = 'fixture-account'"), 0);
      assert.equal(h.keychain.recordedItems().some((item) => item.startsWith('qlb:openai-codex:fixture-account\0')), false);
    } finally {
      h.cleanup();
    }
  });

  it('openai-codex stage refuses codex-identity-missing and writes nothing', () => {
    const h = stageHarness(false);
    try {
      assert.throws(() => h.migration.stage(), /codex-identity-missing/);
      const db = (h.store as unknown as { db: DatabaseSync }).db;
      assert.equal(count(db, 'migrations'), 0);
      assert.equal(count(db, 'accounts'), 0);
      assert.deepEqual(h.keychain.recordedItems(), []);
      assert.equal(h.keychain.mutations, 0);
      assert.deepEqual(readdirSync(h.agentDir), ['auth.json']);
    } finally {
      h.cleanup();
    }
  });

  it('rehearse sends the bare id header for a slot id', async () => {
    const calls: RequestInit[] = [];
    const fetchMock = mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response('{}', { status: 200 });
    });
    try {
      const result = await defaultRehearseFn({
        id: 'fixture-user:fixture-account', provider: 'openai-codex', label: 'fixture-user:fixture-account', fingerprint: 'fixture',
        grant: { access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 60_000, generation: 0, writtenBy: 'fixture' },
      });
      assert.deepEqual(result, { ok: true });
      assert.equal(new Headers(calls[0]?.headers).get('chatgpt-account-id'), 'fixture-account');
    } finally { fetchMock.mock.restore(); }
  });

  it('import-active takes the backup before its first write and commits', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-backup-order-'));
    const store = openStore(join(home, 'qlb.db'));
    const keychain = new MockKeychain();
    try {
      store.upsertAccount('fixture-account', 'openai-codex', 'legacy');
      let observedBeforeWrite = false;
      const result = importActiveCodexSlot(document(), {
        store, keychain,
        backup: (path, source) => {
          observedBeforeWrite = count(source, 'codex_slots') === 0
            && count(source, 'accounts') === 1
            && (source.prepare("SELECT value FROM config WHERE key = 'codex.rekey.backupPath'").get() === undefined);
          return backupBeforeMigrateSync(path, source);
        },
      });
      const db = (store as unknown as { db: DatabaseSync }).db;
      const backup = (db.prepare("SELECT value FROM config WHERE key = 'codex.rekey.backupPath'").get() as { value: string }).value;
      assert.equal(result.slotId, 'fixture-user:fixture-account');
      assert.equal(observedBeforeWrite, true);
      assert.equal(existsSync(backup), true);
      const copy = new DatabaseSync(backup, { readOnly: true });
      try { assert.equal(Object.values(copy.prepare('PRAGMA integrity_check').get() as object)[0], 'ok'); } finally { copy.close(); }
      assert.equal(count(db, 'codex_slots'), 1);
      assert.equal(count(db, 'accounts'), 1);
    } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it('a failing backup rolls back the import and writes no Keychain item', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-backup-fail-'));
    const store = openStore(join(home, 'qlb.db'));
    const keychain = new MockKeychain();
    try {
      const db = (store as unknown as { db: DatabaseSync }).db;
      db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('fixture-account', 'primary', 1)").run();
      assert.throws(() => importActiveCodexSlot(document(), { store, keychain, backup: () => { throw new Error('injected backup failure'); } }), /injected backup failure/);
      assert.equal(count(db, 'codex_slots'), 0);
      assert.equal(count(db, 'accounts'), 0);
      assert.throws(() => keychain.getSync('qlb:openai-codex:fixture-user:fixture-account', 'qlb'));
    } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it('import refuses legacy-codex-takeover-active (bare and codex-default) with exit 3, no Keychain item, no row', () => {
    for (const id of ['fixture-account', 'codex-default']) {
      const store = openStore(':memory:');
      const keychain = new MockKeychain();
      try {
        const db = (store as unknown as { db: DatabaseSync }).db;
        migration(db, 'QLB_OWNED', [id]);
        assert.throws(() => importActiveCodexSlot(document(), { store, keychain }), (error: unknown) =>
          error instanceof CodexAdmissionRefused && error.code === 'legacy-codex-takeover-active' && error.exitCode === 3);
        assert.equal(count(db, 'codex_slots'), 0);
        assert.equal(count(db, 'accounts'), 0);
        assert.throws(() => keychain.getSync('qlb:openai-codex:fixture-user:fixture-account', 'qlb'));
      } finally { store.close(); }
    }
  });

  it('add refuses the same with exit 3 and compensation leaves the Keychain unchanged', async () => {
    for (const id of ['fixture-account', 'codex-default']) {
      const store = openStore(':memory:');
      const keychain = new MockKeychain();
      const sentinel = 'fixture-keychain-bytes';
      keychain.setSync('qlb:test:sentinel', 'qlb', sentinel);
      try {
        migration((store as unknown as { db: DatabaseSync }).db, 'QLB_OWNED', [id]);
        await assert.rejects(addCodexAccount({ home: '/fixture', nativeAuthPath: '/fixture/native' }, addDeps(store, keychain)),
          (error: unknown) => error instanceof CodexAddError && error.exitCode === 3);
        assert.equal(keychain.getSync('qlb:test:sentinel', 'qlb'), sentinel);
        assert.throws(() => keychain.getSync('qlb:openai-codex:fixture-user:fixture-account', 'qlb'));
      } finally { store.close(); }
    }
  });

  it('import and add refuse slot-account-provider-mismatch with no candidate present and with one present; all rows and fake Keychain items unchanged', async () => {
    for (const candidate of [false, true]) {
      const store = openStore(':memory:');
      const keychain = new MockKeychain();
      try {
        const db = (store as unknown as { db: DatabaseSync }).db;
        db.prepare("INSERT INTO accounts (id, provider, label, status, created_at) VALUES ('fixture-user:fixture-account', 'xai', 'foreign', 'active', 1)").run();
        if (candidate) store.upsertAccount('fixture-account', 'openai-codex', 'legacy');
        keychain.setSync('qlb:test:sentinel', 'qlb', 'unchanged');
        const before = tableState(store);
        assert.throws(() => importActiveCodexSlot(document(), { store, keychain }), (error: unknown) =>
          error instanceof CodexAdmissionRefused && error.code === 'slot-account-provider-mismatch');
        assert.equal(tableState(store), before);
        await assert.rejects(addCodexAccount({ home: '/fixture', nativeAuthPath: '/fixture/native' }, addDeps(store, keychain)),
          (error: unknown) => error instanceof CodexAddError && error.exitCode === 3);
        assert.equal(tableState(store), before);
        assert.equal(keychain.getSync('qlb:test:sentinel', 'qlb'), 'unchanged');
      } finally { store.close(); }
    }
  });

  it('after a NATIVE hand-back the same import succeeds', () => {
    const store = openStore(':memory:');
    const keychain = new MockKeychain();
    try {
      const db = (store as unknown as { db: DatabaseSync }).db;
      migration(db, 'NATIVE', ['fixture-account']);
      assert.equal(importActiveCodexSlot(document(), { store, keychain }).slotId, 'fixture-user:fixture-account');
      assert.equal(count(db, 'codex_slots'), 1);
      assert.doesNotThrow(() => keychain.getSync('qlb:openai-codex:fixture-user:fixture-account', 'qlb'));
    } finally { store.close(); }
  });

  it('orphan codex-default data moves onto the only slot and its row exists', () => {
    const store = openStore(':memory:');
    const keychain = new MockKeychain();
    try {
      const db = (store as unknown as { db: DatabaseSync }).db;
      db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('codex-default', 'primary', 1)").run();
      db.prepare("INSERT INTO overrides (kind, account_id, session, until) VALUES ('pin', 'codex-default', 'fixture', 2)").run();
      importActiveCodexSlot(document(), { store, keychain });
      assert.equal(count(db, 'snapshots'), 1);
      assert.equal((db.prepare('SELECT account_id FROM snapshots').get() as { account_id: string }).account_id, 'fixture-user:fixture-account');
      assert.equal((db.prepare("SELECT provider FROM accounts WHERE id = 'fixture-user:fixture-account'").get() as { provider: string }).provider, 'openai-codex');
    } finally { store.close(); }
  });

  it("importing A with existing slot B and B's orphan bare dependents ⇒ B's account row and dependents exist; a second import changes nothing", () => {
    const store = openStore(':memory:');
    const keychain = new MockKeychain();
    try {
      const db = (store as unknown as { db: DatabaseSync }).db;
      db.prepare(`INSERT INTO codex_slots (account_id, chatgpt_user_id, chatgpt_account_id, added_at)
        VALUES ('user-B:bare-B', 'user-B', 'bare-B', 1)`).run();
      db.prepare("INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES ('bare-B', 'primary', 1)").run();
      db.prepare("INSERT INTO overrides (kind, account_id, session, until) VALUES ('pin', 'bare-B', 'fixture', 2)").run();
      db.prepare("INSERT INTO usage_polls (provider, account_id, next_due_at) VALUES ('openai-codex', 'bare-B', 3)").run();
      const docA = document(true, 'user-A', 'bare-A');
      importActiveCodexSlot(docA, { store, keychain, now: () => 7 });
      for (const table of ['snapshots', 'overrides', 'usage_polls']) {
        assert.equal((db.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_id = 'user-B:bare-B'`).get() as { count: number }).count, 1);
      }
      assert.equal((db.prepare("SELECT provider FROM accounts WHERE id = 'user-B:bare-B'").get() as { provider: string }).provider, 'openai-codex');
      const before = tableState(store);
      importActiveCodexSlot(docA, { store, keychain, now: () => 7 });
      assert.equal(tableState(store), before);
    } finally { store.close(); }
  });

  it('the backup-taking import records the restore baseline in the same commit', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-baseline-'));
    const store = openStore(join(home, 'qlb.db'));
    const keychain = new MockKeychain();
    try {
      store.upsertAccount('fixture-account', 'openai-codex', 'legacy');
      importActiveCodexSlot(document(), { store, keychain });
      const db = (store as unknown as { db: DatabaseSync }).db;
      const baseline = JSON.parse((db.prepare("SELECT value FROM config WHERE key = 'codex.rekey.baseline'").get() as { value: string }).value) as { saveKind: string };
      assert.equal(baseline.saveKind, 'import-new');
      assert.deepEqual(checkRestorePrecondition(store.dbPath, { keychain }), { verdict: 'same' });

      const failedHome = mkdtempSync(join(tmpdir(), 'qlb-codex-baseline-rollback-'));
      const failedStore = openStore(join(failedHome, 'qlb.db'));
      const failedKeychain = new MockKeychain();
      try {
        failedStore.upsertAccount('fixture-account', 'openai-codex', 'legacy');
        assert.throws(() => importActiveCodexSlot(document(), {
          store: failedStore, keychain: failedKeychain,
          withDb: (_store, run) => {
            const actual = new DatabaseSync(failedStore.dbPath);
            const db = new Proxy(actual, {
              get(target, property) {
                if (property === 'exec') return (sql: string) => {
                  if (sql === 'COMMIT') throw new Error('injected pre-commit failure');
                  return target.exec(sql);
                };
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }) as unknown as DatabaseSync;
            try { return run(db); } finally { actual.close(); }
          },
        }), /injected pre-commit failure/);
        const failedDb = (failedStore as unknown as { db: DatabaseSync }).db;
        assert.equal(failedDb.prepare("SELECT value FROM config WHERE key = 'codex.rekey.backupPath'").get(), undefined);
        assert.equal(failedDb.prepare("SELECT value FROM config WHERE key = 'codex.rekey.baseline'").get(), undefined);
      } finally { failedStore.close(); rmSync(failedHome, { recursive: true, force: true }); }
    } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
  });
});
