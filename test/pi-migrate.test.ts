import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MockKeychain, NativeOpenRouterKeyNotFoundError, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import {
  defaultPiMigratePaths,
  migratePiSingleProvider,
  rollbackPiSingleProvider,
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

  it('recovers stale auth locks and rejects fresh ones for migrate and rollback', () => {
    const h = setup();
    try {
      const lock = `${h.paths.authJsonPath}.lock`;
      mkdirSync(lock); utimesSync(lock, new Date(Date.now() - 2_000), new Date(Date.now() - 2_000));
      assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, authLockTiming: { staleMs: 10, retries: 0, retryMs: 1 } }).state, 'migrated');
      mkdirSync(lock); assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, authLockTiming: { staleMs: 60_000, retries: 0, retryMs: 1 } }), (error: unknown) => (error as { code?: string }).code === 'pi-auth-locked');
      rmSync(lock, { recursive: true });
      mkdirSync(lock); utimesSync(lock, new Date(Date.now() - 2_000), new Date(Date.now() - 2_000));
      assert.doesNotThrow(() => rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, authLockTiming: { staleMs: 10, retries: 0, retryMs: 1 } }));
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

  it('does not overwrite a new native credential on a repeated rollback', () => {
    const h = setup();
    try {
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain });
      const reauthed = oauth('new-native');
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ xai: reauthed }));
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).xai, reauthed);
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
