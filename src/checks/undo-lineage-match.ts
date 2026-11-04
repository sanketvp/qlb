import { CswapUndoRefusalError, planHandBack, readPlanState } from '../cswap-undo';
import type { ClaudeSlotBackend } from '../cc-slots';
import { openStoreConnection } from '../store';
import { check } from './_check';
import type { HealthCheck } from './claude-slots';
import { isLifecycleState, type LifecyclePhaseResult } from './lifecycle-phase';

export default check('undo:lineage-match');

function undoBegan(dbPath: string): boolean {
  const db = openStoreConnection(dbPath, true);
  try {
    const row = db.prepare(`
      SELECT undo_began_at AS undoBeganAt
      FROM lifecycle WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1
    `).get() as { undoBeganAt: number | null } | undefined;
    return row?.undoBeganAt != null;
  } finally {
    db.close();
  }
}

function encryptedSlot(path: string): string {
  return /^\.creds-(\d+)-/.exec(path.split(/[\\/]/).pop() ?? '')?.[1] ?? 'unknown';
}

/** Read-only proof that C-swap already has each post-undo credential lineage. */
export async function undoLineageMatchCheck(
  dbPath: string,
  lifecycle: LifecyclePhaseResult,
  keychain: Pick<ClaudeSlotBackend, 'get'>,
  backupDir: string,
): Promise<HealthCheck> {
  const name = 'undo:lineage-match';
  if (!lifecycle.available) return { name, level: 'WARN', message: 'lifecycle phase unavailable; undo lineage cannot be evaluated' };
  if (!isLifecycleState(lifecycle.phase)) return { name, level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
  if (!['rolled-back', 'aborted'].includes(lifecycle.phase) || lifecycle.restorePending === true) {
    return { name, level: 'N/A', message: `not applicable in phase=${lifecycle.phase}` };
  }

  try {
    if (!undoBegan(dbPath)) return { name, level: 'N/A', message: 'not applicable: lifecycle row was not produced by undo' };
    const plan = await planHandBack({ ...readPlanState(dbPath), backupDir, keychain });
    const update = plan.slots.find((slot) => slot.action !== 'noop');
    if (update) return { name, level: 'FAIL', message: `slot ${update.accountNumber}: update required fingerprint=${update.fingerprint}` };
    const encrypted = plan.deleteEnc[0];
    if (encrypted) return { name, level: 'FAIL', message: `slot ${encryptedSlot(encrypted)}: encrypted credential remains` };
    return { name, level: 'PASS', message: 'all undo credential lineages match' };
  } catch (error) {
    if (error instanceof CswapUndoRefusalError) return { name, level: 'FAIL', message: `refused: ${error.code}` };
    // Do not expose backend errors: they can contain sensitive credential material.
    return { name, level: 'FAIL', message: 'refused: structure-invalid' };
  }
}
