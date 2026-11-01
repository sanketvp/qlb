import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { claudePaths } from '../src/cc-paths';
import { atomicWriteText } from '../src/fsutil';
import { withClaudeConfigPathLock, withClaudeCredentialLocks } from '../src/cc-locks';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import { deleteClaudeSwitchJournal, readClaudeSwitchJournal, readStagedRollback, updateClaudeSwitchJournal, withClaudeSwitchJournalOwner, type ClaudeSwitchJournal } from '../src/cc-switch-journal';
import { MockKeychain } from '../src/keychain';
import {
  restoreConfigFromJournal,
  restoreLiveFromStaged,
  switchClaude,
  type ClaudeSwitchDeps,
} from '../src/cc-switch';

const NOW = 1_000_000;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const credential = (tag: string) => JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${tag}`, refreshToken: `fixture-refresh-${tag}`, expiresAt: NOW + 3_600_000 } });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-rollback-'));
  const home = join(root, 'home');
  const env = { QLB_TEST_MODE: '1', HOME: home };
  const paths = claudePaths({ home, env });
  mkdirSync(paths.configHome, { recursive: true });
  const backend = new MockKeychain();
  const slots = new ClaudeSlots({ backend, repository: new InMemoryClaudeSlotRepository(), stashDir: join(root, 'unclaimed'), now: () => NOW });
  const outgoing = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-a', refreshToken: 'fixture-refresh-a', expiresAt: NOW + 3_600_000 }, mcpOAuth: { machine: 'kept' } });
  const target = credential('b');
  await slots.createSlot({ accountId: 'a', credential: outgoing, email: 'a@example.test', orgUuid: 'org-a', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'a' } }), source: 'cswap-import' });
  await slots.createSlot({ accountId: 'b', credential: target, email: 'b@example.test', orgUuid: 'org-b', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'b' } }), source: 'cswap-import' });
  await backend.set(paths.keychainService, 'fixture-user', outgoing);
  const configText = `${JSON.stringify({ oauthAccount: { accountUuid: 'a' }, retained: 'yes' })}\n`;
  writeFileSync(paths.globalConfigPath, configText);
  let active = 'a';
  const rows: Record<string, unknown>[] = [];
  const deps: ClaudeSwitchDeps = {
    store: {
      getActiveLogin: () => ({ provider: 'anthropic', accountId: active, since: NOW, setBy: 'manual' }),
      getConfig: () => null,
      recordSwitch: (row: Record<string, unknown>) => { rows.push(row); return rows.length; },
      recordRelogin: () => 1,
      recordClaudeSwitchRefusal: (row: Record<string, unknown>) => { rows.push(row); return rows.length; },
      findClaudeSwitchByAttempt: () => null,
      commitClaudeSwitch: (row: { toAccount: string; beforeCommit?: () => void }) => { row.beforeCommit?.(); active = row.toAccount; return 12; },
    } as unknown as ClaudeSwitchDeps['store'],
    slots,
    live: { backend, paths, account: 'fixture-user' },
    readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
    resolveProfile: async () => null,
    consume: { postRefresh: async () => ({ status: 500, body: '' }), withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn() },
    env, home, now: () => NOW, by: 'qlb-cli', attempt: 'rollback-attempt', journalDir: join(root, 'journal'), journalOwner: { pid: process.pid, lstart: 'fixture' },
  };
  return { root, home, env, paths, backend, slots, outgoing, target, configText, deps, rows, active: () => active };
}

function journal(subject: Awaited<ReturnType<typeof fixture>>, patch: Partial<ClaudeSwitchJournal> = {}): ClaudeSwitchJournal {
  return {
    v: 1, provider: 'anthropic', attemptId: 'recovery-attempt', from: 'a', to: 'b', trigger: 'manual', by: 'qlb-cli', republish: false, injected: false, detail: null,
    decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null }, outgoingKind: 'own-bytes', bindingJson: null, step: 8,
    stagedBlobService: 'qlb:anthropic:staged-rollback:recovery', stagedAccount: 'qlb', stagedWritten: true, keychainService: subject.paths.keychainService,
    configPath: subject.paths.globalConfigPath, configText: subject.configText, configWrittenHash: null, fromOauthAccount: { accountUuid: 'a' },
    credentialsWrittenHash: digest(subject.target), credentialsWriteStarted: true, credentialsWritten: true, configWriteStarted: true, configWritten: true,
    closed: null, startedAt: NOW, owner: { pid: process.pid, lstart: 'fixture' }, ...patch,
  };
}

const manual = { to: 'b', trigger: 'manual' };

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

describe('Claude switch rollback (K8-2)', () => {
  it('X18 contract fixture: injected step-8 restores live and config byte-for-byte, leaves active unchanged, and closes the journal', async () => {
    const subject = await fixture();
    subject.deps.injectFailStep = 8;
    const beforeInode = readFileSync(subject.paths.globalConfigPath, 'utf8');
    const result = await switchClaude(subject.deps, { ...manual, injected: true });
    assert.equal(result.outcome, 'rolled-back');
    assert.equal(result.error, 'injected');
    assert.equal(result.reason, 'fault-injection:fail-step-8');
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.outgoing);
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), beforeInode);
    assert.equal(subject.active(), 'a');
    assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), false);
    assert.deepEqual((subject.rows.at(-1) as { outcome: string; detail: string; injected: boolean }).outcome, 'rolled-back');
    assert.equal((subject.rows.at(-1) as { detail: string }).detail, 'fault-injection:fail-step-8');
  });

  it('X19 injects step 9 through beforeCommit, restores both effects, and writes no ok row', async () => {
    const subject = await fixture();
    subject.deps.injectFailStep = 9;
    const result = await switchClaude(subject.deps, { ...manual, injected: true });
    assert.equal(result.outcome, 'rolled-back');
    assert.equal(result.steps?.failedStep, 9);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.outgoing);
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), subject.configText);
    assert.equal(subject.rows.filter((row) => row.outcome === 'ok').length, 0);
  });

  it('X16 distinguishes a step-7 write that did not land from one that landed', async () => {
    const notLanded = await fixture();
    notLanded.deps.live.backend = wrappedBackend(notLanded.backend, { set: async (service: string, account: string, value: string) => {
      if (service === notLanded.paths.keychainService && value !== notLanded.outgoing) throw new Error('keychain write failed');
      return notLanded.backend.set(service, account, value);
    } });
    const first = await switchClaude(notLanded.deps, manual);
    assert.equal(first.outcome, 'rolled-back');
    assert.deepEqual(first.steps?.notLanded, [7]);

    const landed = await fixture();
    let writes = 0;
    landed.deps.live.backend = wrappedBackend(landed.backend, { set: async (service: string, account: string, value: string) => {
      writes += 1; await landed.backend.set(service, account, value);
      if (service === landed.paths.keychainService && value !== landed.outgoing && writes > 1) throw new Error('keychain write failed');
    } });
    const second = await switchClaude(landed.deps, manual);
    assert.equal(second.outcome, 'rolled-back');
    assert.equal(await landed.backend.get(landed.paths.keychainService, 'fixture-user'), landed.outgoing);
  });

  it('X17b re-splices the step-8 oauthAccount into a post-write config edit', async () => {
    const subject = await fixture();
    subject.deps.injectFailStep = 9;
    subject.deps.hooks = { afterStep8: () => writeFileSync(subject.paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'b' }, retained: 'new-edit' })}\n`) };
    const result = await switchClaude(subject.deps, { ...manual, injected: true });
    assert.equal(result.outcome, 'rolled-back');
    assert.ok(result.steps?.reversed.includes('config:resplice'));
    assert.deepEqual(JSON.parse(readFileSync(subject.paths.globalConfigPath, 'utf8')), { oauthAccount: { accountUuid: 'a' }, retained: 'new-edit' });
  });

  it('restoreConfigFromJournal returns not-landed, restored, or resplice and preserves post-write edits', async () => {
    const subject = await fixture();
    const planned = `${JSON.stringify({ oauthAccount: { accountUuid: 'b' }, retained: 'yes' }, null, 2)}\n`;
    const base = journal(subject, { configWrittenHash: digest(planned) });
    const underLock = async () => withClaudeConfigPathLock(subject.paths.globalConfigPath, { env: subject.env }, (held) => restoreConfigFromJournal(subject.deps, base, held));
    assert.equal(await underLock(), 'not-landed');
    writeFileSync(subject.paths.globalConfigPath, planned);
    assert.equal(await underLock(), 'restored');
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), subject.configText);
    writeFileSync(subject.paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'b' }, retained: 'changed' })}\n`);
    assert.equal(await underLock(), 'resplice');
    assert.deepEqual(JSON.parse(readFileSync(subject.paths.globalConfigPath, 'utf8')).oauthAccount, { accountUuid: 'a' });
  });

  it('X17d removes a null prior oauthAccount, and step-6/7 journals do not read or alter config', async () => {
    const subject = await fixture();
    const nullPrior = journal(subject, { fromOauthAccount: null, configWrittenHash: 'different' });
    writeFileSync(subject.paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'b' }, retained: 'changed' })}\n`);
    const removed = await withClaudeConfigPathLock(subject.paths.globalConfigPath, { env: subject.env }, (held) => restoreConfigFromJournal(subject.deps, nullPrior, held));
    assert.equal(removed, 'resplice');
    assert.equal('oauthAccount' in JSON.parse(readFileSync(subject.paths.globalConfigPath, 'utf8')), false);
    const untouched = readFileSync(subject.paths.globalConfigPath, 'utf8');
    const noConfigWrite = journal(subject, { step: 7, configWriteStarted: false, configText: null });
    const result = await withClaudeConfigPathLock(subject.paths.globalConfigPath, { env: subject.env }, (held) => restoreConfigFromJournal(subject.deps, noConfigWrite, held));
    assert.equal(result, 'not-landed');
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), untouched);
  });

  it('restoreLiveFromStaged returns all recovery outcomes and never overwrites moved or unreadable live bytes', async () => {
    const subject = await fixture();
    const j = journal(subject);
    await subject.backend.set(j.stagedBlobService, 'qlb', subject.outgoing);
    const underLocks = (fn: Parameters<typeof withClaudeCredentialLocks>[1]) => withClaudeCredentialLocks({ configDir: subject.paths.configHome, env: subject.env }, fn);
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', credential('rotated'));
    assert.equal(await underLocks((held) => restoreLiveFromStaged(subject.deps, j, held)), 'live-moved');
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.outgoing);
    assert.equal(await underLocks((held) => restoreLiveFromStaged(subject.deps, j, held)), 'not-landed');
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', subject.target);
    assert.equal(await underLocks((held) => restoreLiveFromStaged(subject.deps, j, held)), 'restored');
    await subject.backend.delete(j.stagedBlobService, 'qlb');
    assert.equal(await underLocks((held) => restoreLiveFromStaged(subject.deps, j, held)), 'staged-unreadable');
  });

  it('rollback never reads the staged item and keeps a step-5 own-family adoption', async () => {
    const subject = await fixture();
    const family = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-rotated', refreshToken: 'fixture-refresh-a', expiresAt: NOW + 3_600_000 }, mcpOAuth: { machine: 'kept' } });
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', family);
    const stagedReads: string[] = [];
    subject.deps.live.backend = wrappedBackend(subject.backend, { get: async (service: string, account: string) => {
      stagedReads.push(service);
      return subject.backend.get(service, account);
    } });
    subject.deps.injectFailStep = 8;
    const result = await switchClaude(subject.deps, { ...manual, injected: true });
    assert.equal(result.outcome, 'rolled-back');
    assert.equal(stagedReads.some((service) => service.startsWith('qlb:anthropic:staged-rollback:')), false);
    assert.equal(await subject.slots.readSlot('a', { fresh: true }).then((slot) => slot.credential), family);
  });

  it('a restore failure records restoreFailures and keeps the unfinished journal and staged copy for K14', async () => {
    const subject = await fixture();
    subject.deps.injectFailStep = 8;
    subject.deps.live.backend = wrappedBackend(subject.backend, { set: async (service: string, account: string, value: string) => {
      if (service === subject.paths.keychainService && value === subject.outgoing) throw new Error('keychain restore failed');
      return subject.backend.set(service, account, value);
    } });
    const result = await switchClaude(subject.deps, { ...manual, injected: true });
    assert.equal(result.outcome, 'rolled-back');
    assert.deepEqual(result.steps?.restoreFailures, ['credentials']);
    const read = readClaudeSwitchJournal({ journalDir: subject.deps.journalDir, home: subject.home, env: subject.env, configPath: subject.paths.globalConfigPath, keychainService: subject.paths.keychainService });
    assert.equal(read.state, 'ok');
    if (read.state === 'ok') {
      assert.equal(read.journal.closed, null);
      assert.notEqual(await readStagedRollback(subject.backend, read.journal.stagedBlobService), null);
    }
  });

  it('a rollback whose staged delete fails keeps a journal marked closed rolled-back and the next switch finishes it', async () => {
    const subject = await fixture();
    subject.deps.injectFailStep = 8;
    let deletes = 0;
    subject.deps.live.backend = wrappedBackend(subject.backend, { delete: async (service: string, account: string) => {
      if (service.startsWith('qlb:anthropic:staged-rollback:') && deletes++ === 0) throw new Error('keychain delete failed');
      return subject.backend.delete(service, account);
    } });
    const result = await switchClaude(subject.deps, { ...manual, injected: true });
    assert.equal(result.outcome, 'rolled-back');
    assert.ok(result.steps?.cleanup.length);
    const read = readClaudeSwitchJournal({ journalDir: subject.deps.journalDir, home: subject.home, env: subject.env, configPath: subject.paths.globalConfigPath, keychainService: subject.paths.keychainService });
    assert.equal(read.state, 'ok');
    if (read.state === 'ok') {
      assert.equal(read.journal.closed, 'rolled-back');
      assert.notEqual(await readStagedRollback(subject.backend, read.journal.stagedBlobService), null);
    }
    subject.deps.injectFailStep = undefined;
    const next = await switchClaude(subject.deps, manual);
    assert.equal(next.outcome, 'ok');
    assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), false);
  });

  it('a failing step 8 whose rename landed restores config by rename and the live item, and records rolled-back; a failing step 8 whose rename did not land restores only the live item', async () => {
    const notLanded = await fixture();
    notLanded.deps.live.writeText = () => { throw new Error('rename denied'); };
    const first = await switchClaude(notLanded.deps, manual);
    assert.equal(first.error, 'config-write-failed');
    assert.deepEqual(first.steps?.notLanded, ['config']);
    assert.equal(readFileSync(notLanded.paths.globalConfigPath, 'utf8'), notLanded.configText);
    assert.equal(await notLanded.backend.get(notLanded.paths.keychainService, 'fixture-user'), notLanded.outgoing);

    const landed = await fixture();
    let writes = 0;
    let landedInode = 0;
    landed.deps.live.writeText = (path, text) => {
      atomicWriteText(path, text, { mode: 0o600 });
      if (writes++ === 0) {
        landedInode = statSync(path).ino;
        throw new Error('rename denied after landing');
      }
    };
    const second = await switchClaude(landed.deps, manual);
    assert.equal(second.error, 'config-write-failed');
    assert.ok(second.steps?.reversed.includes('config'));
    assert.equal(readFileSync(landed.paths.globalConfigPath, 'utf8'), landed.configText);
    assert.notEqual(statSync(landed.paths.globalConfigPath).ino, landedInode);
    assert.equal(await landed.backend.get(landed.paths.keychainService, 'fixture-user'), landed.outgoing);
  });

  it('X17c: a step-8 write that lands followed by a failing configWritten update is restored byte-for-byte by rename (inode changed), reversed lists config, not config:resplice', async () => {
    const subject = await fixture();
    let updates = 0;
    subject.deps.journalOps = {
      update: (...args) => {
        updates += 1;
        if (updates === 5) throw new Error('journal update failed');
        return updateClaudeSwitchJournal(...args);
      },
      remove: deleteClaudeSwitchJournal,
    };
    const inode = statSync(subject.paths.globalConfigPath).ino;
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.outcome, 'rolled-back');
    assert.equal(result.error, 'journal-io-failed');
    assert.ok(result.steps?.reversed.includes('config'));
    assert.equal(result.steps?.reversed.includes('config:resplice'), false);
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), subject.configText);
    assert.notEqual(statSync(subject.paths.globalConfigPath).ino, inode);
  });

  it('X17d: fromOauthAccount in the journal equals the oauthAccount of the text read under the step-8 lock, not the Phase-A text', async () => {
    const subject = await fixture();
    subject.deps.injectFailStep = 9;
    subject.deps.hooks = {
      afterStep4: () => writeFileSync(subject.paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'step-8' }, retained: 'before-step-8' })}\n`),
      afterStep8: () => writeFileSync(subject.paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'b' }, retained: 'post-step-8' })}\n`),
    };
    const result = await switchClaude(subject.deps, { ...manual, injected: true });
    assert.equal(result.outcome, 'rolled-back');
    assert.deepEqual(JSON.parse(readFileSync(subject.paths.globalConfigPath, 'utf8')), { oauthAccount: { accountUuid: 'step-8' }, retained: 'post-step-8' });
  });

  it('after a failed restore the next switch refuses switch-journal-present and the staged item survives (the rolled-back row does not finish the journal)', async () => {
    const subject = await fixture();
    subject.deps.injectFailStep = 8;
    subject.deps.live.backend = wrappedBackend(subject.backend, { set: async (service, account, value) => {
      if (service === subject.paths.keychainService && value === subject.outgoing) throw new Error('restore failed');
      return subject.backend.set(service, account, value);
    } });
    await switchClaude(subject.deps, { ...manual, injected: true });
    const next = await switchClaude(subject.deps, manual);
    assert.equal(next.outcome, 'refused');
    assert.equal(next.reason, 'switch-journal-present');
    const read = readClaudeSwitchJournal({ journalDir: subject.deps.journalDir, home: subject.home, env: subject.env, configPath: subject.paths.globalConfigPath, keychainService: subject.paths.keychainService });
    assert.equal(read.state, 'ok');
    if (read.state === 'ok') assert.notEqual(await readStagedRollback(subject.backend, read.journal.stagedBlobService), null);
  });

  it('an empty or absent live item under restoreLiveFromStaged is live-moved, not restored', async () => {
    const subject = await fixture();
    const j = journal(subject);
    await subject.backend.set(j.stagedBlobService, 'qlb', subject.outgoing);
    let writes = 0;
    subject.deps.live.backend = wrappedBackend(subject.backend, { set: async (service, account, value) => {
      if (service === subject.paths.keychainService) writes += 1;
      return subject.backend.set(service, account, value);
    } });
    const underLocks = (fn: Parameters<typeof withClaudeCredentialLocks>[1]) => withClaudeCredentialLocks({ configDir: subject.paths.configHome, env: subject.env }, fn);
    await subject.backend.delete(subject.paths.keychainService, 'fixture-user');
    assert.equal(await underLocks((held) => restoreLiveFromStaged(subject.deps, j, held)), 'live-moved');
    assert.equal(writes, 0);
  });

  it('a journal re-read failure during rollback restores live from in-memory write intent', async () => {
    const subject = await fixture();
    subject.deps.journalOps = {
      read: () => ({ state: 'malformed' }),
      update: updateClaudeSwitchJournal,
      remove: deleteClaudeSwitchJournal,
    };
    subject.deps.injectFailStep = 7;
    const result = await switchClaude(subject.deps, { ...manual, injected: true });
    assert.equal(result.outcome, 'rolled-back');
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.outgoing);
    assert.equal(result.steps?.restoreFailures.length, 0);
  });

  it('rollback holds the config lock only for the config re-read and restore, inside the owner lock (lock-order spy)', async () => {
    const subject = await fixture();
    subject.deps.injectFailStep = 9;
    const events: string[] = [];
    let ownerHeld = false;
    subject.deps.locks = {
      owner: (async (options: Parameters<typeof withClaudeSwitchJournalOwner>[0], fn: (held: unknown) => Promise<unknown>) => {
        events.push('owner:start'); ownerHeld = true;
        try { return await withClaudeSwitchJournalOwner(options, async (held) => fn(held)); }
        finally { ownerHeld = false; events.push('owner:end'); }
      }) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['owner'],
      configPath: (async (path: string, options: { env?: NodeJS.ProcessEnv }, fn: (held: unknown) => Promise<unknown>) => {
        assert.equal(ownerHeld, true);
        events.push('config:start');
        try { return await withClaudeConfigPathLock(path, options, async (held) => fn(held)); }
        finally { events.push('config:end'); }
      }) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['configPath'],
    };
    const result = await switchClaude(subject.deps, { ...manual, injected: true });
    assert.equal(result.outcome, 'rolled-back');
    assert.deepEqual(events, ['owner:start', 'config:start', 'config:end', 'config:start', 'config:end', 'owner:end']);
  });

  it('a rolled-back row carries error, stepsJson with attempt, failedStep, started, reversed, notLanded and restoreFailures, and no token value', async () => {
    const subject = await fixture();
    subject.deps.injectFailStep = 8;
    await switchClaude(subject.deps, { ...manual, injected: true });
    const row = subject.rows.at(-1) as { error: string; stepsJson: string };
    assert.equal(row.error, 'injected');
    const serialized = JSON.stringify(row);
    for (const value of ['fixture-access-a', 'fixture-refresh-a', 'fixture-access-b', 'fixture-refresh-b']) assert.equal(serialized.includes(value), false);
    assert.deepEqual(Object.keys(JSON.parse(row.stepsJson)).sort(), ['attempt', 'cleanup', 'failedStep', 'notLanded', 'restoreFailures', 'reversed', 'started']);
  });
});
