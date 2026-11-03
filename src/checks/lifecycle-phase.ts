import { lifecyclePhase, type LifecyclePhaseResult } from '../lifecycle-read';
export { lifecyclePhase, type LifecyclePhaseResult } from '../lifecycle-read';
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

function printableUnknownLifecycleState(phase: string): string {
  return /^[a-z0-9-]{1,32}$/.test(phase) ? phase : '<unprintable>';
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
