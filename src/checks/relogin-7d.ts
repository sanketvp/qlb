import { check, guardCheck } from './_check';
import { reloginsInWindow } from '../relogin';
import type { HealthCheck } from './claude-slots';

export default check('relogin:7d');

const APPLICABLE_PHASES = new Set(['cutting-over', 'cutover', 'retired']);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** S26/AC17: any non-denied relogin in the current seven-day window is unhealthy. */
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
    if (!APPLICABLE_PHASES.has(phase)) {
      return { name: 'relogin:7d', level: 'N/A', message: `not applicable in phase=${phase}` };
    }
    const events = reloginsInWindow(dbPath, { start: now - windowMs, end: now })
      .filter((event) => event.userDeniedAt == null);
    return events.length === 0
      ? { name: 'relogin:7d', level: 'PASS', message: 'no relogin events in the last 7 days' }
      : {
        name: 'relogin:7d',
        level: 'FAIL',
        message: `${events.length} relogin event(s) in the last 7 days`,
        detail: events.map(({ id, ts, provider, accountId, kind }) => ({ id, ts, provider, accountId, kind })),
      };
  });
}
