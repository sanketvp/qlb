import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { credentialWithFixtureAccess } from './support/claude-fixtures';

import { credentialFingerprint } from '../src/anthropic-oauth';
import { runAuto, type LiveBinding } from '../src/auto';
import { anthropicTick, pollAnthropic } from '../src/auto/anthropic';
import { claudePaths } from '../src/cc-paths';
import { ProbeVerdictMemo, refreshActiveLogin } from '../src/cc-resync';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { createCutoverCommand } from '../src/commands/cutover';
import importCswapCommand from '../src/commands/import-cswap';
import { runKeychainCommand, type LiveSwitchReceipt } from '../src/commands/keychain';
import { runAutoCommand } from '../src/commands/auto';
import { runUndoCswapCommand } from '../src/commands/undo-cswap';
import { createSwitchAnthropicCommand, makeProductionSwitchDeps } from '../src/commands/switch-anthropic';
import { defaultConfig } from '../src/config';
import { CONSUME_STATE } from '../src/cswap-consume';
import { doctorQlb, type DoctorReport } from '../src/diagnostics';
import { reconcileClaudeSwitch } from '../src/journal';
import { MockKeychain, platformKeychain } from '../src/keychain';
import { phase } from '../src/lifecycle';
import { productionTryAcquireLock, type CswapAgent } from '../src/cswap-agent';
import type { CommandContext } from '../src/registry';
import { openStore, openStoreConnection } from '../src/store';

// Keep the rehearsal's injected clock inside the real cutover window.
const NOW = Date.now();

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

function stageOne(report: DoctorReport) {
  const rows = report.checks.filter((row) => ['auto:agent', 'cswap:agent', 'cswap:processes'].includes(row.name));
  assert.equal(rows.length, 3, JSON.stringify(rows));
  return rows;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withSafetyTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 5_000);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

