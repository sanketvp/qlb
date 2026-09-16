import {
  DEFAULT_AUTH_JSON,
  DEFAULT_POOL_FILE,
  Migration,
  createSingleGrantMigration,
  createStaticKeyMigration,
  defaultOwnerFileFor,
  isMigrateProvider,
  isSingleGrantProvider,
  isStaticKeyProvider,
} from './migration';
import { platformKeychain } from './keychain';
import type { Store } from './store';
import type { AccountSnapshot, BucketReading } from './types';

export type HealthLevel = 'ok' | 'warn' | 'fail';
export type HealthGlyph = '✓' | '⚠' | '✗';

export interface AccountOverrideView {
  kind: string;
  session: string | null;
  until: number | null;
}

export interface DashboardAccount extends AccountSnapshot {
  ownership: string;
  override: AccountOverrideView | null;
  health: HealthLevel;
  healthGlyph: HealthGlyph;
}

export interface DashboardLookups {
  ownershipForProvider: (provider: string) => string;
  overrideForAccount: (accountId: string) => AccountOverrideView | null;
}

export function formatRelative(resetAt?: number, now: number = Date.now()): string {
  if (resetAt == null || !Number.isFinite(resetAt)) return '-';
  const deltaMs = resetAt - now;
  const absMs = Math.abs(deltaMs);
  const totalMins = Math.round(absMs / 60_000);
  let rel: string;
  if (totalMins < 1) {
    rel = '<1m';
  } else if (totalMins < 60) {
    rel = `${totalMins}m`;
  } else {
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    rel = mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
  }
  return deltaMs >= 0 ? `in ${rel}` : `${rel} ago`;
}

export function formatUsedPct(usedPct: number | null): string {
  return usedPct == null ? '—' : `${usedPct}%`;
}

const LOW_LEFT_PCT = 5;

export interface StatusDisplayRow {
  provider: string;
  label: string;
  window: string;
  rawKey: string | null;
  used: string;
  left: string;
  confidence: string;
  reset: string;
  marker: string;
  reported: boolean;
  exhausted: boolean;
  low: boolean;
  detail: string;
}

export function leftPct(usedPct: number | null | undefined): number | null {
  if (usedPct == null || !Number.isFinite(usedPct)) return null;
  return Math.min(100, Math.max(0, 100 - usedPct));
}

