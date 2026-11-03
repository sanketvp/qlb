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
  | 'writeUsagePollPlans' | 'getAutoswitchSettings' | 'compareAndSetUsagePollHeldUntil' | 'getConfig' | 'setConfig'>;

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

interface IdleHold {
  accountId: string;
  sinceMs: number;
}

function idleHold(store: PollStore, accountId: string): number | undefined {
  const value = store.getConfig(`${AUTO_PREFIX}idleHoldSince`);
  if (value === null || value === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const hold = parsed as Partial<IdleHold>;
    return hold.accountId === accountId && Number.isFinite(hold.sinceMs) ? hold.sinceMs : undefined;
  } catch {
    return undefined;
  }
}

function setIdleHold(store: PollStore, accountId: string, since: number | undefined): void {
  store.setConfig(`${AUTO_PREFIX}idleHoldSince`, since === undefined ? '' : JSON.stringify({ accountId, sinceMs: since }));
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
  const previous = usageFrom(currentReadings(store, accountId));
  const base = (activeCredentialExpired = false, idleHoldSinceMs: number | null = null, refresh?: CodexActiveOutcome): CodexAutoPollResult => ({
    accountId,
    readings: currentReadings(store, accountId),
    activeCredentialExpired,
    idleHoldSinceMs,
    ...(refresh ? { refresh: refreshReceipt(refresh) } : {}),
  });
  const stillOwns = async (): Promise<{ doc: CodexAuthDocument } | null> => {
    if (store.getCodexActiveLogin() !== accountId) return null;
    const current = await deps.active.readLive();
    // readLive is external state: ownership must be checked again afterwards.
    if (store.getCodexActiveLogin() !== accountId || current.status !== 'ok' || codexIdentity(current.doc) !== accountId) return null;
    return { doc: current.doc };
  };
  const record = async (status: string, readings?: Record<string, BucketReading>, http429 = false, retryAfterS?: number): Promise<boolean> => {
    // Do not let a changed active account receive this tick's poll state.
    if (!(await stillOwns())) return false;
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
    return true;
  };
  const setHold = async (since: number | undefined): Promise<boolean> => {
    if (!(await stillOwns())) return false;
    setIdleHold(store, accountId, since);
    return true;
  };
  const compareAndSetRenewerLease = async (expectedHeldUntilS: number | null, heldUntilS: number | null): Promise<boolean> => {
    if (!(await stillOwns())) return false;
    return store.compareAndSetUsagePollHeldUntil(PROVIDER, accountId, expectedHeldUntilS, heldUntilS);
  };
  // This expected value follows this tick's successful CAS writes.  A 401 can
  // clear an expired lease before its refresh observes a fresh renewer, so a
  // later renewal must compare against NULL rather than the tick-start lease.
  let leaseExpected = polls[accountId]?.heldUntil ?? null;
  const clearExpiredLease = async (): Promise<boolean> => {
    if (leaseExpected === null || nowS < leaseExpected) return true;
    if (!(await compareAndSetRenewerLease(leaseExpected, null))) return false;
    leaseExpected = null;
    return true;
  };
  const stopped = async (refresh: CodexActiveOutcome): Promise<CodexAutoPollResult | undefined> => {
    const receipt = refreshReceipt(refresh);
    if (refresh.status === 'held') {
      // Only a process scan made by this refresh can renew a lease.  A held
      // result carried from consume-time holders is not fresh evidence.
      if (refresh.fresh !== true) {
        if (!(await clearExpiredLease())) return base(false, null, refresh);
        logRefreshStop(deps, refresh);
        return { ...base(), refresh: receipt };
      }
      const interval = polls[accountId]?.pollIntervalS ?? 60;
      const heldUntil = Math.max(leaseExpected ?? 0, nowS + Math.max(60, interval));
      // A later lease already protects this account; never shorten or replace it.
      if (heldUntil !== leaseExpected) {
        if (!(await compareAndSetRenewerLease(leaseExpected, heldUntil))) return base(false, null, refresh);
        leaseExpected = heldUntil;
      }
      logRefreshStop(deps, refresh);
      return { ...base(), refresh: receipt };
    }
    if (refresh.status === 'codex-won') {
      // This is not a fetch. Recording without readings preserves that distinction.
      if (!(await record('codex-won'))) return base(false, null, refresh);
      return { ...base(), refresh: receipt };
    }
    if (shouldStopAfterRefresh(refresh)) {
      logRefreshStop(deps, refresh);
      return { ...base(), refresh: receipt };
    }
    return undefined;
  };

  // Credential maintenance deliberately precedes the usage schedule gate.
  let live = await stillOwns();
  if (!live) return base();
  let expiry = classifyActiveCodexExpiry(live.doc, nowMs);
  let heldSinceMs = idleHold(store, accountId);

  if (expiry.state === 'expired') {
    let renewers: unknown[];
    try {
      renewers = await (deps.activeRenewers ?? activeCodexRenewers)(deps.active, accountId);
    } catch (error) {
      if (error instanceof CodexProcessCheckFailed) {
        try { deps.active.autoLog?.('codex:poll-ended status=refused reason=codex-process-check-failed'); } catch { /* diagnostic only */ }
        // The credential is known expired even though discovery failed; retain its own hold.
        return base(true, heldSinceMs ?? null);
      }
      throw error;
    }
    // activeRenewers is external state too. Do not mutate after an account switch.
    live = await stillOwns();
    if (!live) return base();
    expiry = classifyActiveCodexExpiry(live.doc, nowMs);
    if (renewers.length > 0 && expiry.state === 'expired') {
      heldSinceMs ??= nowMs;
      if (!(await setHold(heldSinceMs))) return base();
      if (dueCandidate([accountId], polls, nowS) === accountId) {
        if (!(await record('usage-unknown'))) return base();
        return { accountId, readings: {}, activeCredentialExpired: true, idleHoldSinceMs: heldSinceMs };
      }
      // Usage backoff never suppresses the active expired/renewer safety signal.
      return base(true, heldSinceMs);
    }
  }

  // A healthy/new active credential supersedes any hold (including another account's).
  if (!(await setHold(undefined))) return base();
  heldSinceMs = undefined;
  let refresh: CodexActiveOutcome | undefined;
  if (isDueForRefresh(live.doc, nowMs, 'scheduled')) {
    const trigger = expiry.state === 'near-expiry' || expiry.state === 'expired' ? 'proactive-expiry' : 'scheduled';
    refresh = await (deps.refreshActive ?? refreshActiveCodexLogin)(deps.active, { trigger });
    const afterRefresh = await stillOwns();
    if (!afterRefresh) return base(false, null, refresh);
    live = afterRefresh;
    expiry = classifyActiveCodexExpiry(live.doc, nowMs);
    const result = await stopped(refresh);
    if (result) return result;
  }

  // An expired lease may be removed only when the row still has the precise
  // tick-start value. A concurrent tick's newer lease must survive.
  if (!(await clearExpiredLease())) return base(expiry.state === 'expired', heldSinceMs ?? null, refresh);

  // The schedule/backoff gate applies only to the outbound usage probe.
  if (dueCandidate([accountId], store.listUsagePolls(PROVIDER), nowS) !== accountId) return base(expiry.state === 'expired', heldSinceMs ?? null, refresh);

  const usage = await (deps.probeUsage ?? probeCodexUsage)({ auth: live.doc, authPath: deps.active.authPath });
  // A 401 is authoritative even when a passive rollout snapshot has windows.
  if (usage.status === 401) {
    refresh = await (deps.refreshActive ?? refreshActiveCodexLogin)(deps.active, {
      trigger: 'unauthorized', accessFp: accessFingerprint(live.doc),
    });
    const afterRefresh = await stillOwns();
    if (!afterRefresh) return base(false, null, refresh);
    const result = await stopped(refresh);
    if (result) return result;
    if (!(await record('usage-unknown'))) return base(false, null, refresh);
    return base(false, null, refresh);
  }

  // A switch/adopt may finish while the HTTP request is pending. The response
  // has no safe owner then, so do not mutate either account's poll state.
  if (!(await stillOwns())) return base(false, null, refresh);
  // A rate limit remains a rate limit even if rollout snapshots provide readings.
  if (usage.status === 429) {
    const readings = usage.windows && usage.windows.length > 0 ? readingsFrom(usage, nowMs) : undefined;
    // Preserve rate-limit backoff; rollout readings are advisory for this tick only.
    if (!(await record('http-429', undefined, true, usage.retryAfterS))) return base(false, null, refresh);
    return readings
      ? { accountId, readings, activeCredentialExpired: false, idleHoldSinceMs: null, ...(refresh ? { refresh: refreshReceipt(refresh) } : {}) }
      : base(false, null, refresh);
  }
  if (usage.windows && usage.windows.length > 0) {
    const readings = readingsFrom(usage, nowMs);
    if (!(await record('ok', readings))) return base(false, null, refresh);
    return { accountId, readings, activeCredentialExpired: false, idleHoldSinceMs: null, ...(refresh ? { refresh: refreshReceipt(refresh) } : {}) };
  }

  if (!(await record('usage-unknown', undefined, false, usage.retryAfterS))) return base(false, null, refresh);
  return base(false, null, refresh);
}

/** C8 maintenance ordering: settle recovery, consume due watches, then poll. */
export async function codexAutoTick(deps: CodexAutoDeps): Promise<CodexAutoPollResult> {
  await (deps.reconcileRecovery ?? reconcileCodexRecovery)(deps.switch);
  await (deps.runDueWatches ?? runDueCodexWatches)(deps.switch, deps.now());
  return pollOpenAiCodex(deps);
}
