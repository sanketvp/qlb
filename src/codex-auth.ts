import { createHash, randomBytes } from 'node:crypto';
import { open, readFile as readFileFromDisk, rename, unlink } from 'node:fs/promises';

const ACCESS_EXPIRY_BUFFER_MS = 5 * 60 * 1_000;
const REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1_000;
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

export interface CodexTokens extends Record<string, unknown> {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
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

export type CodexAuthStableResult =
  | { status: 'ok'; doc: CodexAuthDocument }
  | { status: 'wiped'; error: Exclude<CodexAuthParseError, { error: 'unparseable' }> }
  | { status: 'unstable' };

export interface ReadCodexAuthStableOptions {
  intervalMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void> | void;
  readFile?: (path: string, encoding: 'utf8') => Promise<string> | string;
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

  const required = ['id_token', 'access_token', 'refresh_token', 'account_id'] as const;
  if (required.some((key) => !nonEmptyString(rawTokens[key]))) {
    return { ok: false, error: 'tokens-empty', status: 'wiped' };
  }

  return {
    ok: true,
    doc: {
      ...parsed,
      tokens: rawTokens as CodexTokens,
      ...(typeof parsed.last_refresh === 'string' ? { last_refresh: parsed.last_refresh } : {}),
    },
  };
}

/** Returns the stable Codex identity key; email is deliberately not an identity field. */
export function codexIdentity(doc: CodexAuthDocument): CodexIdentity | null {
  const payload = decodeJwtPayload(doc.tokens.id_token);
  const authClaims = payload ? payload[OPENAI_AUTH_CLAIM] : undefined;
  if (!isObject(authClaims)) return null;

  const chatgptUserId = authClaims.chatgpt_user_id;
  const accountId = doc.tokens.account_id || authClaims.chatgpt_account_id;
  if (!nonEmptyString(chatgptUserId) || !nonEmptyString(accountId)) return null;
  return { chatgpt_user_id: chatgptUserId, account_id: accountId };
}

/** Returns the access-token JWT expiry in milliseconds, or null for an invalid JWT. */
export function accessExpiry(doc: CodexAuthDocument): number | null {
  const payload = decodeJwtPayload(doc.tokens.access_token);
  const exp = payload?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp * 1_000;
}

/** Codex refreshes at five minutes to expiry or after eight days without a refresh. */
export function needsRefresh(doc: CodexAuthDocument, now: number): boolean {
  const expiry = accessExpiry(doc);
  if (expiry !== null && expiry <= now + ACCESS_EXPIRY_BUFFER_MS) return true;

  if (typeof doc.last_refresh !== 'string') return false;
  const lastRefresh = Date.parse(doc.last_refresh);
  return Number.isFinite(lastRefresh) && lastRefresh <= now - REFRESH_AGE_MS;
}

/** A non-reversible identifier suitable for equality checks and persisted metadata. */
export function codexFingerprint(doc: CodexAuthDocument): string {
  return `sha256:${createHash('sha256').update(doc.tokens.refresh_token, 'utf8').digest('hex')}`;
}

/**
 * Writes an auth document using a same-directory, mode-0600 temporary file and
 * atomic rename. It never logs the document or any token it contains.
 */
export async function writeCodexAuthAtomic(path: string, doc: CodexAuthDocument): Promise<void> {
  const temporaryPath = `${path}.qlb-tmp-${randomBytes(8).toString('hex')}`;
  const contents = `${JSON.stringify(doc, null, 2)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryFileCreated = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    temporaryFileCreated = true;
    await handle.chmod(0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (temporaryFileCreated) await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readOnce(
  path: string,
  read: NonNullable<ReadCodexAuthStableOptions['readFile']>,
): Promise<{ text: string; parsed: CodexAuthParseResult } | null> {
  try {
    const text = await read(path, 'utf8');
    return { text, parsed: parseCodexAuth(text) };
  } catch {
    return null;
  }
}

/**
 * Reads auth.json only after two identical reads separated by an interval.
 * Codex writes in-place, so an unstable document is failed closed rather than
 * returned to a caller. `retries` is the number of two-read attempts.
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
    await sleep(intervalMs);
    const second = await readOnce(path, read);
    if (!first || !second || first.text !== second.text) continue;

    if (!first.parsed.ok) {
      if (first.parsed.error === 'unparseable') continue;
      return { status: 'wiped', error: first.parsed };
    }
    if (!second.parsed.ok) continue;
    return { status: 'ok', doc: first.parsed.doc };
  }
  return { status: 'unstable' };
}
