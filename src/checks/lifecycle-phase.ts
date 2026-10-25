import { redactError } from '../redact';
import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('lifecycle:phase');

/** Canonical lifecycle states from spec §3.2 / §4.7.2. */
export const LIFECYCLE_STATES = [
  'pre-cutover',
  'cutting-over',
  'cutover',
  'undoing',
  'rolled-back',
  'retired',
  'aborted',
  'closed',
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export function isLifecycleState(phase: string): phase is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(phase);
}

export type LifecyclePhaseResult =
  | { available: true; phase: string }
  | { available: false; phase: 'unknown'; reason: string };

function printableUnknownLifecycleState(phase: string): string {
  return /^[a-z0-9-]{1,32}$/.test(phase) ? phase : '<unprintable>';
}

/** Never lets an unavailable/pre-v5 store become a doctor exception path. */
export function lifecyclePhase(dbPath: string): LifecyclePhaseResult {
  let db: ReturnType<typeof openStoreConnection> | undefined;
  try {
    db = openStoreConnection(dbPath, true);
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
    if (!isLifecycleState(result.phase)) {
      return {
        name: 'lifecycle:phase',
        level: 'FAIL',
        message: `unknown lifecycle state: ${printableUnknownLifecycleState(result.phase)}`,
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
