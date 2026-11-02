import { codexL13ReceiptAt } from '../codex-l13-receipt';
import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';
import type { LifecyclePhaseResult } from './lifecycle-phase';

export default check('codex:first-switch');

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1_000;

function printableUnknownLifecyclePhase(phase: string): string {
  return /^[a-z-]+$/.test(phase) ? phase : 'unknown';
}

export function codexFirstSwitchCheck(
  dbPath: string,
  lifecycle: LifecyclePhaseResult,
  now: number,
): HealthCheck {
  return guardCheck('codex:first-switch', () => {
    if (!lifecycle.available) {
      return { name: 'codex:first-switch', level: 'WARN', message: 'lifecycle phase unavailable' };
    }

    switch (lifecycle.phase) {
      case 'pre-cutover':
      case 'undoing':
      case 'rolled-back':
      case 'aborted':
      case 'closed':
        return { name: 'codex:first-switch', level: 'N/A', message: `not applicable in phase=${lifecycle.phase}` };
      case 'cutting-over':
        return {
          name: 'codex:first-switch',
          level: 'INFO',
          message: 'automatic Codex switching stays off until qlb codex verify-l13 --complete records the C9 receipt (X2 step 4b)',
        };
      case 'retired':
        return {
          name: 'codex:first-switch',
          level: 'PASS',
          message: 'retire refuses codex-l13-missing',
        };
      case 'cutover':
        break;
      default:
        return { name: 'codex:first-switch', level: 'N/A', message: `not applicable in phase=${printableUnknownLifecyclePhase(lifecycle.phase)}` };
    }

    const db = openStoreConnection(dbPath, true);
    try {
      const lifecycleRow = db.prepare(`
        SELECT cutover_at AS cutoverAt FROM lifecycle WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1
      `).get() as { cutoverAt: number | null } | undefined;
      const receipt = db.prepare("SELECT value FROM config WHERE key = 'codex.l13VerifiedAt'").get() as { value: string } | undefined;
      const receiptAt = codexL13ReceiptAt(receipt?.value ?? null);
      if (receiptAt != null) {
        return {
          name: 'codex:first-switch',
          level: 'PASS',
          message: `C9 receipt recorded at ${new Date(receiptAt).toISOString()}`,
        };
      }
      if (receipt !== undefined) {
        return {
          name: 'codex:first-switch',
          level: 'WARN',
          message: 'C9 receipt invalid',
        };
      }

      if (lifecycleRow?.cutoverAt == null) {
        return { name: 'codex:first-switch', level: 'WARN', message: 'cutover_at missing' };
      }

      const message = 'automatic Codex switching stays off until qlb codex verify-l13 --complete records the C9 receipt (X2 step 4b)';
      if (now - lifecycleRow.cutoverAt <= THREE_DAYS_MS) {
        return { name: 'codex:first-switch', level: 'INFO', message };
      }
      return { name: 'codex:first-switch', level: 'WARN', message: `${message} — overdue` };
    } finally {
      db.close();
    }
  });
}
