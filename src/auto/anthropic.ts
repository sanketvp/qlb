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
  credentialLineage,
  fetchActiveUsage,
  resyncHook,
  type FetchActiveUsageDeps,
  type ResyncRotatedBackupDeps,
} from '../cc-resync';
import { readLiveClaudeCredentials } from '../cc-credentials';
import { isCredentialNotFound } from '../credential-backends';
import { ClaudeSlots } from '../cc-slots';
import { decideAutoswitch, type AutoswitchAccount, type AutoswitchDecision, type AutoswitchInput } from '../autoswitch';
import { switchClaude, type ClaudeSwitchDeps, type ClaudeSwitchResult } from '../cc-switch';
import { dueCandidate, planAfterFetch, RECENT_429_WINDOW_S, type Usage } from '../poll-policy';
import { redactSecrets } from '../redact';
import { Store, type UsagePollRow } from '../store';
import { projectAnthropicUsageReadings } from '../anthropic-usage-view';
import type { BucketReading } from '../types';

const PROVIDER = 'anthropic';

export interface AnthropicPollDeps {
  store: Store;
  slots: ClaudeSlots;
  /** Epoch seconds, matching `usage_polls` and poll-policy. */
  now: () => number;
  /** Kept injectable because jitter must be deterministic in collector tests. */
  rng?: () => number;
  /** Scoped model names passed from the production live binding's configured scope. */
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
  return row?.last429At !== null && row?.last429At !== undefined && nowS - row.last429At <= RECENT_429_WINDOW_S;
}

/** The slot's live dead flag supersedes a legacy sticky poll status. */
function pollingState(slots: ReturnType<ClaudeSlots['listSlots']>, polls: Record<string, UsagePollRow>): Record<string, UsagePollRow> {
  const liveIds = new Set(slots.filter((slot) => !slot.dead).map((slot) => slot.accountId));
  return Object.fromEntries(Object.entries(polls).map(([accountId, row]) => [accountId,
    liveIds.has(accountId) && row.lastStatus === 'token_dead' ? { ...row, lastStatus: null } : row,
  ]));
}

