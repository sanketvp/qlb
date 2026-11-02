import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { credentialFingerprint } from '../src/anthropic-oauth';
import { runAuto, type LiveBinding } from '../src/auto';
import { anthropicTick, pollAnthropic } from '../src/auto/anthropic';
import { claudePaths } from '../src/cc-paths';
import { ProbeVerdictMemo } from '../src/cc-resync';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { createCutoverCommand } from '../src/commands/cutover';
import importCswapCommand from '../src/commands/import-cswap';
import { runKeychainCommand, type LiveSwitchReceipt } from '../src/commands/keychain';
import { runAutoCommand } from '../src/commands/auto';
import { runUndoCswapCommand } from '../src/commands/undo-cswap';
import { createSwitchAnthropicCommand } from '../src/commands/switch-anthropic';
import { defaultConfig } from '../src/config';
import { consumeMarkerPathFor, CONSUME_STATE, CSWAP_ANTHROPIC_STORE } from '../src/cswap-consume';
import { doctorQlb } from '../src/diagnostics';
import type { CswapAgent } from '../src/cswap-agent';
import { MockKeychain, platformKeychain } from '../src/keychain';
import { phase } from '../src/lifecycle';
import type { CommandContext } from '../src/registry';
import { openStore, openStoreConnection } from '../src/store';

const NOW = 1_800_000_000_000;

