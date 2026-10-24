// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — oauth.py
// See third_party/claude-swap/LICENSE for the upstream license.

import { createHash } from 'node:crypto';

export const ANTHROPIC_OAUTH_BETA_HEADER = 'oauth-2025-04-20';
export const ANTHROPIC_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const ANTHROPIC_OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
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

/** The pre-request outcomes from C-swap's `try_refresh_oauth_credentials`. */
export type RefreshRequestClassification =
  | { kind: 'request'; request: HttpRequestDescription }
  | { kind: 'no_refresh_token' }
  | { kind: 'transient' };

export interface OAuthAccount {
  uuid: string;
  email: string | null;
  organizationUuid: string | null;
}

export type RefreshClassification =
  | {
    kind: 'success';
    accessToken: string;
    refreshToken?: string;
    expiresInMs: number;
    scopes?: string[];
    tokenAccount?: OAuthAccount;
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

export interface LoginExpiryField {
  field: 'refreshTokenExpiresAt';
  iso: string | null;
}

/** C-swap v0.28.0 `oauth.py` lines 73–92: the stored-login expiry field and its UTC ISO value. */
export function loginExpiryField(blob: CredentialBlob | null): LoginExpiryField {
  const field = 'refreshTokenExpiresAt' as const;
  const value = blob?.oauth?.[field];
  if (!isFiniteNumber(value) || value <= 0) return { field, iso: null };
  const date = new Date(value);
  // Python's datetime.fromtimestamp rejects years above 9999 rather than
  // returning None. Keep that failure boundary instead of emitting JS's
  // extended-year ISO form.
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > 9999) {
    throw new RangeError(`${field} is outside the supported date range`);
  }
  return { field, iso: date.toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

/** C-swap v0.28.0 `oauth.py` lines 73–92: stored-login expiry as second-precision UTC. */
export function loginExpiresAtIso(credentials: string): string | null {
  return loginExpiryField(parseCredentialBlob(credentials)).iso;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPythonExpiryNumber(value: unknown): value is number | boolean {
  // `bool` is an `int` subclass in Python, so true is the epoch millisecond 1.
  return typeof value === 'boolean' || isFiniteNumber(value);
}

function expiresWithin(expiresAt: unknown, bufferMs: number, nowMs: number): boolean {
  if (!isPythonExpiryNumber(expiresAt)) return false;
  // Python's int(expires_at) truncates toward zero before comparing.
  return nowMs + bufferMs >= Math.trunc(Number(expiresAt));
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
  if (!isPythonExpiryNumber(expiresAt)) return false;
  // autoswitch.py compares this one directly, without int() truncation.
  return nowMs + FRESHEN_BUFFER_MS >= Number(expiresAt);
}

/** Describe C-swap's refresh-token POST. This function deliberately performs no I/O. */
export function buildRefreshRequest(
  credentials: string,
  timeoutMs = 10_000,
): RefreshRequestClassification {
  // S18 narrows the permanent outcome to a complete OAuth object with an
  // absent refresh token; malformed credential shapes can be torn reads.
  let data: unknown;
  try {
    data = JSON.parse(credentials);
  } catch {
    return { kind: 'transient' };
  }
  if (!isObject(data)) return { kind: 'transient' };
  const oauth = data.claudeAiOauth;
  if (!isObject(oauth)) return { kind: 'transient' };
  const refreshToken = oauth.refreshToken;
  if (refreshToken == null || (typeof refreshToken === 'string' && !refreshToken.trim())) {
    return { kind: 'no_refresh_token' };
  }
  if (typeof refreshToken !== 'string') return { kind: 'transient' };
  return {
    kind: 'request',
    request: {
      url: ANTHROPIC_OAUTH_TOKEN_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'claude-swap/1.0',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      }),
      timeoutMs,
    },
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
      const expiresInMs = parsed.expires_in * 1000;
      if (!Number.isFinite(expiresInMs)) return { kind: 'transient' };
      const result: Extract<RefreshClassification, { kind: 'success' }> = {
        kind: 'success',
        accessToken: parsed.access_token,
        expiresInMs,
      };
      if (parsed.refresh_token) result.refreshToken = parsed.refresh_token;
      if (parsed.scope) result.scopes = parsed.scope.split(/\s+/).filter(Boolean);
      const tokenAccount = parseTokenAccount(parsed);
      if (tokenAccount) result.tokenAccount = tokenAccount;
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

function parseAccount(
  data: unknown,
  emailField: 'email' | 'email_address',
): OAuthAccount | null {
  if (!isObject(data)) return null;
  const account = data.account;
  if (!isObject(account) || typeof account.uuid !== 'string' || !account.uuid.trim()) return null;
  const organization = isObject(data.organization) ? data.organization : null;
  return {
    uuid: account.uuid.trim(),
    email: typeof account[emailField] === 'string' ? account[emailField] : null,
    organizationUuid: organization && typeof organization.uuid === 'string' ? organization.uuid : null,
  };
}

/** Parse the optional account identity included in a successful token response. */
export function parseTokenAccount(data: unknown): OAuthAccount | null {
  return parseAccount(data, 'email_address');
}

/** Describe the profile GET. This function deliberately performs no I/O. */
export function buildProfileRequest(accessToken: string): HttpRequestDescription {
  return {
    url: ANTHROPIC_OAUTH_PROFILE_URL,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'claude-swap/1.0',
    },
    timeoutMs: 5_000,
  };
}

/** Parse a profile response, resolving only a non-empty account UUID. */
export function parseProfileResponse(data: unknown): OAuthAccount | null {
  return parseAccount(data, 'email');
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

function isPythonFalsy(value: unknown): boolean {
  return value == null || value === false || value === 0 || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (isObject(value) && Object.keys(value).length === 0);
}

function usableUsagePct(value: unknown): number | undefined {
  // Python's isinstance(..., (int, float)) includes bool; normalize that
  // numeric value because this port's buckets are explicitly numeric.
  if (typeof value === 'boolean') return Number(value);
  return isFiniteNumber(value) ? value : undefined;
}

function validatedResetAt(value: unknown): string | undefined {
  if (isPythonFalsy(value)) return undefined;
  if (typeof value !== 'string') throw new TypeError('resets_at must be a string');
  // format_reset parses an ISO datetime and then subtracts an aware UTC now;
  // a timezone-less/date-only string therefore fails there too.
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) {
    throw new RangeError('resets_at is not a parseable ISO-8601 timestamp');
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1 || year > 9999 || month < 1 || month > 12 || day < 1
    || calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day || hour > 23 || minute > 59 || (second !== 0 && second > 59)
  ) {
    throw new RangeError('resets_at is not a parseable ISO-8601 timestamp');
  }
  return value;
}

function addUsageBucket(
  buckets: Record<string, UsageBucket>,
  key: string,
  value: unknown,
): void {
  // build_usage_result only skips Python-falsy windows; a truthy malformed
  // window raises. A present non-numeric utilization is retained upstream but
  // filtered later by relevant_windows, so omit only that unusable bucket here.
  if (isPythonFalsy(value)) return;
  if (!isObject(value) || !Object.hasOwn(value, 'utilization')) {
    throw new TypeError(`${key} usage window lacks utilization`);
  }
  const resetsAt = validatedResetAt(value.resets_at);
  const usedPct = usableUsagePct(value.utilization);
  if (usedPct === undefined) return;
  const bucket: UsageBucket = { usedPct };
  if (resetsAt !== undefined) bucket.resetsAt = resetsAt;
  buckets[key] = bucket;
}

/**
 * Normalize C-swap's usage endpoint shape into QLB's 5h / 7d / 7d:<model> buckets.
 * Older responses simply omit `limits`; malformed individual entries are ignored.
 * As upstream does, a non-object response, malformed present base window, or invalid
 * truthy reset timestamp throws.
 */
export function parseUsageResponse(data: unknown): ParsedUsageResponse {
  if (!isObject(data)) throw new TypeError('usage response must be an object');
  const buckets: Record<string, UsageBucket> = {};

  addUsageBucket(buckets, FIVE_HOUR_LABEL, data.five_hour);
  addUsageBucket(buckets, '7d', data.seven_day);

  if (Array.isArray(data.limits)) {
    for (const limit of data.limits) {
      if (!isObject(limit)) continue;
      const scope = isObject(limit.scope) ? limit.scope : null;
      const model = scope && isObject(scope.model) ? scope.model : null;
      const name = model?.display_name;
      const usedPct = usableUsagePct(limit.percent);
      if (typeof name !== 'string' || !name || usedPct === undefined) continue;
      const bucket: UsageBucket = { usedPct };
      const resetsAt = validatedResetAt(limit.resets_at);
      if (resetsAt !== undefined) bucket.resetsAt = resetsAt;
      // Preserve display names verbatim. Duplicate names cannot both be keys,
      // so retain the binding (highest-use) window and its corresponding reset.
      const key = `7d:${name}`;
      const existing = buckets[key];
      if (!existing || bucket.usedPct > existing.usedPct) buckets[key] = bucket;
    }
  }
  return { buckets };
}
