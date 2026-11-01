import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { appendEvidenceGap, GateFailure, GateRefused, runPiGate } from '../src/pi-gate';
import { piEvidenceGapCheck } from '../src/checks/pi-evidence-gap';
import { defaultPiMigratePaths, migratePiSingleProvider } from '../src/pi-migrate';
import { createSingleGrantMigration, createStaticKeyMigration, Migration } from '../src/migration';
import { MockKeychain, platformKeychain } from '../src/keychain';
import { redactSecrets } from '../src/redact';
import { beginCutover } from '../src/lifecycle';
import { openStore, openStoreConnection } from '../src/store';

function fixtureDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'qlb-gate-guard-')), 'qlb.db');
  const store = openStore(path);
  beginCutover(store);
  store.close();
  return path;
}

function fakePiScript(): { root: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-gate-pi-'));
  const root = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const script = join(root, 'dist', 'bundle', 'host.js');
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
  writeFileSync(script, '#!/usr/bin/env node\n');
  chmodSync(script, 0o755);
  return { root: realpathSync(root), script: realpathSync(script) };
}

describe('qlb gate core (S30/S54)', () => {
  it('refuses a wrong parent before resolution with no credential output', async () => {
    const stdout: string[] = [];
    let read = false;
    const result = await runPiGate('xai', {
      dbPath: fixtureDb(),
      env: { QLB_PI_TOKEN_CALL: '1' },
      deliver: (value) => stdout.push(value),
      guard: () => false,
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      provider: { read: () => { read = true; return { token: 'fixture-secret', accountId: 'xai-default', source: 'fixture' }; } },
    });
    assert.equal(result, 3);
    assert.equal(read, false);
    assert.deepEqual(stdout, []);
  });

  it('counts value-free evidence-gap records for doctor without retrying a DB write', () => {
    const dbPath = fixtureDb();
    appendEvidenceGap(dbPath, 'xai');
    const check = piEvidenceGapCheck(dbPath);
    assert.equal(check.level, 'WARN');
    assert.equal(check.detail && (check.detail as { gaps: number }).gaps, 1);
  });

  it('resolves outside the evidence transaction and delivers only the allowlisted JSON shape', async () => {
    const dbPath = fixtureDb();
    const { root, script } = fakePiScript();
    const trace: string[] = [];
    const output: string[] = [];
    const result = await runPiGate('xai', {
      dbPath,
      env: { QLB_PI_TOKEN_CALL: '1' },
      deliver: (value) => output.push(value),
      guard: (env) => env.QLB_PI_TOKEN_CALL === '1',
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      provider: {
        read: () => {
          trace.push('resolve');
          return {
            token: 'fixture-secret', accountId: 'xai-default', source: `fixture:${root}:${script}`, expiresAt: 123,
            refresh: 'must-not-deliver', grant: { refresh: 'must-not-deliver' },
          } as never;
        },
      },
      sqlTrace: (sql) => trace.push(sql),
    });
    assert.equal(result, 0);
    assert.ok(trace.indexOf('resolve') < trace.indexOf('BEGIN IMMEDIATE'), trace.join('\n'));
    assert.equal(trace.filter((entry) => entry === 'BEGIN IMMEDIATE').length, 1);
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(output[0]!), {
      token: 'fixture-secret', accountId: 'xai-default', source: `fixture:${root}:${script}`, expiresAt: 123,
    });
  });

  it('accepts owner/auth files written by the real Anthropic and xai migration writers', async () => {
    const anthropicRoot = mkdtempSync(join(tmpdir(), 'qlb-gate-anthropic-'));
    const anthropicAgent = join(anthropicRoot, '.pi', 'agent');
    mkdirSync(anthropicAgent, { recursive: true, mode: 0o700 });
    const anthropicStore = openStore(join(anthropicRoot, 'qlb.db'));
    try {
      const migration = new Migration(
        anthropicStore,
        new MockKeychain(),
        join(anthropicAgent, 'anthropic-pool.json'),
        join(anthropicAgent, 'qlb-owner.json'),
      );
      writeFileSync(join(anthropicAgent, 'anthropic-pool.json'), JSON.stringify({
        accounts: [{ id: 'anthropic-a', name: 'Anthropic A', credentials: {
          type: 'oauth', access: 'anthropic-access', refresh: 'anthropic-refresh', expires: Date.now() + 60_000,
        } }],
      }));
      migration.stage();
      await migration.rehearse(async () => ({ ok: true }));
      migration.commit();
    } finally {
      anthropicStore.close();
    }
    const xaiRoot = mkdtempSync(join(tmpdir(), 'qlb-gate-xai-'));
    const xaiPaths = defaultPiMigratePaths(xaiRoot);
    mkdirSync(join(xaiRoot, '.pi', 'agent'), { recursive: true, mode: 0o700 });
    writeFileSync(xaiPaths.authJsonPath, JSON.stringify({ xai: {
      type: 'oauth', access: 'xai-access', refresh: 'xai-refresh', expires: Date.now() + 60_000,
    } }));
    migratePiSingleProvider('xai', xaiPaths, { keychain: new MockKeychain() });

    for (const [provider, agentDir] of ([['anthropic', anthropicAgent], ['xai', join(xaiRoot, '.pi', 'agent')]] as const)) {
      const output: string[] = [];
      const result = await runPiGate(provider, {
        dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => output.push(value),
        guard: () => true, admitted: () => ({ ok: true }), piAgentDir: agentDir,
        provider: { read: () => ({ token: `${provider}-token`, accountId: `${provider}-default`, source: 'fixture' }) },
      });
      assert.equal(result, 0, provider);
      assert.equal(output.length, 1, provider);
    }
  });

  it('serves a v2 xai entry whose staged auth key differs from its provider name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-gate-custom-auth-key-'));
    const agentDir = join(root, '.pi', 'agent');
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, 'qlb-owner.json'), JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }) + '\n');
    writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
      xai: { type: 'oauth', access: 'native-xai-access', refresh: 'native-xai-refresh' },
      grok: { type: 'oauth', access: 'qlb-managed', refresh: '' },
    }) + '\n');
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    try {
      beginCutover(store);
      store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({ authJsonKey: 'grok' }));
    } finally { store.close(); }
    const output: string[] = [];
    const result = await runPiGate('xai', {
      dbPath, env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => output.push(value),
      guard: () => true, admitted: () => ({ ok: true }), piAgentDir: agentDir,
      provider: { read: () => ({ token: 'xai-token', accountId: 'xai-default', source: 'fixture' }) },
    });
    assert.equal(result, 0);
    assert.equal(output.length, 1);
  });

  it('serves openrouter from a v2 entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-gate-openrouter-map-'));
    const agentDir = join(root, '.pi', 'agent');
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, 'qlb-owner.json'), JSON.stringify({ providers: {
      openrouter: { mode: 'qlb', since: 1 },
    } }) + '\n');
    const output: string[] = [];
    const result = await runPiGate('openrouter', {
      dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => output.push(value),
      guard: () => true, admitted: () => ({ ok: true }), piAgentDir: agentDir,
      provider: { read: () => ({ token: 'openrouter-token', accountId: 'openrouter-default', source: 'fixture' }) },
    });
    assert.equal(result, 0);
    assert.equal(output.length, 1);
  });

  it('serves an OpenRouter credential staged by Migration through the real gate resolver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-gate-openrouter-migration-'));
    const agentDir = join(root, '.pi', 'agent');
    const ownerPath = join(agentDir, 'qlb-owner.json');
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const store = openStore(join(root, 'qlb.db'));
    try {
      const migration = createStaticKeyMigration(
        store,
        platformKeychain,
        'openrouter',
        ownerPath,
        () => 'openrouter-test-key',
      );
      migration.stage();
      await migration.rehearse(async () => ({ ok: true }));
      migration.commit();

      const output: string[] = [];
      const result = await runPiGate('openrouter', {
        dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => output.push(value),
        guard: () => true, admitted: () => ({ ok: true }), piAgentDir: agentDir,
      });
      assert.equal(result, 0);
      assert.equal(output.length, 1);
    } finally {
      store.close();
    }
  });

  it('accepts legacy per-provider ownership alongside a P7a owner map', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-gate-mixed-'));
    const paths = defaultPiMigratePaths(root);
    const agentDir = join(root, '.pi', 'agent');
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.authJsonPath, JSON.stringify({
      xai: { type: 'oauth', access: 'xai-access', refresh: 'xai-refresh', expires: Date.now() + 60_000 },
      'openai-codex': {
        type: 'oauth',
        access: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
          'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account' },
        })).toString('base64url')}.sig`,
        refresh: 'codex-refresh',
        expires: Date.now() + 60_000,
        accountId: 'fixture-account',
      },
    }));
    const store = openStore(join(root, 'qlb.db'));
    try {
      const legacy = createSingleGrantMigration(
        store, new MockKeychain(), 'openai-codex', paths.authJsonPath,
        join(agentDir, 'qlb-owner-openai-codex.json'),
      );
      legacy.stage();
      await legacy.rehearse(async () => ({ ok: true }));
      legacy.commit();
      migratePiSingleProvider('xai', paths, { keychain: new MockKeychain() });
    } finally {
      store.close();
    }

    for (const provider of ['xai', 'openai-codex'] as const) {
      const output: string[] = [];
      const result = await runPiGate(provider, {
        dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => output.push(value),
        guard: () => true, admitted: () => ({ ok: true }), piAgentDir: agentDir,
        provider: { read: () => ({ token: `${provider}-token`, accountId: `${provider}-default`, source: 'fixture' }) },
      });
      assert.equal(result, 0, provider);
      assert.equal(output.length, 1, provider);
    }
  });

  it('refuses a malformed per-provider owner file without crashing', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'qlb-gate-owner-malformed-'));
    writeFileSync(join(agentDir, 'qlb-owner-xai.json'), '{not-json');
    const stderr: string[] = [];
    const result = await runPiGate('xai', {
      dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: () => undefined, stderr: (line) => stderr.push(line),
      guard: () => true, admitted: () => ({ ok: true }), piAgentDir: agentDir,
      provider: { read: () => ({ token: 'never', accountId: 'never', source: 'fixture' }) },
    });
    assert.equal(result, 1);
    assert.deepEqual(stderr, ['owner-file-malformed']);
  });

  it('lets an owner entry supersede stale not-applicable state but refuses without one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-gate-not-applicable-'));
    const paths = defaultPiMigratePaths(root);
    mkdirSync(join(root, '.pi', 'agent'), { recursive: true, mode: 0o700 });
    writeFileSync(paths.authJsonPath, JSON.stringify({ xai: {
      type: 'oauth', access: 'xai-access', refresh: 'xai-refresh', expires: Date.now() + 60_000,
    } }));
    migratePiSingleProvider('xai', paths, { keychain: new MockKeychain() });
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    try {
      beginCutover(store);
      store.setConfig('pi.xai.state', 'not-applicable');
    } finally { store.close(); }

    const served: string[] = [];
    const result = await runPiGate('xai', {
      dbPath, env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => served.push(value),
      guard: () => true, admitted: () => ({ ok: true }), piAgentDir: join(root, '.pi', 'agent'),
      provider: { read: () => ({ token: 'xai-token', accountId: 'xai-default', source: 'fixture' }) },
    });
    assert.equal(result, 0);
    assert.equal(served.length, 1);

    const missingStderr: string[] = [];
    const missing = await runPiGate('xai', {
      dbPath, env: { QLB_PI_TOKEN_CALL: '1' }, deliver: () => undefined, stderr: (line) => missingStderr.push(line),
      guard: () => true, admitted: () => ({ ok: true }), piAgentDir: mkdtempSync(join(tmpdir(), 'qlb-gate-no-owner-')),
      provider: { read: () => ({ token: 'never', accountId: 'never', source: 'fixture' }) },
    });
    assert.equal(missing, 1);
    assert.deepEqual(missingStderr, ['provider-not-applicable']);
  });

  it('re-checks lifecycle admission inside evidence before delivery', async () => {
    const dbPath = fixtureDb();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runPiGate('xai', {
      dbPath, env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => stdout.push(value), stderr: (line) => stderr.push(line),
      guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined,
      provider: { read: () => {
        const db = openStoreConnection(dbPath);
        try { db.prepare("UPDATE lifecycle SET state = 'undoing'").run(); } finally { db.close(); }
        return { token: 'xai-token', accountId: 'xai-default', source: 'fixture' };
      } },
    });
    assert.equal(result, 3);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, ['undo-in-progress']);
    const db = openStoreConnection(dbPath, true);
    try {
      assert.equal(db.prepare("SELECT 1 FROM config WHERE key = 'pi.xai.lastServedAt'").get(), undefined);
    } finally { db.close(); }
  });

  it('delivers while still holding the evidence write lock, so no transition can land in between', async () => {
    const dbPath = fixtureDb();
    let lockedDuringDelivery: boolean | undefined;
    const result = await runPiGate('xai', {
      dbPath, env: { QLB_PI_TOKEN_CALL: '1' }, guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined,
      provider: { read: () => ({ token: 'xai-token', accountId: 'xai-default', source: 'fixture' }) },
      deliver: () => {
        const other = openStoreConnection(dbPath);
        try {
          other.exec('PRAGMA busy_timeout = 0');
          try { other.exec('BEGIN IMMEDIATE'); other.exec('ROLLBACK'); lockedDuringDelivery = false; } catch { lockedDuringDelivery = true; }
        } finally { other.close(); }
      },
    });
    assert.equal(result, 0);
    assert.equal(lockedDuringDelivery, true);
  });

  it('when the write lock cannot be taken, re-reads the phase and refuses during undo', async () => {
    const dbPath = fixtureDb();
    const setup = openStoreConnection(dbPath);
    try { setup.prepare("UPDATE lifecycle SET state = 'undoing'").run(); } finally { setup.close(); }
    const holder = openStoreConnection(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    const stdout: string[] = [];
    const stderr: string[] = [];
    let gaps = 0;
    try {
      const result = await runPiGate('xai', {
        dbPath, env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => stdout.push(value), stderr: (line) => stderr.push(line),
        guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined, evidenceGap: () => { gaps += 1; },
        open: (path) => { const db = openStoreConnection(path); db.exec('PRAGMA busy_timeout = 20'); return db; },
        provider: { read: () => ({ token: 'xai-token', accountId: 'xai-default', source: 'fixture' }) },
      });
      assert.equal(result, 3);
      assert.deepEqual(stdout, []);
      assert.deepEqual(stderr, ['undo-in-progress']);
      assert.equal(gaps, 0);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('when the write lock cannot be taken in an admitted phase, records an evidence gap and still serves', async () => {
    const dbPath = fixtureDb();
    const holder = openStoreConnection(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    const stdout: string[] = [];
    let gaps = 0;
    try {
      const result = await runPiGate('xai', {
        dbPath, env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => stdout.push(value),
        guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined, evidenceGap: () => { gaps += 1; },
        open: (path) => { const db = openStoreConnection(path); db.exec('PRAGMA busy_timeout = 20'); return db; },
        provider: { read: () => ({ token: 'xai-token', accountId: 'xai-default', source: 'fixture' }) },
      });
      assert.equal(result, 0);
      assert.equal(stdout.length, 1);
      assert.equal(gaps, 1);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('fails a non-migrated provider with its prerequisite cause', async () => {
    const stderr: string[] = [];
    const result = await runPiGate('xai', {
      dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: () => undefined, stderr: (line) => stderr.push(line),
      guard: () => true, admitted: () => ({ ok: true }), piAgentDir: mkdtempSync(join(tmpdir(), 'qlb-gate-unmigrated-')),
      provider: { read: () => ({ token: 'never', accountId: 'never', source: 'fixture' }) },
    });
    assert.equal(result, 1);
    assert.deepEqual(stderr, ['owner-entry-missing']);
  });

  it('reports an absent provider module as missing-provider-gate without stdout', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runPiGate('xai', {
      dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => stdout.push(value), stderr: (line) => stderr.push(line),
      guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined,
      loadGate: () => { throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); },
    });
    assert.equal(result, 3);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, ['missing-provider-gate']);
  });

  it('refuses a live C-swap process with exit 3 before provider prerequisites and reads nothing', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let prerequisites = 0;
    let reads = 0;
    const result = await runPiGate('xai', {
      dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => stdout.push(value), stderr: (line) => stderr.push(line),
      guard: () => true, admitted: () => ({ ok: true }),
      cswapProcesses: () => [{} as never],
      provider: {
        prerequisites: () => { prerequisites += 1; },
        read: () => { reads += 1; return { token: 'never', accountId: 'never', source: 'fixture' }; },
      },
    });
    assert.equal(result, 3);
    assert.equal(prerequisites, 0);
    assert.equal(reads, 0);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, ['cswap-process-alive']);
  });

  it('refuses an unreadable C-swap process table with exit 3', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runPiGate('xai', {
      dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => stdout.push(value), stderr: (line) => stderr.push(line),
      guard: () => true, admitted: () => ({ ok: true }),
      cswapProcesses: () => { throw new Error('fixture process table unavailable'); },
      prerequisites: () => { throw new Error('must not run'); },
      provider: { read: () => { throw new Error('must not read'); } },
    });
    assert.equal(result, 3);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, ['cswap-process-check-failed']);
  });

  it('under test mode with no injected process check the gate does not spawn ps', async () => {
    const output: string[] = [];
    let listed = 0;
    const result = await runPiGate('xai', {
      dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => output.push(value),
      guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined,
      listCswap: () => { listed += 1; return []; },
      provider: { read: () => ({ token: 'xai-token', accountId: 'xai-default', source: 'fixture' }) },
    });
    assert.equal(result, 0);
    assert.equal(listed, 0);
    assert.equal(output.length, 1);
  });

  it('returns exit 3 with no stdout when a provider module refuses', async () => {
    const output: string[] = [];
    const stderr: string[] = [];
    const result = await runPiGate('xai', {
      dbPath: fixtureDb(), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => output.push(value), stderr: (line) => stderr.push(line),
      guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined,
      provider: { read: () => { throw new GateRefused('identity-mismatch'); } },
    });
    assert.equal(result, 3);
    assert.deepEqual(output, []);
    assert.deepEqual(stderr, ['identity-mismatch']);
  });

  it('the provider module receives the configured dbPath and env through context', async () => {
    const dbPath = fixtureDb();
    const env = { QLB_PI_TOKEN_CALL: '1', FIXTURE: 'context' };
    let context: unknown;
    const result = await runPiGate('xai', {
      dbPath, env, piAgentDir: '/fixture/pi-agent', deliver: () => undefined,
      guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined,
      provider: {
        context: (value) => { context = value; },
        read: () => ({ token: 'xai-token', accountId: 'xai-default', source: 'fixture' }),
      },
    });
    assert.equal(result, 0);
    assert.deepEqual(context && {
      dbPath: (context as { dbPath: string }).dbPath,
      env: (context as { env: NodeJS.ProcessEnv }).env,
      piAgentDir: (context as { piAgentDir?: string }).piAgentDir,
    }, { dbPath, env, piAgentDir: '/fixture/pi-agent' });
    assert.equal(typeof (context as { autoLog: unknown }).autoLog, 'function');
  });

  it('preserves explicit provider causes, registers the bare token, and opens one gate connection', async () => {
    const dbPath = fixtureDb();
    const registered: string[] = [];
    let opened = 0;
    const result = await runPiGate('xai', {
      dbPath, env: { QLB_PI_TOKEN_CALL: '1' }, deliver: () => undefined, registerSecret: (value) => registered.push(value),
      guard: () => true, prerequisites: () => undefined,
      open: (path) => { opened += 1; return openStoreConnection(path); },
      provider: { read: () => ({ token: 'bare-fixture-token', accountId: 'xai-default', source: 'fixture' }) },
    });
    assert.equal(result, 0);
    assert.equal(opened, 1);
    assert.deepEqual(registered, ['bare-fixture-token']);
    assert.equal(redactSecrets('later stderr bare-fixture-token', registered), 'later stderr [redacted]');

    const stderr: string[] = [];
    const refused = await runPiGate('xai', {
      dbPath, env: { QLB_PI_TOKEN_CALL: '1' }, deliver: () => undefined, stderr: (line) => stderr.push(line),
      guard: () => true, prerequisites: () => undefined, admitted: () => ({ ok: true }),
      provider: { read: () => { throw new GateFailure('codex-token-expired-renewer-idle'); } },
    });
    assert.equal(refused, 1);
    assert.deepEqual(stderr, ['codex-token-expired-renewer-idle']);
  });
});
