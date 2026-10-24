// Ported from claude-swap 0.26.0 (MIT, Copyright (c) realiti4) — autoswitch.py

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
  /** Deterministic candidate tie-breaker; lower wins. */
  slotNum?: number;
  /** Used only when no slot number is available; earlier wins. */
  addedAtMs?: number;
}

export interface AutoswitchSettings {
  threshold: number;
  hysteresisPct: number;
  cooldownSeconds: number;
  unhealthyTicks: number;
}

// C-swap defaults: settings.py:46-52.
export const DEFAULT_AUTOSWITCH_SETTINGS: Readonly<AutoswitchSettings> = {
  threshold: 90,
  hysteresisPct: 10,
  cooldownSeconds: 300,
  unhealthyTicks: 3,
};

export interface AutoswitchInput {
  accounts: readonly AutoswitchAccount[];
  activeAccountId: string | null;
  nowMs: number;
  settings?: Partial<AutoswitchSettings>;
  /** Provider-side hard-limit signal, even when the last usage number is stale. */
  providerReportedLimit?: boolean;
  /** Timestamp of the prior successful automatic switch. */
  lastSwitchAtMs?: number;
  /** Consecutive ticks whose active usage could not be decided. */
  unhealthyTicks?: number;
  /** Persisted reset that was already used for a parked switch, if any. */
  parkedUntilMs?: number;
}

type StayReason =
  | 'below-threshold'
  | 'cooldown'
  | 'unknown'
  | 'no-active-account'
  | 'no-candidates'
  | 'no-comparison'
  | 'no-qualifying-candidate';

export interface AutoswitchStayDecision {
  kind: 'stay';
  reason: StayReason;
  unhealthyTicks: number;
}

export interface AutoswitchSwitchDecision {
  kind: 'switch';
  targetId: string;
  reason: 'proactive' | 'at-limit' | 'failover' | 'parked';
  unhealthyTicks: number;
  /** Present only for the all-exhausted parked transition. */
  parkedUntilMs?: number;
}

export interface AutoswitchParkedDecision {
  kind: 'parked';
  accountId: string;
  /** Undefined when usage reported no usable future reset. */
  resetAtMs?: number;
  unhealthyTicks: number;
  parkedUntilMs?: number;
}

export type AutoswitchDecision =
  | AutoswitchStayDecision
  | AutoswitchSwitchDecision
  | AutoswitchParkedDecision;

type Trigger = 'proactive' | 'at-limit' | 'failover';

interface RankedAccount {
  account: AutoswitchAccount;
  binding: number;
  index: number;
}

/**
 * The worst reported window binds an account. Missing/unknown windows do not
 * add a fabricated zero; an account is unknown only when it has no numeric
 * window at all. This mirrors C-swap's account_headroom/binding_pct path
 * (autoswitch.py:621-630; poll_policy.py:150-153).
 */
export function bindingPct(account: AutoswitchAccount): number | null {
  let binding: number | null = null;
  for (const bucket of Object.values(account.buckets)) {
    if (typeof bucket.usedPct !== 'number' || !Number.isFinite(bucket.usedPct)) continue;
    binding = binding === null ? bucket.usedPct : Math.max(binding, bucket.usedPct);
  }
  return binding;
}

function settingsFor(input: AutoswitchInput): AutoswitchSettings {
  return { ...DEFAULT_AUTOSWITCH_SETTINGS, ...input.settings };
}

function sortedByBest(accounts: RankedAccount[]): RankedAccount[] {
  return [...accounts].sort((a, b) => {
    const headroomOrder = a.binding - b.binding;
    if (headroomOrder !== 0) return headroomOrder;
    const slotOrder = (a.account.slotNum ?? Infinity) - (b.account.slotNum ?? Infinity);
    if (slotOrder !== 0) return slotOrder;
    const addedOrder = (a.account.addedAtMs ?? Infinity) - (b.account.addedAtMs ?? Infinity);
    if (addedOrder !== 0) return addedOrder;
    return a.index - b.index;
  });
}

function earliestFutureReset(account: AutoswitchAccount, nowMs: number): number | undefined {
  let earliest: number | undefined;
  for (const bucket of Object.values(account.buckets)) {
    const reset = bucket.resetAt;
    if (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= nowMs) continue;
    if (earliest === undefined || reset < earliest) earliest = reset;
  }
  return earliest;
}

