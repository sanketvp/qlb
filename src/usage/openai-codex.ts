// Codex usage is not covered by claude-swap v0.28.0; probe order follows
// QLB spec §4.4.4. L14 and L34 deliberately remain unverified until C4-live.
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config';
import { readCodexAuthStable, type CodexAuthDocument } from '../codex-auth';
import { buildUsageRequest, parseUsage, type UsageParseResult, type UsageWindow } from '../codex-oauth';

export const CODEX_USAGE_WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_USAGE_FALLBACK_URL = 'https://chatgpt.com/backend-api/api/codex/usage';

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
  readRollout?: () => Promise<RolloutSnapshot[]>;
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

function nestedAccountId(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.account_id === 'string') return object.account_id;
  for (const child of Object.values(object)) {
    const found = nestedAccountId(child, depth + 1);
    if (found) return found;
  }
  return undefined;
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

/**
 * Reads recent Codex rollout JSONL snapshots without logging their contents.
 * Files without an account marker are tied to the active auth document because
 * this command never probes an inactive account; marked foreign events are ignored.
 */
async function readRolloutSnapshots(authPath: string): Promise<RolloutSnapshot[]> {
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
          const info = await stat(path);
          files.push({ path, mtimeMs: info.mtimeMs });
        } catch {
          // A concurrently removed snapshot is simply unavailable.
        }
      }
    }
  };
  await visit(sessions, 0);
  const snapshots: RolloutSnapshot[] = [];
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    try {
      // Do not follow a newly swapped path; rollout data is advisory only.
      if (!(await lstat(file.path)).isFile()) continue;
      const lines = (await readFile(file.path, 'utf8')).split('\n');
      for (const line of lines) {
        if (line.length === 0) continue;
        try {
          const body = JSON.parse(line) as unknown;
          if (body && typeof body === 'object' && !Array.isArray(body)) {
            snapshots.push({ accountId: nestedAccountId(body), body });
          }
        } catch {
          // Codex may be in the middle of appending a line.
        }
      }
    } catch {
      // A failed passive fallback must not make the usage probe throw.
    }
  }
  return snapshots;
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

  const rollouts = await (deps.readRollout ?? (() => readRolloutSnapshots(authPath)))();
  for (const snapshot of rollouts) {
    if (snapshot.accountId !== undefined && snapshot.accountId !== activeAccountId) continue;
    const windows = rolloutWindows(snapshot);
    if (windows) return { status: last.status, source: 'codex-rollout', keys: ['rate_limits'], windows };
  }
  return { status: last.status, source: 'unknown', keys: last.keys };
}

/** Registry-loaded usage adapter entry point used by later provider bindings. */
export default { probe: probeCodexUsage };
