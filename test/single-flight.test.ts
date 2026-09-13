import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BucketReading } from '../src/types';
import { openStore } from '../src/store';
import { singleFlightFetch } from '../src/single-flight';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reading(usedPct: number): BucketReading {
  return {
    usedPct,
    source: 'poll',
    confidence: 'authoritative',
    fetchedAt: Date.now(),
  };
}

describe('single-flight poll coalescing', () => {
  it('N concurrent calls for the same account issue exactly 1 real fetch', async () => {
    const store = openStore(':memory:');
    let fetches = 0;
    const doFetch = async (): Promise<Record<string, BucketReading>> => {
      fetches += 1;
      await sleep(150);
      return { '5h': reading(12), '7d': reading(30) };
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        singleFlightFetch('acct-1', null, doFetch, { store, pollClaimTtlMs: 10_000 }),
      ),
    );

    assert.equal(fetches, 1, `expected 1 fetch, got ${fetches}`);
    assert.equal(results.length, 8);
    for (const r of results) {
      assert.ok(r, 'every waiter should receive buckets');
      assert.equal(r!['5h']?.usedPct, 12);
      assert.equal(r!['7d']?.usedPct, 30);
    }
    assert.equal(store.getPollClaim('acct-1'), null, 'claim must be released');
    store.close();
  });

  it('empty-cache waiters resolve on the first populated reading (fresh NULL-safe)', async () => {
    const store = openStore(':memory:');
    let fetches = 0;
    const doFetch = async (): Promise<Record<string, BucketReading>> => {
      fetches += 1;
      await sleep(80);
      return { weekly: reading(62) };
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        singleFlightFetch('kimi-default', null, doFetch, { store, pollClaimTtlMs: 10_000 }),
      ),
    );

    assert.equal(fetches, 1);
    assert.ok(results.every((r) => r && r.weekly?.usedPct === 62));
    store.close();
  });

  it('onOutcome fetched on successful acquire', async () => {
    const store = openStore(':memory:');
    const outcomes: string[] = [];
    const result = await singleFlightFetch(
      'acct-fetch',
      null,
      async () => ({ '5h': reading(4) }),
      {
        store,
        onOutcome(o) {
          outcomes.push(o);
        },
      },
    );
    assert.equal(result?.['5h']?.usedPct, 4);
    assert.deepEqual(outcomes, ['fetched']);
    store.close();
  });

  it('onOutcome cached-after-failure inside TTL with rejected doFetch returns unchanged cache', async () => {
    const store = openStore(':memory:');
    store.upsertAccount('acct-ttl', 'anthropic', 'acct-ttl');
    const cached = reading(33);
    store.upsertSnapshot('acct-ttl', '5h', cached);
    const outcomes: Array<{ o: string; d?: string }> = [];
    const result = await singleFlightFetch(
      'acct-ttl',
      cached.fetchedAt,
      async () => {
        throw new Error('probe-down');
      },
      {
        store,
        pollClaimTtlMs: 10_000,
        onOutcome(o, d) {
          outcomes.push({ o, d });
        },
      },
    );
    assert.equal(result?.['5h']?.usedPct, 33);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.o, 'cached-after-failure');
    assert.match(outcomes[0]?.d ?? '', /probe-down/);
    store.close();
  });

  it('onOutcome cached-after-failure outside TTL with rejected doFetch', async () => {
    const store = openStore(':memory:');
    store.upsertAccount('acct-old', 'anthropic', 'acct-old');
    store.upsertSnapshot('acct-old', '5h', {
      usedPct: 8,
      source: 'poll',
      confidence: 'authoritative',
      fetchedAt: Date.now() - 60_000,
    });
    const outcomes: string[] = [];
    const result = await singleFlightFetch(
      'acct-old',
      Date.now() - 60_000,
      async () => {
        throw new Error('expired-probe');
      },
      {
        store,
        pollClaimTtlMs: 50,
        onOutcome(o) {
          outcomes.push(o);
        },
      },
    );
    assert.equal(result?.['5h']?.usedPct, 8);
    assert.ok(outcomes.includes('cached-after-failure'));
    store.close();
  });

  it('onOutcome coalesced when another holder wrote fresh', async () => {
    const store = openStore(':memory:');
    const outcomes: string[] = [];
    let fetches = 0;
    const doFetch = async (): Promise<Record<string, BucketReading>> => {
      fetches += 1;
      await sleep(80);
      return { weekly: reading(50) };
    };
    const opts = {
      store,
      pollClaimTtlMs: 10_000,
      onOutcome(o: 'fetched' | 'coalesced' | 'cached-after-failure') {
        outcomes.push(o);
      },
    };
    await Promise.all([
      singleFlightFetch('acct-coal', null, doFetch, opts),
      singleFlightFetch('acct-coal', null, doFetch, opts),
    ]);
    assert.equal(fetches, 1);
    assert.ok(outcomes.includes('fetched'));
    assert.ok(outcomes.includes('coalesced'));
    store.close();
  });
});