describe('Stage 1 sandbox dress rehearsal (G19)', () => {
  it('drives cutover through automatic switching and a fenced C-swap hand-back', async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-go-live-dress-'));
    const env = { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home, USER: 'fixture-user' };
    const priorEnv = {
      QLB_TEST_MODE: process.env.QLB_TEST_MODE,
      QLB_HOME: process.env.QLB_HOME,
      HOME: process.env.HOME,
    };
    // Some production defaults (doctor and the Keychain adapter) read process.env.
    Object.assign(process.env, env);
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
    const readItem = async (service: string, account: string): Promise<string | null> => keychain.get(service, account).catch(() => null);
    const resetOutput = (): void => { output.length = 0; errors.length = 0; };
    const fixturePaths = (_options?: Parameters<typeof claudePaths>[0]) => paths;
    const fetchFn = async (_input: string, init: { headers: Record<string, string> }) => {
      const authorization = init.headers.Authorization ?? '';
      const usedPct = authorization.includes('fixture-access-account-a') ? 95 : 10;
      return { status: 200, text: async () => response(usedPct).body };
    };
    const switchDeps = {
      claudePaths: fixturePaths,
      fetchFn,
      now: () => clock,
      randomUUID: (() => { let number = 0; return () => `dress-${++number}`; })(),
      processLstart: async () => '',
    };

    try {
      mkdirSync(dirname(paths.globalConfigPath), { recursive: true });
      mkdirSync(join(backup, 'configs'), { recursive: true });
      mkdirSync(join(backup, 'credentials'), { recursive: true });
      writeFileSync(paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'account-a', emailAddress: 'a@example.test', organizationUuid: 'org-fixture' } })}\n`);
      writeFileSync(config.cswapSequencePath, JSON.stringify({
        activeAccountNumber: 1,
        sequence: [1, 2],
        accounts: {
          1: { email: 'a@example.test', uuid: 'account-a' },
          2: { email: 'b@example.test', uuid: 'account-b' },
        },
      }));
      writeFileSync(join(backup, 'configs', '.claude-config-1-a@example.test.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a', emailAddress: 'a@example.test', organizationUuid: 'org-fixture' } }));
      writeFileSync(join(backup, 'configs', '.claude-config-2-b@example.test.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-b', emailAddress: 'b@example.test', organizationUuid: 'org-fixture' } }));
      writeFileSync(join(backup, 'credentials', '.creds-1-a@example.test.enc'), Buffer.from(credentialWithFixtureAccess('account-a', 'refresh-a', NOW + 3_600_000)).toString('base64'));
      await keychain.set('claude-swap', 'account-2-b@example.test', credentialWithFixtureAccess('account-b-before', 'refresh-b-before', NOW + 3_600_000));
      await keychain.set(paths.keychainService, 'fixture-user', credentialWithFixtureAccess('account-a', 'refresh-a', NOW + 3_600_000));

      await t.test('1. cutover begin drains the injected C-swap agent', async () => {
        const command = createCutoverCommand({ makeAgent: () => agent });
        assert.equal(await command.execute!(['begin', '--json'], context), 0);
        assert.deepEqual(agentCalls, ['bootout', 'disable', 'movePlist', 'drain']);
        assert.deepEqual(readReceipt(), { ok: true, state: 'cutting-over' });
        resetOutput();
      });

      await t.test('2. import brings both fake C-swap accounts into QLB and enables consume through the CLI', async () => {
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
        } finally { store.close(); }
        const cli = join(__dirname, '..', 'src', 'cli.js');
        const result = spawnSync(process.execPath, [cli, 'consume', 'enable', '--provider', 'anthropic', '--json'], {
          env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, encoding: 'utf8', timeout: 5_000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal((JSON.parse(result.stdout) as { state: string }).state, CONSUME_STATE);
        resetOutput();
      });

      const switchCommand = createSwitchAnthropicCommand({
        bootstrap: async (hooks) => { await hooks?.assertAdmitted?.(); },
        ...switchDeps,
      });

      await t.test('3. two manual switches round-trip the active Claude login through production dependencies', async () => {
        const restore = patchPlatformKeychain(keychain);
        try {
          assert.equal(await switchCommand.execute!(['account-b', '--json'], context), 0, JSON.stringify({ errors, output }));
          assert.equal(readReceipt().outcome, 'ok');
          assert.equal(readReceipt().to, 'account-b');
          let store = openStore(config.dbPath);
          try { assert.equal(store.getActiveLogin('anthropic')?.accountId, 'account-b'); } finally { store.close(); }
          resetOutput();
          clock += 1;
          assert.equal(await switchCommand.execute!(['account-a', '--json'], context), 0, JSON.stringify({ errors, output }));
          assert.equal(readReceipt().outcome, 'ok');
          assert.equal(readReceipt().to, 'account-a');
          store = openStore(config.dbPath);
          try { assert.equal(store.getActiveLogin('anthropic')?.accountId, 'account-a'); } finally { store.close(); }
        } finally {
          restore();
        }
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
          store.setConfig('auto.heartbeatAt', String(clock));
        } finally { store.close(); }
        resetOutput();
      });

      await t.test('5a. doctor proves the cutover agent/process checks and rejects a loaded C-swap agent', async () => {
        const report = await doctorQlb(config, {
          command: () => '', hostCommand: () => '', hostPlatform: 'linux', keychain, now: () => clock,
          cswapAgentStatus: () => 'not-loaded', cswapProcesses: () => [],
          piProcessList: () => '  1 fixture /usr/bin/true\n',
        });
        assert.deepEqual(stageOne(report).map((row) => row.level), ['PASS', 'PASS', 'PASS']);
        const loaded = await doctorQlb(config, {
          command: () => '', hostCommand: () => '', hostPlatform: 'linux', keychain, now: () => clock,
          cswapAgentStatus: () => 'loaded', cswapProcesses: () => [],
          piProcessList: () => '  1 fixture /usr/bin/true\n',
        });
        assert.equal(stageOne(loaded).find((row) => row.name === 'cswap:agent')?.level, 'FAIL');
      });

      await t.test('6. one auto --once tick refreshes then switches the live Claude login to account-b', async () => {
        // This tick's production refresh path rotates account-a before its 95% reading triggers the switch.
        await keychain.set('qlb:anthropic:account-a', 'qlb', credentialWithFixtureAccess('account-a', 'refresh-a', NOW - 1_000));
        await keychain.set(paths.keychainService, 'fixture-user', credentialWithFixtureAccess('account-a', 'refresh-a', NOW - 1_000));
        const store = openStore(config.dbPath);
        const repository = SqliteClaudeSlotRepository.open(config.dbPath);
        const slots = new ClaudeSlots({ backend: keychain, repository, stashDir: join(home, '.qlb', 'unclaimed'), now: () => clock });
        let refreshCalls = 0;
        const refresh = async () => {
          refreshCalls += 1;
          return { status: 200, body: JSON.stringify({ access_token: 'fixture-access-account-a-rotated', refresh_token: 'refresh-a-rotated', expires_in: 3_600 }) };
        };
        const verdicts = new ProbeVerdictMemo();
        const liveDeps = { backend: keychain, paths, account: 'fixture-user', home, env };
        const binding: LiveBinding = {
          store,
          close: () => { repository.close(); store.close(); },
          // productionLiveBinding is private and hardwires global fetch; this binding retains
          // its production reconcile and switch composition while injecting the no-network fixture.
          reconcile: async () => {
            const resources = await makeProductionSwitchDeps(switchDeps, context, store, () => {}, 'qlb-auto');
            try { await reconcileClaudeSwitch(resources.deps); } finally { resources.close?.(); }
          },
          poll: async () => {
            const active = await keychain.get('qlb:anthropic:account-a', 'qlb');
            const refreshed = await refreshActiveLogin({
              store, slots, live: liveDeps, env, now: () => clock, verdicts, by: 'qlb-auto', postRefresh: refresh,
            }, { accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-fixture', creds: active, degraded: false });
            assert.equal(refreshed.outcome, 'posted');
            // Rotate the inactive slot through its production slot writer too, so both
            // C-swap destinations are stale before hand-back.
            await slots.writeSlot('account-b', credentialWithFixtureAccess('account-b-rotated', 'refresh-b-rotated', NOW + 3_600_000), { cause: 'post', by: 'qlb-auto', evidence: 'post' });
            return pollAnthropic({
              store, slots, now: () => Math.floor(clock / 1000), rng: () => 0.5,
              fetchActiveDeps: { live: liveDeps, env, now: () => clock, verdicts, by: 'qlb-auto', postRefresh: refresh },
              resyncDeps: { live: liveDeps, env, now: () => clock, getProfile: refresh, readLiveIdentity: () => null, by: 'qlb-auto' },
              consumeDeps: { postRefresh: refresh },
              getUsage: async (accessToken) => response(accessToken.includes('account-a') ? 95 : 10),
            });
          },
          tick: (accounts) => anthropicTick({
            store, slots, accounts, now: () => clock,
            makeSwitchDeps: (by) => makeProductionSwitchDeps(switchDeps, context, store, () => {}, by),
          }),
        };
        const restore = patchPlatformKeychain(keychain);
        try {
          assert.equal(await runAutoCommand(['--once', '--json'], context, {
            acquireFlock: async () => async () => {},
            runAuto: (options, dependencies) => runAuto(options, {
              ...dependencies, now: () => clock, makeLiveBinding: () => binding, listCswapProcesses: () => [],
            }),
          }), 0, errors.join('\n'));
        } finally {
          restore();
        }
        const autoReceipt = readReceipt() as { ticks: number; executed: string[] };
        assert.equal(autoReceipt.ticks, 1);
        assert.equal(refreshCalls, 1);
        assert.deepEqual(autoReceipt.executed, ['account-b'], JSON.stringify(autoReceipt));
        const live = await keychain.get(paths.keychainService, 'fixture-user');
        const liveConfig = JSON.parse(readFileSync(paths.globalConfigPath, 'utf8')) as { oauthAccount: { accountUuid: string; emailAddress: string } };
        assert.equal(liveConfig.oauthAccount.accountUuid, 'account-b');
        assert.equal(liveConfig.oauthAccount.emailAddress, 'b@example.test');
        assert.equal(credentialFingerprint(live), credentialFingerprint(await keychain.get('qlb:anthropic:account-b', 'qlb')));
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
          env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, encoding: 'utf8', timeout: 5_000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal((JSON.parse(result.stdout) as { state: string }).state, CONSUME_STATE);
      });

      await t.test('8. undo waits for the real in-flight auto lock, then hands C-swap current lineages back', async () => {
        let entered!: () => void;
        const atBarrier = new Promise<void>((resolve) => { entered = resolve; });
        let releaseTick!: () => void;
        const continueTick = new Promise<void>((resolve) => { releaseTick = resolve; });
        let undoSleeping!: () => void;
        const undoWaiting = new Promise<void>((resolve) => { undoSleeping = resolve; });
        const tickStore = openStore(config.dbPath);
        const inFlight = runAutoCommand(['--once'], context, {
          acquireFlock: productionTryAcquireLock,
          runAuto: (options, dependencies) => runAuto(options, {
            ...dependencies,
            now: () => clock,
            listCswapProcesses: () => [],
            makeLiveBinding: (): LiveBinding => ({
              store: tickStore,
              close: () => tickStore.close(),
              reconcile: async () => {},
              poll: async () => [],
              tick: async () => {
                entered();
                await continueTick;
                return { decision: { kind: 'stay' as const, reason: 'unknown', unhealthyTicks: 0 } };
              },
            }),
          }),
        });
        const reachedBarrier = await withSafetyTimeout(
          Promise.race([atBarrier.then(() => true), inFlight.then(() => false)]),
          'auto tick did not reach its barrier',
        );
        if (!reachedBarrier) {
          releaseTick();
          await inFlight;
          assert.fail('auto tick must hold auto.lock before undo starts');
        }

        let undo: Promise<number> | undefined;
        try {
          const beforeA = await readItem('claude-swap', 'account-1-a@example.test');
          const beforeB = await keychain.get('claude-swap', 'account-2-b@example.test');
        const qlbA = await keychain.get('qlb:anthropic:account-a', 'qlb');
        const qlbB = await keychain.get('qlb:anthropic:account-b', 'qlb');
        assert.equal(beforeA, null, 'C-swap account-a must differ from QLB before undo');
        assert.notEqual(credentialFingerprint(beforeB), credentialFingerprint(qlbB));

        let waits = 0;
        undo = runUndoCswapCommand(['--json'], context, {
          keychain,
          backupDir: backup,
          bootoutQlbAgent: () => ({ ok: true }),
          listQlbPids: () => [],
          now: () => clock,
          sleep: async () => {
            waits += 1;
            undoSleeping();
            await continueTick;
          },
          moveQlbPlist: () => ({ ok: true }),
          cswapAgent: agent,
        });
        await withSafetyTimeout(undoWaiting, 'undo did not observe the held auto lock');
        assert.equal(await readItem('claude-swap', 'account-1-a@example.test'), beforeA);
        assert.equal(await keychain.get('claude-swap', 'account-2-b@example.test'), beforeB);
        assert.equal(existsSync(join(backup, 'credentials', '.creds-1-a@example.test.enc')), true);
        releaseTick();
        assert.equal(await undo, 0, errors.join('\n'));
        assert.equal(waits, 1);
        assert.equal(await inFlight, 0);

        const a = await keychain.get('claude-swap', 'account-1-a@example.test');
        const b = await keychain.get('claude-swap', 'account-2-b@example.test');
        assert.equal(credentialFingerprint(a), credentialFingerprint(await keychain.get('qlb:anthropic:account-a', 'qlb')));
        assert.equal(credentialFingerprint(b), credentialFingerprint(await keychain.get('qlb:anthropic:account-b', 'qlb')));
        assert.equal(JSON.parse(readFileSync(config.cswapSequencePath, 'utf8')).activeAccountNumber, 2);
        assert.equal(agentCalls.at(-1), 'restorePlist');
        const store = openStore(config.dbPath);
        try { assert.equal(phase(store).state, 'rolled-back'); } finally { store.close(); }
        } finally {
          // Cleanup only: the barrier timeout above is the regression failure path.
          releaseTick();
          await inFlight.catch(() => {});
        }
        resetOutput();
      });

      await t.test('9. doctor reports all three Stage 1 rows as N/A after undo', async () => {
        const report = await doctorQlb(config, {
          command: () => '', hostCommand: () => '', hostPlatform: 'linux', keychain, now: () => clock,
          cswapAgentStatus: () => 'not-loaded', cswapProcesses: () => [],
          piProcessList: () => '  1 fixture /usr/bin/true\n',
        });
        assert.deepEqual(stageOne(report).map((row) => row.level), ['N/A', 'N/A', 'N/A']);
      });
    } finally {
      restoreEnv('QLB_TEST_MODE', priorEnv.QLB_TEST_MODE);
      restoreEnv('QLB_HOME', priorEnv.QLB_HOME);
      restoreEnv('HOME', priorEnv.HOME);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
