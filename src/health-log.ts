import { redactJson, redactSecrets } from './redact';
import { openStoreConnection } from './store';

export interface HealthLogInput {
  ts?: number;
  phase: string;
  overall: string;
  failing: unknown;
  deadSlots: unknown;
  releaseSha?: string | null;
}

export interface HealthLogRow {
  id: number;
  ts: number;
  phase: string;
  overall: string;
  failingJson: string;
  deadSlotsJson: string;
  releaseSha: string | null;
}

/**
 * S26's append-only doctor history hook. H3 owns the doctor-command call site;
 * this module deliberately exposes no update or delete path.
 */
export function appendHealthLog(dbPath: string, input: HealthLogInput): number {
  const db = openStoreConnection(dbPath);
  try {
    const result = db.prepare(`
      INSERT INTO health_log (ts, phase, overall, failing_json, dead_slots_json, release_sha)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.ts ?? Date.now(),
      redactSecrets(input.phase, []),
      redactSecrets(input.overall, []),
      redactJson(input.failing, []),
      redactJson(input.deadSlots, []),
      input.releaseSha == null ? null : redactSecrets(input.releaseSha, []),
    );
    return Number(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

export function listHealthLog(dbPath: string): HealthLogRow[] {
  const db = openStoreConnection(dbPath, true);
  try {
    return db.prepare(`
      SELECT id, ts, phase, overall, failing_json AS failingJson,
             dead_slots_json AS deadSlotsJson, release_sha AS releaseSha
      FROM health_log ORDER BY ts ASC, id ASC
    `).all() as unknown as HealthLogRow[];
  } finally {
    db.close();
  }
}
