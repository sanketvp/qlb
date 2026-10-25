// Codex usage is not covered by claude-swap v0.28.0; probe order follows
// QLB spec §4.4.4. L14 and L34 deliberately remain unverified until C4-live.
import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config';
import { readCodexAuthStable, type CodexAuthDocument } from '../codex-auth';
import { buildUsageRequest, parseUsage, type UsageParseResult, type UsageWindow } from '../codex-oauth';

export const CODEX_USAGE_WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_USAGE_FALLBACK_URL = 'https://chatgpt.com/backend-api/api/codex/usage';
/** Bound passive fallback work when Codex has accumulated a large session history. */
export const MAX_ROLLOUT_FILES = 50;
const MAX_ROLLOUT_LINE_BYTES = 1024 * 1024;

export type CodexUsageSource = 'wham' | 'codex-api' | 'codex-rollout' | 'unknown';

export interface CodexUsageProbeResult {
  status: number | null;
  source: CodexUsageSource;
  keys: string[];
  windows?: UsageWindow[];
}

export interface RolloutSnapshot {
  /** Omitted when Codex's own persisted event did not identify an account. */
  accountId?: string;
  body: unknown;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CodexUsageProbeDeps {
  auth?: CodexAuthDocument;
  authPath?: string;
  fetchFn?: FetchFn;
  /** Returns active-account snapshots ordered newest first. */
  readRollout?: (activeAccountId: string) => Promise<RolloutSnapshot[]>;
}

interface Attempt {
  status: number | null;
  keys: string[];
  parsed: UsageParseResult | undefined;
}

function codexAuthPath(): string {
  return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'auth.json') : config.codexAuthJsonPath;
}

function objectKeys(bodyText: string): string[] {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.keys(parsed).slice(0, 20).map((key) => key.slice(0, 64));
  } catch {
    return [];
  }
}

function isUsable(parsed: UsageParseResult | undefined): parsed is UsageWindow[] {
  return Array.isArray(parsed) && parsed.length > 0;
}

function isUnparseable(parsed: UsageParseResult | undefined): boolean {
  return parsed !== undefined && !Array.isArray(parsed) && parsed.kind === 'unknown';
}

