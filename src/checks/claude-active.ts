import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('claude:active');

const ACTIVE_APPLICABLE_PHASES = new Set(['cutting-over', 'cutover', 'retired']);
const RELOGIN_STATUSES = new Set(['token-expired', 'relogin-needed']);

export function claudeActiveCheck(dbPath: string, phase: string): HealthCheck {
  if (!ACTIVE_APPLICABLE_PHASES.has(phase)) {
    return { name: 'claude:active', level: 'N/A', message: `not applicable in phase=${phase}` };
  }

  return guardCheck('claude:active', () => {
    const db = openStoreConnection(dbPath, true);
    try {
      const hasSlot = db.prepare('SELECT 1 FROM claude_slots LIMIT 1').get() !== undefined;
      if (!hasSlot) return { name: 'claude:active', level: 'N/A', message: 'no Claude slots exist' };

      const active = db.prepare(`
        SELECT active.account_id AS accountId, active.since AS since,
          slot.email AS email, slot.dead AS dead, slot.archived_at AS archivedAt,
          poll.last_status AS lastStatus
        FROM active_login AS active
        LEFT JOIN claude_slots AS slot ON slot.account_id = active.account_id
        LEFT JOIN usage_polls AS poll ON poll.provider = 'anthropic' AND poll.account_id = active.account_id
        WHERE active.provider = 'anthropic'
      `).get() as {
        accountId: string | null;
        since: number;
        email: string | null;
        dead: number | null;
        archivedAt: number | null;
        lastStatus: string | null;
      } | undefined;
      if (!active || active.accountId == null) {
        return { name: 'claude:active', level: 'FAIL', message: 'active Claude login is unset' };
      }
      if (active.dead === null) {
        return { name: 'claude:active', level: 'FAIL', message: 'active Claude login names a missing slot' };
      }
      if (active.dead !== 0 || active.archivedAt !== null) {
        return { name: 'claude:active', level: 'FAIL', message: 'active Claude login names a dead or archived slot' };
      }
      if (RELOGIN_STATUSES.has(active.lastStatus ?? '')) {
        return { name: 'claude:active', level: 'WARN', message: `active Claude login requires re-login: ${active.lastStatus}` };
      }
      const since = new Date(active.since).toISOString();
      return { name: 'claude:active', level: 'PASS', message: `active: ${active.email ?? active.accountId} since ${since}` };
    } finally {
      db.close();
    }
  });
}
