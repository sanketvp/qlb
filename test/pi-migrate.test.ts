import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { MacosKeychainBackend, markFakeExecutor, MockKeychain, NativeOpenRouterKeyNotFoundError, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, readNativeOpenRouterKey, type ExecFileSyncFn } from '../src/keychain';
import { openStore } from '../src/store';
import { ADAPTER_ACCOUNT_IDS } from '../src/migration';
import { sharedSingleGrantCoords } from '../src/single-grant-ownership';
import { exitCodeForError, runExecutingCommand } from '../src/cli';
import { executePiRollback } from '../src/commands/pi-rollback';
import {
  assertDirOutsideGitWorktree,
  defaultPiMigratePaths,
  hasLegacyPiOwnerEntry,
  withPiAuthLock,
  migratePiSingleProvider,
  rollbackPiSingleProvider,
  type PiMigratePaths,
  type PiMigrateProvider,
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
  tokens: string[];
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
    tokens: ['access-native', 'refresh-native'],
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function placeholderPresent(paths: PiMigratePaths, provider: PiMigrateProvider): boolean {
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

function writePiJournal(paths: PiMigratePaths, provider: PiMigrateProvider, phase: string, fields: Record<string, unknown> = {}): void {
  mkdirSync(paths.journalPath, { recursive: true, mode: 0o700 });
  writeFileSync(join(paths.journalPath, `pi-migrate-${provider}.json`), JSON.stringify({ provider, phase, ownerPid: process.pid, updatedAt: Date.now(), ...fields }), { mode: 0o600 });
}

const ALL: ReadonlySet<PiMigrateProvider> = new Set(['xai', 'kimi-coding', 'openrouter', 'openai-codex', 'anthropic']);
const STORE_PICK_STUBS = {
  listAnthropicSlotLineageChains() { return []; },
  replacePiExportTargets() {},
  listPiExportTargets() { return []; },
  getActiveLogin() { return null; },
};

function gitInit(dir: string): void { execFileSync('git', ['init', '-q', dir]); }

function snapshotDirectory(path: string): Array<[string, Buffer]> | null {
  return existsSync(path)
    ? readdirSync(path).sort().map((name) => [name, readFileSync(join(path, name))])
    : null;
}

function expectRefusal(h: ReturnType<typeof setup>, provider: PiMigrateProvider, code: string, fn: () => unknown): void {
  const snapshot = () => ({
    auth: readFileSync(h.paths.authJsonPath, 'utf8'),
    owner: existsSync(h.paths.ownerPath) ? readFileSync(h.paths.ownerPath, 'utf8') : null,
    baseline: snapshotDirectory(h.paths.baselineDir),
    journal: existsSync(join(h.paths.journalPath, `pi-migrate-${provider}.json`))
      ? readFileSync(join(h.paths.journalPath, `pi-migrate-${provider}.json`), 'utf8')
      : null,
    lock: snapshotDirectory(`${h.paths.authJsonPath}.lock`),
    config: [
      `pi.${provider}.state`,
      `pi.${provider}.migratedAt`,
      `pi.${provider}.baselineConsumedBy`,
      `single.${provider}.activeId`,
    ].map((key) => [key, h.store.getConfig(key)]),
    exportTargets: h.store.listPiExportTargets(provider),
  });
  const before = snapshot();
  assert.throws(fn, (error: unknown) => {
    const refusal = error as { code?: unknown; exitCode?: unknown; message?: unknown };
    const message = refusal.message;
    return refusal.code === code
      && refusal.exitCode === 3
      && typeof message === 'string'
      && message.startsWith(code)
      && h.tokens.every((token) => !message.includes(token));
  });
  assert.deepEqual(snapshot(), before, `${code} must not write`);
}

function setupCodexRollback(): ReturnType<typeof setup> & { baseline: Record<string, unknown> } {
  const h = setup();
  const baseline = oauth('codex-baseline');
  writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'qlb-managed', refresh: '', expires: 1 } }), { mode: 0o600 });
  mkdirSync(h.paths.baselineDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(h.paths.baselineDir, 'openai-codex.json'), JSON.stringify(baseline), { mode: 0o600 });
  writeFileSync(h.paths.ownerPath, JSON.stringify({ providers: {
    'openai-codex': { mode: 'qlb', since: 1 },
    xai: { mode: 'qlb', since: 1 },
  } }), { mode: 0o600 });
  h.store.setConfig('pi.openai-codex.state', 'migrated');
  h.store.setConfig('pi.openai-codex.migratedAt', '1');
  return { ...h, baseline, tokens: [...h.tokens, 'access-codex-baseline', 'refresh-codex-baseline'] };
}

function setupAnthropicRollback(): ReturnType<typeof setup> & { baseline: Record<string, unknown>; livePool: string; disabledPool: string } {
  const h = setup();
  const baseline = oauth('anthropic-baseline');
  writeFileSync(h.paths.authJsonPath, JSON.stringify({ anthropic: { type: 'oauth', access: 'qlb-managed', refresh: '', expires: 1 } }), { mode: 0o600 });
  mkdirSync(h.paths.baselineDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(h.paths.baselineDir, 'anthropic.json'), JSON.stringify(baseline), { mode: 0o600 });
  writeFileSync(h.paths.ownerPath, JSON.stringify({ providers: { anthropic: { mode: 'qlb', since: 1 } } }), { mode: 0o600 });
  const livePool = join(h.paths.extensionsDir, 'anthropic-pool');
  const disabledPool = join(h.paths.disabledExtensionsDir, 'anthropic-pool');
  mkdirSync(disabledPool, { recursive: true, mode: 0o700 });
  writeFileSync(join(disabledPool, 'marker'), 'marker-bytes', { mode: 0o600 });
  h.store.setConfig('pi.anthropic.state', 'migrated');
  h.store.setConfig('pi.anthropic.migratedAt', '1');
  return { ...h, baseline, livePool, disabledPool, tokens: [...h.tokens, 'access-anthropic-baseline', 'refresh-anthropic-baseline'] };
}

function assertAnthropicRollbackClean(h: ReturnType<typeof setupAnthropicRollback>): void {
  assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).anthropic, h.baseline);
  assert.equal(existsSync(h.livePool), true, 'pool entry restored');
  assert.equal(lstatPresent(h.disabledPool), false, 'disabled pool entry removed');
  assert.equal(h.store.getConfig('pi.anthropic.state'), '');
  assert.equal(h.store.getConfig('pi.anthropic.migratedAt'), '');
  assert.equal(h.store.getConfig('pi.anthropic.baselineConsumedBy'), '');
  assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-anthropic.json')), false, 'journal removed');
}

