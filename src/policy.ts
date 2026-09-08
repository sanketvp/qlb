import type { PolicyRow, Store } from './store';

export type PolicyHarness = 'claude-code' | 'codex';
export type PolicyEffort = 'low' | 'medium' | 'high' | 'max';
export type SessionMode = 'header' | 'anon';

export interface Policy {
  harness: string;
  virtualModel: string;
  realModel: string;
  effort: string;
  fallback: string[];
  sessionMode: string;
  createdAt: number;
}

export interface PolicyInput {
  harness: string;
  virtualModel: string;
  realModel: string;
  effort: string;
  fallback?: string[];
  sessionMode?: string;
}

function parseFallback(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

export function rowToPolicy(row: PolicyRow): Policy {
  return {
    harness: row.harness,
    virtualModel: row.virtual_model,
    realModel: row.real_model,
    effort: row.effort,
    fallback: parseFallback(row.fallback_json),
    sessionMode: row.session_mode,
    createdAt: row.created_at,
  };
}

export function setPolicy(store: Store, input: PolicyInput): Policy {
  store.upsertPolicy({
    harness: input.harness,
    virtualModel: input.virtualModel,
    realModel: input.realModel,
    effort: input.effort,
    fallback: input.fallback ?? [],
    sessionMode: input.sessionMode ?? 'header',
  });
  const row = store.getPolicy(input.harness, input.virtualModel);
  if (!row) {
    throw new Error('policy write did not persist');
  }
  return rowToPolicy(row);
}

export function listPolicies(store: Store, harness?: string): Policy[] {
  return store.listPolicies(harness).map(rowToPolicy);
}

export function resolvePolicy(
  store: Store,
  harness: string,
  virtualModel: string,
): Policy | null {
  const row = store.getPolicy(harness, virtualModel);
  return row ? rowToPolicy(row) : null;
}

export function unmappedMessage(harness: string, virtualModel: string): string {
  return (
    `QLB: no policy for model '${virtualModel}' (harness ${harness}). ` +
    `Run: qlb policy set --harness ${harness} --virtual-model '${virtualModel}' ` +
    `--real-model <model> --effort <lvl>`
  );
}

/** Harness-native 400 body. Anthropic vs Codex shapes per Phase 3 task / §4.9.2b. */
export function unmappedErrorBody(harness: string, virtualModel: string): unknown {
  const message = unmappedMessage(harness, virtualModel);
  if (harness === 'codex') {
    return { detail: message };
  }
  return {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message,
    },
  };
}

export function harnessForPath(pathname: string): PolicyHarness | null {
  if (pathname === '/v1/messages' || pathname.startsWith('/v1/messages/')) {
    return 'claude-code';
  }
  if (pathname === '/v1/responses' || pathname === '/backend-api/codex/responses') {
    return 'codex';
  }
  return null;
}

const EFFORT_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  max: 3,
};

export function effortRank(effort: string): number {
  return EFFORT_RANK[effort] ?? -1;
}

/**
 * Codex only: inject policy effort if the body lacks it; raise if the body
 * carries a lower effort. Never lower the body's effort (Q9).
 * Returns whether X-QLB-Effort-Raised should be set.
 */
export function applyCodexEffort(
  body: Record<string, unknown>,
  policyEffort: string,
): boolean {
  const reasoning =
    body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)
      ? { ...(body.reasoning as Record<string, unknown>) }
      : {};
  const current = typeof reasoning.effort === 'string' ? reasoning.effort : undefined;
  if (!current) {
    reasoning.effort = policyEffort;
    body.reasoning = reasoning;
    return false;
  }
  if (effortRank(policyEffort) > effortRank(current)) {
    reasoning.effort = policyEffort;
    body.reasoning = reasoning;
    return true;
  }
  return false;
}
