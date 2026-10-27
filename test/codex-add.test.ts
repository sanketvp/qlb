import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { addCodexAccount, CodexAddError, type CodexAddDeps } from '../src/codex-add';
import { CodexAuthLockCompromised, withCodexAuthLock } from '../src/cc-locks';
import { codexFingerprint, parseCodexAuth } from '../src/codex-auth';
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
    withAuthLock: async (_options, fn) => fn({ assertNotCompromised: () => undefined }),
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

  it('codex add --replace racing import-active serialises', async () => {
    const f = fixture(document('locked-original'));
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-add-lock-'));
    try {
      await addCodexAccount({ home, nativeAuthPath: '/native-auth' }, f.deps);
      f.deps.readAuth = async () => ({ status: 'ok', doc: document('locked-replacement') });
      f.deps.withAuthLock = withCodexAuthLock;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
      const importer = withCodexAuthLock({ home, retryMinMs: 1, retryJitterMs: 0 }, async () => {
        entered();
        await held;
      });
      await enteredLock;
      const replacement = addCodexAccount({
        home, nativeAuthPath: '/native-auth', replace: 'fixture-user:fixture-account',
      }, f.deps);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      assert.equal(rows(f.store).slot?.fingerprint, codexFingerprint(document('locked-original')));
      release();
      await importer;
      await replacement;
      assert.equal(rows(f.store).slot?.fingerprint, codexFingerprint(document('locked-replacement')));
    } finally {
      f.store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('checks native auth twice before persisting, so a change between checks leaves nothing committed', async () => {
    const f = fixture();
    let count = 0;
    f.setHash(() => ['before', 'before', 'after'][count++]!);
    try {
      await assert.rejects(addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, f.deps), /native Codex auth\.json changed/);
      assert.equal(rows(f.store).slot, undefined);
      assert.throws(() => f.keychain.getSync(qlbKeychainService('openai-codex', 'fixture-user:fixture-account'), QLB_KEYCHAIN_ACCOUNT));
      assert.ok(f.calls.includes('remove:/tmp/codex-add-fixture'));
    } finally { f.store.close(); }
  });

  it('restores current and :prev exactly when a replace fails after either credential write', async () => {
    for (const failingWrite of [1, 2]) {
      const f = fixture(document('original'));
      try {
        await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, f.deps);
        f.deps.readAuth = async () => ({ status: 'ok', doc: document('current') });
        await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth', replace: 'fixture-user:fixture-account' }, f.deps);
        const service = qlbKeychainService('openai-codex', 'fixture-user:fixture-account');
        const beforeCurrent = f.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
        const beforePrevious = f.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT);
        const db = (f.store as unknown as { db: DatabaseSync }).db;
        const beforeSlot = db.prepare('SELECT prev_fingerprint FROM codex_slots WHERE account_id = ?').get('fixture-user:fixture-account') as { prev_fingerprint: string | null } | undefined;
        let writes = 0;
        f.deps.keychain = {
          getSync: f.keychain.getSync.bind(f.keychain),
          deleteSync: f.keychain.deleteSync.bind(f.keychain),
          setSync: (target, account, value) => {
            writes += 1;
            if (writes === failingWrite) throw new Error(`injected credential write ${failingWrite}`);
            f.keychain.setSync(target, account, value);
          },
        };
        f.deps.readAuth = async () => ({ status: 'ok', doc: document('replacement') });

        await assert.rejects(
          addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth', replace: 'fixture-user:fixture-account' }, f.deps),
          /injected credential write/,
        );
        assert.equal(f.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), beforeCurrent);
        assert.equal(f.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT), beforePrevious);
        const slot = db.prepare('SELECT prev_fingerprint FROM codex_slots WHERE account_id = ?').get('fixture-user:fixture-account') as { prev_fingerprint: string | null } | undefined;
        assert.equal(slot?.prev_fingerprint, beforeSlot?.prev_fingerprint);
      } finally { f.store.close(); }
    }
  });

  it('restores current and :prev exactly when a database write fails during replace', async () => {
    const f = fixture(document('original'));
    try {
      await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, f.deps);
      f.deps.readAuth = async () => ({ status: 'ok', doc: document('current') });
      await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth', replace: 'fixture-user:fixture-account' }, f.deps);
      const service = qlbKeychainService('openai-codex', 'fixture-user:fixture-account');
      const beforeCurrent = f.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
      const beforePrevious = f.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT);
      const db = (f.store as unknown as { db: DatabaseSync }).db;
      const beforeSlot = db.prepare('SELECT prev_fingerprint FROM codex_slots WHERE account_id = ?').get('fixture-user:fixture-account') as { prev_fingerprint: string | null } | undefined;
      const originalWithDb = f.deps.withDb;
      f.deps.withDb = ((store, fn) => originalWithDb(store, (database) => {
        const failingDatabase = new Proxy(database, {
          get(target, property) {
            if (property === 'prepare') return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes('INSERT INTO accounts')) return statement;
              return new Proxy(statement, { get(statementTarget, statementProperty) {
                if (statementProperty === 'run') return () => { throw new Error('injected database write'); };
                const value = Reflect.get(statementTarget, statementProperty);
                return typeof value === 'function' ? value.bind(statementTarget) : value;
              } });
            };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return fn(failingDatabase);
      })) as typeof f.deps.withDb;
      f.deps.readAuth = async () => ({ status: 'ok', doc: document('replacement') });

      await assert.rejects(
        addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth', replace: 'fixture-user:fixture-account' }, f.deps),
        /injected database write/,
      );
      assert.equal(f.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), beforeCurrent);
      assert.equal(f.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT), beforePrevious);
      const slot = db.prepare('SELECT prev_fingerprint FROM codex_slots WHERE account_id = ?').get('fixture-user:fixture-account') as { prev_fingerprint: string | null } | undefined;
      assert.equal(slot?.prev_fingerprint, beforeSlot?.prev_fingerprint);
    } finally { f.store.close(); }
  });

  it('a takeover after the Keychain replace restores the predecessor and :prev never holds the new credential', async () => {
    const f = fixture(document('takeover-original'));
    try {
      await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, f.deps);
      f.deps.readAuth = async () => ({ status: 'ok', doc: document('takeover-current') });
      await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth', replace: 'fixture-user:fixture-account' }, f.deps);
      const service = qlbKeychainService('openai-codex', 'fixture-user:fixture-account');
      const predecessor = f.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
      const previous = f.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT);
      const replacement = document('takeover-replacement');
      let assertions = 0;
      f.deps.withAuthLock = async (_options, fn) => fn({
        assertNotCompromised: () => {
          assertions += 1;
          if (assertions >= 4) throw new CodexAuthLockCompromised();
        },
      });
      f.deps.readAuth = async () => ({ status: 'ok', doc: replacement });

      await assert.rejects(
        addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth', replace: 'fixture-user:fixture-account' }, f.deps),
        /Codex auth lock ownership was lost/,
      );
      assert.equal(f.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), predecessor);
      assert.equal(f.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT), previous);
      assert.notEqual(
        codexFingerprint(JSON.parse(f.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT))),
        codexFingerprint(replacement),
      );
    } finally { f.store.close(); }
  });

  it('does not restore over a newer replacement committed after its rollback', async () => {
    const f = fixture(document('original'));
    try {
      await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth' }, f.deps);
      f.deps.readAuth = async () => ({ status: 'ok', doc: document('current') });
      await addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth', replace: 'fixture-user:fixture-account' }, f.deps);
      const service = qlbKeychainService('openai-codex', 'fixture-user:fixture-account');
      const newer = document('newer');
      const newerJson = JSON.stringify(newer);
      const db = (f.store as unknown as { db: DatabaseSync }).db;
      const originalWithDb = f.deps.withDb;
      f.deps.withDb = ((store, fn) => originalWithDb(store, (database) => {
        const failingDatabase = new Proxy(database, {
          get(target, property) {
            if (property === 'prepare') return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes('INSERT INTO accounts')) return statement;
              return new Proxy(statement, { get(statementTarget, statementProperty) {
                if (statementProperty === 'run') return () => { throw new Error('injected database write'); };
                const value = Reflect.get(statementTarget, statementProperty);
                return typeof value === 'function' ? value.bind(statementTarget) : value;
              } });
            };
            if (property === 'exec') return (sql: string) => {
              const result = target.exec(sql);
              if (sql === 'ROLLBACK') {
                // This hook models the next writer acquiring the lock immediately
                // after A releases it and committing a newer replacement.
                f.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(document('a-attempt')));
                f.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, newerJson);
                target.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?')
                  .run(codexFingerprint(newer), 'fixture-user:fixture-account');
              }
              return result;
            };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return fn(failingDatabase);
      })) as typeof f.deps.withDb;
      f.deps.readAuth = async () => ({ status: 'ok', doc: document('a-attempt') });

      await assert.rejects(
        addCodexAccount({ home: '/fixture-home', nativeAuthPath: '/native-auth', replace: 'fixture-user:fixture-account' }, f.deps),
        /injected database write/,
      );
      assert.equal(f.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), newerJson);
      assert.equal(f.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT), JSON.stringify(document('a-attempt')));
      assert.equal(rows(f.store).slot?.fingerprint, codexFingerprint(newer));
    } finally { f.store.close(); }
  });

  it('stops the login child before removing its temp home on SIGTERM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-add-signal-'));
    const fakeBin = join(root, 'bin');
    const marker = join(root, 'child.json');
    const helper = join(root, 'helper.cjs');
    try {
      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.MARKER, JSON.stringify({ home: process.env.CODEX_HOME, pid: process.pid }));
