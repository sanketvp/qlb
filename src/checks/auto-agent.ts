import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';
import { isLifecycleState, type LifecyclePhaseResult } from './lifecycle-phase';

export default check('auto:agent');

export const AUTO_HEARTBEAT_MAX_AGE_MS = 5 * 60 * 1_000;

/** H2 only applies once QLB owns cutover; all other phases leave the agent alone. */
export function autoAgentCheck(
  dbPath: string,
  lifecycle: LifecyclePhaseResult,
  now = Date.now(),
): HealthCheck {
  if (!lifecycle.available) {
    return { name: 'auto:agent', level: 'WARN', message: 'lifecycle phase unavailable; automatic agent cannot be evaluated' };
  }
  if (!isLifecycleState(lifecycle.phase)) {
    return { name: 'auto:agent', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
  }
  if (lifecycle.phase !== 'cutover') {
    return { name: 'auto:agent', level: 'N/A', message: `not applicable in phase=${lifecycle.phase}` };
  }

  return guardCheck('auto:agent', () => {
    const db = openStoreConnection(dbPath, true);
    try {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get('auto.heartbeatAt') as { value?: unknown } | undefined;
      const heartbeatAt = typeof row?.value === 'string' && /^\d+$/.test(row.value) ? Number(row.value) : NaN;
      if (!Number.isSafeInteger(heartbeatAt) || heartbeatAt < 0) {
        return { name: 'auto:agent', level: 'FAIL', message: 'automatic agent heartbeat is missing or invalid' };
      }
      if (now - heartbeatAt > AUTO_HEARTBEAT_MAX_AGE_MS) {
        return {
          name: 'auto:agent',
          level: 'FAIL',
          message: 'automatic agent heartbeat is older than 5 minutes',
          detail: { heartbeatAt },
        };
      }
      return { name: 'auto:agent', level: 'PASS', message: 'automatic agent heartbeat is current', detail: { heartbeatAt } };
    } finally {
      db.close();
    }
  });
}
