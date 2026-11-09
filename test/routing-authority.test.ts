import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountSnapshot, BucketReading } from '../src/types';
import { resolveFromSnapshots } from '../src/resolve';
import {
  classifyProviderPercentage,
  isProviderAuthoritativeReading,
} from '../src/routing-authority';
import { openStore } from '../src/store';
import { explainWhy } from '../src/why';

function direct(usedPct = 10): BucketReading {
  return {
    usedPct,
    source: 'provider-poll',
    confidence: 'authoritative',
    fetchedAt: Date.now(),
  };
}

function anthropic(id: string, reading: BucketReading, extra: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    accountId: id,
    provider: 'anthropic',
    label: id,
    buckets: { '5h': reading, '7d': { ...reading } },
    ...extra,
  };
}

function codex(id: string, reading: BucketReading): AccountSnapshot {
  return {
    accountId: id,
    provider: 'openai-codex',
    label: id,
    buckets: { primary: reading, secondary: { ...reading } },
  };
}

describe('provider routing authority', () => {
  for (const [name, snapshot] of [
    ['cache/import/rollout source', anthropic('cache', { ...direct(), source: 'poll' })],
    ['ordinary cache headers', anthropic('headers', { ...direct(), source: 'headers' })],
    ['advisory reading', anthropic('advisory', { ...direct(), confidence: 'advisory' })],
    ['unknown reading', anthropic('unknown', { ...direct(), confidence: 'unknown' })],
    ['stale reading', anthropic('stale', { ...direct(), confidence: 'stale' })],
    ['expired provider receipt', anthropic('expired', { ...direct(), fetchedAt: Date.now() - 300_001 })],
    ['synthetic source', anthropic('synthetic', { ...direct(), source: 'error' })],
    ['failed-probe fallback', anthropic('failed', direct(), { probe: { outcome: 'cached-after-failure' } })],
  ] as const) {
    it(`resolve and why reject ${name}`, () => {
      const decision = resolveFromSnapshots({ model: 'claude-sonnet-5', snapshots: [snapshot] });
      assert.equal(decision.ok, false);
      if (decision.ok) return;
      assert.equal(decision.error, 'UNAVAILABLE');
      assert.match(decision.reason, /fresh Anthropic provider quota reading required/);
      const report = explainWhy({ model: 'claude-sonnet-5', snapshots: [snapshot] });
      assert.equal(report.accountId, null);
      assert.equal(report.error, 'UNAVAILABLE');
      assert.match(report.losers[0]?.detail ?? '', /non-actionable/);
    });
  }

  it('routes fresh direct provider readings and reserves EXHAUSTED for direct evidence', () => {
    const available = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [anthropic('fresh', direct(10))],
    });
    assert.equal(available.ok, true);

    const exhausted = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [anthropic('exhausted', direct(100))],
    });
    assert.equal(exhausted.ok, false);
    if (exhausted.ok) return;
    assert.equal(exhausted.error, 'EXHAUSTED');
  });

  it('does not declare a mixed pool exhausted', () => {
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [
        anthropic('exhausted', direct(100)),
        anthropic('unmeasured', { ...direct(10), source: 'poll' }),
      ],
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.error, 'UNAVAILABLE');
  });

  it('names the unmeasured fallback pool', () => {
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      fallback: ['grok-4'],
      snapshots: [
        anthropic('exhausted', direct(100)),
        {
          accountId: 'xai', provider: 'xai', label: 'xAI',
          buckets: {
            tokens: { ...direct(10), source: 'headers', confidence: 'advisory' },
            requests: { ...direct(10), source: 'headers', confidence: 'advisory' },
          },
        },
      ],
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.error, 'UNAVAILABLE');
      assert.match(decision.reason, /xai grok-4 pool requires a fresh provider reading/);
    }
  });

  it('uses a measured fallback without borrowing an unmeasured primary reading', () => {
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      fallback: ['gpt-5.4'],
      snapshots: [
        anthropic('stale-anthropic', { ...direct(), fetchedAt: Date.now() - 300_001 }),
        codex('fresh-codex', direct()),
      ],
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.provider, 'openai-codex');
    assert.equal(decision.accountId, 'fresh-codex');
    assert.equal(decision.mode, 'fallback');
  });

  it('rejects an unmeasured fallback after an unmeasured primary', () => {
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      fallback: ['gpt-5.4'],
      snapshots: [
        anthropic('stale-anthropic', { ...direct(), fetchedAt: Date.now() - 300_001 }),
        codex('stale-codex', { ...direct(), fetchedAt: Date.now() - 300_001 }),
      ],
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.error, 'UNAVAILABLE');
  });

  it('keeps pins and round-robin inside eligible provider readings', () => {
    const store = openStore(':memory:');
    try {
      const cached = anthropic('cached', { ...direct(1), source: 'poll' });
      const fresh = anthropic('fresh', direct(60));
      store.upsertOverride({ kind: 'pin', accountId: 'cached', session: 'authority-pin', until: Date.now() + 60_000 });
      const pin = resolveFromSnapshots({
        model: 'claude-sonnet-5',
        session: 'authority-pin',
        snapshots: [cached, fresh],
        store,
      });
      assert.equal(pin.ok, false);
      if (!pin.ok) assert.equal(pin.error, 'PINNED_UNAVAILABLE');

      const roundRobin = resolveFromSnapshots({
        model: 'claude-sonnet-5',
        strategy: 'round-robin',
        snapshots: [cached, fresh],
        store,
      });
      assert.equal(roundRobin.ok, true);
      if (roundRobin.ok) assert.equal(roundRobin.accountId, 'fresh');
    } finally {
      store.close();
    }
  });

  it('why retains cached evidence but labels it non-actionable', () => {
    const report = explainWhy({
      model: 'claude-sonnet-5',
      snapshots: [anthropic('cached', { ...direct(), source: 'poll' })],
    });
    assert.equal(report.accountId, null);
    assert.equal(report.error, 'UNAVAILABLE');
    assert.match(report.losers[0]?.detail ?? '', /non-actionable/);
  });
});

