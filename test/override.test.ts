import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_OVERRIDE_TTL_MS, parseUntil } from '../src/overrides';
import { resolveFromSnapshots } from '../src/resolve';
import { openStore } from '../src/store';
import type { AccountSnapshot, BucketReading, Confidence } from '../src/types';

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

function anthropic(id: string, used: number): AccountSnapshot {
  return {
    accountId: id,
    provider: 'anthropic',
    label: id,
    buckets: { '5h': reading(used), '7d': reading(used) },
  };
}

describe('parseUntil', () => {
  it('defaults to 24h from now when omitted', () => {
    const now = 1_700_000_000_000;
    assert.equal(parseUntil(undefined, now), now + DEFAULT_OVERRIDE_TTL_MS);
  });

  it('accepts durations and ISO datetimes', () => {
    const now = 1_700_000_000_000;
    assert.equal(parseUntil('2h', now), now + 2 * 3_600_000);
    assert.equal(parseUntil('30m', now), now + 30 * 60_000);
    assert.equal(parseUntil('1d', now), now + 86_400_000);
    const iso = '2026-09-08T12:00:00.000Z';
    assert.equal(parseUntil(iso, now), Date.parse(iso));
  });
});

describe('override pin', () => {
  it('forces the pinned account for that session and is session-scoped', () => {
    const store = openStore(':memory:');
    store.upsertOverride({
      kind: 'pin',
      accountId: 'B',
      session: 'synth-session-pin-1',
      until: Date.now() + 60_000,
    });
    const A = anthropic('A', 10);
    const B = anthropic('B', 70);
    const pinned = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [A, B],
      store,
      session: 'synth-session-pin-1',
    });
    assert.equal(pinned.ok, true);
    if (!pinned.ok) return;
    assert.equal(pinned.accountId, 'B');
    assert.equal(pinned.mode, 'pin');

    const other = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [A, B],
      store,
      session: 'synth-session-other',
    });
    assert.equal(other.ok, true);
    if (!other.ok) return;
    assert.equal(other.accountId, 'A');
    store.close();
  });

  it('fails loudly when the pinned account is unusable', () => {
    const store = openStore(':memory:');
    store.upsertOverride({
      kind: 'pin',
      accountId: 'B',
      session: 'synth-session-pin-dead',
      until: Date.now() + 60_000,
    });
    const A = anthropic('A', 10);
    const B = anthropic('B', 100);
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [A, B],
      store,
      session: 'synth-session-pin-dead',
    });
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.error, 'PINNED_UNAVAILABLE');
    if (decision.error !== 'PINNED_UNAVAILABLE') return;
    assert.equal(decision.accountId, 'B');
    assert.match(decision.reason, /pinned account unavailable/);
    store.close();
  });
});

describe('override reserve / drain-first / clear / list / expiry', () => {
  it('reserve excludes an account from automatic selection', () => {
    const store = openStore(':memory:');
    store.upsertOverride({
      kind: 'reserve',
      accountId: 'A',
      until: Date.now() + 60_000,
    });
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [anthropic('A', 10), anthropic('B', 40)],
      store,
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, 'B');
    store.close();
  });

  it('drain-first biases selection toward the marked account', () => {
    const store = openStore(':memory:');
    store.upsertOverride({
      kind: 'drain-first',
      accountId: 'B',
      until: Date.now() + 60_000,
    });
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [anthropic('A', 10), anthropic('B', 40)],
      store,
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, 'B');
    store.close();
  });

  it('list returns active overrides and clear removes them', () => {
    const store = openStore(':memory:');
    store.upsertOverride({
      kind: 'pin',
      accountId: 'A',
      session: 'synth-session-list',
      until: Date.now() + 60_000,
    });
    store.upsertOverride({
      kind: 'reserve',
      accountId: 'B',
      until: Date.now() + 60_000,
    });
    const listed = store.listActiveOverrides();
    assert.equal(listed.length, 2);
    const clearedSession = store.clearOverrides({ session: 'synth-session-list' });
    assert.equal(clearedSession, 1);
    assert.equal(store.listActiveOverrides().length, 1);
    const clearedAll = store.clearOverrides({ all: true });
    assert.equal(clearedAll, 1);
    assert.equal(store.listActiveOverrides().length, 0);
    store.close();
  });

  it('ignores an override whose --until is in the past', () => {
    const store = openStore(':memory:');
    store.upsertOverride({
      kind: 'pin',
      accountId: 'B',
      session: 'synth-session-expired',
      until: Date.now() - 1000,
    });
    store.upsertOverride({
      kind: 'reserve',
      accountId: 'A',
      until: Date.now() - 5000,
    });
    assert.equal(store.listActiveOverrides().length, 0);
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [anthropic('A', 10), anthropic('B', 70)],
      store,
      session: 'synth-session-expired',
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, 'A');
    assert.notEqual(decision.mode, 'pin');
    store.close();
  });
});
