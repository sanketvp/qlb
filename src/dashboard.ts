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

/**
 * Remaining capacity, LOW, and EXHAUSTED all use this 1-decimal remaining
 * so the printed number and the marker cannot disagree.
 *
 * After half-up rounding to 1 decimal:
 * - a strictly positive remainder that would become 0.0 is raised to 0.1
 *   (never print "0% left" for a bucket that is not exhausted)
 * - a remainder strictly above LOW_LEFT_PCT (5) that would become 5.0 is
 *   raised to 5.1 (never print "5% left" for a bucket that is not LOW)
 * Markers: EXHAUSTED iff this value is 0; LOW iff 0 < value <= 5.
 */
export function normalizeLeftPct(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const capped = Math.min(100, n);
  let rounded = Math.round(capped * 10) / 10;
  if (Object.is(rounded, -0)) rounded = 0;
  if (rounded === 0) return 0.1;
  if (capped > LOW_LEFT_PCT && rounded === LOW_LEFT_PCT) return LOW_LEFT_PCT + 0.1;
  return rounded;
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
  const displayLeft = normalizeLeftPct(leftPct(usedPct)!);
  return {
    used: formatPctNumber(usedPct),
    left: formatPctNumber(displayLeft),
    leftPct: displayLeft,
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
  // No adapter currently exposes a trustworthy "window not started" signal
  // (usedPct === 0 with a missing resetAt is indistinguishable from "this
  // provider never reports resets"). Admit ignorance rather than guess.
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
          leftPct: formatCapacity(reading.usedPct).leftPct,
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

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

interface FlatRow {
  provider: string;
  label: string;
  bucket: string;
  usedPct: string;
  confidence: string;
  reset: string;
}

/**
 * Original `--flat` bucket table: raw reported buckets only, raw names
 * (including kimi `weekly`), six columns, original used/reset formatting.
 * Richer remaining-capacity presentation lives on the dashboard view.
 */
export function formatFlatTable(
  accounts: AccountSnapshot[],
  now: number = Date.now(),
): string {
  const rows: FlatRow[] = [];
  for (const snap of accounts) {
    const entries = Object.entries(snap.buckets);
    if (entries.length === 0 && snap.error) {
      rows.push({
        provider: snap.provider,
        label: snap.label,
        bucket: '-',
        usedPct: '-',
        confidence: 'error',
        reset: snap.error,
      });
      continue;
    }
    for (const [bucket, reading] of entries) {
      rows.push({
        provider: snap.provider,
        label: snap.label,
        bucket,
        usedPct: formatUsedPct(reading.usedPct),
        confidence: reading.confidence,
        reset: formatRelative(reading.resetAt, now),
      });
    }
  }
  const widths = {
    provider: 'provider'.length,
    label: 'account'.length,
    bucket: 'bucket'.length,
    usedPct: 'used'.length,
    confidence: 'confidence'.length,
    reset: 'resets'.length,
  };
  for (const row of rows) {
    widths.provider = Math.max(widths.provider, row.provider.length);
    widths.label = Math.max(widths.label, row.label.length);
    widths.bucket = Math.max(widths.bucket, row.bucket.length);
    widths.usedPct = Math.max(widths.usedPct, row.usedPct.length);
    widths.confidence = Math.max(widths.confidence, row.confidence.length);
    widths.reset = Math.max(widths.reset, `resets ${row.reset}`.length);
  }
  const line = (
    provider: string,
    label: string,
    bucket: string,
    usedPct: string,
    confidence: string,
    reset: string,
  ): string =>
    [
      pad(provider, widths.provider),
      pad(label, widths.label),
      pad(bucket, widths.bucket),
      pad(usedPct, widths.usedPct),
      pad(confidence, widths.confidence),
      pad(reset, widths.reset),
    ].join(' | ');
  const out = [line('provider', 'account', 'bucket', 'used', 'confidence', 'resets')];
  for (const row of rows) {
    out.push(
      line(row.provider, row.label, row.bucket, row.usedPct, row.confidence, `resets ${row.reset}`),
    );
  }
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
