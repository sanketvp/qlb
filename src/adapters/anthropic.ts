import { existsSync, readFileSync } from 'node:fs';
import { config } from '../config';
import { fetchAndCache } from '../single-flight';
import { getStore } from '../store';
import type { AccountSnapshot, Adapter, BucketReading } from '../types';

const POOL_FILE_PATH = config.anthropicPoolPath;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const AUTH_EXPIRED = 'auth expired or invalid — needs re-login';
const FETCH_TIMEOUT_MS = 10_000;
const WINDOW_5H_MIN = 5 * 60;
const WINDOW_7D_MIN = 7 * 24 * 60;

interface PoolCredentials {
  access?: string;
  refresh?: string;
  expires?: number;
}

interface PoolAccount {
  id?: string;
  name?: string;
  email?: string;
  credentials?: PoolCredentials;
}

interface PoolFile {
  accounts?: PoolAccount[];
}

interface UsageWindow {
  utilization?: number;
  resets_at?: string | number | null;
  used_dollars?: number | null;
  limit_dollars?: number | null;
  remaining_dollars?: number | null;
}

function accountIdOf(account: PoolAccount, index: number): string {
  return account.id || account.email || account.name || `account-${index + 1}`;
}

function accountLabelOf(account: PoolAccount, index: number): string {
  return account.email || account.name || accountIdOf(account, index);
}

function errorSnapshot(account: PoolAccount, index: number, error: string): AccountSnapshot {
  return {
    accountId: accountIdOf(account, index),
    provider: 'anthropic',
    label: accountLabelOf(account, index),
    buckets: {},
    error,
  };
}

function shortReason(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = String((err as { name: unknown }).name);
    if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  }
  const message = err instanceof Error ? err.message : String(err);
  const lowered = message.toLowerCase();
  if (
    lowered.includes('enotfound') ||
    lowered.includes('econnrefused') ||
    lowered.includes('econnreset') ||
    lowered.includes('network') ||
    lowered.includes('fetch failed')
  ) {
    return 'network error';
  }
  const trimmed = message.replace(/\s+/g, ' ').trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed || 'request failed';
}

