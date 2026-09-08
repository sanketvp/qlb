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
import { macosKeychain } from './keychain';
import type { Store } from './store';
import type { AccountSnapshot } from './types';

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

export function formatRelative(resetAt?: number): string {
  if (resetAt == null || !Number.isFinite(resetAt)) return '-';
  const deltaMs = resetAt - Date.now();
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
      ? createStaticKeyMigration(store, macosKeychain, provider, ownerFile, () => '')
      : isSingleGrantProvider(provider)
        ? createSingleGrantMigration(
            store,
            macosKeychain,
            provider,
            DEFAULT_AUTH_JSON,
            ownerFile,
          )
        : new Migration(store, macosKeychain, DEFAULT_POOL_FILE, ownerFile);
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

export function formatDashboard(accounts: DashboardAccount[]): string {
  if (accounts.length === 0) return '(no accounts)';
  const lines: string[] = [];
  for (const snap of accounts) {
    lines.push(
      `${snap.healthGlyph}  ${snap.label}  ${snap.provider}  ${snap.ownership}  override=${overrideLabel(snap.override)}`,
    );
    const entries = Object.entries(snap.buckets);
    if (entries.length === 0 && snap.error) {
      lines.push(`     error: ${snap.error}`);
      continue;
    }
    if (snap.error) {
      lines.push(`     error: ${snap.error}`);
    }
    for (const [bucket, reading] of entries) {
      lines.push(
        `     ${bucket}  ${formatUsedPct(reading.usedPct)}  ${reading.confidence}  resets ${formatRelative(reading.resetAt)}`,
      );
    }
  }
  return lines.join('\n');
}
