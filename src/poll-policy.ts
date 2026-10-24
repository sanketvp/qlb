// Ported from claude-swap 0.26.0 (MIT, Copyright (c) realiti4) — poll_policy.py

/** Freshness floor shared by every collector. */
export const SERVE_TTL_S = 180.0;
/** Normal cadence floor. */
export const MIN_INTERVAL_S = 180.0;
/** Active, near-threshold, moving accounts only. */
export const URGENT_INTERVAL_S = 60.0;
export const ACTIVE_MAX_INTERVAL_S = 300.0;
export const CANDIDATE_DEFAULT_INTERVAL_S = 300.0;
export const CANDIDATE_MAX_INTERVAL_S = 600.0;
export const EXHAUSTED_INTERVAL_S = 600.0;
export const MOVEMENT_DELTA_PCT = 1.0;
export const JITTER_FRAC = 0.1;
export const EDGE_BACKOFF_S = 300.0;
export const POST_429_MIN_INTERVAL_S = 360.0;
export const RECENT_429_WINDOW_S = 3600.0;
export const POST_429_BACKOFF_MULT = 1.5;
export const POST_429_MAX_INTERVAL_S = 1800.0;
export const ESCALATION_MARGIN_PCT = 15.0;
export const RESET_SLACK_S = 60.0;

export type Usage = Record<string, unknown>;
export type RandomSource = () => number;

type RelevantWindow = readonly [label: string, pct: number, resetsAt: unknown];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** C-swap oauth.relevant_windows(), kept local so this policy is pure. */
export function relevantWindows(usage: Usage | null | undefined, models: readonly string[] = []): RelevantWindow[] {
  if (!usage) return [];
  const windows: RelevantWindow[] = [];
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']] as const) {
    const window = record(usage[key]);
    if (window && typeof window.pct === 'number') {
      windows.push([label, window.pct, window.resets_at]);
    }
  }
  if (models.length > 0) {
    const wanted = new Set(models.map((model) => model.toLowerCase()));
    const matchAll = wanted.has('all');
    const scoped = usage.scoped;
    if (Array.isArray(scoped)) {
      for (const value of scoped) {
        const window = record(value);
        if (
          window
          && typeof window.pct === 'number'
          && typeof window.name === 'string'
          && (matchAll || wanted.has(window.name.toLowerCase()))
        ) {
          windows.push([window.name, window.pct, window.resets_at]);
        }
      }
    }
  }
  return windows;
}

/** C-swap oauth.account_headroom(). */
export function accountHeadroom(usage: Usage | null | undefined, models: readonly string[] = []): number | null {
  const pcts = relevantWindows(usage, models).map(([, pct]) => pct);
  return pcts.length === 0 ? null : 100.0 - Math.max(...pcts);
}

/** Utilization of the binding relevant window, or null when usage is unknown. */
export function bindingPct(usage: Usage | null | undefined, models: readonly string[] = []): number | null {
  const headroom = accountHeadroom(usage, models);
  return headroom === null ? null : 100.0 - headroom;
}

/** Parse an API reset timestamp to epoch seconds, like poll_policy.parse_reset_ts(). */
export function parseResetTs(resetsAt: unknown): number | null {
  if (!resetsAt) return null;
  const timestamp = Date.parse(String(resetsAt).replaceAll('Z', '+00:00'));
  return Number.isNaN(timestamp) ? null : timestamp / 1000;
}

/** Epoch when the last exhausted relevant window resets. */
export function limitingResetTs(usage: Usage | null | undefined, models: readonly string[] = []): number | null {
  let latest: number | null = null;
  for (const [, pct, resetsAt] of relevantWindows(usage, models)) {
    if (pct < 100.0) continue;
    const timestamp = parseResetTs(resetsAt);
    if (timestamp !== null && (latest === null || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

/** Epoch of the earliest future relevant-window reset, at any utilization. */
export function earliestFutureResetTs(
  usage: Usage | null | undefined,
  now: number,
  models: readonly string[] = [],
): number | null {
  let earliest: number | null = null;
  for (const [, , resetsAt] of relevantWindows(usage, models)) {
    const timestamp = parseResetTs(resetsAt);
    if (timestamp !== null && timestamp > now && (earliest === null || timestamp < earliest)) {
      earliest = timestamp;
    }
  }
  return earliest;
}

export interface PollPlanInput {
  prevIntervalS: number | null | undefined;
  prevUsage: Usage | null | undefined;
  newUsage: Usage | null | undefined;
  isActive: boolean;
  threshold: number;
  models: readonly string[];
  recent429: boolean;
  now: number;
  rng?: RandomSource;
}

/**
 * Return [nextPollAt, intervalS] after a successful usage fetch.
 *
 * The clock and randomness are supplied by the caller, keeping the policy
 * deterministic and side-effect free.
 */
export function planAfterFetch({
  prevIntervalS,
  prevUsage,
  newUsage,
  isActive,
  threshold,
  models,
  recent429,
  now,
  rng = Math.random,
}: PollPlanInput): [nextPollAt: number, intervalS: number] {
  const defaultInterval = isActive ? MIN_INTERVAL_S : CANDIDATE_DEFAULT_INTERVAL_S;
  const ceiling = isActive ? ACTIVE_MAX_INTERVAL_S : CANDIDATE_MAX_INTERVAL_S;
  const base = prevIntervalS || defaultInterval;
  const prevPct = bindingPct(prevUsage, models);
  const newPct = bindingPct(newUsage, models);
  let moving: boolean;
  let interval: number;
  if (prevPct === null || newPct === null) {
    moving = false;
    interval = defaultInterval;
  } else if (Math.abs(newPct - prevPct) >= MOVEMENT_DELTA_PCT) {
    moving = true;
    interval = Math.max(MIN_INTERVAL_S, base / 2);
  } else {
    moving = false;
    interval = Math.min(ceiling, Math.max(MIN_INTERVAL_S, base * 1.5));
  }
  if (
    isActive
    && moving
    && !recent429
    && newPct !== null
    && newPct >= threshold - ESCALATION_MARGIN_PCT
  ) {
    interval = URGENT_INTERVAL_S;
  }
  if (recent429) {
    const increased = Math.max(base * POST_429_BACKOFF_MULT, POST_429_MIN_INTERVAL_S);
    interval = Math.min(POST_429_MAX_INTERVAL_S, Math.max(interval, increased));
  }

  const headroom = accountHeadroom(newUsage, models);
  if (headroom !== null && headroom <= 0) interval = Math.max(interval, EXHAUSTED_INTERVAL_S);

  let nextPoll = now + interval * (1.0 + JITTER_FRAC * (2.0 * rng() - 1.0));
  if (headroom !== null && headroom <= 0) {
    const resetTs = limitingResetTs(newUsage, models);
    if (resetTs !== null && resetTs > now) nextPoll = Math.min(nextPoll, resetTs + RESET_SLACK_S);
  } else {
    const resetTs = earliestFutureResetTs(newUsage, now, models);
    if (resetTs !== null) nextPoll = Math.min(nextPoll, resetTs + RESET_SLACK_S);
  }
  return [nextPoll, interval];
}

// Python-name aliases make port provenance and cross-language comparisons explicit.
export const relevant_windows = relevantWindows;
export const account_headroom = accountHeadroom;
export const binding_pct = bindingPct;
export const parse_reset_ts = parseResetTs;
export const limiting_reset_ts = limitingResetTs;
export const earliest_future_reset_ts = earliestFutureResetTs;
export const plan_after_fetch = planAfterFetch;
