import { existsSync } from 'node:fs';

import { deriveLatch } from '../codex-stage';
import { toStageLog } from '../codex-stop';
import { redactError } from '../redact';
import { openStoreConnection, readCodexStageLogFrom } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('codex:stop-latch');

const NAME = 'codex:stop-latch';

/** Only a sweep-shaped pointer (`<table>:<id>`) is printed; anything else is not ours to echo. */
function printablePointer(evidence: string | null | undefined): string {
  return evidence && /^[a-z_]+:[0-9]+$/.test(evidence) ? evidence : 'unrecognized';
}

function unknownLatch(reason: string, clear = ''): HealthCheck {
  return {
    name: NAME,
    level: 'WARN',
    code: 'latch-unknown',
    message: `Codex stop latch state unknown (${reason}): every Codex switch and refresh treats it as set; see qlb codex stage report${clear}`,
  };
}

/**
 * KTD10: the latch is a WARN, never a FAIL, so a latched qlb still passes the
 * cutover receipt's clean doctor; an unreadable database is a WARN too. The
 * check only reads: it never runs the stop sweep, so a stop the sweep has not
 * recorded yet is not shown here.
 */
export function codexStopLatchCheck(dbPath: string): HealthCheck {
  return guardCheck(NAME, () => {
    if (!existsSync(dbPath)) return { name: NAME, level: 'N/A', message: 'not applicable: no database' };

    const db = openStoreConnection(dbPath, true);
    try {
      const log = readCodexStageLogFrom(db);
      if (log.status === 'unknown') {
        return unknownLatch(log.reason, log.reason === 'initialize-required' ? ', then qlb codex latch clear --initialize --reason <text>' : '');
      }

      const latch = deriveLatch(toStageLog(log));
      if (latch.state === 'latched') {
        const stop = latch.newestStopId;
        const evidence = printablePointer(log.events.find((event) => event.id === stop)?.evidence);
        return {
          name: NAME,
          level: 'WARN',
          code: 'latched',
          message: `Codex stop latch set by stop ${stop} (evidence ${evidence}): new Codex switches and refreshes are refused; see qlb codex stage report, then qlb codex latch clear --through ${stop} --reason <text>`,
        };
      }
      if (!log.events.some((event) => event.kind === 'stage-start')) {
        return { name: NAME, level: 'N/A', message: 'not applicable: no Codex stage has started' };
      }
      return { name: NAME, level: 'INFO', message: 'Codex stop latch clear' };
    } finally {
      db.close();
    }
  }, (error) => unknownLatch(`database unreadable: ${redactError(error, [])}`));
}
