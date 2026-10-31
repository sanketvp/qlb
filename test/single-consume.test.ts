import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { DEFAULT_HEARTBEAT_MS } from '../src/refresh-lease';

import {
  consumeSingleCredential,
  createInMemorySingleConsumeLock,
  type OAuthCredential,
  type SingleConsumeStore,
} from '../src/single-consume';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { refreshXaiCredential, XAI_CLIENT_ID, XAI_REFRESH_URL } from '../src/oauth/xai-refresh';
import { KIMI_CODING_CLIENT_ID, refreshKimiCodingCredential } from '../src/oauth/kimi-coding-refresh';
import { listStashes, recordStash } from '../src/unclaimed-index';
import { ADAPTER_ACCOUNT_IDS } from '../src/migration';
import { sharedSingleGrantCoords } from '../src/single-grant-ownership';
import { refreshLeaseName, Store } from '../src/store';

const NOW = 1_730_000_000_000;

function credential(access: string, refresh: string, expires = NOW + 30_000): OAuthCredential {
  return { type: 'oauth', access, refresh, expires };
}

function lineageFp(refresh: string): string {
  return `sha256:${createHash('sha256').update(refresh, 'utf8').digest('hex')}`;
}

function root(home: string): string {
  return join(home, '.qlb', 'unclaimed');
}

/** No generic journal: the shared item follows today's P7a rules. */
const NO_JOURNAL: SingleConsumeStore = {
  getMigration: () => null,
  getConfig: () => null,
  getGrantGeneration: () => null,
  repairGrantGeneration: () => undefined,
  runImmediate: <T>(work: () => T): T => work(),
  bumpGrantGeneration: () => 0,
};

