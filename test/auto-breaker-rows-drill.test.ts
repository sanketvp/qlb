import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runAuto, AutoAdmissionRefused } from '../src/auto';
import { anthropicBreakerRowsDrill, anthropicTick } from '../src/auto/anthropic';
import { defaultConfig } from '../src/config';
import { beginCutover, transition } from '../src/lifecycle';
import { openStore } from '../src/store';

const NOW = 1_700_000_000_000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-breaker-drill-'));
  const config = defaultConfig(root);
  const store = openStore(config.dbPath);
  beginCutover(store, NOW - 10);
  assert.equal(transition(store, 'cutover', NOW - 9).ok, true);
  store.setActiveLogin('anthropic', 'active', 'fixture', NOW - 8);
  for (const [accountId, pct] of [['active', 20], ['next', 10]] as const) {
    store.upsertSnapshot(accountId, '5h', { usedPct: pct, fetchedAt: NOW, source: 'poll', confidence: 'authoritative' });
  }
  const slots = { listSlots: () => [
    { accountId: 'active', dead: false }, { accountId: 'next', dead: false },
  ] } as unknown as import('../src/cc-slots').ClaudeSlots;
  return { root, store, slots };
}

function rows(store: ReturnType<typeof openStore>) {
  return (store as unknown as { db: { prepare(sql: string): { all(): Array<Record<string, unknown>> } } }).db
    .prepare('SELECT trigger, outcome, error, injected, detail, committed_at FROM switch_log ORDER BY id').all().map((row) => ({ ...row }));
}

describe('auto breaker-rows fault drill', () => {
  it('commits only the three seed rows, one refusal, and one suspension in an immediate transaction', () => {
    const { root, store, slots } = fixture();
    try {
      const result = anthropicBreakerRowsDrill({ store, slots, now: () => NOW });
      assert.deepEqual(result.decision, {
        kind: 'stay', reason: 'breaker', unhealthyTicks: 3, suspendedUntilMs: NOW + 3_600_000,
      });
      assert.deepEqual(rows(store), [
        { trigger: 'failover', outcome: 'ok', error: null, injected: 1, detail: 'fault-injection:breaker-rows:seed', committed_at: NOW - 3 },
        { trigger: 'failover', outcome: 'ok', error: null, injected: 1, detail: 'fault-injection:breaker-rows:seed', committed_at: NOW - 2 },
        { trigger: 'failover', outcome: 'ok', error: null, injected: 1, detail: 'fault-injection:breaker-rows:seed', committed_at: NOW - 1 },
        { trigger: 'failover', outcome: 'refused', error: 'breaker', injected: 1, detail: 'fault-injection:breaker-rows', committed_at: null },
      ]);
      assert.equal(store.getConfig('auto.anthropic.suspendedUntil'), String(NOW + 3_600_000));
      for (const key of ['auto.heartbeatAt', 'auto.anthropic.unhealthyTicks', 'auto.anthropic.healthTickAt', 'auto.anthropic.idleHoldSince', 'auto.anthropic.parkedUntil']) {
        assert.equal(store.getConfig(key), null);
      }
      assert.equal(store.getActiveLogin('anthropic')?.accountId, 'active');
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('does not poll, reconcile, heartbeat, or persist health counters', async () => {
    let poll = 0;
    let reconcile = 0;
    const writes: string[] = [];
    const output = await runAuto({ once: true, inject: { kind: 'breaker-rows', provider: 'anthropic' } }, {
      makeLiveBinding: () => ({
        store: { setConfig: (key: string) => writes.push(key) }, close: () => {},
        reconcile: async () => { reconcile += 1; }, poll: async () => { poll += 1; return []; }, tick: async () => { throw new Error('tick'); },
        breakerRowsDrill: async () => ({ decision: { kind: 'stay', reason: 'breaker', unhealthyTicks: 3, suspendedUntilMs: NOW + 3_600_000 } }),
      }),
      assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: () => {},
    });
    assert.equal(output.ticks, 1);
    assert.equal(poll, 0);
    assert.equal(reconcile, 0);
    assert.deepEqual(writes, []);
  });

  it('refuses wrong decisions and C-swap or journal preconditions without a drill write', async () => {
    let drill = 0;
    const binding = () => ({
      store: { setConfig: () => { throw new Error('write'); } }, close: () => {}, reconcile: async () => { throw new Error('reconcile'); },
      poll: async () => { throw new Error('poll'); }, tick: async () => { throw new Error('tick'); },
      breakerRowsDrill: async () => { drill += 1; return { decision: { kind: 'stay' as const, reason: 'unknown' as const, unhealthyTicks: 1 } }; },
    });
    await assert.rejects(runAuto({ once: true, inject: { kind: 'breaker-rows', provider: 'anthropic' } }, {
      makeLiveBinding: binding, assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: () => {},
    }), (error: unknown) => error instanceof AutoAdmissionRefused && error.code === 'drill-breaker-not-reached');
    assert.equal(drill, 1);

    drill = 0;
    await assert.rejects(runAuto({ once: true, inject: { kind: 'breaker-rows', provider: 'anthropic' } }, {
      makeLiveBinding: binding, assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [{ pid: 1 }], log: () => {},
    }), (error: unknown) => error instanceof AutoAdmissionRefused && error.code === 'cswap-alive');
    assert.equal(drill, 0);

    const home = mkdtempSync(join(tmpdir(), 'qlb-breaker-journal-'));
    try {
      mkdirSync(join(home, '.qlb', 'journal'), { recursive: true });
      writeFileSync(join(home, '.qlb', 'journal', 'switch-anthropic.json'), '{}');
      await assert.rejects(runAuto({ once: true, inject: { kind: 'breaker-rows', provider: 'anthropic' } }, {
        home, env: { HOME: home }, makeLiveBinding: binding, assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: () => {},
      }), (error: unknown) => error instanceof AutoAdmissionRefused && error.code === 'claude-switch-journal-present');
      assert.equal(drill, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('excludes synthetic seeds from later normal breaker and cooldown clocks', async () => {
    const { root, store, slots } = fixture();
    try {
      anthropicBreakerRowsDrill({ store, slots, now: () => NOW });
      assert.equal(store.latestCommittedAnthropicAutoswitchAt(), undefined);
      store.setConfig('auto.anthropic.suspendedUntil', '');
      const normal = await anthropicTick({ store, slots, now: () => NOW + 1, dryRun: true, activeUsageUnknown: true });
      assert.notEqual(normal.decision.kind === 'stay' && normal.decision.reason, 'breaker');
      store.recordSwitch({ provider: 'anthropic', toAccount: 'next', trigger: 'proactive', outcome: 'ok', injected: true, detail: 'fault-injection:usage-5xx', committedAt: NOW });
      assert.equal(store.latestCommittedAnthropicAutoswitchAt(), NOW);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
