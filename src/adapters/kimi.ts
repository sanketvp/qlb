import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountSnapshot, Adapter, BucketReading } from '../types';

const KEY_FILE = join(homedir(), 'DEV_vault', '04-Security', 'kimi-code-credentials.md');
const USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
const TIMEOUT_MS = 10_000;

interface KimiAmount {
  limit?: string;
  used?: string;
  remaining?: string;
  resetTime?: string;
}

interface KimiWindowLimit {
  window?: { duration?: number; timeUnit?: string };
  detail?: KimiAmount;
}

interface KimiUsagesResponse {
  user?: {
    userId?: string;
    region?: string;
    membership?: { level?: string };
  };
  usage?: KimiAmount;
  limits?: KimiWindowLimit[];
  parallel?: { limit?: string };
}

async function readStaticKey(): Promise<string> {
  const content = await readFile(KEY_FILE, 'utf8');
  const match = content.match(/sk-kimi-[A-Za-z0-9]+/);
  if (!match) {
    throw new Error(`no sk-kimi key found in ${KEY_FILE}`);
  }
  return match[0];
}

function parseNumber(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseResetAt(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function toReading(amount: KimiAmount, fetchedAt: number, windowMin?: number): BucketReading {
  const limit = parseNumber(amount.limit);
  const used = parseNumber(amount.used);
  const remaining = parseNumber(amount.remaining);
  const usedPct = limit != null && limit > 0 && used != null ? (used / limit) * 100 : null;
  const reading: BucketReading = {
    usedPct,
    used,
    limit,
    remaining,
    resetAt: parseResetAt(amount.resetTime),
    source: 'poll',
    confidence: 'authoritative',
    fetchedAt,
  };
  if (windowMin != null) reading.windowMin = windowMin;
  return reading;
}

function windowMinutes(window: KimiWindowLimit['window']): number | undefined {
  if (!window || typeof window.duration !== 'number') return undefined;
  switch (window.timeUnit) {
    case 'TIME_UNIT_MINUTE':
      return window.duration;
    case 'TIME_UNIT_HOUR':
      return window.duration * 60;
    case 'TIME_UNIT_DAY':
      return window.duration * 60 * 24;
    default:
      return undefined;
  }
}

function windowBucketKey(minutes: number | undefined): string {
  if (minutes === 300) return '5h';
  if (minutes != null) return `window:${minutes}min`;
  return 'window:unknown';
}

function errorSnapshot(reason: string): AccountSnapshot {
  return {
    accountId: 'kimi-default',
    provider: 'kimi-coding',
    label: 'Kimi K3',
    buckets: {},
    error: reason,
  };
}

export const kimiAdapter: Adapter = {
  id: 'kimi-coding',
  displayName: 'Kimi K3',

  async fetchSnapshots(): Promise<AccountSnapshot[]> {
    const fetchedAt = Date.now();

    let key: string;
    try {
      key = await readStaticKey();
    } catch (err) {
      return [errorSnapshot(err instanceof Error ? err.message : String(err))];
    }

    let res: Response;
    try {
      res = await fetch(USAGES_URL, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return [errorSnapshot(`request failed: ${err instanceof Error ? err.message : String(err)}`)];
    }

    if (!res.ok) {
      return [errorSnapshot(`usages endpoint returned HTTP ${res.status}`)];
    }

    let body: KimiUsagesResponse;
    try {
      body = (await res.json()) as KimiUsagesResponse;
    } catch {
      return [errorSnapshot('malformed JSON from usages endpoint')];
    }

    if (!body.usage) {
      return [errorSnapshot('response missing usage block')];
    }

    const buckets: Record<string, BucketReading> = {
      weekly: toReading(body.usage, fetchedAt),
    };

    for (const entry of body.limits ?? []) {
      if (!entry.detail) continue;
      const minutes = windowMinutes(entry.window);
      buckets[windowBucketKey(minutes)] = toReading(entry.detail, fetchedAt, minutes);
    }

    const level = body.user?.membership?.level;
    return [
      {
        accountId: body.user?.userId ?? 'kimi-default',
        provider: 'kimi-coding',
        label: level ? `Kimi K3 (${level})` : 'Kimi K3',
        buckets,
      },
    ];
  },
};
