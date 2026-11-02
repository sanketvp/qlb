// Scheduled Claude usage collection for the automatic-switch loop.

import {
  extractAccessToken,
  isOAuthTokenExpired,
  parseCredentialBlob,
  parseUsageResponse,
  type ParsedUsageResponse,
} from '../anthropic-oauth';
import { consumeClaudeSlot, type ConsumeGateDeps } from '../cc-consume';
import {
  fetchActiveUsage,
  resyncHook,
  type FetchActiveUsageDeps,
  type ResyncRotatedBackupDeps,
} from '../cc-resync';
import { ClaudeSlots } from '../cc-slots';
import { type AutoswitchAccount } from '../autoswitch';
import { dueCandidate, planAfterFetch, SERVE_TTL_S, type Usage } from '../poll-policy';
import { redactSecrets } from '../redact';
import { Store, type UsagePollRow } from '../store';
import type { BucketReading } from '../types';

const PROVIDER = 'anthropic';

export interface AnthropicPollDeps {
  store: Store;
  slots: ClaudeSlots;
  /** Epoch seconds, matching `usage_polls` and poll-policy. */
  now: () => number;
  /** Kept injectable because jitter must be deterministic in collector tests. */
  rng?: () => number;
  /** Scoped model names; no writer exists yet, so the production caller supplies none. */
  models?: readonly string[];
  fetchActiveDeps: Omit<FetchActiveUsageDeps, 'slots' | 'store' | 'getUsage' | 'afterAcceptedUsage'>;
  /** The active-fetch memo is deliberately shared with this resync hook. */
  resyncDeps: Omit<ResyncRotatedBackupDeps, 'slots' | 'store' | 'verdicts'>;
  consumeDeps: Omit<ConsumeGateDeps, 'slots' | 'now'>;
  getUsage: FetchActiveUsageDeps['getUsage'];
}

function statusFor(record: { error?: string; sentinel?: string }): string {
  return redactSecrets(record.error ?? record.sentinel ?? 'usage-unknown', []);
}

function readUsage(readings: Record<string, BucketReading>): Usage | null {
  const usage: Record<string, unknown> = {};
  const scoped: Array<Record<string, unknown>> = [];
  for (const [label, reading] of Object.entries(readings)) {
    if (typeof reading.usedPct !== 'number') continue;
    const resetsAt = typeof reading.resetAt === 'number' ? new Date(reading.resetAt).toISOString() : undefined;
    if (label === '5h') usage.five_hour = { pct: reading.usedPct, ...(resetsAt ? { resets_at: resetsAt } : {}) };
    else if (label === '7d') usage.seven_day = { pct: reading.usedPct, ...(resetsAt ? { resets_at: resetsAt } : {}) };
    else if (label.startsWith('7d:')) scoped.push({ name: label.slice(3), pct: reading.usedPct, ...(resetsAt ? { resets_at: resetsAt } : {}) });
  }
  if (scoped.length > 0) usage.scoped = scoped;
  return Object.keys(usage).length > 0 ? usage : null;
}

function parsedUsage(parsed: ParsedUsageResponse): Usage {
  const usage: Record<string, unknown> = {};
  const scoped: Array<Record<string, unknown>> = [];
  for (const [label, bucket] of Object.entries(parsed.buckets)) {
    const value = { pct: bucket.usedPct, ...(bucket.resetsAt ? { resets_at: bucket.resetsAt } : {}) };
    if (label === '5h') usage.five_hour = value;
    else if (label === '7d') usage.seven_day = value;
    else if (label.startsWith('7d:')) scoped.push({ name: label.slice(3), ...value });
  }
  if (scoped.length > 0) usage.scoped = scoped;
  return usage;
}

function readingsFrom(parsed: ParsedUsageResponse, nowS: number): Record<string, BucketReading> {
  const fetchedAt = nowS * 1000;
  return Object.fromEntries(Object.entries(parsed.buckets).map(([label, bucket]) => {
    const resetAt = bucket.resetsAt === undefined ? undefined : Date.parse(bucket.resetsAt);
    return [label, {
      usedPct: bucket.usedPct,
      ...(Number.isFinite(resetAt) ? { resetAt } : {}),
      fetchedAt,
      source: 'poll' as const,
      confidence: 'authoritative' as const,
    }];
  }));
}

function due(accountId: string, polls: Record<string, UsagePollRow>, nowS: number): boolean {
  return dueCandidate([accountId], polls, nowS) === accountId;
}

function recent429(row: UsagePollRow | undefined, nowS: number): boolean {
  return row?.last429At !== null && row?.last429At !== undefined && nowS - row.last429At <= 3600;
}

function freshAccounts(slots: ReturnType<ClaudeSlots['listSlots']>, store: Store, nowS: number): AutoswitchAccount[] {
  const oldest = (nowS - SERVE_TTL_S) * 1000;
  return slots.filter((slot) => slot.archivedAt == null).map((slot) => {
    const buckets = Object.fromEntries(Object.entries(store.getAllSnapshots(slot.accountId))
      .filter(([, reading]) => reading.fetchedAt >= oldest)
      .map(([label, reading]) => [label, { usedPct: reading.usedPct, ...(reading.resetAt === undefined ? {} : { resetAt: reading.resetAt }) }]));
    return {
      accountId: slot.accountId, buckets, dead: slot.dead,
      ...(slot.threshold == null ? {} : { threshold: slot.threshold }),
      ...(slot.slotNum == null ? {} : { slotNum: slot.slotNum }),
      addedAtMs: slot.addedAt,
    };
  });
}

