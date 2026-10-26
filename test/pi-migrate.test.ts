import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MacosKeychainBackend, markFakeExecutor, MockKeychain, NativeOpenRouterKeyNotFoundError, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, readNativeOpenRouterKey, type ExecFileSyncFn } from '../src/keychain';
import {
  defaultPiMigratePaths,
  hasLegacyPiOwnerEntry,
  migratePiSingleProvider,
  rollbackPiSingleProvider,
  withPiAuthLock,
  type PiMigratePaths,
  type PiSingleProvider,
} from '../src/pi-migrate';

function oauth(seed: string): Record<string, unknown> {
  return { type: 'oauth', access: `access-${seed}`, refresh: `refresh-${seed}`, expires: Date.now() + 60_000 };
}

function setup(provider: Exclude<PiSingleProvider, 'openrouter'> = 'xai'): {
  dir: string;
  paths: PiMigratePaths;
  keychain: MockKeychain;
  provider: Exclude<PiSingleProvider, 'openrouter'>;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-pi-migrate-'));
  const paths = defaultPiMigratePaths(dir);
  mkdirSync(join(dir, '.pi', 'agent'), { recursive: true, mode: 0o700 });
  writeFileSync(paths.authJsonPath, JSON.stringify({ [provider]: oauth('native') }), { mode: 0o600 });
  return {
    dir,
    paths,
    keychain: new MockKeychain(),
    provider,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function placeholderPresent(paths: PiMigratePaths, provider: PiSingleProvider): boolean {
  const auth = JSON.parse(readFileSync(paths.authJsonPath, 'utf8')) as Record<string, unknown>;
  const entry = auth[provider] as { type?: unknown; access?: unknown; refresh?: unknown } | undefined;
  return entry?.type === 'oauth' && entry.access === 'qlb-managed' && entry.refresh === '';
}

function hasManaged(keychain: MockKeychain, provider: PiSingleProvider): boolean {
  try {
    keychain.getSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT);
    return true;
  } catch {
    return false;
  }
}

async function raceStaleLockTakers(paths: PiMigratePaths, home: string, racers: number): Promise<{ code: number | null; output: string }[]> {
  const modulePath = join(process.cwd(), 'dist-test', 'src', 'pi-migrate.js');
  const children = Array.from({ length: racers }, () => {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let resolveResult!: (result: { code: number | null; output: string }) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const proc = spawn(process.execPath, ['-e', `
      const { migratePiSingleProvider } = require(process.env.PI_MIGRATE_MODULE);
      const paths = JSON.parse(process.env.PI_MIGRATE_PATHS);
      process.send?.('ready');
      process.once('message', () => {
        let value = '';
        try {
          migratePiSingleProvider('xai', paths, { keychain: { setSync(_s, _a, v) { value = v; }, getSync() { return value; }, deleteSync() {} }, authLockTiming: { staleMs: 10, retries: 0, retryMs: 1 }, afterWrite(point) {
            if (point === 'owner-entry') { process.stdout.write('entered\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750); }
          } });
          process.exitCode = 0;
        } catch (error) { process.stdout.write(String(error.code || error.message)); process.exitCode = 1; }
        finally { if (process.connected) process.disconnect(); }
      });
    `], {
      env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home, PI_MIGRATE_MODULE: modulePath, PI_MIGRATE_PATHS: JSON.stringify(paths) },
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    let output = '';
    proc.stdout!.on('data', (chunk) => { output += String(chunk); });
    proc.once('message', (message) => { if (message === 'ready') resolveReady(); else rejectReady(new Error('racer did not become ready')); });
    proc.once('error', (error) => { rejectReady(error); rejectResult(error); });
    proc.once('close', (code) => { rejectReady(new Error(`racer exited before ready: ${code}`)); resolveResult({ code, output }); });
    return { proc, ready, result };
  });
  await Promise.all(children.map(({ ready }) => ready));
  for (const { proc } of children) proc.send('start');
  return Promise.all(children.map(({ result }) => result));
}

describe('Pi migration S58 credential-first barrier', () => {
  it('never leaves a placeholder without a managed item after a crash', () => {
    const h = setup();
    try {
      assert.throws(() => migratePiSingleProvider(h.provider, h.paths, {
        keychain: h.keychain,
        afterWrite: (point) => {
          if (point === 'placeholder') throw new Error('injected crash');
        },
      }));
      assert.equal(placeholderPresent(h.paths, h.provider), true, 'fixture must crash after placeholder publication');
      assert.equal(hasManaged(h.keychain, h.provider), true, 'placeholder without managed item');
    } finally {
      h.cleanup();
    }
  });

  for (const provider of ['xai', 'kimi-coding'] as const) {
    for (const point of ['baseline', 'credential-saved', 'placeholder', 'owner-entry', 'before-committed'] as const) {
      it(`${provider}: resumes and rolls back from ${point}`, () => {
        const h = setup(provider);
        try {
          let injected = false;
          assert.throws(() => migratePiSingleProvider(provider, h.paths, {
            keychain: h.keychain,
            afterWrite: (written) => {
              if (!injected && written === point) {
                injected = true;
                throw new Error('injected crash');
              }
            },
          }));
          const placeholder = placeholderPresent(h.paths, provider);
          assert.equal(!placeholder || hasManaged(h.keychain, provider), true, 'placeholder without managed item');

          migratePiSingleProvider(provider, h.paths, { keychain: h.keychain });
          assert.equal(placeholderPresent(h.paths, provider), true);
          assert.equal(hasManaged(h.keychain, provider), true);
          const owner = JSON.parse(readFileSync(h.paths.ownerPath, 'utf8')) as { providers?: Record<string, unknown> };
          assert.ok(owner.providers?.[provider], 'provider owner entry is present once migration resumes');

          rollbackPiSingleProvider(provider, h.paths, { keychain: h.keychain });
          assert.equal(placeholderPresent(h.paths, provider), false, 'rollback restores a native credential shape');
          const restored = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')) as Record<string, { refresh?: unknown }>;
          assert.equal(typeof restored[provider]?.refresh, 'string', 'rollback restores current managed credential or baseline');
        } finally {
          h.cleanup();
        }
      });
    }
  }

  it('refuses to publish into a legacy v1 Anthropic owner document and writes nothing', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }), { mode: 0o600 });
      const ownerBefore = readFileSync(h.paths.ownerPath); const authBefore = readFileSync(h.paths.authJsonPath);
      assert.throws(() => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }), /owner-file-legacy-v1/);
      assert.equal(readFileSync(h.paths.ownerPath).equals(ownerBefore), true);
      assert.equal(readFileSync(h.paths.authJsonPath).equals(authBefore), true);
      assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-xai.json')), false);
      assert.equal(hasManaged(h.keychain, 'xai'), false);
    } finally { h.cleanup(); }
  });

  it('rollback unlinks qlb-owner.json when its last entry is removed', () => {
    const h = setup();
    try {
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain });
      assert.equal(existsSync(h.paths.ownerPath), false);
    } finally { h.cleanup(); }
  });

  it('hasLegacyPiOwnerEntry is true for a v1 Anthropic claim and false for v2, missing and foreign-provider files', () => {
    const h = setup();
    try {
      assert.equal(hasLegacyPiOwnerEntry(h.paths.ownerPath, 'anthropic'), false, 'missing');
      writeFileSync(h.paths.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }), { mode: 0o600 });
      assert.equal(hasLegacyPiOwnerEntry(h.paths.ownerPath, 'anthropic'), true, 'v1 claim');
      writeFileSync(h.paths.ownerPath, JSON.stringify({ providers: { anthropic: { mode: 'qlb', since: 0 } } }), { mode: 0o600 });
      assert.equal(hasLegacyPiOwnerEntry(h.paths.ownerPath, 'anthropic'), false, 'v2 map');
      writeFileSync(h.paths.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }), { mode: 0o600 });
      assert.equal(hasLegacyPiOwnerEntry(h.paths.ownerPath, 'anthropic'), false, 'foreign provider');
    } finally { h.cleanup(); }
  });

  it('writes not-applicable only when the Pi credential is absent', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, '{}', { mode: 0o600 });
      const result = migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      assert.equal(result.state, 'not-applicable');
      assert.equal(existsSync(h.paths.ownerPath), false);
    } finally {
      h.cleanup();
    }
  });

  it('plans the managed service before the placeholder in dry-run output', () => {
    const h = setup();
    try {
      const result = migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }, { dryRun: true });
      assert.deepEqual(result.wouldWrite.slice(0, 2), ['qlb:xai:default', 'placeholder:xai']);
      assert.equal(hasManaged(h.keychain, 'xai'), false);
    } finally {
      h.cleanup();
    }
  });

  it('migrates OpenRouter from the injected native reader without changing auth.json', () => {
    const h = setup();
    try {
      const before = readFileSync(h.paths.authJsonPath);
      const result = migratePiSingleProvider('openrouter', h.paths, {
        keychain: h.keychain,
        readNativeOpenRouterKey: () => 'fixture-openrouter-key',
      });
      assert.equal(result.state, 'migrated');
      assert.equal(readFileSync(h.paths.authJsonPath).equals(before), true);
      assert.equal(hasManaged(h.keychain, 'openrouter'), true);
      rollbackPiSingleProvider('openrouter', h.paths, { keychain: h.keychain });
      assert.equal(hasManaged(h.keychain, 'openrouter'), false);
    } finally {
      h.cleanup();
    }
  });

  it('refuses writes whose Pi path is inside a git work tree', () => {
    const h = setup();
    try {
      execFileSync('git', ['init', '-q', h.dir]);
      assert.throws(() => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }), /git work tree/);
      assert.equal(hasManaged(h.keychain, 'xai'), false);
    } finally { h.cleanup(); }
  });

  it('treats only a definite native OpenRouter miss as not-applicable', () => {
    const h = setup();
    try {
      const missing = migratePiSingleProvider('openrouter', h.paths, { keychain: h.keychain, readNativeOpenRouterKey: () => { throw new NativeOpenRouterKeyNotFoundError('pi-openrouter'); } });
      assert.equal(missing.state, 'not-applicable');
      let writes = 0;
      assert.throws(() => migratePiSingleProvider('openrouter', h.paths, { keychain: h.keychain, store: { setConfig() { writes += 1; }, recordLineage() { return 0; }, upsertAccount() {} }, readNativeOpenRouterKey: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /denied/);
      assert.equal(writes, 0);
    } finally { h.cleanup(); }
  });

  it('classifies only a darwin security status 44 native miss as not-applicable', () => {
    const h = setup();
    try {
      const config = new Map<string, string>();
      const store = { setConfig(key: string, value: string) { config.set(key, value); }, recordLineage() { return 0; }, upsertAccount() {} };
      const missingExec: ExecFileSyncFn = markFakeExecutor((() => {
        throw { message: 'Command failed: /usr/bin/security find-generic-password -s pi-openrouter -w', status: 44, stderr: null };
      }) as ExecFileSyncFn);
      const result = migratePiSingleProvider('openrouter', h.paths, {
        keychain: h.keychain,
        store,
        readNativeOpenRouterKey: () => readNativeOpenRouterKey('pi-openrouter', missingExec, 'darwin'),
      });
      assert.equal(result.state, 'not-applicable');
      assert.equal(config.get('pi.openrouter.state'), 'not-applicable');

      const failureExec: ExecFileSyncFn = markFakeExecutor((() => {
        throw { message: 'Command failed: /usr/bin/security find-generic-password -s pi-openrouter -w', status: 1, stderr: null };
      }) as ExecFileSyncFn);
      config.clear();
      assert.throws(() => migratePiSingleProvider('openrouter', h.paths, {
        keychain: h.keychain,
        store,
        readNativeOpenRouterKey: () => readNativeOpenRouterKey('pi-openrouter', failureExec, 'darwin'),
      }), (error: unknown) => (error as { status?: number }).status === 1);
      assert.equal(config.size, 0);
    } finally { h.cleanup(); }
  });

  for (const racers of [2, 4]) {
    it(racers === 2 ? 'atomically admits only one racing stale-lock taker' : 'atomically admits only one of 4 racing stale-lock takers', async () => {
      const h = setup();
      try {
        const lock = `${h.paths.authJsonPath}.lock`; const owner = join(lock, 'qlb-lock-owner.json');
        mkdirSync(lock); writeFileSync(owner, JSON.stringify({ pid: 999_999, nonce: 'dead' }));
        utimesSync(lock, new Date(Date.now() - 2_000), new Date(Date.now() - 2_000));
        const results = await raceStaleLockTakers(h.paths, h.dir, racers);
        const detail = JSON.stringify(results);
        assert.equal(results.filter(({ output }) => output.includes('entered')).length, 1, detail);
        assert.equal(results.filter(({ code }) => code === 0).length, 1, detail);
      } finally { h.cleanup(); }
    });
  }

  it('restores a fresh lock moved after the stale check without evicting its holder', () => {
    const h = setup();
    const fsHooks = require('node:fs') as typeof import('node:fs');
    const lock = `${h.paths.authJsonPath}.lock`; const original = `${lock}.original-stale`; const fresh = { pid: process.pid, nonce: 'fresh-a' };
    try {
      const owner = join(lock, 'qlb-lock-owner.json');
      mkdirSync(lock); writeFileSync(owner, JSON.stringify({ pid: 999_999, nonce: 'dead' }));
      utimesSync(lock, new Date(Date.now() - 2_000), new Date(Date.now() - 2_000));
      const rename = fsHooks.renameSync; let injected = false;
      fsHooks.renameSync = ((from: string, to: string) => {
        if (!injected && from === lock && to.startsWith(`${lock}.stale-`)) {
          injected = true;
          rename(lock, original);
          const pending = `${lock}.pending-fresh-a`;
          writeFileSync(pending, JSON.stringify(fresh)); linkSync(pending, lock); unlinkSync(pending);
        }
        rename(from, to);
      }) as typeof fsHooks.renameSync;
      try {
        assert.throws(() => withPiAuthLock(h.paths.authJsonPath, () => assert.fail('preempted taker entered'), { staleMs: 10, retries: 0, retryMs: 1 }), (error: unknown) => (error as { code?: string }).code === 'pi-auth-locked');
      } finally { fsHooks.renameSync = rename; }
      assert.equal(injected, true);
      assert.deepEqual(JSON.parse(readFileSync(lock, 'utf8')), fresh, 'the fresh holder is restored');
      assert.throws(() => withPiAuthLock(h.paths.authJsonPath, () => assert.fail('second holder entered'), { staleMs: 10, retries: 0, retryMs: 1 }), (error: unknown) => (error as { code?: string }).code === 'pi-auth-locked');
    } finally { h.cleanup(); }
  });

  it('restores moved locks create-only when a third racer acquires the canonical path', () => {
    const h = setup();
    const fsHooks = require('node:fs') as typeof import('node:fs');
    const lock = `${h.paths.authJsonPath}.lock`; const original = `${lock}.original-stale`; const fresh = { pid: process.pid, nonce: 'fresh-a' }; const third = { pid: process.pid, nonce: 'fresh-c' };
    try {
      const owner = join(lock, 'qlb-lock-owner.json');
      mkdirSync(lock); writeFileSync(owner, JSON.stringify({ pid: 999_999, nonce: 'dead' }));
      utimesSync(lock, new Date(Date.now() - 2_000), new Date(Date.now() - 2_000));
      const rename = fsHooks.renameSync; const link = fsHooks.linkSync; let movedFreshLock = false; let thirdAcquired = false;
      fsHooks.renameSync = ((from: string, to: string) => {
        if (!movedFreshLock && from === lock && to.startsWith(`${lock}.stale-`)) {
          movedFreshLock = true;
          rename(lock, original);
          const pending = `${lock}.pending-fresh-a`;
          writeFileSync(pending, JSON.stringify(fresh)); link(pending, lock); unlinkSync(pending);
        }
        rename(from, to);
      }) as typeof fsHooks.renameSync;
      fsHooks.linkSync = ((from: string, to: string) => {
        if (movedFreshLock && !thirdAcquired && from.startsWith(`${lock}.stale-`) && to === lock) {
          thirdAcquired = true;
          const pending = `${lock}.pending-fresh-c`;
          writeFileSync(pending, JSON.stringify(third)); link(pending, lock); unlinkSync(pending);
        }
        link(from, to);
      }) as typeof fsHooks.linkSync;
      try {
        assert.throws(() => withPiAuthLock(h.paths.authJsonPath, () => assert.fail('preempted taker entered'), { staleMs: 10, retries: 0, retryMs: 1 }), (error: unknown) => (error as { code?: string }).code === 'pi-auth-locked');
      } finally { fsHooks.renameSync = rename; fsHooks.linkSync = link; }
      assert.equal(thirdAcquired, true);
      assert.deepEqual(JSON.parse(readFileSync(lock, 'utf8')), third, 'restore never replaces the third racer');
      assert.throws(() => withPiAuthLock(h.paths.authJsonPath, () => assert.fail('second holder entered'), { staleMs: 10, retries: 0, retryMs: 1 }), (error: unknown) => (error as { code?: string }).code === 'pi-auth-locked');
    } finally { h.cleanup(); }
  });

  it('allows one bounded refresh grace while a verifying reaper restores its identical owner record', () => {
    const h = setup();
    const fsHooks = require('node:fs') as typeof import('node:fs');
    const lock = `${h.paths.authJsonPath}.lock`;
    try {
      const stat = fsHooks.statSync; let injectEnoent = true; let entered = false;
      fsHooks.statSync = ((path: string) => {
        if (injectEnoent && path === lock) {
          injectEnoent = false;
          throw Object.assign(new Error('temporarily moved by reaper'), { code: 'ENOENT' });
        }
        return stat(path);
      }) as typeof fsHooks.statSync;
      try { withPiAuthLock(h.paths.authJsonPath, () => { entered = true; }, { retries: 0 }); } finally { fsHooks.statSync = stat; }
      assert.equal(entered, true, 'the identical owner record returned during the bounded grace');
    } finally { h.cleanup(); }
  });

  it('takes over only stale locks whose recorded owner is dead and never releases a foreign lock', () => {
    const h = setup();
    try {
      const lock = `${h.paths.authJsonPath}.lock`; const owner = join(lock, 'qlb-lock-owner.json');
      mkdirSync(lock); writeFileSync(owner, JSON.stringify({ pid: process.pid, nonce: 'alive' }));
      utimesSync(lock, new Date(Date.now() - 2_000), new Date(Date.now() - 2_000));
      assert.throws(() => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, authLockTiming: { staleMs: 10, retries: 0, retryMs: 1 } }), (error: unknown) => (error as { code?: string }).code === 'pi-auth-locked');
      rmSync(lock, { recursive: true });

      mkdirSync(lock); writeFileSync(owner, JSON.stringify({ pid: 999_999, nonce: 'dead' }));
      utimesSync(lock, new Date(Date.now() - 2_000), new Date(Date.now() - 2_000));
      assert.equal(migratePiSingleProvider('xai', h.paths, {
        keychain: h.keychain,
        authLockTiming: { staleMs: 10, retries: 0, retryMs: 1 },
      }).state, 'migrated');

      assert.throws(() => rollbackPiSingleProvider('xai', h.paths, {
        keychain: h.keychain,
        afterWrite: (point) => {
          if (point === 'owner-entry') writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'foreign' }));
        },
      }), /lock-lost/);
      assert.equal(existsSync(lock), true, 'a superseded holder must leave the new owner lock intact');
      assert.deepEqual(JSON.parse(readFileSync(lock, 'utf8')), { pid: process.pid, nonce: 'foreign' });
    } finally { h.cleanup(); }
  });

  it('keeps a pre-publication baseline byte-identical when Pi entry is malformed on resume', () => {
    const h = setup();
    try {
      assert.throws(() => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, afterWrite: (point) => { if (point === 'baseline') throw new Error('crash'); } }), /crash/);
      const baseline = join(h.paths.baselineDir, 'xai.json'); const before = readFileSync(baseline);
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ xai: { access: 'bad' } }));
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      assert.equal(readFileSync(baseline).equals(before), true);
      assert.equal(placeholderPresent(h.paths, 'xai'), true);
    } finally { h.cleanup(); }
  });

  it('restores the current managed credential when Pi entry is absent after a committed migration', () => {
    const h = setup();
    try {
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      const rotated = oauth('managed-new');
      h.keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(rotated));
      writeFileSync(h.paths.authJsonPath, '{}');
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).xai, rotated);
      assert.equal(hasManaged(h.keychain, 'xai'), false);
    } finally { h.cleanup(); }
  });

  it('falls back to the baseline only when the managed credential is absent', () => {
    const h = setup();
    try {
      const baseline = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).xai;
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      h.keychain.deleteSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT);
      writeFileSync(h.paths.authJsonPath, '{}');
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).xai, baseline);
    } finally { h.cleanup(); }
  });

  it('refuses rollback without deleting anything when neither credential source is usable', () => {
    const h = setup();
    try {
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      h.keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT, '{}');
      writeFileSync(join(h.paths.baselineDir, 'xai.json'), '{}');
      assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain }), /no managed or baseline/);
      assert.equal(hasManaged(h.keychain, 'xai'), true);
      const owner = JSON.parse(readFileSync(h.paths.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.xai);
    } finally { h.cleanup(); }
  });

  it('keeps migration finalization inside the auth lock against rollback', () => {
    const h = setup();
    try {
      const config = new Map<string, string>();
      const store = { setConfig(key: string, value: string) { config.set(key, value); }, recordLineage() { return 0; }, upsertAccount() {} };
      migratePiSingleProvider('xai', h.paths, {
        keychain: h.keychain,
        store,
        authLockTiming: { retries: 0, retryMs: 1 },
        afterWrite: (point) => {
          if (point === 'before-committed') {
            assert.throws(() => rollbackPiSingleProvider('xai', h.paths, {
              keychain: h.keychain,
              store,
              authLockTiming: { retries: 0, retryMs: 1 },
            }), (error: unknown) => (error as { code?: string }).code === 'pi-auth-locked');
          }
        },
      });
      assert.equal(placeholderPresent(h.paths, 'xai'), true);
      assert.equal(config.get('pi.xai.state'), 'migrated');
      assert.equal(hasManaged(h.keychain, 'xai'), true);
    } finally { h.cleanup(); }
  });

  it('recognizes the real macOS status-44 delete miss but rethrows a denial', () => {
    const h = setup();
    try {
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      let status = 44;
      const keychain = new MacosKeychainBackend({
        execFileSync: markFakeExecutor(((_file, args) => {
          if (args[0] === 'find-generic-password') return h.keychain.getSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT);
          throw Object.assign(new Error(status === 44
            ? 'Command failed: /usr/bin/security delete-generic-password -a qlb -s qlb:xai:default\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n'
            : 'Command failed: /usr/bin/security delete-generic-password -a qlb -s qlb:xai:default\nsecurity: User interaction is not allowed.\n'), { status });
        }) as ExecFileSyncFn),
      });
      assert.doesNotThrow(() => rollbackPiSingleProvider('xai', h.paths, { keychain }));
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      status = 1;
      assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain }), (error: unknown) => (error as { status?: number }).status === 1);
    } finally { h.cleanup(); }
  });

  it('keeps rollback state and journal until a failed managed deletion can be retried', () => {
    const h = setup();
    try {
      const config = new Map<string, string>();
      const store = { setConfig(key: string, value: string) { config.set(key, value); }, recordLineage() { return 0; }, upsertAccount() {} };
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store });
      const journal = join(h.paths.journalPath, 'pi-migrate-xai.json');
      mkdirSync(h.paths.journalPath, { recursive: true });
      writeFileSync(journal, JSON.stringify({ provider: 'xai', phase: 'committed', ownerPid: process.pid, updatedAt: Date.now() }));
      let denied = true;
      const keychain = {
        getSync: h.keychain.getSync.bind(h.keychain),
        setSync: h.keychain.setSync.bind(h.keychain),
        deleteSync(service: string, account: string) {
          if (denied) throw Object.assign(new Error('keychain delete denied'), { status: 1 });
          h.keychain.deleteSync(service, account);
        },
      };
      assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain, store }), /denied/);
      assert.equal(config.get('pi.xai.state'), 'migrated');
      assert.equal(existsSync(journal), true);
      assert.equal(hasManaged(h.keychain, 'xai'), true);
      denied = false;
      rollbackPiSingleProvider('xai', h.paths, { keychain, store });
      assert.equal(hasManaged(h.keychain, 'xai'), false);
      assert.equal(config.get('pi.xai.state'), '');
      assert.equal(existsSync(journal), false);
    } finally { h.cleanup(); }
  });

  it('does not overwrite a new native credential on a repeated rollback', () => {
    const h = setup();
    try {
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain });
      const reauthed = oauth('new-native');
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ xai: reauthed }));
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).xai, reauthed);
      assert.equal(hasManaged(h.keychain, 'xai'), false);
    } finally { h.cleanup(); }
  });

  it('is re-runnable after a crash after rollback owner removal', () => {
    const h = setup();
    try {
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, afterWrite: (point) => { if (point === 'owner-entry') throw new Error('crash'); } }), /crash/);
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain });
      assert.equal(placeholderPresent(h.paths, 'xai'), false);
    } finally { h.cleanup(); }
  });

  it('resolves a symlinked auth target before the git worktree check', () => {
    const h = setup(); const target = mkdtempSync(join(tmpdir(), 'qlb-pi-target-'));
    try {
      execFileSync('git', ['init', '-q', target]);
      const targetAuth = join(target, 'auth.json'); writeFileSync(targetAuth, JSON.stringify({ xai: oauth('native') }));
      rmSync(h.paths.authJsonPath); symlinkSync(targetAuth, h.paths.authJsonPath);
      assert.throws(() => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }), /git work tree/);
      assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain }), /git work tree/);
    } finally { h.cleanup(); rmSync(target, { recursive: true, force: true }); }
  });
});
