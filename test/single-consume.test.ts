import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  consumeSingleCredential,
  createInMemorySingleConsumeLock,
  type OAuthCredential,
} from '../src/single-consume';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { refreshXaiCredential, XAI_CLIENT_ID, XAI_REFRESH_URL } from '../src/oauth/xai-refresh';
import { KIMI_CODING_CLIENT_ID, refreshKimiCodingCredential } from '../src/oauth/kimi-coding-refresh';
import { listStashes, recordStash } from '../src/unclaimed-index';

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

describe('single-account consume gate', () => {
  it('serializes two concurrent refreshes into one POST and returns the persisted winner', async () => {
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
    const [first, second] = await Promise.all([
      consumeSingleCredential('kimi-coding', snapshot, { keychain, lock, refresh, now: () => NOW }),
      consumeSingleCredential('kimi-coding', snapshot, { keychain, lock, refresh, now: () => NOW }),
    ]);

    assert.equal(posts, 1);
    assert.equal(first.credential.access, 'access-after');
    assert.equal(second.credential.access, 'access-after');
  });

  it('does not POST when a different, unexpired winner appears under the consume lock (N8)', async () => {
    const keychain = new MockKeychain();
    keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify(credential('winner-access', 'winner-refresh', NOW + 60_000)));
    let posts = 0;
    const result = await consumeSingleCredential('xai', credential('stale-access', 'stale-refresh'), {
      keychain, lock: createInMemorySingleConsumeLock(), now: () => NOW,
      refresh: async () => { posts += 1; return { kind: 'transient' }; },
    });

    assert.equal(posts, 0);
    assert.equal(result.outcome, 'winner');
    assert.equal(result.credential.access, 'winner-access');
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
        keychain, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => ({ kind: 'success', credential: credential('issued', 'refresh-issued', NOW + 3_600_000) }),
      }), /persist-failed/);
      const [stash] = await listStashes(root(home), 'xai', 'default');
      assert.ok(stash);
      assert.equal(existsSync(join(root(home), 'xai', `${stash.stashId}.json`)), true);

      rejectPrimary = false;
      let posts = 0;
      const recovered = await consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
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
        keychain, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
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
        keychain, home, lock, now: () => NOW,
        refresh: async () => { posts += 1; return { kind: 'success' as const, credential: credential('issued', 'refresh-issued', NOW + 3_600_000) }; },
      });
      const second = consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, home, lock, now: () => NOW,
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
        keychain, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
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
        keychain, lock: createInMemorySingleConsumeLock(), now: () => 1730000000000,
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
    const keychain = new MockKeychain();
    const primary = qlbKeychainService('kimi-coding', 'default');
    keychain.setSync(primary, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential('before', 'refresh-before')));
    const warnings: string[] = [];
    const result = await consumeSingleCredential('kimi-coding', credential('before', 'refresh-before'), {
      keychain, lock: createInMemorySingleConsumeLock(), now: () => NOW,
      warn: (message) => warnings.push(message),
      onLineage: () => { throw new Error('audit unavailable'); },
      refresh: async () => ({ kind: 'success', credential: credential('after', 'refresh-after', NOW + 3_600_000) }),
    });
    assert.equal(result.credential.access, 'after');
    assert.equal(JSON.parse(keychain.getSync(primary, QLB_KEYCHAIN_ACCOUNT)).access, 'after');
    assert.deepEqual(warnings, ['lineage callback failed']);
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
        keychain, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => ({ kind: 'success', credential: credential('issued', 'refresh-issued') }),
      }), /successor-unpersisted/);
      assert.equal((await listStashes(root(home), 'xai', 'default')).length, 1);
      await rm(blockedPath, { recursive: true, force: true });
      rejectPrimary = false;
      let posts = 0;
      const recovered = await consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
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
        keychain, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
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
    const keychain = new MockKeychain();
    keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify(credential('before', 'refresh-before')));
    const warnings: string[] = [];
    await assert.rejects(consumeSingleCredential('xai', credential('before', 'refresh-before'), {
      keychain, lock: createInMemorySingleConsumeLock(), now: () => NOW,
      warn: (message) => warnings.push(message),
      onDead: () => { throw new Error('audit unavailable'); },
      refresh: async () => ({ kind: 'dead' }),
    }), /refresh-dead/);
    assert.deepEqual(warnings, ['dead callback failed']);
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
        keychain, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
        refresh: async () => ({ kind: 'success', credential: credential('issued', 'refresh-issued', NOW + 3_600_000) }),
      }), /persist-failed/);
      failPrimary = false;
      const edges: Array<{ fromFp: string; toFp: string }> = [];
      const adopted = await consumeSingleCredential('xai', credential('before', 'refresh-before'), {
        keychain, home, lock: createInMemorySingleConsumeLock(), now: () => NOW,
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
