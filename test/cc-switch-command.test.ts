import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { claudePaths } from '../src/cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { MockKeychain } from '../src/keychain';
import { discoverCommands, type CommandContext } from '../src/registry';
import { openStore, openStoreConnection } from '../src/store';
import {
  createSwitchAnthropicCommand,
  type SwitchAnthropicCommandDeps,
} from '../src/commands/switch-anthropic';
import { switchClaude, type ClaudeSwitchDeps, type ClaudeSwitchResult } from '../src/cc-switch';

const HOME = mkdtempSync(join(tmpdir(), 'qlb-switch-command-'));

function context(home = HOME): { ctx: CommandContext; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    ctx: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      env: { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: join(home, 'qlb') },
      config: defaultConfig(home),
      loadConfig: () => defaultConfig(home),
      home,
      registerSecret: () => {},
      deliverSecret: () => {},
      knownSecrets: () => [],
    },
  };
}

function result(overrides: Partial<ClaudeSwitchResult> = {}): ClaudeSwitchResult {
  return {
    outcome: 'ok', from: 'account-a', to: 'account-b', attempt: 'attempt-1', exitCode: 0,
    ...overrides,
  };
}

function subject(overrides: Partial<SwitchAnthropicCommandDeps> = {}) {
  const store = { close: () => {} };
  const deps: SwitchAnthropicCommandDeps = {
    openStore: () => store as never,
    bootstrap: async (hooks) => { await hooks?.assertAdmitted?.(); await hooks?.reconcileJournals?.(); },
    assertAdmitted: () => ({ ok: true }),
    makeSwitchDeps: async () => ({
      store: {} as never,
      slots: {} as never,
      live: {} as never,
      readConfig: () => ({}),
      resolveProfile: async () => null,
      consume: {} as never,
      env: {}, now: () => 1, by: 'qlb-cli', attempt: 'attempt-1',
    }),
    switchClaude: async () => result(),
    ...overrides,
  };
  return createSwitchAnthropicCommand(deps);
}

