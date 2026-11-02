import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { defaultConfig } from '../src/config';
import { createCutoverCommand } from '../src/commands/cutover';
import { CSWAP_ANTHROPIC_STORE, CONSUME_STATE } from '../src/cswap-consume';
import { beginCutover, phase } from '../src/lifecycle';
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
      env: { QLB_TEST_MODE: '1', QLB_HOME: root },
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
