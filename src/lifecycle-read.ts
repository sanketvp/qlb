import { DatabaseSync } from 'node:sqlite';

import { redactError } from './redact';

export type LifecyclePhaseResult =
  | { available: true; phase: string }
  | { available: false; phase: 'unknown'; reason: string };

/** Reads lifecycle state without opening a migration-capable store. */
export function lifecyclePhase(dbPath: string): LifecyclePhaseResult {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Match the store's read-only connection lock contract.
    db.exec('PRAGMA busy_timeout = 5000');
    const row = db.prepare(`
      SELECT state FROM lifecycle WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1
    `).get() as { state: unknown } | undefined;
    return { available: true, phase: row == null ? 'pre-cutover' : typeof row.state === 'string' ? row.state : '<unprintable>' };
  } catch (error) {
    return {
      available: false,
      phase: 'unknown',
      reason: redactError(error, []),
    };
  } finally {
    try { db?.close(); } catch { /* unavailable connection has no close path */ }
  }
}
