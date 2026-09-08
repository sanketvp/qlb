import { randomUUID } from 'node:crypto';
import type { BucketReading } from './types';
import {
  getStore,
  isFresh,
  newestFetchedAt,
  type Store,
} from './store';

/** Per-process uuid; combined with a fresh opId per claim attempt (§4.3.3 v6). */
const PROCESS_UUID = randomUUID();

export const DEFAULT_POLL_CLAIM_TTL_MS = 10_000;

export function hardTimeoutMs(pollClaimTtlMs: number): number {
  return Math.max(pollClaimTtlMs - 2000, 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('poll hard timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function nonempty(
  buckets: Record<string, BucketReading>,
): Record<string, BucketReading> | null {
  return Object.keys(buckets).length > 0 ? buckets : null;
}

export interface SingleFlightOpts {
  store?: Store;
  pollClaimTtlMs?: number;
}

/**
 * Single-flight poll coalescing per spec §4.3.3 (v6, P1–P4 + Rule W).
 *
 * Caller is expected to have done P1 (plain cache read) and pass the
 * `fetched_at` it observed as `seenFetchedAt` (NULL when the cache was empty).
 *
 * Returns the fresh bucket map, or null if a wait timed out without fresh
 * data — caller should use whatever is already in the cache.
 */
export async function singleFlightFetch(
  accountId: string,
  seenFetchedAt: number | null,
  doFetch: () => Promise<Record<string, BucketReading>>,
  opts: SingleFlightOpts = {},
): Promise<Record<string, BucketReading> | null> {
  const store = opts.store ?? getStore();
  const ttl = opts.pollClaimTtlMs ?? DEFAULT_POLL_CLAIM_TTL_MS;
  const timeout = hardTimeoutMs(ttl);

  let passes = 0;
  while (passes < 2) {
    passes += 1;
    const opId = randomUUID();
    const me = `${PROCESS_UUID}:${opId}`;

    const outcome = store.claimPollOrFresh(accountId, me, ttl, seenFetchedAt);

    if (outcome === 'fresh') {
      return nonempty(store.getAllSnapshots(accountId));
    }

    if (outcome === 'acquired') {
      const claim = store.getPollClaim(accountId);
      const claimedAt = claim?.claimed_at ?? Date.now();
      try {
        const readings = await withTimeout(doFetch(), timeout);
        store.completePoll(accountId, me, claimedAt, readings);
        const cached = store.getAllSnapshots(accountId);
        return nonempty(cached) ?? nonempty(readings);
      } catch {
        store.releasePollClaim(accountId, me, claimedAt);
        return nonempty(store.getAllSnapshots(accountId));
      }
    }

    // P4: someone else holds the claim — wait for fresh(row) or claim gone/expired.
    const live = store.getPollClaim(accountId);
    const deadline = Math.min(live?.until ?? Date.now() + ttl, Date.now() + ttl);
    while (Date.now() < deadline) {
      await sleep(50);
      const cached = store.getAllSnapshots(accountId);
      if (isFresh(newestFetchedAt(cached), seenFetchedAt)) {
        return nonempty(cached);
      }
      const row = store.getPollClaim(accountId);
      if (!row || row.until <= Date.now()) break;
    }

    const cached = store.getAllSnapshots(accountId);
    if (isFresh(newestFetchedAt(cached), seenFetchedAt)) {
      return nonempty(cached);
    }
    // claim gone/expired without fresh data → second pass through P2
  }

  return nonempty(store.getAllSnapshots(accountId));
}

/**
 * Convenience for adapters: read cache → single-flight fetch → fall back to cache.
 */
export async function fetchAndCache(
  accountId: string,
  doFetch: () => Promise<Record<string, BucketReading>>,
  opts: SingleFlightOpts = {},
): Promise<Record<string, BucketReading> | null> {
  const store = opts.store ?? getStore();
  const cached = store.getAllSnapshots(accountId);
  const seen = newestFetchedAt(cached);
  const result = await singleFlightFetch(accountId, seen, doFetch, { ...opts, store });
  if (result) return result;
  return nonempty(cached);
}