describe('provider percentage classification',
  () => {
    it('maps absent, usable, exhausted, and malformed values',
      () => {
        assert.equal(classifyProviderPercentage(null), 'absent');
        assert.equal(classifyProviderPercentage(undefined), 'absent');
        assert.equal(classifyProviderPercentage(0), 'usable');
        assert.equal(classifyProviderPercentage(99.9), 'usable');
        assert.equal(classifyProviderPercentage(100), 'exhausted');
        assert.equal(classifyProviderPercentage(101), 'exhausted');
        assert.equal(classifyProviderPercentage(-1), 'malformed');
        assert.equal(classifyProviderPercentage(Number.NaN), 'malformed');
        assert.equal(classifyProviderPercentage(Number.POSITIVE_INFINITY), 'malformed');
      });

    it('treats overspend as authoritative exhausted and malformed as unavailable',
      () => {
        const now = Date.now();
        assert.equal(isProviderAuthoritativeReading(direct(101)), true);
        assert.equal(isProviderAuthoritativeReading(direct(100)), true);
        assert.equal(isProviderAuthoritativeReading(direct(-1)), false);
        assert.equal(isProviderAuthoritativeReading({ ...direct(), usedPct: Number.NaN }), false);
        assert.equal(isProviderAuthoritativeReading({ ...direct(), usedPct: null }), false);
        assert.equal(isProviderAuthoritativeReading({ ...direct(), fetchedAt: now - 300_001 }, now), false);

        const overspend = resolveFromSnapshots({
          model: 'claude-sonnet-5',
          snapshots: [anthropic('overspend', direct(101))],
        });
        assert.equal(overspend.ok, false);
        if (!overspend.ok) assert.equal(overspend.error, 'EXHAUSTED');

        const malformed = resolveFromSnapshots({
          model: 'claude-sonnet-5',
          snapshots: [anthropic('malformed', direct(-1))],
        });
        assert.equal(malformed.ok, false);
        if (!malformed.ok) assert.equal(malformed.error, 'UNAVAILABLE');
      });
  });