function parkedDecision(
  accounts: readonly AutoswitchAccount[],
  input: AutoswitchInput,
  unhealthyTicks: number,
): AutoswitchDecision {
  const ranked = accounts
    .map((account, index) => ({ account, index, resetAtMs: earliestFutureReset(account, input.nowMs) }))
    .sort((a, b) => {
      const resetOrder = (a.resetAtMs ?? Infinity) - (b.resetAtMs ?? Infinity);
      if (resetOrder !== 0) return resetOrder;
      const slotOrder = (a.account.slotNum ?? Infinity) - (b.account.slotNum ?? Infinity);
      if (slotOrder !== 0) return slotOrder;
      const addedOrder = (a.account.addedAtMs ?? Infinity) - (b.account.addedAtMs ?? Infinity);
      if (addedOrder !== 0) return addedOrder;
      return a.index - b.index;
    });
  const target = ranked[0];
  // This function is called only for a non-empty non-dead account set.
  if (!target) return { kind: 'stay', reason: 'no-candidates', unhealthyTicks };

  const parked = {
    kind: 'parked' as const,
    accountId: target.account.accountId,
    ...(target.resetAtMs === undefined ? {} : { resetAtMs: target.resetAtMs, parkedUntilMs: target.resetAtMs }),
    unhealthyTicks,
  };
  // §4.3 permits at most one parked switch for one reset. Retain/report the
  // parked condition rather than issuing a duplicate switch command.
  if (
    target.account.accountId === input.activeAccountId ||
    (target.resetAtMs !== undefined && target.resetAtMs === input.parkedUntilMs)
  ) {
    return parked;
  }
  return {
    kind: 'switch',
    targetId: target.account.accountId,
    reason: 'parked',
    ...(target.resetAtMs === undefined ? {} : { parkedUntilMs: target.resetAtMs }),
    unhealthyTicks,
  };
}

/**
 * Decide one auto-switch tick without I/O or mutation.
 *
 * C-swap counts unreadable active usage before failover and gates proactive
 * moves on cooldown (autoswitch.py:1035-1051). Its ordinary candidate path
 * selects greatest headroom and applies the proactive landing/hysteresis bar
 * while at-limit and failover escape it (autoswitch.py:1826-1915; 1404-1406).
 * QLB adds the spec §4.3 all-exhausted parked outcome using the same pure
 * account snapshot rather than C-swap's scheduler/event side effects.
 */
export function decideAutoswitch(input: AutoswitchInput): AutoswitchDecision {
  const settings = settingsFor(input);
  const active = input.activeAccountId === null
    ? undefined
    : input.accounts.find((account) => account.accountId === input.activeAccountId);
  if (!active) return { kind: 'stay', reason: 'no-active-account', unhealthyTicks: 0 };

  const activeBinding = active.dead ? null : bindingPct(active);
  let unhealthyTicks = input.unhealthyTicks ?? 0;
  let trigger: Trigger;
  if (activeBinding === null) {
    unhealthyTicks += 1;
    if (unhealthyTicks < settings.unhealthyTicks) {
      return { kind: 'stay', reason: 'unknown', unhealthyTicks };
    }
    trigger = 'failover';
  } else {
    unhealthyTicks = 0;
    if (input.providerReportedLimit === true || activeBinding >= 100) trigger = 'at-limit';
    else if (activeBinding >= settings.threshold) trigger = 'proactive';
    else return { kind: 'stay', reason: 'below-threshold', unhealthyTicks };
  }

  // C-swap's cooldown is intentionally limited to proactive/consume-first
  // paths (autoswitch.py:1049-1051); at-limit and failover must escape now.
  if (
    trigger === 'proactive' &&
    typeof input.lastSwitchAtMs === 'number' &&
    input.nowMs - input.lastSwitchAtMs < settings.cooldownSeconds * 1000
  ) {
    return { kind: 'stay', reason: 'cooldown', unhealthyTicks };
  }

  const available = input.accounts.filter((account) => !account.dead);
  const candidates = available
    .map((account, index) => ({ account, index, binding: bindingPct(account) }))
    .filter((entry): entry is RankedAccount =>
      entry.account.accountId !== active.accountId && entry.binding !== null,
    );

  let qualifying = candidates.filter((candidate) => candidate.binding < 100);
  if (trigger === 'proactive' && activeBinding !== null) {
    qualifying = qualifying.filter((candidate) =>
      candidate.binding < settings.threshold &&
      candidate.binding <= activeBinding - settings.hysteresisPct,
    );
  }
  const best = sortedByBest(qualifying)[0];
  if (best) {
    return {
      kind: 'switch',
      targetId: best.account.accountId,
      reason: trigger,
      unhealthyTicks,
    };
  }

  // An exhausted fleet is proven only when every non-dead account is known
  // and at 100%. Unknown or merely hysteresis-rejected accounts can recover
  // before a claimed reset, so they remain ordinary stays (C-swap's
  // all-exhausted proof and reset calculation: autoswitch.py:1295-1334,
  // 2226-2260).
  const allExhausted = available.length > 0 && available.every((account) => {
    const binding = bindingPct(account);
    return binding !== null && binding >= 100;
  });
  if (allExhausted) return parkedDecision(available, input, unhealthyTicks);

  const allCandidates = available.filter((account) => account.accountId !== active.accountId);
  if (allCandidates.length === 0) return { kind: 'stay', reason: 'no-candidates', unhealthyTicks };
  if (candidates.length === 0) return { kind: 'stay', reason: 'no-comparison', unhealthyTicks };
  return { kind: 'stay', reason: 'no-qualifying-candidate', unhealthyTicks };
}
