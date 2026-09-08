import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { config } from '../config';
import { fetchAndCache } from '../single-flight';
import { getStore } from '../store';
import type { AccountSnapshot, Adapter, BucketReading } from '../types';

const KEYCHAIN_SERVICE = config.openrouterKeychainService;
const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const TIMEOUT_MS = 10_000;
const ACCOUNT_ID = 'openrouter-default';
const LABEL = 'OpenRouter';
const KEY_MISSING_ERROR =
  `OpenRouter key not found in macOS Keychain (service ${KEYCHAIN_SERVICE})`;
const CREDIT_DETAIL =
  'OpenRouter account-wide credit balance from /api/v1/credits; not a rolling request/token rate-limit window';

const execFileAsync = promisify(execFile);

type FetchFn = typeof fetch;
type FetchAndCacheFn = (
  accountId: string,
  fetcher: () => Promise<Record<string, BucketReading>>,
) => Promise<Record<string, BucketReading> | null>;

interface OpenRouterCreditsResponse {
  data?: {
    total_credits?: unknown;
    total_usage?: unknown;
  };
}

export interface OpenRouterAdapterDeps {
  readKey?: () => Promise<string>;
  fetchFn?: FetchFn;
  fetchAndCacheFn?: FetchAndCacheFn;
  upsertAccount?: (accountId: string, provider: string, label: string) => void;
  now?: () => number;
}

async function readKeyFromKeychain(): Promise<string> {
  try {
    const result = await execFileAsync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8' },
    );
    const key = String(result.stdout).trim();
    if (key.length > 0) return key;
  } catch {
    // Normalize Keychain lookup failures without exposing command output.
  }
  throw new Error(KEY_MISSING_ERROR);
}

function errorSnapshot(reason: string): AccountSnapshot {
  return {
    accountId: ACCOUNT_ID,
    provider: 'openrouter',
    label: LABEL,
    buckets: {},
    error: reason,
  };
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function parseOpenRouterCredits(
  body: OpenRouterCreditsResponse,
  fetchedAt: number,
): Record<string, BucketReading> {
  const totalCredits = finiteNonnegative(body.data?.total_credits);
  const totalUsage = finiteNonnegative(body.data?.total_usage);
  if (totalCredits == null || totalUsage == null) {
    throw new Error('malformed response from credits endpoint');
  }

  return {
    credits: {
      usedPct: totalCredits > 0 ? (totalUsage / totalCredits) * 100 : null,
      used: totalUsage,
      limit: totalCredits,
      remaining: totalCredits - totalUsage,
      source: 'poll',
      confidence: 'authoritative',
      fetchedAt,
      detail: CREDIT_DETAIL,
    },
  };
}

export function createOpenRouterAdapter(
  deps: OpenRouterAdapterDeps = {},
): Adapter {
  const readKey = deps.readKey ?? readKeyFromKeychain;
  const fetchFn = deps.fetchFn ?? fetch;
  const fetchCached = deps.fetchAndCacheFn ?? fetchAndCache;
  const upsertAccount =
    deps.upsertAccount ??
    ((accountId: string, provider: string, label: string) => {
      getStore().upsertAccount(accountId, provider, label);
    });
  const now = deps.now ?? Date.now;

  return {
    id: 'openrouter',
    displayName: LABEL,

    async fetchSnapshots(): Promise<AccountSnapshot[]> {
      try {
        upsertAccount(ACCOUNT_ID, 'openrouter', LABEL);

        let key: string;
        try {
          key = (await readKey()).trim();
          if (!key) throw new Error(KEY_MISSING_ERROR);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return [errorSnapshot(reason || KEY_MISSING_ERROR)];
        }

        let lastError: string | undefined;
        const buckets = await fetchCached(ACCOUNT_ID, async () => {
          let response: Response;
          try {
            response = await fetchFn(CREDITS_URL, {
              headers: { Authorization: `Bearer ${key}` },
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
          } catch (err) {
            lastError = `request failed: ${err instanceof Error ? err.message : String(err)}`;
            throw new Error(lastError);
          }

          if (!response.ok) {
            lastError = `credits endpoint returned HTTP ${response.status}`;
            throw new Error(lastError);
          }

          let body: OpenRouterCreditsResponse;
          try {
            body = (await response.json()) as OpenRouterCreditsResponse;
          } catch {
            lastError = 'malformed JSON from credits endpoint';
            throw new Error(lastError);
          }

          try {
            return parseOpenRouterCredits(body, now());
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            throw err;
          }
        });

        if (lastError) {
          return [errorSnapshot(lastError)];
        }
        if (buckets && Object.keys(buckets).length > 0) {
          const credit = buckets.credits;
          const detailedBuckets = credit
            ? { ...buckets, credits: { ...credit, detail: CREDIT_DETAIL } }
            : buckets;
          return [
            {
              accountId: ACCOUNT_ID,
              provider: 'openrouter',
              label: LABEL,
              buckets: detailedBuckets,
            },
          ];
        }
        return [errorSnapshot(lastError ?? 'credits endpoint returned no usage data')];
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return [errorSnapshot(reason)];
      }
    },
  };
}

export const openRouterAdapter = createOpenRouterAdapter();
