import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { defaultConfig } from '../src/config';
import { credentialFingerprint } from '../src/anthropic-oauth';
import { createCutoverCommand } from '../src/commands/cutover';
import { CSWAP_ANTHROPIC_STORE, CONSUME_STATE } from '../src/cswap-consume';
import { CUTOVER_BEGIN_IN_PROGRESS, beginCutover, phase } from '../src/lifecycle';
import type { CswapAgent } from '../src/cswap-agent';
import type { CommandContext } from '../src/registry';
import { openStore } from '../src/store';

function fixture(): { root: string; dbPath: string; context: CommandContext; output: string[]; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'qlb-cutover-command-'));
  const dbPath = join(root, 'qlb.db');
  const store = openStore(dbPath);
  store.close();
  const config = { ...defaultConfig(root), dbPath };
  const output: string[] = [];
  return {
    root,
    dbPath,
    output,
    context: {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      env: { QLB_TEST_MODE: '1', QLB_HOME: root, HOME: root },
      config,
      loadConfig: () => config,
      home: root,
      registerSecret: () => {},
      deliverSecret: () => {},
      knownSecrets: () => [],
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

class TestKeychain {
  private readonly values = new Map<string, string>();

  async get(service: string, account: string): Promise<string> {
    const value = this.values.get(`${service}\0${account}`);
    if (value === undefined) throw new Error('item not found');
    return value;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    this.values.set(`${service}\0${account}`, value);
  }
}

function credential(account: string, refresh: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${account}`, refreshToken: refresh, expiresAt: 1_800_000_000_000 } });
}

function prepareDeferredCommit(dbPath: string): void {
  const store = openStore(dbPath);
  try {
    beginCutover(store, 10);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO claude_slots (account_id, slot_num, config_json, added_at)
        VALUES (?, ?, ?, ?)`).run('claude-a', 1, '{}', 10);
    } finally { db.close(); }
    store.recordSwitch({ provider: 'anthropic', fromAccount: 'claude-a', toAccount: 'claude-b', trigger: 'manual', outcome: 'ok' });
    store.recordSwitch({ provider: 'anthropic', fromAccount: 'claude-b', toAccount: 'claude-a', trigger: 'manual', outcome: 'ok' });
    store.setConfig('keychain.liveItemsAuthorizedAt', '19');
    store.upsertMigration(CSWAP_ANTHROPIC_STORE, CONSUME_STATE, '{}', 20);
  } finally { store.close(); }
}

test('begin calls the injected agent in S57 order', async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const agent: CswapAgent = {
      bootout: () => { calls.push('bootout'); return { ok: true }; },
      disable: () => { calls.push('disable'); return { ok: true }; },
      movePlist: () => { calls.push('movePlist'); return { ok: true }; },
      drain: () => { calls.push('drain'); return { ok: true }; },
      restorePlist: () => { calls.push('restorePlist'); return { ok: true }; },
    };
    let factoryCalls = 0;
    const command = createCutoverCommand({
      makeAgent: (ctx) => {
        factoryCalls += 1;
        assert.equal(ctx, f.context);
        return agent;
      },
    });

    assert.equal(await command.execute!(['begin', '--json'], f.context), 0);
    assert.equal(factoryCalls, 1);
    assert.deepEqual(calls, ['bootout', 'disable', 'movePlist', 'drain']);
    assert.deepEqual(JSON.parse(f.output[0]!), { ok: true, state: 'cutting-over' });
  } finally {
    f.cleanup();
  }
});

test('commit records release_sha', async () => {
  const f = fixture();
  try {
    const sha = 'a'.repeat(40);
    const releaseDir = join(f.root, 'app', sha);
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, 'release.json'), JSON.stringify({ sha, digest: 'b'.repeat(64) }));
    symlinkSync(sha, join(f.root, 'app', 'current'));
    prepareDeferredCommit(f.dbPath);

    const command = createCutoverCommand();
    assert.equal(await command.execute!(['commit', '--pi-deferred', '--json'], f.context), 0);
    assert.equal(JSON.parse(f.output[0]!).row.releaseSha, sha);
    const store = openStore(f.dbPath);
    try { assert.equal(phase(store).releaseSha, sha); } finally { store.close(); }
  } finally {
    f.cleanup();
  }
});

test('a test process stays guarded when the command context lacks the flag', async () => {
  const f = fixture();
  const saved = process.env.QLB_TEST_MODE;
  process.env.QLB_TEST_MODE = '1';
  try {
    const { QLB_TEST_MODE: _dropped, ...env } = f.context.env;
    const command = createCutoverCommand();

    assert.equal(await command.execute!(['begin', '--json'], { ...f.context, env }), 3);
    assert.equal(JSON.parse(f.output[0]!).code, 'cswap-restore-failed');
  } finally {
    if (saved === undefined) delete process.env.QLB_TEST_MODE;
    else process.env.QLB_TEST_MODE = saved;
    f.cleanup();
  }
});

