import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { anthropicTick } from '../src/auto/anthropic';
import type { AutoswitchAccount } from '../src/autoswitch';
import { makeProductionSwitchDeps } from '../src/commands/switch-anthropic';
import { switchClaude, type ClaudeSwitchDeps, type ClaudeSwitchResult, type SwitchClaudeInput } from '../src/cc-switch';
import { ClaudeSlots, InMemoryClaudeSlotRepository, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { claudePaths } from '../src/cc-paths';
import { MockKeychain } from '../src/keychain';
import { openStore } from '../src/store';

const NOW = 1_700_000_000_000;

type Switcher = (deps: ClaudeSwitchDeps, input: SwitchClaudeInput) => Promise<ClaudeSwitchResult>;

function result(outcome: ClaudeSwitchResult['outcome'], overrides: Partial<ClaudeSwitchResult> = {}): ClaudeSwitchResult {
  return { outcome, from: '1', to: '3', attempt: 'fixture', exitCode: outcome === 'refused' ? 3 : outcome === 'ok' ? 0 : 1, ...overrides };
}

async function fixture(used = [95, 30, 10], resets = [60, 60, 60]) {
  const home = mkdtempSync(join(tmpdir(), 'qlb-autoswitch-loop-'));
  const store = openStore(':memory:');
  const slots = new ClaudeSlots({ backend: new MockKeychain(), repository: new InMemoryClaudeSlotRepository(), stashDir: join(home, 'unclaimed') });
  for (let index = 0; index < used.length; index += 1) {
    const accountId = String(index + 1);
    await slots.createSlot({ accountId, credential: JSON.stringify({ fixture: accountId }), slotNum: index + 1, source: 'fixture' });
    store.upsertSnapshot(accountId, '5h', { usedPct: used[index], resetAt: NOW + resets[index] * 60_000, fetchedAt: NOW, source: 'poll', confidence: 'authoritative' });
  }
  store.setActiveLogin('anthropic', '1', 'fixture', NOW);
  return { store, slots };
}

function tickDeps(
  f: Awaited<ReturnType<typeof fixture>>,
  switcher: Switcher,
  options: { now?: () => number; accounts?: readonly AutoswitchAccount[]; onBuild?: (by: 'qlb-auto') => void } = {},
) {
  let attempt = 0;
  return {
    store: f.store,
    slots: f.slots,
    now: options.now ?? (() => NOW),
    ...(options.accounts ? { accounts: options.accounts } : {}),
    makeSwitchDeps: async (by: 'qlb-auto') => {
      options.onBuild?.(by);
      attempt += 1;
      return { deps: { attempt: `fixture-${attempt}`, by } as ClaudeSwitchDeps };
    },
    switchClaude: switcher as typeof import('../src/cc-switch').switchClaude,
  };
}

async function realSwitchFixture() {
  const home = mkdtempSync(join(tmpdir(), 'qlb-autoswitch-real-switch-'));
  const env = { HOME: home, QLB_HOME: join(home, 'qlb'), QLB_TEST_MODE: '1' };
  const paths = claudePaths({ home, env });
  mkdirSync(dirname(paths.globalConfigPath), { recursive: true });
  const credential = (tag: string) => JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${tag}`, refreshToken: `fixture-refresh-${tag}`, expiresAt: NOW + 60 * 60_000 } });
  writeFileSync(paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: '1' } })}\n`);
  const store = openStore(join(home, 'qlb.db'));
  const repository = SqliteClaudeSlotRepository.open(join(home, 'qlb.db'));
  const backend = new MockKeychain();
  const slots = new ClaudeSlots({ backend, repository, stashDir: join(home, 'unclaimed') });
  await slots.createSlot({ accountId: '1', credential: credential('one'), slotNum: 1, configJson: JSON.stringify({ oauthAccount: { accountUuid: '1' } }), source: 'fixture' });
  await slots.createSlot({ accountId: '2', credential: credential('two'), slotNum: 2, configJson: JSON.stringify({ oauthAccount: { accountUuid: '2' } }), source: 'fixture' });
  await backend.set(paths.keychainService, 'fixture-user', credential('one'));
  store.setActiveLogin('anthropic', '1', 'fixture', NOW);
  store.upsertSnapshot('1', '5h', { usedPct: 95, resetAt: NOW + 60_000, fetchedAt: NOW, source: 'poll', confidence: 'authoritative' });
  store.upsertSnapshot('2', '5h', { usedPct: 10, resetAt: NOW + 60_000, fetchedAt: NOW, source: 'poll', confidence: 'authoritative' });
  return { home, env, paths, store, backend, slots, close: () => repository.close() };
}

