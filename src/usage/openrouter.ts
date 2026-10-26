import { resolve as resolveToken } from '../token/openrouter';

export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

export interface OpenRouterUsageProbeResult {
  status: number | null;
  source: 'credits' | 'unknown';
  keys: string[];
  /** Present only for a complete, finite credits response. */
  usedPct?: number;
}

export interface OpenRouterUsageProbeDeps {
  resolve?: typeof resolveToken;
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
}

function topLevelKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).slice(0, 20).map((key) => key.slice(0, 64))
    : [];
}

function usedPercent(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const total = (data as Record<string, unknown>).total_credits;
  const used = (data as Record<string, unknown>).total_usage;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0 ||
      typeof used !== 'number' || !Number.isFinite(used)) return undefined;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/**
 * S52 metadata-only usage probe. The access key and response body never leave
 * this module; callers receive only status, source, safe top-level keys, and
 * an optional calculated percentage.
 */
export async function probeOpenRouterUsage(
  deps: OpenRouterUsageProbeDeps = {},
): Promise<OpenRouterUsageProbeResult> {
  let token: string;
  try {
    token = (deps.resolve ?? resolveToken)().token;
  } catch {
    return { status: null, source: 'unknown', keys: [] };
  }

  try {
    const response = await (deps.fetchFn ?? fetch)(OPENROUTER_CREDITS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const bodyText = await response.text();
    let body: unknown;
    try { body = JSON.parse(bodyText); } catch { body = undefined; }
    const keys = topLevelKeys(body);
    const usedPct = response.status >= 200 && response.status < 300 ? usedPercent(body) : undefined;
    return {
      status: response.status,
      source: response.status >= 200 && response.status < 300 ? 'credits' : 'unknown',
      keys,
      ...(usedPct === undefined ? {} : { usedPct }),
    };
  } catch {
    return { status: null, source: 'unknown', keys: [] };
  }
}

export default { probe: probeOpenRouterUsage };
