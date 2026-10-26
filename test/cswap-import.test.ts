import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { credentialFingerprint } from '../src/anthropic-oauth';
import { InMemoryClaudeSlotRepository, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT } from '../src/keychain';
import { openStore } from '../src/store';
import { importCswap, planCswapImport } from '../src/cswap-import';

function credential(id: string, refresh: string): string {
  return JSON.stringify({ claudeAiOauth: { accountUuid: id, accessToken: `access-${id}`, refreshToken: refresh } });
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
  writeFileSync(join(backup, 'configs', '.claude-config-1-a@example.test.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }));
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
  });

  it('stages, adopts an active live successor, promotes, and commits one destination record', async () => {
    const h = fixture();
    const live = credential('account-a', 'refresh-a-rotated');
    const result = await importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo,
      liveCredential: async () => live, now: () => 1_700_000_000_000, runId: 'fixture-run',
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
      accountId: source.accountId, slotNum: source.slotNum, email: source.email, configJson: source.configJson,
      fingerprint: source.fingerprint, prevFingerprint: null, addedAt: 1, source: 'fixture',
    });
    await h.keychain.set('qlb:anthropic:account-a', QLB_KEYCHAIN_ACCOUNT, credential('account-a', 'refresh-a'));
    await assert.rejects(importCswap({ backupDir: h.backup, keychain: h.keychain, repository: h.repo }), /non-empty/);
    await assert.doesNotReject(importCswap({
      backupDir: h.backup, journalDir: join(h.root, 'journals'), keychain: h.keychain, repository: h.repo,
      replace: true, runId: 'equal-replace',
    }));
  });

  it('refuses API-key and session-profile sources before staging', async () => {
    const h = fixture();
    writeFileSync(join(h.backup, 'credentials', '.creds-1-a@example.test.enc'), Buffer.from('sk-ant-fixture').toString('base64'));
    await assert.rejects(importCswap({ backupDir: h.backup, keychain: h.keychain, repository: h.repo }), /API-key/);
    assert.equal(h.repo.listSlots().length, 0);
    const sessions = fixture();
    mkdirSync(join(sessions.backup, 'sessions', 'present'), { recursive: true });
    await assert.rejects(importCswap({ backupDir: sessions.backup, keychain: sessions.keychain, repository: sessions.repo }), /session profiles/);
  });
});
