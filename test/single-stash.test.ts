import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  adoptStashedSuccessor,
  persistStash,
  type OAuthCredential,
} from '../src/single-stash';
import { consumeSingleCredential, createInMemorySingleConsumeLock } from '../src/single-consume';
import { ADAPTER_ACCOUNT_IDS } from '../src/migration';
import { sharedSingleGrantCoords } from '../src/single-grant-ownership';
import { Store } from '../src/store';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { listStashes, recordStash, removeStash } from '../src/unclaimed-index';

const NOW = 1_730_000_000_000;

function credential(access: string, refresh: string, expires = NOW + 30_000): OAuthCredential {
  return { type: 'oauth', access, refresh, expires };
}

function lineage(refresh: string): string {
  return `sha256:${createHash('sha256').update(refresh, 'utf8').digest('hex')}`;
}

function root(home: string): string {
  return join(home, '.qlb', 'unclaimed');
}

class StashFailingKeychain extends MockKeychain {
  deletes: string[] = [];
  failStashWrites = false;
  failStashDeletes = false;
  failStashReads = new Set<string>();

  override setSync(service: string, account: string, value: string): void {
    if (this.failStashWrites && service.includes(':unclaimed:')) throw new Error('fixture stash write failed');
    super.setSync(service, account, value);
  }

  override getSync(service: string, account: string): string {
    if (this.failStashReads.has(service)) throw new Error('fixture stash read failed');
    return super.getSync(service, account);
  }

  override deleteSync(service: string, account: string): void {
    if (this.failStashDeletes && service.includes(':unclaimed:')) throw new Error('fixture stash delete failed');
    this.deletes.push(service);
    super.deleteSync(service, account);
  }
}

