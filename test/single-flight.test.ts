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
});
