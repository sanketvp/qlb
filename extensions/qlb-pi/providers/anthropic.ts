// QLB-backed Anthropic access source (§4.7.2).
//
// The caller supplies the gate runner: this module never shells out, logs a
// credential, or falls back to Pi's persisted OAuth entry.

import type { ActiveAccess, ActiveAccessSource } from '../active-access.js';

export interface GateResult {
  code: number;
  stdout: string;
}

/** Injectable process boundary for `qlb gate anthropic --json`. */
export type GateRunner = (provider: 'anthropic') => Promise<GateResult>;

export interface AnthropicSourceDeps {
  runGate: GateRunner;
}

type GatePayload = {
  token?: unknown;
  accountId?: unknown;
  expiresAt?: unknown;
  source?: unknown;
};

function unavailable(): Error {
  // Do not expose gate stdout/stderr: either may contain credential material.
  return new Error('QLB gate anthropic unavailable');
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
    || typeof payload.source !== 'string' || !payload.source
    || (payload.expiresAt !== undefined && (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)))
  ) {
    throw unavailable();
  }

  return {
    token: payload.token,
    accountId: payload.accountId,
    ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
    source: payload.source,
  };
}

/** A per-request gate source; callers register it with the P1 access registry. */
export function createAnthropicSource(deps: AnthropicSourceDeps): ActiveAccessSource {
  return {
    provider: 'anthropic',
    async read(): Promise<ActiveAccess> {
      let result: GateResult;
      try {
        result = await deps.runGate('anthropic');
      } catch {
        throw unavailable();
      }
      if (result.code !== 0) throw unavailable();
      return parseGatePayload(result.stdout);
    },
  };
}