describe('single-grant stash store', () => {
  it('uses the process QLB home rather than an empty injected environment', async () => {
    const processHome = process.env.QLB_HOME;
    assert.ok(processHome, 'the test runner supplies QLB_HOME');
    const isolatedOsHome = await mkdtemp(join(tmpdir(), 'qlb-single-stash-os-home-'));
    const originalHome = process.env.HOME;
    const keychain = new StashFailingKeychain();
    try {
      process.env.HOME = isolatedOsHome;
      await persistStash('xai', credential('issued', 'next'), lineage('before'), keychain, { env: {}, now: () => NOW });
      const [entry] = await listStashes(root(processHome), 'xai', 'default');
      assert.ok(entry);
      assert.equal(existsSync(root(isolatedOsHome)), false);
      await removeStash(root(processHome), entry);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(isolatedOsHome, { recursive: true, force: true });
    }
  });

  it('rejects an omitted home under node:test when process QLB_HOME is absent', async () => {
    const originalQlbHome = process.env.QLB_HOME;
    const originalHome = process.env.HOME;
    const isolatedOsHome = await mkdtemp(join(tmpdir(), 'qlb-single-stash-os-home-'));
    try {
      delete process.env.QLB_HOME;
      process.env.HOME = isolatedOsHome;
      assert.equal(homedir(), isolatedOsHome);
      await assert.rejects(
        persistStash('xai', credential('issued', 'next'), lineage('before'), new StashFailingKeychain(), { env: {}, now: () => NOW }),
        /explicit home/,
      );
    } finally {
      if (originalQlbHome === undefined) delete process.env.QLB_HOME;
      else process.env.QLB_HOME = originalQlbHome;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(isolatedOsHome, { recursive: true, force: true });
    }
  });

  it('persists a successor in a create-only file fallback when Keychain storage fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    keychain.failStashWrites = true;
    try {
      await persistStash('xai', credential('issued', 'next'), lineage('before'), keychain, { home, now: () => NOW });
      const [entry] = await listStashes(root(home), 'xai', 'default');
      assert.equal(entry?.location, 'file');
      assert.equal(existsSync(join(root(home), 'xai', `${entry?.stashId}.json`)), true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('a directory fsync that the platform does not support does not stop the file fallback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    const directorySyncCalls: string[] = [];
    keychain.failStashWrites = true;
    const deps = {
      home,
      now: () => NOW,
      directorySync: async (path: string) => {
        directorySyncCalls.push(path);
        const error = new Error('unsupported directory fsync') as NodeJS.ErrnoException;
        error.code = 'EINVAL';
        throw error;
      },
    };
    try {
      await persistStash('xai', credential('issued', 'next'), lineage('before'), keychain, deps);
      const [entry] = await listStashes(root(home), 'xai', 'default');
      assert.equal(entry?.location, 'file');
      assert.equal(existsSync(join(root(home), 'xai', `${entry?.stashId}.json`)), true);
      assert.deepEqual(directorySyncCalls, [root(home), join(root(home), 'xai')]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('adopting a file-fallback stash deletes the file and its row and never calls the Keychain delete', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    const current = credential('before', 'before-refresh');
    const successor = credential('issued', 'next-refresh', NOW + 60_000);
    const primary = qlbKeychainService('xai', 'default');
    keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(current));
    keychain.failStashWrites = true;
    try {
      await persistStash('xai', successor, lineage('before-refresh'), keychain, { home, now: () => NOW });
      const [entry] = await listStashes(root(home), 'xai', 'default');
      const file = join(root(home), 'xai', `${entry!.stashId}.json`);

      assert.deepEqual(await adoptStashedSuccessor('xai', current, keychain, { home }), successor);
      assert.equal(existsSync(file), false);
      assert.deepEqual(await listStashes(root(home), 'xai', 'default'), []);
      assert.deepEqual(keychain.deletes, []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('adopting a Keychain stash deletes the item and leaves no file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    const current = credential('before', 'before-refresh');
    const successor = credential('issued', 'next-refresh', NOW + 60_000);
    const stashId = 'keychain-stash';
    const stashService = qlbKeychainService('xai', `unclaimed:${stashId}`);
    keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(current));
    try {
      await recordStash(root(home), {
        provider: 'xai', accountId: 'default', stashId, consumedFp: lineage('before-refresh'), location: 'keychain', createdAt: NOW,
      });
      keychain.setSync(stashService, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ credential: successor, consumedFp: lineage('before-refresh') }));

      assert.deepEqual(await adoptStashedSuccessor('xai', current, keychain, { home }), successor);
      assert.deepEqual(keychain.deletes, [stashService]);
      assert.equal(existsSync(join(root(home), 'xai', `${stashId}.json`)), false);
      assert.deepEqual(await listStashes(root(home), 'xai', 'default'), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('three xAI passes after a file-fallback adoption leave zero rows and the primary unchanged', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    const current = credential('before', 'before-refresh');
    const successor = credential('issued', 'next-refresh', NOW + 60_000);
    const primary = qlbKeychainService('xai', 'default');
    keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(current));
    keychain.failStashWrites = true;
    try {
      await persistStash('xai', successor, lineage('before-refresh'), keychain, { home, now: () => NOW });
      assert.deepEqual(await adoptStashedSuccessor('xai', current, keychain, { home }), successor);
      const installed = keychain.getSync(primary, QLB_KEYCHAIN_ACCOUNT);
      for (let pass = 0; pass < 3; pass += 1) {
        assert.equal(await adoptStashedSuccessor('xai', successor, keychain, { home }), null);
      }
      assert.equal(keychain.getSync(primary, QLB_KEYCHAIN_ACCOUNT), installed);
      assert.deepEqual(await listStashes(root(home), 'xai', 'default'), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('clears a reservation whose body is absent in both places', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    const current = credential('before', 'before-refresh');
    const warnings: string[] = [];
    try {
      await recordStash(root(home), {
        provider: 'xai', accountId: 'default', stashId: 'lost-stash', consumedFp: lineage('before-refresh'), location: 'keychain', createdAt: NOW,
      });
      assert.equal(await adoptStashedSuccessor('xai', current, keychain, { home, warn: (message) => warnings.push(message) }), null);
      assert.deepEqual(await listStashes(root(home), 'xai', 'default'), []);
      assert.deepEqual(warnings, ['stash-lost lost-stash credential-and-file-not-found']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('defers a present but corrupt stash rather than treating it as an orphan', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    const current = credential('before', 'before-refresh');
    const stashId = 'corrupt-stash';
    try {
      await recordStash(root(home), {
        provider: 'xai', accountId: 'default', stashId, consumedFp: lineage('before-refresh'), location: 'file', createdAt: NOW,
      });
      mkdirSync(join(root(home), 'xai'), { recursive: true, mode: 0o700 });
      writeFileSync(join(root(home), 'xai', `${stashId}.json`), '{not-json', { mode: 0o600 });
      await assert.rejects(adoptStashedSuccessor('xai', current, keychain, { home }), /stash-unreadable/);
      assert.equal(readFileSync(join(root(home), 'xai', `${stashId}.json`), 'utf8'), '{not-json');
      assert.equal((await listStashes(root(home), 'xai', 'default')).length, 1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('a stash that is not newer than the installed primary is removed, never re-installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    const current = credential('primary', 'same-refresh', NOW + 60_000);
    const stale = credential('stale', 'same-refresh', NOW + 60_000);
    const stashId = 'obsolete-stash';
    const primary = qlbKeychainService('xai', 'default');
    keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(current));
    try {
      await recordStash(root(home), {
        provider: 'xai', accountId: 'default', stashId, consumedFp: lineage('same-refresh'), location: 'keychain', createdAt: NOW,
      });
      keychain.setSync(qlbKeychainService('xai', `unclaimed:${stashId}`), QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ credential: stale, consumedFp: lineage('same-refresh') }));
      assert.equal(await adoptStashedSuccessor('xai', current, keychain, { home }), null);
      assert.deepEqual(JSON.parse(keychain.getSync(primary, QLB_KEYCHAIN_ACCOUNT)), current);
      assert.deepEqual(await listStashes(root(home), 'xai', 'default'), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('an xAI file-fallback stash is invisible to Claude\'s unclaimed scan', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const xaiKeychain = new StashFailingKeychain();
    const claudeKeychain = new MockKeychain();
    xaiKeychain.failStashWrites = true;
    const claudeSlots = new ClaudeSlots({
      backend: claudeKeychain,
      repository: new InMemoryClaudeSlotRepository(),
      stashDir: root(home),
      now: () => NOW,
    });
    try {
      await claudeSlots.createSlot({
        accountId: 'claude-slot',
        credential: JSON.stringify({ claudeAiOauth: { accessToken: 'claude-access', refreshToken: 'claude-refresh', expiresAt: NOW + 60_000 } }),
        source: 'test',
      });
      await persistStash('xai', credential('issued', 'next'), lineage('before'), xaiKeychain, { home, now: () => NOW });

      assert.equal(await claudeSlots.adoptStashedSuccessor('claude-slot'), null);
      assert.deepEqual(await claudeSlots.sweepUnclaimed(), { swept: 0, retained: 0 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('an unreadable second row after a successful adoption still reports adopted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    const current = credential('before', 'before-refresh');
    const successor = credential('issued', 'next-refresh', NOW + 60_000);
    const firstStashId = 'adopt-first';
    const secondStashId = 'unreadable-second';
    const warnings: string[] = [];
    try {
      await recordStash(root(home), {
        provider: 'xai', accountId: 'default', stashId: firstStashId, consumedFp: lineage('before-refresh'), location: 'keychain', createdAt: NOW,
      });
      await recordStash(root(home), {
        provider: 'xai', accountId: 'default', stashId: secondStashId, consumedFp: lineage('before-refresh'), location: 'keychain', createdAt: NOW + 1,
      });
      keychain.setSync(qlbKeychainService('xai', `unclaimed:${firstStashId}`), QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ credential: successor, consumedFp: lineage('before-refresh') }));
      keychain.failStashReads.add(qlbKeychainService('xai', `unclaimed:${secondStashId}`));

      assert.deepEqual(await adoptStashedSuccessor('xai', current, keychain, { home, warn: (message) => warnings.push(message) }), successor);
      assert.deepEqual(JSON.parse(keychain.getSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT)), successor);
      assert.deepEqual(warnings, ['stash-unreadable']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('a row left by a failed cleanup is removed on the next pass after the refresh token rotated', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    const current = credential('before', 'before-refresh');
    const successor = credential('issued', 'next-refresh', NOW + 60_000);
    const warnings: string[] = [];
    try {
      await persistStash('xai', successor, lineage('before-refresh'), keychain, { home, now: () => NOW });
      keychain.failStashDeletes = true;
      assert.deepEqual(await adoptStashedSuccessor('xai', current, keychain, { home, warn: (message) => warnings.push(message) }), successor);
      assert.equal((await listStashes(root(home), 'xai', 'default')).length, 1);

      keychain.failStashDeletes = false;
      assert.equal(await adoptStashedSuccessor('xai', successor, keychain, { home, warn: (message) => warnings.push(message) }), null);
      assert.deepEqual(await listStashes(root(home), 'xai', 'default'), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  for (const provider of ['xai', 'kimi-coding'] as const) {
    it(`stash adoption into a generic-held shared item advances the generation and stamps the grant [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
      const keychain = new StashFailingKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      const primary = qlbKeychainService(provider, 'default');
      const before = credential('before', 'before-refresh');
      const successor = credential('issued', 'issued-refresh', NOW + 60_000);
      store.upsertAccount(accountId, provider, provider);
      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] }));
      keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...before, generation: 0 }));
      try {
        await persistStash(provider, successor, lineage('before-refresh'), keychain, { home, now: () => NOW });
        const result = await consumeSingleCredential(provider, { access: before.access, expires: before.expires! }, {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => assert.fail('stash adoption precedes POST'),
        });
        const installed = JSON.parse(keychain.getSync(primary, QLB_KEYCHAIN_ACCOUNT));
        assert.equal(result.outcome, 'winner');
        assert.equal(store.getGrantGeneration(accountId), 1);
        assert.equal(installed.generation, 1);
        assert.equal(installed.writtenBy, 'single-consume');

        store.upsertMigration(`pi-${provider}`, 'NATIVE', JSON.stringify({ accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] }));
        store.setConfig(`pi.${provider}.state`, 'migrated');
        keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(before));
        await persistStash(provider, successor, lineage('before-refresh'), keychain, { home, now: () => NOW + 1 });
        await consumeSingleCredential(provider, { access: before.access, expires: before.expires! }, {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => assert.fail('stash adoption precedes POST'),
        });
        assert.equal(store.getGrantGeneration(accountId), 1);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });
  }

  it('a Linux-style operational keychain error with no fallback file defers and keeps the row', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-stash-'));
    const keychain = new StashFailingKeychain();
    const current = credential('before', 'before-refresh');
    try {
      await recordStash(root(home), {
        provider: 'xai', accountId: 'default', stashId: 'linux-operational', consumedFp: lineage('before-refresh'), location: 'keychain', createdAt: NOW,
      });
      keychain.getSync = () => { throw new Error('keychain get failed: exit 1'); };
      await assert.rejects(adoptStashedSuccessor('xai', current, keychain, { home }), /stash-unreadable/);
      assert.equal((await listStashes(root(home), 'xai', 'default')).length, 1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
