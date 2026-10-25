// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — autoswitch.py

import { bindingWindow, type BindingWindow } from './lines';

/** A decision-only projection of an account usage window. */
export interface AutoswitchBucket {
  usedPct: number | null;
  resetAt?: number;
}

/** Input account state; callers own all persistence and switching I/O. */
export interface AutoswitchAccount {
  accountId: string;
  buckets: Record<string, AutoswitchBucket>;
  dead?: boolean;
  /** Imported per-account switch-line override (D-R7). */
  threshold?: number;
  weeklyThreshold?: number | null;
  /** Deterministic candidate tie-breaker; lower wins. */
  slotNum?: number;
  /** Used only when no slot number is available; earlier wins. */
  addedAtMs?: number;
}

export interface AutoswitchSettings {
  threshold: number;
  weeklyThreshold?: number | null;
  hysteresisPct: number;
  cooldownSeconds: number;
  unhealthyTicks: number;
  strategy?: 'best' | 'consume-first';
}

export const DEFAULT_AUTOSWITCH_SETTINGS: Readonly<AutoswitchSettings> = {
  threshold: 90,
  weeklyThreshold: null,
  hysteresisPct: 10,
  cooldownSeconds: 300,
  unhealthyTicks: 3,
  strategy: 'best',
};

export interface AutoswitchBreakerRow {
  ts: number;
  trigger: string;
  outcome: string;
  automatic?: boolean;
  injected?: boolean;
}

export interface AutoswitchInput {
  accounts: readonly AutoswitchAccount[];
  activeAccountId: string | null;
  nowMs: number;
  settings?: Partial<AutoswitchSettings>;
  /** Provider-side hard-limit signal for the active account. */
  providerReportedLimit?: boolean;
  /** An active credential that Claude Code/Codex may renew while idle. */
  activeCredentialExpired?: boolean;
  idleHoldSinceMs?: number | null;
  /** Timestamp of the prior successful automatic switch. */
  lastSwitchAtMs?: number;
  /** Consecutive failed polls for this active account. */
  unhealthyTicks?: number;
  /** Persisted reset already used for a parked switch. */
  parkedUntilMs?: number | null;
  /** S45 state. */
  lastSwitchFrom?: string | null;
  lastSwitchTo?: string | null;
  leftHeadroom?: number | null;
  leftRecoveryAtMs?: number | null;
  leftTrigger?: Trigger | 'parked' | null;
  /** S14 state and rows, supplied by the loop/store. */
  suspendedUntilMs?: number | null;
  lastSuspensionEndMs?: number | null;
  lastResumeAtMs?: number | null;
  breakerRows?: readonly AutoswitchBreakerRow[];
  /** S15 gate. */
  provider?: 'anthropic' | 'openai-codex';
  codexL13VerifiedAtMs?: number | null;
  /** Testable projection of the otherwise opt-in consume-first policy. */
  requestedTrigger?: 'consume-first';
}

type StayReason =
  | 'below-threshold'
  | 'cooldown'
  | 'unknown'
  | 'active-idle'
  | 'no-active-account'
  | 'no-candidates'
  | 'no-comparison'
  | 'no-qualifying-candidate'
  | 'reset-unknown'
  | 'breaker'
  | 'codex-l13-unverified';

export interface AutoswitchStayDecision {
  kind: 'stay';
  reason: StayReason;
  unhealthyTicks: number;
  idleHoldSinceMs?: number;
  suspendedUntilMs?: number;
}

export interface AutoswitchSwitchDecision {
  kind: 'switch';
  targetId: string;
  reason: Trigger | 'parked';
  unhealthyTicks: number;
  parkedUntilMs?: number;
  /** S45 fields to persist only after the executor succeeds. */
  leftHeadroom: number | null;
  leftRecoveryAtMs: number | null;
  leftTrigger: Trigger | 'parked';
}

export interface AutoswitchParkedDecision {
  kind: 'parked';
  accountId: string;
  resetAtMs: number;
  unhealthyTicks: number;
  parkedUntilMs?: number;
}

export type AutoswitchDecision = AutoswitchStayDecision | AutoswitchSwitchDecision | AutoswitchParkedDecision;
type Trigger = 'proactive' | 'at-limit' | 'failover' | 'consume-first';

