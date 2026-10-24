// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — poll_policy.py lines 73–284; lines.py lines 39–45; usage_store.py lines 439–491.

/** Freshness floor shared by every collector. */
export const SERVE_TTL_S = 180.0;
/** Normal cadence floor. */
export const MIN_INTERVAL_S = 180.0;
/** Active accounts with a relevant window rising into its own switch-line band. */
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

/** Scheduling state needed to decide which candidate slot is due next. */
export interface DueCandidateSlot {
  lastFetchAt?: number | null;
  lastAttemptAt?: number | null;
  nextDueAt?: number | null;
  pollIntervalS?: number | null;
  backoffUntil?: number | null;
}

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

/**
 * Parse an API reset timestamp to epoch seconds, like poll_policy.parse_reset_ts().
 *
 * This intentionally recognizes the datetime.fromisoformat() grammar rather
 * than Date.parse(): the latter accepts non-ISO text and truncates fractional
 * seconds to milliseconds.  The fractional component below is retained as
 * microseconds, so reset ordering keeps Python's precision without relying on
 * JavaScript Date's millisecond representation.
 */
export function parseResetTs(resetsAt: unknown): number | null {
  if (!resetsAt) return null;
  let value = String(resetsAt).replaceAll('Z', '+00:00');
  const basicWeek = /^(\d{4})W(\d{2})(\d)?([\s\S].*)?$/u.exec(value);
  if (basicWeek) {
    // Do not let an incomplete basic time (W28-6) become an extended weekday.
    if (!basicWeek[3] && /^-\d(?!\d)/u.test(basicWeek[4] ?? '')) return null;
    value = `${basicWeek[1]}-W${basicWeek[2]}${basicWeek[3] ? `-${basicWeek[3]}` : ''}${basicWeek[4] ?? ''}`;
  }
  const match = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2})|(\d{4})-W(\d{2})(?:-(\d))?)(?:[\s\S](\d{2})(?:(:)?(\d{2}))?(?:(:)?(\d{2}))?([.,]\d*)?(?:[\s\S]?(?<offset>[+-])(\d{2})(?:(:)?(\d{2}))?(?:(:)?(\d{2}))?([.,]\d+)?)?)?$/u.exec(value);
  if (!match) return null;

  let year: number;
  let month: number;
  let day: number;
  if (match[1] !== undefined) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if (match[4] !== undefined) {
    year = Number(match[4]);
    month = Number(match[5]);
    day = Number(match[6]);
  } else {
    year = Number(match[7]);
    const week = Number(match[8]);
    const weekDay = Number(match[9] ?? 1);
    if (week < 1 || week > 53 || weekDay < 1 || weekDay > 7) return null;
    const jan4 = new Date(0);
    jan4.setUTCFullYear(year, 0, 4);
    const weekStart = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000;
    const date = new Date(weekStart + ((week - 1) * 7 + weekDay - 1) * 86_400_000);
    const thursday = new Date(weekStart + ((week - 1) * 7 + 3) * 86_400_000);
    if (thursday.getUTCFullYear() !== year) return null;
    year = date.getUTCFullYear();
    month = date.getUTCMonth() + 1;
    day = date.getUTCDate();
  }

  const hour = Number(match[10] ?? 0);
  const minute = Number(match[12] ?? 0);
  const second = Number(match[14] ?? 0);
  const fractionText = match[15] ?? '';
  const fraction = Number(`0.${fractionText.slice(1, 7).padEnd(6, '0')}`);
  const offsetSign = match.groups?.offset;
  const offsetHour = Number(match[17] ?? 0);
  const offsetMinute = Number(match[19] ?? 0);
  const offsetSecond = Number(match[21] ?? 0);
  const offsetFraction = Number(`0.${(match[22] ?? '').slice(1, 7).padEnd(6, '0')}`);
  const offset = offsetHour * 3600 + offsetMinute * 60 + offsetSecond;
  if (
    (match[14] !== undefined && ((match[11] === undefined) !== (match[13] === undefined)))
    || (match[21] !== undefined && ((match[18] === undefined) !== (match[20] === undefined)))
    || (fractionText.length === 1 && offsetSign === undefined)
    || year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59
    || offset >= 86_400
  ) return null;

  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  if (
    utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day
  ) return null;
  const timestamp = utc.getTime() / 1000 + fraction;
  if (offsetSign === undefined) {
    const local = new Date(0);
    local.setFullYear(year, month - 1, day);
    local.setHours(hour, minute, second, 0);
    if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) return null;
    return local.getTime() / 1000 + fraction;
  }
  // datetime.timezone normalizes a fractional zero offset to UTC.
  const offsetWithFraction = offset === 0 ? 0 : offset + offsetFraction;
  return timestamp + (offsetSign === '+' ? -offsetWithFraction : offsetWithFraction);
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
  weeklyThreshold?: number | null;
  models: readonly string[];
  recent429: boolean;
  now: number;
  rng?: RandomSource;
}