function lstatPresent(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function singleGrantJournalAccount(provider: Exclude<PiSingleProvider, 'openrouter'>, shared = false): Record<string, unknown> {
  const account: Record<string, unknown> = { id: ADAPTER_ACCOUNT_IDS[provider], provider, label: provider };
  if (shared) account.keychain = sharedSingleGrantCoords(provider);
  return account;
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
  return { service, account, stashService: `qlb:${provider}:kept:${new Date(cleanedAt).toISOString()}`, kept };
}

describe('Pi migration S58 credential-first barrier', () => {
  it('openai-codex and anthropic are refused provider-not-enabled by migrate and rollback before the lock by default', () => {
    for (const provider of ['openai-codex', 'anthropic'] as const) {
      for (const operation of [migratePiSingleProvider, rollbackPiSingleProvider]) {
        const h = setup();
        let lockCalls = 0;
        try {
          expectRefusal(h, provider, 'provider-not-enabled', () => operation(provider, h.paths, {
            keychain: h.keychain,
            store: h.store,
            withAuthLock: (_path, _fn) => { lockCalls += 1; throw new Error('lock must not be taken'); },
          }));
          assert.equal(lockCalls, 0, `${provider}: refusal must precede the lock`);
        } finally { h.cleanup(); }
      }
    }
  });

  it('openai-codex and anthropic refuse store-required when deps.store is absent', () => {
    for (const provider of ['openai-codex', 'anthropic'] as const) {
      const h = setup();
      try {
        expectRefusal(h, provider, 'store-required', () => migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, enabledProviders: ALL }));
        expectRefusal(h, provider, 'store-required', () => rollbackPiSingleProvider(provider, h.paths, { keychain: h.keychain, enabledProviders: ALL }));
      } finally { h.cleanup(); }
    }
  });

  it('anthropic migrate remains provider-not-enabled when the test seam enables it', () => {
    const h = setup(); let lockCalls = 0;
    try {
      expectRefusal(h, 'anthropic', 'provider-not-enabled', () => migratePiSingleProvider('anthropic', h.paths, {
        keychain: h.keychain, store: h.store, enabledProviders: ALL,
        withAuthLock: (_path, _fn) => { lockCalls += 1; throw new Error('lock must not be taken'); },
      }));
      assert.equal(lockCalls, 0, 'anthropic migrate: refusal must precede the lock');
    } finally { h.cleanup(); }
  });

  it('owner-file-legacy-v1 refusal carries exitCode 3', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }), { mode: 0o600 });
      assert.throws(
        () => rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }),
        (error: unknown) => (error as { code?: unknown }).code === 'owner-file-legacy-v1' && (error as { exitCode?: unknown }).exitCode === 3,
      );
    } finally { h.cleanup(); }
  });

  it('a write path inside a git work tree is refused pi-path-in-git-worktree with exitCode 3 and a message starting with the code', () => {
    const h = setup();
    try {
      gitInit(h.dir);
      expectRefusal(h, 'xai', 'pi-path-in-git-worktree', () => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }));
    } finally { h.cleanup(); }
  });

  it('assertDirOutsideGitWorktree refuses a directory that is itself a repository root or a missing child of one, and accepts a missing directory outside any repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'qlb-pi-repo-'));
    const outside = mkdtempSync(join(tmpdir(), 'qlb-pi-outside-'));
    try {
      gitInit(repo);
      assert.throws(() => assertDirOutsideGitWorktree(repo, outside), (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'pi-path-in-git-worktree' && (error as { exitCode?: unknown }).exitCode === 3);
      assert.throws(() => assertDirOutsideGitWorktree(join(repo, 'missing', 'child'), outside), (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'pi-path-in-git-worktree' && (error as { exitCode?: unknown }).exitCode === 3);
      assert.doesNotThrow(() => assertDirOutsideGitWorktree(join(outside, 'missing', 'child'), outside));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('the journal carries priorBaselineConsumedBy through every later phase write and readJournal rejects a non-string value', () => {
    const h = setup();
    try {
      writePiJournal(h.paths, 'xai', 'started', { priorBaselineConsumedBy: 'slot-a' });
      const observed = new Set<string>();
      migratePiSingleProvider('xai', h.paths, {
        keychain: h.keychain,
        afterWrite: (point) => {
          if (!['baseline', 'credential-saved', 'placeholder', 'publishing', 'owner-entry', 'before-committed'].includes(point)) return;
          const journal = JSON.parse(readFileSync(join(h.paths.journalPath, 'pi-migrate-xai.json'), 'utf8')) as { priorBaselineConsumedBy?: unknown };
          assert.equal(journal.priorBaselineConsumedBy, 'slot-a', point);
          observed.add(point);
        },
      });
      assert.deepEqual([...observed].sort(), ['baseline', 'before-committed', 'credential-saved', 'owner-entry', 'placeholder', 'publishing']);

      const authBefore = readFileSync(h.paths.authJsonPath);
      const ownerBefore = readFileSync(h.paths.ownerPath);
      const baseline = join(h.paths.baselineDir, 'xai.json');
      const baselineBefore = readFileSync(baseline);
      writePiJournal(h.paths, 'xai', 'baseline', { priorBaselineConsumedBy: 7 });
      assert.throws(() => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }), /Pi migration journal is malformed/);
      assert.equal(readFileSync(h.paths.authJsonPath).equals(authBefore), true);
      assert.equal(readFileSync(h.paths.ownerPath).equals(ownerBefore), true);
      assert.equal(readFileSync(baseline).equals(baselineBefore), true);
    } finally { h.cleanup(); }
  });

  it('pi migrate sets a kept copy aside at qlb:<p>:kept:<ISO>', () => {
    const h = setup('xai');
    try {
      const kept = plantKeptGenericCopy(h, 'xai');
      assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
      assert.equal(kept.stashService, 'qlb:xai:kept:2026-10-30T12:00:00.000Z');
      assert.equal(h.keychain.getSync(kept.stashService, QLB_KEYCHAIN_ACCOUNT), kept.kept);
    } finally { h.cleanup(); }
  });

  it('pi migrate kept-copy stash refuses a generic journal with more than one account', () => {
    for (const provider of ['xai', 'kimi-coding'] as const) {
      const h = setup(provider);
      try {
        const kept = plantKeptGenericCopy(h, provider);
        const row = h.store.getMigration(`pi-${provider}`)!;
        const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
        detail.accounts.push({ ...detail.accounts[0]! });
        h.store.upsertMigration(`pi-${provider}`, 'NATIVE', JSON.stringify(detail));
        const setSync = h.keychain.setSync.bind(h.keychain);
        const deleteSync = h.keychain.deleteSync.bind(h.keychain);
        const writes: string[] = [];
        const deletes: string[] = [];
        h.keychain.setSync = (service, account, value) => {
          writes.push(`${service}/${account}`);
          return setSync(service, account, value);
        };
        h.keychain.deleteSync = (service, account) => {
          deletes.push(`${service}/${account}`);
          return deleteSync(service, account);
        };

        assert.throws(
          () => migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }),
          (error: unknown) => (error as { code?: unknown }).code === 'journal-keychain-invalid',
        );
        assert.deepEqual(writes, []);
        assert.deepEqual(deletes, []);
        assert.equal(h.keychain.getSync(kept.service, kept.account), kept.kept);
      } finally { h.cleanup(); }
    }
  });

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

          rollbackPiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store });
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

  it('xai migrate with a v1 document claiming xai keeps the origin/main owner-file-legacy-v1 outcome', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }), { mode: 0o600 });
      expectRefusal(h, 'xai', 'owner-file-legacy-v1', () => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }));
    } finally { h.cleanup(); }
  });

  it('rollback unlinks qlb-owner.json when its last entry is removed', () => {
    const h = setup();
    try {
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store });
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
    it(`${provider}: T-PR1: pi rollback does not delete the shared item while the generic migration is QLB_OWNED and records it`, () => {
      const shared = singleGrantJournalAccount(provider, true);
      const held = [
        { name: 'shared coordinates', detail: JSON.stringify({ accounts: [shared] }) },
        { name: 'rollback intent marker', detail: JSON.stringify({ accounts: [shared], intent: 'rollback' }) },
        { name: 'rollback decision marker', detail: JSON.stringify({ accounts: [shared], rollbackDecision: {} }) },
        { name: 'hand-back marker', detail: JSON.stringify({ accounts: [shared], handback: { phase: 'cleanup-pending' } }) },
        { name: 'unparseable detail', detail: '{' },
        { name: 'invalid keychain', detail: JSON.stringify({ accounts: [{ ...shared, keychain: { service: 'invalid', account: 'invalid' } }] }) },
        { name: 'no accounts', detail: JSON.stringify({ accounts: [] }) },
        { name: 'two accounts', detail: JSON.stringify({ accounts: [shared, singleGrantJournalAccount(provider)] }) },
        { name: 'invalid second account', detail: JSON.stringify({ accounts: [shared, { bogus: true }] }) },
      ];
      for (const fixture of held) {
        const h = setup(provider);
        try {
          migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store });
          h.store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', fixture.detail);
          const ownerBefore = readFileSync(h.paths.ownerPath);
          const authBefore = readFileSync(h.paths.authJsonPath);
          const { service, account } = sharedSingleGrantCoords(provider);
          const itemBefore = h.keychain.getSync(service, account);
          const stateBefore = h.store.getConfig(`pi.${provider}.state`);
          const migratedAtBefore = h.store.getConfig(`pi.${provider}.migratedAt`);
          assert.throws(
            () => rollbackPiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }),
            (error: unknown) => {
              const refusal = error as { code?: unknown; exitCode?: unknown; message?: unknown };
              return refusal.code === 'owned-by-generic-migrate'
                && refusal.exitCode === 3
                && typeof refusal.message === 'string'
                && refusal.message.includes(`generic migration pi-${provider}`)
                && refusal.message.includes(`qlb migrate rollback --provider ${provider}`);
            },
            fixture.name,
          );
          assert.equal(readFileSync(h.paths.ownerPath).equals(ownerBefore), true, `${fixture.name}: owner map changed`);
          assert.equal(readFileSync(h.paths.authJsonPath).equals(authBefore), true, `${fixture.name}: auth.json changed`);
          assert.equal(h.keychain.getSync(service, account), itemBefore, `${fixture.name}: shared item changed`);
          assert.equal(h.store.getConfig(`pi.${provider}.state`), stateBefore, `${fixture.name}: state config changed`);
          assert.equal(h.store.getConfig(`pi.${provider}.migratedAt`), migratedAtBefore, `${fixture.name}: migration time changed`);
        } finally { h.cleanup(); }
      }

      const admitted: Array<{ name: string; state?: string; detail?: string; dual?: boolean; file?: string }> = [
        { name: 'no generic row' },
        // With no row nothing names the shared item, so a stray owner file does not hold it.
        { name: 'no generic row with a staging file', file: `qlb-owner.json.${provider}.staging` },
        { name: 'no generic row with a legacy sidecar', file: `qlb-owner-${provider}.json` },
        { name: 'NATIVE', state: 'NATIVE', detail: JSON.stringify({ accounts: [shared] }) },
        // preCommitRollback leaves commitGeneration behind; NATIVE is still at rest.
        {
          name: 'NATIVE after a pre-commit rollback',
          state: 'NATIVE',
          detail: JSON.stringify({ accounts: [shared], commitGeneration: 3, rolledBackFrom: 'pre-commit' }),
        },
        { name: 'VALIDATED without staging', state: 'VALIDATED', detail: JSON.stringify({ accounts: [shared] }) },
        { name: 'QLB_OWNED legacy', state: 'QLB_OWNED', detail: JSON.stringify({ accounts: [singleGrantJournalAccount(provider)] }) },
        { name: 'OD-9 dual ownership with legacy generic journal', state: 'QLB_OWNED', detail: JSON.stringify({ accounts: [singleGrantJournalAccount(provider)] }), dual: true },
      ];
      for (const fixture of admitted) {
        const h = setup(provider);
        try {
          if (fixture.dual) migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store });
          if (fixture.state && fixture.detail) h.store.upsertMigration(`pi-${provider}`, fixture.state, fixture.detail);
          if (fixture.file) writeFileSync(join(dirname(h.paths.ownerPath), fixture.file), '{}', { mode: 0o600 });
          assert.doesNotThrow(() => rollbackPiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }), fixture.name);
        } finally { h.cleanup(); }
      }
    });

    it(`${provider}: T-PR1c: pi rollback refuses while the generic migration stages or retires the shared item`, () => {
      const shared = singleGrantJournalAccount(provider, true);
      const cases: Array<{
        name: string;
        state: string;
        detail: Record<string, unknown> | string;
        staging?: boolean;
      }> = [
        { name: 'MIRRORED', state: 'MIRRORED', detail: { accounts: [shared] } },
        { name: 'VALIDATED with staging', state: 'VALIDATED', detail: { accounts: [shared] }, staging: true },
        { name: 'VALIDATED with commit generation', state: 'VALIDATED', detail: { accounts: [shared], commitGeneration: 1 } },
        { name: 'RETIRED', state: 'RETIRED', detail: { accounts: [shared] } },
        // Unreadable or ambiguous evidence is protected by the same S0.6 rules.
        { name: 'VALIDATED with unparseable detail', state: 'VALIDATED', detail: '{' },
        { name: 'NATIVE with unparseable detail', state: 'NATIVE', detail: '{' },
        { name: 'VALIDATED with no accounts and commit generation', state: 'VALIDATED', detail: { accounts: [], commitGeneration: 1 } },
        {
          name: 'VALIDATED with two accounts and commit generation',
          state: 'VALIDATED',
          detail: { accounts: [shared, singleGrantJournalAccount(provider)], commitGeneration: 1 },
        },
      ];

      for (const fixture of cases) {
        const h = setup(provider);
        try {
          migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store });
          h.store.upsertMigration(
            `pi-${provider}`,
            fixture.state,
            typeof fixture.detail === 'string' ? fixture.detail : JSON.stringify(fixture.detail),
          );
          if (fixture.staging) {
            writeFileSync(join(dirname(h.paths.ownerPath), `qlb-owner.json.${provider}.staging`), '{}', { mode: 0o600 });
          }
          const ownerBefore = readFileSync(h.paths.ownerPath);
          const authBefore = readFileSync(h.paths.authJsonPath);
          const { service, account } = sharedSingleGrantCoords(provider);
          const itemBefore = h.keychain.getSync(service, account);
          const stateBefore = h.store.getConfig(`pi.${provider}.state`);
          const migratedAtBefore = h.store.getConfig(`pi.${provider}.migratedAt`);
          const keychainWrites: string[] = [];
          const storeWrites: string[] = [];
          const keychain = {
            getSync: h.keychain.getSync.bind(h.keychain),
            setSync: (targetService: string, targetAccount: string, value: string) => {
              keychainWrites.push(`set:${targetService}/${targetAccount}`);
              h.keychain.setSync(targetService, targetAccount, value);
            },
            deleteSync: (targetService: string, targetAccount: string) => {
              keychainWrites.push(`delete:${targetService}/${targetAccount}`);
              h.keychain.deleteSync(targetService, targetAccount);
            },
          };
          const setConfig = h.store.setConfig.bind(h.store);
          h.store.setConfig = (key: string, value: string) => {
            storeWrites.push(`${key}=${value}`);
            setConfig(key, value);
          };

          assert.throws(
            () => rollbackPiSingleProvider(provider, h.paths, { keychain, store: h.store }),
            (error: unknown) => {
              const refusal = error as { code?: unknown; exitCode?: unknown; message?: unknown };
              return refusal.code === 'owned-by-generic-migrate'
                && refusal.exitCode === 3
                && typeof refusal.message === 'string'
                && refusal.message.includes(`generic migration pi-${provider}`)
                && refusal.message.includes(`qlb migrate rollback --provider ${provider}`);
            },
            fixture.name,
          );
          assert.equal(readFileSync(h.paths.ownerPath).equals(ownerBefore), true, `${fixture.name}: owner map changed`);
          assert.equal(readFileSync(h.paths.authJsonPath).equals(authBefore), true, `${fixture.name}: auth.json changed`);
          assert.equal(h.keychain.getSync(service, account), itemBefore, `${fixture.name}: shared item changed`);
          assert.deepEqual(keychainWrites, [], `${fixture.name}: Keychain fake was written`);
          assert.deepEqual(storeWrites, [], `${fixture.name}: store was written`);
          assert.equal(h.store.getConfig(`pi.${provider}.state`), stateBefore, `${fixture.name}: state config changed`);
          assert.equal(h.store.getConfig(`pi.${provider}.migratedAt`), migratedAtBefore, `${fixture.name}: migration time changed`);
        } finally { h.cleanup(); }
      }
    });

    it(`${provider}: T-PR1b: pi rollback without a store refuses for xai and kimi-coding and writes nothing`, () => {
      const h = setup(provider);
      try {
        migratePiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store });
        const ownerBefore = readFileSync(h.paths.ownerPath);
        const authBefore = readFileSync(h.paths.authJsonPath);
        const { service, account } = sharedSingleGrantCoords(provider);
        const itemBefore = h.keychain.getSync(service, account);
        const stateBefore = h.store.getConfig(`pi.${provider}.state`);
        const migratedAtBefore = h.store.getConfig(`pi.${provider}.migratedAt`);
        assert.throws(
          () => rollbackPiSingleProvider(provider, h.paths, { keychain: h.keychain }),
          (error: unknown) => {
            const refusal = error as { code?: unknown; exitCode?: unknown; message?: unknown };
            return refusal.code === 'generic-ownership-unreadable'
              && refusal.exitCode === 3
              && typeof refusal.message === 'string'
              && refusal.message.includes(`qlb migrate rollback --provider ${provider}`);
          },
        );
        assert.equal(readFileSync(h.paths.ownerPath).equals(ownerBefore), true, 'owner map changed');
        assert.equal(readFileSync(h.paths.authJsonPath).equals(authBefore), true, 'auth.json changed');
        assert.equal(h.keychain.getSync(service, account), itemBefore, 'shared item changed');
        assert.equal(h.store.getConfig(`pi.${provider}.state`), stateBefore, 'state config changed');
        assert.equal(h.store.getConfig(`pi.${provider}.migratedAt`), migratedAtBefore, 'migration time changed');
      } finally { h.cleanup(); }
    });

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

    it(`${provider}: T-PR3: pi rollback over a generic hand-back that kept its copy`, () => {
      const h = setup(provider);
      try {
        const kept = plantKeptGenericCopy(h, provider);
        rollbackPiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store });
        assert.equal(h.keychain.getSync(kept.stashService, kept.account), kept.kept);
        assert.throws(() => h.keychain.getSync(kept.service, kept.account), /item not found/);
      } finally { h.cleanup(); }
    });

    it(`${provider}: a malformed Pi journal does not block pi rollback when no copy was kept`, () => {
      const h = setup(provider);
      try {
        mkdirSync(h.paths.journalPath, { recursive: true, mode: 0o700 });
        const journal = join(h.paths.journalPath, `pi-migrate-${provider}.json`);
        writeFileSync(journal, '{not json', { mode: 0o600 });
        assert.doesNotThrow(() => rollbackPiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store }));
        assert.equal(existsSync(journal), false, 'rollback still clears the journal');
      } finally { h.cleanup(); }
    });

    it(`${provider}: T-PR3b: pi rollback over a kept copy re-runs after a crash at each step to the same end state`, () => {
      for (const crash of ['stash', 'delete'] as const) {
        const h = setup(provider);
        try {
          const kept = plantKeptGenericCopy(h, provider);
          let stashWrites = 0;
          let crashAfterStashRead = crash === 'stash';
          let crashAfterDelete = crash === 'delete';
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
            deleteSync(service: string, account: string) {
              h.keychain.deleteSync(service, account);
              if (crashAfterDelete && service === kept.service && account === kept.account) {
                crashAfterDelete = false;
                throw new Error('injected crash');
              }
            },
          };
          assert.throws(
            () => rollbackPiSingleProvider(provider, h.paths, { keychain, store: h.store }),
            /injected crash/,
            crash,
          );
          assert.equal(h.keychain.getSync(kept.stashService, kept.account), kept.kept, `${crash}: stash preserves the kept copy`);
          assert.doesNotThrow(() => rollbackPiSingleProvider(provider, h.paths, { keychain, store: h.store }), crash);
          assert.equal(stashWrites, 1, `${crash}: exactly one stash`);
          assert.equal(h.keychain.getSync(kept.stashService, kept.account), kept.kept, `${crash}: stash remains the kept copy`);
          assert.throws(() => h.keychain.getSync(kept.service, kept.account), /item not found/, `${crash}: shared item is deleted`);
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

    it(`${provider}: pi migrate over a kept copy that crashed after the stash and the journal resumes with the kept copy stashed`, () => {
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
      assert.throws(() => migratePiSingleProvider('openrouter', h.paths, { keychain: h.keychain, store: { getMigration() { return null; }, getConfig() { return null; }, setConfig() { writes += 1; }, recordLineage() { return 0; }, upsertAccount() {}, getAccount() { return null; }, setAccountStatus() {}, ...STORE_PICK_STUBS }, readNativeOpenRouterKey: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /denied/);
      assert.equal(writes, 0);
    } finally { h.cleanup(); }
  });

  it('classifies only a darwin security status 44 native miss as not-applicable', () => {
    const h = setup();
    try {
      const config = new Map<string, string>();
      const store = { getMigration() { return null; }, getConfig(key: string) { return config.get(key) ?? null; }, setConfig(key: string, value: string) { config.set(key, value); }, recordLineage() { return 0; }, upsertAccount() {}, getAccount() { return null; }, setAccountStatus() {}, ...STORE_PICK_STUBS };
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

  it('P7a-r: holder A makes no write after holder B takes over its stale lock', () => {
    const h = setup();
    try {
      const kept = plantKeptGenericCopy(h, 'xai');
      const setSync = h.keychain.setSync.bind(h.keychain);
      const writes: string[] = [];
      h.keychain.setSync = (service, account, value) => {
        writes.push(`${service}/${account}`);
        return setSync(service, account, value);
      };
      let bTookOver = false;
      const now = () => 10_000;

      assert.throws(() => migratePiSingleProvider('xai', h.paths, {
        keychain: h.keychain,
        store: h.store,
        withAuthLock: (path, holderA) => withPiAuthLock(path, (refreshA) => {
          const lock = `${path}.lock`;
          writeFileSync(join(lock, 'qlb-lock-owner.json'), JSON.stringify({ pid: 999_999, nonce: 'misjudged-stale' }));
          utimesSync(lock, new Date(now() - 2), new Date(now() - 2));
          return withPiAuthLock(path, () => {
            bTookOver = true;
            return holderA(refreshA);
          }, { staleMs: 1, retries: 0, retryMs: 0, now });
        }, { staleMs: 1, retries: 0, retryMs: 0, now }),
      }), (error: unknown) => (error as { code?: unknown; message?: unknown }).code === 'pi-auth-lock-lost'
        && /another run took the auth\.json lock over/.test(String((error as { message?: unknown }).message)));

      assert.equal(bTookOver, true, 'holder B took over holder A\'s stale lock');
      assert.deepEqual(writes, [], 'holder A must make no write after the takeover');
      assert.throws(() => h.keychain.getSync(kept.stashService, QLB_KEYCHAIN_ACCOUNT), /item not found/);
    } finally { h.cleanup(); }
  });

  it('P7a-r: pi rollback makes no managed-item delete after its lock is taken over during the kept-copy stash', () => {
    const h = setup();
    try {
      const kept = plantKeptGenericCopy(h, 'xai');
      const lockOwner = join(`${h.paths.authJsonPath}.lock`, 'qlb-lock-owner.json');
      const deletes: string[] = [];
      const keychain = {
        setSync(service: string, account: string, value: string) {
          h.keychain.setSync(service, account, value);
          // Barrier: holder B takes the lock over right after A's stash write.
          if (service === kept.stashService) writeFileSync(lockOwner, JSON.stringify({ pid: process.pid, nonce: 'holder-b' }));
        },
        getSync: h.keychain.getSync.bind(h.keychain),
        deleteSync(service: string, account: string) { deletes.push(`${service}/${account}`); h.keychain.deleteSync(service, account); },
      };
      assert.throws(
        () => rollbackPiSingleProvider('xai', h.paths, { keychain, store: h.store }),
        (error: unknown) => (error as { code?: unknown }).code === 'pi-auth-lock-lost',
      );
      assert.deepEqual(deletes, [], 'holder A must not delete the managed item after the takeover');
      assert.equal(h.keychain.getSync(kept.service, kept.account), kept.kept, 'the shared item is intact');
      assert.deepEqual(JSON.parse(readFileSync(lockOwner, 'utf8')), { pid: process.pid, nonce: 'holder-b' }, 'B\'s lock is left intact');
    } finally { h.cleanup(); }
  });

  it('P7a-r: a lock lost before removing an unverified stash names the stash left behind', () => {
    const h = setup();
    try {
      const kept = plantKeptGenericCopy(h, 'xai');
      const lockOwner = join(`${h.paths.authJsonPath}.lock`, 'qlb-lock-owner.json');
      const deletes: string[] = [];
      let stashReads = 0;
      const keychain = {
        setSync: h.keychain.setSync.bind(h.keychain),
        getSync(service: string, account: string) {
          const value = h.keychain.getSync(service, account);
          // The presence check throws not-found above, so the first stash value read is the verify read.
          // Barrier: the read-back differs and holder B takes the lock over at the same moment.
          if (service !== kept.stashService || ++stashReads !== 1) return value;
          writeFileSync(lockOwner, JSON.stringify({ pid: process.pid, nonce: 'holder-b' }));
          return value.slice(0, 10);
        },
        deleteSync(service: string, account: string) { deletes.push(`${service}/${account}`); h.keychain.deleteSync(service, account); },
      };
      assert.throws(
        () => migratePiSingleProvider('xai', h.paths, { keychain, store: h.store }),
        (error: unknown) => {
          const e = error as { code?: unknown; message?: unknown; cause?: { code?: unknown } };
          return e.code === 'pi-auth-lock-lost'
            && String(e.message).includes('another run took the auth.json lock over')
            && String(e.message).includes(`unverified kept-copy stash ${kept.stashService} (account ${QLB_KEYCHAIN_ACCOUNT})`)
            && e.cause?.code === 'kept-copy-stash-unverified'
            && exitCodeForError(error) === 1;
        },
      );
      assert.deepEqual(deletes, [], 'holder A must not delete after the takeover');
    } finally { h.cleanup(); }
  });

  describe('P7a-r-Q2: pi-auth-lock-lost exits 3 before the first write and 1 once a write has landed', () => {
    // Barrier: holder B takes the lock over by rewriting its owner file.
    const takeOver = (path: string) => writeFileSync(join(`${path}.lock`, 'qlb-lock-owner.json'), JSON.stringify({ pid: process.pid, nonce: 'holder-b' }));
    // Lock wrapper that lets B take over after A acquires the lock and before A runs.
    const takenOverOnEntry = <T>(path: string, fn: (refresh: () => void) => T): T => withPiAuthLock(path, (refresh) => { takeOver(path); return fn(refresh); });
    const lockLostWithExit = (exit: number) => (error: unknown) => (error as { code?: unknown }).code === 'pi-auth-lock-lost' && exitCodeForError(error) === exit;
    const snapshot = (h: ReturnType<typeof setup>) => ({
      auth: readFileSync(h.paths.authJsonPath, 'utf8'),
      owner: existsSync(h.paths.ownerPath) ? readFileSync(h.paths.ownerPath, 'utf8') : null,
      journal: existsSync(join(h.paths.journalPath, 'pi-migrate-xai.json')),
      baseline: existsSync(join(h.paths.baselineDir, 'xai.json')) ? readFileSync(join(h.paths.baselineDir, 'xai.json'), 'utf8') : null,
      managed: hasManaged(h.keychain, 'xai') ? h.keychain.getSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT) : null,
      state: h.store.getConfig('pi.xai.state') ?? null,
    });

    it('pi migrate: lock lost before the first write exits 3 and writes nothing', () => {
      const h = setup();
      try {
        const before = snapshot(h);
        assert.throws(() => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store, withAuthLock: takenOverOnEntry }), lockLostWithExit(3));
        assert.deepEqual(snapshot(h), before, 'nothing written');
      } finally { h.cleanup(); }
    });

    it('pi migrate: lock lost after a write exits 1', () => {
      const h = setup();
      try {
        assert.throws(() => migratePiSingleProvider('xai', h.paths, {
          keychain: h.keychain,
          store: h.store,
          afterWrite: (point) => { if (point === 'baseline') takeOver(h.paths.authJsonPath); },
        }), lockLostWithExit(1));
        assert.equal(existsSync(join(h.paths.baselineDir, 'xai.json')), true, 'the baseline write landed');
      } finally { h.cleanup(); }
    });

    it('pi rollback: lock lost before the first write exits 3 and writes nothing', () => {
      const h = setup();
      try {
        assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
        const before = snapshot(h);
        assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store, withAuthLock: takenOverOnEntry }), lockLostWithExit(3));
        assert.deepEqual(snapshot(h), before, 'nothing written');
      } finally { h.cleanup(); }
    });

    it('qlb pi rollback through the CLI entry: lock lost before the first write exits 3', async () => {
      const h = setup();
      try {
        assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
        const before = snapshot(h);
        const errors: string[] = [];
        const exit = await runExecutingCommand({
          command: {
            name: 'pi rollback',
            execute: (args, ctx) => executePiRollback(args, ctx, {
              rollback: (provider) => rollbackPiSingleProvider(provider, h.paths, { keychain: h.keychain, store: h.store, withAuthLock: takenOverOnEntry }),
            }),
          },
          args: ['xai'],
        }, {
          stdout: () => {}, stderr: (message: string) => errors.push(message),
          env: { QLB_TEST_MODE: '1', QLB_HOME: h.dir }, home: h.dir,
          config: { dbPath: join(h.dir, 'qlb.db') }, loadConfig: () => ({ dbPath: join(h.dir, 'qlb.db') }),
          registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
        } as never);
        assert.equal(exit, 3, errors.join('\n'));
        assert.match(errors.join('\n'), /pi-auth-lock-lost/);
        assert.deepEqual(snapshot(h), before, 'nothing written');
      } finally { h.cleanup(); }
    });

    it('pi rollback: lock lost after a write exits 1', () => {
      const h = setup();
      try {
        assert.equal(migratePiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }).state, 'migrated');
        assert.throws(() => rollbackPiSingleProvider('xai', h.paths, {
          keychain: h.keychain,
          store: h.store,
          afterWrite: (point) => { if (point === 'owner-entry') takeOver(h.paths.authJsonPath); },
        }), lockLostWithExit(1));
        assert.equal(existsSync(h.paths.ownerPath), false, 'the owner-entry write landed');
      } finally { h.cleanup(); }
    });
  });

  it('P7a-r: a lock replaced between the owner check and the touch reports pi-auth-lock-lost', () => {
    const h = setup();
    try {
      const lock = `${h.paths.authJsonPath}.lock`;
      let replace = false;
      const now = () => {
        // Barrier: refresh() reads now() after its owner check and before utimesSync; holder B
        // moves A's lock aside and creates its own in that window.
        if (replace) {
          replace = false;
          renameSync(lock, `${lock}.stale-taker`);
          mkdirSync(lock);
          writeFileSync(join(lock, 'qlb-lock-owner.json'), JSON.stringify({ pid: process.pid, nonce: 'holder-b' }));
        }
        return 10_000;
      };
      let wroteAfterRefresh = false;
      assert.throws(
        () => withPiAuthLock(h.paths.authJsonPath, (refresh) => { replace = true; refresh(); wroteAfterRefresh = true; }, { now }),
        (error: unknown) => (error as { code?: unknown }).code === 'pi-auth-lock-lost',
      );
      assert.equal(wroteAfterRefresh, false, 'holder A must not continue to a write');
      assert.deepEqual(JSON.parse(readFileSync(join(lock, 'qlb-lock-owner.json'), 'utf8')), { pid: process.pid, nonce: 'holder-b' }, 'B\'s lock is left intact');
    } finally { h.cleanup(); }
  });

  it('P7a-r: a lock moved aside between the owner check and the touch reports pi-auth-lock-lost', () => {
    const h = setup();
    try {
      const lock = `${h.paths.authJsonPath}.lock`;
      let moveAside = false;
      const now = () => {
        // Barrier: refresh() reads now() after its owner check and before utimesSync.
        if (moveAside) { moveAside = false; renameSync(lock, `${lock}.stale-taker`); }
        return 10_000;
      };
      assert.throws(
        () => withPiAuthLock(h.paths.authJsonPath, (refresh) => { moveAside = true; refresh(); }, { now }),
        (error: unknown) => (error as { code?: unknown }).code === 'pi-auth-lock-lost',
      );
      assert.equal(existsSync(`${lock}.stale-taker`), true, 'the moved-aside lock is not removed by the old holder');
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
        store: h.store,
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
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store });
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
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).xai, baseline);
    } finally { h.cleanup(); }
  });

  it('refuses rollback without deleting anything when neither credential source is usable', () => {
    const h = setup();
    try {
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      h.keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT, '{}');
      writeFileSync(join(h.paths.baselineDir, 'xai.json'), '{}');
      assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }), /no managed or baseline/);
      assert.equal(hasManaged(h.keychain, 'xai'), true);
      const owner = JSON.parse(readFileSync(h.paths.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.xai);
    } finally { h.cleanup(); }
  });

  it('keeps migration finalization inside the auth lock against rollback', () => {
    const h = setup();
    try {
      const config = new Map<string, string>();
      const store = { getMigration() { return null; }, getConfig(key: string) { return config.get(key) ?? null; }, setConfig(key: string, value: string) { config.set(key, value); }, recordLineage() { return 0; }, upsertAccount() {}, getAccount() { return null; }, setAccountStatus() {}, ...STORE_PICK_STUBS };
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
      assert.doesNotThrow(() => rollbackPiSingleProvider('xai', h.paths, { keychain, store: h.store }));
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      status = 1;
      assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain, store: h.store }), (error: unknown) => (error as { status?: number }).status === 1);
    } finally { h.cleanup(); }
  });

  it('keeps rollback state and journal until a failed managed deletion can be retried', () => {
    const h = setup();
    try {
      const config = new Map<string, string>();
      const store = { getMigration() { return null; }, getConfig(key: string) { return config.get(key) ?? null; }, setConfig(key: string, value: string) { config.set(key, value); }, recordLineage() { return 0; }, upsertAccount() {}, getAccount() { return null; }, setAccountStatus() {}, ...STORE_PICK_STUBS };
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
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store });
      const reauthed = oauth('new-native');
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ xai: reauthed }));
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).xai, reauthed);
      assert.equal(hasManaged(h.keychain, 'xai'), false);
    } finally { h.cleanup(); }
  });

  it('is re-runnable after a crash after rollback owner removal', () => {
    const h = setup();
    try {
      migratePiSingleProvider('xai', h.paths, { keychain: h.keychain });
      assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store, afterWrite: (point) => { if (point === 'owner-entry') throw new Error('crash'); } }), /crash/);
      rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store });
      assert.equal(placeholderPresent(h.paths, 'xai'), false);
    } finally { h.cleanup(); }
  });

  it('openai-codex: rollback restores the baseline entry byte-identical, removes only its owner entry and clears pi.openai-codex.* markers', () => {
    const h = setupCodexRollback();
    try {
      rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      const auth = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(auth['openai-codex'], h.baseline);
      assert.deepEqual(JSON.parse(readFileSync(h.paths.ownerPath, 'utf8')), { providers: { xai: { mode: 'qlb', since: 1 } } });
      assert.equal(h.store.getConfig('pi.openai-codex.state'), '');
      assert.equal(h.store.getConfig('pi.openai-codex.migratedAt'), '');
    } finally { h.cleanup(); }
  });

  it('openai-codex: rollback keeps a newer native login and removes the owner entry', () => {
    const h = setupCodexRollback();
    try {
      const newer = oauth('codex-newer');
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': newer }), { mode: 0o600 });
      rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')), { 'openai-codex': newer });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.ownerPath, 'utf8')), { providers: { xai: { mode: 'qlb', since: 1 } } });
    } finally { h.cleanup(); }
  });

  it('openai-codex: rollback with a placeholder and no baseline refuses no-restore-source', () => {
    const h = setupCodexRollback();
    try {
      rmSync(join(h.paths.baselineDir, 'openai-codex.json'));
      expectRefusal(h, 'openai-codex', 'no-restore-source', () => rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('openai-codex: rollback with an unreadable baseline refuses baseline-unreadable', () => {
    const h = setupCodexRollback();
    try {
      writeFileSync(join(h.paths.baselineDir, 'openai-codex.json'), '{"access":"access-codex-baseline"', { mode: 0o600 });
      expectRefusal(h, 'openai-codex', 'baseline-unreadable', () => rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('openai-codex: rollback on a never-migrated provider refuses pi-not-migrated', () => {
    for (const state of ['', 'not-applicable']) {
      const h = setupCodexRollback();
      try {
        h.store.setConfig('pi.openai-codex.state', state);
        expectRefusal(h, 'openai-codex', 'pi-not-migrated', () => rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
      } finally { h.cleanup(); }
    }
  });

  it('openai-codex: rollback refuses pi-not-migrated when only a generic v2 owner entry and placeholder exist and a stale baseline file is present', () => {
    const h = setupCodexRollback();
    try {
      h.store.setConfig('pi.openai-codex.state', '');
      expectRefusal(h, 'openai-codex', 'pi-not-migrated', () => rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('openai-codex: rollback ignores a stale baseline on a started journal with an absent entry, and restores it from a baseline journal', () => {
    for (const [phase, restores] of [['started', false], ['baseline', true]] as const) {
      const h = setupCodexRollback();
      try {
        h.store.setConfig('pi.openai-codex.state', '');
        writePiJournal(h.paths, 'openai-codex', phase);
        writeFileSync(h.paths.ownerPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }), { mode: 0o600 });
        writeFileSync(h.paths.authJsonPath, '{}', { mode: 0o600 });
        const authBefore = readFileSync(h.paths.authJsonPath, 'utf8');
        rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
        const auth = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')) as Record<string, unknown>;
        assert.equal(auth['openai-codex'] === undefined, !restores, phase);
        if (restores) assert.deepEqual(auth['openai-codex'], h.baseline);
        else assert.equal(readFileSync(h.paths.authJsonPath, 'utf8'), authBefore);
        assert.equal(h.store.getConfig('pi.openai-codex.state'), '');
        assert.equal(h.store.getConfig('pi.openai-codex.migratedAt'), '');
        assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-openai-codex.json')), false);
      } finally { h.cleanup(); }
    }
  });

  it('openai-codex: rollback refuses no-restore-source for a placeholder with only a stale started-journal baseline', () => {
    const h = setupCodexRollback();
    try {
      h.store.setConfig('pi.openai-codex.state', '');
      writePiJournal(h.paths, 'openai-codex', 'started');
      writeFileSync(h.paths.ownerPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }), { mode: 0o600 });
      expectRefusal(h, 'openai-codex', 'no-restore-source', () => rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('openai-codex: rollback accepts journal-only evidence at baseline phase and removes the journal', () => {
    const h = setupCodexRollback();
    try {
      h.store.setConfig('pi.openai-codex.state', '');
      writePiJournal(h.paths, 'openai-codex', 'baseline');
      writeFileSync(h.paths.ownerPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }), { mode: 0o600 });
      rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8'))['openai-codex'], h.baseline);
      assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-openai-codex.json')), false);
    } finally { h.cleanup(); }
  });

  it('openai-codex: rollback refuses owned-by-generic-migrate before any write while migrations.pi-openai-codex is QLB_OWNED, MIRRORED or carries a rollback intent', () => {
    for (const [state, detail] of [
      ['QLB_OWNED', '{}'],
      ['MIRRORED', '{}'],
      ['NATIVE', JSON.stringify({ intent: 'rollback' })],
    ]) {
      const h = setupCodexRollback();
      try {
        h.store.upsertMigration('pi-openai-codex', state, detail);
        expectRefusal(h, 'openai-codex', 'owned-by-generic-migrate', () => rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
      } finally { h.cleanup(); }
    }
  });

  it('openai-codex: rollback refuses a canonical owner claim with only a pre-publishing journal, whether the generic row is absent or VALIDATED', () => {
    for (const phase of ['started', 'baseline'] as const) {
      for (const state of [undefined, 'VALIDATED'] as const) {
        const h = setupCodexRollback();
        try {
          h.store.setConfig('pi.openai-codex.state', '');
          writePiJournal(h.paths, 'openai-codex', phase);
          if (state) h.store.upsertMigration('pi-openai-codex', state, '{}');
          expectRefusal(h, 'openai-codex', 'owned-by-generic-migrate', () => rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
        } finally { h.cleanup(); }
      }
    }
  });

  it('openai-codex: rollback never touches qlb:openai-codex:* Keychain items', () => {
    const h = setupCodexRollback();
    try {
      let sets = 0; let deletes = 0;
      const keychain = {
        getSync: h.keychain.getSync.bind(h.keychain),
        setSync(service: string, account: string, value: string) { sets += 1; h.keychain.setSync(service, account, value); },
        deleteSync(service: string, account: string) { deletes += 1; h.keychain.deleteSync(service, account); },
      };
      rollbackPiSingleProvider('openai-codex', h.paths, { keychain, store: h.store, enabledProviders: ALL });
      assert.equal(sets, 0);
      assert.equal(deletes, 0);
    } finally { h.cleanup(); }
  });

  it('openai-codex: rollback is re-runnable after a crash at owner-entry, entry-restored, migrated-at or journal-cleared', () => {
    for (const crashPoint of ['owner-entry', 'entry-restored', 'migrated-at', 'journal-cleared'] as const) {
      const h = setupCodexRollback();
      try {
        assert.throws(() => rollbackPiSingleProvider('openai-codex', h.paths, {
          keychain: h.keychain, store: h.store, enabledProviders: ALL,
          afterWrite: (point) => { if (point === crashPoint) throw new Error('crash'); },
        }), /crash/);
        rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
        assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')), { 'openai-codex': h.baseline });
        assert.deepEqual(JSON.parse(readFileSync(h.paths.ownerPath, 'utf8')), { providers: { xai: { mode: 'qlb', since: 1 } } });
        assert.equal(h.store.getConfig('pi.openai-codex.state'), '');
        assert.equal(h.store.getConfig('pi.openai-codex.migratedAt'), '');
        assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-openai-codex.json')), false);
      } finally { h.cleanup(); }
    }
  });

  it('openai-codex: journal-only rollback crash after journal removal leaves the final files and retry refuses pi-not-migrated', () => {
    const h = setupCodexRollback();
    try {
      h.store.setConfig('pi.openai-codex.state', '');
      writePiJournal(h.paths, 'openai-codex', 'publishing');
      assert.throws(() => rollbackPiSingleProvider('openai-codex', h.paths, {
        keychain: h.keychain, store: h.store, enabledProviders: ALL,
        afterWrite: (point) => { if (point === 'journal-cleared') throw new Error('crash'); },
      }), /crash/);
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')), { 'openai-codex': h.baseline });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.ownerPath, 'utf8')), { providers: { xai: { mode: 'qlb', since: 1 } } });
      assert.equal(h.store.getConfig('pi.openai-codex.state'), '');
      assert.equal(h.store.getConfig('pi.openai-codex.migratedAt'), '');
      assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-openai-codex.json')), false);
      expectRefusal(h, 'openai-codex', 'pi-not-migrated', () => rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('openai-codex: a lock takeover after owner-entry stops rollback before the entry write with exit 1', () => {
    const h = setupCodexRollback();
    try {
      assert.throws(() => rollbackPiSingleProvider('openai-codex', h.paths, {
        keychain: h.keychain, store: h.store, enabledProviders: ALL,
        withAuthLock: (path, fn) => withPiAuthLock(path, fn),
        afterWrite: (point) => {
          if (point === 'owner-entry') writeFileSync(join(`${h.paths.authJsonPath}.lock`, 'qlb-lock-owner.json'), JSON.stringify({ pid: process.pid, nonce: 'foreign' }));
        },
      }), (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'pi-auth-lock-lost' && (error as { exitCode?: unknown }).exitCode === 1);
      assert.equal(placeholderPresent(h.paths, 'openai-codex'), true);
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback restores the baseline entry, moves the pool entry back and clears pi.anthropic.* markers', () => {
    const h = setupAnthropicRollback();
    try {
      const before = readFileSync(join(h.disabledPool, 'marker'));
      rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).anthropic, h.baseline);
      assert.equal(readFileSync(join(h.livePool, 'marker')).equals(before), true);
      assert.equal(existsSync(h.disabledPool), false);
      assert.equal(existsSync(h.paths.ownerPath), false);
      assert.equal(h.store.getConfig('pi.anthropic.state'), '');
      assert.equal(h.store.getConfig('pi.anthropic.migratedAt'), '');
      assert.equal(h.store.getConfig('pi.anthropic.baselineConsumedBy'), '');
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback moves a symlink entry back without following it', () => {
    const h = setupAnthropicRollback(); const target = mkdtempSync(join(tmpdir(), 'qlb-pool-target-'));
    try {
      rmSync(h.disabledPool, { recursive: true, force: true });
      writeFileSync(join(target, 'marker'), 'outside'); const before = statSync(target).mtimeMs;
      symlinkSync(target, h.disabledPool);
      rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.equal(lstatSync(h.livePool).isSymbolicLink(), true);
      assert.equal(readlinkSync(h.livePool), target);
      assert.equal(statSync(target).mtimeMs, before);
    } finally { h.cleanup(); rmSync(target, { recursive: true, force: true }); }
  });

  it('anthropic: rollback writes the consuming slot\'s current pair in Pi\'s shape when baselineConsumedBy is set', () => {
    const h = setupAnthropicRollback();
    try {
      const db = (h.store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
      db.prepare("INSERT INTO claude_slots (account_id, config_json, dead, added_at) VALUES (?, '{}', 0, ?)").run('slot-a', 1);
      h.store.setConfig('pi.anthropic.baselineConsumedBy', 'slot-a');
      h.keychain.setSync(qlbKeychainService('anthropic', 'slot-a'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ claudeAiOauth: { accessToken: 'slot-access', refreshToken: 'slot-refresh', expiresAt: 42 } }));
      rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).anthropic, { type: 'oauth', access: 'slot-access', refresh: 'slot-refresh', expires: 42 });
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback refuses claude-slot-unreadable before un-owning when a live consuming slot\'s item is unreadable', () => {
    const h = setupAnthropicRollback();
    try {
      const db = (h.store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
      db.prepare("INSERT INTO claude_slots (account_id, config_json, dead, added_at) VALUES (?, '{}', 0, ?)").run('slot-a', 1);
      h.store.setConfig('pi.anthropic.baselineConsumedBy', 'slot-a');
      expectRefusal(h, 'anthropic', 'claude-slot-unreadable', () => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback restores the baseline with a consumer-slot-gone warning when the consuming slot is archived, dead or absent', () => {
    for (const kind of ['absent', 'archived', 'dead'] as const) {
      const h = setupAnthropicRollback();
      try {
        const accountId = `gone-${kind}`;
        if (kind !== 'absent') {
          const db = (h.store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
          db.prepare("INSERT INTO claude_slots (account_id, config_json, dead, archived_at, added_at) VALUES (?, '{}', ?, ?, ?)").run(accountId, kind === 'dead' ? 1 : 0, kind === 'archived' ? 1 : null, 1);
          h.keychain.setSync(qlbKeychainService('anthropic', accountId), QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ claudeAiOauth: { accessToken: 'retired-access', refreshToken: 'retired-refresh', expiresAt: 42 } }));
        }
        h.store.setConfig('pi.anthropic.baselineConsumedBy', accountId);
        let reads = 0;
        const keychain = { getSync: (...args: Parameters<MockKeychain['getSync']>) => { reads += 1; return h.keychain.getSync(...args); }, setSync: h.keychain.setSync.bind(h.keychain), deleteSync: h.keychain.deleteSync.bind(h.keychain) };
        const result = rollbackPiSingleProvider('anthropic', h.paths, { keychain, store: h.store, enabledProviders: ALL });
        assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).anthropic, h.baseline, kind);
        assert.deepEqual(result.warnings, [`consumer-slot-gone:anthropic:${accountId}`], kind);
        assert.equal(reads, 0, kind);
      } finally { h.cleanup(); }
    }
  });

  it('anthropic: rollback with a journal below consumption-recorded restores the baseline unchanged and never reads a live slot item', () => {
    const h = setupAnthropicRollback();
    try {
      const db = (h.store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
      db.prepare("INSERT INTO claude_slots (account_id, config_json, dead, added_at) VALUES (?, '{}', 0, ?)").run('slot-a', 1);
      h.keychain.setSync(qlbKeychainService('anthropic', 'slot-a'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ claudeAiOauth: { accessToken: 'slot-access', refreshToken: 'slot-refresh', expiresAt: 42 } }));
      h.store.setConfig('pi.anthropic.baselineConsumedBy', 'slot-a'); writePiJournal(h.paths, 'anthropic', 'baseline');
      let reads = 0;
      const keychain = { getSync: (...args: Parameters<MockKeychain['getSync']>) => { reads += 1; return h.keychain.getSync(...args); }, setSync: h.keychain.setSync.bind(h.keychain), deleteSync: h.keychain.deleteSync.bind(h.keychain) };
      const result = rollbackPiSingleProvider('anthropic', h.paths, { keychain, store: h.store, enabledProviders: ALL });
      assert.equal(reads, 0);
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).anthropic, h.baseline);
      assert.equal(result.warnings, undefined);
      assert.equal(h.store.getConfig('pi.anthropic.baselineConsumedBy'), '');
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback refuses a malformed live consuming slot item before un-owning', () => {
    const h = setupAnthropicRollback();
    try {
      const db = (h.store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
      db.prepare("INSERT INTO claude_slots (account_id, config_json, dead, added_at) VALUES (?, '{}', 0, ?)").run('slot-a', 1);
      h.store.setConfig('pi.anthropic.baselineConsumedBy', 'slot-a');
      h.keychain.setSync(qlbKeychainService('anthropic', 'slot-a'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ claudeAiOauth: { accessToken: 'partial' } }));
      expectRefusal(h, 'anthropic', 'claude-slot-unreadable', () => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback refuses owner-file-legacy-v1 with exitCode 3 and writes nothing', () => {
    const h = setupAnthropicRollback();
    try {
      // This v1 document does not claim anthropic, so the at-rest ownership
      // check permits it and rollback reaches the legacy-document refusal.
      writeFileSync(h.paths.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }));
      expectRefusal(h, 'anthropic', 'owner-file-legacy-v1', () => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback refuses anthropic-pool-dir-ambiguous before any write while both entries exist and completes once one is removed', () => {
    const h = setupAnthropicRollback();
    try {
      mkdirSync(h.livePool, { recursive: true });
      expectRefusal(h, 'anthropic', 'anthropic-pool-dir-ambiguous', () => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
      rmSync(h.livePool, { recursive: true });
      rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.equal(existsSync(h.livePool), true);
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback refuses pi-extensions-dir-in-git-worktree when either pool directory is a symlink into a git work tree', () => {
    for (const which of ['extensions', 'disabled'] as const) {
      const h = setupAnthropicRollback(); const repo = mkdtempSync(join(tmpdir(), 'qlb-pool-repo-'));
      try {
        gitInit(repo);
        const path = which === 'extensions' ? h.paths.extensionsDir : h.paths.disabledExtensionsDir;
        rmSync(path, { recursive: true, force: true }); symlinkSync(repo, path);
        expectRefusal(h, 'anthropic', 'pi-extensions-dir-in-git-worktree', () => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
      } finally { h.cleanup(); rmSync(repo, { recursive: true, force: true }); }
    }
  });

  it('anthropic: rollback refuses pi-not-migrated when only a generic v2 entry and placeholder exist', () => {
    const h = setupAnthropicRollback();
    try {
      h.store.setConfig('pi.anthropic.state', '');
      expectRefusal(h, 'anthropic', 'pi-not-migrated', () => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback refuses pi-not-migrated on a never-migrated provider', () => {
    const h = setup();
    try {
      expectRefusal(h, 'anthropic', 'pi-not-migrated', () => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback refuses owned-by-generic-migrate while migrations.pi-pool is QLB_OWNED, MIRRORED, has a v1 claim, holds a sidecar or rollback intent, including dangling symlink evidence', () => {
    for (const kind of ['owned', 'mirrored', 'intent', 'decision', 'handback', 'sidecar', 'staging-link', 'pre-qlb-link', 'owner-link', 'legacy-owner'] as const) {
      const h = setupAnthropicRollback();
      try {
        if (kind === 'owned') h.store.upsertMigration('pi-pool', 'QLB_OWNED', '{}');
        if (kind === 'mirrored') h.store.upsertMigration('pi-pool', 'MIRRORED', '{}');
        if (kind === 'intent') h.store.upsertMigration('pi-pool', 'NATIVE', JSON.stringify({ intent: 'rollback' }));
        if (kind === 'decision') h.store.upsertMigration('pi-pool', 'NATIVE', JSON.stringify({ rollbackDecision: 'keep' }));
        if (kind === 'handback') h.store.upsertMigration('pi-pool', 'NATIVE', JSON.stringify({ handback: true }));
        if (kind === 'sidecar') { h.store.upsertMigration('pi-pool', 'NATIVE', '{}'); writeFileSync(`${h.paths.poolFilePath}.pre-qlb`, 'x'); }
        if (kind === 'staging-link') symlinkSync(join(h.dir, 'missing-staging'), join(dirname(h.paths.ownerPath), 'qlb-owner.json.staging'));
        if (kind === 'pre-qlb-link') symlinkSync(join(h.dir, 'missing-pre-qlb'), `${h.paths.poolFilePath}.pre-qlb`);
        if (kind === 'owner-link') { rmSync(h.paths.ownerPath); symlinkSync(join(h.dir, 'missing-owner'), h.paths.ownerPath); }
        if (kind === 'legacy-owner') writeFileSync(h.paths.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }));
        expectRefusal(h, 'anthropic', 'owned-by-generic-migrate', () => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
      } finally { h.cleanup(); }
    }
    const h = setupAnthropicRollback(); try { h.store.upsertMigration('pi-pool', 'NATIVE', '{}'); assert.doesNotThrow(() => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL })); } finally { h.cleanup(); }
  });

  it('anthropic: rollback with no pool entry anywhere restores the entry only', () => {
    const h = setupAnthropicRollback();
    try { rmSync(h.disabledPool, { recursive: true }); rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }); assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).anthropic, h.baseline); } finally { h.cleanup(); }
  });

  it('anthropic: rollback keeps a newer valid native login, restores the pool entry and clears markers', () => {
    const h = setupAnthropicRollback();
    try {
      const newer = oauth('anthropic-new'); writeFileSync(h.paths.authJsonPath, JSON.stringify({ anthropic: newer }));
      rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')).anthropic, newer);
      assert.equal(existsSync(h.livePool), true);
      assert.equal(lstatPresent(h.disabledPool), false);
      assert.equal(h.store.getConfig('pi.anthropic.state'), '');
      assert.equal(h.store.getConfig('pi.anthropic.migratedAt'), '');
      assert.equal(h.store.getConfig('pi.anthropic.baselineConsumedBy'), '');
      assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-anthropic.json')), false);
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback refuses absent or placeholder entries without a valid source and every unrecognised present entry before cleanup', () => {
    const cases: Array<{ name: string; current: unknown; baseline: Record<string, unknown>; code: string }> = [
      { name: 'absent entry with invalid baseline', current: undefined, baseline: { ...oauth('invalid-absent'), type: 'api-key' }, code: 'no-restore-source' },
      { name: 'placeholder with invalid baseline', current: { type: 'oauth', access: 'qlb-managed', refresh: '', expires: 1 }, baseline: { ...oauth('invalid-placeholder'), type: 'api-key' }, code: 'no-restore-source' },
      { name: 'incomplete entry', current: { type: 'oauth', access: 'partial' }, baseline: oauth('valid-incomplete'), code: 'unrecognised-anthropic-entry' },
      { name: 'Pi api key entry', current: { type: 'api_key', key: 'fixture' }, baseline: oauth('valid-api-key'), code: 'unrecognised-anthropic-entry' },
      { name: 'empty-access OAuth entry', current: { type: 'oauth', access: '', refresh: 'refresh-fixture', expires: 1 }, baseline: oauth('valid-empty-access'), code: 'unrecognised-anthropic-entry' },
    ];
    for (const fixture of cases) {
      const h = setupAnthropicRollback();
      try {
        writeFileSync(h.paths.authJsonPath, JSON.stringify(fixture.current === undefined ? {} : { anthropic: fixture.current }));
        writeFileSync(join(h.paths.baselineDir, 'anthropic.json'), JSON.stringify(fixture.baseline));
        writePiJournal(h.paths, 'anthropic', 'published');
        expectRefusal(h, 'anthropic', fixture.code, () => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
      } finally { h.cleanup(); }
    }
  });

  it('anthropic: rollback un-owns before restoring the auth entry', () => {
    const h = setupAnthropicRollback();
    try {
      rollbackPiSingleProvider('anthropic', h.paths, {
        keychain: h.keychain, store: h.store, enabledProviders: ALL,
        afterWrite: (point) => {
          if (point !== 'owner-entry') return;
          assert.equal(placeholderPresent(h.paths, 'anthropic'), true);
          assert.equal(existsSync(h.paths.ownerPath), false);
        },
      });
    } finally { h.cleanup(); }
  });

  it('anthropic: rollback is re-runnable after a crash at each write and cleanup marker point', () => {
    for (const point of ['owner-entry', 'entry-restored', 'pool-dir-restored', 'migrated-at', 'baseline-consumed-by', 'journal-cleared', 'state-cleared'] as const) {
      const h = setupAnthropicRollback(); try {
        assert.throws(() => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL, afterWrite: (actual: string) => { if (actual === point) throw new Error('crash'); } }), /crash/, point);
        if (point === 'state-cleared') {
          expectRefusal(h, 'anthropic', 'pi-not-migrated', () => rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
        } else {
          rollbackPiSingleProvider('anthropic', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
        }
        assertAnthropicRollbackClean(h);
      } finally { h.cleanup(); }
    }
  });

  it('anthropic: a lock takeover after each write point stops rollback before the next write class', () => {
    for (const point of ['owner-entry', 'entry-restored', 'pool-dir-restored'] as const) {
      const h = setupAnthropicRollback(); try {
        assert.throws(() => rollbackPiSingleProvider('anthropic', h.paths, {
          keychain: h.keychain, store: h.store, enabledProviders: ALL, withAuthLock: (path, fn) => withPiAuthLock(path, fn),
          afterWrite: (actual) => { if (actual === point) writeFileSync(join(`${h.paths.authJsonPath}.lock`, 'qlb-lock-owner.json'), JSON.stringify({ pid: process.pid, nonce: 'foreign' })); },
        }), (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'pi-auth-lock-lost' && (error as { exitCode?: unknown }).exitCode === 1);
        if (point === 'owner-entry') assert.equal(placeholderPresent(h.paths, 'anthropic'), true, point);
        if (point === 'entry-restored') { assert.equal(lstatPresent(h.disabledPool), true, point); assert.equal(lstatPresent(h.livePool), false, point); }
        if (point === 'pool-dir-restored') {
          assert.equal(h.store.getConfig('pi.anthropic.state'), 'migrated', point);
          assert.equal(h.store.getConfig('pi.anthropic.migratedAt'), '1', point);
        }
      } finally { h.cleanup(); }
    }
  });

  it('openai-codex: migrate writes baseline, placeholder and owner entry and records pi.openai-codex.state without any Keychain write', () => {
    const h = setup();
    try {
      const native = { ...oauth('codex-native'), accountId: 'acct-codex' };
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': native }), { mode: 0o600 });
      let sets = 0;
      const keychain = {
        getSync: h.keychain.getSync.bind(h.keychain),
        setSync: (...args: Parameters<MockKeychain['setSync']>) => { sets += 1; h.keychain.setSync(...args); },
        deleteSync: h.keychain.deleteSync.bind(h.keychain),
      };
      const result = migratePiSingleProvider('openai-codex', h.paths, { keychain, store: h.store, enabledProviders: ALL });
      assert.deepEqual(result.wouldWrite, ['baseline:openai-codex', 'placeholder:openai-codex', 'owner:openai-codex']);
      assert.equal(sets, 0);
      const auth = JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')) as Record<string, unknown>;
      assert.equal(placeholderPresent(h.paths, 'openai-codex'), true);
      assert.deepEqual(JSON.parse(readFileSync(join(h.paths.baselineDir, 'openai-codex.json'), 'utf8')), native);
      assert.equal((JSON.parse(readFileSync(h.paths.ownerPath, 'utf8')) as { providers: Record<string, { mode: string }> }).providers['openai-codex']?.mode, 'qlb');
      assert.equal(h.store.getConfig('pi.openai-codex.state'), 'migrated');
      assert.equal(h.store.listLineageTransitions('openai-codex', 'default').length, 0);
      assert.equal(h.store.getAccount('openai-codex-default'), null);
      assert.equal(auth['openai-codex'] !== undefined, true);
    } finally { h.cleanup(); }
  });

  it('openai-codex: the publishing phase is journaled before the placeholder is written', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('native') }), { mode: 0o600 });
      migratePiSingleProvider('openai-codex', h.paths, {
        keychain: h.keychain, store: h.store, enabledProviders: ALL,
        afterWrite: (point) => {
          if (point !== 'publishing') return;
          assert.equal(placeholderPresent(h.paths, 'openai-codex'), false);
          assert.equal(JSON.parse(readFileSync(join(h.paths.journalPath, 'pi-migrate-openai-codex.json'), 'utf8')).phase, 'publishing');
        },
      });
    } finally { h.cleanup(); }
  });

  it('openai-codex: dry-run lists baseline, placeholder and owner and changes nothing on disk or in the store', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('native') }), { mode: 0o600 });
      const before = readFileSync(h.paths.authJsonPath, 'utf8');
      const result = migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }, { dryRun: true });
      assert.deepEqual(result.wouldWrite, ['baseline:openai-codex', 'placeholder:openai-codex', 'owner:openai-codex']);
      assert.equal(readFileSync(h.paths.authJsonPath, 'utf8'), before);
      assert.equal(existsSync(h.paths.ownerPath), false);
      assert.equal(h.store.getConfig('pi.openai-codex.state'), null);
    } finally { h.cleanup(); }
  });

  it('openai-codex: writes not-applicable with reason no-pi-credential when auth.json has no entry and nothing owns the provider', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, '{}', { mode: 0o600 });
      const result = migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.deepEqual(result, { provider: 'openai-codex', state: 'not-applicable', resumed: false, wouldWrite: ['baseline:openai-codex', 'placeholder:openai-codex', 'owner:openai-codex'], reason: 'no-pi-credential' });
      assert.equal(existsSync(h.paths.ownerPath), false);
      assert.equal(existsSync(join(h.paths.baselineDir, 'openai-codex.json')), false);
      assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-openai-codex.json')), false);
      assert.equal(h.store.getConfig('pi.openai-codex.state'), 'not-applicable');
    } finally { h.cleanup(); }
  });

  it('openai-codex: a crash after not-applicable state is written leaves only a started journal, then re-run and rollback ignore a stale baseline', () => {
    const h = setup();
    try {
      const stale = oauth('stale-baseline');
      writeFileSync(h.paths.authJsonPath, '{}', { mode: 0o600 });
      mkdirSync(h.paths.baselineDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(h.paths.baselineDir, 'openai-codex.json'), JSON.stringify(stale), { mode: 0o600 });
      assert.throws(() => migratePiSingleProvider('openai-codex', h.paths, {
        keychain: h.keychain, store: h.store, enabledProviders: ALL,
        afterWrite: (point: string) => { if (point === 'not-applicable') throw new Error('injected crash'); },
      }), /injected crash/);
      assert.equal(h.store.getConfig('pi.openai-codex.state'), 'not-applicable');
      assert.equal(JSON.parse(readFileSync(join(h.paths.journalPath, 'pi-migrate-openai-codex.json'), 'utf8')).phase, 'started');
      assert.equal(migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }).state, 'not-applicable');
      expectRefusal(h, 'openai-codex', 'pi-not-migrated', () => rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8')), {});
    } finally { h.cleanup(); }
  });

  for (const damage of ['missing', 'corrupt'] as const) {
    for (const dryRun of [false, true]) {
      it(`openai-codex: ${dryRun ? 'dry-run' : 're-run'} refuses baseline-unreadable after a completed migration's baseline is ${damage}`, () => {
        const h = setup();
        try {
          writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('native') }), { mode: 0o600 });
          migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
          const file = join(h.paths.baselineDir, 'openai-codex.json');
          if (damage === 'missing') rmSync(file);
          else writeFileSync(file, '{"access":"truncated"', { mode: 0o600 });
          expectRefusal(h, 'openai-codex', 'baseline-unreadable', () => migratePiSingleProvider(
            'openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }, { dryRun },
          ));
        } finally { h.cleanup(); }
      });
    }
  }

  for (const dryRun of [false, true]) {
    it(`openai-codex: ${dryRun ? 'dry-run' : 'migrate'} refuses a placeholder under a started journal without adopting a stale baseline`, () => {
      const h = setup();
      try {
        writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'qlb-managed', refresh: '', expires: 1 } }), { mode: 0o600 });
        mkdirSync(h.paths.baselineDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(h.paths.baselineDir, 'openai-codex.json'), JSON.stringify(oauth('stale-baseline')), { mode: 0o600 });
        writePiJournal(h.paths, 'openai-codex', 'started', { priorBaselineConsumedBy: '' });
        const before = {
          auth: readFileSync(h.paths.authJsonPath, 'utf8'),
          baseline: readFileSync(join(h.paths.baselineDir, 'openai-codex.json'), 'utf8'),
          journal: readFileSync(join(h.paths.journalPath, 'pi-migrate-openai-codex.json'), 'utf8'),
          state: h.store.getConfig('pi.openai-codex.state'),
        };
        assert.throws(() => migratePiSingleProvider(
          'openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }, { dryRun },
        ), /baseline would be a placeholder/);
        assert.deepEqual({
          auth: readFileSync(h.paths.authJsonPath, 'utf8'),
          baseline: readFileSync(join(h.paths.baselineDir, 'openai-codex.json'), 'utf8'),
          journal: readFileSync(join(h.paths.journalPath, 'pi-migrate-openai-codex.json'), 'utf8'),
          state: h.store.getConfig('pi.openai-codex.state'),
        }, before);
      } finally { h.cleanup(); }
    });
  }

  it('openai-codex: refuses native-entry-removed when state is migrated and the entry is gone, and rollback then restores the baseline', () => {
    const h = setupCodexRollback();
    try {
      writeFileSync(h.paths.authJsonPath, '{}', { mode: 0o600 });
      expectRefusal(h, 'openai-codex', 'native-entry-removed', () => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
      rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8'))['openai-codex'], h.baseline);
    } finally { h.cleanup(); }
  });

  it('openai-codex: refuses native-entry-rewritten when state is migrated, no journal exists and the entry is not the placeholder', () => {
    const h = setupCodexRollback();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('rewritten') }), { mode: 0o600 });
      expectRefusal(h, 'openai-codex', 'native-entry-rewritten', () => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  it('openai-codex: refuses unless the generic migration is at rest', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('native') }), { mode: 0o600 });
      h.store.upsertMigration('pi-openai-codex', 'MIRRORED', '{}');
      expectRefusal(h, 'openai-codex', 'owned-by-generic-migrate', () => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }));
    } finally { h.cleanup(); }
  });

  for (const point of ['baseline', 'publishing', 'placeholder', 'owner-entry', 'before-committed'] as const) {
    it(`openai-codex: resumes and rolls back from ${point}`, () => {
      const h = setup();
      try {
        const native = oauth('codex-native');
        writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': native }), { mode: 0o600 });
        assert.throws(() => migratePiSingleProvider('openai-codex', h.paths, {
          keychain: h.keychain, store: h.store, enabledProviders: ALL,
          afterWrite: (written) => { if (written === point) throw new Error('injected crash'); },
        }));
        migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
        rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
        assert.equal(typeof (JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8'))['openai-codex'] as { refresh?: unknown }).refresh, 'string');
      } finally { h.cleanup(); }
    });
  }

  it('openai-codex: a rotation between a crash at baseline and the resume lands in the baseline', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('old') }), { mode: 0o600 });
      assert.throws(() => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL, afterWrite: (point) => { if (point === 'baseline') throw new Error('crash'); } }));
      const rotated = oauth('rotated');
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': rotated }), { mode: 0o600 });
      migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.deepEqual(JSON.parse(readFileSync(join(h.paths.baselineDir, 'openai-codex.json'), 'utf8')), rotated);
      rollbackPiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.deepEqual(JSON.parse(readFileSync(h.paths.authJsonPath, 'utf8'))['openai-codex'], rotated);
    } finally { h.cleanup(); }
  });

  it('openai-codex: a rotation after the publishing phase is journaled does not touch the baseline and refuses the resume', () => {
    const h = setup();
    try {
      const native = oauth('native');
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': native }), { mode: 0o600 });
      assert.throws(() => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL, afterWrite: (point) => { if (point === 'publishing') throw new Error('crash'); } }));
      const baseline = readFileSync(join(h.paths.baselineDir, 'openai-codex.json'));
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('rotated') }), { mode: 0o600 });
      assert.throws(() => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }), /entry changed after publication/);
      assert.equal(readFileSync(join(h.paths.baselineDir, 'openai-codex.json')).equals(baseline), true);
    } finally { h.cleanup(); }
  });

  it('openai-codex: dry-run refuses a rotated entry after publishing just as a real resume does', () => {
    const h = setup();
    try {
      const native = oauth('native');
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': native }), { mode: 0o600 });
      assert.throws(() => migratePiSingleProvider('openai-codex', h.paths, {
        keychain: h.keychain, store: h.store, enabledProviders: ALL,
        afterWrite: (point) => { if (point === 'publishing') throw new Error('crash'); },
      }), /crash/);
      const baseline = readFileSync(join(h.paths.baselineDir, 'openai-codex.json'));
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('rotated') }), { mode: 0o600 });
      assert.throws(() => migratePiSingleProvider(
        'openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }, { dryRun: true },
      ), /entry changed after publication/);
      assert.equal(readFileSync(join(h.paths.baselineDir, 'openai-codex.json')).equals(baseline), true);
    } finally { h.cleanup(); }
  });

  it('openai-codex: a resume from a journal at consumption-recorded decides its refusals before the phase-dropped write', () => {
    const h = setup();
    try {
      const native = oauth('native');
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': native }), { mode: 0o600 });
      mkdirSync(h.paths.baselineDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(h.paths.baselineDir, 'openai-codex.json'), JSON.stringify(native), { mode: 0o600 });
      writePiJournal(h.paths, 'openai-codex', 'consumption-recorded', { priorBaselineConsumedBy: '' });
      h.store.upsertMigration('pi-openai-codex', 'MIRRORED', '{}');
      let writes = 0;
      expectRefusal(h, 'openai-codex', 'owned-by-generic-migrate', () => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL, afterWrite: () => { writes += 1; } }));
      assert.equal(writes, 0);
      h.store.upsertMigration('pi-openai-codex', 'NATIVE', '{}');
      let first = '';
      migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL, afterWrite: (point) => { if (!first) first = point; } });
      assert.equal(first, 'phase-dropped');
    } finally { h.cleanup(); }
  });

  it('openai-codex: dry-run reports the git-work-tree and generic-ownership refusals', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('native') }), { mode: 0o600 });
      h.store.upsertMigration('pi-openai-codex', 'MIRRORED', '{}');
      expectRefusal(h, 'openai-codex', 'owned-by-generic-migrate', () => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }, { dryRun: true }));
      h.store.upsertMigration('pi-openai-codex', 'NATIVE', '{}');
      gitInit(h.dir);
      expectRefusal(h, 'openai-codex', 'pi-path-in-git-worktree', () => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }, { dryRun: true }));
    } finally { h.cleanup(); }
  });

  it('openai-codex: refuses a placeholder entry with no journal before writing anything', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'qlb-managed', refresh: '', expires: 1 } }), { mode: 0o600 });
      const before = readFileSync(h.paths.authJsonPath, 'utf8');
      assert.throws(() => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL }), /baseline would be a placeholder/);
      assert.equal(readFileSync(h.paths.authJsonPath, 'utf8'), before);
      assert.equal(existsSync(join(h.paths.journalPath, 'pi-migrate-openai-codex.json')), false);
    } finally { h.cleanup(); }
  });

  it('openai-codex: a crash between the publishing journal and the placeholder write resumes and writes the placeholder', () => {
    const h = setup();
    try {
      const native = oauth('native');
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': native }), { mode: 0o600 });
      assert.throws(() => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL, afterWrite: (point) => { if (point === 'publishing') throw new Error('crash'); } }));
      const baseline = readFileSync(join(h.paths.baselineDir, 'openai-codex.json'));
      migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      assert.equal(placeholderPresent(h.paths, 'openai-codex'), true);
      assert.equal(readFileSync(join(h.paths.baselineDir, 'openai-codex.json')).equals(baseline), true);
    } finally { h.cleanup(); }
  });

  it('openai-codex: a completed migration re-run is idempotent', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('native') }), { mode: 0o600 });
      migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL });
      let writes = 0;
      const result = migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL, afterWrite: () => { writes += 1; } });
      assert.equal(result.state, 'migrated');
      assert.equal(writes, 0);
    } finally { h.cleanup(); }
  });

  it('openai-codex: a lock takeover before the baseline write exits 3 and writes nothing', () => {
    const h = setup();
    try {
      writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('native') }), { mode: 0o600 });
      const takenOverOnEntry = <T,>(path: string, fn: (refresh: () => void) => T): T => withPiAuthLock(path, (refresh) => {
        writeFileSync(join(`${path}.lock`, 'qlb-lock-owner.json'), JSON.stringify({ pid: process.pid, nonce: 'foreign' }));
        return fn(refresh);
      });
      assert.throws(() => migratePiSingleProvider('openai-codex', h.paths, { keychain: h.keychain, store: h.store, enabledProviders: ALL, withAuthLock: takenOverOnEntry }), (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'pi-auth-lock-lost' && (error as { exitCode?: unknown }).exitCode === 3);
      assert.equal(existsSync(join(h.paths.baselineDir, 'openai-codex.json')), false);
    } finally { h.cleanup(); }
  });

  for (const point of ['baseline', 'publishing', 'placeholder', 'owner-entry'] as const) {
    it(`openai-codex: a lock takeover after ${point} stops migrate before the next write class`, () => {
      const h = setup();
      try {
        writeFileSync(h.paths.authJsonPath, JSON.stringify({ 'openai-codex': oauth('native') }), { mode: 0o600 });
        assert.throws(() => migratePiSingleProvider('openai-codex', h.paths, {
          keychain: h.keychain, store: h.store, enabledProviders: ALL, withAuthLock: (path, fn) => withPiAuthLock(path, fn),
          afterWrite: (written) => { if (written === point) writeFileSync(join(`${h.paths.authJsonPath}.lock`, 'qlb-lock-owner.json'), JSON.stringify({ pid: process.pid, nonce: 'foreign' })); },
        }), (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'pi-auth-lock-lost' && (error as { exitCode?: unknown }).exitCode === 1);
      } finally { h.cleanup(); }
    });
  }

  it('resolves a symlinked auth target before the git worktree check', () => {
    const h = setup(); const target = mkdtempSync(join(tmpdir(), 'qlb-pi-target-'));
    try {
      execFileSync('git', ['init', '-q', target]);
      const targetAuth = join(target, 'auth.json'); writeFileSync(targetAuth, JSON.stringify({ xai: oauth('native') }));
      rmSync(h.paths.authJsonPath); symlinkSync(targetAuth, h.paths.authJsonPath);
      assert.throws(() => migratePiSingleProvider('xai', h.paths, { keychain: h.keychain }), /git work tree/);
      assert.throws(() => rollbackPiSingleProvider('xai', h.paths, { keychain: h.keychain, store: h.store }), /git work tree/);
    } finally { h.cleanup(); rmSync(target, { recursive: true, force: true }); }
  });
});
