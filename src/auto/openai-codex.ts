// Scheduled Codex usage collection and active-login maintenance.

import { CodexProcessCheckFailed, accessFingerprint, activeCodexRenewers, classifyActiveCodexExpiry, isDueForRefresh, refreshActiveCodexLogin, type CodexActiveDeps, type CodexActiveInput, type CodexActiveOutcome } from '../codex-active';
import { codexIdentity, type CodexAuthDocument } from '../codex-auth';
import { reconcileCodexRecovery, runDueCodexWatches, type CodexSwitchDeps } from '../codex-switch';
import { dueCandidate, planAfterFetch, RECENT_429_WINDOW_S, type Usage } from '../poll-policy';
import type { Store, UsagePollRow } from '../store';
import { probeCodexUsage, type CodexUsageProbeDeps, type CodexUsageProbeResult } from '../usage/openai-codex';
import type { BucketReading } from '../types';

const PROVIDER = 'openai-codex';
const AUTO_PREFIX = 'auto.openai-codex.';

type PollStore = Pick<Store,
  'getCodexActiveLogin' | 'getAllSnapshots' | 'recordUsagePollResult' | 'listUsagePolls'
  | 'writeUsagePollPlans' | 'getAutoswitchSettings' | 'setUsagePollHeldUntil' | 'getConfig' | 'setConfig'>;

export interface CodexAutoDeps {
  /** The live active-refresh binding; it also provides the stable auth-file read. */
  active: CodexActiveDeps & { store: PollStore };
  /** The switch binding owns recovery reconciliation and persisted watch rows. */
  switch: CodexSwitchDeps;
  now: () => number;
  /** Kept injectable because usage-plan jitter must be deterministic in tests. */
  rng?: () => number;
  probeUsage?: (deps: CodexUsageProbeDeps) => Promise<CodexUsageProbeResult>;
  refreshActive?: (deps: CodexActiveDeps, input: CodexActiveInput) => Promise<CodexActiveOutcome>;
  activeRenewers?: (deps: Pick<CodexActiveDeps, 'dbPath' | 'journalDir' | 'list'>, accountId: string) => Promise<unknown[]>;
  reconcileRecovery?: (deps: CodexSwitchDeps) => Promise<unknown>;
  runDueWatches?: (deps: CodexSwitchDeps, now: number) => Promise<void>;
}

/** Credential-free refresh receipt suitable for scheduler consumers. */
export interface CodexAutoRefreshResult {
  status: CodexActiveOutcome['status'];
  reason?: string;
}

export interface CodexAutoPollResult {
  accountId: string | null;
  readings: Record<string, BucketReading>;
  activeCredentialExpired: boolean;
  /** Passed to the autoswitch engine so an expired, live-renewer login stays put. */
  idleHoldSinceMs: number | null;
  refresh?: CodexAutoRefreshResult;
}

function readingsFrom(result: CodexUsageProbeResult, nowMs: number): Record<string, BucketReading> {
  return Object.fromEntries((result.windows ?? []).map((window) => [window.bucket, {
    usedPct: window.usedPct,
    ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
    fetchedAt: nowMs,
    source: 'poll' as const,
    confidence: 'authoritative' as const,
  }]));
}

function currentReadings(store: PollStore, accountId: string | null): Record<string, BucketReading> {
  return accountId === null ? {} : store.getAllSnapshots(accountId);
}

function usageFrom(readings: Record<string, BucketReading>): Usage | null {
  const usage: Record<string, unknown> = {};
  for (const [bucket, reading] of Object.entries(readings)) {
    const value = { pct: reading.usedPct, ...(reading.resetAt === undefined ? {} : { resets_at: new Date(reading.resetAt).toISOString() }) };
    if (bucket === 'primary') usage.five_hour = value;
    else if (bucket === 'secondary') usage.seven_day = value;
  }
  return Object.keys(usage).length === 0 ? null : usage;
}

