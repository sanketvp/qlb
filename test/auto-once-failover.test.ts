import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildUsageRequest } from '../src/anthropic-oauth';
import { AUTO_BINDINGS, anthropicModelScope, autoReconcileStillTheSameProcess, productionRequest, runAuto } from '../src/auto';
import { anthropicTick, pollAnthropic, type AnthropicTickResult } from '../src/auto/anthropic';
import * as autoAnthropicModule from '../src/auto/anthropic';
import { claudePaths } from '../src/cc-paths';
import { type ClaudeSwitchDeps } from '../src/cc-switch';
import { createClaudeSwitchJournal, type ClaudeSwitchJournal } from '../src/cc-switch-journal';
import { SqliteClaudeSlotRepository, type ClaudeSlot } from '../src/cc-slots';
import { defaultConfig } from '../src/config';
import { MockKeychain } from '../src/keychain';
import { reconcileClaudeSwitch } from '../src/journal';
import { beginCutover, transition } from '../src/lifecycle';
import { openStore, openStoreConnection } from '../src/store';

const decision = { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } as const;

function liveBinding(overrides: Partial<{
  reconcile(): Promise<void>;
  poll(): Promise<[]>;
  tick(): Promise<AnthropicTickResult>;
}> = {}) {
  const writes: Array<[string, string]> = [];
  return {
    store: { setConfig: (key: string, value: string) => { writes.push([key, value]); } },
    close: () => {},
    reconcile: overrides.reconcile ?? (async () => {}),
    poll: overrides.poll ?? (async () => [] as []),
    tick: overrides.tick ?? (async () => ({ decision })),
    writes,
  };
}

const AUTO_NOW = 1_000_000;

function weeklyUsageFixture(fablePct: number, modelConfig: string | null = null, nextFablePct = 10, fallbackFablePct?: number) {
  const root = mkdtempSync(join(tmpdir(), 'qlb-auto-model-scope-'));
  const home = join(root, 'home');
  const config = defaultConfig(home);
  const store = openStore(config.dbPath);
  beginCutover(store, 1);
  assert.equal(transition(store, 'cutover', 2).ok, true);
  const slots: ClaudeSlot[] = ['active', 'next', ...(fallbackFablePct === undefined ? [] : ['fallback'])].map((accountId, index) => ({
    accountId, slotNum: index + 1, email: null, alias: null, orgUuid: null, configJson: '{}', fingerprint: null,
    prevFingerprint: null, threshold: null, dead: false, deadReason: null, deadAt: null, healedAt: null,
    addedAt: AUTO_NOW, lastActiveAt: null, source: 'fixture', archivedAt: null,
  }));
  const repository = SqliteClaudeSlotRepository.open(config.dbPath);
  try { for (const slot of slots) repository.createSlot(slot); } finally { repository.close(); }
  store.setActiveLogin('anthropic', 'active', 'fixture', AUTO_NOW);
  const fetchedAt = Date.now();
  for (const slot of slots) {
    const pct = slot.accountId === 'active' ? fablePct : slot.accountId === 'next' ? nextFablePct : fallbackFablePct!;
    store.upsertSnapshot(slot.accountId, '7d', { usedPct: slot.accountId === 'active' ? 85 : 10, fetchedAt, source: 'poll', confidence: 'authoritative' });
    store.upsertSnapshot(slot.accountId, '7d:Fable', { usedPct: pct, fetchedAt, source: 'poll', confidence: 'authoritative' });
  }
  if (modelConfig !== null) store.setConfig('auto.anthropic.models', modelConfig);
  return { root, home, config, store, slots };
}

