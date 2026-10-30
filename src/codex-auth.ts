import { createHash } from 'node:crypto';
import { open as openFile, readFile as readFileFromDisk } from 'node:fs/promises';
import { atomicWriteText } from './fsutil';

const ACCESS_EXPIRY_BUFFER_MS = 5 * 60 * 1_000;
const REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1_000;
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

export interface CodexTokens extends Record<string, unknown> {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string | null;
}

/** The complete auth.json shape, including fields Codex may add in the future. */
export interface CodexAuthDocument extends Record<string, unknown> {
  tokens: CodexTokens;
  last_refresh?: string;
}

export type CodexAuthParseError =
  | { ok: false; error: 'unparseable' }
  | { ok: false; error: 'tokens-absent' }
  | { ok: false; error: 'tokens-empty'; status: 'wiped' };

export type CodexAuthParseResult =
  | { ok: true; doc: CodexAuthDocument }
  | CodexAuthParseError;

export type CodexIdentity = {
  chatgpt_user_id: string;
  account_id: string;
};

/**
 * Canonical persisted identity form used by Codex slots and session holders.
 * The field order is fixed so every caller derives the S29 composite key alike.
 */
export function codexIdentityKey(identity: CodexIdentity): string {
  return `${identity.chatgpt_user_id}:${identity.account_id}`;
}

export type CodexAuthStableResult =
  | { status: 'ok'; doc: CodexAuthDocument }
  | { status: 'wiped'; error: Exclude<CodexAuthParseError, { error: 'unparseable' }> }
  | { status: 'missing' }
  | { status: 'unreadable'; code: string }
  | { status: 'unstable' };

export interface ReadCodexAuthStableOptions {
  intervalMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void> | void;
  readFile?: (path: string, encoding: 'utf8') => Promise<string> | string;
}

export type CodexAuthStableWithStatResult =
  | { status: 'ok'; doc: CodexAuthDocument; sha256: string; inode: number }
  | { status: 'wiped'; error: Exclude<CodexAuthParseError, { error: 'unparseable' }> }
  | { status: 'missing' }
  | { status: 'unreadable'; code: string }
  | { status: 'unstable' };

export interface ReadCodexAuthStableWithStatOptions {
  openRead?: (path: string) => Promise<{ text: string; ino: number }> | { text: string; ino: number };
  attempts?: number;
  delayMs?: number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function decodeJwtPayload(token: string): JsonObject | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[1].length === 0) return null;
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return isObject(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Returns sorted ID-token claim names without retaining their values. */
export function idTokenClaimNames(doc: CodexAuthDocument): string[] {
  const idToken = doc?.tokens?.id_token;
  const payload = typeof idToken === 'string' ? decodeJwtPayload(idToken) : null;
  return payload ? Object.keys(payload).sort() : [];
}

/** Returns the numeric ID-token auth_time claim, if the token is well-formed. */
export function authTime(doc: CodexAuthDocument): number | undefined {
  const idToken = doc?.tokens?.id_token;
  const payload = typeof idToken === 'string' ? decodeJwtPayload(idToken) : null;
  return typeof payload?.auth_time === 'number' ? payload.auth_time : undefined;
}

/** Parses an auth.json without exposing any credential value in errors. */
export function parseCodexAuth(text: string): CodexAuthParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: 'unparseable' };
  }
  if (!isObject(parsed)) return { ok: false, error: 'unparseable' };

  const rawTokens = parsed.tokens;
  if (!isObject(rawTokens)) return { ok: false, error: 'tokens-absent' };

  const required = ['id_token', 'access_token', 'refresh_token'] as const;
  if (required.some((key) => !nonEmptyString(rawTokens[key]))) {
    return { ok: false, error: 'tokens-empty', status: 'wiped' };
  }

  const { last_refresh: _lastRefresh, ...documentFields } = parsed;
  return {
    ok: true,
    doc: {
      ...documentFields,
      tokens: rawTokens as CodexTokens,
      ...(typeof parsed.last_refresh === 'string' ? { last_refresh: parsed.last_refresh } : {}),
    },
  };
}

