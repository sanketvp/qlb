import { DatabaseSync } from 'node:sqlite';

import { check } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('codex:slots');

const SLOT_APPLICABLE_PHASES = new Set(['cutting-over', 'cutover', 'retired']);

export function codexSlotsCheck(dbPath: string, phase: string): HealthCheck {
  if (!SLOT_APPLICABLE_PHASES.has(phase)) {
    return { name: 'codex:slots', level: 'N/A', message: `not applicable in phase=${phase}` };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const dead = db.prepare(`
      SELECT account_id AS accountId, dead_reason AS reason
      FROM codex_slots WHERE dead = 1 AND archived_at IS NULL ORDER BY account_id
    `).all() as Array<{ accountId: string; reason: string | null }>;
    return dead.length === 0
      ? { name: 'codex:slots', level: 'PASS', message: 'no dead Codex slots' }
      : { name: 'codex:slots', level: 'FAIL', message: `${dead.length} dead Codex slot(s) require re-login`, detail: dead };
  } finally {
    db.close();
  }
}
