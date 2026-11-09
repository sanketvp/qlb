import { relevantBuckets } from './scoring';
import { isProviderAuthoritativeReading } from './usage-freshness';
import type { AccountSnapshot, BucketReading } from './types';
export {
  classifyProviderPercentage,
  currentProviderObservation,
  failedProviderAttemptAfterReadings,
  isProviderAuthoritativeReading,
  PROVIDER_READING_MAX_AGE_MS,
} from './usage-freshness';
export type { ProviderPercentageClass } from './usage-freshness';

export interface RoutingAuthority {
  eligible: boolean;
  reason: string;
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