/**
 * Poll the scheduled active Claude slot and at most one scheduled inactive slot.
 * A due failure records unknown state but deliberately leaves the prior snapshot
 * intact for the policy's 180-second serving window.
 */
export async function pollAnthropic(deps: AnthropicPollDeps): Promise<AutoswitchAccount[]> {
  const nowS = deps.now();
  const slots = deps.slots.listSlots().filter((slot) => slot.archivedAt == null);
  const activeId = deps.store.getActiveLogin(PROVIDER)?.accountId ?? null;
  const polls = deps.store.listUsagePolls(PROVIDER);
  const settings = deps.store.getAutoswitchSettings();
  const models = deps.models ?? [];

  const record = (accountId: string, previous: Usage | null, next: Usage | null, success: Record<string, BucketReading> | undefined, status: string, isActive: boolean, http429 = false): void => {
    deps.store.recordUsagePollResult(PROVIDER, accountId, {
      attemptedAt: nowS, status: redactSecrets(status, []), readings: success, http429,
    });
    const prior = polls[accountId];
    const threshold = slots.find((slot) => slot.accountId === accountId)?.threshold ?? settings.threshold;
    const [nextDueAt, pollIntervalS] = planAfterFetch({
      prevIntervalS: prior?.pollIntervalS, prevUsage: previous, newUsage: next,
      isActive, threshold, weeklyThreshold: settings.weeklyThreshold, models,
      recent429: http429 || recent429(prior, nowS), now: nowS, rng: deps.rng,
    });
    deps.store.writeUsagePollPlans(PROVIDER, { [accountId]: { nextDueAt, pollIntervalS } });
  };

  const active = activeId === null ? null : slots.find((slot) => slot.accountId === activeId) ?? null;
  if (active && due(active.accountId, polls, nowS)) {
    let current: Awaited<ReturnType<ClaudeSlots['readSlot']>> | null = null;
    try { current = await deps.slots.readSlot(active.accountId, { fresh: true }); } catch { /* unknown below */ }
    const previous = readUsage(deps.store.getAllSnapshots(active.accountId));
    if (!current) record(active.accountId, previous, null, undefined, 'slot-unreadable', true);
    else {
      const result = await fetchActiveUsage({
        ...deps.fetchActiveDeps, slots: deps.slots, store: deps.store, getUsage: deps.getUsage,
        afterAcceptedUsage: resyncHook({ ...deps.resyncDeps, slots: deps.slots, store: deps.store, verdicts: deps.fetchActiveDeps.verdicts }),
      }, { accountId: active.accountId, email: active.email ?? '', orgUuid: active.orgUuid ?? '', creds: current.credential, degraded: false });
      if (result.usage && typeof result.usage === 'object' && 'buckets' in result.usage) {
        const parsed = result.usage as ParsedUsageResponse;
        const readings = readingsFrom(parsed, nowS);
        record(active.accountId, previous, parsedUsage(parsed), readings, 'ok', true);
      } else record(active.accountId, previous, null, undefined, statusFor(result), true, result.error === 'http-429');
    }
  }

  const inactiveIds = slots.filter((slot) => !slot.dead && slot.accountId !== activeId).map((slot) => slot.accountId);
  const inactiveId = dueCandidate(inactiveIds, polls, nowS);
  if (inactiveId) {
    const previous = readUsage(deps.store.getAllSnapshots(inactiveId));
    let credential: string | null = null;
    try { credential = (await deps.slots.readSlot(inactiveId, { fresh: true })).credential; } catch { /* unknown below */ }
    if (!credential) record(inactiveId, previous, null, undefined, 'slot-unreadable', false);
    else {
      const expiresAt = parseCredentialBlob(credential)?.oauth?.expiresAt;
      if (isOAuthTokenExpired(expiresAt, nowS * 1000)) {
        const consumed = await consumeClaudeSlot({ ...deps.consumeDeps, slots: deps.slots, now: () => nowS * 1000 }, { accountId: inactiveId, snapshot: credential });
        credential = consumed.credential ?? null;
        if (!credential) {
          record(inactiveId, previous, null, undefined, `consume-${consumed.kind}`, false);
        }
      }
      if (credential) {
        const accessToken = extractAccessToken(credential);
        if (!accessToken) record(inactiveId, previous, null, undefined, 'no-credentials', false);
        else {
          let response: Awaited<ReturnType<AnthropicPollDeps['getUsage']>> | null = null;
          try { response = await deps.getUsage(accessToken); } catch { /* unknown below */ }
          if (!response) record(inactiveId, previous, null, undefined, 'usage-fetch-failed', false);
          else if (response.status < 200 || response.status >= 300) record(inactiveId, previous, null, undefined, `http-${response.status}`, false, response.status === 429);
          else {
            try {
              const parsed = parseUsageResponse(JSON.parse(response.body));
              record(inactiveId, previous, parsedUsage(parsed), readingsFrom(parsed, nowS), 'ok', false);
            } catch { record(inactiveId, previous, null, undefined, 'usage-unreadable', false); }
          }
        }
      }
    }
  }
  return freshAccounts(slots, deps.store, nowS);
}
