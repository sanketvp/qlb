import { readFile } from 'node:fs/promises';
import { config } from '../config';
import { codexIdentity, type CodexAuthDocument } from '../codex-auth';
import type { Adapter } from '../types';

// Codex exposes quota only in response headers from real, quota-consuming requests.
// Phase 0 therefore reports an authenticated account with no buckets and never probes;
// Phase 1+ can populate buckets from response headers observed by qlb-pi/qlb-proxy traffic.
const AUTH_PATH = config.codexAuthJsonPath;
const INVALID_CREDENTIALS_ERROR = `no valid Codex credentials found in ${AUTH_PATH}`;

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

export interface CodexAdapterDeps {
  authPath?: string;
  readAuth?: (path: string) => Promise<string>;
}

export function createCodexAdapter(deps: CodexAdapterDeps = {}): Adapter {
  const authPath = deps.authPath ?? AUTH_PATH;
  const readAuth = deps.readAuth ?? ((path: string) => readFile(path, 'utf8'));

  return {
    id: 'openai-codex',
    displayName: 'Codex (ChatGPT Pro)',
    probes: false,
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
        return [{
          accountId,
          provider: 'openai-codex',
          label,
          buckets: {},
        }];
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
