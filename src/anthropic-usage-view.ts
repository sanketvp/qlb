// Read-only Anthropic usage projection shared by auto, status, and doctor.

import { DatabaseSync } from 'node:sqlite';
import type { AccountSnapshot, BucketReading, Confidence } from './types';
import { STALE_OK_S } from './usage-freshness';
export { STALE_OK_S };
export const TRUST_MAX_AGE_S = 3600;
export const RATE_LIMIT_TRUST_MAX_AGE_S = 7200;
const QLB_USAGE_PHASES = new Set(['cutting-over', 'cutover', 'retired']);
const HARD_SENTINEL_STATUSES = new Set(['token-expired', 'foreign-credential', 'live-unattributed', 'keychain-unavailable', 'no-credentials', 'relogin-needed']);

/** The read-only slot fields required to render persisted Anthropic usage. */
export interface AnthropicUsageSlot {
  accountId: string;
  email?: string | null;
  dead?: boolean;
  archivedAt?: number | null;
}

/** The read-only poll fields required to decide whether a retained reading is usable. */
export interface AnthropicUsagePollRow {
  accountId: string;
  lastFetchAt: number | null;
  lastAttemptAt: number | null;
  nextDueAt: number | null;
  pollIntervalS: number | null;
  lastStatus: string | null;
  consecutiveFailures: number;
  backoffUntil: number | null;
  last429At: number | null;
  heldUntil: number | null;
}

/** QLB owns Anthropic usage only while its Claude cutover is active or retired. */
export function qlbOwnsAnthropicUsage(phase: string): boolean {
  return QLB_USAGE_PHASES.has(phase);
}

export function decisionTrusts(
  row: AnthropicUsagePollRow | undefined,
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
  row: AnthropicUsagePollRow | undefined,
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
  row: AnthropicUsagePollRow | undefined,
  nowS: number,
  include: (label: string) => boolean = () => true,
): Record<string, BucketReading> {
  const snapshotResetAt = earliestResetAt(snapshot);
  return Object.fromEntries(Object.entries(snapshot).flatMap(([label, reading]) => {
    if (reading.source !== 'poll' || !include(label)) return [];
    const confidence = anthropicUsageConfidence(row, reading, snapshotResetAt, nowS);
    return confidence === 'unknown' ? [] : [[label, { ...reading, confidence }]];
  }));
}

export interface AnthropicUsageStoreReader {
  listUsagePolls(provider: string): Record<string, AnthropicUsagePollRow>;
  getAllSnapshots(accountId: string): Record<string, BucketReading>;
}

export interface AnthropicStoreSnapshots {
  hasPolls: boolean;
  snapshots: AccountSnapshot[];
}

function hasPollsForLiveSlots(
  slots: readonly AnthropicUsageSlot[],
  polls: Record<string, AnthropicUsagePollRow>,
): boolean {
  return slots.some((slot) => slot.archivedAt == null && polls[slot.accountId] !== undefined);
}

