import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';
import { isLifecycleState, type LifecyclePhaseResult } from './lifecycle-phase';

export default check('auto:parked');

/** Reports whether automatic Anthropic switching is waiting for its next usable window. */
export function autoParkedCheck(
  dbPath: string,
  lifecycle: LifecyclePhaseResult,
  now = Date.now(),
): HealthCheck {
  if (!lifecycle.available) {
    return { name: 'auto:parked', level: 'WARN', message: 'lifecycle phase unavailable; automatic Anthropic parking cannot be evaluated' };
  }
  if (!isLifecycleState(lifecycle.phase)) {
    return { name: 'auto:parked', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
  }
  if (lifecycle.phase !== 'cutover' && lifecycle.phase !== 'retired') {
    return { name: 'auto:parked', level: 'N/A', message: `not applicable in phase=${lifecycle.phase}` };
  }

  return guardCheck('auto:parked', () => {
    const db = openStoreConnection(dbPath, true);
    try {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get('auto.anthropic.parkedUntil') as
        | { value: string }
        | undefined;
      const value = row?.value ?? '';
      if (value !== '' && !Number.isFinite(Number(value))) {
        return { name: 'auto:parked', level: 'WARN', message: 'parked marker unreadable' };
      }
      const until = Number(value);
      return Number.isFinite(until) && until > now
        ? {
          name: 'auto:parked',
          level: 'WARN',
          message: `automatic anthropic switching is parked until ${new Date(until).toISOString()}`,
          detail: { parkedUntil: until },
        }
        : { name: 'auto:parked', level: 'PASS', message: 'automatic anthropic switching is not parked' };
    } finally {
      db.close();
    }
  });
}
