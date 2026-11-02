import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { anthropicTick } from '../src/auto/anthropic';
import type { ClaudeSwitchDeps, ClaudeSwitchResult } from '../src/cc-switch';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import { MockKeychain } from '../src/keychain';
import { openStore } from '../src/store';

const NOW = 1_700_000_000_000;

function result(outcome: ClaudeSwitchResult['outcome']): ClaudeSwitchResult {
  return { outcome, from: '1', to: '3', attempt: 'fixture', exitCode: outcome === 'refused' ? 3 : outcome === 'ok' ? 0 : 1 };
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

function tickDeps(f: Awaited<ReturnType<typeof fixture>>, switcher: (deps: ClaudeSwitchDeps, input: { to: string; trigger: string }) => Promise<ClaudeSwitchResult>) {
  return {
    store: f.store,
    slots: f.slots,
    now: () => NOW,
    switchDeps: {} as ClaudeSwitchDeps,
    switchClaude: switcher as typeof import('../src/cc-switch').switchClaude,
  };
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

  it('dry run performs zero writes and takes no lock (spy)', async () => {
    const f = await fixture();
    let writes = 0;
    let switches = 0;
    const originalSetConfig = f.store.setConfig.bind(f.store);
    f.store.setConfig = (key, value) => { writes += 1; originalSetConfig(key, value); };
    const locks = { switch: 0, credential: 0, config: 0, owner: 0 };
    const output = await anthropicTick({
      ...tickDeps(f, async () => { switches += 1; return result('ok'); }),
      dryRun: true,
      switchDeps: {
        locks: {
          switch: (..._args: unknown[]) => { locks.switch += 1; },
          credential: (..._args: unknown[]) => { locks.credential += 1; },
          configPath: (..._args: unknown[]) => { locks.config += 1; },
          owner: (..._args: unknown[]) => { locks.owner += 1; },
        },
      } as unknown as ClaudeSwitchDeps,
    });
    assert.equal(output.decision.kind, 'switch');
    assert.equal(writes, 0);
    assert.equal(switches, 0);
    assert.deepEqual(locks, { switch: 0, credential: 0, config: 0, owner: 0 });
  });

  it('token-shaped text in a switch error never reaches switch_log.error or steps_json', async () => {
    const f = await fixture();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    await anthropicTick(tickDeps(f, async () => {
      f.store.recordSwitch({ provider: 'anthropic', toAccount: '3', trigger: 'proactive', outcome: 'failed', error: `switch ${secret}`, stepsJson: JSON.stringify({ error: secret }) });
      return { ...result('failed'), error: `switch ${secret}` };
    }));
    const db = (f.store as unknown as { db: { prepare: (sql: string) => { get: () => { error: string | null; steps_json: string | null } } } }).db;
    const row = db.prepare('SELECT error, steps_json FROM switch_log ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.error?.includes(secret), false);
    assert.equal(row.steps_json?.includes(secret), false);
  });
});
