import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { claudePaths } from '../src/cc-paths';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import {
  claudeSwitchJournalPath,
  createClaudeSwitchJournal,
  deleteClaudeSwitchJournal,
  readClaudeSwitchJournal,
  readStagedRollback,
  updateClaudeSwitchJournal,
  writeStagedRollback,
  type ClaudeSwitchJournal,
} from '../src/cc-switch-journal';
import { MockKeychain } from '../src/keychain';
import { reconcileClaudeSwitch, resolveClaudeSwitchJournal } from '../src/journal';
import { switchClaude, type ClaudeSwitchDeps } from '../src/cc-switch';
import { createSwitchAnthropicCommand } from '../src/commands/switch-anthropic';
import { createClaudeJournalResolveCommand } from '../src/commands/claude-journal-resolve';
import { ClaudeCodeLockTimeout } from '../src/cc-locks';
import type { CommandContext } from '../src/registry';

const NOW = 1_000_000;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const credential = (tag: string) => JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${tag}`, refreshToken: `fixture-refresh-${tag}`, expiresAt: NOW + 3_600_000 } });

type Subject = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-journal-reconcile-'));
  const home = join(root, 'home');
  const env = { QLB_TEST_MODE: '1', QLB_HOME: join(root, 'qlb-home'), HOME: home };
  const paths = claudePaths({ home, env });
  mkdirSync(paths.configHome, { recursive: true });
  const backend = new MockKeychain();
  const slots = new ClaudeSlots({ backend, repository: new InMemoryClaudeSlotRepository(), stashDir: join(root, 'unclaimed'), now: () => NOW });
  const outgoing = credential('a');
  const target = credential('b');
  const configText = `${JSON.stringify({ oauthAccount: { accountUuid: 'a' }, retained: 'yes' })}\n`;
  writeFileSync(paths.globalConfigPath, configText);
  await backend.set(paths.keychainService, 'fixture-user', outgoing);
  await slots.createSlot({ accountId: 'a', credential: outgoing, email: 'a@example.test', orgUuid: 'org-a', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'a' } }), source: 'cswap-import' });
  await slots.createSlot({ accountId: 'b', credential: target, email: 'b@example.test', orgUuid: 'org-b', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'b' } }), source: 'cswap-import' });
  let active = 'a';
  const rows: Array<Record<string, unknown>> = [];
  const commits: Array<Record<string, unknown>> = [];
  const committed = new Set<string>();
  const warnings: string[] = [];
  const deps: ClaudeSwitchDeps = {
    store: {
      getActiveLogin: () => ({ provider: 'anthropic', accountId: active, since: NOW, setBy: 'manual' }),
      getConfig: () => null,
      setActiveLogin: () => {},
      recordRelogin: () => 1,
      recordSwitch: (row: Record<string, unknown>) => { rows.push(row); return rows.length; },
      recordClaudeSwitchRefusal: (row: Record<string, unknown>) => { rows.push(row); return rows.length; },
      findClaudeSwitchByAttempt: (attempt: string) => committed.has(attempt) ? { id: 1, outcome: 'ok', ts: NOW, committedAt: NOW } : null,
      commitClaudeSwitch: (row: { toAccount: string; beforeCommit?: () => void }) => { row.beforeCommit?.(); commits.push(row); active = row.toAccount; return 1; },
    } as unknown as ClaudeSwitchDeps['store'],
    slots,
    live: { backend, paths, account: 'fixture-user' },
    readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
    resolveProfile: async () => null,
    consume: { postRefresh: async () => ({ status: 500, body: '' }), withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn() },
    env, home, now: () => NOW, by: 'qlb-cli', attempt: 'next-switch', journalDir: join(root, 'journal'),
    journalOwner: { pid: process.pid, lstart: 'fixture' },
    stillTheSameProcess: async () => false,
    warn: (message) => warnings.push(message),
  };
  return { root, home, env, paths, backend, slots, outgoing, target, configText, deps, rows, commits, committed, warnings, active: () => active };
}

function journal(subject: Subject, patch: Partial<ClaudeSwitchJournal> = {}): ClaudeSwitchJournal {
  return {
    v: 1, provider: 'anthropic', attemptId: 'orphaned-attempt', from: 'a', to: 'b', trigger: 'manual', by: 'qlb-cli', republish: false, injected: false, detail: null,
    decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null }, outgoingKind: 'own-bytes', bindingJson: null,
    step: 7, stagedBlobService: 'qlb:anthropic:staged-rollback:orphaned', stagedAccount: 'qlb', stagedWritten: true,
    keychainService: subject.paths.keychainService, configPath: subject.paths.globalConfigPath, configText: null, configWrittenHash: null,
    fromOauthAccount: null, credentialsWrittenHash: digest(subject.target), credentialsWriteStarted: true, credentialsWritten: true,
    configWriteStarted: false, configWritten: false, closed: null, startedAt: NOW,
    owner: { pid: 999_999, lstart: 'dead-process' }, ...patch,
  };
}

async function install(subject: Subject, entry = journal(subject)): Promise<ClaudeSwitchJournal> {
  createClaudeSwitchJournal(entry, { journalDir: subject.deps.journalDir, home: subject.home, env: subject.env, configPath: subject.paths.globalConfigPath, keychainService: subject.paths.keychainService });
  if (entry.stagedWritten) await writeStagedRollback(subject.backend, entry.stagedBlobService, subject.outgoing);
  return entry;
}

function journalExists(subject: Subject): boolean {
  return existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json'));
}

function wrappedBackend(backend: MockKeychain, overrides: Partial<ClaudeSwitchDeps['live']['backend']>): ClaudeSwitchDeps['live']['backend'] {
  return {
    kind: 'test-memory',
    get: overrides.get ?? ((service, account) => backend.get(service, account)),
    set: overrides.set ?? ((service, account, value) => backend.set(service, account, value)),
    delete: overrides.delete ?? ((service, account) => backend.delete(service, account)),
    setSync: overrides.setSync ?? ((service, account, value) => backend.setSync(service, account, value)),
    getSync: overrides.getSync ?? ((service, account) => backend.getSync(service, account)),
    deleteSync: overrides.deleteSync ?? ((service, account) => backend.deleteSync(service, account)),
  };
}

describe('Claude switch journal reconciliation (G10)', () => {
  it('journal resolve reports lock contention as a refusal instead of usage failure', async () => {
    const subject = await fixture();
    const stderr: string[] = [];
    const command = createClaudeJournalResolveCommand({
      openStore: () => ({ close: () => {} }) as never,
      assertAdmitted: () => ({ ok: true }),
      makeSwitchDeps: async () => subject.deps,
      resolve: async () => { throw new ClaudeCodeLockTimeout(join(subject.root, 'fixture.lock')); },
    });
    const ctx = { ...({} as CommandContext), stderr: (line: string) => stderr.push(line), stdout: () => {}, env: subject.env, home: subject.home,
      config: { dbPath: join(subject.root, 'unused.sqlite') } };

    assert.equal(await command.execute!(['--forward'], ctx), 3);
    assert.deepEqual(stderr, ['qlb claude journal resolve: refused: lock-timeout']);
  });

  it('journal resolve reports unexpected failures without exposing their message', async () => {
    const subject = await fixture();
    const stderr: string[] = [];
    const command = createClaudeJournalResolveCommand({
      openStore: () => ({ close: () => {} }) as never,
      assertAdmitted: () => ({ ok: true }),
      makeSwitchDeps: async () => subject.deps,
      resolve: async () => { throw new Error('sensitive backend detail'); },
    });
    const ctx = { ...({} as CommandContext), stderr: (line: string) => stderr.push(line), stdout: () => {}, env: subject.env, home: subject.home,
      config: { dbPath: join(subject.root, 'unused.sqlite') } };

    assert.equal(await command.execute!(['--back'], ctx), 1);
    assert.deepEqual(stderr, ['qlb claude journal resolve: failed']);
  });

  it('operator forward completes a step-7 journal with journal provenance', async () => {
    const subject = await fixture();
    await install(subject);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);

    const result = await resolveClaudeSwitchJournal(subject.deps, 'forward');

    assert.equal(result.outcome, 'resolved');
    assert.equal(subject.active(), 'b');
    assert.equal(JSON.parse(readFileSync(subject.paths.globalConfigPath, 'utf8')).oauthAccount.accountUuid, 'b');
    assert.equal(subject.commits[0]?.setBy, 'journal');
    assert.equal(subject.commits[0]?.detail, 'journal-forward');
    assert.equal(journalExists(subject), false);
  });

  it('operator forward preserves a step-8 snapshot if commit fails, so back restores the outgoing config', async () => {
    const subject = await fixture();
    const changedConfig = `${JSON.stringify({ oauthAccount: { accountUuid: 'b' }, retained: 'yes' })}\n`;
    await install(subject, journal(subject, {
      step: 8, configText: subject.configText, configWrittenHash: digest(changedConfig),
      fromOauthAccount: { accountUuid: 'a' }, configWriteStarted: true, configWritten: true,
    }));
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    writeFileSync(subject.paths.globalConfigPath, changedConfig);
    subject.deps.store.commitClaudeSwitch = () => { throw new Error('sqlite failure'); };

    await assert.rejects(resolveClaudeSwitchJournal(subject.deps, 'forward'), /sqlite failure/);
    const afterForward = readClaudeSwitchJournal({ journalDir: subject.deps.journalDir, home: subject.home, env: subject.env, configPath: subject.paths.globalConfigPath, keychainService: subject.paths.keychainService });
    assert.equal(afterForward.state, 'ok');
    if (afterForward.state === 'ok') assert.equal(afterForward.journal.configText, subject.configText);

    const back = await resolveClaudeSwitchJournal(subject.deps, 'back');
    assert.equal(back.outcome, 'resolved');
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), subject.configText);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.outgoing);
  });

  it('operator forward refuses a step-8 journal after an unrelated config edit', async () => {
    const subject = await fixture();
    const written = `${JSON.stringify({ oauthAccount: { accountUuid: 'b' }, retained: 'yes' })}\n`;
    await install(subject, journal(subject, {
      step: 8, configText: subject.configText, configWrittenHash: digest(written),
      fromOauthAccount: { accountUuid: 'a' }, configWriteStarted: true, configWritten: true,
    }));
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    const edited = `${JSON.stringify({ oauthAccount: { accountUuid: 'b' }, retained: 'operator edit' })}\n`;
    writeFileSync(subject.paths.globalConfigPath, edited);

    assert.deepEqual(await resolveClaudeSwitchJournal(subject.deps, 'forward'), { outcome: 'refused', reason: 'config-moved' });
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), edited);
    assert.equal(journalExists(subject), true);
  });
  it('a crash after step 7 restores live and config byte-equal, then a new switch succeeds', async () => {
    const subject = await fixture();
    const changedConfig = `${JSON.stringify({ oauthAccount: { accountUuid: 'b' }, retained: 'yes' })}\n`;
    const entry = await install(subject, journal(subject, {
      step: 8, configText: subject.configText, configWrittenHash: digest(changedConfig),
      fromOauthAccount: { accountUuid: 'a' }, configWriteStarted: true, configWritten: true,
    }));
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    writeFileSync(subject.paths.globalConfigPath, changedConfig);
    await reconcileClaudeSwitch(subject.deps);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.outgoing);
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), subject.configText);
    assert.equal(journalExists(subject), false);
    assert.equal(await readStagedRollback(subject.backend, entry.stagedBlobService), null);
    assert.deepEqual(subject.rows.map((row) => [row.outcome, row.detail]), [['rolled-back', 'crash-reconcile']]);
    assert.equal((await switchClaude(subject.deps, { to: 'b', trigger: 'manual' })).outcome, 'ok');
  });

  it('a staged delete failure leaves a finished journal for the next switch cleanup', async () => {
    const subject = await fixture();
    const entry = await install(subject);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    let failOnce = true;
    subject.deps.live.backend = wrappedBackend(subject.backend, {
      delete: async (service, account) => {
        if (service === entry.stagedBlobService && failOnce) {
          failOnce = false;
          throw new Error('staged delete failed');
        }
        await subject.backend.delete(service, account);
      },
    });
    await assert.rejects(reconcileClaudeSwitch(subject.deps), /staged delete failed/);
    const afterFailure = readClaudeSwitchJournal({ journalDir: subject.deps.journalDir, home: subject.home, env: subject.env, configPath: subject.paths.globalConfigPath, keychainService: subject.paths.keychainService });
    assert.equal(afterFailure.state, 'ok');
    if (afterFailure.state === 'ok') assert.equal(afterFailure.journal.closed, 'rolled-back');
    assert.equal(await readStagedRollback(subject.backend, entry.stagedBlobService), subject.outgoing);
    assert.equal((await switchClaude(subject.deps, { to: 'b', trigger: 'manual' })).outcome, 'ok');
    assert.equal(journalExists(subject), false);
    assert.equal(await readStagedRollback(subject.backend, entry.stagedBlobService), null);
    assert.equal(subject.rows.filter((row) => row.outcome === 'rolled-back').length, 1);
  });

  it('a journal delete failure leaves a finished journal for the next switch cleanup', async () => {
    const subject = await fixture();
    const entry = await install(subject);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    let failOnce = true;
    subject.deps.journalOps = {
      update: updateClaudeSwitchJournal,
      remove: (...args) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('journal delete failed');
        }
        deleteClaudeSwitchJournal(...args);
      },
    };
    await assert.rejects(reconcileClaudeSwitch(subject.deps), /journal delete failed/);
    const afterFailure = readClaudeSwitchJournal({ journalDir: subject.deps.journalDir, home: subject.home, env: subject.env, configPath: subject.paths.globalConfigPath, keychainService: subject.paths.keychainService });
    assert.equal(afterFailure.state, 'ok');
    if (afterFailure.state === 'ok') assert.equal(afterFailure.journal.closed, 'rolled-back');
    assert.equal(await readStagedRollback(subject.backend, entry.stagedBlobService), null);
    assert.equal((await switchClaude(subject.deps, { to: 'b', trigger: 'manual' })).outcome, 'ok');
    assert.equal(journalExists(subject), false);
    assert.equal(subject.rows.filter((row) => row.outcome === 'rolled-back').length, 1);
  });

  it('a C-swap process leaves live, config, journal, and staged state untouched without taking a lock', async () => {
    const subject = await fixture();
    const entry = await install(subject);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    subject.deps.cswapProcesses = () => [{ pid: 123 }];
    let locks = 0;
    subject.deps.locks = {
      switch: async () => { locks += 1; throw new Error('must not lock'); },
    };
    const before = {
      live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'),
      config: readFileSync(subject.paths.globalConfigPath, 'utf8'),
      journal: readFileSync(claudeSwitchJournalPath({ journalDir: subject.deps.journalDir }), 'utf8'),
      staged: await readStagedRollback(subject.backend, entry.stagedBlobService),
    };
    await reconcileClaudeSwitch(subject.deps);
    assert.deepEqual({
      live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'),
      config: readFileSync(subject.paths.globalConfigPath, 'utf8'),
      journal: readFileSync(claudeSwitchJournalPath({ journalDir: subject.deps.journalDir }), 'utf8'),
      staged: await readStagedRollback(subject.backend, entry.stagedBlobService),
    }, before);
    assert.equal(locks, 0);
    assert.deepEqual(subject.warnings, ['cswap-process-alive']);
  });

  it('a failed C-swap process check leaves live, config, journal, and staged state untouched without taking a lock', async () => {
    const subject = await fixture();
    const entry = await install(subject);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    subject.deps.cswapProcesses = () => { throw new Error('process table unavailable'); };
    let locks = 0;
    subject.deps.locks = {
      switch: async () => { locks += 1; throw new Error('must not lock'); },
    };
    const before = {
      live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'),
      config: readFileSync(subject.paths.globalConfigPath, 'utf8'),
      journal: readFileSync(claudeSwitchJournalPath({ journalDir: subject.deps.journalDir }), 'utf8'),
      staged: await readStagedRollback(subject.backend, entry.stagedBlobService),
    };
    await reconcileClaudeSwitch(subject.deps);
    assert.deepEqual({
      live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'),
      config: readFileSync(subject.paths.globalConfigPath, 'utf8'),
      journal: readFileSync(claudeSwitchJournalPath({ journalDir: subject.deps.journalDir }), 'utf8'),
      staged: await readStagedRollback(subject.backend, entry.stagedBlobService),
    }, before);
    assert.equal(locks, 0);
    assert.deepEqual(subject.warnings, ['cswap-process-check-failed']);
  });

  it('a C-swap process appearing under the owner lock leaves recovery untouched and switch refuses', async () => {
    const subject = await fixture();
    const entry = await install(subject);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    let checks = 0;
    subject.deps.cswapProcesses = () => {
      checks += 1;
      return checks === 1 ? [] : [{ pid: 123 }];
    };
    const before = {
      live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'),
      config: readFileSync(subject.paths.globalConfigPath, 'utf8'),
      journal: readFileSync(claudeSwitchJournalPath({ journalDir: subject.deps.journalDir }), 'utf8'),
      staged: await readStagedRollback(subject.backend, entry.stagedBlobService),
    };
    await reconcileClaudeSwitch(subject.deps);
    assert.deepEqual({
      live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'),
      config: readFileSync(subject.paths.globalConfigPath, 'utf8'),
      journal: readFileSync(claudeSwitchJournalPath({ journalDir: subject.deps.journalDir }), 'utf8'),
      staged: await readStagedRollback(subject.backend, entry.stagedBlobService),
    }, before);
    assert.equal(checks, 2);
    assert.deepEqual(subject.warnings, ['cswap-process-alive']);
    assert.equal((await switchClaude(subject.deps, { to: 'b', trigger: 'manual' })).outcome, 'refused');
  });

  it('a failed C-swap check under the owner lock leaves recovery untouched and switch refuses', async () => {
    const subject = await fixture();
    const entry = await install(subject);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    let checks = 0;
    subject.deps.cswapProcesses = () => {
      checks += 1;
      if (checks === 1) return [];
      throw new Error('process table unavailable');
    };
    const before = {
      live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'),
      config: readFileSync(subject.paths.globalConfigPath, 'utf8'),
      journal: readFileSync(claudeSwitchJournalPath({ journalDir: subject.deps.journalDir }), 'utf8'),
      staged: await readStagedRollback(subject.backend, entry.stagedBlobService),
    };
    await reconcileClaudeSwitch(subject.deps);
    assert.deepEqual({
      live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'),
      config: readFileSync(subject.paths.globalConfigPath, 'utf8'),
      journal: readFileSync(claudeSwitchJournalPath({ journalDir: subject.deps.journalDir }), 'utf8'),
      staged: await readStagedRollback(subject.backend, entry.stagedBlobService),
    }, before);
    assert.equal(checks, 2);
    assert.deepEqual(subject.warnings, ['cswap-process-check-failed']);
    assert.equal((await switchClaude(subject.deps, { to: 'b', trigger: 'manual' })).outcome, 'refused');
  });

  it('a crash before the live write needs no staged item', async () => {
    const subject = await fixture();
    await install(subject, journal(subject, { step: 6, stagedWritten: false, credentialsWriteStarted: false, credentialsWritten: false }));
    await reconcileClaudeSwitch(subject.deps);
    assert.equal(journalExists(subject), false);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.outgoing);
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), subject.configText);
    assert.equal(subject.rows[0]?.detail, 'crash-reconcile');
  });

  it('a crash between the SQLite commit and the journal marker is never rolled back', async () => {
    const subject = await fixture();
    const entry = await install(subject);
    subject.committed.add(entry.attemptId);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    const changedConfig = `${JSON.stringify({ oauthAccount: { accountUuid: 'b' }, retained: 'yes' })}\n`;
    writeFileSync(subject.paths.globalConfigPath, changedConfig);
    await reconcileClaudeSwitch(subject.deps);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.target);
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), changedConfig);
    assert.equal(journalExists(subject), true);
    assert.notEqual(await readStagedRollback(subject.backend, entry.stagedBlobService), null);
    assert.equal(subject.rows.length, 0);
  });

  it('live-moved keeps journal and staged item and writes nothing', async () => {
    const subject = await fixture();
    const entry = await install(subject);
    const moved = credential('moved');
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', moved);
    const beforeConfig = readFileSync(subject.paths.globalConfigPath, 'utf8');
    await reconcileClaudeSwitch(subject.deps);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), moved);
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), beforeConfig);
    assert.equal(journalExists(subject), true);
    assert.equal(await readStagedRollback(subject.backend, entry.stagedBlobService), subject.outgoing);
    assert.deepEqual(subject.warnings, ['reconcile-unresolved']);
    assert.equal(subject.rows.length, 0);
  });

  it('staged-unreadable keeps journal and staged item and writes nothing', async () => {
    const subject = await fixture();
    const entry = await install(subject, journal(subject, { stagedWritten: false }));
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    const beforeConfig = readFileSync(subject.paths.globalConfigPath, 'utf8');
    await reconcileClaudeSwitch(subject.deps);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.target);
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), beforeConfig);
    assert.equal(journalExists(subject), true);
    assert.equal(await readStagedRollback(subject.backend, entry.stagedBlobService), null);
    assert.deepEqual(subject.warnings, ['reconcile-unresolved']);
    assert.equal(subject.rows.length, 0);
  });

  it('a second run changes nothing', async () => {
    const subject = await fixture();
    await install(subject);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    await reconcileClaudeSwitch(subject.deps);
    const snapshot = JSON.stringify({ live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'), config: readFileSync(subject.paths.globalConfigPath, 'utf8'), rows: subject.rows, journal: journalExists(subject) });
    await reconcileClaudeSwitch(subject.deps);
    assert.equal(JSON.stringify({ live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'), config: readFileSync(subject.paths.globalConfigPath, 'utf8'), rows: subject.rows, journal: journalExists(subject) }), snapshot);
  });

  it('a live owner is left alone', async () => {
    const subject = await fixture();
    const entry = await install(subject);
    subject.deps.stillTheSameProcess = async () => true;
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    await reconcileClaudeSwitch(subject.deps);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.target);
    assert.equal(journalExists(subject), true);
    assert.equal(await readStagedRollback(subject.backend, entry.stagedBlobService), subject.outgoing);
    assert.equal(subject.rows.length, 0);
  });

  it('a malformed journal refuses', async () => {
    const subject = await fixture();
    mkdirSync(subject.deps.journalDir!, { recursive: true });
    writeFileSync(claudeSwitchJournalPath({ journalDir: subject.deps.journalDir }), '{not-json');
    await reconcileClaudeSwitch(subject.deps);
    const result = await switchClaude(subject.deps, { to: 'b', trigger: 'manual' });
    assert.equal(result.reason, 'switch-journal-malformed');
    assert.equal(journalExists(subject), true);
    assert.equal(subject.rows.at(-1)?.reason, 'switch-journal-malformed');
  });

  it('reconcile runs after admission', async () => {
    const subject = await fixture();
    await install(subject);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    const events: string[] = [];
    const command = createSwitchAnthropicCommand({
      openStore: () => ({ close: () => {} }) as never,
      bootstrap: async (hooks) => {
        events.push('bootstrap');
        await hooks?.assertAdmitted?.();
        events.push('admitted');
        await hooks?.reconcileJournals?.();
        events.push('reconciled');
      },
      assertAdmitted: () => { events.push('admission'); return { ok: true }; },
      makeSwitchDeps: async () => { events.push('make'); return subject.deps; },
      switchClaude: async () => { events.push('switch'); return { outcome: 'noop', from: 'a', to: 'b', attempt: 'next-switch', exitCode: 0 }; },
    });
    const ctx: CommandContext = {
      stdout: () => {}, stderr: () => {}, env: subject.env, home: subject.home, config: { dbPath: join(subject.root, 'unused.sqlite') },
      loadConfig: () => ({ dbPath: join(subject.root, 'unused.sqlite') }), registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    } as unknown as CommandContext;
    assert.equal(await command.execute!(['b'], ctx), 0);
    assert.deepEqual(events, ['bootstrap', 'admission', 'admitted', 'make', 'reconciled', 'switch']);
    assert.equal(journalExists(subject), false);
  });

  it('a committed switch is never rolled back', async () => {
    const subject = await fixture();
    const entry = await install(subject, journal(subject, { committed: NOW }));
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    await reconcileClaudeSwitch(subject.deps);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.target);
    assert.equal(journalExists(subject), true);
    assert.equal(await readStagedRollback(subject.backend, entry.stagedBlobService), subject.outgoing);
  });
});
