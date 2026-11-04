import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createClaudeSwitchJournal, withClaudeSwitchJournalOwner, type ClaudeSwitchJournal, type ClaudeSwitchJournalOptions } from '../src/cc-switch-journal';
import { journalInProgressCheck } from '../src/checks/journal-in-progress';
import { journalOrphanedCheck } from '../src/checks/journal-orphaned';
import { discoverChecks } from '../src/registry';
import { openStore } from '../src/store';

function fixture(): { root: string; dbPath: string; journalDir: string; switchOptions: ClaudeSwitchJournalOptions } {
  const root = mkdtempSync(join(tmpdir(), 'qlb-journal-doctor-'));
  const dbPath = join(root, 'qlb.db');
  openStore(dbPath).close();
  const journalDir = join(root, 'backups');
  return {
    root, dbPath, journalDir,
    switchOptions: { journalDir: join(root, 'switch'), configPath: join(root, 'config.json'), keychainService: 'fixture-service' },
  };
}

function switchJournal(options: ClaudeSwitchJournalOptions): ClaudeSwitchJournal {
  return {
    v: 1, provider: 'anthropic', attemptId: 'fixture-attempt', from: 'before', to: 'after', trigger: 'manual', by: 'fixture', republish: false, injected: false, detail: null,
    decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null }, outgoingKind: null, bindingJson: null, step: 6,
    stagedBlobService: 'qlb:anthropic:staged-rollback:fixture', stagedAccount: 'qlb', stagedWritten: false,
    keychainService: options.keychainService, configPath: options.configPath, configText: null, configWrittenHash: null, fromOauthAccount: null,
    credentialsWrittenHash: null, credentialsWriteStarted: false, credentialsWritten: false, configWriteStarted: false, configWritten: false,
    closed: null, startedAt: 1, owner: { pid: process.pid, lstart: 'fixture' },
  };
}

function writeImportJournal(dir: string, runId: string, phase: string): void {
  const path = join(dir, `cswap-import-${runId}`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'journal.json'), JSON.stringify({
    runId, phase, startedAt: 1,
    slots: [{ accountId: 'fixture-account', staging: `qlb:anthropic:staging:${runId}:fixture-account`, destination: 'qlb:anthropic:fixture-account',
      importPrevious: `qlb:anthropic:import-prev:${runId}:fixture-account`, importPreviousPrevious: `qlb:anthropic:import-prev-prev:${runId}:fixture-account`,
      fingerprint: 'sha256:fixture', previousFingerprint: null, promotedFingerprint: null, destinationExisted: null, priorDestinationFingerprint: null,
      priorDestinationLineage: null, previousDestinationExisted: null, priorPreviousFingerprint: null, prevSaved: false, previousSaved: false,
      reached: 'unreached', restored: false }],
  }));
}

describe('journal doctor rows (HP-K14-3)', () => {
  it('reports an owned Claude switch journal as in progress', async () => {
    const h = fixture();
    createClaudeSwitchJournal(switchJournal(h.switchOptions), h.switchOptions);
    await withClaudeSwitchJournalOwner(h.switchOptions, async () => {
      assert.deepEqual(await journalInProgressCheck(h.dbPath, 'cutover', { journal: h.switchOptions, journalDir: h.journalDir }), {
        name: 'journal:in-progress', level: 'INFO', message: `Claude switch journal ${join(h.switchOptions.journalDir!, 'switch-anthropic.json')} is held`,
      });
    });
  });

  it('reports a fresh C-swap import lock and its journal phases as in progress', async () => {
    const h = fixture(); writeImportJournal(h.journalDir, 'fresh-import', 'staged'); mkdirSync(join(h.journalDir, 'cswap-import.lock'));
    assert.deepEqual(await journalInProgressCheck(h.dbPath, 'cutting-over', { journalDir: h.journalDir }), {
      name: 'journal:in-progress', level: 'INFO', message: 'C-swap import lock is fresh; phases=fresh-import:staged',
    });
  });

  it('fails a stale promoting import journal with its recovery action', () => {
    const h = fixture(); writeImportJournal(h.journalDir, 'stale-promoting', 'promoting'); mkdirSync(join(h.journalDir, 'cswap-import.lock'));
    const stale = new Date(Date.now() - 61_000); utimesSync(join(h.journalDir, 'cswap-import.lock'), stale, stale);
    assert.deepEqual(journalOrphanedCheck(h.dbPath, 'retired', { journalDir: h.journalDir }), {
      name: 'journal:orphaned', level: 'FAIL', message: 'runId=stale-promoting phase=promoting action=recover; run qlb import cswap --reconcile',
    });
  });

  it('fails a free staged import journal with its purge action', () => {
    const h = fixture(); writeImportJournal(h.journalDir, 'free-staged', 'staged');
    assert.deepEqual(journalOrphanedCheck(h.dbPath, 'cutover', { journalDir: h.journalDir }), {
      name: 'journal:orphaned', level: 'FAIL', message: 'runId=free-staged phase=staged action=purge-staging; run qlb import cswap --reconcile',
    });
  });

  it('fails an unreadable import journal as unclassifiable', () => {
    const h = fixture(); const path = join(h.journalDir, 'cswap-import-unreadable'); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'journal.json'), '{bad');
    assert.deepEqual(journalOrphanedCheck(h.dbPath, 'cutover', { journalDir: h.journalDir }), {
      name: 'journal:orphaned', level: 'FAIL', message: 'runId=unreadable phase=invalid action=unclassifiable; run qlb import cswap --reconcile',
    });
  });

  it('passes a cleaned import journal', () => {
    const h = fixture(); writeImportJournal(h.journalDir, 'cleaned', 'cleaned');
    assert.deepEqual(journalOrphanedCheck(h.dbPath, 'cutover', { journalDir: h.journalDir }), {
      name: 'journal:orphaned', level: 'PASS', message: 'no orphaned import journals',
    });
  });

  it('makes both rows N/A outside the Claude cutover phases', async () => {
    const h = fixture();
    for (const phase of ['pre-cutover', 'undoing', 'rolled-back', 'aborted']) {
      assert.deepEqual(await journalInProgressCheck(h.dbPath, phase, { journalDir: h.journalDir }), { name: 'journal:in-progress', level: 'N/A', message: `not applicable in phase=${phase}` });
      assert.deepEqual(journalOrphanedCheck(h.dbPath, phase, { journalDir: h.journalDir }), { name: 'journal:orphaned', level: 'N/A', message: `not applicable in phase=${phase}` });
    }
  });

  it('registers both journal diagnostic fragments', () => {
    assert.deepEqual(discoverChecks().filter(({ name }) => name.startsWith('journal:')).map(({ name }) => name), ['journal:in-progress', 'journal:orphaned']);
  });
});
