import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { addCodexAccount, CodexAddError, type CodexAddDeps } from '../src/codex-add';
import { parseCodexAuth } from '../src/codex-auth';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { openStore } from '../src/store';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(refresh = 'fixture-refresh') {
  const parsed = parseCodexAuth(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account' } }),
      access_token: jwt({ exp: 2_000_000_000 }),
      refresh_token: refresh,
      account_id: 'fixture-account',
    },
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture must parse');
  return parsed.doc;
}

function fixture(doc = document()) {
  const store = openStore(':memory:');
  const keychain = new MockKeychain();
  const calls: string[] = [];
  let cleanup: (() => void) | undefined;
  let hashCalls = 0;
  const deps: CodexAddDeps = {
    store,
    keychain,
    env: {},
    now: () => 1_700_000_000_000,
    createTemp: () => { calls.push('create-temp'); return '/tmp/codex-add-fixture'; },
    writeConfig: (path, contents) => { calls.push(`config:${path}:${contents}`); },
    removeTemp: (path) => { calls.push(`remove:${path}`); },
    hashFile: () => { hashCalls += 1; return 'same-native-hash'; },
    login: async (options) => { calls.push(`login:${options.command}:${options.args.join(' ')}:${options.env.CODEX_HOME}`); return 0; },
    readAuth: async () => ({ status: 'ok', doc }),
    installCleanup: (handler) => { cleanup = handler; return () => { cleanup = undefined; }; },
    withDb: (_store, fn) => fn((store as unknown as { db: DatabaseSync }).db),
  };
  return { store, keychain, calls, deps, fireCleanup: () => cleanup?.(), setHash: (fn: () => string) => { deps.hashFile = fn; }, hashCalls: () => hashCalls };
}

function rows(store: ReturnType<typeof openStore>) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const plain = (row: Record<string, unknown> | undefined) => row && { ...row };
  return {
    slot: plain(db.prepare('SELECT account_id, chatgpt_user_id, chatgpt_account_id, source, fingerprint FROM codex_slots').get() as Record<string, unknown> | undefined),
    accounts: (db.prepare("SELECT id, provider FROM accounts WHERE provider = 'openai-codex'").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
    lineage: (db.prepare("SELECT cause, by, evidence FROM lineage_log WHERE provider = 'openai-codex' ORDER BY id").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
    relogins: (db.prepare("SELECT kind FROM relogin_events WHERE provider = 'openai-codex'").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
  };
}

describe('codex add', () => {
  it('uses an isolated file-store login and persists only its resulting composite identity', async () => {
    const f = fixture();
    try {
      const result = await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/fixture-home/.codex/auth.json' }, f.deps);
      assert.deepEqual(result, { slotId: 'fixture-user:fixture-account', added: true });
      assert.deepEqual(rows(f.store), {
        slot: {
          account_id: 'fixture-user:fixture-account', chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account',
          source: 'qlb-add', fingerprint: rows(f.store).slot?.fingerprint,
        },
        accounts: [{ id: 'fixture-account', provider: 'openai-codex' }],
        lineage: [{ cause: 'add', by: 'qlb-cli', evidence: 'add' }],
        relogins: [],
      });
      assert.match(f.calls.join('\n'), /config:\/tmp\/codex-add-fixture\/config.toml:cli_auth_credentials_store = "file"/);
      assert.ok(f.calls.includes('login:codex:login:/tmp/codex-add-fixture'));
      assert.ok(f.calls.includes('remove:/tmp/codex-add-fixture'));
      assert.doesNotThrow(() => f.keychain.getSync(qlbKeychainService('openai-codex', result.slotId), QLB_KEYCHAIN_ACCOUNT));
    } finally { f.store.close(); }
  });

  it('refuses an existing identity without --replace and removes the temporary login home', async () => {
    const f = fixture();
    try {
      await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, f.deps);
      await assert.rejects(
        addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, f.deps),
        (error: unknown) => error instanceof CodexAddError && error.exitCode === 3,
      );
      assert.equal(f.calls.filter((call) => call === 'remove:/tmp/codex-add-fixture').length, 2);
      assert.equal(rows(f.store).lineage.length, 1);
    } finally { f.store.close(); }
  });

  it('replaces only the identical composite slot, records lineage and clears its relogin state', async () => {
    const f = fixture(document('first-fixture-refresh'));
    try {
      await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, f.deps);
      f.deps.readAuth = async () => ({ status: 'ok', doc: document('second-fixture-refresh') });
      const result = await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth', replace: 'fixture-user:fixture-account' }, f.deps);
      assert.deepEqual(result, { slotId: 'fixture-user:fixture-account', added: false });
      assert.deepEqual(rows(f.store).lineage.map((row) => row.cause), ['add', 'replace']);
      assert.deepEqual(rows(f.store).relogins, [{ kind: 'identity-replaced' }]);
      const service = qlbKeychainService('openai-codex', result.slotId);
      assert.doesNotThrow(() => f.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT));
    } finally { f.store.close(); }
  });

  it('fails closed when the native auth file changes during the isolated login', async () => {
    const f = fixture();
    let count = 0;
    f.setHash(() => (++count === 1 ? 'before' : 'after'));
    try {
      await assert.rejects(addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, f.deps), /native Codex auth\.json changed/);
      assert.equal(rows(f.store).slot, undefined);
      assert.ok(f.calls.includes('remove:/tmp/codex-add-fixture'));
    } finally { f.store.close(); }
  });

  it('cleans the temporary directory on login failure and through the injected signal cleanup', async () => {
    const f = fixture();
    f.deps.login = async () => 1;
    try {
      await assert.rejects(addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, f.deps), /codex login failed/);
      assert.ok(f.calls.includes('remove:/tmp/codex-add-fixture'));

      const g = fixture();
      try {
        const pending = addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, {
          ...g.deps,
          login: async () => new Promise<number>(() => undefined),
        });
        await Promise.resolve();
        g.fireCleanup();
        assert.ok(g.calls.includes('remove:/tmp/codex-add-fixture'));
        void pending;
      } finally { g.store.close(); }
    } finally { f.store.close(); }
  });
});
