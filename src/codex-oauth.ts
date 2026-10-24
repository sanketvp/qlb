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

export type RefreshReason =
  | 'proactive_expiry'
  | 'scheduled'
  | 'unauthorized_recovery'
  | 'forced';

/** Refresh causes owned by QLB's Codex consume and explicit-refresh paths. */
export type RefreshTrigger =
  | 'proactive-expiry'
  | 'scheduled'
  | 'unauthorized'
  | 'force';

/**
 * Maps QLB's refresh triggers to Codex's wire values. Codex declares the four
 * spellings in oauth/client.rs:47-61 and includes the chosen value only when
 * constructing a refresh grant (oauth/client.rs:97-112).
 */
export function refreshReasonFor(trigger: RefreshTrigger): RefreshReason {
  switch (trigger) {
    case 'proactive-expiry':
      return 'proactive_expiry';
    case 'scheduled':
      return 'scheduled';
    case 'unauthorized':
      return 'unauthorized_recovery';
    case 'force':
      return 'forced';
  }
}

export interface CodexTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

export interface CodexAuthDocument {
  tokens: Record<string, unknown>;
  last_refresh?: unknown;
  [key: string]: unknown;
}

export type DeadReason =
  | 'refresh_token_expired'
  | 'refresh_token_reused'
  | 'refresh_token_invalidated'
  | 'invalid_grant'
  | 'http_401';

export type TransientReason =
  | 'invalid_success_response'
  | 'unparseable_response'
  | 'http_error';

export type RefreshClassification =
  | { kind: 'ok'; tokens: CodexTokens }
  | { kind: 'dead'; reason: DeadReason }
  | { kind: 'transient'; reason: TransientReason };

export interface UsageWindow {
  bucket: 'primary' | 'secondary';
  usedPct: number;
  /** True when a server-provided percentage was outside the valid [0, 100] range. */
  clamped?: true;
  resetAt?: number;
  windowMin?: number;
}

export type UsageParseResult =
  | UsageWindow[]
  | { kind: 'unknown'; status: number; topLevelKeys: string[] }
  | { kind: 'unauthorized' }
  | { kind: 'rate-limited'; retryAfter: number | undefined }
  | { kind: 'http_error'; status: number };

export type UsageResponseHeaders =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Describes a Codex refresh request without sending it. Codex 0.164.0
 * serializes refresh grants as JSON, not form data, and sends refresh_reason
 * when one is supplied (oauth/client.rs:97-112).
 */
export function buildRefreshRequest(
  refreshToken: string,
  reason: RefreshReason,
): RequestDescription {
  // OAuthClient collects parameters in a BTreeMap before JSON serialization,
  // hence the intentionally stable key order here (oauth/client.rs:110-128).
  return withRedactedJson({
    url: CODEX_REFRESH_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_reason: reason,
      refresh_token: refreshToken,
    }),
  });
}