describe('single-account consume gate', () => {
  it('serializes two concurrent refreshes into one POST and returns the persisted winner', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const keychain = new MockKeychain();
    const service = qlbKeychainService('kimi-coding', 'default');
    keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('access-before', 'refresh-before')));
    const lock = createInMemorySingleConsumeLock();
    let posts = 0;
    const refresh = async (): Promise<{ kind: 'success'; credential: OAuthCredential }> => {
      posts += 1;
      await Promise.resolve();
      return { kind: 'success', credential: credential('access-after', 'refresh-after', NOW + 3_600_000) };
    };

    const snapshot = credential('access-before', 'refresh-before');
    try {
      const [first, second] = await Promise.all([
        consumeSingleCredential('kimi-coding', snapshot, { keychain, home, store: NO_JOURNAL, lock, refresh, now: () => NOW }),
        consumeSingleCredential('kimi-coding', snapshot, { keychain, home, store: NO_JOURNAL, lock, refresh, now: () => NOW }),
      ]);

      assert.equal(posts, 1);
      assert.equal(first.credential.access, 'access-after');
      assert.equal(second.credential.access, 'access-after');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not POST when a different, unexpired winner appears under the consume lock (N8)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const keychain = new MockKeychain();
    keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify(credential('winner-access', 'winner-refresh', NOW + 60_000)));
    let posts = 0;
    try {
      const result = await consumeSingleCredential('xai', credential('stale-access', 'stale-refresh'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => { posts += 1; return { kind: 'transient' }; },
      });

      assert.equal(posts, 0);
      assert.equal(result.outcome, 'winner');
      assert.equal(result.credential.access, 'winner-access');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses the process QLB home rather than an empty injected environment', async () => {
    const processHome = process.env.QLB_HOME;
    assert.ok(processHome, 'the test runner supplies QLB_HOME');
    const isolatedOsHome = await mkdtemp(join(tmpdir(), 'qlb-single-consume-os-home-'));
    const originalHome = process.env.HOME;
    const keychain = new MockKeychain();
    keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify(credential('before', 'refresh-before', NOW + 3_600_000)));
    try {
      process.env.HOME = isolatedOsHome;
      const result = await consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, env: {}, now: () => NOW,
        refresh: async () => assert.fail('the unexpired credential must win'),
      });
      assert.equal(result.outcome, 'winner');
      assert.equal(existsSync(join(processHome, '.qlb', 'locks')), true);
      assert.equal(existsSync(join(isolatedOsHome, '.qlb')), false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(isolatedOsHome, { recursive: true, force: true });
    }
  });

  it('uses the process QLB home when deps.env has only a Kimi provider host', async () => {
    const processHome = process.env.QLB_HOME;
    assert.ok(processHome, 'the test runner supplies QLB_HOME');
    const isolatedOsHome = await mkdtemp(join(tmpdir(), 'qlb-single-consume-os-home-'));
    const originalHome = process.env.HOME;
    const keychain = new MockKeychain();
    keychain.setSync(qlbKeychainService('kimi-coding', 'default'), QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify(credential('before', 'refresh-before', NOW + 3_600_000)));
    try {
      process.env.HOME = isolatedOsHome;
      const result = await consumeSingleCredential('kimi-coding', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, env: { KIMI_CODE_OAUTH_HOST: 'http://127.0.0.1:1' }, now: () => NOW,
        refresh: async () => assert.fail('the unexpired credential must win'),
      });
      assert.equal(result.outcome, 'winner');
      assert.equal(existsSync(join(processHome, '.qlb', 'locks')), true);
      assert.equal(existsSync(join(isolatedOsHome, '.qlb')), false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(isolatedOsHome, { recursive: true, force: true });
    }
  });

  it('rejects an omitted home under node:test when process QLB_HOME is absent', async () => {
    const originalQlbHome = process.env.QLB_HOME;
    const originalHome = process.env.HOME;
    const isolatedOsHome = await mkdtemp(join(tmpdir(), 'qlb-single-consume-os-home-'));
    const keychain = new MockKeychain();
    keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify(credential('before', 'refresh-before', NOW + 3_600_000)));
    try {
      delete process.env.QLB_HOME;
      process.env.HOME = isolatedOsHome;
      await assert.rejects(consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, env: {}, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => assert.fail('the guard must run before refresh'),
      }), /explicit home/);
    } finally {
      if (originalQlbHome === undefined) delete process.env.QLB_HOME;
      else process.env.QLB_HOME = originalQlbHome;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(isolatedOsHome, { recursive: true, force: true });
    }
  });

  it('stashes an issued successor when persist fails instead of discarding it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const primary = qlbKeychainService('xai', 'default');
    const items = new Map<string, string>();
    const key = (service: string, account: string) => `${service}\0${account}`;
    items.set(key(primary, QLB_KEYCHAIN_ACCOUNT), JSON.stringify(credential('before', 'refresh-before')));
    let rejectPrimary = true;
    const keychain = {
      getSync(service: string, account: string): string {
        const value = items.get(key(service, account));
        if (!value) throw new Error('item not found');
        return value;
      },
      setSync(service: string, account: string, value: string): void {
        if (service === primary && rejectPrimary) throw new Error('primary unavailable');
        if (service.includes(':unclaimed:')) throw new Error('stash Keychain unavailable');
        items.set(key(service, account), value);
      },
      deleteSync(service: string, account: string): void { items.delete(key(service, account)); },
    };
    try {
      await assert.rejects(consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => ({ kind: 'success', credential: credential('issued', 'refresh-issued', NOW + 3_600_000) }),
      }), /persist-failed/);
      const [stash] = await listStashes(root(home), 'xai', 'default');
      assert.ok(stash);
      assert.equal(existsSync(join(root(home), 'xai', `${stash.stashId}.json`)), true);

      rejectPrimary = false;
      let posts = 0;
      const recovered = await consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => { posts += 1; return { kind: 'transient' }; },
      });
      assert.equal(posts, 0);
      assert.equal(recovered.credential.access, 'issued');
      assert.equal(existsSync(join(root(home), 'xai', `${stash.stashId}.json`)), false);
      assert.deepEqual(await listStashes(root(home), 'xai', 'default'), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('stashes a 2xx successor before reporting an unreadable post-POST store', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const primary = qlbKeychainService('kimi-coding', 'default');
    const items = new Map<string, string>();
    const key = (service: string, account: string) => `${service}\0${account}`;
    items.set(key(primary, QLB_KEYCHAIN_ACCOUNT), JSON.stringify(credential('before', 'refresh-before')));
    let primaryReads = 0;
    const keychain = {
      getSync(service: string, account: string): string {
        if (service === primary && ++primaryReads === 2) throw new Error('Keychain busy');
        const value = items.get(key(service, account));
        if (!value) throw new Error('item not found');
        return value;
      },
      setSync(service: string, account: string, value: string): void { items.set(key(service, account), value); },
      deleteSync(service: string, account: string): void { items.delete(key(service, account)); },
    };
    try {
      await assert.rejects(consumeSingleCredential('kimi-coding', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => ({ kind: 'success', credential: credential('issued', 'refresh-issued') }),
      }), /credential-unavailable/);
      const [stash] = await listStashes(root(home), 'kimi-coding', 'default');
      assert.ok(stash);
      assert.equal(JSON.parse(keychain.getSync(qlbKeychainService('kimi-coding', `unclaimed:${stash.stashId}`), QLB_KEYCHAIN_ACCOUNT)).credential.access, 'issued');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('a concurrent adopter cannot remove the row between persistStash\'s row write and its Keychain write', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const primary = qlbKeychainService('xai', 'default');
    const items = new Map<string, string>();
    const key = (service: string, account: string) => `${service}\0${account}`;
    items.set(key(primary, QLB_KEYCHAIN_ACCOUNT), JSON.stringify(credential('before', 'refresh-before')));
    let rejectPrimary = true;
    let stashWrites = 0;
    const keychain = {
      getSync(service: string, account: string): string {
        const value = items.get(key(service, account));
        if (!value) throw new Error('item not found');
        return value;
      },
      setSync(service: string, account: string, value: string): void {
        if (service === primary && rejectPrimary) throw new Error('primary unavailable');
        if (service.includes(':unclaimed:')) stashWrites += 1;
        items.set(key(service, account), value);
      },
      deleteSync(service: string, account: string): void { items.delete(key(service, account)); },
    };
    let posts = 0;
    const lock = createInMemorySingleConsumeLock();
    try {
      const first = consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock, now: () => NOW,
        refresh: async () => { posts += 1; return { kind: 'success' as const, credential: credential('issued', 'refresh-issued', NOW + 3_600_000) }; },
      });
      const second = consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock, now: () => NOW,
        refresh: async () => { posts += 1; return { kind: 'transient' as const }; },
      });
      await assert.rejects(first, /persist-failed/);
      rejectPrimary = false;
      const winner = await second;
      assert.equal(stashWrites, 1);
      assert.equal(posts, 1);
      assert.equal(winner.credential.access, 'issued');
      assert.deepEqual(await listStashes(root(home), 'xai', 'default'), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses an adopted successor with an unknown expiry instead of re-posting its spent lineage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const keychain = new MockKeychain();
    const primary = qlbKeychainService('xai', 'default');
    const stashId = 'unknown-expiry';
    const before = credential('before', 'refresh-before');
    const saved = { type: 'oauth', access: 'saved', refresh: 'refresh-issued' };
    keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(before));
    try {
      await recordStash(root(home), {
        provider: 'xai', accountId: 'default', stashId, consumedFp: lineageFp('refresh-before'), location: 'keychain', createdAt: NOW,
      });
      keychain.setSync(qlbKeychainService('xai', `unclaimed:${stashId}`), QLB_KEYCHAIN_ACCOUNT,
        JSON.stringify({ credential: saved, consumedFp: lineageFp('refresh-before') }));
      let posts = 0;
      const result = await consumeSingleCredential('xai', before, {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => { posts += 1; return { kind: 'transient' }; },
      });
      assert.equal(posts, 0);
      assert.equal(result.outcome, 'winner');
      assert.equal(result.credential.access, 'saved');
      assert.deepEqual(await listStashes(root(home), 'xai', 'default'), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('an adopted successor with no expiry is refreshed on the next consume, not unreadable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const keychain = new MockKeychain();
    const primary = qlbKeychainService('xai', 'default');
    const stashId = 'unknown-expiry-second-pass';
    const before = credential('before', 'refresh-before');
    const saved = { type: 'oauth', access: 'saved', refresh: 'refresh-issued' };
    keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(before));
    try {
      await recordStash(root(home), {
        provider: 'xai', accountId: 'default', stashId, consumedFp: lineageFp('refresh-before'), location: 'keychain', createdAt: NOW,
      });
      keychain.setSync(qlbKeychainService('xai', `unclaimed:${stashId}`), QLB_KEYCHAIN_ACCOUNT,
        JSON.stringify({ credential: saved, consumedFp: lineageFp('refresh-before') }));
      const adopted = await consumeSingleCredential('xai', before, {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => assert.fail('the first pass must adopt without refreshing'),
      });
      let posts = 0;
      const refreshed = await consumeSingleCredential('xai', adopted.credential, {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => {
          posts += 1;
          return { kind: 'success', credential: credential('refreshed', 'refresh-refreshed', NOW + 3_600_000) };
        },
      });
      assert.equal(posts, 1);
      assert.equal(refreshed.outcome, 'refreshed');
      assert.equal(refreshed.credential.access, 'refreshed');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refreshes a primary with a non-finite expiry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const keychain = new MockKeychain();
    const primary = qlbKeychainService('xai', 'default');
    keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT,
      '{"type":"oauth","access":"before","refresh":"refresh-before","expires":1e999}');
    try {
      let posts = 0;
      const result = await consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => {
          posts += 1;
          return { kind: 'success', credential: credential('refreshed', 'refresh-refreshed', NOW + 3_600_000) };
        },
      });
      assert.equal(posts, 1);
      assert.equal(result.outcome, 'refreshed');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('defers SIGTERM after the POST until the successor is persisted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-signal-'));
    const marker = join(home, 'persisted');
    const modulePath = require.resolve('../src/single-consume');
    const child = `
      const fs = require('node:fs');
      const { consumeSingleCredential, createInMemorySingleConsumeLock } = require(process.argv[1]);
      const marker = process.argv[2];
      const service = 'qlb:xai:default', account = 'qlb';
      let stored = JSON.stringify({ type: 'oauth', access: 'before', refresh: 'before-refresh', expires: 1730000000030 });
      let posted = false;
      const keychain = {
        getSync(name) { if (name !== service) throw new Error('item not found'); return stored; },
        setSync(name, ignored, value) { if (name === service && posted) fs.writeFileSync(marker, 'persisted'); if (name === service) stored = value; },
        deleteSync() {},
      };
      consumeSingleCredential('xai', { access: 'before', expires: 1730000000030 }, {
        keychain, store: { getMigration: () => null }, home: process.env.QLB_HOME, lock: createInMemorySingleConsumeLock(), now: () => 1730000000000,
        refresh: async () => { posted = true; const delivered = new Promise((resolve) => { process.once('SIGTERM', resolve); setTimeout(resolve, 50); }); process.kill(process.pid, 'SIGTERM'); await delivered; return { kind: 'success', credential: { type: 'oauth', access: 'after', refresh: 'after-refresh', expires: 1730003600000 } }; },
      }).catch(() => process.exit(1));
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', child, modulePath, marker], {
        env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.signal, 'SIGTERM');
      assert.equal(existsSync(marker), true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('warns and keeps the installed successor when the lineage callback throws', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const keychain = new MockKeychain();
    const primary = qlbKeychainService('kimi-coding', 'default');
    keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('before', 'refresh-before')));
    const warnings: string[] = [];
    try {
      const result = await consumeSingleCredential('kimi-coding', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        warn: (message) => warnings.push(message),
        onLineage: () => { throw new Error('audit unavailable'); },
        refresh: async () => ({ kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) }),
      });
      assert.equal(result.credential.access, 'after');
      assert.equal(JSON.parse(keychain.getSync(primary, QLB_KEYCHAIN_ACCOUNT)).access, 'after');
      assert.deepEqual(warnings, ['lineage callback failed']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('a double-failed stash leaves a reservation the next pass clears', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const primary = qlbKeychainService('xai', 'default');
    const items = new Map<string, string>();
    const key = (service: string, account: string) => `${service}\0${account}`;
    items.set(key(primary, QLB_KEYCHAIN_ACCOUNT), JSON.stringify(credential('before', 'refresh-before')));
    let rejectPrimary = true;
    let blockedPath = '';
    const keychain = {
      getSync(service: string, account: string): string {
        const value = items.get(key(service, account));
        if (!value) throw new Error('item not found');
        return value;
      },
      setSync(service: string, account: string, value: string): void {
        if (service === primary && rejectPrimary) throw new Error('primary unavailable');
        if (service.includes(':unclaimed:')) {
          const stashId = service.slice('qlb:xai:unclaimed:'.length);
          blockedPath = join(root(home), 'xai', `${stashId}.json`);
          mkdirSync(blockedPath, { recursive: true, mode: 0o700 });
          throw new Error('stash unavailable');
        }
        items.set(key(service, account), value);
      },
      deleteSync(service: string, account: string): void { items.delete(key(service, account)); },
    };
    try {
      await assert.rejects(consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => ({ kind: 'success', credential: credential('issued', 'refresh-issued') }),
      }), /successor-unpersisted/);
      assert.equal((await listStashes(root(home), 'xai', 'default')).length, 1);
      await rm(blockedPath, { recursive: true, force: true });
      rejectPrimary = false;
      let posts = 0;
      const recovered = await consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => { posts += 1; return { kind: 'success', credential: credential('recovered', 'refresh-recovered') }; },
      });
      assert.equal(posts, 1);
      assert.equal(recovered.credential.access, 'recovered');
      assert.deepEqual(await listStashes(root(home), 'xai', 'default'), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('stashes the issued successor when a content-fingerprint CAS sees a winner', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const keychain = new MockKeychain();
    const primary = qlbKeychainService('xai', 'default');
    keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('before', 'refresh-before')));
    try {
      const result = await consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => {
          keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('winner', 'winner-refresh', NOW + 3_600_000)));
          return { kind: 'success', credential: credential('issued', 'issued-refresh', NOW + 3_600_000) };
        },
      });
      assert.equal(result.outcome, 'winner');
      assert.equal(result.credential.access, 'winner');
      const [stash] = await listStashes(root(home), 'xai', 'default');
      assert.ok(stash);
      assert.equal(stash.consumedFp, lineageFp('refresh-before'));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports a dead refresh even when its callback throws', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const keychain = new MockKeychain();
    keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify(credential('before', 'refresh-before')));
    const warnings: string[] = [];
    try {
      await assert.rejects(consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        warn: (message) => warnings.push(message),
        onDead: () => { throw new Error('audit unavailable'); },
        refresh: async () => ({ kind: 'dead' }),
      }), /refresh-dead/);
      assert.deepEqual(warnings, ['dead callback failed']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('mirrors Pi xAI refresh and retains the old refresh token when it is omitted', async () => {
    let request: { url: string; body: string; headers: Record<string, string> } | undefined;
    const result = await refreshXaiCredential(credential('access-before', 'refresh-before'), {
      now: () => NOW,
      transport: { request: async (value) => {
        request = value;
        return { status: 200, body: { access_token: 'access-after', expires_in: 3600 } };
      } },
    });
    assert.equal(request?.url, XAI_REFRESH_URL);
    assert.equal(new URLSearchParams(request?.body).get('client_id'), XAI_CLIENT_ID);
    assert.equal(request?.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(result, { kind: 'success', credential: credential('access-after', 'refresh-before', NOW + 3_300_000) });
  });

  it('mirrors Pi Kimi refresh request fields and accepts its rotated token pair', async () => {
    let request: { url: string; body: string } | undefined;
    const result = await refreshKimiCodingCredential(credential('access-before', 'refresh-before'), {
      now: () => NOW,
      sleep: async () => assert.fail('successful first request must not sleep'),
      transport: { request: async (value) => {
        request = value;
        return { status: 200, body: { access_token: 'access-after', refresh_token: 'refresh-after', expires_in: 3600 } };
      } },
    });
    assert.equal(request?.url, 'https://auth.kimi.com/api/oauth/token');
    assert.equal(new URLSearchParams(request?.body).get('client_id'), KIMI_CODING_CLIENT_ID);
    assert.deepEqual(result, { kind: 'success', credential: credential('access-after', 'refresh-after', NOW + 3_600_000) });
  });

  for (const provider of ['xai', 'kimi-coding'] as const) {
    it(`P13 refresh of a generic-held shared item advances the generation and stamps the grant [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      const service = qlbKeychainService(provider, 'default');
      store.upsertAccount(accountId, provider, provider);
      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] }));
      keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...credential('before', 'refresh-before'), generation: 0 }));
      try {
        await consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => ({ kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) }),
        });
        const written = JSON.parse(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT));
        assert.equal(store.getGrantGeneration(accountId), 1);
        assert.equal(written.generation, 1);
        assert.equal(written.writtenBy, 'single-consume');
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 on a generic-held item holds the refresh lease across the POST [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      store.upsertAccount(accountId, provider, provider);
      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] }));
      keychain.setSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...credential('before', 'refresh-before'), generation: 0 }));
      try {
        await consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => {
            const lease = store.getLease(refreshLeaseName(accountId));
            assert.ok(lease, 'P13 holds a live refresh lease during its POST');
            assert.match(lease.holder_id, /:/);
            assert.equal(lease.generation, 0);
            return { kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) };
          },
        });
        assert.equal(store.getLease(refreshLeaseName(accountId)), null);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 on a generic-held item releases the refresh lease on every refusal [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      const service = qlbKeychainService(provider, 'default');
      const detail = { accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] };
      const reset = (): void => {
        store.upsertAccount(accountId, provider, provider);
        store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify(detail));
        keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...credential('before', 'refresh-before'), generation: store.getGrantGeneration(accountId) ?? 0 }));
      };
      const assertP13Lease = (): void => {
        const lease = store.getLease(refreshLeaseName(accountId));
        assert.ok(lease, 'P13 holds a refresh lease during its POST');
        assert.match(lease.holder_id, /:/);
      };
      try {
        reset();
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home: join(home, 'cas'), store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => {
            assertP13Lease();
            assert.equal(store.bumpGrantGeneration(accountId, store.getGrantGeneration(accountId) ?? -1), 1);
            return { kind: 'success', credential: credential('after-cas', 'refresh-after-cas', NOW + 3_600_000) };
          },
        }), /cas-conflict/);
        assert.equal(store.getLease(refreshLeaseName(accountId)), null);

        store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify(detail));
        keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...credential('before', 'refresh-before'), generation: store.getGrantGeneration(accountId) }));
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home: join(home, 'stash'), store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => {
            assertP13Lease();
            store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ ...detail, handback: {} }));
            return { kind: 'success', credential: credential('after-stash', 'refresh-after-stash', NOW + 3_600_000) };
          },
        }), /generic-ownership-marker/);
        assert.equal(store.getLease(refreshLeaseName(accountId)), null);
        assert.equal((await listStashes(root(join(home, 'cas')), provider, 'default')).length, 1);
        assert.equal((await listStashes(root(join(home, 'stash')), provider, 'default')).length, 1);

        store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify(detail));
        keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...credential('before', 'refresh-before'), generation: store.getGrantGeneration(accountId) }));
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home: join(home, 'throw'), store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => { assertP13Lease(); throw new Error('POST exploded'); },
        }), /POST exploded/);
        assert.equal(store.getLease(refreshLeaseName(accountId)), null);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 waits for another live refresh lease and does not POST meanwhile [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      store.upsertAccount(accountId, provider, provider);
      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] }));
      keychain.setSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...credential('before', 'refresh-before'), generation: 0 }));
      assert.equal(store.acquireRefreshLease(accountId, 'other-holder', process.pid, 0, 15_000), 'acquired');
      let posts = 0;
      try {
        const pending = consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => {
            posts += 1;
            return { kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) };
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(posts, 0);
        store.releaseRefreshLease(accountId, 'other-holder');
        await pending;
        assert.equal(posts, 1);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 on an item that is not generic-held takes no refresh lease [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      store.upsertAccount(accountId, provider, provider);
      keychain.setSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('before', 'refresh-before')));
      try {
        await consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => {
            assert.equal(store.getLease(refreshLeaseName(accountId)), null);
            return { kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) };
          },
        });
        assert.equal(store.getLease(refreshLeaseName(accountId)), null);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 refuses a generic-held shared item under a hand-back marker and stashes the issued pair [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      store.upsertAccount(accountId, provider, provider);
      const detail = { accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] };
      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify(detail));
      keychain.setSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('before', 'refresh-before')));
      try {
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => {
            store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ ...detail, handback: {} }));
            return { kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) };
          },
        }), /generic-ownership-marker/);
        assert.equal((await listStashes(root(home), provider, 'default')).length, 1);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 is unchanged when no generic journal exists [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      store.upsertAccount(accountId, provider, provider);
      keychain.setSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('before', 'refresh-before')));
      try {
        await consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => ({ kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) }),
        });
        assert.equal(store.getGrantGeneration(accountId), 0);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 follows P7a rules when the generic journal names the shared item but is NATIVE and P7a owns the provider [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      store.upsertAccount(accountId, provider, provider);
      store.upsertMigration(`pi-${provider}`, 'NATIVE', JSON.stringify({ accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] }));
      store.setConfig(`pi.${provider}.state`, 'migrated');
      keychain.setSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('before', 'refresh-before')));
      try {
        await consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => ({ kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) }),
        });
        assert.equal(store.getGrantGeneration(accountId), 0);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 refuses when the generic journal is QLB_OWNED and P7a also claims the provider, or the journal is unreadable [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      store.upsertAccount(accountId, provider, provider);
      const detail = JSON.stringify({ accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] });
      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', detail);
      store.setConfig(`pi.${provider}.state`, 'migrated');
      keychain.setSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('before', 'refresh-before')));
      try {
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => assert.fail('ownership refusal precedes POST'),
        }), /dual-ownership/);
        store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', 'not-json');
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => assert.fail('ownership refusal precedes POST'),
        }), /generic-ownership-unreadable/);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 on a generic-held item refuses and stashes when another writer bumped G after the POST [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      const service = qlbKeychainService(provider, 'default');
      store.upsertAccount(accountId, provider, provider);
      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] }));
      const before = JSON.stringify({ ...credential('before', 'refresh-before'), generation: 0 });
      keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, before);
      try {
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => {
            assert.equal(store.bumpGrantGeneration(accountId, 0), 1);
            return { kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) };
          },
        }), /cas-conflict/);
        assert.equal(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), before);
        assert.equal(store.getGrantGeneration(accountId), 1);
        assert.equal((await listStashes(root(home), provider, 'default')).length, 1);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 on a generic-held item after a Keychain-ahead crash does not reuse a generation [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      const service = qlbKeychainService(provider, 'default');
      store.upsertAccount(accountId, provider, provider);
      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] }));
      // C3: the Keychain write at generation 1 landed and the SQLite bump rolled back.
      keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...credential('before', 'refresh-before'), generation: 1 }));
      try {
        await consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => ({ kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) }),
        });
        assert.equal(JSON.parse(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT)).generation, 2);
        assert.equal(store.getGrantGeneration(accountId), 2);

        // The Keychain behind the journal is a restored item: refuse before the POST.
        const behind = JSON.stringify({ ...credential('before', 'refresh-before'), generation: 1 });
        keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, behind);
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => assert.fail('a Keychain behind the journal refuses before the POST'),
        }), /cas-conflict/);
        assert.equal(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), behind);
        assert.equal(store.getGrantGeneration(accountId), 2);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    });

    it(`P13 without a store refuses before the POST [${provider}]`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      keychain.setSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('before', 'refresh-before')));
      try {
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => assert.fail('no ownership authority, no POST'),
        } as unknown as Parameters<typeof consumeSingleCredential>[2]), /generic-ownership-unreadable/);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
  }

  it('single-consume refuses a generic journal with more than one account', async () => {
    for (const provider of ['xai', 'kimi-coding'] as const) {
      const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
      const keychain = new MockKeychain();
      const store = new Store(':memory:');
      const accountId = ADAPTER_ACCOUNT_IDS[provider];
      const shared = sharedSingleGrantCoords(provider);
      const account = { id: accountId, provider, label: provider, keychain: shared };
      keychain.setSync(shared.service, shared.account, JSON.stringify(credential('before', 'refresh-before')));
      const setSync = keychain.setSync.bind(keychain);
      const deleteSync = keychain.deleteSync.bind(keychain);
      const writes: string[] = [];
      const deletes: string[] = [];
      keychain.setSync = (service, name, value) => {
        writes.push(`${service}/${name}`);
        return setSync(service, name, value);
      };
      keychain.deleteSync = (service, name) => {
        deletes.push(`${service}/${name}`);
        return deleteSync(service, name);
      };
      store.upsertAccount(accountId, provider, provider);
      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ accounts: [account, { ...account }] }));
      try {
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          refresh: async () => assert.fail('invalid ownership refuses before the POST'),
        }), /generic-ownership-unreadable/);
        assert.deepEqual(writes, []);
        assert.deepEqual(deletes, []);
      } finally { store.close(); await rm(home, { recursive: true, force: true }); }
    }
  });

  it('passes the consumed lineage to a callback after adopting a stashed successor', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const primary = qlbKeychainService('xai', 'default');
    const keychain = new MockKeychain();
    keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('before', 'refresh-before')));
    let failPrimary = true;
    const originalSet = keychain.setSync.bind(keychain);
    keychain.setSync = (service, account, value) => {
      if (service === primary && failPrimary) throw new Error('primary unavailable');
      originalSet(service, account, value);
    };
    try {
      await assert.rejects(consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => ({ kind: 'success', credential: credential('issued', 'refresh-issued', NOW + 3_600_000) }),
      }), /persist-failed/);
      failPrimary = false;
      const edges: Array<{ fromFp: string; toFp: string }> = [];
      const adopted = await consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, store: NO_JOURNAL, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        onLineage: (row) => edges.push({ fromFp: row.fromFp, toFp: row.toFp }),
        refresh: async () => assert.fail('adoption must precede a second POST'),
      });
      assert.equal(adopted.credential.access, 'issued');
      assert.deepEqual(edges, [{ fromFp: lineageFp('refresh-before'), toFp: lineageFp('refresh-issued') }]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('P13 refresh lease failure handling (D-OD6-12a round 1)', () => {
  const PROVIDERS = ['xai', 'kimi-coding'] as const;

  /** A generic-held shared item at generation 0 in a fresh in-memory store. */
  async function genericHeld(provider: typeof PROVIDERS[number]) {
    const home = await mkdtemp(join(tmpdir(), 'qlb-single-consume-'));
    const keychain = new MockKeychain();
    const store = new Store(':memory:');
    const accountId = ADAPTER_ACCOUNT_IDS[provider];
    const service = qlbKeychainService(provider, 'default');
    store.upsertAccount(accountId, provider, provider);
    store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ accounts: [{ id: accountId, provider, label: provider, keychain: sharedSingleGrantCoords(provider) }] }));
    const before = JSON.stringify({ ...credential('before', 'refresh-before'), generation: 0 });
    keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, before);
    const cleanup = async (): Promise<void> => { store.close(); await rm(home, { recursive: true, force: true }); };
    return { home, keychain, store, accountId, service, before, cleanup };
  }

  it('P13 survives a throwing lease heartbeat and stashes the issued pair', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    for (const provider of PROVIDERS) {
      const { home, keychain, store, accountId, service, before, cleanup } = await genericHeld(provider);
      store.heartbeatRefreshLease = () => { throw new Error('database is locked'); };
      const warnings: string[] = [];
      try {
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          warn: (message) => warnings.push(message),
          refresh: async () => {
            // A SQLITE_BUSY in the timer must not escape as an uncaught exception.
            t.mock.timers.tick(DEFAULT_HEARTBEAT_MS);
            return { kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) };
          },
        }), /cas-conflict/);
        assert.equal(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), before);
        assert.equal(store.getGrantGeneration(accountId), 0);
        assert.equal((await listStashes(root(home), provider, 'default')).length, 1);
        assert.equal(store.getLease(refreshLeaseName(accountId)), null);
        assert.ok(warnings.some((message) => /heartbeat/.test(message)));
      } finally { await cleanup(); }
    }
  });

  it('P13 aborts the POST and never writes the primary when the lease is lost', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    for (const provider of PROVIDERS) {
      // (a) The heartbeat sees the lease taken: the POST signal aborts, but the
      // response arrives anyway. (b) No heartbeat fires: the in-transaction fence refuses.
      for (const heartbeatFires of [true, false]) {
        const { home, keychain, store, accountId, service, before, cleanup } = await genericHeld(provider);
        let signal: AbortSignal | undefined;
        try {
          await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
            keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
            refresh: async (...args: unknown[]) => {
              signal = (args[1] as { signal?: AbortSignal } | undefined)?.signal;
              store.stealLease(refreshLeaseName(accountId), 'other-holder');
              if (heartbeatFires) {
                t.mock.timers.tick(DEFAULT_HEARTBEAT_MS);
                assert.equal(signal?.aborted, true, 'a lost lease aborts the POST');
              }
              return { kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) };
            },
          }), /cas-conflict/);
          assert.ok(signal, 'the POST receives an abort signal');
          assert.equal(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), before);
          assert.equal(store.getGrantGeneration(accountId), 0);
          assert.equal((await listStashes(root(home), provider, 'default')).length, 1);
          assert.equal(store.getLease(refreshLeaseName(accountId))?.holder_id, 'other-holder');
        } finally { await cleanup(); }
      }
    }
  });

  it('P13 treats invalid_grant after a generation advance as a lost race, not dead', async () => {
    for (const provider of PROVIDERS) {
      const { home, keychain, store, accountId, service, cleanup } = await genericHeld(provider);
      const winner = JSON.stringify({ ...credential('winner', 'refresh-winner', NOW + 3_600_000), generation: 1, writtenBy: 'other' });
      let posts = 0;
      let dead = 0;
      try {
        const result = await consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          onDead: () => { dead += 1; },
          refresh: async () => {
            posts += 1;
            // Another holder committed g+1 first; this POST's token is now spent.
            keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, winner);
            assert.equal(store.bumpGrantGeneration(accountId, 0), 1);
            return { kind: 'dead' };
          },
        });
        assert.equal(dead, 0);
        assert.equal(posts, 1);
        assert.equal(result.outcome, 'winner');
        assert.equal(result.credential.access, 'winner');
        assert.equal(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), winner);
        assert.equal(store.getLease(refreshLeaseName(accountId)), null);
      } finally { await cleanup(); }
    }
  });

  it('P13 lease release failure does not replace a committed refresh', async () => {
    for (const provider of PROVIDERS) {
      const { home, keychain, store, accountId, service, cleanup } = await genericHeld(provider);
      const releaseRefreshLease = store.releaseRefreshLease.bind(store);
      store.releaseRefreshLease = () => { throw new Error('database is locked'); };
      const warnings: string[] = [];
      try {
        const result = await consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          warn: (message) => warnings.push(message),
          refresh: async () => ({ kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) }),
        });
        assert.equal(result.outcome, 'refreshed');
        assert.equal(store.getGrantGeneration(accountId), 1);
        assert.equal(JSON.parse(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT)).access, 'after');

        // A typed refusal survives a failing release too.
        keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...credential('before', 'refresh-before'), generation: 1 }));
        await assert.rejects(consumeSingleCredential(provider, credential('before', 'refresh-before'), {
          keychain, home, store, lock: createInMemorySingleConsumeLock(), now: () => NOW,
          warn: (message) => warnings.push(message),
          refresh: async () => ({ kind: 'dead' }),
        }), /refresh-dead/);
        assert.ok(warnings.some((message) => /release/.test(message)));
        store.releaseRefreshLease = releaseRefreshLease;
      } finally { await cleanup(); }
    }
  });
});