function accountId(doc: CodexAuthDocument): string | null {
  const value = doc.tokens.account_id;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

async function attemptUsage(
  url: string,
  accessToken: string,
  activeAccountId: string,
  fetchFn: FetchFn,
): Promise<Attempt> {
  try {
    const request = buildUsageRequest(accessToken, activeAccountId);
    const response = await fetchFn(url, { method: request.method, headers: request.headers });
    const body = await response.text();
    return { status: response.status, keys: objectKeys(body), parsed: parseUsage(response.status, body, response.headers) };
  } catch {
    // Network errors are intentionally summarized as no status/keys; never surface request details.
    return { status: null, keys: [], parsed: undefined };
  }
}

function nestedRateLimits(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const direct = object.rate_limits ?? object.rateLimits;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  for (const child of Object.values(object)) {
    const found = nestedRateLimits(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Streams bounded JSONL lines without retaining a rollout file in memory. */
async function streamRolloutLines(
  path: string,
  onLine: (line: string | undefined) => boolean,
): Promise<void> {
  let line = '';
  let tooLong = false;
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  for await (const chunk of stream) {
    for (const character of chunk) {
      if (character === '\n') {
        const value = tooLong ? undefined : line.endsWith('\r') ? line.slice(0, -1) : line;
        line = '';
        tooLong = false;
        if (!onLine(value)) return;
      } else if (!tooLong) {
        if (line.length >= MAX_ROLLOUT_LINE_BYTES) {
          line = '';
          tooLong = true;
        } else {
          line += character;
        }
      }
    }
  }
  if (line.length > 0 || tooLong) onLine(tooLong ? undefined : line);
}

async function firstRolloutLine(path: string): Promise<string | undefined> {
  let first: string | undefined;
  await streamRolloutLines(path, (line) => {
    first = line;
    return false;
  });
  return first;
}

function creatorAccountId(firstLine: string | undefined): string | undefined {
  if (!firstLine) return undefined;
  try {
    const event = JSON.parse(firstLine) as { payload?: Record<string, unknown> };
    const payload = event?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const account = payload.creator_account_id ?? payload.account_id;
    return typeof account === 'string' && account !== '' ? account : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads recent active-account Codex rollout snapshots without logging their contents.
 * The returned list is newest-first; each file retains only its final rate_limits event.
 */
async function readRolloutSnapshots(authPath: string, activeAccountId: string): Promise<RolloutSnapshot[]> {
  const sessions = join(join(authPath, '..'), 'sessions');
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
        } catch {
          // A concurrently removed snapshot is simply unavailable.
        }
      }
    }
  };
  await visit(sessions, 0);

  for (const file of files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_ROLLOUT_FILES)) {
    try {
      // Do not follow a newly swapped path; rollout data is advisory only.
      if (!(await lstat(file.path)).isFile()) continue;
      if (creatorAccountId(await firstRolloutLine(file.path)) !== activeAccountId) continue;

      let latestRateLimits: Record<string, unknown> | undefined;
      await streamRolloutLines(file.path, (line) => {
        if (!line || (!line.includes('rate_limits') && !line.includes('rateLimits'))) return true;
        try {
          latestRateLimits = nestedRateLimits(JSON.parse(line));
        } catch {
          // Codex may be in the middle of appending a line.
        }
        return true;
      });
      if (!latestRateLimits) continue;
      const snapshot = { accountId: activeAccountId, body: { rate_limits: latestRateLimits } };
      // Skip an invalid newer event and continue to an older bounded snapshot.
      if (rolloutWindows(snapshot)) return [snapshot];
    } catch {
      // A failed passive fallback must not make the usage probe throw.
    }
  }
  return [];
}

function rolloutWindows(snapshot: RolloutSnapshot): UsageWindow[] | undefined {
  const rateLimits = nestedRateLimits(snapshot.body);
  if (!rateLimits) return undefined;
  const parsed = parseUsage(200, JSON.stringify({ rate_limits: rateLimits }));
  return isUsable(parsed) ? parsed : undefined;
}

/**
 * Performs the three passive sources from §4.4.4: WHAM, Codex API fallback,
 * then Codex's own rollout snapshots. It returns metadata only, never a body
 * or credential value, so callers can safely print the S52 probe report.
 */
export async function probeCodexUsage(deps: CodexUsageProbeDeps = {}): Promise<CodexUsageProbeResult> {
  let auth = deps.auth;
  const authPath = deps.authPath ?? codexAuthPath();
  if (!auth) {
    const stable = await readCodexAuthStable(authPath);
    if (stable.status !== 'ok') return { status: null, source: 'unknown', keys: [] };
    auth = stable.doc;
  }
  const activeAccountId = accountId(auth);
  if (!activeAccountId || typeof auth.tokens.access_token !== 'string' || auth.tokens.access_token.length === 0) {
    return { status: null, source: 'unknown', keys: [] };
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const wham = await attemptUsage(CODEX_USAGE_WHAM_URL, auth.tokens.access_token, activeAccountId, fetchFn);
  if (isUsable(wham.parsed)) return { status: wham.status, source: 'wham', keys: wham.keys, windows: wham.parsed };

  let last = wham;
  if (wham.status === 404 || wham.status === 410 || isUnparseable(wham.parsed)) {
    const fallback = await attemptUsage(CODEX_USAGE_FALLBACK_URL, auth.tokens.access_token, activeAccountId, fetchFn);
    if (isUsable(fallback.parsed)) {
      return { status: fallback.status, source: 'codex-api', keys: fallback.keys, windows: fallback.parsed };
    }
    last = fallback;
  }

  const rollouts = await (deps.readRollout ?? ((id: string) => readRolloutSnapshots(authPath, id)))(activeAccountId);
  for (const snapshot of rollouts) {
    if (snapshot.accountId !== activeAccountId) continue;
    const windows = rolloutWindows(snapshot);
    if (windows) return { status: last.status, source: 'codex-rollout', keys: ['rate_limits'], windows };
  }
  return { status: last.status, source: 'unknown', keys: last.keys };
}

/** Registry-loaded usage adapter entry point used by later provider bindings. */
export default { probe: probeCodexUsage };