function refreshReceipt(outcome: CodexActiveOutcome): CodexAutoRefreshResult {
  return 'reason' in outcome && typeof outcome.reason === 'string'
    ? { status: outcome.status, reason: outcome.reason }
    : { status: outcome.status };
}

function configNumber(store: PollStore, key: string): number | undefined {
  const value = store.getConfig(key);
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function setIdleHold(store: PollStore, since: number | undefined): void {
  store.setConfig(`${AUTO_PREFIX}idleHoldSince`, since === undefined ? '' : String(since));
}

function recent429(row: UsagePollRow | undefined, nowS: number): boolean {
  return row?.last429At !== null && row?.last429At !== undefined && nowS - row.last429At <= RECENT_429_WINDOW_S;
}

function logRefreshStop(deps: CodexAutoDeps, outcome: CodexActiveOutcome): void {
  const reason = 'reason' in outcome && typeof outcome.reason === 'string' ? ` reason=${outcome.reason}` : '';
  try { deps.active.autoLog?.(`codex:poll-ended status=${outcome.status}${reason}`); } catch { /* diagnostic only */ }
}

function shouldStopAfterRefresh(outcome: CodexActiveOutcome): boolean {
  return outcome.status === 'held'
    || outcome.status === 'codex-won'
    || outcome.status === 'dead'
    || outcome.status === 'drift'
    || outcome.status === 'fenced'
    || outcome.status === 'refused'
    || outcome.status === 'unpersisted'
    || outcome.status === 'stashed'
    || outcome.status === 'deferred'
    || outcome.status === 'transient'
    || outcome.status === 'superseded'
    || outcome.status === 'posted-live-unwritten'
    || outcome.status === 'posted-live-external'
    || outcome.status === 'posted-live-unverified';
}

/**
 * Poll the active Codex login. The usage adapter deliberately returns metadata
 * only; this module persists just its parsed primary/secondary readings.
 */
export async function pollOpenAiCodex(deps: CodexAutoDeps): Promise<CodexAutoPollResult> {
  const store = deps.active.store;
  const accountId = store.getCodexActiveLogin();
  if (accountId === null) return { accountId: null, readings: {}, activeCredentialExpired: false, idleHoldSinceMs: null };

  const nowMs = deps.now();
  const nowS = Math.floor(nowMs / 1000);
  const polls = store.listUsagePolls(PROVIDER);
  if (dueCandidate([accountId], polls, nowS) !== accountId) {
    return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null };
  }

  const previous = usageFrom(currentReadings(store, accountId));
  const record = (status: string, readings?: Record<string, BucketReading>, http429 = false, retryAfterS?: number): void => {
    store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: nowS, status, readings, http429, retryAfterS });
    const settings = store.getAutoswitchSettings();
    const [nextDueAt, pollIntervalS] = planAfterFetch({
      prevIntervalS: polls[accountId]?.pollIntervalS,
      prevUsage: previous,
      newUsage: readings ? usageFrom(readings) : null,
      isActive: true,
      threshold: settings.threshold,
      weeklyThreshold: settings.weeklyThreshold,
      models: [],
      recent429: http429 || recent429(polls[accountId], nowS),
      now: nowS,
      rng: deps.rng,
    });
    store.writeUsagePollPlans(PROVIDER, { [accountId]: { nextDueAt, pollIntervalS } });
  };
  const stopped = (refresh: CodexActiveOutcome): CodexAutoPollResult | undefined => {
    const receipt = refreshReceipt(refresh);
    if (refresh.status === 'held') {
      const interval = polls[accountId]?.pollIntervalS ?? 60;
      store.setUsagePollHeldUntil(PROVIDER, accountId, nowS + Math.max(60, interval));
      logRefreshStop(deps, refresh);
      return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null, refresh: receipt };
    }
    if (refresh.status === 'codex-won') {
      const readings = currentReadings(store, accountId);
      record('codex-won', readings);
      return { accountId, readings, activeCredentialExpired: false, idleHoldSinceMs: null, refresh: receipt };
    }
    if (shouldStopAfterRefresh(refresh)) {
      logRefreshStop(deps, refresh);
      return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null, refresh: receipt };
    }
    return undefined;
  };
  const stillOwns = async (): Promise<{ doc: CodexAuthDocument } | null> => {
    if (store.getCodexActiveLogin() !== accountId) return null;
    const current = await deps.active.readLive();
    if (current.status !== 'ok' || codexIdentity(current.doc) !== accountId) return null;
    return { doc: current.doc };
  };

  let live = await stillOwns();
  if (!live) return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null };

  const expiry = classifyActiveCodexExpiry(live.doc, nowMs);
  if (expiry.state === 'expired') {
    let renewers: unknown[];
    try {
      renewers = await (deps.activeRenewers ?? activeCodexRenewers)(deps.active, accountId);
    } catch (error) {
      if (error instanceof CodexProcessCheckFailed) {
        try { deps.active.autoLog?.('codex:poll-ended status=refused reason=codex-process-check-failed'); } catch { /* diagnostic only */ }
        return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null };
      }
      throw error;
    }
    if (renewers.length > 0) {
      const idleHoldSinceMs = configNumber(store, `${AUTO_PREFIX}idleHoldSince`) ?? nowMs;
      setIdleHold(store, idleHoldSinceMs);
      record('usage-unknown');
      return { accountId, readings: {}, activeCredentialExpired: true, idleHoldSinceMs };
    }
  }
  setIdleHold(store, undefined);
  store.setUsagePollHeldUntil(PROVIDER, accountId, null);

  let refresh: CodexActiveOutcome | undefined;
  if (isDueForRefresh(live.doc, nowMs, 'scheduled')) {
    const trigger = expiry.state === 'near-expiry' || expiry.state === 'expired' ? 'proactive-expiry' : 'scheduled';
    refresh = await (deps.refreshActive ?? refreshActiveCodexLogin)(deps.active, { trigger });
    const afterRefresh = await stillOwns();
    if (!afterRefresh) return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null, refresh: refreshReceipt(refresh) };
    live = afterRefresh;
    const result = stopped(refresh);
    if (result) return result;
  }

  const usage = await (deps.probeUsage ?? probeCodexUsage)({ auth: live.doc, authPath: deps.active.authPath });
  // A 401 is authoritative even when a passive rollout snapshot has windows.
  if (usage.status === 401) {
    refresh = await (deps.refreshActive ?? refreshActiveCodexLogin)(deps.active, {
      trigger: 'unauthorized', accessFp: accessFingerprint(live.doc),
    });
    const afterRefresh = await stillOwns();
    if (!afterRefresh) return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null, refresh: refreshReceipt(refresh) };
    const result = stopped(refresh);
    if (result) return result;
    record('usage-unknown');
    return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null, refresh: refreshReceipt(refresh) };
  }

  // A switch/adopt may finish while the HTTP request is pending.  The response
  // has no safe owner then, so do not mutate either account's poll state.
  if (!(await stillOwns())) {
    return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null, ...(refresh ? { refresh: refreshReceipt(refresh) } : {}) };
  }
  if (usage.windows && usage.windows.length > 0) {
    const readings = readingsFrom(usage, nowMs);
    record('ok', readings);
    return { accountId, readings, activeCredentialExpired: false, idleHoldSinceMs: null, ...(refresh ? { refresh: refreshReceipt(refresh) } : {}) };
  }

  record(usage.status === 429 ? 'http-429' : 'usage-unknown', undefined, usage.status === 429, usage.retryAfterS);
  return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null, ...(refresh ? { refresh: refreshReceipt(refresh) } : {}) };
}

/** C8 maintenance ordering: settle recovery, consume due watches, then poll. */
export async function codexAutoTick(deps: CodexAutoDeps): Promise<CodexAutoPollResult> {
  await (deps.reconcileRecovery ?? reconcileCodexRecovery)(deps.switch);
  await (deps.runDueWatches ?? runDueCodexWatches)(deps.switch, deps.now());
  return pollOpenAiCodex(deps);
}
