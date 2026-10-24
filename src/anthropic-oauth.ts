// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — oauth.py
// See third_party/claude-swap/LICENSE for the upstream license.

import { createHash } from 'node:crypto';

export const ANTHROPIC_OAUTH_BETA_HEADER = 'oauth-2025-04-20';
export const ANTHROPIC_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
export const FRESHEN_BUFFER_MS = 10 * 60 * 1000;
/** C-swap v0.28.0 `oauth.py` lines 538–563: canonical non-weekly window label. */
export const FIVE_HOUR_LABEL = '5h';

export type JsonObject = Record<string, unknown>;

export interface CredentialBlob {
  /** The parsed root object, retained verbatim so unknown fields retain their insertion order. */
  data: JsonObject;
  /** The OAuth payload when present; it is a reference into `data`, not a copy. */
  oauth: JsonObject | null;
}

export interface HttpRequestDescription {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  timeoutMs: number;
  body?: string;
}

export type RefreshClassification =
  | {
    kind: 'success';
    accessToken: string;
    refreshToken?: string;
    expiresInMs: number;
    scopes?: string[];
  }
  | { kind: 'dead' }
  | { kind: 'invalid_client' }
  | { kind: 'transient' };

export interface UsageBucket {
  usedPct: number;
  resetsAt?: string;
}

export interface ParsedUsageResponse {
  buckets: Record<string, UsageBucket>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a Claude Code credential blob without discarding unknown root or OAuth fields. */
export function parseCredentialBlob(credentials: string): CredentialBlob | null {
  try {
    const parsed: unknown = JSON.parse(credentials);
    if (!isObject(parsed)) return null;
    const oauth = isObject(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
    return { data: parsed, oauth };
  } catch {
    return null;
  }
}

/**
 * Serialize a previously parsed credential blob. JSON object insertion order is retained by
 * JavaScript, which preserves C-swap's unknown fields during a parse/update/serialize cycle.
 */
export function serializeCredentialBlob(blob: CredentialBlob): string {
  return JSON.stringify(blob.data);
}

/** Extract a usable access token from a Claude Code credential blob. */
export function extractAccessToken(credentials: string): string | null {
  const token = parseCredentialBlob(credentials)?.oauth?.accessToken;
  return typeof token === 'string' ? token : null;
}

/** Stable credential lineage identity, byte-for-byte compatible with C-swap's SHA-256 inputs. */
export function credentialFingerprint(credentials: string): string | null {
  if (!credentials) return null;
  const refreshToken = parseCredentialBlob(credentials)?.oauth?.refreshToken;
  if (typeof refreshToken === 'string' && refreshToken) {
    return `sha256:${createHash('sha256').update(refreshToken, 'utf8').digest('hex')}`;
  }
  return `sha256-full:${createHash('sha256').update(credentials, 'utf8').digest('hex')}`;
}

/** C-swap v0.28.0 `oauth.py` lines 63–70: identity for a rotating access token. */
export function accessTokenFingerprint(credentials: string): string | null {
  const accessToken = parseCredentialBlob(credentials)?.oauth?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  return `sha256-at:${createHash('sha256').update(accessToken, 'utf8').digest('hex')}`;
}

/** C-swap v0.28.0 `oauth.py` lines 73–92: stored-login expiry as second-precision UTC. */
export function loginExpiresAtIso(credentials: string): string | null {
  const value = parseCredentialBlob(credentials)?.oauth?.refreshTokenExpiresAt;
  if (!isFiniteNumber(value) || value <= 0) return null;
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function expiresWithin(expiresAt: unknown, bufferMs: number, nowMs: number): boolean {
  if (!isFiniteNumber(expiresAt)) return false;
  // Python's int(expires_at) truncates toward zero before comparing.
  return nowMs + bufferMs >= Math.trunc(expiresAt);
}

/** Whether the token is already expired, without C-swap's proactive refresh buffer. */
export function isExpired(expiresAt: unknown, nowMs = Date.now()): boolean {
  return expiresWithin(expiresAt, 0, nowMs);
}

/**
 * C-swap's `is_oauth_token_expired`: true for an expired token or one at/inside its
 * five-minute refresh window.
 */
export function isOAuthTokenExpired(expiresAt: unknown, nowMs = Date.now()): boolean {
  return expiresWithin(expiresAt, OAUTH_EXPIRY_BUFFER_MS, nowMs);
}

/** Alias which makes the proactive five-minute intent explicit at switch call sites. */
export function isWithinRefreshWindow(expiresAt: unknown, nowMs = Date.now()): boolean {
  return isOAuthTokenExpired(expiresAt, nowMs);
}

/** C-swap autoswitch's ten-minute freshen-before-activation predicate. */
export function needsFreshenBeforeSwitch(expiresAt: unknown, nowMs = Date.now()): boolean {
  return expiresWithin(expiresAt, FRESHEN_BUFFER_MS, nowMs);
}

/** Describe C-swap's refresh-token POST. This function deliberately performs no I/O. */
export function buildRefreshRequest(credentials: string): HttpRequestDescription | null {
  const refreshToken = parseCredentialBlob(credentials)?.oauth?.refreshToken;
  if (typeof refreshToken !== 'string' || !refreshToken) return null;
  return {
    url: ANTHROPIC_OAUTH_TOKEN_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'claude-swap/1.0',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    }),
    timeoutMs: 6_000,
  };
}

/**
 * Classify a token-endpoint response. C-swap v0.28.0 `oauth.py` lines 154–167 and
 * 200–225 makes a missing refresh token or `invalid_grant` permanently dead;
 * `invalid_client` is deterministic but systemic, and all other failures are transient.
 */
export function classifyRefreshResponse(status: number | null | undefined, body: string): RefreshClassification {
  if (typeof status === 'number' && status >= 200 && status < 300) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (!isObject(parsed) || typeof parsed.access_token !== 'string' || !isFiniteNumber(parsed.expires_in)) {
        return { kind: 'transient' };
      }
      if (parsed.scope != null && typeof parsed.scope !== 'string') return { kind: 'transient' };
      if (parsed.refresh_token != null && typeof parsed.refresh_token !== 'string') return { kind: 'transient' };
      const result: Extract<RefreshClassification, { kind: 'success' }> = {
        kind: 'success',
        accessToken: parsed.access_token,
        expiresInMs: parsed.expires_in * 1000,
      };
      if (parsed.refresh_token) result.refreshToken = parsed.refresh_token;
      if (parsed.scope) result.scopes = parsed.scope.split(' ');
      return result;
    } catch {
      return { kind: 'transient' };
    }
  }

  if (typeof status === 'number' && (status === 400 || status === 401 || status === 403)) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (isObject(parsed) && parsed.error === 'invalid_grant') return { kind: 'dead' };
      if (isObject(parsed) && parsed.error === 'invalid_client') return { kind: 'invalid_client' };
    } catch {
      // An unparseable body is intentionally ambiguous, hence transient.
    }
  }
  return { kind: 'transient' };
}

