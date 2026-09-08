export const OVERRIDE_KINDS = ['pin', 'reserve', 'drain-first'] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];

/** Default lifetime when `--until` is omitted (session-scoped pin / reserve / drain-first). */
export const DEFAULT_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000;

export function isOverrideKind(value: string | undefined): value is OverrideKind {
  return !!value && (OVERRIDE_KINDS as readonly string[]).includes(value);
}

/**
 * Parse `--until`: ISO datetime, or a duration like `2h`, `30m`, `1d`, `90s`.
 * When omitted, default to 24h from `now`.
 */
export function parseUntil(raw: string | undefined, now: number = Date.now()): number {
  if (raw == null || raw.length === 0) return now + DEFAULT_OVERRIDE_TTL_MS;
  const dur = /^(\d+)(ms|s|m|h|d)$/i.exec(raw.trim());
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2].toLowerCase();
    const ms =
      unit === 'ms' ? n
      : unit === 's' ? n * 1000
      : unit === 'm' ? n * 60_000
      : unit === 'h' ? n * 3_600_000
      : n * 86_400_000;
    return now + ms;
  }
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) {
    throw new Error(
      `invalid --until '${raw}': expected ISO datetime or duration like 2h, 30m, 1d`,
    );
  }
  return ts;
}

export function roundRobinConfigKey(provider: string): string {
  return `round-robin:${provider}`;
}

export function failoverConfigKey(provider: string): string {
  return `failover:${provider}`;
}