const IDLE_HOLD_MAX_MS = 30 * 60 * 1000;
const RECOVERY_HYSTERESIS_MS = 5 * 60 * 1000;
const RECOVERY_HORIZON_MS = 4 * 60 * 60 * 1000;
const HORIZON_HEADROOM_RATIO = 2;
const SPENT_HEADROOM_PCT = 3;

interface CensusAccount {
  account: AutoswitchAccount;
  index: number;
  rawHeadroom: number | null;
  binding: BindingWindow | undefined;
  recoveryAtMs: number | undefined;
  exhausted: boolean;
  hasRoom: boolean;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number | undefined, fallback: number, lo: number, hi: number, integer = false): number {
  if (!finite(value)) return fallback;
  const bounded = Math.min(Math.max(value, lo), hi);
  return integer ? Math.trunc(bounded) : bounded;
}

function settingsFor(input: AutoswitchInput): AutoswitchSettings {
  // Mirrors settings._clamped (settings.py:201-240): reject non-finite input,
  // clamp every range, then truncate the integer unhealthyTicks field.
  const requested = input.settings;
  const weekly = requested?.weeklyThreshold;
  return {
    threshold: clamp(requested?.threshold, 90, 50, 99.9),
    weeklyThreshold: weekly == null || !finite(weekly) ? null : clamp(weekly, 90, 50, 99.9),
    hysteresisPct: clamp(requested?.hysteresisPct, 10, 0, 50),
    cooldownSeconds: clamp(requested?.cooldownSeconds, 300, 0, 86400),
    unhealthyTicks: clamp(requested?.unhealthyTicks, 3, 1, 100, true),
    strategy: requested?.strategy === 'consume-first' ? 'consume-first' : 'best',
  };
}

function optionalNumberOrder(a: number | undefined, b: number | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return a - b;
}

function accountOrder(a: CensusAccount, b: CensusAccount): number {
  const slotOrder = optionalNumberOrder(a.account.slotNum, b.account.slotNum);
  if (slotOrder !== 0) return slotOrder;
  const addedOrder = optionalNumberOrder(a.account.addedAtMs, b.account.addedAtMs);
  return addedOrder !== 0 ? addedOrder : a.index - b.index;
}

/** Raw max-window percentage, used for S38 physical exhaustion. */
export function bindingPct(account: AutoswitchAccount): number | null {
  let binding: number | null = null;
  for (const bucket of Object.values(account.buckets)) {
    if (!finite(bucket.usedPct)) continue;
    binding = binding === null ? bucket.usedPct : Math.max(binding, bucket.usedPct);
  }
  return binding;
}

function bindingFor(account: AutoswitchAccount, settings: AutoswitchSettings): BindingWindow | undefined {
  const threshold = clamp(account.threshold, settings.threshold, 50, 99.9);
  const weeklyRaw = account.weeklyThreshold === undefined ? settings.weeklyThreshold : account.weeklyThreshold;
  const weekly = weeklyRaw == null || !finite(weeklyRaw) ? undefined : clamp(weeklyRaw, threshold, 50, 99.9);
  const windows: Array<readonly [string, number, string | null | undefined]> = [];
  for (const [label, bucket] of Object.entries(account.buckets)) {
    if (!finite(bucket.usedPct)) continue;
    // Codex's primary/secondary adapters map to the same 5h/weekly lines.
    windows.push([label === 'primary' ? '5h' : label, bucket.usedPct, bucket.resetAt === undefined ? undefined : String(bucket.resetAt)]);
  }
  // lines.ts consumes strings because provider adapters parse ISO dates; retain
  // the numeric reset independently below so this pure engine needs no clock I/O.
  return bindingWindow(windows, threshold, weekly, { scale: settings.threshold });
}

function bindingRecovery(account: AutoswitchAccount, binding: BindingWindow | undefined, nowMs: number): number | undefined {
  if (!binding) return undefined;
  const reset = (account.buckets[binding.label] ?? (binding.label === '5h' ? account.buckets.primary : undefined))?.resetAt;
  return finite(reset) && reset > nowMs ? reset : undefined;
}

