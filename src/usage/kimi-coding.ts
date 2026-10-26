import { resolve } from '../token/kimi-coding';

export const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';

export interface KimiCodingUsageProbeResult {
  status: number | null;
  source: 'kimi-api' | 'unknown';
  keys: string[];
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface KimiCodingUsageProbeDeps {
  /** Test seam; production resolves the QLB-owned, non-refreshing credential. */
  access?: string;
  fetchFn?: FetchFn;
}

function objectKeys(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed).slice(0, 20).map((key) => key.slice(0, 64))
      : [];
  } catch {
    return [];
  }
}

/** L18 probe: metadata only, never a response body or credential. */
export async function probeKimiCodingUsage(deps: KimiCodingUsageProbeDeps = {}): Promise<KimiCodingUsageProbeResult> {
  let access: string;
  try {
    access = deps.access ?? resolve().token;
  } catch {
    return { status: null, source: 'unknown', keys: [] };
  }

  try {
    const response = await (deps.fetchFn ?? fetch)(KIMI_USAGE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${access}` },
    });
    return { status: response.status, source: 'kimi-api', keys: objectKeys(await response.text()) };
  } catch {
    return { status: null, source: 'unknown', keys: [] };
  }
}

export default { probe: probeKimiCodingUsage };
