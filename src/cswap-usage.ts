// Cache-only Anthropic status projection from sequence.json + usage.json.
// Never launches the account switcher. Status only — not a serve path.

import { existsSync, readFileSync } from 'node:fs';

import { config } from './config';
import type { AccountSnapshot, BucketReading, Confidence } from './types';

export const TRUST_MAX_AGE_S = 3600;
export const STALE_OK_S = 300;
export const WINDOW_5H_MIN = 5 * 60;
export const WINDOW_7D_MIN = 7 * 24 * 60;

export interface CswapUsageLoadOpts {
  sequencePath?: string;
  usagePath?: string;
  nowMs?: number;
}

function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const trimmed = message.replace(/\s+/g, ' ').trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed || 'unreadable';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function accountEntry(
  accounts: Record<string, unknown> | undefined,
  num: number,
): Record<string, unknown> | null {
  if (!accounts) return null;
  const direct = accounts[String(num)] ?? accounts[num as unknown as string];
  return asRecord(direct);
}

function identityOf(entry: Record<string, unknown> | null): {
  email: string;
  organizationUuid: string;
} | null {
  if (!entry) return null;
  const email = typeof entry.email === 'string' ? entry.email : '';
  const organizationUuid =
    typeof entry.organizationUuid === 'string' ? entry.organizationUuid : '';
  if (!email && !organizationUuid) return null;
  return { email, organizationUuid };
}

function identitiesEqual(
  a: { email: string; organizationUuid: string } | null,
  b: { email: string; organizationUuid: string } | null,
): boolean {
  if (!a || !b) return false;
  return a.email === b.email && a.organizationUuid === b.organizationUuid;
}

export function normalizeModelLabel(raw: string): string {
  let label = raw;
  if (label.startsWith('seven_day_')) label = label.slice('seven_day_'.length);
  if (label.startsWith('five_hour_')) label = label.slice('five_hour_'.length);
  switch (label.toLowerCase()) {
    case 'opus':
      return 'Opus';
    case 'fable':
      return 'Fable';
    case 'sonnet':
      return 'Sonnet';
    case 'haiku':
      return 'Haiku';
    case 'oauth_apps':
      return 'Apps';
    default:
      if (label.length === 0) return label;
      return label[0].toUpperCase() + label.slice(1);
  }
}

function parseResetAt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === 'string' && v.length > 0) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function extractPct(v: unknown): number | null {
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  return v;
}

function reading(
  usedPct: number,
  fetchedAtMs: number,
  confidence: Confidence,
  opts: { resetAt?: number; windowMin?: number } = {},
): BucketReading {
  const out: BucketReading = {
    usedPct,
    source: 'poll',
    confidence,
    fetchedAt: fetchedAtMs,
  };
  if (opts.resetAt !== undefined) out.resetAt = opts.resetAt;
  if (opts.windowMin !== undefined) out.windowMin = opts.windowMin;
  return out;
}

function bucketsFromLastGood(
  lastGood: Record<string, unknown>,
  fetchedAtMs: number,
  confidence: Confidence,
): Record<string, BucketReading> {
  const buckets: Record<string, BucketReading> = {};
  const fiveHour = asRecord(lastGood.five_hour);
  const fivePct = extractPct(fiveHour?.pct);
  if (fivePct !== null) {
    buckets['5h'] = reading(fivePct, fetchedAtMs, confidence, {
      resetAt: parseResetAt(fiveHour?.resets_at),
      windowMin: WINDOW_5H_MIN,
    });
  }
  const sevenDay = asRecord(lastGood.seven_day);
  const sevenPct = extractPct(sevenDay?.pct);
  if (sevenPct !== null) {
    buckets['7d'] = reading(sevenPct, fetchedAtMs, confidence, {
      resetAt: parseResetAt(sevenDay?.resets_at),
      windowMin: WINDOW_7D_MIN,
    });
  }
  const scoped = Array.isArray(lastGood.scoped) ? lastGood.scoped : [];
  for (const item of scoped) {
    const rec = asRecord(item);
    if (!rec) continue;
    const name = typeof rec.name === 'string' ? rec.name : '';
    const pct = extractPct(rec.pct);
    if (!name || pct === null) continue;
    const key = `7d:${normalizeModelLabel(name)}`;
    buckets[key] = reading(pct, fetchedAtMs, confidence, {
      resetAt: parseResetAt(rec.resets_at),
      windowMin: WINDOW_7D_MIN,
    });
  }
  return buckets;
}

