import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { credentialFingerprint } from '../src/anthropic-oauth';
import { InMemoryClaudeSlotRepository, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { withClaudeConfigPathLock, withClaudeCredentialLocks } from '../src/cc-locks';
import { claudePaths } from '../src/cc-paths';
import { macosKeychainAccountName, MockKeychain, platformKeychain, QLB_KEYCHAIN_ACCOUNT } from '../src/keychain';
import importCswapCommand from '../src/commands/import-cswap';
import { beginCutover } from '../src/lifecycle';
import { openStore } from '../src/store';
import type { CommandContext } from '../src/registry';
import {
  CswapImportCommitUnknown, CswapImportInjectedCrash, CswapImportRefusalError,
  importCswap, planCswapImport, recoverUncommittedCswapImport,
} from '../src/cswap-import';

function credential(id: string, refresh: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${id}`, refreshToken: refresh, expiresAt: 1_800_000_000_000, scopes: ['user:inference'], subscriptionType: 'max' } });
}

function fixture(): { root: string; backup: string; keychain: MockKeychain; repo: InMemoryClaudeSlotRepository } {
  const root = mkdtempSync(join(tmpdir(), 'qlb-cswap-import-'));
  const backup = join(root, '.claude-swap-backup');
  mkdirSync(join(backup, 'configs'), { recursive: true });
  mkdirSync(join(backup, 'credentials'), { recursive: true });
  const first = credential('account-a', 'refresh-a');
  const second = credential('account-b', 'refresh-b');
  writeFileSync(join(backup, 'sequence.json'), JSON.stringify({
    activeAccountNumber: 1,
    sequence: [1, 2],
    accounts: {
      1: { email: 'a@example.test', uuid: 'account-a', threshold: 80 },
      2: { email: 'b@example.test', uuid: 'account-b' },
    },
  }));
  writeFileSync(join(backup, 'configs', '.claude-config-1-a@example.test.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a' }, mcpServers: { fixture: { env: { TOKEN: 'fixture-token-shape' } } } }));
  writeFileSync(join(backup, 'configs', '.claude-config-2-b@example.test.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-b' } }));
  writeFileSync(join(backup, 'credentials', '.creds-1-a@example.test.enc'), Buffer.from(first).toString('base64'));
  const keychain = new MockKeychain();
  keychain.setSync('claude-swap', 'account-2-b@example.test', second);
  return { root, backup, keychain, repo: new InMemoryClaudeSlotRepository() };
}

describe('C-swap import (K10 / AC16)', () => {
  it('plans .enc-wins input without mutating a destination', async () => {
    const h = fixture();
    const plan = await planCswapImport({ backupDir: h.backup, keychain: h.keychain, repository: h.repo });
    assert.deepEqual(plan.slots.map((slot) => slot.backend), ['enc', 'keychain']);
    assert.equal(plan.encFiles, 1);
    assert.equal(plan.keychainItems, 1);
    assert.equal(plan.apiKeySlots, 0);
    assert.equal(plan.sessionProfiles, 0);
    assert.equal(h.repo.listSlots().length, 0);
    assert.ok(!JSON.stringify(await planCswapImport({ backupDir: h.backup, keychain: h.keychain, repository: h.repo })).includes('fixture-token-shape'));
  });

  it('stages, adopts an active live successor, promotes, and commits one destination record', async () => {
    const h = fixture();
    const live = credential('account-a', 'refresh-a-rotated');
    const result = await importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo,
      liveCredential: async () => live, liveAccountId: async () => 'account-a', now: () => 1_700_000_000_000, runId: 'fixture-run',
    });
    assert.equal(result.phase, 'cleaned');
    assert.equal(h.repo.listSlots().length, 2);
    assert.equal(h.repo.getSlot('account-a')?.fingerprint, credentialFingerprint(live));
    assert.equal(h.repo.getSlot('account-a')?.prevFingerprint, credentialFingerprint(credential('account-a', 'refresh-a')));
    assert.equal(await h.keychain.get('qlb:anthropic:account-a:prev', QLB_KEYCHAIN_ACCOUNT), credential('account-a', 'refresh-a'));
    assert.equal(h.repo.getImportRun('fixture-run')?.committedAt, 1_700_000_000_000);
  });

  it('commits import_runs, slots, accounts, active login, and lineage atomically in SQLite', async () => {
    const h = fixture();
    const dbPath = join(h.root, 'qlb.db');
    mkdirSync(join(h.backup, 'cache'), { recursive: true });
    writeFileSync(join(h.backup, 'settings.json'), JSON.stringify({ threshold: 80 }));
    writeFileSync(join(h.backup, 'cache', 'usage.json'), JSON.stringify({
      schemaVersion: 2,
      accounts: { 1: { fetchedAt: 1_700_000_000_000, lastGood: { fiveHour: { utilization: 80 } } } },
    }));
    const store = openStore(dbPath);
    store.close();
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    try {
      await importCswap({
        backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository,
        now: () => 1_700_000_000_000, runId: 'sqlite-run',
      });
      assert.equal(repository.getImportRun('sqlite-run')?.committedAt, 1_700_000_000_000);
      assert.equal(repository.listSlots().length, 2);
    } finally {
      repository.close();
    }
    const reopened = openStore(dbPath);
    try {
      assert.equal(reopened.listAccounts('anthropic').length, 2);
      assert.equal(reopened.listLineageTransitions('anthropic', 'account-a').length, 1);
      assert.equal(reopened.getSnapshot('account-a', 'five_hour')?.source, 'cswap-import');
      assert.equal(reopened.getConfig('autoswitch.threshold'), '80');
    } finally {
      reopened.close();
    }
  });

  it('requires --replace and a proven equal/ancestor destination lineage', async () => {
    const h = fixture();
    const plan = await planCswapImport({ backupDir: h.backup, keychain: h.keychain, repository: h.repo });
    const source = plan.slots[0];
    h.repo.createSlot({
      accountId: source.accountId, slotNum: source.slotNum, email: source.email, configJson: '{}',
      fingerprint: source.fingerprint, prevFingerprint: null, addedAt: 1, source: 'fixture',
    });
    await h.keychain.set('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT, credential('account-a', 'refresh-a'));
    await assert.rejects(importCswap({ backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo }), /non-empty/);
    await assert.doesNotReject(importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo,
      replace: true, runId: 'equal-replace',
    }));
  });

  it('refuses API-key and session-profile sources before staging', async () => {
    const h = fixture();
    writeFileSync(join(h.backup, 'credentials', '.creds-1-a@example.test.enc'), Buffer.from('sk-ant-fixture').toString('base64'));
    await assert.rejects(importCswap({ backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo }), /API-key/);
    assert.equal(h.repo.listSlots().length, 0);
    const sessions = fixture();
    mkdirSync(join(sessions.backup, 'sessions', 'present'), { recursive: true });
    await assert.rejects(importCswap({ backupDir: sessions.backup, journalDir: join(sessions.root, 'journals'), keychain: sessions.keychain, repository: sessions.repo }), /session profiles/);
  });

  it('cswap import refuses two slots on one refresh-token lineage', async () => {
    const h = fixture();
    // Slot 2 holds the same refresh token as slot 1 under a different account.
    h.keychain.setSync('claude-swap', 'account-2-b@example.test', credential('account-b', 'refresh-a'));
    for (const run of [
      () => planCswapImport({ backupDir: h.backup, keychain: h.keychain, repository: h.repo }),
      () => importCswap({ backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo }),
    ]) {
      await assert.rejects(run(), (error: unknown) => {
        assert.ok(error instanceof CswapImportRefusalError);
        assert.equal(error.code, 'duplicate-login');
        assert.doesNotMatch(error.message, /refresh-a/);
        return true;
      });
    }
    assert.equal(h.repo.listSlots().length, 0);
    await assert.rejects(h.keychain.get('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT), /item not found/);
    await assert.rejects(h.keychain.get('qlb:anthropic:account-b', QLB_KEYCHAIN_ACCOUNT), /item not found/);
  });

  it('cswap import refuses a live login that another slot already holds', async () => {
    const h = fixture();
    const backupFiles = () => ['sequence.json', 'configs/.claude-config-1-a@example.test.json',
      'configs/.claude-config-2-b@example.test.json', 'credentials/.creds-1-a@example.test.enc']
      .map((path) => readFileSync(join(h.backup, path), 'utf8'));
    const before = backupFiles();
    const sourceItem = await h.keychain.get('claude-swap', 'account-2-b@example.test');
    // The live credential for active slot 1 holds slot 2's refresh token.
    await assert.rejects(importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo, runId: 'live-duplicate',
      liveCredential: async () => credential('account-a', 'refresh-b'), liveAccountId: async () => 'account-a',
    }), (error: unknown) => {
      assert.ok(error instanceof CswapImportRefusalError);
      assert.equal(error.code, 'duplicate-login');
      assert.match(error.message, /slots 1 and 2/);
      assert.doesNotMatch(error.message, /refresh-|access-/);
      return true;
    });
    assert.equal(h.repo.listSlots().length, 0);
    assert.deepEqual(h.keychain.listServices().filter((name) => name.startsWith('qlb:')), []);
    assert.deepEqual(backupFiles(), before);
    assert.equal(await h.keychain.get('claude-swap', 'account-2-b@example.test'), sourceItem);
  });

  it('import cswap command names both slots of a duplicate login and exits 3', async () => {
    const h = fixture();
    const home = join(h.root, 'home');
    const env = { QLB_TEST_MODE: '1', QLB_HOME: join(h.root, 'qlb-home'), HOME: home, USER: macosKeychainAccountName() };
    writeFileSync(join(h.backup, 'credentials', '.creds-2-b@example.test.enc'), Buffer.from(credential('account-b', 'refresh-a')).toString('base64'));
    const dbPath = join(h.root, 'qlb.db');
    const store = openStore(dbPath);
    beginCutover(store);
    store.close();
    const stderr: string[] = [];
    const context: CommandContext = {
      stdout: () => {}, stderr: (line) => stderr.push(line), env,
      config: { dbPath, cswapSequencePath: join(h.backup, 'sequence.json') } as CommandContext['config'],
      loadConfig: () => { throw new Error('not used'); }, home,
      registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    };
    assert.equal(await importCswapCommand.execute!([], context), 3);
    assert.deepEqual(stderr, ['import cswap refused: duplicate-login (slots 1 and 2 hold the same login)']);
  });

  it('refuses malformed source credentials before any Keychain write', async () => {
    const h = fixture();
    writeFileSync(join(h.backup, 'credentials', '.creds-1-a@example.test.enc'), Buffer.from(JSON.stringify({ claudeAiOauth: { refreshToken: 7 } })).toString('base64'));
    await assert.rejects(importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo,
    }), /OAuth credential is invalid/);
    assert.equal(h.repo.listSlots().length, 0);
    await assert.rejects(h.keychain.get('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT), /item not found/);
  });

  it('rolls back a new destination when its first final write fails', async () => {
    const h = fixture();
    const backend = {
      get: h.keychain.get.bind(h.keychain),
      delete: h.keychain.delete.bind(h.keychain),
      set: async (service: string, account: string, value: string) => {
        if (service === 'qlb:anthropic:account-a') throw new Error('injected destination write failure');
        await h.keychain.set(service, account, value);
      },
    };
    await assert.rejects(importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: backend, repository: h.repo, runId: 'destination-failure',
    }), /destination write failure/);
    assert.equal(h.repo.listSlots().length, 0);
    await assert.rejects(h.keychain.get('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT), /item not found/);
    await assert.rejects(h.keychain.get('qlb:anthropic:account-b', QLB_KEYCHAIN_ACCOUNT), /item not found/);
    for (const service of [
      'qlb:anthropic:staging:destination-failure:account-a',
      'qlb:anthropic:import-prev:destination-failure:account-a',
      'qlb:anthropic:import-prev-prev:destination-failure:account-a',
    ]) await assert.rejects(h.keychain.get(service, QLB_KEYCHAIN_ACCOUNT), /item not found/);
  });

  it('records preimages before promotion and restores byte-exact --replace values when :prev fails', async () => {
    const h = fixture();
    const plan = await planCswapImport({ backupDir: h.backup, keychain: h.keychain, repository: h.repo });
    const source = plan.slots[0];
    const prior = credential('account-a', 'refresh-a');
    const priorPrevious = credential('account-a', 'prior-previous');
    h.repo.createSlot({ accountId: source.accountId, slotNum: source.slotNum, email: source.email, configJson: '{}', fingerprint: source.fingerprint, prevFingerprint: null, addedAt: 1, source: 'fixture' });
    await h.keychain.set('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT, prior);
    await h.keychain.set('qlb:anthropic:account-a:prev', QLB_KEYCHAIN_ACCOUNT, priorPrevious);
    let failed = false;
    const backend = {
      get: h.keychain.get.bind(h.keychain),
      delete: h.keychain.delete.bind(h.keychain),
      set: async (service: string, account: string, value: string) => {
        if (service === 'qlb:anthropic:account-a:prev' && !failed) {
          failed = true;
          throw new Error('injected prev write failure');
        }
        await h.keychain.set(service, account, value);
      },
    };
    await assert.rejects(importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: backend, repository: h.repo,
      replace: true, runId: 'prev-failure', liveCredential: async () => credential('account-a', 'live-successor'), liveAccountId: async () => 'account-a',
    }), /prev write failure/);
    assert.equal(await h.keychain.get('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT), prior);
    assert.equal(await h.keychain.get('qlb:anthropic:account-a:prev', QLB_KEYCHAIN_ACCOUNT), priorPrevious);
    const journal = JSON.parse(readFileSync(join(h.root, 'journals', 'cswap-import-prev-failure', 'journal.json'), 'utf8')) as { slots: Array<Record<string, unknown>> };
    assert.deepEqual(journal.slots[0].destinationExisted, true);
    assert.equal(journal.slots[0].prevSaved, true);
    assert.equal(journal.slots[0].previousSaved, true);
    assert.equal(journal.slots[0].reached, 'previous');
    assert.equal(journal.slots[0].promotedFingerprint, credentialFingerprint(credential('account-a', 'live-successor')));
    for (const service of [
      'qlb:anthropic:staging:prev-failure:account-a',
      'qlb:anthropic:import-prev:prev-failure:account-a',
      'qlb:anthropic:import-prev-prev:prev-failure:account-a',
    ]) await assert.rejects(h.keychain.get(service, QLB_KEYCHAIN_ACCOUNT), /item not found/);
  });

  it('recovers every crash point after a final write without touching unreached destinations', async () => {
    for (const crashAfter of [1, 2, 3]) {
      const h = fixture();
      const runId = `crash-${crashAfter}`;
      let writes = 0;
      const options = {
        backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo, runId,
        liveAccountId: async () => 'account-a', liveCredential: async () => credential('account-a', 'live-successor'),
        afterPromotionWrite: () => { if (++writes === crashAfter) throw new CswapImportInjectedCrash(); },
      };
      await assert.rejects(importCswap(options), CswapImportInjectedCrash);
      const before = JSON.parse(readFileSync(join(h.root, 'journals', `cswap-import-${runId}`, 'journal.json'), 'utf8')) as { phase: string; slots: Array<{ reached: string }> };
      assert.equal(before.phase, 'promoting');
      await assert.doesNotReject(recoverUncommittedCswapImport(options, runId));
      assert.equal(h.repo.listSlots().length, 0);
      await assert.rejects(h.keychain.get('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT), /item not found/);
      await assert.rejects(h.keychain.get('qlb:anthropic:account-b', QLB_KEYCHAIN_ACCOUNT), /item not found/);
      await assert.rejects(h.keychain.get('qlb:anthropic:account-a:prev', QLB_KEYCHAIN_ACCOUNT), /item not found/);
    }
  });

  it('keeps --replace backups when an in-process restore fails, then recovery restores byte-exact preimages', async () => {
    const h = fixture();
    const source = (await planCswapImport({ backupDir: h.backup, keychain: h.keychain, repository: h.repo })).slots[0];
    const prior = credential('account-a', 'refresh-a');
    const priorPrevious = credential('account-a', 'prior-previous');
    h.repo.createSlot({ accountId: source.accountId, slotNum: source.slotNum, email: source.email, configJson: '{}', fingerprint: source.fingerprint, prevFingerprint: null, addedAt: 1, source: 'fixture' });
    await h.keychain.set('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT, prior);
    await h.keychain.set('qlb:anthropic:account-a:prev', QLB_KEYCHAIN_ACCOUNT, priorPrevious);
    const originalCommit = h.repo.commitCswapImport.bind(h.repo);
    h.repo.commitCswapImport = () => { throw new Error('injected commit failure'); };
    let failRestore = true;
    const backend = {
      get: h.keychain.get.bind(h.keychain), delete: h.keychain.delete.bind(h.keychain),
      set: async (service: string, account: string, value: string) => {
        if (service === 'qlb:anthropic:account-a' && failRestore) {
          failRestore = false;
          await h.keychain.set(service, account, value);
          return;
        }
        if (service === 'qlb:anthropic:account-a' && !failRestore) {
          failRestore = true;
          throw new Error('injected restore failure');
        }
        await h.keychain.set(service, account, value);
      },
    };
    const options = {
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: backend, repository: h.repo, replace: true, runId: 'restore-failure',
      liveSnapshot: async () => ({ credential: credential('account-a', 'live-successor'), accountId: 'account-a' }),
    };
    await assert.rejects(importCswap(options), /recovery required/);
    assert.equal(await h.keychain.get('qlb:anthropic:import-prev:restore-failure:account-a', QLB_KEYCHAIN_ACCOUNT), prior);
    h.repo.commitCswapImport = originalCommit;
    await assert.equal(await recoverUncommittedCswapImport(options, 'restore-failure'), 'aborted');
    assert.equal(await h.keychain.get('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT), prior);
    assert.equal(await h.keychain.get('qlb:anthropic:account-a:prev', QLB_KEYCHAIN_ACCOUNT), priorPrevious);
    await assert.rejects(h.keychain.get('qlb:anthropic:import-prev:restore-failure:account-a', QLB_KEYCHAIN_ACCOUNT), /item not found/);
  });

  it('refuses a live snapshot that changes before commit and rolls back promotion', async () => {
    const h = fixture();
    let live = credential('account-a', 'live-one');
    await assert.rejects(importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo, runId: 'live-changed',
      liveSnapshot: async () => ({ credential: live, accountId: 'account-a' }),
      afterLiveSnapshot: () => { live = credential('account-a', 'live-two'); },
    }), (error: unknown) => error instanceof CswapImportRefusalError && error.code === 'live-changed');
    assert.equal(h.repo.listSlots().length, 0);
    await assert.rejects(h.keychain.get('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT), /item not found/);
  });

  it('a legacy .claude/.config.json appearing before the first snapshot is the file locked and read', async () => {
    const h = fixture();
    const home = join(h.root, 'home');
    const env = { QLB_TEST_MODE: '1', QLB_HOME: join(h.root, 'qlb-home'), HOME: home, USER: macosKeychainAccountName() };
    const paths = claudePaths({ home, env });
    mkdirSync(paths.configHome, { recursive: true });
    writeFileSync(paths.globalConfigPath, JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }));
    writeFileSync(join(h.backup, 'sequence.json'), JSON.stringify({
      activeAccountNumber: 2,
      sequence: [1, 2],
      accounts: {
        1: { email: 'a@example.test', uuid: 'account-a', threshold: 80 },
        2: { email: 'b@example.test', uuid: 'account-b' },
      },
    }));
    writeFileSync(join(h.backup, 'credentials', '.creds-2-b@example.test.enc'), Buffer.from(credential('account-b', 'refresh-b')).toString('base64'));
    await platformKeychain.set(paths.keychainService, env.USER, credential('account-b', 'live-successor'));
    const dbPath = join(h.root, 'qlb.db');
    const store = openStore(dbPath);
    beginCutover(store);
    store.close();
    const output: string[] = [];
    const context: CommandContext = {
      stdout: (line) => output.push(line), stderr: (line) => output.push(`ERR:${line}`), env,
      config: { dbPath, cswapSequencePath: join(h.backup, 'sequence.json') } as CommandContext['config'],
      loadConfig: () => { throw new Error('not used'); }, home,
      registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    };
    const legacyPath = join(paths.configHome, '.config.json');
    const originalGet = platformKeychain.get;
    let legacyAppeared = false;
    platformKeychain.get = async (service, account) => {
      if (service === paths.keychainService) {
        assert.equal(legacyAppeared, true, 'the legacy config appears before the first snapshot');
        assert.equal(existsSync(`${legacyPath}.lock`), true, 'the legacy config is locked');
        assert.equal(existsSync(`${paths.globalConfigPath}.lock`), false, 'the stale global config is not locked');
      }
      return originalGet(service, account);
    };
    try {
      const execution = importCswapCommand.execute!([], context);
      queueMicrotask(() => {
        legacyAppeared = true;
        writeFileSync(legacyPath, JSON.stringify({ oauthAccount: { accountUuid: 'account-b' } }));
      });
      assert.equal(await execution, 0, output.join('\n'));
    } finally {
      platformKeychain.get = originalGet;
    }
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    try {
      assert.equal(repository.getSlot('account-b')?.fingerprint, credentialFingerprint(credential('account-b', 'live-successor')));
    } finally {
      repository.close();
    }
  });

  it('holds the live-state locks from the final re-check through the SQLite commit', async () => {
    const h = fixture();
    const home = join(h.root, 'home');
    const env = { QLB_TEST_MODE: '1', QLB_HOME: join(h.root, 'qlb-home'), HOME: home };
    const paths = claudePaths({ home, env });
    mkdirSync(paths.configHome, { recursive: true });
    writeFileSync(paths.globalConfigPath, JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }));
    const withLiveStateLocks = <T>(fn: () => Promise<T> | T) => withClaudeCredentialLocks({ home, env }, () =>
      withClaudeConfigPathLock(paths.globalConfigPath, { home, env }, fn));
    let liveAccount = 'account-a';
    let nativeFinished = false;
    let nativeSwitch: Promise<void> | undefined;
    const originalCommit = h.repo.commitCswapImport.bind(h.repo);
    h.repo.commitCswapImport = (input) => {
      assert.equal(liveAccount, 'account-a', 'the live account remains unchanged at commit time');
      assert.equal(input.activeAccountId, liveAccount, 'the committed active login matches the live account at commit time');
      assert.equal(nativeFinished, false, 'a native switch is still blocked by the held locks');
      originalCommit(input);
    };
    await assert.doesNotReject(importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo,
      runId: 'commit-under-live-locks', withLiveStateLocks,
      liveSnapshot: async () => ({ credential: credential('account-a', 'live-successor'), accountId: liveAccount }),
      afterLiveRecheck: () => {
        nativeSwitch = withLiveStateLocks(async () => {
          liveAccount = 'account-b';
          nativeFinished = true;
        });
      },
    }));
    assert.ok(nativeSwitch, 'the simulated native switch was started');
    await nativeSwitch;
    assert.equal(nativeFinished, true, 'the native switch completes after the SQLite commit');
  });

  it('fails closed on unreadable commit authority, then recovery resolves both committed and absent runs', async () => {
    for (const committed of [true, false]) {
      const h = fixture();
      const originalCommit = h.repo.commitCswapImport.bind(h.repo);
      const originalGet = h.repo.getImportRun.bind(h.repo);
      if (!committed) h.repo.commitCswapImport = () => { throw new Error('injected commit failure'); };
      h.repo.getImportRun = () => { throw new Error('injected authority read failure'); };
      const backend = {
        get: h.keychain.get.bind(h.keychain), set: h.keychain.set.bind(h.keychain),
        delete: async (service: string, account: string) => {
          if (service.includes(':staging:')) throw new Error('injected cleanup failure');
          await h.keychain.delete(service, account);
        },
      };
      const runId = `commit-unknown-${committed}`;
      const options = { backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: backend, repository: h.repo, runId };
      await assert.rejects(importCswap(options), CswapImportCommitUnknown);
      const journal = JSON.parse(readFileSync(join(h.root, 'journals', `cswap-import-${runId}`, 'journal.json'), 'utf8')) as { phase: string };
      assert.equal(journal.phase, 'commit-unknown');
      assert.ok(committed ? await h.keychain.get('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT) : await h.keychain.get('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT));
      h.repo.commitCswapImport = originalCommit;
      h.repo.getImportRun = originalGet;
      const resolutionBackend = { get: h.keychain.get.bind(h.keychain), set: h.keychain.set.bind(h.keychain), delete: h.keychain.delete.bind(h.keychain) };
      assert.equal(await recoverUncommittedCswapImport({ ...options, keychain: resolutionBackend }, runId), committed ? 'cleaned' : 'aborted');
      if (committed) assert.equal(h.repo.listSlots().length, 2);
      else {
        assert.equal(h.repo.listSlots().length, 0);
        await assert.rejects(h.keychain.get('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT), /item not found/);
      }
    }
  });

  it('serializes recovery with imports in both directions', async () => {
    const h = fixture();
    const runId = 'recovery-lock';
    await assert.rejects(importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo, runId,
      afterPromotionWrite: () => { throw new CswapImportInjectedCrash(); },
    }), CswapImportInjectedCrash);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredRecovery = new Promise<void>((resolve) => { entered = resolve; });
    const recovery = recoverUncommittedCswapImport({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo,
      beforeRecovery: async () => { entered(); await held; },
    }, runId);
    await enteredRecovery;
    await assert.rejects(importCswap({ backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo }),
      (error: unknown) => error instanceof CswapImportRefusalError && error.code === 'import-in-progress');
    release();
    await recovery;
  });

  it('refuses a second process-wide import while a first import holds the lock', async () => {
    const h = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredLiveRead = new Promise<void>((resolve) => { entered = resolve; });
    const first = importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo,
      liveAccountId: async () => 'account-a',
      liveCredential: async () => { entered(); await held; return credential('account-a', 'live-successor'); },
    });
    await enteredLiveRead;
    await assert.rejects(importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo,
    }), (error: unknown) => (error as { code?: string }).code === 'import-in-progress');
    await assert.rejects(recoverUncommittedCswapImport({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo,
    }, 'no-journal-needed-while-locked'), (error: unknown) => (error as { code?: string }).code === 'import-in-progress');
    release();
    await first;
  });
});
