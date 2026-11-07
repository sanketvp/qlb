import { relevantBuckets } from './scoring';
import type { AccountSnapshot, BucketReading } from './types';

/** A provider receipt remains actionable for five minutes. */
export const PROVIDER_READING_MAX_AGE_MS = 5 * 60 * 1000;

export interface RoutingAuthority {
  eligible: boolean;
  reason: string;
}

export function isProviderAuthoritativeReading(
  reading: BucketReading | undefined,
  now = Date.now(),
): boolean {
  if (!reading || reading.usedPct == null || !Number.isFinite(reading.usedPct)) return false;
  if (reading.confidence !== 'authoritative') return false;
  if (reading.source !== 'provider-poll' && reading.source !== 'provider-headers') return false;
  if (!Number.isFinite(reading.fetchedAt) || reading.fetchedAt > now) return false;
  if (reading.resetAt !== undefined && reading.resetAt <= now) return false;
  return now - reading.fetchedAt <= PROVIDER_READING_MAX_AGE_MS;
}

export function currentProviderObservation(buckets: Record<string, BucketReading>): Record<string, BucketReading> {
  const newest = Math.max(...Object.values(buckets)
    .filter((reading) => reading.confidence === 'authoritative'
      && reading.source === 'provider-poll')
    .map((reading) => reading.fetchedAt));
  if (!Number.isFinite(newest)) return buckets;
  return Object.fromEntries(Object.entries(buckets).filter(([, reading]) =>
    reading.confidence !== 'authoritative'
    || reading.source !== 'provider-poll'
    || reading.fetchedAt >= newest,
  ));
}

export function failedProviderAttemptAfterReadings(
  buckets: Record<string, BucketReading>,
  poll: { lastAttemptAt: number | null; lastStatus: string | null } | undefined,
): boolean {
  if (!poll || poll.lastAttemptAt == null || poll.lastStatus === 'ok' || poll.lastStatus === 'codex-won') return false;
  const newestReading = Math.max(...Object.values(buckets)
    .filter((reading) => reading.confidence === 'authoritative'
      && (reading.source === 'provider-poll' || reading.source === 'provider-headers'))
    .map((reading) => reading.fetchedAt));
  return Number.isFinite(newestReading) && poll.lastAttemptAt >= Math.floor(newestReading / 1000);
}

/**
 * Routing may only use a fresh direct provider measurement for each available relevant bucket.
 * This leaves cached rows intact for status, export, and cross-check display.
 */
export function routingAuthority(
  snapshot: AccountSnapshot,
  model: string,
  now = Date.now(),
): RoutingAuthority {
  if (snapshot.error || snapshot.failed) return { eligible: false, reason: 'provider probe failed' };
  if (snapshot.probe?.outcome === 'cached-after-failure') {
    return { eligible: false, reason: 'cached after failed provider probe' };
  }
  const buckets = relevantBuckets(snapshot, model);
  let found = false;
  for (const bucket of buckets) {
    const reading = snapshot.buckets[bucket];
    if (!reading) continue;
    found = true;
    if (!isProviderAuthoritativeReading(reading, now)) {
      return { eligible: false, reason: `non-actionable ${bucket} reading` };
    }
  }
  return found
    ? { eligible: true, reason: 'fresh direct provider reading' }
    : { eligible: false, reason: 'provider quota buckets unavailable' };
}