/** The last exhausted window to recover determines when an account is usable. */
function exhaustedRecovery(account: AutoswitchAccount, nowMs: number): number | undefined {
  const resets: number[] = [];
  for (const bucket of Object.values(account.buckets)) {
    if (!finite(bucket.usedPct) || bucket.usedPct < 100) continue;
    if (!finite(bucket.resetAt) || bucket.resetAt <= nowMs) return undefined;
    resets.push(bucket.resetAt);
  }
  return resets.length > 0 ? Math.max(...resets) : undefined;
}

function census(accounts: readonly AutoswitchAccount[], settings: AutoswitchSettings, nowMs: number, activeId: string, providerLimit: boolean, activeUsageUnknown = false): CensusAccount[] {
  return accounts.filter((account) => !account.dead).map((account, index) => {
    // §4.3 step 1: after an expired credential's idle hold, its cached
    // buckets are not a reading. Do not let stale known/exhausted state into
    // the S38 fleet proof.
    const unknownActive = activeUsageUnknown && account.accountId === activeId;
    const rawPct = unknownActive ? null : bindingPct(account);
    const binding = unknownActive ? undefined : bindingFor(account, settings);
    const known = rawPct !== null;
    const limited = account.accountId === activeId && providerLimit;
    return {
      account,
      index,
      rawHeadroom: rawPct === null ? null : 100 - rawPct,
      binding,
      recoveryAtMs: bindingRecovery(account, binding, nowMs),
      exhausted: known && (limited || rawPct >= 100),
      hasRoom: known && !limited && rawPct < 100,
    };
  });
}

/** Port of autoswitch.py:161-248. Either recovery inside the horizon matters. */
export function recoveryIsUseful(candidateRecoveryAtMs: number | undefined, activeRecoveryAtMs: number | undefined, activeHeadroom: number, bestCandidateHeadroom: number, nowMs: number): boolean {
  if (activeHeadroom <= SPENT_HEADROOM_PCT && bestCandidateHeadroom <= SPENT_HEADROOM_PCT) return true;
  return (candidateRecoveryAtMs !== undefined && candidateRecoveryAtMs - nowMs <= RECOVERY_HORIZON_MS)
    || (activeRecoveryAtMs !== undefined && activeRecoveryAtMs - nowMs <= RECOVERY_HORIZON_MS);
}

function noReturnRecovered(input: AutoswitchInput, left: CensusAccount | undefined, active: CensusAccount, nowMs: number): boolean {
  if (input.lastSwitchFrom == null || !Object.prototype.hasOwnProperty.call(input, 'leftHeadroom')) return true;
  if (!left) return false;
  const leftTrigger = input.leftTrigger;
  const failoverSnapshot = leftTrigger === 'failover'
    || (leftTrigger == null && input.leftHeadroom === null && input.leftRecoveryAtMs === null);
  if (failoverSnapshot) {
    if (left.binding && !left.binding.over) return true;
    const activeRecovery = active.recoveryAtMs ?? Number.POSITIVE_INFINITY;
    const peerRecovery = left.recoveryAtMs ?? Number.POSITIVE_INFINITY;
    return (Number.isFinite(activeRecovery) || peerRecovery - nowMs <= RECOVERY_HORIZON_MS)
      && peerRecovery < activeRecovery - RECOVERY_HYSTERESIS_MS;
  }
  const h = left.rawHeadroom;
  const activeH = active.rawHeadroom;
  if (h !== null && activeH !== null && h > activeH * HORIZON_HEADROOM_RATIO + SPENT_HEADROOM_PCT) return true;
  if (finite(input.leftHeadroom) && h !== null && h >= Math.min(input.leftHeadroom + SPENT_HEADROOM_PCT, 100)) return true;
  const prior = finite(input.leftRecoveryAtMs) ? input.leftRecoveryAtMs : Number.POSITIVE_INFINITY;
  const recovery = left.recoveryAtMs ?? Number.POSITIVE_INFINITY;
  return recovery < prior - RECOVERY_HYSTERESIS_MS;
}

