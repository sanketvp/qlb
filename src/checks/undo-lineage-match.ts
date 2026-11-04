import { CswapUndoRefusalError, planHandBack, readPlanState } from '../cswap-undo';
import type { ClaudeSlotBackend } from '../cc-slots';
import { readUndoBeganAt } from '../lifecycle-read';
import { redactError } from '../redact';
import { check } from './_check';
import type { HealthCheck } from './claude-slots';
import { isLifecycleState, type LifecyclePhaseResult } from './lifecycle-phase';

export default check('undo:lineage-match');

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
    if (readUndoBeganAt(dbPath) == null) return { name, level: 'N/A', message: 'not applicable: lifecycle row was not produced by undo' };
    const plan = await planHandBack({ ...readPlanState(dbPath), backupDir, keychain });
    const encrypted = plan.deleteEnc[0];
    if (encrypted) return { name, level: 'FAIL', message: `slot ${encryptedSlot(encrypted)}: encrypted credential remains` };
    const missing = plan.slots.find((slot) => slot.destinationState === 'missing');
    if (missing) return { name, level: 'FAIL', message: `slot ${missing.accountNumber}: C-swap credential missing` };
    const malformed = plan.slots.find((slot) => slot.destinationState === 'malformed');
    if (malformed) return { name, level: 'FAIL', message: `slot ${malformed.accountNumber}: C-swap credential malformed` };
    const rotated = plan.slots.find((slot) => slot.destinationState === 'rotated');
    if (rotated) return { name, level: 'WARN', message: `slot ${rotated.accountNumber}: credential lineage changed after hand-back` };
    return { name, level: 'PASS', message: 'all undo credential lineages match' };
  } catch (error) {
    if (error instanceof CswapUndoRefusalError) return { name, level: 'FAIL', message: `refused: ${error.code}` };
    return { name, level: 'FAIL', message: `unable to inspect undo credential lineage: ${redactError(error, [])}` };
  }
}
