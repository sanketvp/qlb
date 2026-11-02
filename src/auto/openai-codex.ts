// Scheduled Codex usage collection and active-login maintenance.

import { accessFingerprint, activeCodexRenewers, classifyActiveCodexExpiry, isDueForRefresh, refreshActiveCodexLogin, type CodexActiveDeps, type CodexActiveInput, type CodexActiveOutcome } from '../codex-active';
import { reconcileCodexRecovery, runDueCodexWatches, type CodexSwitchDeps } from '../codex-switch';
import { probeCodexUsage, type CodexUsageProbeResult } from '../usage/openai-codex';
import type { Store } from '../store';
import type { BucketReading } from '../types';

const PROVIDER = 'openai-codex';

export interface CodexAutoDeps {
  /** The live active-refresh binding; it also provides the stable auth-file read. */
  active: CodexActiveDeps;
  /** The switch binding owns recovery reconciliation and persisted watch rows. */
  switch: CodexSwitchDeps;
  now: () => number;
  probeUsage?: () => Promise<CodexUsageProbeResult>;
  refreshActive?: (deps: CodexActiveDeps, input: CodexActiveInput) => Promise<CodexActiveOutcome>;
  activeRenewers?: (deps: Pick<CodexActiveDeps, 'dbPath' | 'journalDir' | 'list'>, accountId: string) => Promise<unknown[]>;
  reconcileRecovery?: (deps: CodexSwitchDeps) => Promise<unknown>;
  runDueWatches?: (deps: CodexSwitchDeps, now: number) => Promise<void>;
}

export interface CodexAutoPollResult {
  accountId: string | null;
  readings: Record<string, BucketReading>;
  activeCredentialExpired: boolean;
  /** Passed to the autoswitch engine so an expired, live-renewer login stays put. */
  idleHoldSinceMs: number | null;
  refresh?: CodexActiveOutcome;
}

type PollStore = Pick<Store, 'getCodexActiveLogin' | 'getAllSnapshots' | 'recordUsagePollResult'>;

function storeFor(deps: CodexAutoDeps): PollStore {
  return deps.active.store as unknown as PollStore;
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

function isNoAction(outcome: CodexActiveOutcome): boolean {
  return outcome.status === 'fenced'
    || (outcome.status === 'refused' && outcome.reason === 'codex-process-check-failed');
}

/**
 * Poll the active Codex login. The usage adapter deliberately returns metadata
 * only; this module persists just its parsed primary/secondary readings.
 */
export async function pollOpenAiCodex(deps: CodexAutoDeps): Promise<CodexAutoPollResult> {
  const store = storeFor(deps);
  const accountId = store.getCodexActiveLogin();
  if (accountId === null) return { accountId: null, readings: {}, activeCredentialExpired: false, idleHoldSinceMs: null };

  const nowMs = deps.now();
  const nowS = Math.floor(nowMs / 1000);
  const live = await deps.active.readLive();
  if (live.status !== 'ok') {
    store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: nowS, status: 'usage-unknown' });
    return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null };
  }

  const expiry = classifyActiveCodexExpiry(live.doc, nowMs);
  if (expiry.state === 'expired') {
    const renewers = await (deps.activeRenewers ?? activeCodexRenewers)(deps.active, accountId);
    if (renewers.length > 0) {
      // A process holding an expired login may publish a replacement. Do not
      // spend its single-use grant or make an autoswitch decision from stale use.
      store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: nowS, status: 'usage-unknown' });
      return { accountId, readings: {}, activeCredentialExpired: true, idleHoldSinceMs: nowMs };
    }
  }

  let refresh: CodexActiveOutcome | undefined;
  if (isDueForRefresh(live.doc, nowMs, 'scheduled')) {
    const trigger = expiry.state === 'near-expiry' || expiry.state === 'expired' ? 'proactive-expiry' : 'scheduled';
    refresh = await (deps.refreshActive ?? refreshActiveCodexLogin)(deps.active, { trigger });
    if (isNoAction(refresh)) {
      return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null, refresh };
    }
    if (refresh.status === 'codex-won') {
      store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: nowS, status: 'codex-won' });
      return { accountId, readings: {}, activeCredentialExpired: false, idleHoldSinceMs: null, refresh };
    }
  }

  const usage = await (deps.probeUsage ?? probeCodexUsage)();
  if (usage.windows && usage.windows.length > 0) {
    const readings = readingsFrom(usage, nowMs);
    store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: nowS, status: 'ok', readings });
    return { accountId, readings, activeCredentialExpired: false, idleHoldSinceMs: null, refresh };
  }

  if (usage.status === 401) {
    refresh = await (deps.refreshActive ?? refreshActiveCodexLogin)(deps.active, {
      trigger: 'unauthorized', accessFp: accessFingerprint(live.doc),
    });
    if (isNoAction(refresh)) {
      return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null, refresh };
    }
    if (refresh.status === 'codex-won') {
      store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: nowS, status: 'codex-won' });
      return { accountId, readings: {}, activeCredentialExpired: false, idleHoldSinceMs: null, refresh };
    }
  }
  store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: nowS, status: 'usage-unknown' });
  return { accountId, readings: currentReadings(store, accountId), activeCredentialExpired: false, idleHoldSinceMs: null, refresh };
}

/** C8 maintenance ordering: settle recovery, consume due watches, then poll. */
export async function codexAutoTick(deps: CodexAutoDeps): Promise<CodexAutoPollResult> {
  await (deps.reconcileRecovery ?? reconcileCodexRecovery)(deps.switch);
  await (deps.runDueWatches ?? runDueCodexWatches)(deps.switch, deps.now());
  return pollOpenAiCodex(deps);
}
