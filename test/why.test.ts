import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountSnapshot, BucketReading, Confidence } from '../src/types';
import { openStore } from '../src/store';
import { snapshotsFromStore, resolveFromSnapshots } from '../src/resolve';
import { failoverConfigKey, roundRobinConfigKey } from '../src/overrides';
import { DEFAULT_CEILING, scoreAccount } from '../src/scoring';
import { explainWhy } from '../src/why';

function reading(
  usedPct: number,
  confidence: Confidence = 'authoritative',
): BucketReading {
  return {
    usedPct,
    source: 'poll',
    confidence,
    fetchedAt: Date.now(),
  };
}

function anthropic(
  id: string,
  buckets: Record<string, BucketReading>,
  extra?: Partial<AccountSnapshot>,
): AccountSnapshot {
  return {
    accountId: id,
    provider: 'anthropic',
    label: id,
    buckets,
    ...extra,
  };
}

describe('explainWhy', () => {
  it('picks the winner from a 3-account pool and reasons each loser', () => {
    const A = anthropic('A', { '5h': reading(70), '7d': reading(20) });
    const B = anthropic('B', { '5h': reading(40), '7d': reading(65) });
    const C = anthropic('C', { '5h': reading(100), '7d': reading(100) });

    const report = explainWhy({
      model: 'claude-sonnet-5',
      snapshots: [A, B, C],
    });

    assert.equal(report.accountId, 'A');
    assert.equal(report.strategy, 'headroom');
    assert.equal(report.score, scoreAccount(A, 'claude-sonnet-5', DEFAULT_CEILING));
    assert.equal(report.score, 10);
    assert.equal(report.error, null);
    assert.equal(report.losers.length, 2);

    const byId = Object.fromEntries(report.losers.map((l) => [l.accountId, l]));
    assert.equal(byId.B.reason, 'headroom');
    assert.match(byId.B.detail, /score 9 < 10/);
    assert.equal(byId.C.reason, 'unavailable');
    assert.match(byId.C.detail, /exhausted/);
  });

  it('reads stored snapshots (no live fetch) and still names winner + losers', () => {
    const store = openStore(':memory:');
    store.upsertAccount('A', 'anthropic', 'account-A');
    store.upsertSnapshot('A', '5h', reading(70));
    store.upsertSnapshot('A', '7d', reading(20));
    store.upsertAccount('B', 'anthropic', 'account-B');
    store.upsertSnapshot('B', '5h', reading(40));
    store.upsertSnapshot('B', '7d', reading(65));
    store.upsertAccount('C', 'anthropic', 'account-C');
    store.upsertSnapshot('C', '5h', reading(100));
    store.upsertSnapshot('C', '7d', reading(100));

    const before = store.listDecisions().length;
    const report = explainWhy({
      model: 'claude-sonnet-5',
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });
    assert.equal(report.accountId, 'A');
    assert.equal(report.strategy, 'headroom');
    assert.equal(report.losers.length, 2);
    assert.equal(store.listDecisions().length, before, 'why must not persist a decision');
    store.close();
  });

  it('marks non-pinned accounts as pinned when a session pin wins', () => {
    const store = openStore(':memory:');
    store.upsertOverride({
      kind: 'pin',
      accountId: 'B',
      session: 'synth-why-pin',
      until: Date.now() + 60_000,
    });
    const A = anthropic('A', { '5h': reading(10), '7d': reading(10) });
    const B = anthropic('B', { '5h': reading(70), '7d': reading(70) });
    const C = anthropic('C', { '5h': reading(40), '7d': reading(40) });

    const report = explainWhy({
      model: 'claude-sonnet-5',
      snapshots: [A, B, C],
      store,
      session: 'synth-why-pin',
    });

    assert.equal(report.accountId, 'B');
    assert.equal(report.strategy, 'pin');
    assert.equal(report.error, null);
    const byId = Object.fromEntries(report.losers.map((l) => [l.accountId, l]));
    assert.equal(byId.A.reason, 'pinned');
    assert.equal(byId.C.reason, 'pinned');
    store.close();
  });

  it('explains EXHAUSTED without throwing — still returns per-loser reasons', () => {
    const A = anthropic('A', { '5h': reading(100), '7d': reading(100) });
    const B = anthropic('B', { '5h': reading(100), '7d': reading(100) });
    const C = anthropic('C', { '5h': reading(100), '7d': reading(100) });

    const report = explainWhy({
      model: 'claude-sonnet-5',
      snapshots: [A, B, C],
    });

    assert.equal(report.accountId, null);
    assert.equal(report.score, null);
    assert.equal(report.error, 'EXHAUSTED');
    assert.equal(report.losers.length, 3);
    for (const loser of report.losers) {
      assert.equal(loser.reason, 'unavailable');
      assert.match(loser.detail, /exhausted/);
    }
  });

  it('treats an error snapshot as unavailable', () => {
    const A = anthropic('A', { '5h': reading(20), '7d': reading(20) });
    const B = anthropic('B', { '5h': reading(40), '7d': reading(40) });
    const C = anthropic('C', {}, { error: 'auth_revoked' });

    const report = explainWhy({
      model: 'claude-sonnet-5',
      snapshots: [A, B, C],
    });

    assert.equal(report.accountId, 'A');
    const c = report.losers.find((l) => l.accountId === 'C');
    assert.ok(c);
    assert.equal(c!.reason, 'unavailable');
    assert.match(c!.detail, /auth_revoked/);
  });

  it('matches resolve under drain-first and does not persist a decision', () => {
    const store = openStore(':memory:');
    store.upsertOverride({
      kind: 'drain-first',
      accountId: 'C',
      until: Date.now() + 60_000,
    });
    const snapshots = [
      anthropic('A', { '5h': reading(10), '7d': reading(10) }),
      anthropic('B', { '5h': reading(40), '7d': reading(40) }),
      anthropic('C', { '5h': reading(70), '7d': reading(70) }),
    ];
    const before = store.listDecisions().length;
    const why = explainWhy({
      model: 'claude-sonnet-5',
      snapshots,
      store,
    });
    assert.equal(store.listDecisions().length, before, 'why must not persist a decision');
    const resolved = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots,
      store,
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(why.accountId, resolved.accountId);
    assert.equal(why.accountId, 'C');
    store.close();
  });

  it('matches resolve under sticky failover and does not write failover config', () => {
    const store = openStore(':memory:');
    const key = failoverConfigKey('anthropic');
    store.setConfig(key, 'B');
    const snapshots = [
      anthropic('A', { '5h': reading(10), '7d': reading(10) }),
      anthropic('B', { '5h': reading(40), '7d': reading(40) }),
      anthropic('C', { '5h': reading(70), '7d': reading(70) }),
    ];
    const why = explainWhy({
      model: 'claude-sonnet-5',
      strategy: 'failover',
      snapshots,
      store,
    });
    assert.equal(store.getConfig(key), 'B', 'why must not rewrite failover stickiness');
    const resolved = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      strategy: 'failover',
      snapshots,
      store,
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(why.accountId, resolved.accountId);
    assert.equal(why.accountId, 'B');
    assert.equal(store.getConfig(key), 'B');
    store.close();
  });

  it('peeks failover without setConfig, then matches the subsequent resolve', () => {
    const store = openStore(':memory:');
    const key = failoverConfigKey('anthropic');
    const snapshots = [
      anthropic('A', { '5h': reading(10), '7d': reading(10) }),
      anthropic('B', { '5h': reading(40), '7d': reading(40) }),
      anthropic('C', { '5h': reading(70), '7d': reading(70) }),
    ];
    assert.equal(store.getConfig(key), null);
    const why = explainWhy({
      model: 'claude-sonnet-5',
      strategy: 'failover',
      snapshots,
      store,
    });
    assert.equal(store.getConfig(key), null, 'why must not write failover config');
    const resolved = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      strategy: 'failover',
      snapshots,
      store,
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(why.accountId, resolved.accountId);
    assert.equal(store.getConfig(key), resolved.accountId);
    store.close();
  });

  it('matches resolve under round-robin without advancing the cursor', () => {
    const store = openStore(':memory:');
    const key = roundRobinConfigKey('anthropic');
    const snapshots = [
      anthropic('A', { '5h': reading(10), '7d': reading(10) }),
      anthropic('B', { '5h': reading(40), '7d': reading(40) }),
      anthropic('C', { '5h': reading(70), '7d': reading(70) }),
    ];
    const req = {
      model: 'claude-sonnet-5',
      strategy: 'round-robin' as const,
      snapshots,
      store,
    };

    const cursor0 = store.getConfig(key);
    const why1 = explainWhy(req);
    assert.equal(store.getConfig(key), cursor0, 'why must not advance round-robin');
    const resolved1 = resolveFromSnapshots(req);
    assert.equal(resolved1.ok, true);
    if (!resolved1.ok) return;
    assert.equal(why1.accountId, resolved1.accountId);

    const cursor1 = store.getConfig(key);
    const why2 = explainWhy(req);
    assert.equal(store.getConfig(key), cursor1, 'why must not advance round-robin');
    const resolved2 = resolveFromSnapshots(req);
    assert.equal(resolved2.ok, true);
    if (!resolved2.ok) return;
    assert.equal(why2.accountId, resolved2.accountId);
    assert.notEqual(why1.accountId, why2.accountId);
    store.close();
  });
});
