import { readUndoBeganAt } from '../lifecycle-read';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';
import { isLifecycleState, type LifecyclePhaseResult } from './lifecycle-phase';

export default check('undo:incomplete');

const RESUME_COMMAND = 'qlb undo cswap --resume';

export function undoIncompleteCheck(dbPath: string, lifecycle: LifecyclePhaseResult): HealthCheck {
  return guardCheck('undo:incomplete', () => {
    if (!lifecycle.available) {
      return { name: 'undo:incomplete', level: 'WARN', message: 'lifecycle phase unavailable; undo cannot be evaluated' };
    }

    if (!isLifecycleState(lifecycle.phase)) {
      return { name: 'undo:incomplete', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
    }
    if (!['undoing', 'rolled-back', 'aborted'].includes(lifecycle.phase)) {
      return { name: 'undo:incomplete', level: 'N/A', message: `not applicable in phase=${lifecycle.phase}` };
    }

    if (lifecycle.phase === 'undoing') {
      const undoBeganAt = readUndoBeganAt(dbPath);
      return {
        name: 'undo:incomplete',
        level: 'FAIL',
        message: `undo-unfinished: undo_began_at=${undoBeganAt ?? 'missing'}; run ${RESUME_COMMAND}`,
      };
    }

    if (lifecycle.restorePending === true) {
      return {
        name: 'undo:incomplete',
        level: 'FAIL',
        message: `cswap-restore-pending: run ${RESUME_COMMAND}`,
      };
    }
    return { name: 'undo:incomplete', level: 'PASS', message: 'no incomplete undo' };
  });
}