function credential(account: string, refresh: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${account}`, refreshToken: refresh, expiresAt: NOW + 3_600_000 } });
}

function response(usedPct: number): { status: number; body: string } {
  return { status: 200, body: JSON.stringify({ five_hour: { utilization: usedPct }, seven_day: { utilization: 10 } }) };
}

function patchPlatformKeychain(keychain: MockKeychain): () => void {
  const original = {
    get: platformKeychain.get,
    set: platformKeychain.set,
    delete: platformKeychain.delete,
    getSync: platformKeychain.getSync,
    setSync: platformKeychain.setSync,
    deleteSync: platformKeychain.deleteSync,
  };
  Object.assign(platformKeychain, {
    get: keychain.get.bind(keychain),
    set: keychain.set.bind(keychain),
    delete: keychain.delete.bind(keychain),
    getSync: keychain.getSync.bind(keychain),
    setSync: keychain.setSync.bind(keychain),
    deleteSync: keychain.deleteSync.bind(keychain),
  });
  return () => Object.assign(platformKeychain, original);
}

describe('Stage 1 sandbox dress rehearsal (G19)', () => {
  it('drives cutover through automatic switching and a fenced C-swap hand-back', async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-go-live-dress-'));
    const env = { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home, USER: 'fixture-user' };
    const config = defaultConfig(home);
    const output: string[] = [];
    const errors: string[] = [];
    const context: CommandContext = {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      env,
      config,
      loadConfig: () => config,
      home,
      registerSecret: () => {},
      deliverSecret: () => {},
      knownSecrets: () => [],
    };
    const keychain = new MockKeychain();
    const paths = claudePaths({ home, env });
    const backup = dirname(config.cswapSequencePath);
    let clock = NOW;

    const agentCalls: string[] = [];
    const agent: CswapAgent = {
      bootout: () => { agentCalls.push('bootout'); return { ok: true }; },
      disable: () => { agentCalls.push('disable'); return { ok: true }; },
      movePlist: () => { agentCalls.push('movePlist'); return { ok: true }; },
      drain: () => { agentCalls.push('drain'); return { ok: true }; },
      restorePlist: () => { agentCalls.push('restorePlist'); return { ok: true }; },
    };

    const readReceipt = (): Record<string, unknown> => JSON.parse(output.at(-1) ?? '{}') as Record<string, unknown>;
    const resetOutput = (): void => { output.length = 0; errors.length = 0; };

    try {
      mkdirSync(dirname(paths.globalConfigPath), { recursive: true });
      mkdirSync(join(backup, 'configs'), { recursive: true });
      mkdirSync(join(backup, 'credentials'), { recursive: true });
      writeFileSync(paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } })}\n`);
      writeFileSync(config.cswapSequencePath, JSON.stringify({
        activeAccountNumber: 1,
        sequence: [1, 2],
        accounts: {
          1: { email: 'a@example.test', uuid: 'account-a' },
          2: { email: 'b@example.test', uuid: 'account-b' },
        },
      }));
      writeFileSync(join(backup, 'configs', '.claude-config-1-a@example.test.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }));
      writeFileSync(join(backup, 'configs', '.claude-config-2-b@example.test.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-b' } }));
      writeFileSync(join(backup, 'credentials', '.creds-1-a@example.test.enc'), Buffer.from(credential('account-a', 'refresh-a')).toString('base64'));
      await keychain.set('claude-swap', 'account-2-b@example.test', credential('account-b', 'refresh-b'));
      await keychain.set(paths.keychainService, 'fixture-user', credential('account-a', 'refresh-a'));

      await t.test('1. cutover begin drains the injected C-swap agent', async () => {
        const command = createCutoverCommand({ makeAgent: () => agent });
        assert.equal(await command.execute!(['begin', '--json'], context), 0);
        assert.deepEqual(agentCalls, ['bootout', 'disable', 'movePlist', 'drain']);
        assert.deepEqual(readReceipt(), { ok: true, state: 'cutting-over' });
        resetOutput();
      });

      await t.test('2. import brings both fake C-swap accounts into QLB', async () => {
        const restore = patchPlatformKeychain(keychain);
        try {
          assert.equal(await importCswapCommand.execute!(['--json'], context), 0, errors.join('\n'));
        } finally {
          restore();
        }
        const receipt = readReceipt();
        assert.equal(receipt.phase, 'cleaned');
        assert.equal((receipt.slots as unknown[]).length, 2);
        const store = openStore(config.dbPath);
        try {
          assert.equal(store.getActiveLogin('anthropic')?.accountId, 'account-a');
          assert.equal(store.listAccounts('anthropic').length, 2);
          store.upsertMigration(CSWAP_ANTHROPIC_STORE, CONSUME_STATE, '{}');
        } finally { store.close(); }
        mkdirSync(dirname(consumeMarkerPathFor(config.dbPath)), { recursive: true });
        writeFileSync(consumeMarkerPathFor(config.dbPath), `${JSON.stringify({ state: CONSUME_STATE })}\n`);
        resetOutput();
      });

      const switchCommand = createSwitchAnthropicCommand({
        bootstrap: async (hooks) => { await hooks?.assertAdmitted?.(); },
        now: () => clock,
        randomUUID: (() => { let number = 0; return () => `manual-${++number}`; })(),
        makeSwitchDeps: async (_ctx, store, warn) => {
          const repository = SqliteClaudeSlotRepository.open(config.dbPath);
          const slots = new ClaudeSlots({ backend: keychain, repository, stashDir: join(home, '.qlb', 'unclaimed'), now: () => clock });
          return {
            deps: {
              store, slots, live: { backend: keychain, paths, account: 'fixture-user' },
              readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
              resolveProfile: async () => null,
              consume: { postRefresh: async () => ({ status: 500, body: '' }) },
              env, home, now: () => clock, by: 'qlb-cli', attempt: `manual-${clock}`,
              journalOwner: { pid: process.pid, lstart: '' }, warn,
            },
            close: () => repository.close(),
          };
        },
      });

      await t.test('3. two manual switches round-trip the active Claude login', async () => {
        assert.equal(await switchCommand.execute!(['account-b', '--json'], context), 0, errors.join('\n'));
        assert.equal(readReceipt().outcome, 'ok');
        assert.equal(readReceipt().to, 'account-b');
        let store = openStore(config.dbPath);
        try { assert.equal(store.getActiveLogin('anthropic')?.accountId, 'account-b'); } finally { store.close(); }
        resetOutput();
        clock += 1;
        assert.equal(await switchCommand.execute!(['account-a', '--json'], context), 0, errors.join('\n'));
        assert.equal(readReceipt().outcome, 'ok');
        assert.equal(readReceipt().to, 'account-a');
        store = openStore(config.dbPath);
        try {
          assert.equal(store.getActiveLogin('anthropic')?.accountId, 'account-a');
        } finally { store.close(); }
        resetOutput();
      });

      await t.test('4. the launchd receipt fixture authorizes live Keychain writes', async () => {
        const store = openStore(config.dbPath);
        try {
          store.setConfig('keychain.liveItemsReadAuthorizedAt', String(clock));
          store.setConfig('keychain.liveItemsReadAuthorizedIdentityHash', 'fixture-helper');
          store.setConfig('keychain.helperCheckIdentityHash', 'fixture-helper');
        } finally { store.close(); }
        const receipt: LiveSwitchReceipt = {
          outcome: 'ok', from: 'account-a', to: 'account-a', switchId: 1, attempt: 'launchd-republish',
          reason: null, error: null, outgoingKind: 'own-bytes', steps: { cleanup: [] }, injected: false,
        };
        assert.equal(await runKeychainCommand(['check-launchd', '--live', '--json'], context, {
          helperPath: () => '/fixture/qlb-keychain-helper',
          helperConfigReader: () => 'fixture-helper',
          helperIdentityVerifier: () => ({ trusted: true }),
          runLaunchdLiveSwitch: () => receipt,
        }), 0, errors.join('\n'));
        assert.deepEqual(readReceipt(), { command: 'check-launchd --live', liveItemsAuthorized: true });
        resetOutput();
      });

      await t.test('5. deferred-Pi commit enters cutover', async () => {
        const command = createCutoverCommand({ makeAgent: () => agent });
        assert.equal(await command.execute!(['commit', '--pi-deferred', '--json'], context), 0, errors.join('\n'));
        assert.equal(readReceipt().ok, true);
        const store = openStore(config.dbPath);
        try {
          assert.equal(phase(store).state, 'cutover');
          assert.ok(store.getConfig('cutover.piDeferredAt'));
        } finally { store.close(); }
        resetOutput();
      });

      await t.test('6. one auto --once tick crosses 90% and records one ok switch', async () => {
        const store = openStore(config.dbPath);
        const repository = SqliteClaudeSlotRepository.open(config.dbPath);
        const slots = new ClaudeSlots({ backend: keychain, repository, stashDir: join(home, '.qlb', 'unclaimed'), now: () => clock });
        const binding: LiveBinding = {
          store,
          close: () => { repository.close(); store.close(); },
          reconcile: async () => {},
          poll: () => pollAnthropic({
            store, slots, now: () => Math.floor(clock / 1000), rng: () => 0.5,
            fetchActiveDeps: {
              live: { backend: keychain, paths, account: 'fixture-user', home, env }, env, now: () => clock,
              verdicts: new ProbeVerdictMemo(), by: 'qlb-auto',
              postRefresh: async () => ({ status: 500, body: '' }),
            },
            resyncDeps: {
              live: { backend: keychain, paths, account: 'fixture-user', home, env }, env, now: () => clock,
              getProfile: async () => ({ status: 500, body: '' }), readLiveIdentity: () => null, by: 'qlb-auto',
            },
            consumeDeps: { postRefresh: async () => ({ status: 500, body: '' }) },
            getUsage: async (accessToken) => response(accessToken === 'fixture-access-account-a' ? 95 : 10),
          }),
          tick: (accounts) => anthropicTick({
            store, slots, accounts, now: () => clock,
            makeSwitchDeps: async (by) => ({
              store, slots, live: { backend: keychain, paths, account: 'fixture-user' },
              readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
              resolveProfile: async () => null,
              consume: { postRefresh: async () => ({ status: 500, body: '' }) },
              env, home, now: () => clock, by, attempt: 'automatic-switch', journalOwner: { pid: process.pid, lstart: '' },
            }),
          }),
        };
        assert.equal(await runAutoCommand(['--once', '--json'], context, {
          acquireFlock: async () => async () => {},
          runAuto: (options, dependencies) => runAuto(options, {
            ...dependencies, now: () => clock, makeLiveBinding: () => binding, listCswapProcesses: () => [],
          }),
        }), 0, errors.join('\n'));
        const autoReceipt = readReceipt() as { ticks: number; executed: string[] };
        assert.equal(autoReceipt.ticks, 1);
        assert.deepEqual(autoReceipt.executed, ['account-b']);
        const db = openStoreConnection(config.dbPath, true);
        try {
          const rows = (db.prepare("SELECT outcome, trigger FROM switch_log WHERE provider = 'anthropic' AND trigger != 'manual'").all() as Array<{ outcome: string; trigger: string }>)
            .map(({ outcome, trigger }) => ({ outcome, trigger }));
          assert.deepEqual(rows, [{ outcome: 'ok', trigger: 'proactive' }]);
        } finally { db.close(); }
        resetOutput();
      });

      await t.test('7. compiled consume status remains CONSUMED', () => {
        const cli = join(__dirname, '..', 'src', 'cli.js');
        const result = spawnSync(process.execPath, [cli, 'consume', 'status', '--provider', 'anthropic', '--json'], {
          env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal((JSON.parse(result.stdout) as { state: string }).state, CONSUME_STATE);
      });

      await t.test('8. undo waits for an in-flight auto tick, then hands C-swap current lineages', async () => {
        let entered!: () => void;
        const atBarrier = new Promise<void>((resolve) => { entered = resolve; });
        let release!: () => void;
        const continueTick = new Promise<void>((resolve) => { release = resolve; });
        let held = true;
        const tickStore = openStore(config.dbPath);
        const inFlight = runAuto({ once: true }, {
          now: () => clock,
          makeLiveBinding: () => ({
            store: tickStore,
            close: () => tickStore.close(),
            reconcile: async () => {},
            poll: async () => [],
            tick: async () => {
              entered();
              await continueTick;
              held = false;
              return { decision: { kind: 'stay' as const, reason: 'unknown', unhealthyTicks: 0 } };
            },
          }),
          listCswapProcesses: () => [],
          log: () => {},
        });
        await atBarrier;
        let waits = 0;
        assert.equal(await runUndoCswapCommand(['--json'], context, {
          keychain,
          backupDir: backup,
          bootoutQlbAgent: () => ({ ok: true }),
          listQlbPids: () => [],
          listHeldLocks: () => held ? ['auto.lock'] : [],
          now: () => clock,
          sleep: async () => { waits += 1; release(); await inFlight; },
          withActiveLocks: async (fn) => fn(),
          readActiveCredential: async () => ({ credential: await keychain.get(paths.keychainService, 'fixture-user'), accountId: 'account-b' }),
          resyncActive: async () => {},
          validateActiveSequence: async () => {},
          setActiveAccountNumber: async () => {},
          moveQlbPlist: () => ({ ok: true }),
          cswapAgent: agent,
        }), 0, errors.join('\n'));
        assert.equal(waits, 1);
        assert.equal(await inFlight.then(() => 'settled'), 'settled');
        const a = await keychain.get('claude-swap', 'account-1-a@example.test');
        const b = await keychain.get('claude-swap', 'account-2-b@example.test');
        const qlbA = await keychain.get('qlb:anthropic:account-a', 'qlb');
        const qlbB = await keychain.get('qlb:anthropic:account-b', 'qlb');
        assert.equal(credentialFingerprint(a), credentialFingerprint(qlbA));
        assert.equal(credentialFingerprint(b), credentialFingerprint(qlbB));
        const store = openStore(config.dbPath);
        try { assert.equal(phase(store).state, 'rolled-back'); } finally { store.close(); }
        resetOutput();
      });

      await t.test('9. doctor has no FAIL for Stage 1 agent checks after undo', async () => {
        const report = await doctorQlb(config, {
          command: () => '', hostCommand: () => '', now: () => clock,
          cswapAgentStatus: () => 'not-loaded', cswapProcesses: () => [],
          piProcessList: () => '  1 fixture /usr/bin/true\n',
        });
        const stageOne = report.checks.filter((row) => ['auto:agent', 'cswap:agent', 'cswap:processes'].includes(row.name));
        assert.equal(stageOne.some((row) => row.level === 'FAIL'), false, JSON.stringify(stageOne));
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