/** Returns the S29 composite Codex identity key; email is deliberately not an identity field. */
export function codexIdentity(doc: CodexAuthDocument): string | null {
  const payload = decodeJwtPayload(doc.tokens.id_token);
  const authClaims = payload ? payload[OPENAI_AUTH_CLAIM] : undefined;
  if (!isObject(authClaims)) return null;

  const chatgptUserId = authClaims.chatgpt_user_id;
  const accountId = doc.tokens.account_id || authClaims.chatgpt_account_id;
  if (!nonEmptyString(chatgptUserId) || !nonEmptyString(accountId)) return null;
  return codexIdentityKey({ chatgpt_user_id: chatgptUserId, account_id: accountId });
}

/** Returns the S29 slot id from a Pi access grant, or null when its identity is incomplete. */
export function codexSlotIdFromAccessToken(access: string, bareAccountId?: string): string | null {
  const payload = decodeJwtPayload(access);
  const authClaims = payload ? payload[OPENAI_AUTH_CLAIM] : undefined;
  if (!isObject(authClaims)) return null;

  const chatgptUserId = authClaims.chatgpt_user_id;
  const accountId = bareAccountId || authClaims.chatgpt_account_id;
  if (!nonEmptyString(chatgptUserId) || !nonEmptyString(accountId)) return null;
  return codexIdentityKey({ chatgpt_user_id: chatgptUserId, account_id: accountId });
}

/** Returns the access-token JWT expiry in milliseconds, or null for an invalid JWT. */
export function accessExpiry(doc: CodexAuthDocument): number | null {
  const payload = decodeJwtPayload(doc.tokens.access_token);
  const exp = payload?.exp;
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) return null;
  const expiry = exp * 1_000;
  return Number.isSafeInteger(expiry) ? expiry : null;
}

/** Codex refreshes at five minutes to expiry or after eight days without a refresh. */
export function needsRefresh(doc: CodexAuthDocument, now: number): boolean {
  const expiry = accessExpiry(doc);
  if (expiry === null || expiry <= now + ACCESS_EXPIRY_BUFFER_MS) return true;

  if (typeof doc.last_refresh !== 'string') return true;
  const isIsoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!isIsoTimestamp.test(doc.last_refresh)) return true;
  const lastRefresh = Date.parse(doc.last_refresh);
  return !Number.isFinite(lastRefresh) || lastRefresh > now || lastRefresh <= now - REFRESH_AGE_MS;
}

