import { withClaudeConfigPathLock, withClaudeCredentialLocks, withClaudeSwitchLock } from './cc-locks';
import { claudePaths } from './cc-paths';
import {
  deleteClaudeSwitchJournal,
  deleteStagedRollback,
  probeClaudeSwitchJournalOwner,
  readClaudeSwitchJournal,
  withClaudeSwitchJournalOwner,
  type ClaudeSwitchJournal,
  type ClaudeSwitchJournalOptions,
} from './cc-switch-journal';
import { restoreConfigFromJournal, restoreLiveFromStaged, type ClaudeSwitchDeps } from './cc-switch';
import { stillTheSameProcess } from './codex-sessions';

function optionsFor(deps: ClaudeSwitchDeps): ClaudeSwitchJournalOptions {
  const paths = deps.live.paths ?? claudePaths({ home: deps.home, env: deps.env });
  return {
    journalDir: deps.journalDir,
    home: deps.home,
    env: deps.env,
    configPath: paths.globalConfigPath,
    keychainService: paths.keychainService,
  };
}

function finished(deps: ClaudeSwitchDeps, journal: ClaudeSwitchJournal): boolean {
  return journal.committed !== undefined
    || journal.closed !== null
    || deps.store.findClaudeSwitchByAttempt(journal.attemptId) !== null;
}

async function ownerIsLive(deps: ClaudeSwitchDeps, journal: ClaudeSwitchJournal): Promise<boolean> {
  return (deps.stillTheSameProcess ?? stillTheSameProcess)(journal.owner);
}

/**
 * Recover an orphaned, unfinished Claude switch by rolling its live effects
 * back. This deliberately never completes a switch forward.
 */
export async function reconcileClaudeSwitch(deps: ClaudeSwitchDeps): Promise<void> {
  const options = optionsFor(deps);
  const initial = readClaudeSwitchJournal(options);
  // An absent, malformed, completed, or live-owned journal is left for the
  // normal switch path. In particular, malformed journals remain fail-closed.
  if (initial.state !== 'ok' || finished(deps, initial.journal)
    || probeClaudeSwitchJournalOwner(options) === 'held'
    || await ownerIsLive(deps, initial.journal)) return;

  const paths = deps.live.paths ?? claudePaths({ home: deps.home, env: deps.env });
  const switchLock = deps.locks?.switch ?? withClaudeSwitchLock;
  const credentialLock = deps.locks?.credential ?? withClaudeCredentialLocks;
  const ownerLock = deps.locks?.owner ?? withClaudeSwitchJournalOwner;
  const configLock = deps.locks?.configPath ?? withClaudeConfigPathLock;

  await switchLock(async () => {
    await credentialLock({ configDir: paths.configHome, env: deps.env }, async (credentialHeld) => {
      await ownerLock(options, async (ownerHeld) => {
        const reread = readClaudeSwitchJournal(options);
        if (reread.state !== 'ok' || finished(deps, reread.journal) || await ownerIsLive(deps, reread.journal)) return;
        const journal = reread.journal;

        if (journal.credentialsWriteStarted) {
          const liveResult = await restoreLiveFromStaged(deps, journal, credentialHeld);
          if (liveResult === 'live-moved' || liveResult === 'staged-unreadable') {
            deps.warn?.('reconcile-unresolved');
            return;
          }
        }

        await configLock(journal.configPath, { env: deps.env }, (heldConfigLock) =>
          restoreConfigFromJournal(deps, journal, heldConfigLock));
        deps.store.recordSwitch({
          ts: deps.now(), provider: 'anthropic', fromAccount: journal.from, toAccount: journal.to,
          trigger: 'journal', outcome: 'rolled-back', detail: 'crash-reconcile',
          stepsJson: JSON.stringify({ attempt: journal.attemptId }),
        });
        await deleteStagedRollback(deps.live.backend, journal.stagedBlobService);
        deleteClaudeSwitchJournal(ownerHeld, options);
      });
    });
  }, { home: deps.home, env: deps.env });
}
