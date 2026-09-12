import type { DecisionRow, Store } from './store';

export const DEFAULT_AUDIT_LIMIT = 20;

export interface AuditDecision {
  timestamp: number;
  provider: string | null;
  account: string | null;
  strategy: string | null;
}

/**
 * `strategy` is not a decisions-table column and is not written into
 * snapshot_json by resolve today. Read it from snapshot_json when present
 * (string), otherwise fall back to the row's `mode`, else null. `provider`
 * likewise lives only in snapshot_json. Malformed JSON never throws —
 * both fields degrade to null (strategy still falls back to mode).
 */
export function toAuditDecision(row: DecisionRow): AuditDecision {
  const snap = parseSnapshot(row.snapshot_json);
  const provider = stringField(snap, 'provider');
  const strategy = stringField(snap, 'strategy') ?? nonempty(row.mode);
  return {
    timestamp: row.ts,
    provider,
    account: row.account_id,
    strategy,
  };
}

export function listAuditDecisions(
  store: Store,
  limit: number = DEFAULT_AUDIT_LIMIT,
): AuditDecision[] {
  const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : DEFAULT_AUDIT_LIMIT;
  return store.listRecentDecisions(n).map(toAuditDecision);
}

export function formatAudit(decisions: AuditDecision[], json: boolean): string {
  if (json) return JSON.stringify(decisions, null, 2);
  if (decisions.length === 0) return 'no decisions';
  return decisions
    .map((d) => {
      const ts = new Date(d.timestamp).toISOString();
      return `${ts}  provider=${d.provider ?? '-'}  account=${d.account ?? '-'}  strategy=${d.strategy ?? '-'}`;
    })
    .join('\n');
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

function nonempty(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.length > 0 ? value : null;
}
