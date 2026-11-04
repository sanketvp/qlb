import { join } from 'node:path';

import { SqliteClaudeSlotRepository } from '../cc-slots';
import { classifyCswapImportJournals, probeCswapImportLock } from '../cswap-import';
import { qlbHomeDir } from '../home';
import { platformKeychain } from '../keychain';
import { openStoreConnection } from '../store';
import { check } from './_check';
import { isLifecycleState, LIFECYCLE_STATES } from './lifecycle-phase';
import type { HealthCheck } from './claude-slots';
import type { JournalDoctorOptions } from './journal-in-progress';

export default check('journal:orphaned');

const APPLICABLE_PHASES = new Set<string>(LIFECYCLE_STATES.filter((phase) => (
  phase === 'cutting-over' || phase === 'cutover' || phase === 'retired'
)));

/** Report import journals which need explicit reconciliation without advancing them. */
export function journalOrphanedCheck(dbPath: string, phase: string, options: JournalDoctorOptions = {}): HealthCheck {
  if (phase === 'unknown') return { name: 'journal:orphaned', level: 'WARN', message: 'lifecycle phase unavailable; journals cannot be evaluated' };
  if (!isLifecycleState(phase)) return { name: 'journal:orphaned', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
  if (!APPLICABLE_PHASES.has(phase)) return { name: 'journal:orphaned', level: 'N/A', message: `not applicable in phase=${phase}` };

  const imports = {
    backupDir: '',
    journalDir: options.journalDir ?? join(qlbHomeDir(), '.qlb', 'backups'),
    keychain: platformKeychain,
    repository: new SqliteClaudeSlotRepository(openStoreConnection(dbPath, true)),
  };
  try {
    // A fresh owner is allowed to finish its own transaction. A missing or stale
    // owner cannot make a journal safe, so every non-cleaned record is surfaced.
    if (probeCswapImportLock(imports).held) return { name: 'journal:orphaned', level: 'PASS', message: 'C-swap import lock is held' };
    const orphans = classifyCswapImportJournals(imports).filter((journal) => journal.phase !== 'cleaned');
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
