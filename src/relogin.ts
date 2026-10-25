import { assertStoredReloginFields, reloginDetailValue } from './relogin-fields';
import { openStoreConnection } from './store';

export const RELOGIN_KINDS = ['dead', 'healed', 'wiped', 'identity-replaced', 'external-login'] as const;
export type ReloginKind = (typeof RELOGIN_KINDS)[number];

export interface ReloginStore {
  recordRelogin(row: {
    ts?: number;
    provider: string;
    accountId?: string | null;
    kind: string;
    detail?: string | null;
    evidence?: string | null;
    userDeniedAt?: number | null;
  }): number;
}

export interface ReloginEvent {
  id: number;
  ts: number;
  provider: string;
  accountId: string | null;
  kind: string;
  detail: string | null;
  evidence: string | null;
  userDeniedAt: number | null;
}

export interface ReloginWindow {
  start: number;
  end: number;
}

/** Records only durable detail codes/fingerprints and S65 evidence classes. */
export function recordRelogin(
  store: ReloginStore,
  event: Omit<ReloginEvent, 'id' | 'detail' | 'evidence' | 'userDeniedAt'> & {
    detail?: string | null;
    evidence?: string | null;
    userDeniedAt?: number | null;
  },
): number {
  if (!(RELOGIN_KINDS as readonly string[]).includes(event.kind)) {
    throw new Error(`unsupported relogin event kind: ${event.kind}`);
  }
  const detail = reloginDetailValue(event.detail);
  const evidence = event.evidence ?? null;
  assertStoredReloginFields(detail, evidence);
  return store.recordRelogin({
    ts: event.ts,
    provider: event.provider,
    accountId: event.accountId,
    kind: event.kind,
    detail,
    evidence,
    userDeniedAt: event.userDeniedAt,
  });
}

/** Read-only window report used by doctor/status/report cutover. */
export function reloginsInWindow(dbPath: string, window: ReloginWindow): ReloginEvent[] {
  if (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.end < window.start) {
    throw new Error('invalid relogin window');
  }
  const db = openStoreConnection(dbPath, true);
  try {
    return db.prepare(`
      SELECT id, ts, provider, account_id AS accountId, kind, detail, evidence, user_denied_at AS userDeniedAt
      FROM relogin_events WHERE ts >= ? AND ts <= ? ORDER BY ts ASC, id ASC
    `).all(window.start, window.end) as unknown as ReloginEvent[];
  } finally {
    db.close();
  }
}

export function listReloginEvents(dbPath: string): ReloginEvent[] {
  return reloginsInWindow(dbPath, { start: 0, end: Number.MAX_SAFE_INTEGER });
}