test('test mode without an injected agent never reaches launchctl', async () => {
  const f = fixture();
  try {
    const command = createCutoverCommand();

    assert.equal(await command.execute!(['begin', '--json'], f.context), 3);
    assert.deepEqual(JSON.parse(f.output[0]!), {
      ok: false,
      code: 'cswap-restore-failed',
      state: 'cutting-over',
    });
  } finally {
    f.cleanup();
  }
});

test('cutover begin then abort with no QLB agent installed ends aborted with C-swap restored', async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const agent: CswapAgent = {
      bootout: () => { calls.push('cswap-bootout'); return { ok: true }; },
      disable: () => { calls.push('cswap-disable'); return { ok: true }; },
      movePlist: () => { calls.push('cswap-move'); return { ok: true }; },
      drain: () => { calls.push('cswap-drain'); return { ok: true }; },
      restorePlist: () => { calls.push('restore-cswap'); return { ok: true }; },
    };
    const command = createCutoverCommand({
      makeAgent: () => agent,
      undoCswap: {
        bootoutQlbAgent: () => { calls.push('bootout-qlb'); return { ok: true }; },
        listQlbPids: () => [], listHeldLocks: () => [], pendingStash: () => null,
      },
    });
    // The production mover is intentionally selected: no test-mode marker and
    // no injected QLB plist mover. The temporary HOME has no LaunchAgent.
    const productionContext = { ...f.context, env: { QLB_HOME: f.root, HOME: f.root } };

    assert.equal(await command.execute!(['begin'], productionContext), 0);
    assert.equal(await command.execute!(['abort'], productionContext), 0);
    assert.deepEqual(calls, ['cswap-bootout', 'cswap-disable', 'cswap-move', 'cswap-drain', 'bootout-qlb', 'restore-cswap']);
    const completed = openStore(f.dbPath);
    try {
      assert.equal(phase(completed).state, 'aborted');
      assert.equal(phase(completed).note, null);
    } finally { completed.close(); }
    assert.match(f.output.at(-1)!, /qlb lifecycle close \d+/);
  } finally { f.cleanup(); }
});

test('direct cutover abort observes the cutover-begin in-progress fence', async () => {
  const f = fixture();
  try {
    const store = openStore(f.dbPath);
    try {
      beginCutover(store, 10);
      const db = new DatabaseSync(f.dbPath);
      try { db.prepare('UPDATE lifecycle SET note = ?').run(CUTOVER_BEGIN_IN_PROGRESS); } finally { db.close(); }
    } finally { store.close(); }
    const command = createCutoverCommand();

    assert.equal(await command.execute!(['abort', '--json'], f.context), 3);
    assert.deepEqual(JSON.parse(f.output[0]!), { ok: false, code: CUTOVER_BEGIN_IN_PROGRESS });
    const current = openStore(f.dbPath);
    try { assert.equal(phase(current).state, 'cutting-over'); } finally { current.close(); }
  } finally { f.cleanup(); }
});

test('abort after import hands back and ends aborted', async () => {
  const f = fixture();
  try {
    const keychain = new TestKeychain();
    const active = credential('account-a', 'refresh-current');
    await keychain.set('qlb:anthropic:account-a', 'qlb', active);
    const store = openStore(f.dbPath);
    try {
      beginCutover(store, 10);
      const db = new DatabaseSync(f.dbPath);
      try {
        db.prepare(`INSERT INTO claude_slots (account_id, slot_num, email, config_json, fingerprint, added_at, source, dead)
          VALUES (?, ?, ?, '{}', ?, ?, 'cswap-import', 0)`).run('account-a', 1, 'a@example.test', credentialFingerprint(active), 10);
        db.prepare("INSERT INTO active_login (provider, account_id, since, set_by) VALUES ('anthropic', 'account-a', 10, 'test')").run();
      } finally { db.close(); }
    } finally { store.close(); }
    const agent: CswapAgent = {
      bootout: () => ({ ok: true }), disable: () => ({ ok: true }), movePlist: () => ({ ok: true }), drain: () => ({ ok: true }), restorePlist: () => ({ ok: true }),
    };
    const command = createCutoverCommand({
      makeAgent: () => agent,
      undoCswap: {
        keychain,
        backupDir: f.root,
        bootoutQlbAgent: () => ({ ok: true }), listQlbPids: () => [], listHeldLocks: () => [], pendingStash: () => null,
        withActiveLocks: async (fn) => fn(),
        readActiveCredential: async () => ({ credential: active, accountId: 'account-a' }),
        resyncActive: async () => undefined,
        validateActiveSequence: async () => undefined,
        setActiveAccountNumber: async () => undefined,
        moveQlbPlist: () => ({ ok: true }),
      },
    });

    assert.equal(await command.execute!(['abort'], f.context), 0);
    assert.equal(await keychain.get('claude-swap', 'account-1-a@example.test'), active);
    const completed = openStore(f.dbPath);
    try { assert.equal(phase(completed).state, 'aborted'); } finally { completed.close(); }
  } finally { f.cleanup(); }
});
