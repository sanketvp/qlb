import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';

export default check('claude:slots');

export type HealthCheckLevel = 'PASS' | 'WARN' | 'FAIL' | 'INFO' | 'N/A';
export interface HealthCheck {
  name: string;
  level: HealthCheckLevel;
  message: string;
  detail?: unknown;
}

const SLOT_APPLICABLE_PHASES = new Set(['cutting-over', 'cutover', 'retired']);

export function claudeSlotsCheck(dbPath: string, phase: string): HealthCheck {
  return guardCheck('claude:slots', () => {
    if (phase === 'unknown') {
      return { name: 'claude:slots', level: 'WARN', message: 'lifecycle phase unavailable; Claude slots cannot be evaluated' };
    }
    if (!SLOT_APPLICABLE_PHASES.has(phase)) {
      return { name: 'claude:slots', level: 'N/A', message: `not applicable in phase=${phase}` };
    }
    const db = openStoreConnection(dbPath, true);
    try {
      const dead = (db.prepare(`
        SELECT account_id AS accountId, dead_reason AS reason
        FROM claude_slots WHERE dead = 1 AND archived_at IS NULL ORDER BY account_id
      `).all() as Array<{ accountId: string; reason: string | null }>)
        .map(({ accountId, reason }) => ({ accountId, reason }));
      return dead.length === 0
        ? { name: 'claude:slots', level: 'PASS', message: 'no dead Claude slots' }
        : { name: 'claude:slots', level: 'FAIL', message: `${dead.length} dead Claude slot(s) require re-login`, detail: dead };
    } finally {
      db.close();
    }
  });
}
