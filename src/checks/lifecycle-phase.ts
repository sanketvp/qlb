import { redactError } from '../redact';
import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('lifecycle:phase');

export type LifecyclePhaseResult =
  | { available: true; phase: string }
  | { available: false; phase: 'unknown'; reason: string };

/** Never lets an unavailable/pre-v5 store become a doctor exception path. */
export function lifecyclePhase(dbPath: string): LifecyclePhaseResult {
  let db: ReturnType<typeof openStoreConnection> | undefined;
  try {
    db = openStoreConnection(dbPath, true);
    const row = db.prepare(`
      SELECT state FROM lifecycle WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1
    `).get() as { state: string } | undefined;
    return { available: true, phase: row?.state ?? 'pre-cutover' };
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

/** `--phase` is an assertion, never a phase override (S26/S43). */
export function lifecyclePhaseCheck(result: LifecyclePhaseResult, expected?: string): HealthCheck {
  return guardCheck('lifecycle:phase', () => {
    if (!result.available) {
      return {
        name: 'lifecycle:phase',
        level: 'WARN',
        message: `lifecycle phase unavailable: ${result.reason}`,
        detail: result,
      };
    }
    if (expected != null && expected !== result.phase) {
      return {
        name: 'lifecycle:phase',
        level: 'FAIL',
        message: `phase assertion failed: expected ${expected}, actual ${result.phase}`,
        detail: { expected, actual: result.phase },
      };
    }
    return { name: 'lifecycle:phase', level: 'PASS', message: `phase=${result.phase}`, detail: result };
  });
}