async function autoCli(home: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [join(__dirname, '..', 'src', 'cli.js'), 'auto', ...args], {
    env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function dryRunCli(home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return autoCli(home, ['--once', '--dry-run', '--json']);
}

function productionUsageResponse(retryAfter: string) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('fixture rate limited', {
    status: 429, headers: { 'Retry-After': retryAfter },
  });
  return productionRequest(buildUsageRequest('fixture')).finally(() => { globalThis.fetch = originalFetch; });
}

async function reconcileFixture(owner: ClaudeSwitchJournal['owner'], sameProcess: ClaudeSwitchDeps['stillTheSameProcess']) {
  const root = mkdtempSync(join(tmpdir(), 'qlb-auto-reconcile-'));
  const home = join(root, 'home');
  const env = { QLB_TEST_MODE: '1', QLB_HOME: join(root, 'qlb-home'), HOME: home };
  const paths = claudePaths({ home, env });
  mkdirSync(paths.configHome, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  const journalDir = join(root, 'journal');
  const deps: ClaudeSwitchDeps = {
    store: {
      findCommittedSwitchByAttempt: () => null,
      recordSwitch: (row: Record<string, unknown>) => { rows.push(row); return rows.length; },
    } as unknown as ClaudeSwitchDeps['store'],

    slots: {} as ClaudeSwitchDeps['slots'],
    live: { backend: new MockKeychain(), paths, account: 'fixture' },
    readConfig: () => ({}), resolveProfile: async () => null,
    consume: { postRefresh: async () => ({ status: 500, body: '' }) },
    cswapProcesses: () => [], env, home, now: () => 1_000_000, by: 'qlb-auto', attempt: 'fixture',
    journalDir, journalOwner: owner, stillTheSameProcess: sameProcess,
  };
  const journal: ClaudeSwitchJournal = {
    v: 1, provider: 'anthropic', attemptId: 'orphaned-attempt', from: 'a', to: 'b', trigger: 'manual', by: 'qlb-auto', republish: false, injected: false, detail: null,
    decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null }, outgoingKind: null, bindingJson: null,
    step: 6, stagedBlobService: 'qlb:anthropic:staged-rollback:orphaned', stagedAccount: 'qlb', stagedWritten: false,
    keychainService: paths.keychainService, configPath: paths.globalConfigPath, configText: null, configWrittenHash: null,
    fromOauthAccount: null, credentialsWrittenHash: null, credentialsWriteStarted: false, credentialsWritten: false,
    configWriteStarted: false, configWritten: false, closed: null, startedAt: 1_000_000, owner,
  };
  createClaudeSwitchJournal(journal, { journalDir: deps.journalDir, home, env, configPath: paths.globalConfigPath, keychainService: paths.keychainService });
  return { deps, journalPath: join(journalDir, 'switch-anthropic.json'), rows };
}

async function reconcileOnNextTick(deps: ClaudeSwitchDeps): Promise<void> {
  await runAuto({ once: true }, {
    makeLiveBinding: () => ({
      store: { setConfig: () => {} }, close: () => {}, reconcile: () => reconcileClaudeSwitch(deps),
      poll: async () => [], tick: async () => ({ decision }),
    }),
    assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: () => {},
  });
}

function signals() {
  let handler: (() => void) | undefined;
  return {
    on: (_signal: string, value: () => void) => { handler = value; },
    removeListener: (_signal: string, value: () => void) => { if (handler === value) handler = undefined; },
    emit: () => handler?.(),
  };
}

describe('auto once failover (G11)', () => {
  it('the live binding counts a 7d:Fable window over threshold and proposes a proactive switch', async () => {
    const fixture = weeklyUsageFixture(92);
    try {
      const live = await anthropicTick({
        store: fixture.store, slots: { listSlots: () => fixture.slots } as unknown as import('../src/cc-slots').ClaudeSlots,
        now: () => AUTO_NOW, models: anthropicModelScope(fixture.store), dryRun: true,
      });
      assert.deepEqual(live.decision, {
        kind: 'switch', targetId: 'next', reason: 'proactive', unhealthyTicks: 0, parkedUntilMs: undefined,
        leftHeadroom: 8, leftRecoveryAtMs: null, leftTrigger: 'proactive',
      });
      fixture.store.close();
      const cli = await dryRunCli(fixture.home);
      assert.equal(cli.code, 0, cli.stderr);
      const receipt = JSON.parse(cli.stdout) as { decisions: Array<{ kind: string; reason: string }> };
      assert.equal(receipt.decisions[0]?.kind, 'switch');
      assert.equal(receipt.decisions[0]?.reason, 'proactive');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('live binding passes the configured model scope', async () => {
    const fixture = weeklyUsageFixture(10, ' fAbLe ');
    const autoAnthropic = autoAnthropicModule as {
      pollAnthropic: typeof pollAnthropic;
      anthropicTick: typeof anthropicTick;
    };
    const originalPoll = autoAnthropic.pollAnthropic;
    const originalTick = autoAnthropic.anthropicTick;
    let pollModels: readonly string[] | undefined;
    let tickModels: readonly string[] | undefined;
    try {
      autoAnthropic.pollAnthropic = async (deps) => {
        pollModels = deps.models;
        return [];
      };
      autoAnthropic.anthropicTick = async (deps) => {
        tickModels = deps.models;
        return { decision };
      };
      const output = await runAuto({ once: true }, {
        config: fixture.config, home: fixture.home,
        env: { QLB_TEST_MODE: '1', QLB_HOME: fixture.home, HOME: fixture.home }, now: () => AUTO_NOW,
        listCswapProcesses: () => [], log: () => {},
      });
      assert.equal(output.ticks, 1);
      assert.deepEqual(pollModels, ['fable']);
      assert.deepEqual(tickModels, ['fable']);
    } finally {
      autoAnthropic.pollAnthropic = originalPoll;
      autoAnthropic.anthropicTick = originalTick;
      fixture.store.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('exhausted 7d:fable target is not chosen', async () => {
    const fixture = weeklyUsageFixture(100, 'fable', 100, 10);
    try {
      const result = await anthropicTick({
        store: fixture.store, slots: { listSlots: () => fixture.slots } as unknown as import('../src/cc-slots').ClaudeSlots,
        now: () => AUTO_NOW, models: anthropicModelScope(fixture.store), dryRun: true,
      });
      assert.equal(result.decision.kind, 'switch');
      assert.equal(result.decision.targetId, 'fallback');
    } finally {
      fixture.store.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('a 7d:Fable window at 100% is at-limit', async () => {
    const fixture = weeklyUsageFixture(100);
    try {
      const result = await anthropicTick({
        store: fixture.store, slots: { listSlots: () => fixture.slots } as unknown as import('../src/cc-slots').ClaudeSlots,
        now: () => AUTO_NOW, models: anthropicModelScope(fixture.store), dryRun: true,
      });
      assert.equal(result.decision.kind, 'switch');
      assert.equal(result.decision.reason, 'at-limit');
    } finally {
      fixture.store.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('auto.anthropic.models=opus excludes 7d:Fable', async () => {
    const fixture = weeklyUsageFixture(92, ' OpUs ');
    try {
      assert.deepEqual(anthropicModelScope(fixture.store), ['opus']);
      assert.deepEqual(anthropicModelScope({ getConfig: () => 'opus,,fable' }), ['all']);
      const result = await anthropicTick({
        store: fixture.store, slots: { listSlots: () => fixture.slots } as unknown as import('../src/cc-slots').ClaudeSlots,
        now: () => AUTO_NOW, models: anthropicModelScope(fixture.store), dryRun: true,
      });
      assert.deepEqual(result.decision, { kind: 'stay', reason: 'below-threshold', unhealthyTicks: 0 });
    } finally {
      fixture.store.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('dry-run uses the same model scope as the live tick', async () => {
    const fixture = weeklyUsageFixture(92, ' fAbLe ');
    try {
      const live = await anthropicTick({
        store: fixture.store, slots: { listSlots: () => fixture.slots } as unknown as import('../src/cc-slots').ClaudeSlots,
        now: () => AUTO_NOW, models: anthropicModelScope(fixture.store), dryRun: true,
      });
      fixture.store.close();
      const dry = await runAuto({ once: true, dryRun: true }, {
        config: fixture.config, home: fixture.home,
        env: { QLB_TEST_MODE: '1', QLB_HOME: fixture.home, HOME: fixture.home }, now: () => AUTO_NOW, log: () => {},
      });
      assert.deepEqual(dry.decisions, [live.decision]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('configures an Anthropic scope through the CLI, clears only its stale park, and dry-runs under the new scope', async () => {
    const fixture = weeklyUsageFixture(92);
    try {
      fixture.store.setConfig('auto.anthropic.parkedUntil', String(AUTO_NOW + 60_000));
      fixture.store.setConfig('auto.anthropic.suspendedUntil', String(AUTO_NOW + 120_000));
      fixture.store.close();

      const set = await autoCli(fixture.home, ['scope', 'anthropic', 'OpUs', '--json']);
      assert.equal(set.code, 0, set.stderr);
      assert.deepEqual(JSON.parse(set.stdout), { provider: 'anthropic', scope: 'opus', changed: true, parkedCleared: true });
      const repeat = await autoCli(fixture.home, ['scope', 'anthropic', 'opus', '--json']);
      assert.equal(repeat.code, 0, repeat.stderr);
      assert.deepEqual(JSON.parse(repeat.stdout), { provider: 'anthropic', scope: 'opus', changed: false, parkedCleared: false });
      const inspect = await autoCli(fixture.home, ['scope', 'anthropic']);
      assert.equal(inspect.code, 0, inspect.stderr);
      assert.equal(inspect.stdout, 'anthropic automatic model scope: opus (unchanged)\n');

      const dry = await dryRunCli(fixture.home);
      assert.equal(dry.code, 0, dry.stderr);
      assert.deepEqual(JSON.parse(dry.stdout).decisions, [{ kind: 'stay', reason: 'below-threshold', unhealthyTicks: 0 }]);
      const reopened = openStore(fixture.config.dbPath);
      try {
        assert.equal(reopened.getConfig('auto.anthropic.models'), 'opus');
        assert.equal(reopened.getConfig('auto.anthropic.parkedUntil'), '');
        assert.equal(reopened.getConfig('auto.anthropic.suspendedUntil'), String(AUTO_NOW + 120_000));
      } finally { reopened.close(); }

      const reset = await autoCli(fixture.home, ['scope', 'anthropic', 'all']);
      assert.equal(reset.code, 0, reset.stderr);
      assert.equal(reset.stdout, 'anthropic automatic model scope: all (updated)\n');
      const invalid = await autoCli(fixture.home, ['scope', 'anthropic', 'opus!']);
      assert.equal(invalid.code, 2);
      assert.equal(invalid.stderr, 'qlb auto scope: invalid-model-name\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('a live C-swap process stays', async () => {
    const binding = liveBinding({
      reconcile: async () => { throw new Error('reconcile must not run'); },
      poll: async () => { throw new Error('poll must not run'); },
      tick: async () => { throw new Error('tick must not run'); },
    });
    const lines: string[] = [];
    const output = await runAuto({ once: true }, {
      makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [{ pid: 1 }],
      now: () => 100,
      log: (line) => lines.push(line),
    });
    assert.equal(output.ticks, 1);
    assert.deepEqual(output.decisions, []);
    assert.deepEqual(binding.writes, [['auto.heartbeatAt', '100']]);
    assert.deepEqual(lines, ['auto: stay(cswap-alive)']);
  });

  it('a thrown tick logs and continues', async () => {
    let ticks = 0;
    const term = signals();
    const binding = liveBinding({
      tick: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error('first tick failed');
        term.emit();
        return { decision };
      },
    });
    const lines: string[] = [];
    const output = await runAuto({}, {
      makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [],
      log: (line) => lines.push(line),
      signals: term,
      setTimeout: (callback) => { callback(); return {} as ReturnType<typeof setTimeout>; },
    });
    assert.equal(ticks, 2);
    assert.equal(output.ticks, 1);
    assert.deepEqual(output.decisions, [decision]);
    assert.deepEqual(lines, ['auto: tick error: first tick failed', 'auto: stay(unknown)']);
  });

  it('SIGTERM during a tick finishes it', async () => {
    const term = signals();
    let finished = false;
    const binding = liveBinding({
      tick: async () => {
        term.emit();
        await Promise.resolve();
        finished = true;
        return { decision };
      },
    });
    const output = await runAuto({}, {
      makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [],
      signals: term,
      log: () => {},
    });
    assert.equal(finished, true);
    assert.equal(output.ticks, 1);
  });

  it('SIGTERM during sleep clears the timer and ends the loop', async () => {
    const term = signals();
    let timer: (() => void) | undefined;
    let cleared = false;
    const pending = runAuto({}, {
      makeLiveBinding: () => liveBinding(),
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [],
      signals: term,
      log: () => {},
      setTimeout: (callback) => { timer = callback; return {} as ReturnType<typeof setTimeout>; },
      clearTimeout: () => { cleared = true; },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(timer);
    term.emit();
    const output = await pending;
    assert.equal(cleared, true);
    assert.equal(output.ticks, 1);
  });

  it('a real SIGTERM re-raised after refresh persistence still finishes the tick and exits 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-auto-signal-'));
    const modulePath = join(process.cwd(), 'dist-test', 'src', 'auto.js');
    const script = `
      const { runAuto } = require(${JSON.stringify(modulePath)});
      const keepAlive = setInterval(() => {}, 1000);
      process.once('SIGTERM', () => setImmediate(() => {
        process.kill(process.pid, 'SIGTERM');
        clearInterval(keepAlive);
        process.emit('refresh-persisted');
      }));
      runAuto({}, {
        makeLiveBinding: () => ({
          store: { setConfig: () => {} }, close: () => {}, reconcile: async () => {}, poll: async () => [],
          tick: async () => {
            console.log('refresh-started');
            await new Promise((resolve) => process.once('refresh-persisted', resolve));
            console.log('tick-finished');
            return { decision: { kind: 'stay', reason: 'fixture', unhealthyTicks: 0 } };
          },
        }),
        assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: () => {},
      }).then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ['-e', script], {
      env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let signaled = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (!signaled && stdout.includes('refresh-started')) {
          signaled = true;
          child.kill('SIGTERM');
        }
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal || code !== 0) reject(new Error(`child exit=${code} signal=${signal} output=${stdout}`));
        else resolve(stdout);
      });
    });
    assert.match(output, /tick-finished/);
  });

  it('records only successful switches as executed and logs a refusal reason', async () => {
    const refused: AnthropicTickResult = { decision: { kind: 'switch', targetId: 'next', reason: 'at-limit', unhealthyTicks: 1, leftHeadroom: 0, leftRecoveryAtMs: null, leftTrigger: 'at-limit' },
      switchResult: { outcome: 'refused', from: 'active', to: 'next', reason: 'switch-journal-present', attempt: 'fixture', exitCode: 3 } };
    const refusedLines: string[] = [];
    const refusedResult = await runAuto({ once: true }, {
      makeLiveBinding: () => liveBinding({ tick: async () => refused }), assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [], log: (line) => refusedLines.push(line),
    });
    assert.deepEqual(refusedResult.executed, []);
    assert.deepEqual(refusedLines, ['auto: switch(next,at-limit,refused,switch-journal-present)']);

    const ok: AnthropicTickResult = { decision: { kind: 'switch', targetId: 'next', reason: 'at-limit', unhealthyTicks: 1, leftHeadroom: 0, leftRecoveryAtMs: null, leftTrigger: 'at-limit' },
      switchResult: { outcome: 'ok', from: 'active', to: 'next', attempt: 'fixture', exitCode: 0 } };
    const okResult = await runAuto({ once: true }, {
      makeLiveBinding: () => liveBinding({ tick: async () => ok }), assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [], log: () => {},
    });
    assert.deepEqual(okResult.executed, ['next']);
  });

  it('maps production Retry-After headers into the usage-poll backoff', async () => {
    const store = openStore(':memory:');
    try {
      const delayed = await productionUsageResponse('3600');
      store.recordUsagePollResult('anthropic', 'delayed', {
        attemptedAt: 100, status: `http-${delayed.status}`, http429: true, retryAfterS: delayed.retryAfterS,
      });
      assert.equal(store.listUsagePolls('anthropic').delayed?.backoffUntil, 4_600);

      const fallback = await productionUsageResponse('later');
      store.recordUsagePollResult('anthropic', 'fallback', {
        attemptedAt: 100, status: `http-${fallback.status}`, http429: true, retryAfterS: fallback.retryAfterS,
      });
      assert.equal(store.listUsagePolls('anthropic').fallback?.backoffUntil, 130);
    } finally { store.close(); }
  });

  it('the auto reconcile process check recovers this process journal but leaves another live owner', async () => {
    const ownLstart = 'Tue Oct 28 10:00:00 2026';
    const checked: ClaudeSwitchJournal['owner'][] = [];
    const fallback: NonNullable<ClaudeSwitchDeps['stillTheSameProcess']> = async (owner) => {
      checked.push(owner);
      return owner.pid === 4242;
    };
    const own = await reconcileFixture(
      { pid: process.pid, lstart: ownLstart },
      autoReconcileStillTheSameProcess(ownLstart, fallback),
    );
    await reconcileOnNextTick(own.deps);
    assert.equal(existsSync(own.journalPath), false);
    assert.deepEqual(own.rows.map((row) => row.detail), ['crash-reconcile']);
    assert.deepEqual(checked, []);

    const other = await reconcileFixture(
      { pid: 4242, lstart: 'another live process' },
      autoReconcileStillTheSameProcess(ownLstart, fallback),
    );
    await reconcileOnNextTick(other.deps);
    assert.equal(existsSync(other.journalPath), true);
    assert.deepEqual(other.rows, []);
    assert.deepEqual(checked, [{ pid: 4242, lstart: 'another live process' }]);
  });

  it('xai and kimi bindings are never called', async () => {
    const binding = liveBinding();
    await runAuto({ once: true }, {
      makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [],
      now: () => 100,
      log: () => {},
    });
    assert.deepEqual(AUTO_BINDINGS, ['anthropic']);
    assert.deepEqual(binding.writes, [['auto.heartbeatAt', '100']]);
  });

  it('dry run never calls reconcile, poll, refresh or the heartbeat writer', async () => {
    let dryTicks = 0;
    let liveBindings = 0;
    const output = await runAuto({ once: true, dryRun: true }, {
      makeLiveBinding: () => { liveBindings += 1; return liveBinding(); },
      makeDryBinding: () => ({
        admit: () => ({ ok: true }), close: () => {}, tick: async () => { dryTicks += 1; return { decision }; },
      }),
      log: () => {},
    });
    assert.equal(dryTicks, 1);
    assert.equal(liveBindings, 0);
    assert.equal(output.ticks, 1);
  });

  it('the production dry branch uses stored readings without changing the database', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-auto-dry-'));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.close();
    const before = readFileSync(config.dbPath);
    const output = await runAuto({ once: true, dryRun: true }, {
      config, home, env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, now: () => 100,
      log: () => {},
    });
    assert.equal(output.ticks, 1);
    assert.deepEqual(readFileSync(config.dbPath), before);
  });

  it('dry run reports the same breaker stay as a live decision', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-auto-breaker-'));
    const config = defaultConfig(home);
    const now = 1_000_000;
    const store = openStore(config.dbPath);
    const repository = SqliteClaudeSlotRepository.open(config.dbPath);
    const slot = (accountId: string, slotNum: number): ClaudeSlot => ({
      accountId, slotNum, email: null, alias: null, orgUuid: null, configJson: '{}', fingerprint: null,
      prevFingerprint: null, threshold: null, dead: false, deadReason: null, deadAt: null, healedAt: null,
      addedAt: now, lastActiveAt: null, source: 'fixture', archivedAt: null,
    });
    repository.createSlot(slot('active', 1));
    repository.createSlot(slot('next', 2));
    repository.close();
    store.setActiveLogin('anthropic', 'active', 'fixture', now);
    store.upsertSnapshot('active', '5h', { usedPct: 100, fetchedAt: now, source: 'poll', confidence: 'authoritative' });
    store.upsertSnapshot('next', '5h', { usedPct: 0, fetchedAt: now, source: 'poll', confidence: 'authoritative' });
    for (let index = 0; index < 3; index += 1) store.recordSwitch({
      ts: now - index, provider: 'anthropic', fromAccount: 'active', toAccount: 'next', trigger: 'at-limit', outcome: 'ok', committedAt: now - index,
    });
    const slots = [slot('active', 1), slot('next', 2)];
    const live = await anthropicTick({ store, slots: { listSlots: () => slots } as unknown as import('../src/cc-slots').ClaudeSlots, now: () => now });
    store.setConfig('auto.anthropic.suspendedUntil', '');
    store.close();
    const dry = await runAuto({ once: true, dryRun: true }, {
      config, home, env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, now: () => now, log: () => {},
    });
    assert.deepEqual(dry.decisions, [live.decision]);
    assert.equal(dry.decisions[0]?.kind, 'stay');
    assert.equal(dry.decisions[0]?.reason, 'breaker');
  });

  it('token-shaped text in a thrown error never reaches the auto log or health_log', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const home = mkdtempSync(join(tmpdir(), 'qlb-auto-redact-'));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.close();
    const lines: string[] = [];
    const binding = liveBinding({ tick: async () => { throw new Error(`network ${secret}\nforged-line`); } });
    await runAuto({ once: true }, {
      config, home, env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: (line) => lines.push(line),
    });
    assert.equal(lines.join('\n').includes(secret), false);
    assert.equal(lines[0]?.includes('\n'), false);
    const db = openStoreConnection(config.dbPath, true);
    try {
      const rows = db.prepare('SELECT failing_json, dead_slots_json FROM health_log').all() as Array<{ failing_json: string; dead_slots_json: string }>;
      assert.equal(rows.some((row) => row.failing_json.includes(secret) || row.dead_slots_json.includes(secret)), false);
    } finally { db.close(); }
    assert.equal(binding.writes.length, 0);
  });
});