export function freshAnthropicAccounts(slots: ReturnType<ClaudeSlots['listSlots']>, store: Store, polls: Record<string, UsagePollRow>, nowS: number, models: readonly string[]): AutoswitchAccount[] {
  const configuredModels = new Set(models.map((model) => model.toLowerCase()));
  const scopedEnabled = configuredModels.size > 0;
  const allScoped = configuredModels.has('all');
  return slots.filter((slot) => slot.archivedAt == null).map((slot) => {
    const row = polls[slot.accountId];
    const snapshot = store.getAllSnapshots(slot.accountId);
    const trusted = projectAnthropicUsageReadings(
      snapshot, row, nowS,
      (label) => !label.startsWith('7d:') || (scopedEnabled && (allScoped || configuredModels.has(label.slice(3).toLowerCase()))),
    );
    const buckets = Object.fromEntries(Object.entries(trusted).map(([label, reading]) => [label, {
      usedPct: reading.usedPct,
      ...(reading.resetAt === undefined ? {} : { resetAt: reading.resetAt }),
    }]));
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
 * A due failure records unknown state and leaves the prior snapshot subject to
 * the resulting status's serving policy.
 */
export async function pollAnthropic(deps: AnthropicPollDeps): Promise<AutoswitchAccount[]> {
  const nowS = deps.now();
  const slots = deps.slots.listSlots().filter((slot) => slot.archivedAt == null);
  const activeId = deps.store.getActiveLogin(PROVIDER)?.accountId ?? null;
  const polls = pollingState(slots, deps.store.listUsagePolls(PROVIDER));
  const settings = deps.store.getAutoswitchSettings();
  const models = deps.models ?? [];

  const record = (accountId: string, previous: Usage | null, next: Usage | null, success: Record<string, BucketReading> | undefined, status: string, isActive: boolean, http429 = false, retryAfterS?: number): void => {
    deps.store.recordUsagePollResult(PROVIDER, accountId, {
      attemptedAt: nowS, status: redactSecrets(status, []), readings: success, http429, retryAfterS,
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
  if (active && !active.dead && due(active.accountId, polls, nowS)) {
    let current: Awaited<ReturnType<ClaudeSlots['readSlot']>> | null = null;
    try { current = await deps.slots.readSlot(active.accountId, { fresh: true }); } catch { /* unknown below */ }
    const previous = readUsage(deps.store.getAllSnapshots(active.accountId));
    if (!current) record(active.accountId, previous, null, undefined, 'slot-unreadable', true);
    else {
      let creds = current.credential;
      let degraded = false;
      try {
        creds = await readLiveClaudeCredentials({ ...deps.fetchActiveDeps.live, env: deps.fetchActiveDeps.live.env ?? deps.fetchActiveDeps.env });
      } catch {
        // The slot is only a degraded fallback; do not run the resync hook on it.
        degraded = true;
      }
      const result = await fetchActiveUsage({
        ...deps.fetchActiveDeps, slots: deps.slots, store: deps.store, getUsage: deps.getUsage,
        afterAcceptedUsage: resyncHook({ ...deps.resyncDeps, slots: deps.slots, store: deps.store, verdicts: deps.fetchActiveDeps.verdicts }),
      }, { accountId: active.accountId, email: active.email ?? '', orgUuid: active.orgUuid ?? '', creds, degraded });
      // A switch can commit while the usage request is in flight. The reading
      // has no safe owner then, so leave both accounts' poll rows untouched.
      if (deps.store.getActiveLogin(PROVIDER)?.accountId !== activeId) {
        return freshAnthropicAccounts(deps.slots.listSlots(), deps.store, pollingState(deps.slots.listSlots(), deps.store.listUsagePolls(PROVIDER)), nowS, models);
      }
      if (result.usage && typeof result.usage === 'object' && 'buckets' in result.usage) {
        const lineage = result.servedLineage ?? null;
        // The accepted-usage hook can adopt a same-account live rotation, so
        // read the slot after it returns and attribute the credential that
        // actually served usage rather than the pre-fetch live read.
        const activeAfterFetch = deps.slots.getSlot(active.accountId);
        const attributed = (lineage !== null && (lineage === activeAfterFetch?.fingerprint || lineage === activeAfterFetch?.prevFingerprint))
          || (lineage !== null && deps.fetchActiveDeps.verdicts.get(active.accountId, active.email ?? '', lineage, active.orgUuid ?? '')?.match === true);
        if (!attributed) {
          record(active.accountId, previous, null, undefined, 'live-unattributed', true);
        } else {
          const parsed = result.usage as ParsedUsageResponse;
          const readings = readingsFrom(parsed, nowS);
          record(active.accountId, previous, parsedUsage(parsed), readings, 'ok', true);
        }
      } else record(active.accountId, previous, null, undefined, statusFor(result), true, result.error === 'http-429', result.retryAfterS);
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
      let skipped = false;
      const expiresAt = parseCredentialBlob(credential)?.oauth?.expiresAt;
      if (isOAuthTokenExpired(expiresAt, nowS * 1000)) {
        // The active row and Claude Code's live lineage can change between the
        // candidate selection above and a refresh POST. Re-check both at spend time.
        const activeNow = deps.store.getActiveLogin(PROVIDER)?.accountId ?? null;
        let live: string | null = null;
        let liveUnreadable = false;
        try { live = await readLiveClaudeCredentials({ ...deps.fetchActiveDeps.live, env: deps.fetchActiveDeps.live.env ?? deps.fetchActiveDeps.env }); } catch (error) { liveUnreadable = !isCredentialNotFound(error); }
        if (activeNow === null || activeNow === inactiveId || liveUnreadable || (live !== null && credentialLineage(live) === credentialLineage(credential))) {
          // Yield this candidate so another inactive account can be polled.
          deps.store.writeUsagePollPlans(PROVIDER, { [inactiveId]: { nextDueAt: nowS + (polls[inactiveId]?.pollIntervalS ?? 300), pollIntervalS: polls[inactiveId]?.pollIntervalS ?? 300 } });
          skipped = true;
        } else {
          const consumed = await consumeClaudeSlot({ ...deps.consumeDeps, slots: deps.slots, now: () => nowS * 1000 }, { accountId: inactiveId, snapshot: credential });
          if (consumed.kind === 'dead') {
            let strike: 'struck' | 'already-dead' | 'lineage-moved' = 'lineage-moved';
            if (consumed.consumedFp) {
              try {
                strike = await deps.slots.strikeDead(inactiveId, { reason: parseCredentialBlob(credential)?.oauth?.refreshToken ? 'invalid_grant' : 'no_refresh_token', struckFp: consumed.consumedFp, ts: nowS * 1000 });
              } catch { /* a failed strike is not a durable dead mark */ }
            }
            record(inactiveId, previous, null, undefined, 'consume-dead', false);
            skipped = true;
            if (strike === 'lineage-moved') { /* keep the slot eligible after ordinary failure backoff */ }
          } else if (consumed.kind === 'consume-gate-unpersisted') {
            // Like cc-switch, the successor is lost; refuse durably and defer retrying its spent predecessor until the hold ends.
            deps.store.recordClaudeSwitchRefusal({ from: activeId, to: inactiveId, trigger: 'auto', reason: 'freshen-consume-gate-unpersisted', injected: false, attempt: `poll-freshen-${inactiveId}-${nowS}`, now: nowS * 1000 });
            try { deps.consumeDeps.warn?.('Claude refresh successor was not persisted; inactive poll stopped'); } catch { /* diagnostic only */ }
            record(inactiveId, previous, null, undefined, `consume-${consumed.kind}`, false, false, 3600);
            skipped = true;
          } else if (consumed.kind !== 'refreshed' && consumed.kind !== 'current') {
            record(inactiveId, previous, null, undefined, consumed.kind === 'systemic' ? 'invalid_client' : `consume-${consumed.kind}`, false);
            skipped = true;
          } else {
            credential = consumed.credential ?? null;
            if (!credential) {
              record(inactiveId, previous, null, undefined, `consume-${consumed.kind}`, false);
              skipped = true;
            }
          }
        }
      }
      if (!skipped && credential) {
        const accessToken = extractAccessToken(credential);
        if (!accessToken) record(inactiveId, previous, null, undefined, 'no-credentials', false);
        else {
          let response: Awaited<ReturnType<AnthropicPollDeps['getUsage']>> | null = null;
          try { response = await deps.getUsage(accessToken); } catch { /* unknown below */ }
          if (!response) record(inactiveId, previous, null, undefined, 'usage-fetch-failed', false);
          else if (response.status < 200 || response.status >= 300) record(inactiveId, previous, null, undefined, `http-${response.status}`, false, response.status === 429, response.retryAfterS);
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
  return freshAnthropicAccounts(deps.slots.listSlots(), deps.store, pollingState(deps.slots.listSlots(), deps.store.listUsagePolls(PROVIDER)), nowS, models);
}

export interface AnthropicTickDeps {
  store: Store;
  slots: ClaudeSlots;
  /** Epoch milliseconds, matching the switch journal and autoswitch engine. */
  now: () => number;
  models?: readonly string[];
  /** A just-polled projection is accepted so a live loop does not re-read it. */
  accounts?: readonly AutoswitchAccount[];
  /** Dry runs are strictly decision-only and must not mutate or switch. */
  dryRun?: boolean;
  /** Optional test override; production defaults to the Store projection. */
  breakerRows?: AutoswitchInput['breakerRows'];
  /** Called only for a switch, so every attempt gets fresh resources and ID. */
  makeSwitchDeps?: (by: 'qlb-auto') => Promise<{ deps: ClaudeSwitchDeps; close?: () => void } | ClaudeSwitchDeps>;
  switchClaude?: typeof switchClaude;
}

export interface AnthropicTickResult {
  decision: AutoswitchDecision;
  switchResult?: ClaudeSwitchResult;
}

const AUTO_PREFIX = 'auto.anthropic.';

function configNumber(store: Store, key: string): number | undefined {
  const value = store.getConfig(key);
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function configString(store: Store, key: string): string | null {
  const value = store.getConfig(key);
  return value === '' ? null : value;
}

// Store deliberately exposes only an upsert config API. Empty values retain
// the same absence semantics for all numeric/string readers in this module.
function setOrDelete(store: Store, key: string, value: number | string | undefined): void {
  store.setConfig(key, value === undefined ? '' : String(value));
}

function decisionInput(deps: AnthropicTickDeps): AutoswitchInput {
  const nowMs = deps.now();
  const nowS = Math.floor(nowMs / 1000);
  const settings = deps.store.getAutoswitchSettings();
  const activeAccountId = deps.store.getActiveLogin(PROVIDER)?.accountId ?? null;
  const polls = pollingState(deps.slots.listSlots(), deps.store.listUsagePolls(PROVIDER));
  const healthTickAt = configNumber(deps.store, `${AUTO_PREFIX}healthTickAt`);
  const healthIsFresh = activeAccountId !== null
    && configString(deps.store, `${AUTO_PREFIX}healthAccount`) === activeAccountId
    && healthTickAt !== undefined
    && nowMs - healthTickAt >= 0
    && nowMs - healthTickAt <= 60 * 60_000;
  const accounts = deps.accounts ?? freshAnthropicAccounts(
    deps.slots.listSlots(), deps.store, polls, nowS, deps.models ?? [],
  );
  // The switch journal's committed row is authoritative. The config value is
  // retained only for legacy/test rows that predate this reader.
  const lastSwitchAtMs = deps.store.latestCommittedAnthropicAutoswitchAt()
    ?? configNumber(deps.store, `${AUTO_PREFIX}lastSwitchAt`);
  return {
    accounts,
    activeAccountId,
    nowMs,
    settings,
    lastSwitchAtMs,
    activeCredentialExpired: polls[activeAccountId ?? '']?.lastStatus === 'token-expired',
    unhealthyTicks: healthIsFresh ? configNumber(deps.store, `${AUTO_PREFIX}unhealthyTicks`) : undefined,
    idleHoldSinceMs: healthIsFresh ? configNumber(deps.store, `${AUTO_PREFIX}idleHoldSince`) : undefined,
    parkedUntilMs: configNumber(deps.store, `${AUTO_PREFIX}parkedUntil`),
    lastSwitchFrom: configString(deps.store, `${AUTO_PREFIX}lastSwitchFrom`),
    lastSwitchTo: configString(deps.store, `${AUTO_PREFIX}lastSwitchTo`),
    leftHeadroom: configNumber(deps.store, `${AUTO_PREFIX}leftHeadroom`) ?? null,
    leftRecoveryAtMs: configNumber(deps.store, `${AUTO_PREFIX}leftRecoveryAt`) ?? null,
    leftTrigger: configString(deps.store, `${AUTO_PREFIX}leftTrigger`) as AutoswitchInput['leftTrigger'],
    suspendedUntilMs: configNumber(deps.store, `${AUTO_PREFIX}suspendedUntil`) ?? null,
    lastSuspensionEndMs: configNumber(deps.store, `${AUTO_PREFIX}lastSuspensionEnd`) ?? null,
    lastResumeAtMs: configNumber(deps.store, `${AUTO_PREFIX}lastResumeAt`) ?? null,
    breakerRows: deps.breakerRows ?? deps.store.listAnthropicAutoswitchBreakerRows(),
    provider: 'anthropic',
  };
}

function persistTickState(store: Store, input: AutoswitchInput, decision: AutoswitchDecision, switched: boolean, committedAtMs?: number): void {
  // After the idle hold, the engine deliberately returns `unknown` without
  // repeating the start time. Keep that start while this same active
  // credential remains expired, then clear it on a known reading/account
  // change/switch.
  const idleHoldSince = decision.kind === 'stay'
    ? decision.idleHoldSinceMs ?? (input.activeCredentialExpired ? input.idleHoldSinceMs ?? undefined : undefined)
    : decision.kind === 'switch' && !switched
      ? input.idleHoldSinceMs ?? undefined
      : undefined;
  const health = decision.unhealthyTicks > 0 || idleHoldSince !== undefined;
  const { activeAccountId, nowMs } = input;
  if (health && activeAccountId !== null) {
    store.setConfig(`${AUTO_PREFIX}unhealthyTicks`, String(decision.unhealthyTicks));
    store.setConfig(`${AUTO_PREFIX}healthAccount`, activeAccountId);
    store.setConfig(`${AUTO_PREFIX}healthTickAt`, String(nowMs));
    setOrDelete(store, `${AUTO_PREFIX}idleHoldSince`, idleHoldSince);
  } else {
    for (const key of ['unhealthyTicks', 'idleHoldSince', 'healthAccount', 'healthTickAt']) setOrDelete(store, `${AUTO_PREFIX}${key}`, undefined);
  }

  if (decision.kind === 'parked') {
    setOrDelete(store, `${AUTO_PREFIX}parkedUntil`, decision.parkedUntilMs);
  } else if (decision.kind === 'switch' && decision.reason === 'parked' && !switched) {
    // A failed parked operation has not consumed this reset; retaining the
    // prior value makes the engine retry it on the next tick.
  } else {
    setOrDelete(store, `${AUTO_PREFIX}parkedUntil`, decision.kind === 'switch' && switched ? decision.parkedUntilMs : undefined);
  }
  const suspendedUntil = decision.kind === 'stay' ? decision.suspendedUntilMs : undefined;
  if (suspendedUntil !== undefined) store.setConfig(`${AUTO_PREFIX}suspendedUntil`, String(suspendedUntil));
  else if (configNumber(store, `${AUTO_PREFIX}suspendedUntil`) !== undefined && configNumber(store, `${AUTO_PREFIX}suspendedUntil`)! <= nowMs) {
    setOrDelete(store, `${AUTO_PREFIX}suspendedUntil`, undefined);
    store.setConfig(`${AUTO_PREFIX}lastSuspensionEnd`, String(nowMs));
  }
  if (switched) store.setConfig(`${AUTO_PREFIX}lastSwitchAt`, String(committedAtMs ?? nowMs));
}

/**
 * Make exactly one Claude auto-switch decision. Polling is deliberately owned
 * by G8/G11; this function consumes only its supplied or stored readings.
 */
export async function anthropicTick(deps: AnthropicTickDeps): Promise<AnthropicTickResult> {
  const input = decisionInput(deps);
  const decision = decideAutoswitch(input);
  if (deps.dryRun) return { decision };

  if (decision.kind !== 'switch') {
    persistTickState(deps.store, input, decision, false);
    return { decision };
  }

  if (!deps.makeSwitchDeps) throw new Error('anthropic tick requires a fresh switch-dependency factory to execute a switch');
  const built = await deps.makeSwitchDeps('qlb-auto');
  const resources = 'deps' in built ? built : { deps: built };
  const result = await (async (): Promise<ClaudeSwitchResult> => {
    try {
      return await (deps.switchClaude ?? switchClaude)(resources.deps, {
        to: decision.targetId,
        trigger: decision.reason,
        decision: {
          leftHeadroom: decision.leftHeadroom,
          leftRecoveryAt: decision.leftRecoveryAtMs,
          leftTrigger: decision.leftTrigger,
        },
      });
    } finally {
      resources.close?.();
    }
  })();
  // A refused/failed target is not tried again in this tick. Its durable switch
  // row is the retry authority for the following tick.
  const switched = result.outcome === 'ok';
  persistTickState(deps.store, input, decision, switched,
    switched && result.switchId !== undefined ? deps.store.committedAnthropicSwitchAt(result.switchId) : undefined);
  return { decision, switchResult: result };
}
