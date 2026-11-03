import { DatabaseSync } from 'node:sqlite';

import { redactError } from './redact';

// Keep this read-only module outside the lifecycle writer closure. This value
// is the CSWAP_RESTORE_PENDING fence defined in lifecycle.ts.
const CSWAP_RESTORE_PENDING = 'cswap-restore-pending';

export type LifecyclePhaseResult =
  | { available: true; phase: string; restorePending?: boolean }
  | { available: false; phase: 'unknown'; reason: string };

/** Reads lifecycle state without opening a migration-capable store. */
export function lifecyclePhase(dbPath: string): LifecyclePhaseResult {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Match the store's read-only connection lock contract.
    db.exec('PRAGMA busy_timeout = 5000');
    const hasNote = (db.prepare('PRAGMA table_info(lifecycle)').all() as Array<{ name?: unknown }>)
      .some((column) => column.name === 'note');
    const row = db.prepare(`
      SELECT state${hasNote ? ', note' : ''} FROM lifecycle WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1
    `).get() as { state: unknown; note?: unknown } | undefined;
    return {
      available: true,
      phase: row == null ? 'pre-cutover' : typeof row.state === 'string' ? row.state : '<unprintable>',
      ...(row?.note === CSWAP_RESTORE_PENDING ? { restorePending: true } : {}),
    };
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
