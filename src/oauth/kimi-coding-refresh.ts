// Refresh request mirrored from Pi 1.4.0's pi-ai/auth/oauth/kimi-coding.js:172-221
// (with its 30-second request timeout at :15).
// The transport and retry delay are injected so tests never use the network or clock.

import type { OAuthRefreshCredential, OAuthRefreshResult, OAuthRefreshTransport } from './xai-refresh';

export const KIMI_CODING_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
export const KIMI_CODING_OAUTH_HOST = 'https://auth.kimi.com';
const MAX_RETRIES = 3;

function bodyObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validTokenResponse(body: Record<string, unknown> | null): { access: string; refresh: string; expiresIn: number } | null {
  const access = body?.access_token;
  const refresh = body?.refresh_token;
  const expiresIn = body?.expires_in;
  return typeof access === 'string' && access && typeof refresh === 'string' && refresh
    && typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
    ? { access, refresh, expiresIn }
    : null;
}

/** Pi retries 429/5xx three times after the initial attempt. */
export async function refreshKimiCodingCredential(
  credential: OAuthRefreshCredential,
  deps: {
    transport: OAuthRefreshTransport;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    oauthHost?: string;
    /** An aborted signal stops the retry chain; the in-flight request gets it too. */
    signal?: AbortSignal;
  },
): Promise<OAuthRefreshResult> {
  const oauthHost = (deps.oauthHost ?? KIMI_CODING_OAUTH_HOST).replace(/\/+$/, '');
  let response: { status: number; body: unknown } | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) await (deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(1000 * 2 ** (attempt - 1));
    if (deps.signal?.aborted) return { kind: 'transient' };
    try {
      response = await deps.transport.request({
        url: `${oauthHost}/api/oauth/token`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: KIMI_CODING_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: credential.refresh,
        }).toString(),
        signal: deps.signal,
      });
    } catch {
      if (attempt < MAX_RETRIES) continue;
      return { kind: 'transient' };
    }
    const body = bodyObject(response.body);
    if (response.status >= 200 && response.status < 300) {
      const parsed = validTokenResponse(body);
      return parsed
        ? { kind: 'success', credential: { ...credential, type: 'oauth', access: parsed.access, refresh: parsed.refresh, expires: (deps.now ?? Date.now)() + parsed.expiresIn * 1000 } }
        : { kind: 'transient' };
    }
    // §4.5 wins over Pi's broader classifier: only an OAuth error body on
    // 400/401 proves that this single-use grant is dead.
    if ((response.status === 400 || response.status === 401) && typeof body?.error === 'string') return { kind: 'dead' };
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) continue;
    return { kind: 'transient' };
  }
  return { kind: 'transient' };
}
