import { classifyCswapImportJournals, probeCswapImportLock } from '../cswap-import';
import { check } from './_check';
import type { HealthCheck } from './claude-slots';
import { importOptions, unavailable, type JournalDoctorOptions } from './journal-in-progress';

export default check('journal:orphaned');

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
      message: `${orphans.map((journal) => `runId=${journal.runId} phase=${journal.phase} action=${journal.action}`).join('; ')}; run qlb import cswap --reconcile`,
    };
  } catch {
    return { name: 'journal:orphaned', level: 'FAIL', message: 'runId=journal-root-unreadable phase=invalid action=unclassifiable; run qlb import cswap --reconcile' };
  } finally {
    imports.repository.close();
  }
}
