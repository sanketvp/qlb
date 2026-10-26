// QLB-backed OpenAI Codex access source (§4.7.2).
//
// The caller supplies the gate runner: this module never shells out, logs a
// credential, or falls back to Pi's persisted OAuth entry.

import type { ActiveAccess, ActiveAccessSource } from '../active-access.js';

export interface GateResult {
  code: number;
  stdout: string;
}

/** Injectable process boundary for `qlb gate openai-codex --json`. */
export type GateRunner = (provider: 'openai-codex') => Promise<GateResult>;

export interface OpenAICodexSourceDeps {
  runGate: GateRunner;
}

type GatePayload = {
  token?: unknown;
  accountId?: unknown;
  chatgptAccountId?: unknown;
  expiresAt?: unknown;
  source?: unknown;
};

function unavailable(): Error {
  // Do not expose gate stdout/stderr: either may contain credential material.
  return new Error('QLB gate openai-codex unavailable');
}

function parseGatePayload(stdout: string): ActiveAccess {
  let payload: GatePayload;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unavailable();
    payload = parsed as GatePayload;
  } catch {
    throw unavailable();
  }

  if (
    typeof payload.token !== 'string' || !payload.token
    || typeof payload.accountId !== 'string' || !payload.accountId
    || typeof payload.chatgptAccountId !== 'string' || !payload.chatgptAccountId
    || typeof payload.source !== 'string' || !payload.source
    || (payload.expiresAt !== undefined && (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)))
  ) {
    throw unavailable();
  }

  return {
    token: payload.token,
    accountId: payload.accountId,
    chatgptAccountId: payload.chatgptAccountId,
    ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
    source: payload.source,
  };
}

/** A per-request gate source; callers register it with the P1 access registry. */
export function createOpenAICodexSource(deps: OpenAICodexSourceDeps): ActiveAccessSource {
  return {
    provider: 'openai-codex',
    async read(): Promise<ActiveAccess> {
      let result: GateResult;
      try {
        result = await deps.runGate('openai-codex');
      } catch {
        throw unavailable();
      }
      if (result.code !== 0) throw unavailable();
      return parseGatePayload(result.stdout);
    },
  };
}

/** Headers for Pi's OpenAI Codex transport. The account header is never the QLB composite slot id. */
export function openAICodexHeaders(access: ActiveAccess): Record<'Authorization' | 'ChatGPT-Account-Id', string> {
  if (!access.chatgptAccountId) throw unavailable();
  return {
    Authorization: `Bearer ${access.token}`,
    'ChatGPT-Account-Id': access.chatgptAccountId,
  };
}
