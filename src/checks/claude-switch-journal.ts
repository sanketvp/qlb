import { claudePaths } from '../cc-paths';
import {
  claudeSwitchJournalPath,
  probeClaudeSwitchJournalOwner,
  readClaudeSwitchJournal,
  validateClaudeSwitchJournalIdentity,
  type ClaudeSwitchJournal,
  type ClaudeSwitchJournalOptions,
} from '../cc-switch-journal';
import { stillTheSameProcess } from '../codex-sessions';
import { redactError } from '../redact';
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
  ownerIsLive?: (owner: ClaudeSwitchJournal['owner']) => Promise<boolean>;
}

function journalOptions(options: ClaudeSwitchJournalCheckOptions): ClaudeSwitchJournalOptions {
  if (options.journal) return options.journal;
  const paths = claudePaths();
  return { configPath: paths.globalConfigPath, keychainService: paths.keychainService };
}

export function isClaudeSwitchJournalCommitted(dbPath: string, attemptId: string): boolean {
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

function claudeSlotInventory(dbPath: string): Iterable<{ accountId: string }> {
  const db = openStoreConnection(dbPath, true);
  try {
    return db.prepare('SELECT account_id AS accountId FROM claude_slots').all() as { accountId: string }[];
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
    if (!validateClaudeSwitchJournalIdentity(read.journal, claudeSlotInventory(dbPath))) {
      return { name: 'claude:switch-journal', level: 'FAIL', message: 'invalid journal' };
    }
    if (read.journal.committed !== undefined || read.journal.closed !== null || isClaudeSwitchJournalCommitted(dbPath, read.journal.attemptId)) {
      return { name: 'claude:switch-journal', level: 'PASS', message: 'finished' };
    }
    const ownerIsLive = options.ownerIsLive ?? stillTheSameProcess;
    if (probeClaudeSwitchJournalOwner(journal) === 'held' || await ownerIsLive(read.journal.owner)) {
      return { name: 'claude:switch-journal', level: 'PASS', message: 'in progress' };
    }
  } catch (error) {
    return { name: 'claude:switch-journal', level: 'FAIL', message: `unable to inspect Claude switch journal: ${redactError(error, [])}` };
  }

  return {
    name: 'claude:switch-journal',
    level: 'FAIL',
    message: `unfinished Claude switch journal ${path}: attemptId=${read.journal.attemptId} step=${read.journal.step} from=${read.journal.from} to=${read.journal.to}; run qlb claude journal resolve --forward or qlb claude journal resolve --back`,
  };
}
