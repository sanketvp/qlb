import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountSnapshot, BucketReading, Confidence } from '../src/types';
import { openStore } from '../src/store';
import { snapshotsFromStore, resolveFromSnapshots } from '../src/resolve';

function reading(
  usedPct: number,
  confidence: Confidence = 'authoritative',
  resetAt?: number,
): BucketReading {
  const r: BucketReading = {
    usedPct,
    source: 'poll',
    confidence,
    fetchedAt: Date.now(),
  };
  if (resetAt != null) r.resetAt = resetAt;
  return r;
}

function seed(
  store: ReturnType<typeof openStore>,
  id: string,
  buckets: Record<string, BucketReading>,
  label = id,
): void {
  store.upsertAccount(id, 'anthropic', label);
  for (const [bucket, value] of Object.entries(buckets)) {
    store.upsertSnapshot(id, bucket, value);
  }
}

describe('qlb resolve — store-backed end-to-end', () => {
  it('normal resolve: picks the higher-scoring account (case 1 A vs B)', () => {
    const store = openStore(':memory:');
    seed(store, 'A', { '5h': reading(70), '7d': reading(20) }, 'account-A');
    seed(store, 'B', { '5h': reading(40), '7d': reading(65) }, 'account-B');

    const snapshots = snapshotsFromStore(store, 'anthropic');
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots,
      store,
      harness: 'dispatch',
    });

    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, 'A');
    assert.equal(decision.servedModel, 'claude-sonnet-5');
    assert.equal(decision.requestedModel, 'claude-sonnet-5');
    assert.equal(decision.mode, 'headroom');
    assert.equal(decision.score, 10);
    assert.ok(typeof decision.decisionId === 'number');
    store.close();
  });

  it('all-in fallback: ceiling 80 scores ≤ 0, ceiling 100 selects the account', () => {
    const store = openStore(':memory:');
    // used 90 → headroom at 80 = -10 (not selected); at 100 = 10
    seed(store, 'hot', {
      '5h': reading(90),
      '7d': reading(90),
    });

    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });

    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, 'hot');
    assert.equal(decision.mode, 'all-in');
    assert.equal(decision.ceiling, 100);
    assert.ok(decision.score > 0);
    store.close();
  });

  it('fallback chain walk: requested Fable exhausted, Opus fallback serves', () => {
    const store = openStore(':memory:');
    // Fable pool at 100% → score 0 even at ceiling 100. Opus pool has room.
    seed(store, 'one', {
      '5h': reading(50),
      '7d': reading(50),
      '7d:Fable': reading(100),
      '7d:Opus': reading(20),
    });

    const fable = resolveFromSnapshots({
      model: 'claude-fable-5',
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });
    assert.equal(fable.ok, false);
    if (fable.ok) return;
    assert.equal(fable.error, 'EXHAUSTED');

    const withFallback = resolveFromSnapshots({
      model: 'claude-fable-5',
      fallback: ['claude-opus-5'],
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });
    assert.equal(withFallback.ok, true);
    if (!withFallback.ok) return;
    assert.equal(withFallback.requestedModel, 'claude-fable-5');
    assert.equal(withFallback.servedModel, 'claude-opus-5');
    assert.notEqual(withFallback.servedModel, withFallback.requestedModel);
    assert.ok(withFallback.mode === 'fallback' || withFallback.mode === 'fallback-all-in');
    assert.ok(withFallback.reason.includes('claude-opus-5'));
    store.close();
  });

  it('EXHAUSTED: every scored bucket at 100%, reports earliest reset', () => {
    const store = openStore(':memory:');
    const resetA = Date.now() + 3 * 60 * 60 * 1000;
    const resetB = Date.now() + 60 * 60 * 1000; // earlier
    seed(store, 'A', {
      '5h': reading(100, 'authoritative', resetA),
      '7d': reading(100, 'authoritative', resetA),
    });
    seed(store, 'B', {
      '5h': reading(100, 'authoritative', resetB),
      '7d': reading(100, 'authoritative', resetB),
    });

    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      fallback: ['claude-opus-5'],
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });

    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.error, 'EXHAUSTED');
    assert.ok(decision.earliestReset);
    assert.equal(decision.earliestReset!.accountId, 'B');
    assert.equal(decision.earliestReset!.at, resetB);
    assert.ok(typeof decision.decisionId === 'number');
    store.close();
  });
});