/** A non-reversible identifier suitable for equality checks and persisted metadata. */
export function codexFingerprint(doc: CodexAuthDocument): string {
  return `sha256:${createHash('sha256').update(doc.tokens.refresh_token, 'utf8').digest('hex')}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/**
 * Atomically publishes an auth document through fsutil and returns its inode.
 * The shared writer creates a private mode-0600 temporary file, fsyncs it, and
 * writes through a final-path symlink rather than replacing that symlink.
 *
 * Production callers must hold withCodexAuthLock across their live-file read,
 * attribution decision, and this write. The lock is intentionally not acquired
 * here because it is non-reentrant and the decision must stay protected until
 * publication completes.
 */
export async function writeCodexAuthAtomic(path: string, doc: CodexAuthDocument): Promise<number> {
  return atomicWriteText(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ReadCodexAuthOnceResult =
  | { status: 'read'; text: string; parsed: CodexAuthParseResult }
  | { status: 'missing' }
  | { status: 'unreadable'; code: string };

type ReadCodexAuthOnceWithStatResult =
  | { status: 'read'; text: string; ino: number; parsed: CodexAuthParseResult }
  | { status: 'missing' }
  | { status: 'unreadable'; code: string };

function classifyReadError(error: unknown): Extract<ReadCodexAuthOnceResult, { status: 'missing' | 'unreadable' }> {
  const code = errorCode(error);
  return code === 'ENOENT'
    ? { status: 'missing' }
    : { status: 'unreadable', code: code ?? 'UNKNOWN' };
}

async function readOnce(
  path: string,
  read: NonNullable<ReadCodexAuthStableOptions['readFile']>,
): Promise<ReadCodexAuthOnceResult> {
  try {
    const text = await read(path, 'utf8');
    return { status: 'read', text, parsed: parseCodexAuth(text) };
  } catch (error) {
    return classifyReadError(error);
  }
}

async function defaultOpenRead(path: string): Promise<{ text: string; ino: number }> {
  const handle = await openFile(path);
  try {
    const metadata = await handle.stat();
    const text = await handle.readFile({ encoding: 'utf8' });
    return { text, ino: metadata.ino };
  } finally {
    await handle.close();
  }
}

async function readOnceWithStat(
  path: string,
  openRead: NonNullable<ReadCodexAuthStableWithStatOptions['openRead']>,
): Promise<ReadCodexAuthOnceWithStatResult> {
  try {
    const { text, ino } = await openRead(path);
    return { status: 'read', text, ino, parsed: parseCodexAuth(text) };
  } catch (error) {
    return classifyReadError(error);
  }
}

/**
 * Reads auth.json only after two identical successful reads separated by an
 * interval. `unstable` means Codex may be writing; `missing` and `unreadable`
 * instead report an absent document or a read failure. `retries` is the number
 * of two-read attempts.
 */
export async function readCodexAuthStable(
  path: string,
  options: ReadCodexAuthStableOptions = {},
): Promise<CodexAuthStableResult> {
  const intervalMs = options.intervalMs ?? 200;
  const retries = options.retries ?? 5;
  const sleep = options.sleep ?? defaultSleep;
  const read = options.readFile ?? readFileFromDisk;
  const attempts = Math.max(1, Math.floor(retries));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const first = await readOnce(path, read);
    if (first.status === 'missing') return first;
    if (first.status === 'unreadable') return first;

    await sleep(intervalMs);
    const second = await readOnce(path, read);
    if (second.status === 'missing') return second;
    if (second.status === 'unreadable') return second;
    if (first.text !== second.text) continue;

    if (!first.parsed.ok) {
      if (first.parsed.error === 'unparseable') continue;
      return { status: 'wiped', error: first.parsed };
    }
    if (!second.parsed.ok) continue;
    return { status: 'ok', doc: first.parsed.doc };
  }
  return { status: 'unstable' };
}

/**
 * Reads auth.json through one file descriptor per observation. A document is
 * stable only if both its bytes and inode match on two consecutive reads.
 */
export async function readCodexAuthStableWithStat(
  path: string,
  options: ReadCodexAuthStableWithStatOptions = {},
): Promise<CodexAuthStableWithStatResult> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 5));
  const delayMs = options.delayMs ?? 200;
  const openRead = options.openRead ?? defaultOpenRead;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const first = await readOnceWithStat(path, openRead);
    if (first.status === 'missing' || first.status === 'unreadable') return first;

    await defaultSleep(delayMs);
    const second = await readOnceWithStat(path, openRead);
    if (second.status === 'missing' || second.status === 'unreadable') return second;
    if (first.text !== second.text || first.ino !== second.ino) continue;

    if (!first.parsed.ok) {
      if (first.parsed.error === 'unparseable') continue;
      return { status: 'wiped', error: first.parsed };
    }
    if (!second.parsed.ok) continue;
    return {
      status: 'ok',
      doc: first.parsed.doc,
      sha256: `sha256-file:${createHash('sha256').update(first.text, 'utf8').digest('hex')}`,
      inode: first.ino,
    };
  }
  return { status: 'unstable' };
}