/** Describe the OAuth usage GET. This function deliberately performs no I/O. */
export function buildUsageRequest(accessToken: string): HttpRequestDescription {
  return {
    url: ANTHROPIC_USAGE_URL,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': ANTHROPIC_OAUTH_BETA_HEADER,
      'User-Agent': 'claude-swap/1.0',
    },
    timeoutMs: 5_000,
  };
}

function addUsageBucket(
  buckets: Record<string, UsageBucket>,
  key: string,
  value: unknown,
): void {
  if (!isObject(value) || !isFiniteNumber(value.utilization)) return;
  const bucket: UsageBucket = { usedPct: value.utilization };
  if (typeof value.resets_at === 'string' && value.resets_at) bucket.resetsAt = value.resets_at;
  buckets[key] = bucket;
}

/**
 * Normalize C-swap's usage endpoint shape into QLB's 5h / 7d / 7d:<model> buckets.
 * Older responses simply omit `limits`; malformed individual entries are ignored.
 */
export function parseUsageResponse(data: unknown): ParsedUsageResponse {
  const buckets: Record<string, UsageBucket> = {};
  if (!isObject(data)) return { buckets };

  addUsageBucket(buckets, FIVE_HOUR_LABEL, data.five_hour);
  addUsageBucket(buckets, '7d', data.seven_day);

  if (Array.isArray(data.limits)) {
    for (const limit of data.limits) {
      if (!isObject(limit) || !isFiniteNumber(limit.percent)) continue;
      const scope = isObject(limit.scope) ? limit.scope : null;
      const model = scope && isObject(scope.model) ? scope.model : null;
      const name = model?.display_name;
      if (typeof name !== 'string' || !name) continue;
      const bucket: UsageBucket = { usedPct: limit.percent };
      if (typeof limit.resets_at === 'string' && limit.resets_at) bucket.resetsAt = limit.resets_at;
      buckets[`7d:${name}`] = bucket;
    }
  }
  return { buckets };
}
