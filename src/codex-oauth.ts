// Pure Codex OAuth request descriptions and response parsing.
// Sources: Codex rust-v0.164.0 codex-rs/login/src/auth/manager.rs:1695-1747,
// :1783-1785; oauth/client.rs:14-18, :89-130; codex-api/src/rate_limits.rs:68-80,
// :104-115, :171-177. The L14 usage response shape remains unverified.

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_REFRESH_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export interface RequestDescription {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface CodexTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

export interface CodexAuthDocument {
  tokens: Record<string, unknown>;
  last_refresh?: unknown;
  [key: string]: unknown;
}

export type RefreshClassification =
  | { kind: 'ok'; tokens: CodexTokens }
  | { kind: 'dead'; reason: string }
  | { kind: 'transient'; reason: string };

export interface UsageWindow {
  bucket: 'primary' | 'secondary';
  usedPct: number;
  resetAt?: number;
}

export type UsageParseResult =
  | UsageWindow[]
  | { kind: 'unknown'; status: number; topLevelKeys: string[] }
  | { kind: 'unauthorized' }
  | { kind: 'rate-limited'; retryAfter: number | undefined };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Describes the forced refresh request QLB makes for a Codex slot.
 * Codex 0.164.0 serializes its refresh grant as JSON, not form data. Its
 * manager always supplies a refresh_reason; QLB's explicit consume action is
 * the corresponding `forced` reason.
 */
export function buildRefreshRequest(refreshToken: string): RequestDescription {
  // OAuthClient collects parameters in a BTreeMap before JSON serialization,
  // hence the intentionally stable key order here (oauth/client.rs:110-128).
  return {
    url: CODEX_REFRESH_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_reason: 'forced',
      refresh_token: refreshToken,
    }),
  };
}

function parseJson(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Mirrors TokenErrorDetail's error / error.code / code precedence. */
function oauthErrorCode(body: unknown): string | undefined {
  if (!isObject(body)) return undefined;
  const error = body.error;
  return nonEmptyString(error) ??
    (isObject(error) ? nonEmptyString(error.code) : undefined) ??
    nonEmptyString(body.code);
}

function successTokens(body: unknown): CodexTokens | undefined {
  if (!isObject(body)) return undefined;
  const idToken = nonEmptyString(body.id_token);
  const accessToken = nonEmptyString(body.access_token);
  const refreshToken = nonEmptyString(body.refresh_token);
  if (!idToken || !accessToken || !refreshToken) return undefined;
  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
  };
}

/**
 * Classifies a completed refresh response without retaining its raw body.
 * Codex manager.rs:1728-1741 treats the three provider codes, any 401, and
 * 400 invalid_grant as permanent; all other failures are retryable.
 */
export function classifyRefreshResponse(status: number, bodyText: string): RefreshClassification {
  const body = parseJson(bodyText);
  if (status >= 200 && status < 300) {
    const tokens = successTokens(body);
    return tokens
      ? { kind: 'ok', tokens }
      : { kind: 'transient', reason: 'invalid_success_response' };
  }

  if (status === 401) return { kind: 'dead', reason: 'http_401' };

  const code = oauthErrorCode(body)?.toLowerCase();
  if (
    code === 'refresh_token_expired' ||
    code === 'refresh_token_reused' ||
    code === 'refresh_token_invalidated'
  ) {
    return { kind: 'dead', reason: code };
  }
  if (status === 400 && code === 'invalid_grant') {
    return { kind: 'dead', reason: 'invalid_grant' };
  }

  return {
    kind: 'transient',
    reason: body === undefined ? 'unparseable_response' : `http_${status}`,
  };
}

/** Returns a new document, retaining every field not replaced by the rotation. */
export function applyRefresh(
  doc: CodexAuthDocument,
  tokens: CodexTokens,
  now: Date | number,
): CodexAuthDocument {
  return {
    ...doc,
    tokens: { ...doc.tokens, ...tokens },
    last_refresh: new Date(now).toISOString(),
  };
}

/** Describes, but does not execute, the Codex usage request. */
export function buildUsageRequest(accessToken: string, accountId: string): RequestDescription {
  return {
    url: CODEX_USAGE_URL,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': accountId,
    },
  };
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseResetAt(value: unknown): number | undefined {
  const numberValue = asFiniteNumber(value);
  if (numberValue !== undefined) {
    // Codex rate_limits.rs calls this `reset_at` / `resets_at` and treats it as
    // Unix seconds. Preserve already-millisecond epoch values for tolerance.
    return numberValue > 1_000_000_000_000 ? numberValue : numberValue * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function rateLimitRoots(body: JsonObject): JsonObject[] {
  const roots: JsonObject[] = [body];
  for (const key of ['rate_limits', 'rateLimits', 'limits']) {
    const value = body[key];
    if (isObject(value)) roots.push(value);
  }
  return roots;
}

function parseWindow(root: JsonObject, bucket: UsageWindow['bucket']): UsageWindow | undefined {
  const raw = root[bucket];
  if (!isObject(raw)) return undefined;
  const usedPct = asFiniteNumber(raw.used_percent) ??
    asFiniteNumber(raw.usedPercent) ??
    asFiniteNumber(raw.used_pct);
  if (usedPct === undefined) return undefined;
  const resetAt = parseResetAt(raw.reset_at) ??
    parseResetAt(raw.resets_at) ??
    parseResetAt(raw.resetAt) ??
    parseResetAt(raw.resetsAt);
  return resetAt === undefined ? { bucket, usedPct } : { bucket, usedPct, resetAt };
}

function retryAfter(body: unknown): number | undefined {
  if (!isObject(body)) return undefined;
  return asFiniteNumber(body.retry_after) ?? asFiniteNumber(body.retryAfter);
}

/**
 * Parses only recognized usage gauges. The WHAM endpoint's body shape is L14
 * UNVERIFIED, so an unfamiliar response returns metadata only, never body text.
 */
export function parseUsage(status: number, bodyText: string): UsageParseResult {
  if (status === 401) return { kind: 'unauthorized' };

  const body = parseJson(bodyText);
  if (status === 429) return { kind: 'rate-limited', retryAfter: retryAfter(body) };

  const topLevelKeys = isObject(body) ? Object.keys(body) : [];
  if (!isObject(body)) return { kind: 'unknown', status, topLevelKeys };

  const windows: UsageWindow[] = [];
  for (const bucket of ['primary', 'secondary'] as const) {
    for (const root of rateLimitRoots(body)) {
      const window = parseWindow(root, bucket);
      if (window) {
        windows.push(window);
        break;
      }
    }
  }
  return windows.length > 0 ? windows : { kind: 'unknown', status, topLevelKeys };
}
