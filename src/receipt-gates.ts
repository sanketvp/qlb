import { DatabaseSync } from 'node:sqlite';

import { safeNonNegativeInt } from './codex-l13-receipt';

const DAY_MS = 24 * 60 * 60 * 1000;

export function receiptHealthHistory(db: DatabaseSync, now: number): { hasPass: boolean; passes: boolean } {
  const since = now - DAY_MS;
  const lastPass = db.prepare("SELECT ts, id FROM health_log WHERE overall = 'PASS' AND ts >= ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1")
    .get(since, now) as { ts: number; id: number } | undefined;
  if (lastPass == null) return { hasPass: false, passes: true };
  const laterFailure = db.prepare("SELECT 1 FROM health_log WHERE overall = 'FAIL' AND ts >= ? AND ts <= ? AND (ts > ? OR (ts = ? AND id > ?)) LIMIT 1")
    .get(since, now, lastPass.ts, lastPass.ts, lastPass.id);
  return { hasPass: true, passes: laterFailure == null };
}

export function hasRecentPiService(value: string | null, now: number): boolean {
  const servedAt = safeNonNegativeInt(value);
  return servedAt != null && servedAt <= now && now - servedAt <= DAY_MS;
}