function noReturnAccount(input: AutoswitchInput, trigger: Trigger, all: CensusAccount[], active: CensusAccount, nowMs: number): { barred?: string; recovered: boolean } {
  if ((trigger !== 'proactive' && trigger !== 'consume-first') || input.lastSwitchFrom == null) return { recovered: true };
  if (input.lastSwitchTo != null && String(input.lastSwitchTo) !== active.account.accountId) return { recovered: true };
  const left = all.find((item) => item.account.accountId === String(input.lastSwitchFrom));
  const recovered = noReturnRecovered(input, left, active, nowMs);
  if (!recovered) return { barred: String(input.lastSwitchFrom), recovered };
  if (left?.rawHeadroom !== null && left?.rawHeadroom !== undefined) {
    if (active.rawHeadroom !== null && left.rawHeadroom >= active.rawHeadroom * HORIZON_HEADROOM_RATIO) return { recovered };
    if (active.rawHeadroom === null && left.binding && !left.binding.over) return { recovered };
  }
  return { barred: String(input.lastSwitchFrom), recovered };
}

interface RankResult { ordered: CensusAccount[]; anyKnown: boolean; }

function weeklyReset(account: AutoswitchAccount, nowMs: number): number | undefined {
  const reset = account.buckets['7d']?.resetAt ?? account.buckets.weekly?.resetAt ?? account.buckets.secondary?.resetAt;
  return finite(reset) && reset > nowMs ? reset : undefined;
}

function rankCandidates(all: CensusAccount[], active: CensusAccount, trigger: Trigger, barred: string | undefined, settings: AutoswitchSettings, nowMs: number): RankResult {
  const candidates = all.filter((item) => item.account.accountId !== active.account.accountId);
  const measured = candidates.filter((item) => item.rawHeadroom !== null);
  const allAbove = active.binding?.over === true && measured.length > 0 && measured.every((item) => item.binding?.over === true);
  const bestCandidateHeadroom = Math.max(0, ...measured.map((item) => item.rawHeadroom ?? 0));
  const consumeFirst = settings.strategy === 'consume-first';
  const activeWeeklyReset = consumeFirst ? weeklyReset(active.account, nowMs) : undefined;
  const qualified: Array<{ item: CensusAccount; key: readonly number[] }> = [];
  const fallback: Array<{ item: CensusAccount; key: readonly number[] }> = [];
  for (const item of measured) {
    const h = item.rawHeadroom as number;
    if (h <= 0 || item.account.accountId === barred) continue;
    if (trigger === 'proactive' || trigger === 'consume-first') {
      if (!allAbove && item.binding?.over) continue;
      if (allAbove) {
        const recovery = item.recoveryAtMs ?? Number.POSITIVE_INFINITY;
        const activeRecovery = active.recoveryAtMs ?? Number.POSITIVE_INFINITY;
        const byRecovery = recoveryIsUseful(item.recoveryAtMs, active.recoveryAtMs, active.rawHeadroom ?? 0, bestCandidateHeadroom, nowMs);
        if (byRecovery) {
          if (recovery >= activeRecovery - RECOVERY_HYSTERESIS_MS) continue;
          qualified.push({ item, key: [0, recovery, -h] });
        } else if (h >= (active.rawHeadroom ?? 0) * HORIZON_HEADROOM_RATIO) {
          qualified.push({ item, key: [1, -h, recovery] });
        } else if ((active.rawHeadroom ?? 0) <= SPENT_HEADROOM_PCT && h >= (active.rawHeadroom ?? 0) && recovery < activeRecovery - RECOVERY_HYSTERESIS_MS) {
          fallback.push({ item, key: [0, recovery, -h] });
        }
        continue;
      }
      if (consumeFirst) {
        const reset = weeklyReset(item.account, nowMs);
        // Below the line, only burn quota that expires before the active's.
        if (trigger === 'consume-first' && (reset === undefined || activeWeeklyReset === undefined || reset >= activeWeeklyReset)) continue;
        qualified.push({ item, key: [reset ?? Number.POSITIVE_INFINITY, -(item.binding?.lineHeadroom ?? h)] });
        continue;
      }
      if (trigger === 'proactive' && active.binding && item.binding && item.binding.lineHeadroom - active.binding.lineHeadroom < settings.hysteresisPct) continue;
    }
    qualified.push({ item, key: consumeFirst
      ? [weeklyReset(item.account, nowMs) ?? Number.POSITIVE_INFINITY, -(item.binding?.lineHeadroom ?? h)]
      : allAbove ? [1, -h, item.recoveryAtMs ?? Number.POSITIVE_INFINITY] : [-(item.binding?.lineHeadroom ?? h)] });
  }
  const sortable = qualified.length > 0 ? qualified : fallback;
  sortable.sort((a, b) => {
    for (let i = 0; i < Math.max(a.key.length, b.key.length); i += 1) {
      const left = a.key[i] ?? 0;
      const right = b.key[i] ?? 0;
      // Python tuple ordering treats equal infinities as a tie and compares
      // the next field. Subtraction makes Infinity - Infinity NaN, which JS
      // sort treats as equality before accountOrder is reached.
      if (left === right) continue;
      const delta = left - right;
      if (!Number.isNaN(delta) && delta !== 0) return delta;
    }
    return accountOrder(a.item, b.item);
  });
  return { ordered: sortable.map(({ item }) => item), anyKnown: measured.length > 0 };
}