function errorSnap(
  accountId: string,
  label: string,
  error: string,
): AccountSnapshot {
  return {
    accountId,
    provider: 'anthropic',
    label,
    buckets: {},
    error,
  };
}

export function loadCswapUsageSnapshots(opts: CswapUsageLoadOpts = {}): AccountSnapshot[] {
  const sequencePath = opts.sequencePath ?? config.cswapSequencePath;
  const usagePath = opts.usagePath ?? config.cswapUsagePath;
  const nowMs = opts.nowMs ?? Date.now();
  try {
    if (!existsSync(sequencePath) || !existsSync(usagePath)) {
      return [
        errorSnap(
          'anthropic',
          'Claude (Anthropic)',
          'cswap cache not found',
        ),
      ];
    }
    const sequenceRaw = readJsonFile(sequencePath);
    const usageRaw = readJsonFile(usagePath);
    const sequence = asRecord(sequenceRaw);
    const usage = asRecord(usageRaw);
    if (!sequence || !usage) {
      return [errorSnap('anthropic', 'Claude (Anthropic)', 'cswap cache malformed')];
    }
    if (usage.schemaVersion !== 2) {
      return [errorSnap('anthropic', 'Claude (Anthropic)', 'cswap usage schema unsupported')];
    }
    const nums = Array.isArray(sequence.sequence)
      ? sequence.sequence.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
      : [];
    const seqAccounts = asRecord(sequence.accounts) ?? undefined;
    const usageAccounts = asRecord(usage.accounts) ?? undefined;
    const activeNum =
      typeof sequence.activeAccountNumber === 'number' ? sequence.activeAccountNumber : undefined;
    const out: AccountSnapshot[] = [];
    for (const num of nums) {
      const seqEntry = accountEntry(seqAccounts, num);
      if (seqEntry?.disabled === true) continue;
      const seqId = identityOf(seqEntry);
      const useEntry = accountEntry(usageAccounts, num);
      const useId = identityOf(useEntry);
      if (!identitiesEqual(seqId, useId)) continue;
      const email = seqId?.email || `cswap-slot-${num}`;
      const accountId =
        (seqId?.organizationUuid && seqId.organizationUuid.length > 0
          ? seqId.organizationUuid
          : `cswap-slot-${num}`);
      const label = activeNum === num ? `● ${email}` : email;
      const strikes =
        typeof useEntry?.authDeadStrikes === 'number' ? useEntry.authDeadStrikes : 0;
      if (strikes >= 1) {
        out.push(errorSnap(accountId, label, 'token_dead'));
        continue;
      }
      const fetchedAt =
        typeof useEntry?.fetchedAt === 'number' && Number.isFinite(useEntry.fetchedAt)
          ? useEntry.fetchedAt
          : null;
      const lastGood = asRecord(useEntry?.lastGood);
      if (fetchedAt == null || !lastGood) {
        out.push(errorSnap(accountId, label, 'unavailable'));
        continue;
      }
      const ageS = nowMs / 1000 - fetchedAt;
      if (ageS > TRUST_MAX_AGE_S) {
        out.push(errorSnap(accountId, label, 'unavailable'));
        continue;
      }
      const confidence: Confidence = ageS <= STALE_OK_S ? 'authoritative' : 'stale';
      const buckets = bucketsFromLastGood(lastGood, fetchedAt * 1000, confidence);
      out.push({
        accountId,
        provider: 'anthropic',
        label,
        buckets,
      });
    }
    return out;
  } catch (err) {
    return [errorSnap('anthropic', 'Claude (Anthropic)', shortReason(err))];
  }
}

export function cswapCachePresent(opts: CswapUsageLoadOpts = {}): boolean {
  const sequencePath = opts.sequencePath ?? config.cswapSequencePath;
  const usagePath = opts.usagePath ?? config.cswapUsagePath;
  if (!existsSync(sequencePath) || !existsSync(usagePath)) return false;
  try {
    const usage = asRecord(readJsonFile(usagePath));
    return usage?.schemaVersion === 2;
  } catch {
    return false;
  }
}