function switchRow(store: ReturnType<typeof openStore>, input: { from: string; to: string; trigger: string; now: number }): ClaudeSwitchResult {
  const switchId = store.recordSwitch({
    ts: input.now, committedAt: input.now, provider: 'anthropic', fromAccount: input.from,
    toAccount: input.to, trigger: input.trigger, outcome: 'ok', stepsJson: JSON.stringify({ attempt: `committed-${input.now}` }),
  });
  store.setActiveLogin('anthropic', input.to, 'auto', input.now);
  return result('ok', { from: input.from, to: input.to, switchId });
}

function consumeFirstAccounts(): AutoswitchAccount[] {
  return [
    { accountId: '1', slotNum: 1, buckets: { '5h': { usedPct: 20 }, '7d': { usedPct: 20, resetAt: NOW + 20 * 60 * 60_000 } } },
    { accountId: '2', slotNum: 2, buckets: { '5h': { usedPct: 5 }, '7d': { usedPct: 5, resetAt: NOW + 10 * 60 * 60_000 } } },
    { accountId: '3', slotNum: 3, buckets: { '5h': { usedPct: 10 }, '7d': { usedPct: 10, resetAt: NOW + 2 * 60 * 60_000 } } },
  ];
}

describe('autoswitch loop (G9)', () => {
  it('crossing 90% switches once to the best slot', async () => {
    const f = await fixture();
    const calls: Array<{ to: string; trigger: string; decision: unknown }> = [];
    const output = await anthropicTick({ ...tickDeps(f, async (_deps, input) => {
      calls.push(input as typeof calls[number]);
      return result('ok');
    }) });
    assert.equal(output.decision.kind, 'switch');
    assert.deepEqual(calls, [{ to: '3', trigger: 'proactive', decision: { leftHeadroom: 5, leftRecoveryAt: NOW + 60 * 60_000, leftTrigger: 'proactive' } }]);
    assert.equal(f.store.getConfig('auto.anthropic.lastSwitchAt'), String(NOW));
  });

  it('passes injected usage-failure provenance to a failover switch', async () => {
    const f = await fixture([20, 80]);
    f.store.setConfig('auto.anthropic.unhealthyTicks', '2');
    f.store.setConfig('auto.anthropic.healthAccount', '1');
    f.store.setConfig('auto.anthropic.healthTickAt', String(NOW));
    let received: SwitchClaudeInput | undefined;
    const output = await anthropicTick({
      ...tickDeps(f, async (_deps, input) => {
        received = input;
        return result('ok', { to: input.to });
      }),
      activeUsageUnknown: true,
      injected: true,
      injectionDetail: 'fault-injection:usage-5xx',
    });
    assert.equal(output.decision.kind, 'switch');
    assert.deepEqual(received && { injected: received.injected, detail: received.detail, trigger: received.trigger }, {
      injected: true, detail: 'fault-injection:usage-5xx', trigger: 'failover',
    });
  });

  it('cooldown holds a second proactive switch', async () => {
    const f = await fixture();
    let calls = 0;
    const deps = tickDeps(f, async () => { calls += 1; return result('ok'); });
    await anthropicTick(deps);
    const second = await anthropicTick(deps);
    assert.equal(second.decision.kind, 'stay');
    assert.equal(second.decision.kind === 'stay' ? second.decision.reason : null, 'cooldown');
    assert.equal(calls, 1);
  });

  it('consume-first moves to the earliest weekly reset and passes its trigger to the switch seam', async () => {
    const f = await fixture();
    f.store.setConfig('autoswitch.strategy', 'consume-first');
    const calls: Array<{ to: string; trigger: string }> = [];
    const output = await anthropicTick(tickDeps(f, async (_deps, input) => {
      calls.push({ to: input.to, trigger: input.trigger });
      return result('ok', { from: '1', to: input.to });
    }, { accounts: consumeFirstAccounts() }));

    assert.equal(output.decision.kind === 'switch' ? output.decision.reason : null, 'consume-first');
    assert.equal(output.decision.kind === 'switch' ? output.decision.targetId : null, '3');
    assert.deepEqual(calls, [{ to: '3', trigger: 'consume-first' }]);
  });

  it('cooldown holds a valid second consume-first switch until it expires', async () => {
    const f = await fixture();
    f.store.setConfig('autoswitch.strategy', 'consume-first');
    const accounts: AutoswitchAccount[] = [
      { accountId: '1', slotNum: 1, buckets: { '5h': { usedPct: 20 }, '7d': { usedPct: 20, resetAt: NOW + 20 * 60 * 60_000 } } },
      { accountId: '2', slotNum: 2, buckets: { '5h': { usedPct: 10 }, '7d': { usedPct: 10, resetAt: NOW + 2 * 60 * 60_000 } } },
      { accountId: '3', slotNum: 3, buckets: { '5h': { usedPct: 5 }, '7d': { usedPct: 5, resetAt: NOW + 30 * 60 * 60_000 } } },
    ];
    let clock = NOW;
    const calls: string[] = [];
    const deps = tickDeps(f, async (_deps, input) => {
      calls.push(input.to);
      const from = f.store.getActiveLogin('anthropic')?.accountId;
      assert.ok(from);
      return switchRow(f.store, { from, to: input.to, trigger: input.trigger, now: clock });
    }, { now: () => clock, accounts });

    const first = await anthropicTick(deps);
    accounts[2].buckets['7d'].resetAt = NOW + 60 * 60_000;
    const held = await anthropicTick(deps);
    clock += 300 * 1_000 + 1;
    const released = await anthropicTick(deps);

    assert.equal(first.decision.kind === 'switch' ? first.decision.targetId : null, '2');
    assert.deepEqual(held.decision, { kind: 'stay', reason: 'cooldown', unhealthyTicks: 0 });
    assert.equal(released.decision.kind === 'switch' ? released.decision.targetId : null, '3');
    assert.deepEqual(calls, ['2', '3']);
  });

  it('strategy best does not consume-first on the same fixture', async () => {
    const f = await fixture();
    f.store.setConfig('autoswitch.strategy', 'best');
    let calls = 0;
    const output = await anthropicTick(tickDeps(f, async () => {
      calls += 1;
      throw new Error('best must not switch');
    }, { accounts: consumeFirstAccounts() }));

    assert.deepEqual(output.decision, { kind: 'stay', reason: 'below-threshold', unhealthyTicks: 0 });
    assert.equal(calls, 0);
  });

  it('uses the committed switch time for cooldown and recovers it from switch_log', async () => {
    const f = await fixture();
    f.store.recordSwitch({ provider: 'anthropic', fromAccount: '2', toAccount: '1', trigger: 'proactive', outcome: 'ok', ts: NOW - 10_000, committedAt: NOW - 10_000 });
    const output = await anthropicTick(tickDeps(f, async () => { throw new Error('cooldown must not switch'); }));
    assert.deepEqual(output.decision, { kind: 'stay', reason: 'cooldown', unhealthyTicks: 0 });

    const committed = await fixture();
    const output2 = await anthropicTick(tickDeps(committed, async (_deps, input) =>
      switchRow(committed.store, { from: '1', to: input.to, trigger: input.trigger, now: NOW + 77 })));
    assert.equal(output2.switchResult?.outcome, 'ok');
    assert.equal(committed.store.getConfig('auto.anthropic.lastSwitchAt'), String(NOW + 77));
  });

  it('all accounts at limit parks', async () => {
    const f = await fixture([100, 100], [10, 20]);
    const output = await anthropicTick(tickDeps(f, async () => { throw new Error('should not switch'); }));
    assert.deepEqual(output.decision, { kind: 'parked', accountId: '1', resetAtMs: NOW + 10 * 60_000, unhealthyTicks: 0, parkedUntilMs: NOW + 10 * 60_000 });
    assert.equal(f.store.getConfig('auto.anthropic.parkedUntil'), String(NOW + 10 * 60_000));
  });

  it('a refused switch stays and retries next tick', async () => {
    const f = await fixture();
    let calls = 0;
    const deps = tickDeps(f, async () => { calls += 1; return result('refused'); });
    const first = await anthropicTick(deps);
    const second = await anthropicTick(deps);
    assert.equal(first.switchResult?.outcome, 'refused');
    assert.equal(second.switchResult?.outcome, 'refused');
    assert.equal(calls, 2);
    assert.equal(f.store.getConfig('auto.anthropic.lastSwitchAt'), null);
  });

  it('a failed parked switch keeps its previous marker and retries next tick', async () => {
    const f = await fixture([100, 100], [20, 10]);
    const previous = NOW + 5 * 60_000;
    f.store.setConfig('auto.anthropic.parkedUntil', String(previous));
    let calls = 0;
    const deps = tickDeps(f, async () => { calls += 1; return result('refused'); });
    const first = await anthropicTick(deps);
    const second = await anthropicTick(deps);
    assert.equal(first.decision.kind === 'switch' ? first.decision.reason : null, 'parked');
    assert.equal(second.decision.kind === 'switch' ? second.decision.reason : null, 'parked');
    assert.equal(calls, 2);
    assert.equal(f.store.getConfig('auto.anthropic.parkedUntil'), String(previous));
  });

  it('clears a parked marker after a failed non-parked switch so its reset account can be selected', async () => {
    const f = await fixture([100, 10], [20, 10]);
    const parkedUntil = NOW + 10 * 60_000;
    f.store.setConfig('auto.anthropic.parkedUntil', String(parkedUntil));
    const accounts: AutoswitchAccount[] = [
      { accountId: '1', buckets: { '5h': { usedPct: 100, resetAt: NOW + 20 * 60_000 } }, slotNum: 1 },
      { accountId: '2', buckets: { '5h': { usedPct: 10, resetAt: parkedUntil } }, slotNum: 2 },
    ];
    let calls = 0;
    const deps = tickDeps(f, async () => {
      calls += 1;
      return calls === 1 ? result('refused') : result('ok');
    }, { accounts });

    const failed = await anthropicTick(deps);
    assert.equal(failed.decision.kind === 'switch' ? failed.decision.reason : null, 'at-limit');
    assert.equal(f.store.getConfig('auto.anthropic.parkedUntil'), '');

    accounts[1].buckets['5h'].usedPct = 100;
    const parked = await anthropicTick(deps);
    assert.equal(parked.decision.kind === 'switch' ? parked.decision.reason : null, 'parked');
    assert.equal(parked.decision.kind === 'switch' ? parked.decision.targetId : null, '2');
    assert.equal(calls, 2);
  });

  it('retries an expired active credential failover on the next tick after one refusal', async () => {
    const f = await fixture([10, 20]);
    let clock = NOW;
    const accounts: AutoswitchAccount[] = [
      { accountId: '1', buckets: { '5h': { usedPct: 10 } }, slotNum: 1 },
      { accountId: '2', buckets: { '5h': { usedPct: 20 } }, slotNum: 2 },
    ];
    f.store.recordUsagePollResult('anthropic', '1', { attemptedAt: Math.floor(clock / 1000), status: 'token-expired' });
    const attempts: number[] = [];
    const deps = tickDeps(f, async (_deps, input) => {
      attempts.push(clock);
      return attempts.length === 1
        ? result('refused')
        : switchRow(f.store, { from: '1', to: input.to, trigger: input.trigger, now: clock });
    }, { now: () => clock, accounts });

    for (let tick = 0; tick < 34; tick += 1) {
      const output = await anthropicTick(deps);
      if (tick < 32) assert.notEqual(output.decision.kind, 'switch', `tick ${tick}`);
      clock += 60_000;
    }
    assert.deepEqual(attempts, [NOW + 32 * 60_000, NOW + 33 * 60_000]);
    assert.equal(f.store.getConfig('auto.anthropic.idleHoldSince'), '');
  });

  it('opens the production breaker from real switch_log rows and performs no fourth switch', async () => {
    const f = await fixture([100, 20]);
    let clock = NOW;
    let calls = 0;
    const accounts: AutoswitchAccount[] = [
      { accountId: '1', buckets: { '5h': { usedPct: 100 } }, slotNum: 1 },
      { accountId: '2', buckets: { '5h': { usedPct: 20 } }, slotNum: 2 },
    ];
    const deps = tickDeps(f, async (_deps, input) => {
      calls += 1;
      const from = f.store.getActiveLogin('anthropic')?.accountId;
      assert.ok(from);
      const target = input.to;
      const row = switchRow(f.store, { from, to: target, trigger: input.trigger, now: clock });
      accounts.find((account) => account.accountId === from)!.buckets['5h'].usedPct = 20;
      accounts.find((account) => account.accountId === target)!.buckets['5h'].usedPct = 100;
      return row;
    }, { now: () => clock, accounts });

    for (let tick = 0; tick < 3; tick += 1) {
      const output = await anthropicTick(deps);
      assert.equal(output.decision.kind, 'switch', JSON.stringify(output.decision));
      clock += 60_000;
    }
    const blocked = await anthropicTick(deps);
    assert.deepEqual(blocked.decision, { kind: 'stay', reason: 'breaker', unhealthyTicks: 0, suspendedUntilMs: clock + 3_600_000 });
    assert.equal(calls, 3);
    assert.equal(f.store.getConfig('auto.anthropic.suspendedUntil'), String(clock + 3_600_000));
  });

  it('production switch deps preserve manual provenance and accept qlb-auto', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-switch-deps-'));
    const store = openStore(join(home, 'qlb.db'));
    const ctx = { home, env: { HOME: home, QLB_HOME: join(home, 'qlb'), QLB_TEST_MODE: '1' }, config: { dbPath: join(home, 'qlb.db') } };
    try {
      const commandDeps = { randomUUID: (() => { let value = 0; return () => `attempt-${++value}`; })(), processLstart: async () => '' };
      const manual = await makeProductionSwitchDeps(commandDeps, ctx as never, store, () => {});
      const automatic = await makeProductionSwitchDeps(commandDeps, ctx as never, store, () => {}, 'qlb-auto');
      assert.equal(manual.deps.by, 'qlb-cli');
      assert.equal(manual.deps.attempt, 'attempt-1');
      assert.equal(automatic.deps.by, 'qlb-auto');
      assert.equal(automatic.deps.attempt, 'attempt-2');
      manual.close?.();
      automatic.close?.();
    } finally {
      store.close();
    }
  });

  it('uses qlb-auto and a fresh attempt for every automatic switch', async () => {
    const f = await fixture();
    const by: string[] = [];
    const attempts: string[] = [];
    const deps = tickDeps(f, async (switchDeps) => {
      attempts.push(switchDeps.attempt);
      return result('refused');
    }, { onBuild: (value) => by.push(value) });
    await anthropicTick(deps);
    await anthropicTick(deps);
    assert.deepEqual(by, ['qlb-auto', 'qlb-auto']);
    assert.deepEqual(attempts, ['fixture-1', 'fixture-2']);
  });

  it('dry run performs zero writes and takes no lock (spy)', async () => {
    const f = await fixture();
    let writes = 0;
    let builds = 0;
    const originalSetConfig = f.store.setConfig.bind(f.store);
    f.store.setConfig = (key, value) => { writes += 1; originalSetConfig(key, value); };
    const output = await anthropicTick({
      ...tickDeps(f, async () => { throw new Error('must not switch'); }, { onBuild: () => { builds += 1; } }),
      dryRun: true,
    });
    assert.equal(output.decision.kind, 'switch');
    assert.equal(writes, 0);
    assert.equal(builds, 0);
  });

  it('token-shaped text in a switch error never reaches switch_log.error or steps_json', async () => {
    const f = await realSwitchFixture();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const recordSwitch = f.store.recordSwitch.bind(f.store);
    // Exercise the real tick → switchClaude → Store path with a raw switch
    // error at its durable sink. Removing Store redaction makes this fail.
    f.store.recordSwitch = (row) => recordSwitch({ ...row, error: `switch ${secret}`, stepsJson: JSON.stringify({ error: secret }) });
    const output = await anthropicTick({
      store: f.store, slots: f.slots, now: () => NOW,
      makeSwitchDeps: async (by) => ({
        store: f.store, slots: f.slots, live: { backend: f.backend, paths: f.paths, account: 'fixture-user' },
        readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
        resolveProfile: async () => null,
        consume: { postRefresh: async () => ({ status: 500, body: '' }), withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn() },
        env: f.env, home: f.home, now: () => NOW, by, attempt: 'redaction-attempt', journalOwner: { pid: process.pid, lstart: '' },
      }),
      switchClaude,
    });
    assert.equal(output.switchResult?.outcome, 'ok');
    const db = (f.store as unknown as { db: { prepare: (sql: string) => { get: () => { error: string | null; steps_json: string | null } } } }).db;
    const row = db.prepare('SELECT error, steps_json FROM switch_log ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.error?.includes(secret) ?? false, false);
    assert.equal(row.steps_json?.includes(secret) ?? false, false);
    f.close();
    f.store.close();
  });
});