export function displayWindow(rawKey: string): string {
  return rawKey === 'weekly' ? '7d' : rawKey;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function formatPctNumber(n: number): string {
  if (!Number.isFinite(n)) return 'unknown';
  const rounded = Math.round(n * 10) / 10;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return `${normalized}%`;
}

export function formatCapacity(usedPct: number | null | undefined): {
  used: string;
  left: string;
  leftPct: number | null;
} {
  if (usedPct == null || !Number.isFinite(usedPct)) {
    return { used: 'unknown', left: 'unknown', leftPct: null };
  }
  const left = leftPct(usedPct)!;
  return {
    used: formatPctNumber(usedPct),
    left: formatPctNumber(left),
    leftPct: left,
  };
}

export function formatResetAtLocal(resetAt: number, now: number = Date.now()): string {
  const d = new Date(resetAt);
  const n = new Date(now);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const dayDelta = Math.round((startOfLocalDay(d) - startOfLocalDay(n)) / 86_400_000);
  if (dayDelta === 0) return `today ${time}`;
  if (dayDelta === 1) return `tomorrow ${time}`;
  if (dayDelta === -1) return `yesterday ${time}`;
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  if (Math.abs(dayDelta) < 7) return `${weekday} ${time}`;
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  return `${weekday} ${month} ${d.getDate()} ${time}`;
}

function isRollingWindow(window: string): boolean {
  return window === '5h' || window === '7d' || window === 'weekly' || window.startsWith('7d:');
}

export function formatResetClause(opts: {
  provider: string;
  window: string;
  usedPct: number | null | undefined;
  resetAt?: number;
  now?: number;
}): string {
  const now = opts.now ?? Date.now();
  if (opts.resetAt != null && Number.isFinite(opts.resetAt)) {
    return `resets ${formatRelative(opts.resetAt, now)} (${formatResetAtLocal(opts.resetAt, now)})`;
  }
  if (opts.usedPct === 0 && isRollingWindow(opts.window)) {
    return 'reset: window not started (no usage yet)';
  }
  return `reset: not reported by ${opts.provider}`;
}

function rawKeyForStandardWindow(
  buckets: AccountSnapshot['buckets'],
  window: '5h' | '7d',
): string | null {
  if (window === '5h') return buckets['5h'] ? '5h' : null;
  if (buckets['7d']) return '7d';
  if (buckets['weekly']) return 'weekly';
  return null;
}

function unreportedRow(snap: AccountSnapshot, window: string): StatusDisplayRow {
  const reason = `not reported by ${snap.provider}`;
  return {
    provider: snap.provider,
    label: snap.label,
    window,
    rawKey: null,
    used: 'not reported',
    left: 'not reported',
    confidence: 'not reported',
    reset: reason,
    marker: '',
    reported: false,
    exhausted: false,
    low: false,
    detail: reason,
  };
}

function rowFromReading(
  snap: AccountSnapshot,
  rawKey: string,
  window: string,
  reading: BucketReading,
  now: number,
): StatusDisplayRow {
  const cap = formatCapacity(reading.usedPct);
  const exhausted = cap.leftPct === 0;
  const low = cap.leftPct != null && cap.leftPct > 0 && cap.leftPct <= LOW_LEFT_PCT;
  const marker = exhausted ? 'EXHAUSTED' : low ? 'LOW' : '';
  const reset = formatResetClause({
    provider: snap.provider,
    window,
    usedPct: reading.usedPct,
    resetAt: reading.resetAt,
    now,
  });
  const bits = [`${cap.used} used`, `${cap.left} left`];
  if (marker) bits.push(marker);
  bits.push(reading.confidence, reset);
  return {
    provider: snap.provider,
    label: snap.label,
    window,
    rawKey,
    used: cap.used,
    left: marker ? `${cap.left} ${marker}` : cap.left,
    confidence: reading.confidence,
    reset,
    marker,
    reported: true,
    exhausted,
    low,
    detail: bits.join('  '),
  };
}

export function statusRowsForAccount(
  snap: AccountSnapshot,
  now: number = Date.now(),
): StatusDisplayRow[] {
  const rows: StatusDisplayRow[] = [];
  const seen = new Set<string>();
  for (const window of ['5h', '7d'] as const) {
    const rawKey = rawKeyForStandardWindow(snap.buckets, window);
    if (rawKey) {
      seen.add(rawKey);
      const label = window === '7d' && rawKey === 'weekly' ? '7d' : displayWindow(rawKey);
      rows.push(rowFromReading(snap, rawKey, label, snap.buckets[rawKey], now));
    } else {
      rows.push(unreportedRow(snap, window));
    }
  }
  for (const [rawKey, reading] of Object.entries(snap.buckets)) {
    if (seen.has(rawKey)) continue;
    rows.push(rowFromReading(snap, rawKey, rawKey, reading, now));
  }
  return rows;
}

function accountCapacitySuffix(rows: StatusDisplayRow[]): string {
  const exhausted = rows.filter((r) => r.exhausted).map((r) => r.window);
  const low = rows.filter((r) => r.low).map((r) => r.window);
  const parts: string[] = [];
  if (exhausted.length) parts.push(`EXHAUSTED (${exhausted.join(', ')})`);
  if (low.length) parts.push(`LOW (${low.join(', ')})`);
  return parts.length ? `  ${parts.join('  ')}` : '';
}

function formatBucketLines(rows: StatusDisplayRow[]): string[] {
  const width = Math.max(0, ...rows.map((r) => r.window.length));
  return rows.map((r) => `     ${r.window.padEnd(width)}  ${r.detail}`);
}

export function decorateStatusJson<T extends AccountSnapshot>(
  accounts: T[],
  now: number = Date.now(),
): T[] {
  return accounts.map((acct) => ({
    ...acct,
    buckets: Object.fromEntries(
      Object.entries(acct.buckets).map(([key, reading]) => [
        key,
        {
          ...reading,
          leftPct: leftPct(reading.usedPct),
          window: displayWindow(key),
          resetInMs:
            reading.resetAt != null && Number.isFinite(reading.resetAt)
              ? reading.resetAt - now
              : null,
          resetAtLocal:
            reading.resetAt != null && Number.isFinite(reading.resetAt)
              ? formatResetAtLocal(reading.resetAt, now)
              : null,
        },
      ]),
    ),
  }));
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function formatFlatTable(
  accounts: AccountSnapshot[],
  now: number = Date.now(),
): string {
  const rows: StatusDisplayRow[] = [];
  for (const snap of accounts) {
    if (snap.error && Object.keys(snap.buckets).length === 0) {
      rows.push({
        provider: snap.provider,
        label: snap.label,
        window: 'error',
        rawKey: null,
        used: 'error',
        left: 'error',
        confidence: 'error',
        reset: snap.error,
        marker: '',
        reported: false,
        exhausted: false,
        low: false,
        detail: snap.error,
      });
    }
    rows.push(...statusRowsForAccount(snap, now));
  }
  const headers = {
    provider: 'provider',
    label: 'account',
    window: 'bucket',
    used: 'used',
    left: 'left',
    confidence: 'confidence',
    reset: 'resets',
  };
  const widths = {
    provider: headers.provider.length,
    label: headers.label.length,
    window: headers.window.length,
    used: headers.used.length,
    left: headers.left.length,
    confidence: headers.confidence.length,
    reset: headers.reset.length,
  };
  for (const row of rows) {
    widths.provider = Math.max(widths.provider, row.provider.length);
    widths.label = Math.max(widths.label, row.label.length);
    widths.window = Math.max(widths.window, row.window.length);
    widths.used = Math.max(widths.used, row.used.length);
    widths.left = Math.max(widths.left, row.left.length);
    widths.confidence = Math.max(widths.confidence, row.confidence.length);
    widths.reset = Math.max(widths.reset, row.reset.length);
  }
  const line = (row: {
    provider: string;
    label: string;
    window: string;
    used: string;
    left: string;
    confidence: string;
    reset: string;
  }): string =>
    [
      padRight(row.provider, widths.provider),
      padRight(row.label, widths.label),
      padRight(row.window, widths.window),
      padRight(row.used, widths.used),
      padRight(row.left, widths.left),
      padRight(row.confidence, widths.confidence),
      padRight(row.reset, widths.reset),
    ].join(' | ');
  const out = [line(headers)];
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

/**
 * ✓ all buckets under 80%, ⚠ any bucket 80–99%, ✗ any bucket ≥ 100% or account error.
 */
export function accountHealth(snap: AccountSnapshot): { health: HealthLevel; healthGlyph: HealthGlyph } {
  if (snap.error) return { health: 'fail', healthGlyph: '✗' };
  let warn = false;
  for (const reading of Object.values(snap.buckets)) {
    if (reading.usedPct == null) continue;
    if (reading.usedPct >= 100) return { health: 'fail', healthGlyph: '✗' };
    if (reading.usedPct >= 80) warn = true;
  }
  if (warn) return { health: 'warn', healthGlyph: '⚠' };
  return { health: 'ok', healthGlyph: '✓' };
}

export function readOwnership(store: Store, provider: string): string {
  if (!isMigrateProvider(provider)) return 'n/a';
  try {
    const ownerFile = defaultOwnerFileFor(provider);
    const mig = isStaticKeyProvider(provider)
      ? createStaticKeyMigration(store, platformKeychain, provider, ownerFile, () => '')
      : isSingleGrantProvider(provider)
        ? createSingleGrantMigration(
            store,
            platformKeychain,
            provider,
            DEFAULT_AUTH_JSON,
            ownerFile,
          )
        : new Migration(store, platformKeychain, DEFAULT_POOL_FILE, ownerFile);
    return mig.status().state;
  } catch {
    return 'unknown';
  }
}

export function makeOwnershipReader(store: Store): (provider: string) => string {
  const cache = new Map<string, string>();
  return (provider: string) => {
    const hit = cache.get(provider);
    if (hit !== undefined) return hit;
    const value = readOwnership(store, provider);
    cache.set(provider, value);
    return value;
  };
}

export function overrideFromStore(store: Store, accountId: string): AccountOverrideView | null {
  try {
    const row = store.getOverride(accountId);
    if (!row) return null;
    return { kind: row.kind, session: row.session, until: row.until };
  } catch {
    return null;
  }
}

export function enrichAccounts(
  accounts: AccountSnapshot[],
  lookups: DashboardLookups,
): DashboardAccount[] {
  return accounts.map((snap) => {
    const { health, healthGlyph } = accountHealth(snap);
    return {
      ...snap,
      ownership: lookups.ownershipForProvider(snap.provider),
      override: lookups.overrideForAccount(snap.accountId),
      health,
      healthGlyph,
    };
  });
}

function overrideLabel(override: AccountOverrideView | null): string {
  if (!override) return 'none';
  const bits = [override.kind];
  if (override.session) bits.push(`session=${override.session}`);
  if (override.until != null) bits.push(`until=${new Date(override.until).toISOString()}`);
  return bits.join(' ');
}

export function formatDashboard(accounts: DashboardAccount[], now: number = Date.now()): string {
  if (accounts.length === 0) return '(no accounts)';
  const lines: string[] = [];
  for (const snap of accounts) {
    const rows = statusRowsForAccount(snap, now);
    lines.push(
      `${snap.healthGlyph}  ${snap.label}  ${snap.provider}  ${snap.ownership}  override=${overrideLabel(snap.override)}${accountCapacitySuffix(rows)}`,
    );
    if (snap.error) {
      lines.push(`     error: ${snap.error}`);
    }
    lines.push(...formatBucketLines(rows));
  }
  return lines.join('\n');
}
