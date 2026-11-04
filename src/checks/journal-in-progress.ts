import { join } from 'node:path';

import { claudePaths } from '../cc-paths';
import { claudeSwitchJournalPath, probeClaudeSwitchJournalOwner, readClaudeSwitchJournal, type ClaudeSwitchJournalOptions } from '../cc-switch-journal';
import { SqliteClaudeSlotRepository } from '../cc-slots';
import { stillTheSameProcess } from '../codex-sessions';
import { classifyCswapImportJournals, probeCswapImportLock, type CswapImportJournalStatus } from '../cswap-import';
import { qlbHomeDir } from '../home';
import { platformKeychain } from '../keychain';
import { openStoreConnection } from '../store';
import { check } from './_check';
import { isLifecycleState, LIFECYCLE_STATES } from './lifecycle-phase';
import type { HealthCheck } from './claude-slots';

export default check('journal:in-progress');

const APPLICABLE_PHASES = new Set<string>(LIFECYCLE_STATES.filter((phase) => (
  phase === 'cutting-over' || phase === 'cutover' || phase === 'retired'
)));

export interface JournalDoctorOptions {
  journal?: ClaudeSwitchJournalOptions;
  journalDir?: string;
  now?: () => number;
}

function unavailable(phase: string, name: string): HealthCheck | null {
  if (phase === 'unknown') return { name, level: 'WARN', message: 'lifecycle phase unavailable; journals cannot be evaluated' };
  if (!isLifecycleState(phase)) return { name, level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
  if (!APPLICABLE_PHASES.has(phase)) return { name, level: 'N/A', message: `not applicable in phase=${phase}` };
  return null;
}

function importOptions(dbPath: string, options: JournalDoctorOptions) {
  // The classifier never reads Keychain; this read-only repository prevents a
  // doctor invocation from creating a WAL file or otherwise advancing state.
  return {
    backupDir: '',
    journalDir: options.journalDir ?? join(qlbHomeDir(), '.qlb', 'backups'),
    keychain: platformKeychain,
    repository: new SqliteClaudeSlotRepository(openStoreConnection(dbPath, true)),
  };
}

function phases(journals: CswapImportJournalStatus[]): string {
  return journals.length === 0 ? 'none' : journals.map((journal) => `${journal.runId}:${journal.phase}`).join(', ');
}

/** Read-only visibility of active Claude-switch and C-swap import work. */
export async function journalInProgressCheck(dbPath: string, phase: string, options: JournalDoctorOptions = {}): Promise<HealthCheck> {
  const unavailableResult = unavailable(phase, 'journal:in-progress');
  if (unavailableResult) return unavailableResult;

  const journal: ClaudeSwitchJournalOptions = options.journal ?? (() => {
    const paths = claudePaths();
    return { configPath: paths.globalConfigPath, keychainService: paths.keychainService };
  })();
  let switchHeld = false;
  try {
    const switchRead = readClaudeSwitchJournal(journal);
    switchHeld = switchRead.state === 'ok' && (
      probeClaudeSwitchJournalOwner(journal) === 'held' || await stillTheSameProcess(switchRead.journal.owner)
    );
  } catch {
    return { name: 'journal:in-progress', level: 'FAIL', message: 'Claude switch journal cannot be inspected' };
  }

  const imports = importOptions(dbPath, options);
  try {
    const held = probeCswapImportLock(imports).held;
    const journals = classifyCswapImportJournals(imports);
    if (!switchHeld && !held) return { name: 'journal:in-progress', level: 'PASS', message: 'no journal in progress' };
    const active: string[] = [];
    if (switchHeld) active.push(`Claude switch journal ${claudeSwitchJournalPath(journal)} is held`);
    if (held) active.push(`C-swap import lock is fresh; phases=${phases(journals)}`);
    return { name: 'journal:in-progress', level: 'INFO', message: active.join('; ') };
  } finally {
    imports.repository.close();
  }
}
