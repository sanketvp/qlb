import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';
import { isLifecycleState } from './lifecycle-phase';

export default check('claude:unpersisted-token');

const APPLICABLE_PHASES = new Set(['cutover', 'retired']);
const SWITCH_REFUSAL_DETAIL = 'freshen-consume-gate-unpersisted';
const USAGE_STATUS = 'consume-consume-gate-unpersisted';
const AUTO_LOG_LINE = /^claude:unpersisted-token provider=anthropic account=([^\s]+) at=(\d+)$/;

interface Evidence {
  accountId: string;
  at: number;
}

/**
 * Read-only evidence for a Claude refresh successor which could not be persisted.
 * Only a later successful poll or a non-injected successful switch into the slot
 * clears the evidence; neither seeded drill rows nor noops are recoveries.
 */
export function claudeUnpersistedTokenCheck(
  dbPath: string,
  phase: string,
): HealthCheck {
  if (phase === 'unknown') {
    return { name: 'claude:unpersisted-token', level: 'WARN', message: 'lifecycle phase unavailable; unpersisted Claude token evidence cannot be evaluated' };
  }
  if (!isLifecycleState(phase)) {
    return { name: 'claude:unpersisted-token', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
  }
  if (!APPLICABLE_PHASES.has(phase)) {
    return { name: 'claude:unpersisted-token', level: 'N/A', message: `not applicable in phase=${phase}` };
  }

  return guardCheck('claude:unpersisted-token', () => {
    const db = openStoreConnection(dbPath, true);
    try {
      const switchEvidence = db.prepare(`SELECT to_account AS accountId, ts AS at
        FROM switch_log
        WHERE provider = 'anthropic' AND outcome = 'refused' AND detail = ?`).all(SWITCH_REFUSAL_DETAIL);
      const pollEvidence = db.prepare(`SELECT account_id AS accountId, COALESCE(last_attempt_at, 0) * 1000 AS at
        FROM usage_polls
        WHERE provider = 'anthropic' AND last_status = ?`).all(USAGE_STATUS);
      const evidence: Evidence[] = [...switchEvidence, ...pollEvidence].flatMap((row) => {
        const accountId = typeof row.accountId === 'string' ? row.accountId : null;
        const at = typeof row.at === 'number' ? row.at : null;
        return accountId !== null && at !== null ? [{ accountId, at }] : [];
      });

      const autoLogPath = join(dirname(dbPath), 'auto.log');
      let autoLogUnreadable = false;
      if (existsSync(autoLogPath)) {
        try {
          for (const line of readFileSync(autoLogPath, 'utf8').split(/\r?\n/)) {
            const match = AUTO_LOG_LINE.exec(line);
            if (match) evidence.push({ accountId: match[1]!, at: Number(match[2]) });
          }
        } catch {
          autoLogUnreadable = true;
        }
      }

      const unresolved = new Set<string>();
      const isLiveSlot = db.prepare(`SELECT 1 FROM claude_slots
        WHERE account_id = ? AND dead = 0 AND archived_at IS NULL`);
      const laterOkPoll = db.prepare(`SELECT 1 FROM usage_polls
        WHERE provider = 'anthropic' AND account_id = ?
          AND COALESCE(last_fetch_at, 0) * 1000 > ?`);
      const laterSwitch = db.prepare(`SELECT 1 FROM switch_log
        WHERE provider = 'anthropic' AND to_account = ? AND outcome = 'ok' AND injected = 0 AND ts > ?`);
      for (const item of evidence) {
        if (!Number.isFinite(item.at) || !isLiveSlot.get(item.accountId)) continue;
        if (!laterOkPoll.get(item.accountId, item.at) && !laterSwitch.get(item.accountId, item.at)) {
          unresolved.add(item.accountId);
        }
      }

      if (unresolved.size === 0) {
        return autoLogUnreadable
          ? { name: 'claude:unpersisted-token', level: 'WARN', message: 'auto.log unreadable' }
          : { name: 'claude:unpersisted-token', level: 'PASS', message: 'no unrecovered Claude unpersisted-token evidence' };
      }
      const slots = [...unresolved].sort();
      return {
        name: 'claude:unpersisted-token', level: 'FAIL',
        message: `unpersisted Claude token evidence without later recovery: ${slots.join(', ')}${autoLogUnreadable ? '; auto.log unreadable' : ''}; re-login affected slot(s)`,
      };
    } finally {
      db.close();
    }
  });
}