function parkedDecision(all: CensusAccount[], active: CensusAccount, input: AutoswitchInput, unhealthyTicks: number): AutoswitchDecision {
  const withReset = all.map((item) => ({ item, recoveryAtMs: exhaustedRecovery(item.account, input.nowMs) }))
    .filter((item): item is { item: CensusAccount; recoveryAtMs: number } => item.recoveryAtMs !== undefined);
  if (withReset.length === 0) return { kind: 'stay', reason: 'reset-unknown', unhealthyTicks };
  withReset.sort((a, b) => a.recoveryAtMs - b.recoveryAtMs || accountOrder(a.item, b.item));
  const target = withReset[0].item;
  const reset = withReset[0].recoveryAtMs;
  if (target.account.accountId === active.account.accountId || reset === input.parkedUntilMs) {
    return { kind: 'parked', accountId: target.account.accountId, resetAtMs: reset, unhealthyTicks, parkedUntilMs: reset };
  }
  return switchDecision(target, 'parked', active, unhealthyTicks, reset);
}

function switchDecision(target: CensusAccount, trigger: Trigger | 'parked', active: CensusAccount, unhealthyTicks: number, parkedUntilMs?: number): AutoswitchSwitchDecision {
  return {
    kind: 'switch', targetId: target.account.accountId, reason: trigger, unhealthyTicks, parkedUntilMs,
    leftHeadroom: active.rawHeadroom,
    leftRecoveryAtMs: active.recoveryAtMs ?? null,
    leftTrigger: trigger,
  };
}

function breakerDecision(input: AutoswitchInput, trigger: Trigger, unhealthyTicks: number): AutoswitchStayDecision | undefined {
  if (trigger !== 'failover' && trigger !== 'at-limit') return undefined;
  if (finite(input.suspendedUntilMs) && input.suspendedUntilMs > input.nowMs) {
    return { kind: 'stay', reason: 'breaker', unhealthyTicks, suspendedUntilMs: input.suspendedUntilMs };
  }
  const since = Math.max(input.nowMs - 3_600_000, input.lastSuspensionEndMs ?? Number.NEGATIVE_INFINITY, input.lastResumeAtMs ?? Number.NEGATIVE_INFINITY);
  const count = (input.breakerRows ?? []).filter((row) => row.ts > since && row.outcome === 'ok'
    && (row.trigger === 'failover' || row.trigger === 'at-limit') && row.automatic !== false && row.injected !== true).length;
  return count >= 3 ? { kind: 'stay', reason: 'breaker', unhealthyTicks, suspendedUntilMs: input.nowMs + 3_600_000 } : undefined;
}

/**
 * Decide one auto-switch tick without I/O or mutation. The caller persists
 * returned S45/S14/idle values only after its matching operation succeeds.
 */
