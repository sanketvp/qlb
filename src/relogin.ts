import { DatabaseSync } from 'node:sqlite';

import { redactSecrets } from './redact';

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

/** Records only the durable, redacted relogin event taxonomy from S26. */
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
  return store.recordRelogin({
    ts: event.ts,
    provider: event.provider,
    accountId: event.accountId,
    kind: event.kind,
    detail: event.detail == null ? null : redactSecrets(event.detail, []),
    evidence: event.evidence == null ? null : redactSecrets(event.evidence, []),
    userDeniedAt: event.userDeniedAt,
  });
}

/** Read-only window report used by doctor/status/report cutover. */
export function reloginsInWindow(dbPath: string, window: ReloginWindow): ReloginEvent[] {
  if (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.end < window.start) {
    throw new Error('invalid relogin window');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
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
