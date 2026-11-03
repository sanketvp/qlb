// Read-only Anthropic usage projection shared by auto, status, and doctor.

import type { ClaudeSlot } from './cc-slots';
import type { UsagePollRow } from './store';
import type { AccountSnapshot, BucketReading, Confidence } from './types';

export const STALE_OK_S = 300;
export const TRUST_MAX_AGE_S = 3600;
export const RATE_LIMIT_TRUST_MAX_AGE_S = 7200;
const HARD_SENTINEL_STATUSES = new Set(['token-expired', 'foreign-credential', 'keychain-unavailable', 'no-credentials', 'relogin-needed']);

export function decisionTrusts(
  row: UsagePollRow | undefined,
  fetchedAt: number,
  snapshotResetAt: number | undefined,
  nowS: number,
): boolean {
  const ageS = nowS - fetchedAt / 1000;
  if (HARD_SENTINEL_STATUSES.has(row?.lastStatus ?? '')) return ageS <= 180;
  if (row?.lastStatus === 'http-429') {
    if (snapshotResetAt !== undefined && nowS * 1000 > snapshotResetAt) return false;
    if (ageS <= STALE_OK_S) return true;
    return ageS <= RATE_LIMIT_TRUST_MAX_AGE_S;
  }
  if (ageS <= STALE_OK_S) return true;
  if (!row || ageS > TRUST_MAX_AGE_S) return false;
  return row.consecutiveFailures > 0
    || (row.nextDueAt !== null && row.nextDueAt !== undefined && nowS < row.nextDueAt)
    || (row.heldUntil !== null && row.heldUntil !== undefined && nowS < row.heldUntil);
}

function earliestResetAt(snapshot: Record<string, BucketReading>): number | undefined {
  return Object.values(snapshot).reduce<number | undefined>((earliest, reading) =>
    reading.resetAt === undefined ? earliest : earliest === undefined ? reading.resetAt : Math.min(earliest, reading.resetAt), undefined);
}

/** Confidence for a retained reading; `unknown` means it must not be served. */
export function anthropicUsageConfidence(
  row: UsagePollRow | undefined,
  reading: BucketReading,
  snapshotResetAt: number | undefined,
  nowS: number,
): Confidence {
  if (!decisionTrusts(row, reading.fetchedAt, snapshotResetAt, nowS)) return 'unknown';
  return nowS - reading.fetchedAt / 1000 <= STALE_OK_S ? 'authoritative' : 'stale';
}

/**
 * Projects usable store readings without doing I/O. The optional predicate lets
 * auto restrict model-scoped windows while status keeps every recorded window.
 */
export function projectAnthropicUsageReadings(
  snapshot: Record<string, BucketReading>,
  row: UsagePollRow | undefined,
  nowS: number,
  include: (label: string) => boolean = () => true,
): Record<string, BucketReading> {
  const snapshotResetAt = earliestResetAt(snapshot);
  return Object.fromEntries(Object.entries(snapshot).flatMap(([label, reading]) => {
    if (!include(label)) return [];
    const confidence = anthropicUsageConfidence(row, reading, snapshotResetAt, nowS);
    return confidence === 'unknown' ? [] : [[label, { ...reading, confidence }]];
  }));
}

export interface AnthropicUsageStoreReader {
  listUsagePolls(provider: string): Record<string, UsagePollRow>;
  getAllSnapshots(accountId: string): Record<string, BucketReading>;
}

export interface AnthropicStoreSnapshots {
  hasPolls: boolean;
  snapshots: AccountSnapshot[];
}

/** Read-only status projection of QLB-owned slots and stored poll results. */
export function anthropicStoreSnapshots(
  slots: readonly ClaudeSlot[],
  store: AnthropicUsageStoreReader,
  nowS: number,
): AnthropicStoreSnapshots {
  const polls = store.listUsagePolls('anthropic');
  const hasPolls = Object.keys(polls).length > 0;
  if (!hasPolls) return { hasPolls, snapshots: [] };
  return {
    hasPolls,
    snapshots: slots.filter((slot) => slot.archivedAt == null).map((slot) => {
      const label = slot.email ?? slot.accountId;
      if (slot.dead) {
        return { accountId: slot.accountId, provider: 'anthropic', label, buckets: {}, error: 'token_dead' };
      }
      const buckets = projectAnthropicUsageReadings(
        store.getAllSnapshots(slot.accountId), polls[slot.accountId], nowS,
      );
      return Object.keys(buckets).length > 0
        ? { accountId: slot.accountId, provider: 'anthropic', label, buckets }
        : { accountId: slot.accountId, provider: 'anthropic', label, buckets: {}, error: 'unavailable' };
    }),
  };
}

/** Whether any persisted Anthropic poll has a currently usable reading. */
export function hasFreshAnthropicUsagePoll(store: AnthropicUsageStoreReader, nowS: number): boolean {
  const polls = store.listUsagePolls('anthropic');
  return Object.entries(polls).some(([accountId, row]) =>
    Object.keys(projectAnthropicUsageReadings(store.getAllSnapshots(accountId), row, nowS)).length > 0,
  );
}
