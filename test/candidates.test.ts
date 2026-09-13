import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectCandidates, recordObservation } from '../src/candidates';
import { resolveFromSnapshots } from '../src/resolve';
import { openStore } from '../src/store';
import type { Strategy } from '../src/scoring';
import type { AccountSnapshot, Adapter, BucketReading } from '../src/types';
import { explainWhy } from '../src/why';

function reading(usedPct: number): BucketReading {
  return {
    usedPct,
    source: 'poll',
    confidence: 'authoritative',
    fetchedAt: Date.now(),
  };
}

function snap(
  id: string,
  provider: string,
  buckets: Record<string, BucketReading>,
  extra?: Partial<AccountSnapshot>,
): AccountSnapshot {
  return { accountId: id, provider, label: id, buckets, ...extra };
}

function adapter(
  id: string,
  fetch: () => AccountSnapshot[],
  extra?: Partial<Adapter>,
): Adapter {
  return {
    id,
    displayName: id,
    fetchSnapshots: async () => fetch(),
    ...extra,
  };
}

describe('collectCandidates', () => {
  it('probe:true then probe:false yields identical winners across 4 strategies', async () => {
    const store = openStore(':memory:');
    const A = snap('A', 'anthropic', { '5h': reading(70), '7d': reading(20) });
    const B = snap('B', 'anthropic', { '5h': reading(40), '7d': reading(65) });
    const adapters = [adapter('anthropic', () => [A, B])];
    const probed = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: true,
      recordAs: 'resolve',
    });
    const recalled = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: false,
    });
    const strategies: Strategy[] = ['headroom', 'spread', 'round-robin', 'failover'];
    for (const strategy of strategies) {
      const a = resolveFromSnapshots({
        model: 'claude-sonnet-5',
        snapshots: probed.snapshots,
        store,
        strategy,
        persist: false,
      });
      const b = resolveFromSnapshots({
        model: 'claude-sonnet-5',
        snapshots: recalled.snapshots,
        store,
        strategy,
        persist: false,
      });
      assert.equal(a.ok, b.ok, strategy);
      if (a.ok && b.ok) assert.equal(a.accountId, b.accountId, strategy);
    }
    store.close();
  });

  it('credential error observed by probe keeps account unavailable in why', async () => {
    const store = openStore(':memory:');
    const adapters = [
      adapter('anthropic', () => [
        snap('good', 'anthropic', { '5h': reading(20), '7d': reading(20) }),
        snap('bad', 'anthropic', {}, { error: 'auth_revoked' }),
      ]),
    ];
    await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: true,
      recordAs: 'resolve',
    });
    const recalled = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: false,
    });
    const report = explainWhy({
      model: 'claude-sonnet-5',
      snapshots: recalled.snapshots,
      store,
      observations: recalled.observations,
    });
    const bad = report.losers.find((l) => l.accountId === 'bad');
    assert.ok(bad);
    assert.equal(bad!.reason, 'unavailable');
    assert.match(bad!.detail, /auth_revoked/);
    store.close();
  });

  it('post-observation bucket changes do not alter the reproduced pick until re-probe', async () => {
    const store = openStore(':memory:');
    const A = snap('A', 'anthropic', { '5h': reading(10), '7d': reading(10) });
    const B = snap('B', 'anthropic', { '5h': reading(80), '7d': reading(80) });
    const live = { current: [A, B] as AccountSnapshot[] };
    const adapters = [adapter('anthropic', () => live.current)];
    await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: true,
      recordAs: 'resolve',
    });
    const first = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: false,
    });
    const before = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: first.snapshots,
      persist: false,
    });
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.equal(before.accountId, 'A');

    store.upsertAccount('A', 'anthropic', 'A');
    store.upsertSnapshot('A', '5h', reading(100));
    store.upsertSnapshot('A', '7d', reading(100));

    const afterStore = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: false,
    });
    const still = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: afterStore.snapshots,
      persist: false,
    });
    assert.equal(still.ok, true);
    if (!still.ok) return;
    assert.equal(still.accountId, 'A', 'frozen observation must ignore live store buckets');

    live.current = [
      snap('A', 'anthropic', {}, { error: 'new credential error' }),
      B,
    ];
    const stillError = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: false,
    });
    const frozen = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: stillError.snapshots,
      persist: false,
    });
    assert.equal(frozen.ok, true);
    if (!frozen.ok) return;
    assert.equal(frozen.accountId, 'A', 'new credential error is not visible until re-probe');

    const reprobed = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: true,
      recordAs: 'resolve',
    });
    const updated = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: reprobed.snapshots,
      persist: false,
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.equal(updated.accountId, 'B');
    store.close();
  });

  it('account removed from adapter output disappears after re-probe', async () => {
    const store = openStore(':memory:');
    const live = {
      current: [
        snap('keep', 'anthropic', { '5h': reading(20), '7d': reading(20) }),
        snap('gone', 'anthropic', { '5h': reading(40), '7d': reading(40) }),
      ] as AccountSnapshot[],
    };
    const adapters = [adapter('anthropic', () => live.current)];
    await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: true,
      recordAs: 'refresh',
    });
    live.current = [live.current[0]];
    const after = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: true,
      recordAs: 'refresh',
    });
    assert.ok(after.snapshots.some((s) => s.accountId === 'keep'));
    assert.ok(!after.snapshots.some((s) => s.accountId === 'gone'));
    store.close();
  });

  it('never-probed provider falls back to store snapshots with source flag', async () => {
    const store = openStore(':memory:');
    store.upsertAccount('stored', 'anthropic', 'stored');
    store.upsertSnapshot('stored', '5h', reading(15));
    store.upsertSnapshot('stored', '7d', reading(15));
    const adapters = [adapter('anthropic', () => [])];
    const result = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: false,
    });
    assert.equal(result.observations[0]?.status, 'store-fallback');
    assert.ok(result.snapshots.some((s) => s.accountId === 'stored'));
    store.close();
  });

  it('recordObservation failure (setConfig throws) does not fail collectCandidates or resolve', async () => {
    const store = openStore(':memory:');
    store.setConfig = () => {
      throw new Error('db locked');
    };
    const adapters = [
      adapter('anthropic', () => [
        snap('A', 'anthropic', { '5h': reading(20), '7d': reading(20) }),
      ]),
    ];
    const result = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: true,
      recordAs: 'resolve',
    });
    assert.ok(result.snapshots.length > 0);
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: result.snapshots,
      persist: false,
    });
    assert.equal(decision.ok, true);
    store.close();
  });

  it('malformed observation data → observation: unavailable', async () => {
    const store = openStore(':memory:');
    store.setConfig('observed:anthropic', '{not-json');
    const adapters = [adapter('anthropic', () => [])];
    const result = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: false,
    });
    assert.equal(result.observations[0]?.status, 'unavailable');
    assert.equal(result.snapshots.length, 0);
    store.close();
  });

  it('string usedPct observation is unavailable and scores nothing', async () => {
    const store = openStore(':memory:');
    store.setConfig(
      'observed:anthropic',
      JSON.stringify({
        at: '2026-01-01T00:00:00.000Z',
        source: 'resolve',
        generation: 1,
        persisted: true,
        outcome: 'ok',
        accounts: [
          {
            accountId: 'A',
            provider: 'anthropic',
            label: 'A',
            buckets: {
              '5h': {
                usedPct: '12',
                source: 'poll',
                confidence: 'authoritative',
                fetchedAt: 1,
              },
            },
          },
        ],
      }),
    );
    const adapters = [adapter('anthropic', () => [])];
    const result = await collectCandidates({
      adapters,
      store,
      models: ['claude-sonnet-5'],
      probe: false,
    });
    assert.equal(result.observations[0]?.status, 'unavailable');
    assert.equal(result.snapshots.length, 0);
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: result.snapshots,
      persist: false,
    });
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.error, 'EXHAUSTED');
    store.close();
  });
});

describe('recordObservation', () => {
  it('stores generation + normalized snapshots atomically', () => {
    const store = openStore(':memory:');
    recordObservation(
      store,
      { provider: 'anthropic' },
      [snap('A', 'anthropic', { '5h': reading(1) })],
      'status',
    );
    recordObservation(
      store,
      { provider: 'anthropic' },
      [snap('A', 'anthropic', { '5h': reading(2) })],
      'resolve',
    );
    const raw = store.getConfig('observed:anthropic');
    assert.ok(raw);
    const parsed = JSON.parse(raw!) as { generation: number; accounts: AccountSnapshot[] };
    assert.equal(parsed.generation, 2);
    assert.equal(parsed.accounts[0]?.buckets['5h']?.usedPct, 2);
    store.close();
  });
});