/** Read-only status projection of QLB-owned slots and stored poll results. */
export function anthropicStoreSnapshots(
  slots: readonly AnthropicUsageSlot[],
  store: AnthropicUsageStoreReader,
  nowS: number,
): AnthropicStoreSnapshots {
  const liveSlots = slots.filter((slot) => slot.archivedAt == null);
  const polls = store.listUsagePolls('anthropic');
  const hasPolls = hasPollsForLiveSlots(slots, polls);
  if (liveSlots.length === 0) {
    return {
      hasPolls,
      snapshots: [{
        accountId: 'anthropic', provider: 'anthropic', label: 'Claude (Anthropic)', buckets: {}, error: 'unavailable',
      }],
    };
  }
  return {
    hasPolls,
    snapshots: liveSlots.map((slot) => {
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
export function hasFreshAnthropicUsagePoll(
  slots: readonly AnthropicUsageSlot[],
  store: AnthropicUsageStoreReader,
  nowS: number,
): boolean {
  const polls = store.listUsagePolls('anthropic');
  return slots.filter((slot) => slot.archivedAt == null).some((slot) => {
    const row = polls[slot.accountId];
    return row !== undefined
      && Object.keys(projectAnthropicUsageReadings(store.getAllSnapshots(slot.accountId), row, nowS)).length > 0;
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function readOnlyStoreData(dbPath: string): {
  slots: AnthropicUsageSlot[];
  polls: Record<string, AnthropicUsagePollRow>;
  snapshots: Map<string, Record<string, BucketReading>>;
} | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const pollRows = db.prepare(`SELECT account_id, last_fetch_at, last_attempt_at, next_due_at,
      poll_interval_s, last_status, consecutive_failures, backoff_until, last_429_at, held_until
      FROM usage_polls WHERE provider = 'anthropic'`).all() as Array<Record<string, unknown>>;
    const polls: Record<string, AnthropicUsagePollRow> = {};
    for (const row of pollRows) {
      const accountId = String(row.account_id);
      polls[accountId] = {
        accountId,
        lastFetchAt: numberOrNull(row.last_fetch_at), lastAttemptAt: numberOrNull(row.last_attempt_at),
        nextDueAt: numberOrNull(row.next_due_at), pollIntervalS: numberOrNull(row.poll_interval_s),
        lastStatus: typeof row.last_status === 'string' ? row.last_status : null,
        consecutiveFailures: typeof row.consecutive_failures === 'number' ? row.consecutive_failures : 0,
        backoffUntil: numberOrNull(row.backoff_until), last429At: numberOrNull(row.last_429_at), heldUntil: numberOrNull(row.held_until),
      };
    }
    const slots = db.prepare(`SELECT account_id, email, dead, archived_at
      FROM claude_slots`).all() as Array<Record<string, unknown>>;
    const snapshots = new Map<string, Record<string, BucketReading>>();
    const snapshotRows = db.prepare(`SELECT account_id, bucket, used_pct, used, limit_val, remaining,
      reset_at, fetched_at, source, confidence FROM snapshots WHERE source = 'poll'`).all() as Array<Record<string, unknown>>;
    for (const row of snapshotRows) {
      const accountId = String(row.account_id);
      const reading: BucketReading = {
        usedPct: numberOrNull(row.used_pct),
        source: (typeof row.source === 'string' ? row.source : 'poll') as BucketReading['source'],
        confidence: (typeof row.confidence === 'string' ? row.confidence : 'unknown') as Confidence,
        fetchedAt: numberOrNull(row.fetched_at) ?? 0,
      };
      if (typeof row.used === 'number') reading.used = row.used;
      if (typeof row.limit_val === 'number') reading.limit = row.limit_val;
      if (typeof row.remaining === 'number') reading.remaining = row.remaining;
      if (typeof row.reset_at === 'number') reading.resetAt = row.reset_at;
      const accountSnapshots = snapshots.get(accountId) ?? {};
      accountSnapshots[String(row.bucket)] = reading;
      snapshots.set(accountId, accountSnapshots);
    }
    return {
      slots: slots.map((row) => ({
        accountId: String(row.account_id),
        email: typeof row.email === 'string' ? row.email : null,
        dead: Number(row.dead) !== 0,
        archivedAt: numberOrNull(row.archived_at),
      })),
      polls,
      snapshots,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Reads the status projection through a SQLite read-only handle; it never migrates or scrubs. */
export function readAnthropicStoreSnapshots(dbPath: string, nowS: number): AnthropicStoreSnapshots | null {
  const data = readOnlyStoreData(dbPath);
  if (!data) return null;
  return anthropicStoreSnapshots(data.slots, {
    listUsagePolls: () => data.polls,
    getAllSnapshots: (accountId) => data.snapshots.get(accountId) ?? {},
  }, nowS);
}

/** Reads persisted poll freshness through a SQLite read-only handle. */
export function readAnthropicUsagePollFreshness(
  dbPath: string,
  nowS: number,
): { hasPolls: boolean; fresh: boolean } | null {
  const data = readOnlyStoreData(dbPath);
  if (!data) return null;
  const hasPolls = hasPollsForLiveSlots(data.slots, data.polls);
  return {
    hasPolls,
    fresh: hasFreshAnthropicUsagePoll(data.slots, {
      listUsagePolls: () => data.polls,
      getAllSnapshots: (accountId) => data.snapshots.get(accountId) ?? {},
    }, nowS),
  };
}