export function decideAutoswitch(input: AutoswitchInput): AutoswitchDecision {
  const settings = settingsFor(input);
  const activeAccount = input.activeAccountId == null ? undefined : input.accounts.find((account) => account.accountId === input.activeAccountId);
  if (!activeAccount) return { kind: 'stay', reason: 'no-active-account', unhealthyTicks: 0 };

  const expiredPastIdleHold = input.activeCredentialExpired === true
    && finite(input.idleHoldSinceMs) && input.nowMs - input.idleHoldSinceMs >= IDLE_HOLD_MAX_MS;
  if (input.activeCredentialExpired) {
    const since = finite(input.idleHoldSinceMs) ? input.idleHoldSinceMs : input.nowMs;
    if (input.nowMs - since < IDLE_HOLD_MAX_MS) return { kind: 'stay', reason: 'active-idle', unhealthyTicks: 0, idleHoldSinceMs: since };
  }

  // S38 and §4.3 step 1 require known usage before provider-limit can change
  // the verdict or the fleet-exhausted proof. A dead active also follows the
  // ordinary unknown grace: upstream has no immediate-dead-active escape.
  const rawActive = activeAccount.dead || expiredPastIdleHold ? null : bindingPct(activeAccount);
  let unhealthyTicks = input.unhealthyTicks ?? 0;
  let trigger: Trigger;
  if (rawActive === null) {
    unhealthyTicks += 1;
    if (unhealthyTicks < settings.unhealthyTicks) return { kind: 'stay', reason: 'unknown', unhealthyTicks };
    trigger = 'failover';
  } else {
    unhealthyTicks = 0;
    if (input.providerReportedLimit === true || rawActive >= 100) trigger = 'at-limit';
    else {
      const activeBinding = bindingFor(activeAccount, settings);
      if ((settings.strategy === 'consume-first' || input.requestedTrigger === 'consume-first') && !activeBinding?.over) trigger = 'consume-first';
      else if (activeBinding?.over) trigger = 'proactive';
      else return { kind: 'stay', reason: 'below-threshold', unhealthyTicks };
    }
  }

  if ((trigger === 'proactive' || trigger === 'consume-first') && finite(input.lastSwitchAtMs) && input.nowMs - input.lastSwitchAtMs < settings.cooldownSeconds * 1000) {
    return { kind: 'stay', reason: 'cooldown', unhealthyTicks };
  }

  const all = census(
    input.accounts,
    settings,
    input.nowMs,
    activeAccount.accountId,
    input.providerReportedLimit === true && rawActive !== null,
    expiredPastIdleHold,
  );
  const active = all.find((item) => item.account.accountId === activeAccount.accountId);
  if (!active) {
    // A dead active is intentionally excluded from census but remains a valid
    // failover source; reconstruct only its S45 snapshot as unknown.
    const fallback: CensusAccount = { account: activeAccount, index: -1, rawHeadroom: null, binding: undefined, recoveryAtMs: undefined, exhausted: false, hasRoom: false };
    return decideWithCensus(input, settings, trigger, unhealthyTicks, all, fallback);
  }
  return decideWithCensus(input, settings, trigger, unhealthyTicks, all, active);
}

function decideWithCensus(input: AutoswitchInput, settings: AutoswitchSettings, trigger: Trigger, unhealthyTicks: number, all: CensusAccount[], active: CensusAccount): AutoswitchDecision {
  if (input.provider === 'openai-codex' && !finite(input.codexL13VerifiedAtMs)) return { kind: 'stay', reason: 'codex-l13-unverified', unhealthyTicks };

  const noReturn = noReturnAccount(input, trigger, all, active, input.nowMs);
  let ranked = rankCandidates(all, active, trigger, noReturn.barred, settings, input.nowMs);
  if (noReturn.barred && noReturn.recovered && ranked.ordered.length === 0) ranked = rankCandidates(all, active, trigger, undefined, settings, input.nowMs);
  if (ranked.ordered[0]) {
    // S14 applies only before a switch we could actually execute; a
    // no-candidate or parked outcome must not open the breaker.
    const breaker = breakerDecision(input, trigger, unhealthyTicks);
    if (breaker) return breaker;
    return switchDecision(ranked.ordered[0], trigger, active, unhealthyTicks);
  }

  // S38: only non-dead, known accounts count; unknown usage is never rounded
  // into an exhausted proof. Parking uses the soonest known binding reset.
  const fleetExhausted = all.length > 0 && all.every((item) => item.exhausted);
  if (fleetExhausted) return parkedDecision(all, active, input, unhealthyTicks);
  const peers = all.filter((item) => item.account.accountId !== active.account.accountId);
  if (peers.length === 0) return { kind: 'stay', reason: 'no-candidates', unhealthyTicks };
  if (!ranked.anyKnown) return { kind: 'stay', reason: 'no-comparison', unhealthyTicks };
  return { kind: 'stay', reason: 'no-qualifying-candidate', unhealthyTicks };
}