describe('qlb switch anthropic command (K5-6)', () => {
  it('wiring lists switch anthropic', () => {
    assert.ok(discoverCommands().some((command) => command.name === 'switch anthropic'));
  });

  it('pre-cutover admission throws AdmissionRefused inside the hook, exits 3 before reconcileJournals, any lock or any read (spies)', async () => {
    const events: string[] = [];
    const command = subject({
      assertAdmitted: () => ({ ok: false, code: 'phase=pre-cutover' }),
      bootstrap: async (hooks) => { events.push('bootstrap'); await hooks?.assertAdmitted?.(); events.push('after-admission'); await hooks?.reconcileJournals?.(); },
      reconcileJournals: async () => { events.push('reconcile'); },
      makeSwitchDeps: async () => { events.push('read-or-lock'); throw new Error('must not run'); },
    });
    const run = context();
    assert.equal(await command.execute!(['account-b'], run.ctx), 3);
    assert.deepEqual(events, ['bootstrap']);
    assert.deepEqual(run.stderr, ['qlb switch anthropic: refused: phase=pre-cutover']);
  });

  it('ok exits 0 and prints the outcome line with from and to taken from the result', async () => {
    const command = subject({ switchClaude: async () => result({ from: 'locked-from', to: 'locked-to' }) });
    const run = context();
    assert.equal(await command.execute!(['ignored'], run.ctx), 0);
    assert.deepEqual(run.stdout, ['switched anthropic: locked-from → locked-to (ok)']);
  });

  it('--json prints exactly the receipt shape (outcome, from, to, switchId, attempt, reason, error, outgoingKind, steps, injected) and no token value', async () => {
    const command = subject({ switchClaude: async () => result({ switchId: 9, outgoingKind: 'own-bytes', injected: false }) });
    const run = context();
    assert.equal(await command.execute!(['account-b', '--json'], run.ctx), 0);
    const receipt = JSON.parse(run.stdout[0]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(receipt).sort(), ['attempt', 'error', 'from', 'injected', 'outcome', 'outgoingKind', 'reason', 'steps', 'switchId', 'to']);
    assert.equal(JSON.stringify(receipt).includes('fixture-access'), false);
  });

  it('a stubbed switchClaude result maps refused to 3, failed and rolled-back to 1, noop to 0, ok with cleanup to 0 with a stderr warning', async () => {
    const cases: Array<[ClaudeSwitchResult['outcome'], number]> = [['refused', 3], ['failed', 1], ['rolled-back', 1], ['noop', 0]];
    for (const [outcome, expected] of cases) {
      const command = subject({ switchClaude: async () => result({ outcome, exitCode: expected as 0 | 1 | 3, reason: outcome === 'refused' ? 'blocked' : undefined }) });
      const run = context();
      assert.equal(await command.execute!(['account-b'], run.ctx), expected, outcome);
    }
    const command = subject({ switchClaude: async () => result({ steps: { started: [], reversed: [], notLanded: [], restoreFailures: [], cleanup: ['journal-io-failed'] } }) });
    const run = context();
    assert.equal(await command.execute!(['account-b'], run.ctx), 0);
    assert.match(run.stderr.join('\n'), /warning/i);
  });

  it('a CLI manual switch leaves no auto.anthropic.left* key (real store)', async () => {
    const run = context();
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    const paths = claudePaths({ home: HOME, env: run.ctx.env });
    writeFileSync(paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } })}\n`);
    const store = openStore(run.ctx.config.dbPath);
    const repository = SqliteClaudeSlotRepository.open(run.ctx.config.dbPath);
    const backend = new MockKeychain();
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(HOME, 'unclaimed'), now: () => 1 });
    const credential = (tag: string) => JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}`, expiresAt: 3_600_001 } });
    await slots.createSlot({ accountId: 'account-a', credential: credential('a'), email: 'a@example.test', orgUuid: 'org-a', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }), source: 'cswap-import' });
    await slots.createSlot({ accountId: 'account-b', credential: credential('b'), email: 'b@example.test', orgUuid: 'org-b', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-b' } }), source: 'cswap-import' });
    await backend.set(paths.keychainService, 'fixture-user', credential('a'));
    store.setActiveLogin('anthropic', 'account-a', 'manual', 1);
    for (const key of ['auto.anthropic.leftHeadroom', 'auto.anthropic.leftRecoveryAt', 'auto.anthropic.leftTrigger']) store.setConfig(key, 'stale');
    const command = subject({
      openStore: () => store,
      switchClaude,
      bootstrap: async (hooks) => { await hooks?.assertAdmitted?.(); },
      makeSwitchDeps: async (_ctx, commandStore, warn) => ({
        store: commandStore as ClaudeSwitchDeps['store'], slots, live: { backend, paths, account: 'fixture-user' },
        readConfig: () => ({ oauthAccount: { accountUuid: 'account-a' } }), resolveProfile: async () => null,
        consume: { postRefresh: async () => ({ status: 500, body: '' }) }, env: run.ctx.env, home: HOME, now: () => 1,
        by: 'qlb-cli', attempt: 'real-store-attempt', journalOwner: { pid: process.pid, lstart: '' }, warn,
      }),
    });
    try {
      assert.equal(await command.execute!(['account-b'], run.ctx), 0);
      const verify = openStore(run.ctx.config.dbPath);
      try {
        assert.equal(verify.getConfig('auto.anthropic.leftHeadroom'), null);
        assert.equal(verify.getConfig('auto.anthropic.leftRecoveryAt'), null);
        assert.equal(verify.getConfig('auto.anthropic.leftTrigger'), null);
      } finally { verify.close(); }
    } finally {
      repository.close();
    }
  });

  it('X26: --inject fail-step without the env exits 2 before admission, and step 5 exits 2', async () => {
    const events: string[] = [];
    const command = subject({ bootstrap: async () => { events.push('admission'); } });
    const disabled = context();
    assert.equal(await command.execute!(['account-b', '--inject', 'fail-step', '8'], disabled.ctx), 2);
    assert.deepEqual(events, []);
    assert.match(disabled.stderr.join('\n'), /QLB_FAULT_INJECTION/);

    const invalid = context();
    invalid.ctx.env.QLB_FAULT_INJECTION = '1';
    assert.equal(await command.execute!(['account-b', '--inject', 'fail-step', '5'], invalid.ctx), 2);
    assert.deepEqual(events, []);
  });

  it('--inject fail-step 8 rolls back one injected row and emits the injected JSON receipt', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-switch-command-inject-'));
    const run = context(home);
    run.ctx.env.QLB_FAULT_INJECTION = '1';
    mkdirSync(join(home, '.claude'), { recursive: true });
    const paths = claudePaths({ home, env: run.ctx.env });
    writeFileSync(paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } })}\n`);
    const store = openStore(run.ctx.config.dbPath);
    const repository = SqliteClaudeSlotRepository.open(run.ctx.config.dbPath);
    const backend = new MockKeychain();
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(home, 'unclaimed'), now: () => 1 });
    const credential = (tag: string) => JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${tag}`, refreshToken: `fixture-refresh-${tag}`, expiresAt: 3_600_001 } });
    try {
      await slots.createSlot({ accountId: 'account-a', credential: credential('a'), email: 'a@example.test', orgUuid: 'org-a', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }), source: 'cswap-import' });
      await slots.createSlot({ accountId: 'account-b', credential: credential('b'), email: 'b@example.test', orgUuid: 'org-b', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-b' } }), source: 'cswap-import' });
      await backend.set(paths.keychainService, 'fixture-user', credential('a'));
      store.setActiveLogin('anthropic', 'account-a', 'manual', 1);
    } finally {
      store.close();
    }
    const command = createSwitchAnthropicCommand({
      openStore,
      bootstrap: async () => {},
      assertAdmitted: () => ({ ok: true }),
      makeSwitchDeps: async (_ctx, commandStore, warn) => ({
        deps: {
          store: commandStore as ClaudeSwitchDeps['store'], slots, live: { backend, paths, account: 'fixture-user' },
          readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
          resolveProfile: async () => null,
          consume: { postRefresh: async () => ({ status: 500, body: '' }), withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn() },
          env: run.ctx.env, home, now: () => 1, by: 'qlb-cli', attempt: 'injected-command-attempt', journalOwner: { pid: process.pid, lstart: '' }, warn,
        },
      }),
    });
    try {
      assert.equal(await command.execute!(['account-b', '--inject', 'fail-step', '8', '--json'], run.ctx), 1);
      const receipt = JSON.parse(run.stdout[0]) as { error: string; injected: boolean; steps: { failedStep: number } };
      assert.deepEqual(receipt, {
        outcome: 'rolled-back', from: 'account-a', to: 'account-b', switchId: null, attempt: 'injected-command-attempt',
        reason: 'fault-injection:fail-step-8', error: 'injected', outgoingKind: null,
        steps: { failedStep: 8, started: [4, 5, 6, 7, 8], reversed: ['config', 7], notLanded: [], restoreFailures: [], cleanup: [] }, injected: true,
      });
      const db = openStoreConnection(run.ctx.config.dbPath, true);
      try {
        const rows = (db.prepare("SELECT outcome, injected, detail, error FROM switch_log WHERE provider = 'anthropic'").all() as Array<{ outcome: string; injected: number; detail: string; error: string }>).map((row) => ({ ...row }));
        assert.deepEqual(rows, [{ outcome: 'rolled-back', injected: 1, detail: 'fault-injection:fail-step-8', error: 'injected' }]);
      } finally { db.close(); }
    } finally {
      repository.close();
    }
  });

  it('--trigger proactive exits 2', async () => {
    const run = context();
    assert.equal(await subject().execute!(['account-b', '--trigger', 'proactive'], run.ctx), 2);
  });

  it('an unknown flag exits 2', async () => {
    const run = context();
    assert.equal(await subject().execute!(['account-b', '--unknown'], run.ctx), 2);
  });

  it('CLAUDE_CONFIG_DIR selects the hashed Keychain service and config path', async () => {
    let received: ClaudeSwitchDeps | undefined;
    const command = subject({ openStore, makeSwitchDeps: undefined, switchClaude: async (deps) => { received = deps; return result(); } });
    const run = context();
    run.ctx.env.CLAUDE_CONFIG_DIR = join(HOME, 'alternate-claude');
    assert.equal(await command.execute!(['account-b'], run.ctx), 0);
    assert.ok(received?.live.paths?.keychainService.includes('Claude Code-credentials-'));
    assert.equal(received?.live.paths?.globalConfigPath, join(HOME, 'alternate-claude', '.claude.json'));
  });

  it('a Phase-C usage error is a stderr warning and does not change the exit code', async () => {
    const command = subject({
      makeSwitchDeps: async (_ctx, _store, warn) => ({
        store: {} as never, slots: {} as never, live: {} as never, readConfig: () => ({}), resolveProfile: async () => null,
        consume: {} as never, env: {}, now: () => 1, by: 'qlb-cli', attempt: 'attempt-1', warn,
        afterSwitch: async () => { throw new Error('usage failed'); },
      }),
      switchClaude: async (deps) => { try { await deps.afterSwitch?.('account-b'); } catch { deps.warn?.('Claude switch post-switch hook failed'); } return result(); },
    });
    const run = context();
    assert.equal(await command.execute!(['account-b'], run.ctx), 0);
    assert.match(run.stderr.join('\n'), /warning/i);
  });

  it('the command passes reconcileJournals through unchanged: undefined when not injected (bootstrap spy receives undefined), and an injected one runs exactly once, after admission and before preconditions (call-count and call-order spy)', async () => {
    let absent: unknown = 'unset';
    const first = subject({ bootstrap: async (hooks) => { absent = hooks?.reconcileJournals; await hooks?.assertAdmitted?.(); } });
    const firstRun = context();
    assert.equal(await first.execute!(['account-b'], firstRun.ctx), 0);
    assert.equal(absent, undefined);

    const events: string[] = [];
    const second = subject({
      reconcileJournals: async () => { events.push('reconcile'); },
      bootstrap: async (hooks) => { await hooks?.assertAdmitted?.(); events.push('admitted'); await hooks?.reconcileJournals?.(); },
      makeSwitchDeps: async () => { events.push('preconditions'); return { store: {} as never, slots: {} as never, live: {} as never, readConfig: () => ({}), resolveProfile: async () => null, consume: {} as never, env: {}, now: () => 1, by: 'qlb-cli', attempt: 'attempt-1' }; },
    });
    const secondRun = context();
    assert.equal(await second.execute!(['account-b'], secondRun.ctx), 0);
    assert.deepEqual(events, ['admitted', 'reconcile', 'preconditions']);
  });
});
