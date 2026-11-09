import type { BucketReading } from './types';

export const STALE_OK_S = 300;

/** A provider receipt remains actionable for five minutes. */
export const PROVIDER_READING_MAX_AGE_MS = 5 * 60 * 1000;

export type ProviderPercentageClass = 'absent' | 'usable' | 'exhausted' | 'malformed';

/** Classify a provider-reported percentage without inferring one from other fields. */
export function classifyProviderPercentage(usedPct: number | null | undefined): ProviderPercentageClass {
  if (usedPct == null) return 'absent';
  if (!Number.isFinite(usedPct) || usedPct < 0) return 'malformed';
  return usedPct >= 100 ? 'exhausted' : 'usable';
}

export function isProviderAuthoritativeReading(
  reading: BucketReading | undefined,
  now = Date.now(),
): boolean {
  if (!reading) return false;
  const classification = classifyProviderPercentage(reading.usedPct);
  if (classification !== 'usable' && classification !== 'exhausted') return false;
  if (reading.confidence !== 'authoritative') return false;
  if (reading.source !== 'provider-poll' && reading.source !== 'provider-headers') return false;
  if (!Number.isFinite(reading.fetchedAt) || reading.fetchedAt > now) return false;
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
