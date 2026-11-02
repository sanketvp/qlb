import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { buildUsageRequest, type HttpRequestDescription } from './anthropic-oauth';
import { anthropicTick, pollAnthropic, type AnthropicPollDeps, type AnthropicTickDeps, type AnthropicTickResult } from './auto/anthropic';
import { claudePaths } from './cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository, type ClaudeSlot } from './cc-slots';
import { ProbeVerdictMemo, resolveCswapCheck, type RefreshHttpResponse } from './cc-resync';
import { processLstart, stillTheSameProcess } from './codex-sessions';
import { makeProductionSwitchDeps } from './commands/switch-anthropic';
import { resolveConfig, type QlbConfig } from './config';
import type { CswapProcess } from './cswap-processes';
import { qlbHomeDir } from './home';
import { reconcileClaudeSwitch } from './journal';
import { platformKeychain } from './keychain';
import { assertAdmitted, assertAdmittedInConnection, type LifecycleResult } from './lifecycle';
import { loadProviderStub } from './provider-loader';
import { redactError, redactSecrets } from './redact';
import { listAnthropicAutoswitchBreakerRows, openStore, openStoreConnection, Store, type AutoswitchSettings, type UsagePollRow } from './store';
import type { BucketReading } from './types';

const INTERVAL_MS = 60_000;
export const AUTO_BINDINGS = ['anthropic'] as const;

/** Provider module loader. The polling loop is added by slice K7. */
export function loadAutoProvider(provider: string): unknown {
  return loadProviderStub(provider, join(__dirname, 'auto'));
}

export interface RunAutoOptions {
  once?: boolean;
  dryRun?: boolean;
}

export class AutoAdmissionRefused extends Error {
  constructor(public readonly code: string) {
    super(`auto refused: ${code}`);
    this.name = 'AutoAdmissionRefused';
  }
}

export interface AutoRunResult {
  ticks: number;
  decisions: AnthropicTickResult['decision'][];
  /** Kept for the command receipt shape; G11 executes only Anthropic. */
  executed: string[];
}

export type LiveBinding = {
  store: Pick<Store, 'setConfig'>;
  close(): void;
  reconcile(): Promise<void>;
  poll(): Promise<Awaited<ReturnType<typeof pollAnthropic>>>;
  tick(accounts: Awaited<ReturnType<typeof pollAnthropic>>): Promise<AnthropicTickResult>;
};

export type DryBinding = {
  close(): void;
  tick(): Promise<AnthropicTickResult>;
  admit?(): LifecycleResult;
};

/** Injectable seams keep the loop testable without a process table, network, or Keychain. */
export interface AutoDependencies {
  env?: NodeJS.ProcessEnv;
  home?: string;
  config?: QlbConfig;
  now?: () => number;
  log?: (line: string) => void;
  assertAdmitted?: typeof assertAdmitted;
  listCswapProcesses?: () => CswapProcess[];
  makeLiveBinding?: () => Promise<LiveBinding> | LiveBinding;
  makeDryBinding?: () => Promise<DryBinding> | DryBinding;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  signals?: { on(signal: 'SIGTERM', listener: () => void): unknown; removeListener(signal: 'SIGTERM', listener: () => void): unknown };
  /** Resolves when an owned external resource is lost, including during a running tick. */
  stopWhen?: Promise<Error>;
  /** Synchronously observes a loss so no new or switching tick can start after it. */
  stopIf?: () => Error | undefined;
}

function redactedLog(log: (line: string) => void, line: string): void {
  log(redactSecrets(line, []));
}

function decisionText(result: AnthropicTickResult): string {
  const { decision, switchResult } = result;
  switch (decision.kind) {
    case 'switch':
      return switchResult && switchResult.outcome !== 'ok'
        ? `switch(${decision.targetId},${decision.reason},${switchResult.outcome},${switchResult.reason ?? 'unknown'})`
        : `switch(${decision.targetId},${decision.reason})`;
    case 'stay': return `stay(${decision.reason})`;
    case 'parked': return `parked(${decision.accountId})`;
  }
}

export function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

export function productionRequest(description: HttpRequestDescription): Promise<RefreshHttpResponse & { retryAfterS?: number }> {
  return fetch(description.url, {
    method: description.method,
    headers: description.headers,
    ...(description.body === undefined ? {} : { body: description.body }),
    signal: AbortSignal.timeout(description.timeoutMs),
  }).then(async (response) => {
    const retryAfterS = retryAfterSeconds(response.headers.get('Retry-After'));
    return { status: response.status, body: await response.text(), ...(retryAfterS === undefined ? {} : { retryAfterS }) };
  });
}