/** Adds a non-enumerable JSON view so descriptor logging cannot leak credentials. */
function withRedactedJson(request: RequestDescription): RequestDescription {
  Object.defineProperty(request, 'toJSON', {
    enumerable: false,
    value: () => {
      const headers = { ...request.headers };
      if (headers.Authorization?.startsWith('Bearer ')) {
        headers.Authorization = 'Bearer [redacted]';
      }

      let body = request.body;
      const parsedBody = body === undefined ? undefined : parseJson(body);
      if (isObject(parsedBody) && Object.hasOwn(parsedBody, 'refresh_token')) {
        body = JSON.stringify({ ...parsedBody, refresh_token: '[redacted]' });
      }

      return body === undefined ? { ...request, headers } : { ...request, headers, body };
    },
  });
  return request;
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
  const tokens: CodexTokens = {};
  const idToken = nonEmptyString(body.id_token);
  const accessToken = nonEmptyString(body.access_token);
  const refreshToken = nonEmptyString(body.refresh_token);
  if (idToken) tokens.id_token = idToken;
  if (accessToken) tokens.access_token = accessToken;
  if (refreshToken) tokens.refresh_token = refreshToken;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

/**
 * Classifies a completed refresh response without retaining its raw body.
 * Codex manager.rs:1728-1741 reads the provider code before its 401 fallback.
 * Preserve every recognized 4xx code so the consumer can apply its holder rule.
 */
export function classifyRefreshResponse(status: number, bodyText: string): RefreshClassification {
  const body = parseJson(bodyText);
  if (status >= 200 && status < 300) {
    const tokens = successTokens(body);
    return tokens
      ? { kind: 'ok', tokens }
      : { kind: 'transient', reason: 'invalid_success_response' };
  }

  const code = oauthErrorCode(body)?.toLowerCase();
  if (
    status >= 400 && status < 500 &&
    (code === 'refresh_token_expired' ||
      code === 'refresh_token_reused' ||
      code === 'refresh_token_invalidated' ||
      code === 'invalid_grant')
  ) {
    return { kind: 'dead', reason: code };
  }
  if (status === 401) return { kind: 'dead', reason: 'http_401' };

  return {
    kind: 'transient',
    reason: body === undefined ? 'unparseable_response' : 'http_error',
  };
}

/** Returns a new document, retaining every field not replaced by the rotation. */
export function applyRefresh(
  doc: CodexAuthDocument,
  tokens: CodexTokens,
  now: Date | number,
): CodexAuthDocument {
  const refreshedTokens = { ...doc.tokens };
  for (const key of ['id_token', 'access_token', 'refresh_token'] as const) {
    const value = tokens[key];
    if (Object.hasOwn(tokens, key) && nonEmptyString(value)) {
      refreshedTokens[key] = value;
    }
  }
  return {
    ...doc,
    tokens: refreshedTokens,
    last_refresh: new Date(now).toISOString(),
  };
}

/** Describes, but does not execute, the Codex usage request for `tokens.account_id`. */
export function buildUsageRequest(accessToken: string, accountId: string): RequestDescription {
  if (accountId === 'codex-default') {
    throw new Error('Codex usage requests require tokens.account_id, not codex-default');
  }
  return withRedactedJson({
    url: CODEX_USAGE_URL,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': accountId,
    },
  });
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
  const rawUsedPct = asFiniteNumber(raw.used_percent) ??
    asFiniteNumber(raw.usedPercent) ??
    asFiniteNumber(raw.used_pct);
  if (rawUsedPct === undefined) return undefined;
  const usedPct = Math.min(100, Math.max(0, rawUsedPct));
  const resetAt = parseResetAt(raw.reset_at) ??
    parseResetAt(raw.resets_at) ??
    parseResetAt(raw.resetAt) ??
    parseResetAt(raw.resetsAt);
  const windowMin = asFiniteNumber(raw.window_minutes) ?? asFiniteNumber(raw.windowMinutes);
  return {
    bucket,
    usedPct,
    ...(usedPct !== rawUsedPct ? { clamped: true as const } : {}),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(windowMin === undefined ? {} : { windowMin }),
  };
}

function headerValue(headers: UsageResponseHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function retryAfter(body: unknown, headers: UsageResponseHeaders | undefined): number | undefined {
  const value = isObject(body)
    ? asFiniteNumber(body.retry_after) ?? asFiniteNumber(body.retryAfter)
    : undefined;
  const seconds = value ?? asFiniteNumber(headerValue(headers, 'Retry-After'));
  return seconds === undefined ? undefined : Math.min(86_400, Math.max(0, seconds));
}

function safeTopLevelKeys(body: JsonObject): string[] {
  return Object.keys(body).slice(0, 20).map((key) => key.slice(0, 64));
}

/**
 * Parses only recognized usage gauges. The WHAM endpoint's body shape is L14
 * UNVERIFIED, so an unfamiliar response returns metadata only, never body text.
 */
export function parseUsage(
  status: number,
  bodyText: string,
  headers?: UsageResponseHeaders,
): UsageParseResult {
  if (status === 401) return { kind: 'unauthorized' };

  const body = parseJson(bodyText);
  if (status === 429) return { kind: 'rate-limited', retryAfter: retryAfter(body, headers) };
  if (status < 200 || status >= 300) return { kind: 'http_error', status };

  const topLevelKeys = isObject(body) ? safeTopLevelKeys(body) : [];
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
