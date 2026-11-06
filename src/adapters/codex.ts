import { readFile } from 'node:fs/promises';
import { config } from '../config';
import { codexIdentity, type CodexAuthDocument } from '../codex-auth';
import type { Store } from '../store';
import type { CodexUsageProbeDeps, CodexUsageProbeResult } from '../usage/openai-codex';
import type { Adapter, BucketReading } from '../types';

const PROVIDER = 'openai-codex';
const AUTH_PATH = config.codexAuthJsonPath;
const INVALID_CREDENTIALS_ERROR = `no valid Codex credentials found in ${AUTH_PATH}`;
const STORE_ERROR = 'Codex usage store unavailable';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJwtPayload(token: string): JsonObject | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return undefined;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return isObject(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function stringClaim(payload: JsonObject | undefined, name: string): string | undefined {
  if (!payload) return undefined;

  const direct = payload[name];
  if (typeof direct === 'string' && direct.length > 0) return direct;

  for (const value of Object.values(payload)) {
    if (!isObject(value)) continue;
    const nested = value[name];
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }

  return undefined;
}

type CodexStore = Pick<Store, 'upsertAccount' | 'recordUsagePollResult' | 'listUsagePolls'>;
type ProbeUsage = (deps: CodexUsageProbeDeps) => Promise<CodexUsageProbeResult>;

export interface CodexAdapterDeps {
  authPath?: string;
  readAuth?: (path: string) => Promise<string>;
  /** Supplying this opt-in seam enables the authenticated provider usage probe. */
  probeUsage?: ProbeUsage;
  store?: CodexStore;
  getStore?: () => CodexStore;
  now?: () => number;
}

function readingsFrom(result: CodexUsageProbeResult, fetchedAt: number): Record<string, BucketReading> {
  if (result.source !== 'wham' && result.source !== 'codex-api') return {};
  return Object.fromEntries((result.windows ?? []).map((window) => [window.bucket, {
    usedPct: window.usedPct,
    ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
    ...(window.windowMin === undefined ? {} : { windowMin: window.windowMin }),
    fetchedAt,
    source: 'poll' as const,
    confidence: 'authoritative' as const,
  }]));
}

export function createCodexAdapter(deps: CodexAdapterDeps = {}): Adapter {
  const authPath = deps.authPath ?? AUTH_PATH;
  const readAuth = deps.readAuth ?? ((path: string) => readFile(path, 'utf8'));
  const now = deps.now ?? (() => Date.now());

  return {
    id: PROVIDER,
    displayName: 'Codex (ChatGPT Pro)',
    probes: deps.probeUsage !== undefined,
    persistsSnapshots: deps.probeUsage !== undefined,
    fetchSnapshots: async () => {
      try {
        const auth = JSON.parse(await readAuth(authPath)) as unknown;
        if (!isObject(auth) || !isObject(auth.tokens)) {
          return [{
            accountId: 'codex-default',
            provider: 'openai-codex',
            label: 'codex-default',
            buckets: {},
            error: INVALID_CREDENTIALS_ERROR,
          }];
        }

        const accessToken = auth.tokens.access_token;
        if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
          return [{
            accountId: 'codex-default',
            provider: 'openai-codex',
            label: 'codex-default',
            buckets: {},
            error: INVALID_CREDENTIALS_ERROR,
          }];
        }

        const idToken = auth.tokens.id_token;
        const payload = typeof idToken === 'string' ? parseJwtPayload(idToken) : undefined;
        const accountId = codexIdentity(auth as CodexAuthDocument);
        if (!accountId) {
          return [{
            accountId: 'codex-default',
            provider: 'openai-codex',
            label: 'codex-default',
            buckets: {},
            error: 'Codex login has no S29 identity',
          }];
        }
        const label = stringClaim(payload, 'email') ?? accountId;
        if (!deps.probeUsage) {
          return [{ accountId, provider: PROVIDER, label, buckets: {} }];
        }

        let store: CodexStore | undefined;
        try {
          store = deps.store ?? deps.getStore?.();
          if (!store) throw new Error('store unavailable');
          store.upsertAccount(accountId, PROVIDER, label);
        } catch {
          return [{ accountId, provider: PROVIDER, label, buckets: {}, error: STORE_ERROR }];
        }

        const attemptedAt = Math.floor(now() / 1_000);
        let backingOff: boolean;
        try {
          backingOff = (store.listUsagePolls(PROVIDER)[accountId]?.backoffUntil ?? 0) > attemptedAt;
        } catch {
          return [{ accountId, provider: PROVIDER, label, buckets: {}, error: STORE_ERROR }];
        }
        if (backingOff) {
          return [{ accountId, provider: PROVIDER, label, buckets: {}, error: 'Codex usage probe is backing off' }];
        }
        let result: CodexUsageProbeResult;
        try {
          result = await deps.probeUsage({ auth: auth as CodexAuthDocument, authPath });
        } catch {
          try {
            store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt, status: 'usage-unknown' });
          } catch {
            return [{ accountId, provider: PROVIDER, label, buckets: {}, error: STORE_ERROR }];
          }
          return [{ accountId, provider: PROVIDER, label, buckets: {}, error: 'Codex usage probe failed' }];
        }
        const buckets = readingsFrom(result, now());
        try {
          if (result.status === 429) {
            store.recordUsagePollResult(PROVIDER, accountId, {
              attemptedAt, status: 'http-429', http429: true, retryAfterS: result.retryAfterS,
            });
          } else if (Object.keys(buckets).length === 0) {
            store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt, status: 'usage-unknown' });
          } else {
            store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt, status: 'ok', readings: buckets });
          }
        } catch {
          return [{ accountId, provider: PROVIDER, label, buckets: {}, error: STORE_ERROR }];
        }
        if (Object.keys(buckets).length === 0) {
          return [{ accountId, provider: PROVIDER, label, buckets: {}, error: 'Codex usage probe returned no live provider reading' }];
        }
        return [{ accountId, provider: PROVIDER, label, buckets }];
      } catch {
        return [{
          accountId: 'codex-default',
          provider: 'openai-codex',
          label: 'codex-default',
          buckets: {},
          error: INVALID_CREDENTIALS_ERROR,
        }];
      }
    },
  };
}

export const codexAdapter = createCodexAdapter();
