import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { MacosKeychainBackend, markFakeExecutor, MockKeychain, NativeOpenRouterKeyNotFoundError, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, readNativeOpenRouterKey, type ExecFileSyncFn } from '../src/keychain';
import { openStore } from '../src/store';
import { ADAPTER_ACCOUNT_IDS } from '../src/migration';
import { sharedSingleGrantCoords } from '../src/single-grant-ownership';
import {
  defaultPiMigratePaths,
  hasLegacyPiOwnerEntry,
  withPiAuthLock,
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
  store: ReturnType<typeof openStore>;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-pi-migrate-'));
  const paths = defaultPiMigratePaths(dir);
  mkdirSync(join(dir, '.pi', 'agent'), { recursive: true, mode: 0o700 });
  writeFileSync(paths.authJsonPath, JSON.stringify({ [provider]: oauth('native') }), { mode: 0o600 });
  const store = openStore(join(dir, 'qlb.db'));
  return {
    dir,
    paths,
    keychain: new MockKeychain(),
    provider,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
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

function writePiJournal(paths: PiMigratePaths, provider: PiSingleProvider, phase: string): void {
  mkdirSync(paths.journalPath, { recursive: true, mode: 0o700 });
  writeFileSync(join(paths.journalPath, `pi-migrate-${provider}.json`), JSON.stringify({ provider, phase, ownerPid: process.pid, updatedAt: Date.now() }), { mode: 0o600 });
}

function plantKeptGenericCopy(
  h: ReturnType<typeof setup>,
  provider: Exclude<PiSingleProvider, 'openrouter'>,
): { service: string; account: string; stashService: string; kept: string } {
  const { service, account } = sharedSingleGrantCoords(provider);
  const cleanedAt = Date.UTC(2026, 9, 30, 12, 0, 0);
  const kept = JSON.stringify(oauth(`kept-${provider}`));
  h.keychain.setSync(service, account, kept);
  h.store.upsertMigration(`pi-${provider}`, 'NATIVE', JSON.stringify({
    accounts: [{ id: ADAPTER_ACCOUNT_IDS[provider], provider, label: provider, keychain: { service, account } }],
    lastRollback: { keychainDisposition: 'keep', cleanedAt },
  }));
  return { service, account, stashService: `qlb:${provider}:unclaimed:${new Date(cleanedAt).toISOString()}`, kept };
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

  it('T-PM1: refuses unless the generic migration is at rest', () => {
    const cases: Array<{ name: string; state?: string; detail?: Record<string, unknown>; file?: 'staging' | 'sidecar' | 'custom' | 'customStaging' }> = [
      { name: 'absent' },
      { name: 'NATIVE', state: 'NATIVE' },
      { name: 'VALIDATED without staging', state: 'VALIDATED' },
      { name: 'MIRRORED', state: 'MIRRORED' },
      { name: 'VALIDATED with staging', state: 'VALIDATED', file: 'staging' },
      { name: 'QLB_OWNED', state: 'QLB_OWNED' },
      { name: 'RETIRED', state: 'RETIRED' },
      { name: 'legacy sidecar', state: 'VALIDATED', file: 'sidecar' },
      { name: 'custom owner', state: 'VALIDATED', detail: { ownerFilePath: 'custom' }, file: 'custom' },
      { name: 'custom owner staging', state: 'VALIDATED', detail: { ownerFilePath: 'custom' }, file: 'customStaging' },
      { name: 'rollback intent', state: 'VALIDATED', detail: { intent: 'rollback' } },
      { name: 'rollback decision', state: 'VALIDATED', detail: { rollbackDecision: {} } },
      { name: 'hand-back marker', state: 'VALIDATED', detail: { handback: {} } },
    ];

    for (const fixture of cases) {
      const h = setup();
      try {
        const paths = {
          staging: join(h.dir, '.pi', 'agent', 'qlb-owner.json.xai.staging'),
          sidecar: join(h.dir, '.pi', 'agent', 'qlb-owner-xai.json'),
          custom: join(h.dir, 'custom-owner-dir', 'custom-owner.json'),
          customStaging: join(h.dir, 'custom-owner-dir', 'qlb-owner.json.xai.staging'),
        };
        const detail = fixture.detail?.ownerFilePath === 'custom'
          ? { ownerFilePath: paths.custom }
          : fixture.detail;
        if (fixture.state) h.store.upsertMigration('pi-xai', fixture.state, JSON.stringify(detail ?? {}));
        if (fixture.file) {
          mkdirSync(dirname(paths[fixture.file]), { recursive: true, mode: 0o700 });
          writeFileSync(paths[fixture.file], '{}', { mode: 0o600 });
        }
        const authBefore = readFileSync(h.paths.authJsonPath);
        const journal = join(h.paths.journalPath, 'pi-migrate-xai.json');
        const admitted = fixture.state === undefined || fixture.state === 'NATIVE' || (fixture.state === 'VALIDATED' && !fixture.file && !fixture.detail);
        if (admitted) {
          assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated', fixture.name);
        } else {
          assert.throws(
            () => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }),
            (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'owned-by-generic-migrate' && (error as { exitCode?: unknown }).exitCode === 3,
            fixture.name,
          );
          assert.equal(readFileSync(h.paths.authJsonPath).equals(authBefore), true, `${fixture.name}: auth.json changed`);
          assert.equal(existsSync(journal), false, `${fixture.name}: Pi journal written`);
          assert.equal(hasManaged(h.keychain, 'xai'), false, `${fixture.name}: managed credential written`);
        }
      } finally { h.cleanup(); }
    }
  });

  for (const provider of ['xai', 'kimi-coding'] as const) {
    it(`${provider}: T-PR2: pi migrate over a generic hand-back that kept its copy`, () => {
      const h = setup(provider);
      try {
        const kept = plantKeptGenericCopy(h, provider);
        const native = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8'))[provider];
        assert.equal(migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
        assert.equal(h.keychain.getSync(kept.stashService, kept.account), kept.kept);
        assert.deepEqual(JSON.parse(h.keychain.getSync(kept.service, kept.account)), native);
      } finally { h.cleanup(); }
    });

    it(`${provider}: T-PR2b: pi migrate over a kept copy re-runs after a crash at each step to the same end state`, () => {
      for (const crash of ['stash', 'overwrite'] as const) {
        const h = setup(provider);
        try {
          const kept = plantKeptGenericCopy(h, provider);
          const native = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8'))[provider];
          let stashWrites = 0;
          let crashAfterStashRead = crash === 'stash';
          const keychain = {
            setSync(service: string, account: string, value: string) {
              if (service === kept.stashService && account === kept.account) stashWrites += 1;
              h.keychain.setSync(service, account, value);
            },
            getSync(service: string, account: string) {
              const value = h.keychain.getSync(service, account);
              if (crashAfterStashRead && service === kept.stashService && account === kept.account) {
                crashAfterStashRead = false;
                throw new Error('injected crash');
              }
              return value;
            },
            deleteSync: h.keychain.deleteSync.bind(h.keychain),
          };
          assert.throws(() => migratePiSingleProvider(provider, h.paths, {
            keychain,
            store: h.store,
            afterWrite: (point) => { if (crash === 'overwrite' && point === 'credential-saved') throw new Error('injected crash'); },
          }), /injected crash/, crash);
          assert.equal(h.keychain.getSync(kept.stashService, kept.account), kept.kept, `${crash}: stash preserves the kept copy`);
          assert.equal(migratePiSingleProvider(provider, h.paths, { keychain, store: h.store }).state, 'migrated', crash);
          assert.equal(stashWrites, 1, `${crash}: exactly one stash`);
          assert.equal(h.keychain.getSync(kept.stashService, kept.account), kept.kept, `${crash}: stash remains the kept copy`);
          assert.deepEqual(JSON.parse(h.keychain.getSync(kept.service, kept.account)), native, `${crash}: shared item is Pi's entry`);
        } finally { h.cleanup(); }
      }
    });

    it(`${provider}: pi migrate after migrate, pi rollback and a kept-copy stash finishes without reading the absent item`, () => {
      const h = setup(provider);
      try {
        const kept = plantKeptGenericCopy(h, provider);
        const native = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8'))[provider];
        assert.equal(migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
        rollbackPiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store });
        assert.equal(hasManaged(h.keychain, provider), false, 'pi rollback removed the shared item');
        const sharedOps: string[] = [];
        let stashWrites = 0;
        const keychain = {
          setSync(service: string, account: string, value: string) {
            if (service === kept.service && account === kept.account) sharedOps.push('set');
            if (service === kept.stashService) stashWrites += 1;
            h.keychain.setSync(service, account, value);
          },
          getSync(service: string, account: string) {
            if (service === kept.service && account === kept.account) sharedOps.push('get');
            return h.keychain.getSync(service, account);
          },
          deleteSync: h.keychain.deleteSync.bind(h.keychain),
        };
        assert.equal(migratePiSingleProvider(provider, h.paths, { keychain, store: h.store }).state, 'migrated');
        assert.equal(sharedOps[0], 'set', 'the absent shared item is not read before the write');
        assert.equal(stashWrites, 0, 'no second stash');
        assert.equal(h.keychain.getSync(kept.stashService, kept.account), kept.kept);
        assert.deepEqual(JSON.parse(h.keychain.getSync(kept.service, kept.account)), native);
      } finally { h.cleanup(); }
    });

    it(`${provider}: pi migrate over a kept hand-back whose shared item is already gone finishes with no stash`, () => {
      const h = setup(provider);
      try {
        const kept = plantKeptGenericCopy(h, provider);
        h.keychain.deleteSync(kept.service, kept.account);
        const native = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8'))[provider];
        assert.equal(migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
        assert.throws(() => h.keychain.getSync(kept.stashService, kept.account), /item not found/);
        assert.deepEqual(JSON.parse(h.keychain.getSync(kept.service, kept.account)), native);
      } finally { h.cleanup(); }
    });

    it(`${provider}: pi migrate refuses a kept hand-back whose journal account cannot be resolved and writes nothing`, () => {
      for (const variant of ['extra-keychain-field', 'no-accounts'] as const) {
        const h = setup(provider);
        try {
          const kept = plantKeptGenericCopy(h, provider);
          const detail = JSON.parse(h.store.getMigration(`pi-${provider}`)!.detail_json) as { accounts?: Array<{ keychain: Record<string, unknown> }> };
          if (variant === 'extra-keychain-field') detail.accounts![0].keychain.extra = 'x';
          else delete detail.accounts;
          h.store.upsertMigration(`pi-${provider}`, 'NATIVE', JSON.stringify(detail));
          const authBefore = readFileSync(h.paths.authJsonPath, 'utf8');
          assert.throws(
            () => migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }),
            (error: unknown) => (error as { code?: unknown }).code === 'journal-keychain-invalid' && (error as { exitCode?: unknown }).exitCode === 3,
            variant,
          );
          assert.equal(h.keychain.getSync(kept.service, kept.account), kept.kept, `${variant}: kept copy untouched`);
          assert.throws(() => h.keychain.getSync(kept.stashService, kept.account), /item not found/, `${variant}: no stash`);
          assert.equal(readFileSync(h.paths.authJsonPath, 'utf8'), authBefore, `${variant}: auth.json untouched`);
          assert.equal(existsSync(join(h.paths.journalPath, `pi-migrate-${provider}.json`)), false, `${variant}: no P7a journal`);
          assert.equal(existsSync(h.paths.ownerPath), false, `${variant}: no owner entry`);
        } finally { h.cleanup(); }
      }
    });

    it(`${provider}: pi migrate that refuses before writing leaves no stash`, () => {
      const h = setup(provider);
      try {
        const kept = plantKeptGenericCopy(h, provider);
        writeFileSync(h.paths.authJsonPath, JSON.stringify({ [provider]: { type: 'oauth', access: 'qlb-managed', refresh: '', expires: Date.now() + 60_000 } }), { mode: 0o600 });
        assert.throws(() => migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }), /baseline would be a placeholder/);
        assert.throws(() => h.keychain.getSync(kept.stashService, kept.account), /item not found/, 'no stash');
        assert.equal(h.keychain.getSync(kept.service, kept.account), kept.kept, 'kept copy untouched');
      } finally { h.cleanup(); }
    });

    it(`${provider}: pi migrate over a kept copy that crashed after its journal and before the stash still stashes on re-run`, () => {
      const h = setup(provider);
      try {
        const kept = plantKeptGenericCopy(h, provider);
        const native = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8'))[provider];
        assert.throws(() => migratePiSingleProvider(provider, h.paths, {
          keychain: h.keychain,
          store: h.store,
          afterWrite: (point) => { if (point === 'baseline') throw new Error('injected crash'); },
        }), /injected crash/);
        assert.equal(h.keychain.getSync(kept.service, kept.account), kept.kept, 'the crash left the kept copy in place');
        assert.equal(migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
        assert.equal(h.keychain.getSync(kept.stashService, kept.account), kept.kept, 'the kept copy is stashed');
        assert.deepEqual(JSON.parse(h.keychain.getSync(kept.service, kept.account)), native);
      } finally { h.cleanup(); }
    });

    it(`${provider}: a stash whose verify read differs is removed and pi migrate refuses without overwriting`, () => {
      const h = setup(provider);
      try {
        const kept = plantKeptGenericCopy(h, provider);
        const native = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8'))[provider];
        let corrupt = true;
        const keychain = {
          setSync(service: string, account: string, value: string) {
            if (corrupt && service === kept.stashService) { corrupt = false; value = value.slice(0, 10); }
            h.keychain.setSync(service, account, value);
          },
          getSync: h.keychain.getSync.bind(h.keychain),
          deleteSync: h.keychain.deleteSync.bind(h.keychain),
        };
        assert.throws(
          () => migratePiSingleProvider(provider, h.paths, { keychain, store: h.store }),
          (error: unknown) => (error as { code?: unknown }).code === 'kept-copy-stash-unverified' && (error as { exitCode?: unknown }).exitCode === 3,
        );
        assert.throws(() => h.keychain.getSync(kept.stashService, kept.account), /item not found/, 'the unverified stash is removed');
        assert.equal(h.keychain.getSync(kept.service, kept.account), kept.kept, 'the kept copy is not overwritten');
        assert.equal(migratePiSingleProvider(provider, h.paths, { keychain, store: h.store }).state, 'migrated', 're-run');
        assert.equal(h.keychain.getSync(kept.stashService, kept.account), kept.kept, 're-run stashes the kept copy');
        assert.deepEqual(JSON.parse(h.keychain.getSync(kept.service, kept.account)), native);
      } finally { h.cleanup(); }
    });
  }

  it('T-PM2: marks only the shared handed-back account row active', () => {
    for (const { provider, accountId } of [
      { provider: 'xai' as const, accountId: 'xai-default' },
      { provider: 'kimi-coding' as const, accountId: 'kimi-default' },
    ]) {
      const h = setup(provider);
      try {
        h.store.upsertAccount(accountId, provider, provider, 'handed-back');
        h.store.setAccountStatus(accountId, 'handed-back');
        assert.equal(h.store.getAccount(accountId)?.status, 'handed-back');

        assert.equal(migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
        assert.equal(h.store.getAccount(accountId)?.status, 'active');
      } finally { h.cleanup(); }
    }
  });

  it('kimi-coding upserts kimi-default, never kimi-coding-default', () => {
    const h = setup('kimi-coding');
    try {
      assert.equal(migratePiSingleProvider('kimi-coding', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
      assert.equal(h.store.getAccount('kimi-default')?.status, 'active');
      assert.equal(h.store.getAccount('kimi-coding-default'), null);
    } finally { h.cleanup(); }
  });

  it('keeps auth_revoked on fresh and idempotent already-migrated runs', () => {
    for (const alreadyMigrated of [false, true]) {
      const h = setup();
      try {
        if (alreadyMigrated) {
          migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store });
        }
        h.store.upsertAccount('xai-default', 'xai', 'xai', 'auth_revoked');
        h.store.setAccountStatus('xai-default', 'auth_revoked');

        assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
        assert.equal(h.store.getAccount('xai-default')?.status, 'auth_revoked');
      } finally { h.cleanup(); }
    }
  });

  it('keeps validated account rows validated', () => {
    const h = setup();
    try {
      h.store.upsertAccount('xai-default', 'xai', 'xai', 'validated');
      h.store.setAccountStatus('xai-default', 'validated');

      assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
      assert.equal(h.store.getAccount('xai-default')?.status, 'validated');
    } finally { h.cleanup(); }
  });

  it('keeps completed xai and OpenRouter migrations idempotent', () => {
    const xai = setup();
    try {
      assert.equal(migratePiSingleProvider('xai', xai.paths, { keychain: xai.keychain, store: xai.store }).state, 'migrated');
      assert.equal(migratePiSingleProvider('xai', xai.paths, { keychain: xai.keychain, store: xai.store }).state, 'migrated');
    } finally { xai.cleanup(); }

    const openrouter = setup();
    try {
      const deps = { keychain: openrouter.keychain, store: openrouter.store, readNativeOpenRouterKey: () => 'fixture-openrouter-key' };
      assert.equal(migratePiSingleProvider('openrouter', openrouter.paths, deps).state, 'migrated');
      assert.equal(migratePiSingleProvider('openrouter', openrouter.paths, deps).state, 'migrated');
    } finally { openrouter.cleanup(); }
  });

  for (const provider of ['xai', 'openrouter'] as const) {
    it(`${provider}: resumes a crash at the publishing and owner-entry boundaries`, () => {
      for (const point of ['publishing', 'owner-entry'] as const) {
        const h = setup();
        try {
          const deps = provider === 'openrouter'
            ? { keychain: h.keychain, store: h.store, readNativeOpenRouterKey: () => 'fixture-openrouter-key' }
            : { keychain: h.keychain, store: h.store };
          assert.throws(() => migratePiSingleProvider(provider, h.paths, {
            ...deps,
            afterWrite: (written: string) => {
              if (written === point) throw new Error('injected crash');
            },
          }), /injected crash/, point);
          const journal = JSON.parse(readFileSync(join(h.paths.journalPath, `pi-migrate-${provider}.json`), 'utf8')) as { phase?: unknown };
          assert.equal(journal.phase, 'publishing', `${point}: publish intent is durable`);
          assert.equal(existsSync(h.paths.ownerPath), point === 'owner-entry', `${point}: owner entry publication boundary`);
          assert.equal(migratePiSingleProvider(provider, h.paths, deps).state, 'migrated', point);
          assert.equal(placeholderPresent(h.paths, provider), provider !== 'openrouter', point);
        } finally { h.cleanup(); }
      }
    });
  }

  it('keeps the baseline byte-identical across an interrupted completed-migration re-run', () => {
    const h = setup();
    try {
      assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
      const baseline = join(h.paths.baselineDir, 'xai.json'); const before = readFileSync(baseline);
      assert.throws(() => migratePiSingleProvider('xai', h.paths, {
        keychain: h.keychain,
        store: h.store,
        afterWrite: (point) => { if (point === 'before-committed') throw new Error('injected crash'); },
      }), /injected crash/);
      assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-xai.json')), false, 'idempotent re-run writes no journal');
      assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
      assert.equal(readFileSync(baseline).equals(before), true, 'a re-run must not replace the native baseline');
    } finally { h.cleanup(); }
  });

  it('xai: a publishing resume reinstalls and verifies a lost managed item before publishing', () => {
    const h = setup();
    try {
      assert.throws(() => migratePiSingleProvider('xai', h.paths, {
        keychain: h.keychain,
        store: h.store,
        afterWrite: (point: string) => { if (point === 'publishing') throw new Error('injected crash'); },
      }), /injected crash/);
      h.keychain.deleteSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT);
      assert.equal(hasManaged(h.keychain, 'xai'), false);
      assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
      assert.equal(hasManaged(h.keychain, 'xai'), true, 'resume reinstalled the managed item before publication');
    } finally { h.cleanup(); }
  });

  it('a foreign owner entry does not count as already migrated over a placeholder', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ xai: { type: 'oauth', access: 'qlb-managed', refresh: '' } }), { mode: 0o600 });
      mkdirSync(dirname(h.paths.ownerPath), { recursive: true });
      writeFileSync(h.paths.ownerPath, JSON.stringify({ providers: { xai: { mode: 'manual' } } }), { mode: 0o600 });
      assert.throws(
        () => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }),
        /Pi xai baseline would be a placeholder/,
      );
      assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-xai.json')), false);
      assert.equal(h.store.getConfig('pi.xai.state'), null);
    } finally { h.cleanup(); }
  });

  it('xai: a publishing resume with the owner entry visible keeps a rotated managed item', () => {
    const h = setup();
    try {
      assert.throws(() => migratePiSingleProvider('xai', h.paths, {
        keychain: h.keychain,
        store: h.store,
        afterWrite: (point: string) => { if (point === 'owner-entry') throw new Error('injected crash'); },
      }), /injected crash/);
      const service = qlbKeychainService('xai', 'default');
      const rotated = { ...(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT)) as Record<string, unknown>), refresh: 'rotated-refresh', access: 'rotated-access' };
      h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(rotated));
      assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
      const after = JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT)) as { refresh?: string };
      assert.equal(after.refresh, 'rotated-refresh', 'a published, rotated managed item is never replaced by the baseline');
    } finally { h.cleanup(); }
  });

  it('xai: a publishing resume with the owner entry visible fails closed on a Keychain read error', () => {
    const h = setup();
    try {
      assert.throws(() => migratePiSingleProvider('xai', h.paths, {
        keychain: h.keychain,
        store: h.store,
        afterWrite: (point: string) => { if (point === 'owner-entry') throw new Error('injected crash'); },
      }), /injected crash/);
      const service = qlbKeychainService('xai', 'default');
      const rotated = JSON.stringify({ ...(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT)) as Record<string, unknown>), refresh: 'rotated-refresh', access: 'rotated-access' });
      h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, rotated);
      const flaky = {
        setSync: (s: string, a: string, v: string) => h.keychain.setSync(s, a, v),
        getSync: (s: string, a: string): string => { if (s === service) throw new Error('security: keychain read timed out'); return h.keychain.getSync(s, a); },
        deleteSync: (s: string, a: string) => h.keychain.deleteSync(s, a),
      } as unknown as typeof h.keychain;
      assert.throws(() => migratePiSingleProvider('xai', h.paths, { keychain: flaky, store: h.store }), /timed out/);
      assert.equal(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), rotated, 'a read error never reinstalls the baseline over the managed item');
    } finally { h.cleanup(); }
  });

  for (const damage of ['lost', 'corrupt'] as const) {
    it(`xai: a publishing resume with the owner entry visible reinstalls a ${damage} managed item from the baseline`, () => {
      const h = setup();
      try {
        assert.throws(() => migratePiSingleProvider('xai', h.paths, {
          keychain: h.keychain,
          store: h.store,
          afterWrite: (point: string) => { if (point === 'owner-entry') throw new Error('injected crash'); },
        }), /injected crash/);
        const service = qlbKeychainService('xai', 'default');
        if (damage === 'lost') h.keychain.deleteSync(service, QLB_KEYCHAIN_ACCOUNT);
        else h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, 'not-json');
        assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
        const after = JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT)) as { refresh?: string };
        assert.equal(after.refresh, 'refresh-native', 'the baseline was reinstalled');
        assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-xai.json')), false, 'the migration committed');
      } finally { h.cleanup(); }
    });
  }

  it('refuses a placeholder auth entry with no journal before writing anything', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ xai: { type: 'oauth', access: 'qlb-managed', refresh: '' } }), { mode: 0o600 });
      assert.throws(
        () => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }),
        /Pi xai baseline would be a placeholder; run qlb pi rollback or restore auth\.json/,
      );
      assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-xai.json')), false, 'no stray started journal');
      assert.equal(existsSync(join(h.paths.baselineDir, 'xai.json')), false);
    } finally { h.cleanup(); }
  });

  it('refuses a placeholder baseline without writing a baseline file', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ xai: { type: 'oauth', access: 'qlb-managed', refresh: '' } }), { mode: 0o600 });
      writePiJournal(h.paths, 'xai', 'started');
      const baseline = join(h.paths.baselineDir, 'xai.json');
      assert.throws(
        () => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }),
        /Pi xai baseline would be a placeholder; run qlb pi rollback or restore auth\.json/,
      );
      assert.equal(existsSync(baseline), false);
    } finally { h.cleanup(); }
  });

  it('refuses a canonical claim with only a pre-publication P7a journal', () => {
    for (const phase of ['started', 'baseline', 'credential-saved'] as const) {
      const h = setup();
      try {
        writeFileSync(h.paths.ownerPath, JSON.stringify({ providers: { xai: { mode: 'qlb' } } }), { mode: 0o600 });
        writePiJournal(h.paths, 'xai', phase);
        assert.throws(
          () => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }),
          (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'owned-by-generic-migrate' && (error as { exitCode?: unknown }).exitCode === 3,
          phase,
        );
      } finally { h.cleanup(); }
    }
  });

  it('decides a canonical claim from the journal re-read inside the auth lock', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.ownerPath, JSON.stringify({ providers: { xai: { mode: 'qlb' } } }), { mode: 0o600 });
      writePiJournal(h.paths, 'xai', 'credential-saved');
      assert.throws(
        () => migratePiSingleProvider('xai', h.paths, {
          keychain: h.keychain,
          withAuthLock: (path, fn) => {
            writePiJournal(h.paths, 'xai', 'started');
            return withPiAuthLock(path, fn);
          },
        }),
        (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'owned-by-generic-migrate' && (error as { exitCode?: unknown }).exitCode === 3,
      );
      assert.equal(hasManaged(h.keychain, 'xai'), false);
    } finally { h.cleanup(); }
  });

  it('refuses generic ownership artifacts even without a migration row', () => {
    for (const fixture of ['staging', 'legacy sidecar', 'canonical owner claim', 'nothing'] as const) {
      const h = setup();
      try {
        if (fixture === 'staging') writeFileSync(join(h.dir, '.pi', 'agent', 'qlb-owner.json.xai.staging'), '{}', { mode: 0o600 });
        if (fixture === 'legacy sidecar') writeFileSync(join(h.dir, '.pi', 'agent', 'qlb-owner-xai.json'), '{}', { mode: 0o600 });
        if (fixture === 'canonical owner claim') writeFileSync(h.paths.ownerPath, JSON.stringify({ providers: { xai: { mode: 'qlb' } } }), { mode: 0o600 });
        if (fixture === 'nothing') {
          assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }).state, 'migrated', fixture);
        } else {
          assert.throws(
            () => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }),
            (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'owned-by-generic-migrate' && (error as { exitCode?: unknown }).exitCode === 3,
            fixture,
          );
        }
      } finally { h.cleanup(); }
    }
  });

  it('T-OW1: refuses when generic stage publishes before the Pi auth lock is acquired', () => {
    const h = setup();
    try {
      const staging = join(h.dir, '.pi', 'agent', 'qlb-owner.json.xai.staging');
      const authBefore = readFileSync(h.paths.authJsonPath);
      assert.throws(() => migratePiSingleProvider('xai', h.paths, {
        keychain: h.keychain,
        store: h.store,
        withAuthLock: (path, fn) => {
          h.store.upsertMigration('pi-xai', 'MIRRORED', '{}');
          writeFileSync(staging, '{}', { mode: 0o600 });
          return withPiAuthLock(path, fn);
        },
      }), (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'owned-by-generic-migrate' && (error as { exitCode?: unknown }).exitCode === 3);
      assert.equal(readFileSync(h.paths.authJsonPath).equals(authBefore), true);
      assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-xai.json')), false);
      assert.equal(hasManaged(h.keychain, 'xai'), false);
    } finally { h.cleanup(); }
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
      assert.throws(() => migratePiSingleProvider('openrouter', h.paths, { keychain: h.keychain, store: { getMigration() { return null; }, getConfig() { return null; }, setConfig() { writes += 1; }, recordLineage() { return 0; }, upsertAccount() {}, getAccount() { return null; }, setAccountStatus() {} }, readNativeOpenRouterKey: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /denied/);
      assert.equal(writes, 0);
    } finally { h.cleanup(); }
  });

  it('classifies only a darwin security status 44 native miss as not-applicable', () => {
    const h = setup();
    try {
      const config = new Map<string, string>();
      const store = { getMigration() { return null; }, getConfig(key: string) { return config.get(key) ?? null; }, setConfig(key: string, value: string) { config.set(key, value); }, recordLineage() { return 0; }, upsertAccount() {}, getAccount() { return null; }, setAccountStatus() {} };
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

  it('atomically admits only one racing stale-lock taker', async () => {
    const h = setup();
    try {
      const lock = `${h.paths.authJsonPath}.lock`; const owner = join(lock, 'qlb-lock-owner.json');
      mkdirSync(lock); writeFileSync(owner, JSON.stringify({ pid: 999_999, nonce: 'dead' }));
      utimesSync(lock, new Date(Date.now() - 2_000), new Date(Date.now() - 2_000));
      const modulePath = join(process.cwd(), 'dist-test', 'src', 'pi-migrate.js');
      const startAt = Date.now() + 200;
      const child = () => new Promise<{ code: number | null; output: string }>((resolveChild, rejectChild) => {
        const proc = spawn(process.execPath, ['-e', `
          const { migratePiSingleProvider } = require(process.env.PI_MIGRATE_MODULE);
          const paths = JSON.parse(process.env.PI_MIGRATE_PATHS);
          const until = Number(process.env.PI_MIGRATE_START);
          while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
          let value = '';
          const keychain = { setSync(_s, _a, v) { value = v; }, getSync() { return value; }, deleteSync() {} };
          try {
            migratePiSingleProvider('xai', paths, { keychain, authLockTiming: { staleMs: 10, retries: 0, retryMs: 1 }, afterWrite(point) {
              if (point === 'owner-entry') { process.stdout.write('entered\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
            } });
            process.exitCode = 0;
          } catch (error) { process.stdout.write(String(error.code || error.message)); process.exitCode = 1; }
        `], {
          env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: h.dir, HOME: h.dir, PI_MIGRATE_MODULE: modulePath, PI_MIGRATE_PATHS: JSON.stringify(h.paths), PI_MIGRATE_START: String(startAt) },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let output = '';
        proc.stdout.on('data', (chunk) => { output += String(chunk); });
        proc.once('error', rejectChild);
        proc.once('close', (code) => resolveChild({ code, output }));
      });
      const results = await Promise.all([child(), child()]);
      const detail = JSON.stringify(results);
      const winners = results.filter(({ output }) => output.includes('entered'));
      assert.ok(winners.length <= 1, detail);
      for (const result of results) {
        if (!result.output.includes('entered')) {
          assert.equal(result.code, 1, detail);
          assert.match(result.output, /pi-auth-locked/, detail);
        }
      }
      assert.equal(existsSync(lock), false, `finished racers left a lock behind: ${detail}`);
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
          if (point === 'owner-entry') writeFileSync(owner, JSON.stringify({ pid: process.pid, nonce: 'foreign' }));
        },
      }), /lock-lost/);
      assert.equal(existsSync(lock), true, 'a superseded holder must leave the new owner lock intact');
      assert.deepEqual(JSON.parse(readFileSync(owner, 'utf8')), { pid: process.pid, nonce: 'foreign' });
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
      const store = { getMigration() { return null; }, getConfig(key: string) { return config.get(key) ?? null; }, setConfig(key: string, value: string) { config.set(key, value); }, recordLineage() { return 0; }, upsertAccount() {}, getAccount() { return null; }, setAccountStatus() {} };
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
      const store = { getMigration() { return null; }, getConfig(key: string) { return config.get(key) ?? null; }, setConfig(key: string, value: string) { config.set(key, value); }, recordLineage() { return 0; }, upsertAccount() {}, getAccount() { return null; }, setAccountStatus() {} };
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
