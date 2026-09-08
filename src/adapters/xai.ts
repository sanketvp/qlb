import { readFile } from 'node:fs/promises';
import { config } from '../config';
import { fetchAndCache } from '../single-flight';
import { getStore } from '../store';
import type { AccountSnapshot, Adapter, BucketReading } from '../types';

// Read-only mirror of Pi's OAuth grants (Phase 0: never write/refresh — the
// native harness owns the refresh flow; if the grant expires we surface an
// error and the user refreshes via pi itself).
const AUTH_FILE = config.piAuthJsonPath;

const ADVISORY_DETAIL =
  'xAI developer-API allowance — NOT proven to match the SuperGrok Heavy in-app meter the user sees on grok.com; treat as advisory only (spec §3, §7 R2)';

interface XaiGrant {
  type?: string;
  access?: string;
  expires?: number; // epoch ms
}

function num(header: string | null): number | null {
  if (header == null) return null;
  const n = Number(header);
  return Number.isFinite(n) ? n : null;
}

function bucket(limit: number, remaining: number): BucketReading {
  return {
    usedPct: Math.round(((limit - remaining) / limit) * 1000) / 10,
    used: limit - remaining,
    limit,
    remaining,
    // xAI exposes a refilling bucket with no reset timestamp (spec §3) — resetAt unknown.
    source: 'headers',
    confidence: 'advisory',
    fetchedAt: Date.now(),
    detail: ADVISORY_DETAIL,
  };
}

export const xaiAdapter: Adapter = {
  id: 'xai',
  displayName: 'Grok (xAI)',
  fetchSnapshots: async (): Promise<AccountSnapshot[]> => {
    const snapshot: AccountSnapshot = {
      accountId: 'xai-default',
      provider: 'xai',
      label: 'Grok (xAI)',
      buckets: {},
    };
    try {
      // 1. Read the xAI OAuth grant (READ ONLY).
      let grant: XaiGrant;
      try {
        const raw = JSON.parse(await readFile(AUTH_FILE, 'utf8')) as Record<string, unknown>;
        grant = (raw['xai'] ?? {}) as XaiGrant;
      } catch {
        snapshot.error = `cannot read ${AUTH_FILE}`;
        return [snapshot];
      }
      if (!grant.access) {
        snapshot.error = 'no xai credentials in auth.json';
        return [snapshot];
      }
      if (grant.expires != null && Number.isFinite(grant.expires) && grant.expires <= Date.now()) {
        snapshot.error = 'xai grant expired — run pi once to refresh it';
        return [snapshot];
      }

      getStore().upsertAccount(snapshot.accountId, 'xai', snapshot.label);

      // 2. One minimal real probe request (spec §3 validated this provider via a
      //    live 1-token round-trip; there is no free gauge endpoint). Hard
      //    timeout, no retries — never more than one attempt. Concurrent callers
      //    share that one probe via single-flight (§4.3.3).
      let lastError: string | undefined;
      const buckets = await fetchAndCache(snapshot.accountId, async () => {
        const res = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${grant.access}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'grok-4.6',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          lastError = `probe failed: HTTP ${res.status}`;
          throw new Error(lastError);
        }

        // 3. The gauge rides on the response headers of the request that went through.
        const limitTokens = num(res.headers.get('x-ratelimit-limit-tokens'));
        const remainingTokens = num(res.headers.get('x-ratelimit-remaining-tokens'));
        const limitRequests = num(res.headers.get('x-ratelimit-limit-requests'));
        const remainingRequests = num(res.headers.get('x-ratelimit-remaining-requests'));

        if (
          limitTokens != null &&
          remainingTokens != null &&
          limitTokens > 0 &&
          limitRequests != null &&
          remainingRequests != null &&
          limitRequests > 0
        ) {
          return {
            tokens: bucket(limitTokens, remainingTokens),
            requests: bucket(limitRequests, remainingRequests),
          };
        }
        lastError = 'no x-ratelimit headers on response';
        throw new Error(lastError);
      });

      if (buckets && Object.keys(buckets).length > 0) {
        snapshot.buckets = buckets;
      } else {
        snapshot.error = lastError ?? 'no x-ratelimit headers on response';
      }
      return [snapshot];
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      snapshot.error = `probe failed: ${reason}`;
      return [snapshot];
    }
  },
};