process.on('SIGTERM', () => {});
setTimeout(() => {
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(require('node:path').join(process.env.CODEX_HOME, 'auth.json'), '{}');
  process.exit(0);
}, 150);
`);
      chmodSync(fakeCodex, 0o700);
      writeFileSync(helper, `
const fs = require('node:fs');
const { openStore } = require(${JSON.stringify(require.resolve('../src/store'))});
const { MockKeychain } = require(${JSON.stringify(require.resolve('../src/keychain'))});
const { addCodexAccount, productionCodexAddDeps } = require(${JSON.stringify(require.resolve('../src/codex-add'))});
const native = require('node:path').join(process.env.HOME, 'native-auth.json');
fs.writeFileSync(native, '{}');
const store = openStore(':memory:');
addCodexAccount({ home: process.env.HOME, nativeAuthPath: native }, productionCodexAddDeps(store, new MockKeychain(), process.env))
  .then(() => { store.close(); process.exitCode = 0; })
  .catch(() => { store.close(); process.exitCode = 1; });
`);
      const child = spawn(process.execPath, [helper], {
        env: {
          ...process.env,
          QLB_TEST_MODE: '1', QLB_HOME: root, HOME: root,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`, MARKER: marker,
        },
        stdio: 'ignore',
      });
      const markerText = await new Promise<string>((resolve, reject) => {
        const deadline = Date.now() + 2_000;
        const check = (): void => {
          if (existsSync(marker)) { resolve(readFileSync(marker, 'utf8')); return; }
          if (Date.now() >= deadline) { reject(new Error('fake codex did not start')); return; }
          setTimeout(check, 10);
        };
        check();
      });
      const childInfo = JSON.parse(markerText) as { home: string; pid: number };
      child.kill('SIGTERM');
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      assert.notEqual(result.code, 0);
      assert.equal(result.signal, 'SIGTERM');
      assert.equal(existsSync(childInfo.home), false);
      assert.throws(() => process.kill(childInfo.pid, 0), { code: 'ESRCH' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a missing codex spawn without hanging, including signal cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-add-spawn-'));
    const fakeBin = join(root, 'bin');
    const nativeDir = join(root, '.codex');
    const cli = join(process.cwd(), 'dist', 'cli.js');
    const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => spawn(process.execPath, args, {
      env: { QLB_TEST_MODE: '1', QLB_HOME: root, HOME: root, PATH: fakeBin, ...extraEnv },
      stdio: 'ignore',
    });
    const waitForExit = async (child: ReturnType<typeof spawn>) => {
      let timeout: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.once('close', (code, signal) => resolve({ code, signal }));
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('missing codex spawn did not settle within 8 seconds'));
          }, 8_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      return result;
    };
    try {
      mkdirSync(fakeBin);
      mkdirSync(nativeDir);
      writeFileSync(join(nativeDir, 'auth.json'), '{}');
      const cliStore = openStore(join(root, '.qlb', 'qlb.db'));
      try {
        const db = (cliStore as unknown as { db: DatabaseSync }).db;
        db.prepare("INSERT INTO lifecycle (state, began_at) VALUES ('cutting-over', 1)").run();
      } finally { cliStore.close(); }
      const normal = await waitForExit(run([cli, 'codex', 'add']));
      assert.notEqual(normal.code, 0);
      assert.equal(normal.signal, null);
      assert.deepEqual(existsSync(join(root, '.qlb', 'tmp')) ? readdirSync(join(root, '.qlb', 'tmp')) : [], []);

      const helper = join(root, 'signal-spawn-failure.cjs');
      const ready = join(root, 'spawn-failed');
      writeFileSync(helper, `
const { spawn } = require('node:child_process');
const { openStore } = require(${JSON.stringify(require.resolve('../src/store'))});
const { MockKeychain } = require(${JSON.stringify(require.resolve('../src/keychain'))});
const { addCodexAccount, productionCodexAddDeps } = require(${JSON.stringify(require.resolve('../src/codex-add'))});
const fs = require('node:fs');
const path = require('node:path');
const native = path.join(process.env.HOME, '.codex', 'auth.json');
const store = openStore(':memory:');
const deps = productionCodexAddDeps(store, new MockKeychain(), process.env);
deps.login = (options) => new Promise((resolve, reject) => {
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: 'ignore' });
  options.onSpawn(child);
  fs.writeFileSync(process.env.READY, 'spawned');
  child.once('error', (error) => setTimeout(() => reject(error), 1_000));
  child.once('exit', (code) => resolve(code ?? 1));
});
addCodexAccount({ home: process.env.HOME, nativeAuthPath: native }, deps)
  .finally(() => store.close());
`);
      const signalled = run([helper], { READY: ready });
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2_000;
        const check = (): void => {
          if (existsSync(ready)) { resolve(); return; }
          if (Date.now() >= deadline) { reject(new Error('failed-spawn helper did not start')); return; }
          setTimeout(check, 10);
        };
        check();
      });
      signalled.kill('SIGTERM');
      const signalledResult = await waitForExit(signalled);
      assert.equal(signalledResult.signal, 'SIGTERM');
      assert.deepEqual(existsSync(join(root, '.qlb', 'tmp')) ? readdirSync(join(root, '.qlb', 'tmp')) : [], []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
