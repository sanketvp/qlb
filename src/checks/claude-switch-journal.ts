import { claudePaths } from '../cc-paths';
import {
  claudeSwitchJournalPath,
  probeClaudeSwitchJournalOwner,
  readClaudeSwitchJournal,
  type ClaudeSwitchJournal,
  type ClaudeSwitchJournalOptions,
} from '../cc-switch-journal';
import { stillTheSameProcess } from '../codex-sessions';
import { openStoreConnection } from '../store';
import { isLifecycleState, LIFECYCLE_STATES } from './lifecycle-phase';
import { check } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('claude:switch-journal');

const APPLICABLE_PHASES = new Set<string>(LIFECYCLE_STATES.filter((phase) => (
  phase === 'cutting-over' || phase === 'cutover' || phase === 'retired'
)));

export interface ClaudeSwitchJournalCheckOptions {
  journal?: ClaudeSwitchJournalOptions;
  ownerLock?: (options: ClaudeSwitchJournalOptions) => 'held' | 'free';
  ownerIsLive?: (owner: ClaudeSwitchJournal['owner']) => Promise<boolean>;
  committed?: (attemptId: string) => boolean;
}

function journalOptions(options: ClaudeSwitchJournalCheckOptions): ClaudeSwitchJournalOptions {
  if (options.journal) return options.journal;
  const paths = claudePaths();
  return { configPath: paths.globalConfigPath, keychainService: paths.keychainService };
}

function isCommitted(dbPath: string, attemptId: string): boolean {
  const db = openStoreConnection(dbPath, true);
  try {
    return db.prepare(`SELECT 1
      FROM switch_log
      WHERE provider = 'anthropic' AND committed_at IS NOT NULL
        AND CASE WHEN json_valid(steps_json) THEN json_extract(steps_json, '$.attempt') END = ?
      LIMIT 1`).get(attemptId) !== undefined;
  } finally {
    db.close();
  }
}

/** Read-only visibility for a stranded Claude switch journal. */
export async function claudeSwitchJournalCheck(
  dbPath: string,
  phase: string,
  options: ClaudeSwitchJournalCheckOptions = {},
): Promise<HealthCheck> {
  if (phase === 'unknown') {
    return { name: 'claude:switch-journal', level: 'WARN', message: 'lifecycle phase unavailable; Claude switch journal cannot be evaluated' };
  }
  if (!isLifecycleState(phase)) {
    return { name: 'claude:switch-journal', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
  }
  if (!APPLICABLE_PHASES.has(phase)) {
    return { name: 'claude:switch-journal', level: 'N/A', message: `not applicable in phase=${phase}` };
  }

  const journal = journalOptions(options);
  const path = claudeSwitchJournalPath(journal);
  const read = readClaudeSwitchJournal(journal);
  if (read.state === 'absent') return { name: 'claude:switch-journal', level: 'PASS', message: 'no Claude switch journal' };
  if (read.state === 'malformed') return { name: 'claude:switch-journal', level: 'FAIL', message: 'malformed' };

  try {
    const committed = options.committed ?? ((attemptId: string) => isCommitted(dbPath, attemptId));
    if (read.journal.committed !== undefined || read.journal.closed !== null || committed(read.journal.attemptId)) {
      return { name: 'claude:switch-journal', level: 'PASS', message: 'finished' };
    }
    const ownerLock = options.ownerLock ?? probeClaudeSwitchJournalOwner;
    const ownerIsLive = options.ownerIsLive ?? stillTheSameProcess;
    if (ownerLock(journal) === 'held' || await ownerIsLive(read.journal.owner)) {
      return { name: 'claude:switch-journal', level: 'PASS', message: 'in progress' };
    }
  } catch {
    return { name: 'claude:switch-journal', level: 'FAIL', message: 'unable to inspect Claude switch journal' };
  }

  return {
    name: 'claude:switch-journal',
    level: 'FAIL',
    message: `unfinished Claude switch journal ${path}: attemptId=${read.journal.attemptId} step=${read.journal.step} from=${read.journal.from} to=${read.journal.to}; run qlb claude journal resolve --forward or qlb claude journal resolve --back`,
  };
}
