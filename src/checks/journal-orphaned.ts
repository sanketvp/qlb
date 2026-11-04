import { classifyCswapImportJournals, probeCswapImportLock, type CswapImportJournalStatus } from '../cswap-import';
import { redactError } from '../redact';
import { check } from './_check';
import type { HealthCheck } from './claude-slots';
import { importOptions, unavailable, type JournalDoctorOptions } from './journal-in-progress';

export default check('journal:orphaned');

function recoveryAdvice(phase: string, orphans: CswapImportJournalStatus[]): string {
  if (orphans.some((journal) => journal.action === 'unclassifiable')) return '; inspect unclassifiable import journals manually';
  if (phase === 'retired') return '; reconciliation is available only during cutting-over or cutover';
  return '; run qlb import cswap --reconcile';
}

/** Report import journals which need explicit reconciliation without advancing them. */
export function journalOrphanedCheck(dbPath: string, phase: string, options: JournalDoctorOptions = {}): HealthCheck {
  const unavailableResult = unavailable(phase, 'journal:orphaned');
  if (unavailableResult) return unavailableResult;

  const imports = importOptions(dbPath, options);
  try {
    if (probeCswapImportLock(imports).held) return { name: 'journal:orphaned', level: 'PASS', message: 'C-swap import lock is held' };
    const orphans = classifyCswapImportJournals(imports).filter((journal) => journal.action !== 'none');
    if (orphans.length === 0) return { name: 'journal:orphaned', level: 'PASS', message: 'no orphaned import journals' };
    return {
      name: 'journal:orphaned',
      level: 'FAIL',
      message: `${orphans.map((journal) => `runId=${journal.runId} phase=${journal.phase} action=${journal.action}`).join('; ')}${recoveryAdvice(phase, orphans)}`,
    };
  } catch (error) {
    return { name: 'journal:orphaned', level: 'FAIL', message: `unable to inspect C-swap import journals: ${redactError(error, [])}` };
  } finally {
    imports.repository.close();
  }
}
