import { providerForModel } from './scoring';
import type { DecisionRow } from './store';

export const DEFAULT_AUDIT_LIMIT = 20;

export type FieldSource = 'recorded' | 'derived' | 'accounts' | 'snapshot' | 'model' | 'none';

export interface AuditDecision {
  timestamp: number;
  provider: string | null;
  account: string | null;
  strategy: string | null;
  reason: string;
  strategySource: FieldSource;
  providerSource: FieldSource;
}

export interface AuditLookup {
  accountProvider?: string | null;
}

function nonempty(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.length > 0 ? value : null;
}

function parseSnapshot(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function stringField(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const value = obj[key];
  return typeof value === 'string' ? nonempty(value) : null;
}

function deriveStrategy(mode: string): { strategy: string | null; source: FieldSource } {
  if (mode === 'pin' || mode === 'spread' || mode === 'round-robin' || mode === 'failover') {
    return { strategy: mode, source: 'derived' };
  }
  if (mode === 'headroom' || mode === 'all-in') {
    return { strategy: 'headroom', source: 'derived' };
  }
  return { strategy: null, source: 'none' };
}

/**
 * Prefer the recorded strategy/provider columns. Legacy v4 rows derive
 * strategy only when unambiguous, and provider from accounts → snapshot → model.
 */
export function toAuditDecision(row: DecisionRow, lookup: AuditLookup = {}): AuditDecision {
  const snap = parseSnapshot(row.snapshot_json);
  let strategy = nonempty(row.strategy);
  let strategySource: FieldSource = strategy ? 'recorded' : 'none';
  if (!strategy) {
    const derived = deriveStrategy(row.mode);
    strategy = derived.strategy;
    strategySource = derived.source;
  }

  let provider = nonempty(row.provider);
  let providerSource: FieldSource = provider ? 'recorded' : 'none';
  if (!provider && lookup.accountProvider) {
    provider = nonempty(lookup.accountProvider);
    if (provider) providerSource = 'accounts';
  }
  if (!provider) {
    const fromSnap = stringField(snap, 'provider');
    if (fromSnap) {
      provider = fromSnap;
      providerSource = 'snapshot';
    }
  }
  if (!provider && row.requested_model) {
    const fromModel = providerForModel(row.requested_model);
    if (fromModel) {
      provider = fromModel;
      providerSource = 'model';
    }
  }

  return {
    timestamp: row.ts,
    provider,
    account: row.account_id,
    strategy,
    reason: row.reason,
    strategySource,
    providerSource,
  };
}

export function formatAudit(decisions: AuditDecision[], json: boolean): string {
  if (json) return JSON.stringify(decisions, null, 2);
  if (decisions.length === 0) return 'no decisions';
  return decisions
    .map((d) => {
      const ts = new Date(d.timestamp).toISOString();
      return `${ts}  provider=${d.provider ?? '-'}  account=${d.account ?? '-'}  strategy=${d.strategy ?? '?'}`;
    })
    .join('\n');
}
