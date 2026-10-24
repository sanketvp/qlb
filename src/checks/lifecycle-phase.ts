import { DatabaseSync } from 'node:sqlite';

import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('lifecycle:phase');

export function lifecyclePhase(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT state FROM lifecycle WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1
    `).get() as { state: string } | undefined;
    return row?.state ?? 'pre-cutover';
  } finally {
    db.close();
  }
}

/** `--phase` is an assertion, never a phase override (S26/S43). */
export function lifecyclePhaseCheck(dbPath: string, expected?: string): HealthCheck {
  return guardCheck('lifecycle:phase', () => {
    const phase = lifecyclePhase(dbPath);
    if (expected != null && expected !== phase) {
      return {
        name: 'lifecycle:phase',
        level: 'FAIL',
        message: `phase assertion failed: expected ${expected}, actual ${phase}`,
        detail: { expected, actual: phase },
      };
    }
    return { name: 'lifecycle:phase', level: 'PASS', message: `phase=${phase}`, detail: { phase } };
  });
}
