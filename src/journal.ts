import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { credentialFingerprint, type JsonObject } from './anthropic-oauth';
import { readClaudeConfig, readLiveClaudeCredentials, spliceOauthAccount, writeLiveClaudeCredentials } from './cc-credentials';
import { withClaudeConfigPathLock, withClaudeCredentialLocks, withClaudeSwitchLock } from './cc-locks';
import { claudePaths } from './cc-paths';
import {
  deleteClaudeSwitchJournal,
  deleteStagedRollback,
  readStagedRollback,
  probeClaudeSwitchJournalOwner,
  updateClaudeSwitchJournal,
  readClaudeSwitchJournal,
  withClaudeSwitchJournalOwner,
  type ClaudeSwitchJournal,
  type ClaudeSwitchJournalOptions,
} from './cc-switch-journal';
import { checkClaudeCswapProcessPrecondition, restoreConfigFromJournal, restoreLiveFromStaged, sameAccountCredential, targetOauthAccount, type ClaudeSwitchDeps } from './cc-switch';
import { stillTheSameProcess } from './codex-sessions';
import { atomicWriteText } from './fsutil';

function optionsFor(deps: ClaudeSwitchDeps): ClaudeSwitchJournalOptions {
  const paths = deps.live.paths ?? claudePaths({ home: deps.live.home ?? deps.home, env: deps.live.env ?? deps.env });
  return {
    journalDir: deps.journalDir,
    home: deps.home,
    env: deps.env,
    configPath: paths.globalConfigPath,
    keychainService: paths.keychainService,
  };
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function finished(deps: ClaudeSwitchDeps, journal: ClaudeSwitchJournal): boolean {
  return journal.committed !== undefined
    || journal.closed !== null
    || deps.store.findClaudeSwitchByAttempt(journal.attemptId) !== null;
}

async function ownerIsLive(deps: ClaudeSwitchDeps, journal: ClaudeSwitchJournal): Promise<boolean> {
  return (deps.stillTheSameProcess ?? stillTheSameProcess)(journal.owner);
}

export type ClaudeJournalResolveDirection = 'forward' | 'back';
export type ClaudeJournalResolveResult = { outcome: 'resolved' | 'refused'; reason?: string; fingerprints?: string[]; cleanup?: string[] };

function prefix(fingerprint: string | null | undefined): string | null {
  return fingerprint == null ? null : fingerprint.replace(/^sha256(?:-full)?:/, '').slice(0, 12);
}

async function cleanupResolvedJournal(close: () => void, stage: () => Promise<void>, remove: () => void): Promise<string[]> {
  try { close(); } catch { return ['journal']; }
  try { await stage(); } catch { return ['staged']; }
  try { remove(); } catch { return ['journal']; }
  return [];
}

/**
 * Resolve a dead owner's unfinished journal only on explicit operator request;
 * forward completes it while automatic reconciliation remains rollback-only.
 */
export async function resolveClaudeSwitchJournal(
  deps: ClaudeSwitchDeps,
  direction: ClaudeJournalResolveDirection,
): Promise<ClaudeJournalResolveResult> {
  const cswap = checkClaudeCswapProcessPrecondition(deps);
  if (cswap !== null) return { outcome: 'refused', reason: cswap };
  const options = optionsFor(deps);
  const initial = readClaudeSwitchJournal(options);
  if (initial.state !== 'ok') return { outcome: 'refused', reason: initial.state === 'absent' ? 'journal-absent' : 'journal-malformed' };
  if (finished(deps, initial.journal)) return { outcome: 'refused', reason: 'journal-finished' };
  if (probeClaudeSwitchJournalOwner(options) === 'held' || await ownerIsLive(deps, initial.journal)) return { outcome: 'refused', reason: 'owner-alive' };
  const paths = deps.live.paths ?? claudePaths({ home: deps.live.home ?? deps.home, env: deps.live.env ?? deps.env });
  const switchLock = deps.locks?.switch ?? withClaudeSwitchLock;
  const credentialLock = deps.locks?.credential ?? withClaudeCredentialLocks;
  const ownerLock = deps.locks?.owner ?? withClaudeSwitchJournalOwner;
  const configLock = deps.locks?.configPath ?? withClaudeConfigPathLock;
  const update = deps.journalOps?.update ?? updateClaudeSwitchJournal;
  const remove = deps.journalOps?.remove ?? deleteClaudeSwitchJournal;
  return switchLock(() => credentialLock({ configDir: paths.configHome, env: deps.env }, async (credentialHeld) => ownerLock(options, async (ownerHeld) => {
    const reread = readClaudeSwitchJournal(options);
    if (reread.state !== 'ok') return { outcome: 'refused', reason: reread.state === 'absent' ? 'journal-absent' : 'journal-malformed' };
    const journal = reread.journal;
    if (finished(deps, journal)) return { outcome: 'refused', reason: 'journal-finished' };
    if (await ownerIsLive(deps, journal)) return { outcome: 'refused', reason: 'owner-alive' };
    const lockedCswap = checkClaudeCswapProcessPrecondition(deps);
    if (lockedCswap !== null) return { outcome: 'refused', reason: lockedCswap };

    if (direction === 'back') {
      let staged: string | null = null;
      let live: string | null = null;
      const outgoing = deps.slots.getSlot(journal.from);
      if (journal.credentialsWriteStarted) {
        try { staged = await readStagedRollback(deps.live.backend, journal.stagedBlobService); live = await readLiveClaudeCredentials(deps.live); }
        catch { return { outcome: 'refused', reason: 'staged-unreadable' }; }
        if (staged === null) return { outcome: 'refused', reason: 'staged-unreadable' };
        const liveFingerprint = credentialFingerprint(live);
        if (journal.credentialsWrittenHash === null) return { outcome: 'refused', reason: 'live-not-outgoing' };
        if (live !== staged && sha256(live) !== journal.credentialsWrittenHash
          && liveFingerprint !== outgoing?.fingerprint && liveFingerprint !== outgoing?.prevFingerprint) {
          return { outcome: 'refused', reason: 'live-not-outgoing' };
        }
      }
      await configLock(journal.configPath, { env: deps.env }, (held) => restoreConfigFromJournal(deps, journal, held));
      if (journal.credentialsWriteStarted && staged !== null && live !== null && sha256(live) === journal.credentialsWrittenHash) {
        await writeLiveClaudeCredentials(staged, deps.live, credentialHeld);
      }
      deps.store.recordSwitch({ ts: deps.now(), provider: 'anthropic', fromAccount: journal.from, toAccount: journal.to,
        trigger: journal.trigger, outcome: 'rolled-back', detail: 'journal-back', injected: journal.injected,
        stepsJson: JSON.stringify({ attempt: journal.attemptId }) });
      const cleanup = await cleanupResolvedJournal(
        () => update(ownerHeld, { closed: 'rolled-back' }, options),
        () => deleteStagedRollback(deps.live.backend, journal.stagedBlobService),
        () => remove(ownerHeld, options),
      );
      return { outcome: 'resolved', fingerprints: [prefix(outgoing?.fingerprint), prefix(outgoing?.prevFingerprint)].filter((value): value is string => value !== null), cleanup };
    }

    if (!journal.credentialsWritten) return { outcome: 'refused', reason: 'credentials-not-written' };
    let live: string;
    let target: string;
    try { live = await readLiveClaudeCredentials(deps.live); target = (await deps.slots.readSlot(journal.to, { fresh: true })).credential; }
    catch { return { outcome: 'refused', reason: 'target-lineage-missing' }; }
    if (!sameAccountCredential(target, live)) return { outcome: 'refused', reason: 'target-lineage-missing' };
    const oauth = targetOauthAccount(deps.slots.getSlot(journal.to)?.configJson, journal.to);
    if (oauth === null) return { outcome: 'refused', reason: 'target-invalid' };
    const configResult = await configLock(journal.configPath, { env: deps.env }, async (held): Promise<string | null> => {
      const raw = (deps.live.readText ?? ((path: string) => readFileSync(path, 'utf8')))(journal.configPath);
      const original = readClaudeConfig(journal.configPath, () => raw).oauthAccount;
      const fromOauthAccount = original && typeof original === 'object' && !Array.isArray(original) ? original as JsonObject : null;
      if (journal.configWriteStarted) {
        if (journal.configWrittenHash !== null && sha256(raw) === journal.configWrittenHash) return null;
        if (journal.configText === null || raw !== journal.configText) return 'config-moved';
      }
      let planned: string | undefined;
      await spliceOauthAccount(journal.configPath, oauth, held, { readText: () => raw, writeText: (_path, text) => { planned = text; } });
      if (planned === undefined) throw new Error('config-plan-failed');
      if (journal.configWriteStarted) {
        if (journal.configWrittenHash === null || sha256(planned) !== journal.configWrittenHash) return 'config-moved';
      } else {
        update(ownerHeld, { step: 8, configText: raw, fromOauthAccount, configWrittenHash: sha256(planned), configWriteStarted: true }, options);
      }
      (deps.live.writeText ?? ((path: string, text: string) => { atomicWriteText(path, text, { mode: 0o600 }); }))(journal.configPath, planned);
      update(ownerHeld, { configWritten: true }, options);
      return null;
    });
    if (configResult !== null) return { outcome: 'refused', reason: configResult };
    deps.store.commitClaudeSwitch({ now: deps.now(), fromAccount: journal.from, toAccount: journal.to, trigger: journal.trigger,
      setBy: 'journal', attempt: journal.attemptId, outgoingKind: journal.outgoingKind,
      bindingJson: journal.bindingJson, stepsJson: JSON.stringify({ attempt: journal.attemptId, started: [8, 9] }),
      publishedAt: journal.publishedAt ?? null, injected: journal.injected,
      detail: journal.republish ? 'republish' : 'journal-forward', republish: journal.republish, decision: journal.decision });
    const cleanup = await cleanupResolvedJournal(
      () => update(ownerHeld, { committed: deps.now() }, options),
      () => deleteStagedRollback(deps.live.backend, journal.stagedBlobService),
      () => remove(ownerHeld, options),
    );
    return { outcome: 'resolved', fingerprints: [prefix(credentialFingerprint(live))].filter((value): value is string => value !== null), cleanup };
  })), { home: deps.home, env: deps.env });
}

/**
 * Recover an orphaned, unfinished Claude switch by rolling its live effects
 * back. This deliberately never completes a switch forward.
 */
export async function reconcileClaudeSwitch(deps: ClaudeSwitchDeps): Promise<void> {
  // S24 must prevent recovery from acquiring any Claude Code lock too.
  const initialCswapProcessReason = checkClaudeCswapProcessPrecondition(deps);
  if (initialCswapProcessReason !== null) {
    deps.warn?.(initialCswapProcessReason);
    return;
  }

  const options = optionsFor(deps);
  const initial = readClaudeSwitchJournal(options);
  // An absent, malformed, completed, or live-owned journal is left for the
  // normal switch path. In particular, malformed journals remain fail-closed.
  if (initial.state !== 'ok' || finished(deps, initial.journal)
    || probeClaudeSwitchJournalOwner(options) === 'held'
    || await ownerIsLive(deps, initial.journal)) return;

  const paths = deps.live.paths ?? claudePaths({ home: deps.live.home ?? deps.home, env: deps.live.env ?? deps.env });
  const switchLock = deps.locks?.switch ?? withClaudeSwitchLock;
  const credentialLock = deps.locks?.credential ?? withClaudeCredentialLocks;
  const ownerLock = deps.locks?.owner ?? withClaudeSwitchJournalOwner;
  const configLock = deps.locks?.configPath ?? withClaudeConfigPathLock;
  const journalUpdate = deps.journalOps?.update ?? updateClaudeSwitchJournal;
  const journalRemove = deps.journalOps?.remove ?? deleteClaudeSwitchJournal;

  await switchLock(async () => {
    await credentialLock({ configDir: paths.configHome, env: deps.env }, async (credentialHeld) => {
      await ownerLock(options, async (ownerHeld) => {
        const reread = readClaudeSwitchJournal(options);
        if (reread.state !== 'ok' || finished(deps, reread.journal) || await ownerIsLive(deps, reread.journal)) return;
        const journal = reread.journal;
        const lockedCswapProcessReason = checkClaudeCswapProcessPrecondition(deps);
        if (lockedCswapProcessReason !== null) {
          deps.warn?.(lockedCswapProcessReason);
          return;
        }

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
          trigger: journal.trigger, outcome: 'rolled-back', detail: 'crash-reconcile', injected: journal.injected,
          stepsJson: JSON.stringify({ attempt: journal.attemptId }),
        });
        // Durable completion must precede cleanup: a cleanup failure then
        // leaves a finished journal for switchClaude's existing step-4 cleanup.
        journalUpdate(ownerHeld, { closed: 'rolled-back' }, options);
        await deleteStagedRollback(deps.live.backend, journal.stagedBlobService);
        journalRemove(ownerHeld, options);
      });
    });
  }, { home: deps.home, env: deps.env });
}
