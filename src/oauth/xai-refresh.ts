// Refresh request mirrored from Pi 1.4.0's pi-ai/auth/oauth/xai.js:102-105.
// The transport is injected so this module never performs network I/O in tests.

export const XAI_REFRESH_URL = 'https://auth.x.ai/oauth2/token';
export const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface OAuthRefreshCredential {
  type?: unknown;
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export interface OAuthRefreshTransport {
  request(request: { url: string; method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    status: number;
    body: unknown;
  }>;
}

export type OAuthRefreshResult =
  | { kind: 'success'; credential: OAuthRefreshCredential }
  | { kind: 'dead' }
  | { kind: 'transient' };

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function bodyObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** xAI permits the old refresh token when the response omits refresh_token. */
export async function refreshXaiCredential(
  credential: OAuthRefreshCredential,
  deps: { transport: OAuthRefreshTransport; now?: () => number; signal?: AbortSignal },
): Promise<OAuthRefreshResult> {
  let response: { status: number; body: unknown };
  try {
    response = await deps.transport.request({
      url: XAI_REFRESH_URL,
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: XAI_CLIENT_ID,
        refresh_token: credential.refresh,
      }).toString(),
      signal: deps.signal,
    });
  } catch {
    return { kind: 'transient' };
  }
  const body = bodyObject(response.body);
  if (response.status < 200 || response.status >= 300) {
    // §4.5 only declares an OAuth error body dead; a bare gateway 400/401 is transient.
    return (response.status === 400 || response.status === 401) && typeof body?.error === 'string'
      ? { kind: 'dead' }
      : { kind: 'transient' };
  }
  const access = body?.access_token;
  if (typeof access !== 'string' || !access) return { kind: 'transient' };
  const returnedRefresh = body?.refresh_token;
  if (returnedRefresh !== undefined && (typeof returnedRefresh !== 'string' || !returnedRefresh)) return { kind: 'transient' };
  const expiresIn = body?.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : positiveNumber(body.expires_in);
  if (expiresIn === undefined) return { kind: 'transient' };
  return {
    kind: 'success',
    credential: {
      ...credential,
      type: 'oauth',
      access,
      refresh: typeof returnedRefresh === 'string' ? returnedRefresh : credential.refresh,
      expires: (deps.now ?? Date.now)() + expiresIn * 1000 - REFRESH_SKEW_MS,
    },
  };
}
