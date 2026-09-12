import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountSnapshot, BucketReading, Confidence } from '../src/types';
import { openStore } from '../src/store';
import { snapshotsFromStore } from '../src/resolve';
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
});