function extractPct(v: unknown): number | null {
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  return v;
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

function normalizeModelLabel(raw: string): string {
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

function reading(
  usedPct: number,
  fetchedAt: number,
  opts: { resetAt?: number; windowMin?: number; used?: number; limit?: number; remaining?: number } = {},
): BucketReading {
  const out: BucketReading = {
    usedPct,
    source: 'poll',
    confidence: 'authoritative',
    fetchedAt,
  };
  if (opts.resetAt !== undefined) out.resetAt = opts.resetAt;
  if (opts.windowMin !== undefined) out.windowMin = opts.windowMin;
  if (opts.used !== undefined) out.used = opts.used;
  if (opts.limit !== undefined) out.limit = opts.limit;
  if (opts.remaining !== undefined) out.remaining = opts.remaining;
  return out;
}

function optionalNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function windowExtras(win: UsageWindow | undefined): {
  resetAt?: number;
  used?: number;
  limit?: number;
  remaining?: number;
} {
  if (!win) return {};
  return {
    resetAt: parseResetAt(win.resets_at),
    used: optionalNumber(win.used_dollars),
    limit: optionalNumber(win.limit_dollars),
    remaining: optionalNumber(win.remaining_dollars),
  };
}

function parseUsage(data: Record<string, unknown>, fetchedAt: number): Record<string, BucketReading> {
  const buckets: Record<string, BucketReading> = {};

  const fiveHour = data.five_hour as UsageWindow | undefined;
  const fiveHourPct = extractPct(fiveHour?.utilization);
  if (fiveHourPct !== null) {
    buckets['5h'] = reading(fiveHourPct, fetchedAt, { ...windowExtras(fiveHour), windowMin: WINDOW_5H_MIN });
  }

  const sevenDay = data.seven_day as UsageWindow | undefined;
  const sevenDayPct = extractPct(sevenDay?.utilization);
  if (sevenDayPct !== null) {
    buckets['7d'] = reading(sevenDayPct, fetchedAt, { ...windowExtras(sevenDay), windowMin: WINDOW_7D_MIN });
  }

  const limits = Array.isArray(data.limits) ? (data.limits as Record<string, unknown>[]) : [];
  for (const limit of limits) {
    if (limit.kind !== 'weekly_scoped') continue;
    const scope = limit.scope as { model?: { display_name?: string } } | undefined;
    const displayName = scope?.model?.display_name;
    const pct = extractPct(limit.percent);
    if (!displayName || pct === null) continue;
    const key = `7d:${normalizeModelLabel(displayName)}`;
    buckets[key] = reading(pct, fetchedAt, {
      resetAt: parseResetAt(limit.resets_at),
      windowMin: WINDOW_7D_MIN,
    });
  }

  // Older/fallback shape: seven_day_<model> objects. Do not map five_hour_* —
  // per-model buckets are weekly-scoped (`7d:<Model>`).
  for (const [key, value] of Object.entries(data)) {
    if (!/^seven_day_.+/.test(key)) continue;
    if (typeof value !== 'object' || value === null) continue;
    const win = value as UsageWindow;
    const pct = extractPct(win.utilization);
    if (pct === null) continue;
    const label = normalizeModelLabel(key);
    const bucketKey = `7d:${label}`;
    if (bucketKey in buckets) continue;
    buckets[bucketKey] = reading(pct, fetchedAt, {
      ...windowExtras(win),
      windowMin: WINDOW_7D_MIN,
    });
  }

  return buckets;
}

function loadPoolAccounts(): PoolAccount[] | { error: string } {
  if (!existsSync(POOL_FILE_PATH)) {
    return { error: 'pool file not found' };
  }
  let raw: string;
  try {
    raw = readFileSync(POOL_FILE_PATH, 'utf8');
  } catch (err) {
    return { error: `pool file unreadable: ${shortReason(err)}` };
  }
  let parsed: PoolFile;
  try {
    parsed = JSON.parse(raw) as PoolFile;
  } catch {
    return { error: 'pool file malformed JSON' };
  }
  if (!Array.isArray(parsed.accounts)) {
    return { error: 'pool file missing accounts' };
  }
  return parsed.accounts;
}

async function fetchUsageBuckets(account: PoolAccount): Promise<Record<string, BucketReading>> {
  const access = account.credentials?.access;
  const expires = account.credentials?.expires;
  if (!access || (typeof expires === 'number' && expires < Date.now())) {
    throw new Error(AUTH_EXPIRED);
  }

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${access}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status === 401) {
    throw new Error(AUTH_EXPIRED);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('malformed JSON');
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error('malformed JSON');
  }

  return parseUsage(data as Record<string, unknown>, Date.now());
}

async function fetchOne(account: PoolAccount, index: number): Promise<AccountSnapshot> {
  const accountId = accountIdOf(account, index);
  const label = accountLabelOf(account, index);
  try {
    getStore().upsertAccount(accountId, 'anthropic', label);
    let lastError = AUTH_EXPIRED;
    const buckets = await fetchAndCache(accountId, async () => {
      try {
        return await fetchUsageBuckets(account);
      } catch (err) {
        lastError = shortReason(err);
        throw err;
      }
    });
    if (buckets && Object.keys(buckets).length > 0) {
      return { accountId, provider: 'anthropic', label, buckets };
    }
    return errorSnapshot(account, index, lastError);
  } catch (err) {
    return errorSnapshot(account, index, shortReason(err));
  }
}

export const anthropicAdapter: Adapter = {
  id: 'anthropic',
  displayName: 'Claude (Anthropic)',
  async fetchSnapshots(): Promise<AccountSnapshot[]> {
    try {
      const loaded = loadPoolAccounts();
      if (!Array.isArray(loaded)) {
        return [
          {
            accountId: 'anthropic',
            provider: 'anthropic',
            label: 'Claude (Anthropic)',
            buckets: {},
            error: loaded.error,
          },
        ];
      }
      return await Promise.all(loaded.map((account, index) => fetchOne(account, index)));
    } catch (err) {
      return [
        {
          accountId: 'anthropic',
          provider: 'anthropic',
          label: 'Claude (Anthropic)',
          buckets: {},
          error: shortReason(err),
        },
      ];
    }
  },
};