export function autoReconcileStillTheSameProcess(
  ownLstart: string | null,
  realStillTheSameProcess: NonNullable<import('./cc-switch').ClaudeSwitchDeps['stillTheSameProcess']>,
): NonNullable<import('./cc-switch').ClaudeSwitchDeps['stillTheSameProcess']> {
  return async (owner) => owner.pid === process.pid && ownLstart !== null && owner.lstart.replace(/\s+/g, ' ') === ownLstart
    ? false
    : realStillTheSameProcess(owner);
}

function productionLiveBinding(deps: Required<Pick<AutoDependencies, 'env' | 'home' | 'config' | 'now' | 'log'>>): LiveBinding {
  const store = openStore(deps.config.dbPath);
  const repository = SqliteClaudeSlotRepository.open(deps.config.dbPath);
  const paths = claudePaths({ home: deps.home, env: deps.env });
  const slots = new ClaudeSlots({ backend: platformKeychain, repository, stashDir: join(qlbHomeDir(deps.env), '.qlb', 'unclaimed') });
  const warn = (message: string): void => redactedLog(deps.log, `auto: warning: ${message}`);
  const live = { backend: platformKeychain, paths, env: deps.env };
  const verdicts = new ProbeVerdictMemo();
  const pollDeps = (): AnthropicPollDeps => ({
    store,
    slots,
    now: () => Math.floor(deps.now() / 1000),
    fetchActiveDeps: {
      live, env: deps.env, now: deps.now, verdicts, by: 'qlb-auto',
      postRefresh: productionRequest,
      warn,
    },
    resyncDeps: { live, env: deps.env, now: deps.now, getProfile: productionRequest, by: 'qlb-auto', warn },
    consumeDeps: { postRefresh: productionRequest, warn },
    getUsage: async (accessToken) => productionRequest(buildUsageRequest(accessToken)),
  });
  const tickDeps = (accounts: Awaited<ReturnType<typeof pollAnthropic>>): AnthropicTickDeps => ({
    store, slots, now: deps.now, accounts,
    makeSwitchDeps: async (by) => makeProductionSwitchDeps({}, {
      stdout: () => {}, stderr: warn, env: deps.env, config: deps.config, loadConfig: () => deps.config,
      home: deps.home, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    }, store, warn, by),
  });
  return {
    store,
    close: () => { repository.close(); store.close(); },
    reconcile: async () => {
      const resources = await makeProductionSwitchDeps({}, {
        stdout: () => {}, stderr: warn, env: deps.env, config: deps.config, loadConfig: () => deps.config,
        home: deps.home, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
      }, store, warn, 'qlb-auto');
      const ownLstart = await processLstart(process.pid);
      const realStillTheSameProcess = resources.deps.stillTheSameProcess ?? stillTheSameProcess;
      resources.deps.stillTheSameProcess = autoReconcileStillTheSameProcess(ownLstart, realStillTheSameProcess);
      try { await reconcileClaudeSwitch(resources.deps); } finally { resources.close?.(); }
    },
    poll: () => pollAnthropic(pollDeps()),
    tick: (accounts) => anthropicTick(tickDeps(accounts)),
  };
}

function configNumber(db: DatabaseSync, key: string, fallback: number, min: number, max: number, integer = false): number {
  const raw = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value?: string | null } | undefined;
  const parsed = raw?.value == null || raw.value.trim() === '' ? NaN : Number(raw.value);
  const bounded = Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
  return integer ? Math.trunc(bounded) : bounded;
}

/* A deliberately small read-only Store facade. anthropicTick's dry path calls
 * only these readers before returning, so this connection cannot persist state. */
