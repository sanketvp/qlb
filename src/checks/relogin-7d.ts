import { check, guardCheck } from './_check';
import { countsAsRelogin, reloginsInWindow } from '../relogin';
import type { HealthCheck } from './claude-slots';
import { isLifecycleState, LIFECYCLE_STATES } from './lifecycle-phase';

export default check('relogin:7d');

const APPLICABLE_PHASES = new Set<string>(LIFECYCLE_STATES.filter((phase) => (
  phase === 'cutting-over' || phase === 'cutover' || phase === 'retired'
)));
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** S26/AC17: any relogin that counts under S65 in the current seven-day window is unhealthy. */
export function relogin7dCheck(
  dbPath: string,
  phase: string,
  now: number = Date.now(),
  windowMs: number = SEVEN_DAYS_MS,
): HealthCheck {
  if (!Number.isFinite(now) || !Number.isFinite(windowMs) || windowMs <= 0) {
    return { name: 'relogin:7d', level: 'FAIL', message: 'check failed: invalid relogin window' };
  }
  return guardCheck('relogin:7d', () => {
    if (phase === 'unknown') {
      return { name: 'relogin:7d', level: 'WARN', message: 'lifecycle phase unavailable; relogin window cannot be evaluated' };
    }
    if (!isLifecycleState(phase)) {
      return { name: 'relogin:7d', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
    }
    if (!APPLICABLE_PHASES.has(phase)) {
      return { name: 'relogin:7d', level: 'N/A', message: `not applicable in phase=${phase}` };
    }
    const events = reloginsInWindow(dbPath, { start: now - windowMs, end: now });
    const counted = events.filter(countsAsRelogin);
    const excused = events.filter((event) => !countsAsRelogin(event));
    return counted.length === 0
      ? { name: 'relogin:7d', level: 'PASS', message: `no counted relogin events in the last 7 days${excused.length === 0 ? '' : `; excused by user denial: ${excused.map((event) => `#${event.id}@${event.ts}`).join(', ')}`}` }
      : {
        name: 'relogin:7d',
        level: 'FAIL',
        message: `${counted.length} relogin event(s) in the last 7 days`,
        detail: counted.map(({ id, ts, provider, accountId, kind }) => ({ id, ts, provider, accountId, kind })),
      };
  });
}
