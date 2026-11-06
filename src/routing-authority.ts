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
  return now - reading.fetchedAt <= PROVIDER_READING_MAX_AGE_MS;
}

/**
 * Routing may only use a complete, fresh direct provider measurement.
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