function readOnlyStore(db: DatabaseSync, dbPath: string): Store {
  const getConfig = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value?: string } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  };
  const store = {
    dbPath,
    getConfig,
    getAutoswitchSettings: (): AutoswitchSettings => {
      const threshold = configNumber(db, 'autoswitch.threshold', 90, 50, 99.9);
      const weekly = getConfig('autoswitch.weeklyThreshold');
      return {
        threshold,
        weeklyThreshold: weekly == null || weekly.trim() === '' ? null : configNumber(db, 'autoswitch.weeklyThreshold', threshold, 50, 99.9),
        intervalSeconds: configNumber(db, 'autoswitch.intervalSeconds', 60, 15, 3600),
        cooldownSeconds: configNumber(db, 'autoswitch.cooldownSeconds', 300, 0, 86400),
        hysteresisPct: configNumber(db, 'autoswitch.hysteresisPct', 10, 0, 50),
        unhealthyTicks: configNumber(db, 'autoswitch.unhealthyTicks', 3, 1, 100, true),
        strategy: getConfig('autoswitch.strategy') === 'consume-first' ? 'consume-first' : 'best',
      };
    },
    getActiveLogin: (provider: string) => {
      const row = db.prepare('SELECT provider, account_id, since, set_by FROM active_login WHERE provider = ?').get(provider) as Record<string, unknown> | undefined;
      return row ? { provider: String(row.provider), accountId: row.account_id as string | null, since: Number(row.since), setBy: String(row.set_by) } : null;
    },
    getAllSnapshots: (accountId: string): Record<string, BucketReading> => {
      const rows = db.prepare('SELECT bucket, used_pct, used, limit_val, remaining, reset_at, fetched_at, source, confidence FROM snapshots WHERE account_id = ?').all(accountId) as Array<Record<string, unknown>>;
      return Object.fromEntries(rows.map((row) => [String(row.bucket), {
        usedPct: row.used_pct as number, ...(typeof row.used === 'number' ? { used: row.used } : {}),
        ...(typeof row.limit_val === 'number' ? { limit: row.limit_val } : {}), ...(typeof row.remaining === 'number' ? { remaining: row.remaining } : {}),
        ...(typeof row.reset_at === 'number' ? { resetAt: row.reset_at } : {}), fetchedAt: typeof row.fetched_at === 'number' ? row.fetched_at : 0,
        source: (row.source as BucketReading['source']) || 'poll', confidence: (row.confidence as BucketReading['confidence']) || 'unknown',
      }]));
    },
    listUsagePolls: (provider: string): Record<string, UsagePollRow> => {
      const rows = db.prepare('SELECT account_id, last_fetch_at, last_attempt_at, next_due_at, poll_interval_s, last_status, consecutive_failures, backoff_until, last_429_at, held_until FROM usage_polls WHERE provider = ?').all(provider) as Array<Record<string, unknown>>;
      const value = (row: Record<string, unknown>, key: string): number | null => typeof row[key] === 'number' ? row[key] : null;
      return Object.fromEntries(rows.map((row) => [String(row.account_id), {
        accountId: String(row.account_id), lastFetchAt: value(row, 'last_fetch_at'), lastAttemptAt: value(row, 'last_attempt_at'), nextDueAt: value(row, 'next_due_at'), pollIntervalS: value(row, 'poll_interval_s'), lastStatus: typeof row.last_status === 'string' ? row.last_status : null, consecutiveFailures: Number(row.consecutive_failures ?? 0), backoffUntil: value(row, 'backoff_until'), last429At: value(row, 'last_429_at'), heldUntil: value(row, 'held_until'),
      }]));
    },
    latestCommittedAnthropicAutoswitchAt: (): number | undefined => {
      const row = db.prepare("SELECT committed_at FROM switch_log WHERE provider = 'anthropic' AND trigger != 'manual' AND outcome = 'ok' AND committed_at IS NOT NULL ORDER BY committed_at DESC LIMIT 1").get() as { committed_at?: number } | undefined;
      return row?.committed_at;
    },
    listAnthropicAutoswitchBreakerRows: () => listAnthropicAutoswitchBreakerRows(db),
  };
  return store as unknown as Store;
}

function readOnlySlots(db: DatabaseSync): Pick<ClaudeSlots, 'listSlots'> {
  return {
    listSlots: (): ClaudeSlot[] => (db.prepare('SELECT account_id, slot_num, email, alias, org_uuid, config_json, fingerprint, prev_fingerprint, threshold, dead, dead_reason, dead_at, healed_at, added_at, last_active_at, source, archived_at FROM claude_slots ORDER BY slot_num, account_id').all() as Array<Record<string, unknown>>).map((row) => ({
      accountId: String(row.account_id), slotNum: row.slot_num as number | null, email: row.email as string | null, alias: row.alias as string | null, orgUuid: row.org_uuid as string | null, configJson: row.config_json as string, fingerprint: row.fingerprint as string | null, prevFingerprint: row.prev_fingerprint as string | null, threshold: row.threshold as number | null, dead: Boolean(row.dead), deadReason: row.dead_reason as string | null, deadAt: row.dead_at as number | null, healedAt: row.healed_at as number | null, addedAt: Number(row.added_at), lastActiveAt: row.last_active_at as number | null, source: row.source as string | null, archivedAt: row.archived_at as number | null,
    })),
  } as Pick<ClaudeSlots, 'listSlots'>;
}