/** C-swap lines.window_line(): weekly line for all but the 5h window. */
function windowLine(label: string, threshold: number, weeklyThreshold: number | null | undefined): number {
  return weeklyThreshold === null || weeklyThreshold === undefined || label === '5h'
    ? threshold
    : weeklyThreshold;
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
  weeklyThreshold = null,
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
  // Match C-swap per label, rising only: urgency is independent from the
  // raw-max movement calculation above.
  const previousPcts = new Map(relevantWindows(prevUsage, models).map(([label, pct]) => [label, pct]));
  const risingInBand = relevantWindows(newUsage, models).some(([label, pct]) => {
    const previousPct = previousPcts.get(label);
    return previousPct !== undefined
      && pct - previousPct >= MOVEMENT_DELTA_PCT
      && pct >= windowLine(label, threshold, weeklyThreshold) - ESCALATION_MARGIN_PCT;
  });
  if (isActive && risingInBand && !recent429) {
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

/** C-swap usage_store._plan_oversleeps_interval(), exposed for parity. */
export function planOversleepsInterval(
  nextPollAt: number | null | undefined,
  pollIntervalS: number | null | undefined,
  now: number,
): boolean {
  if (nextPollAt === null || nextPollAt === undefined) return false;
  const interval = Math.max(pollIntervalS || EXHAUSTED_INTERVAL_S, EXHAUSTED_INTERVAL_S);
  const latestNormalPoll = now + interval * (1.0 + JITTER_FRAC) + RESET_SLACK_S;
  return nextPollAt > latestNormalPoll;
}

/**
 * Return the due candidate least recently attempted or measured, or null.
 *
 * A slot remains ineligible until its backoff and planned due time have both
 * elapsed. Among eligible slots, max(lastFetchAt, lastAttemptAt) rotates a
 * slot that repeatedly fails without producing a measurement behind other due
 * slots, matching usage_store.py's starvation protection.
 */
export function dueCandidate(
  candidates: readonly string[],
  entries: Readonly<Record<string, DueCandidateSlot>>,
  now: number,
): string | null {
  const due: Array<[lastTouchedAt: number, slot: string]> = [];
  for (const slot of candidates) {
    const entry = entries[slot];
    if (entry === undefined) {
      due.push([0, slot]);
      continue;
    }
    if (entry.backoffUntil !== null && entry.backoffUntil !== undefined && now < entry.backoffUntil) {
      continue;
    }
    if (
      entry.nextDueAt !== null
      && entry.nextDueAt !== undefined
      && now < entry.nextDueAt
      && !planOversleepsInterval(entry.nextDueAt, entry.pollIntervalS, now)
    ) {
      continue;
    }
    due.push([Math.max(entry.lastFetchAt || 0, entry.lastAttemptAt || 0), slot]);
  }
  due.sort(([leftTouchedAt, leftSlot], [rightTouchedAt, rightSlot]) => {
    if (leftTouchedAt !== rightTouchedAt) return leftTouchedAt - rightTouchedAt;
    return leftSlot < rightSlot ? -1 : leftSlot > rightSlot ? 1 : 0;
  });
  return due[0]?.[1] ?? null;
}

// Python-name aliases make port provenance and cross-language comparisons explicit.
export const relevant_windows = relevantWindows;
export const account_headroom = accountHeadroom;
export const binding_pct = bindingPct;
export const parse_reset_ts = parseResetTs;
export const limiting_reset_ts = limitingResetTs;
export const earliest_future_reset_ts = earliestFutureResetTs;
export const plan_oversleeps_interval = planOversleepsInterval;
export const plan_after_fetch = planAfterFetch;