function productionDryBinding(config: QlbConfig, now: () => number): DryBinding {
  // SQLite may create -wal/-shm sidecars even for a read-only open. A live
  // WAL is readable only with its shared-memory companion; otherwise immutable
  // mode avoids creating the missing sidecar.
  const connectionPath = existsSync(`${config.dbPath}-wal`) && existsSync(`${config.dbPath}-shm`)
    ? config.dbPath
    : `${pathToFileURL(config.dbPath).href}?immutable=1`;
  const db = openStoreConnection(connectionPath, true);
  const store = readOnlyStore(db, config.dbPath);
  const slots = readOnlySlots(db);
  return {
    close: () => db.close(),
    admit: () => assertAdmittedInConnection(db, 'auto:dry-run'),
    tick: () => anthropicTick({ store, slots: slots as ClaudeSlots, now, dryRun: true }),
  };
}

/** Runs the single Anthropic binding. Per-tick failures are intentionally logged and retried. */
export async function runAuto(options: RunAutoOptions = {}, dependencies: AutoDependencies = {}): Promise<AutoRunResult> {
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? qlbHomeDir(env);
  const config = dependencies.config ?? resolveConfig({ env, home });
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? ((line: string) => console.error(line));
  const result: AutoRunResult = { ticks: 0, decisions: [], executed: [] };

  if (options.dryRun) {
    const binding = await (dependencies.makeDryBinding?.() ?? productionDryBinding(config, now));
    try {
      const admissionStore = { dbPath: config.dbPath } as Store;
      const admission = dependencies.assertAdmitted
        ? dependencies.assertAdmitted(admissionStore, 'auto:dry-run')
        : binding.admit?.() ?? assertAdmitted(admissionStore, 'auto:dry-run');
      if (!admission.ok) throw new AutoAdmissionRefused(admission.code ?? 'not-admitted');
      const tick = await binding.tick();
      result.ticks = 1;
      result.decisions.push(tick.decision);
      redactedLog(log, `auto: ${decisionText(tick)}`);
      return result;
    } finally { binding.close(); }
  }

  const binding = await (dependencies.makeLiveBinding?.() ?? productionLiveBinding({ env, home, config, now, log }));
  let stopping = false;
  let sleepTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeSleep: (() => void) | undefined;
  const clearSleep = dependencies.clearTimeout ?? globalThis.clearTimeout;
  const onTerm = (): void => {
    stopping = true;
    if (sleepTimer !== undefined) {
      clearSleep(sleepTimer);
      sleepTimer = undefined;
      wakeSleep?.();
      wakeSleep = undefined;
    }
  };
  let stopError: Error | undefined;
  const observeStop = (): Error | undefined => {
    const error = dependencies.stopIf?.();
    if (error !== undefined) {
      stopError ??= error;
      onTerm();
    }
    return stopError;
  };
  dependencies.stopWhen?.then((error) => {
    stopError ??= error;
    onTerm();
  });
  const signals = dependencies.signals ?? process;
  signals.on('SIGTERM', onTerm);
  try {
    // Let an already-resolved stop promise run before the first loop iteration.
    await Promise.resolve();
    do {
      if (observeStop() !== undefined) break;
      try {
        const admission = (dependencies.assertAdmitted ?? assertAdmitted)(binding.store as Store, 'switch:auto');
        if (!admission.ok) throw new AutoAdmissionRefused(admission.code ?? 'not-admitted');
        let cswapAlive = false;
        try { cswapAlive = resolveCswapCheck(dependencies.listCswapProcesses, env)().length > 0; } catch { cswapAlive = true; }
        if (cswapAlive) {
          binding.store.setConfig('auto.heartbeatAt', String(now()));
          result.ticks += 1;
          redactedLog(log, 'auto: stay(cswap-alive)');
        } else {
          await binding.reconcile();
          if (observeStop() !== undefined) break;
          const accounts = await binding.poll();
          // This is the final point before a tick that can switch credentials.
          if (observeStop() !== undefined) break;
          const tick = await binding.tick(accounts);
          binding.store.setConfig('auto.heartbeatAt', String(now()));
          result.ticks += 1;
          result.decisions = [tick.decision];
          if (tick.switchResult?.outcome === 'ok') result.executed.push(tick.switchResult.to);
          redactedLog(log, `auto: ${decisionText(tick)}`);
        }
      } catch (error) {
        if (error instanceof AutoAdmissionRefused) throw error;
        redactedLog(log, `auto: tick error: ${redactError(error, [])}`);
      }
      if (options.once || stopping) break;
      await new Promise<void>((resolve) => {
        wakeSleep = resolve;
        sleepTimer = (dependencies.setTimeout ?? globalThis.setTimeout)(() => {
          sleepTimer = undefined;
          wakeSleep = undefined;
          resolve();
        }, INTERVAL_MS) as ReturnType<typeof setTimeout>;
      });
    } while (!stopping);
    if (stopError !== undefined) throw stopError;
    return result;
  } finally {
    signals.removeListener('SIGTERM', onTerm);
    binding.close();
  }
}
