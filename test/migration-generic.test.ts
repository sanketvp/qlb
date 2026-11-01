import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it, mock } from 'node:test';
import { createOwnedCredentialSource } from '../src/credentials';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { OPENROUTER_GATE_KEYCHAIN_SERVICE } from '../src/token/openrouter';
import {
  ADAPTER_ACCOUNT_IDS,
  ADAPTER_ACCOUNT_LABELS,
  Migration,
  NATIVE_OPENROUTER_KEYCHAIN_SERVICE,
  SINGLE_GRANT_PROVIDERS,
  createSingleGrantMigration,
  createStaticKeyMigration,
  parseApiKeyPayload,
  stageGenericGrant,
  stagingOwnerPath,
  type ApiKeyPayload,
  type MigrationConfig,
  type RehearseFn,
  type SingleGrantProvider,
  type StagedAccount,
} from '../src/migration';
import { parseGrant } from '../src/refresh-lease';
import { sharedSingleGrantCoords, type RollbackDecision } from '../src/single-grant-ownership';
import { legacyPiAuthBackupPath, piAuthBackupPath, readPiAuthBackup, writePiAuthBackup } from '../src/pi-auth-backup';
import { canonicalDigest, keychainDigest, restoreRecordFor } from '../src/pi-handback-source';
import { bindDetectAndResync } from '../src/native-resync';
import { hasLegacyPiOwnerEntry, isPiPlaceholder } from '../src/pi-migrate';
import { openStore } from '../src/store';

const fs = require('node:fs') as typeof import('node:fs');

/**
 * Fixture grants — fake tokens only. This file never points at the live
 * Pi agent directory; every auth.json path is a temp copy.
 *
 * Adapter accountId sources (must stay in lockstep):
 *   src/adapters/xai.ts    snapshot.accountId = 'xai-default'
 *   src/adapters/kimi.ts   claimId            = 'kimi-default'
 *   src/adapters/codex.ts  S29 slot identity
 */
const ROLLBACK_DECISION: RollbackDecision = {
  kind: 'keychain',
  generation: 0,
  fingerprint: 'fixture-fingerprint',
  entryPresent: true,
  sourceDigest: 'fixture-source-digest',
  kd0: 'fixture-kd0',
  decidedAt: 123,
  fencedGeneration: 0,
};

const FAKE_GRANTS: Record<
  SingleGrantProvider,
  { type: 'oauth'; access: string; refresh: string; expires: number; accountId?: string }
> = {
  xai: {
    type: 'oauth',
    access: 'xai-access-fake',
    refresh: 'xai-refresh-fake',
    expires: Date.now() + 7 * 24 * 3600 * 1000,
  },
  'kimi-coding': {
    type: 'oauth',
    access: 'kimi-access-fake',
    refresh: 'kimi-refresh-fake',
    expires: Date.now() + 7 * 24 * 3600 * 1000,
  },
  'openai-codex': {
    type: 'oauth',
    access: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account' },
    })).toString('base64url')}.sig`,
    refresh: 'codex-refresh-fake',
    expires: Date.now() + 7 * 24 * 3600 * 1000,
    accountId: 'fixture-account',
  },
};

function fixtureAuthJson(): string {
  return JSON.stringify(FAKE_GRANTS, null, 2) + '\n';
}

function mockRehearse(calls: StagedAccount[]): RehearseFn {
  return async (account) => {
    calls.push(account);
    assert.ok(account.grant.access, 'rehearse received staged access token');
    assert.ok(account.grant.refresh, 'rehearse received staged refresh token');
    return { ok: true };
  };
}

function expectedId(provider: SingleGrantProvider): string {
  return provider === 'openai-codex' ? 'fixture-user:fixture-account' : ADAPTER_ACCOUNT_IDS[provider];
}

function expectedLabel(provider: SingleGrantProvider): string {
  return provider === 'openai-codex' ? expectedId(provider) : ADAPTER_ACCOUNT_LABELS[provider];
}

function kmCoords(provider: SingleGrantProvider): { service: string; account: string } {
  if (provider === 'xai' || provider === 'kimi-coding') return sharedSingleGrantCoords(provider);
  return legacyKmCoords(provider);
}

function legacyKmCoords(provider: SingleGrantProvider): { service: string; account: string } {
  return {
    service: qlbKeychainService(provider, expectedId(provider)),
    account: expectedLabel(provider),
  };
}

class RollbackDeleteKeychain extends MockKeychain {
  mode: 'succeed' | 'denied' | 'not-found' = 'succeed';

  override deleteSync(service: string, account: string): void {
    if (this.mode === 'denied') throw new Error('fixture Keychain access denied');
    if (this.mode === 'not-found') throw new Error('fixture Keychain item not found');
    super.deleteSync(service, account);
  }
}

class DeleteTrackingKeychain extends MockKeychain {
  deleteCalls: Array<{ service: string; account: string }> = [];
  beforeDelete: (() => void) | undefined;

  override deleteSync(service: string, account: string): void {
    this.beforeDelete?.();
    this.deleteCalls.push({ service, account });
    super.deleteSync(service, account);
  }
}

class StageWriteTrackingKeychain extends MockKeychain {
  setCalls: Array<{ service: string; account: string }> = [];
  beforeSet: (() => void) | undefined;

  override setSync(service: string, account: string, value: string): void {
    this.beforeSet?.();
    this.setCalls.push({ service, account });
    super.setSync(service, account, value);
  }
}

class S2ReadTaxonomyKeychain extends MockKeychain {
  getCalls = 0;
  faultOnGet: number | undefined;
  fault: 'malformed' | 'unavailable' | undefined;

  override getSync(service: string, account: string): string {
    this.getCalls += 1;
    if (this.faultOnGet === this.getCalls) {
      if (this.fault === 'malformed') return '{not-json';
      if (this.fault === 'unavailable') throw new Error('fixture Keychain unavailable');
    }
    return super.getSync(service, account);
  }
}

class ReadTrackingKeychain extends MockKeychain {
  getCalls: Array<{ service: string; account: string }> = [];

  override getSync(service: string, account: string): string {
    this.getCalls.push({ service, account });
    return super.getSync(service, account);
  }
}

function keychainHas(
  kc: MockKeychain,
  provider: SingleGrantProvider,
): boolean {
  try {
    const raw = kc.getSync(
      kmCoords(provider).service,
      kmCoords(provider).account,
    );
    const grant = parseGrant(raw);
    return grant.access === FAKE_GRANTS[provider].access;
  } catch {
    return false;
  }
}

function fileSnapshot(dir: string, prefix = ''): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [nestedPath, bytes] of fileSnapshot(path, relative)) files.set(nestedPath, bytes);
    } else if (entry.isFile()) {
      files.set(relative, readFileSync(path));
    }
  }
  return files;
}

interface Harness {
  dir: string;
  authPath: string;
  ownerPath: string;
  originalBytes: Buffer;
  store: ReturnType<typeof openStore>;
  kc: MockKeychain;
  cleanup: () => void;
}

function ownerMapPath(h: Harness): string {
  return join(h.dir, 'qlb-owner.json');
}

function legacySidecarPath(h: Harness, provider: SingleGrantProvider = 'xai'): string {
  return join(h.dir, `qlb-owner-${provider}.json`);
}

function currentExactBackupDecision(h: Harness, provider: SingleGrantProvider = 'xai'): RollbackDecision {
  const backup = readPiAuthBackup(h.authPath, provider);
  assert.ok(backup?.entry && typeof backup.entry === 'object', 'P7b6 commit wrote the native auth backup');
  const entry = backup.entry as { refresh: string };
  return {
    kind: 'exact-backup', generation: 0, fingerprint: createHash('sha256').update(entry.refresh, 'utf8').digest('hex'),
    entryPresent: true, sourceDigest: canonicalDigest(backup), kd0: keychainDigest(parseGrant(h.kc.getSync(kmCoords(provider).service, kmCoords(provider).account))),
    decidedAt: 123, fencedGeneration: 0,
  };
}

function setup(
  provider: SingleGrantProvider,
  kc: MockKeychain = new MockKeychain(),
  config: Pick<MigrationConfig, 'fsyncDirectory' | 'afterStep' | 'afterWrite' | 'sleepSync' | 'now' | 'authLockTiming' | 'beforeOwnerFileRename'> = {},
): Harness & {
  mig: Migration;
} {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
  const authPath = join(dir, 'auth.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  const original = fixtureAuthJson();
  writeFileSync(authPath, original, { encoding: 'utf8', mode: 0o600 });
  const originalBytes = readFileSync(authPath);
  const store = openStore(join(dir, 'qlb.db'));
  const mig = createSingleGrantMigration(
    store,
    kc,
    provider,
    authPath,
    ownerPath,
    provider,
    config,
  );
  return {
    dir,
    authPath,
    ownerPath,
    originalBytes,
    store,
    kc,
    mig,
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type CrashWindow = 'S1-legacy-delete' | 'S1-legacy-unlink' | 'S1-stage' | 'keychain-write-failed' | 'after-keychain-write';

class CrashingStageKeychain extends MockKeychain {
  setMode: 'ok' | 'fail-before' | 'fail-after' = 'ok';

  override setSync(service: string, account: string, value: string): void {
    if (this.setMode === 'fail-before') throw new Error('fixture crash: Keychain write failed');
    super.setSync(service, account, value);
    if (this.setMode === 'fail-after') throw new Error('fixture crash after Keychain write');
  }
}

type OldFixture = Harness & { mig: Migration; staging: string; crashAt: { point: string | undefined } };

/**
 * A pre-commit migration staged by the old code: the journal and staging file
 * record no `keychain` (so both name qlb:<p>:<id>), the Grant sits at that
 * old item, and the shared item does not exist.
 */
function oldPreCommitFixture(
  provider: 'xai' | 'kimi-coding',
  state: 'MIRRORED' | 'VALIDATED',
  kc: MockKeychain = new CrashingStageKeychain(),
): OldFixture {
  const crashAt: { point: string | undefined } = { point: undefined };
  const h = setup(provider, kc, {
    afterStep: (point) => {
      if (point === crashAt.point) throw new Error(`fixture crash at ${point}`);
    },
  });
  h.mig.stage();
  const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), provider);
  const detail = JSON.parse(h.store.getMigration(`pi-${provider}`)!.detail_json) as { accounts: Array<Record<string, unknown>> };
  delete detail.accounts[0]!.keychain;
  h.store.upsertMigration(`pi-${provider}`, state, JSON.stringify(detail));
  const owner = JSON.parse(readFileSync(staging, 'utf8')) as { accounts: Array<Record<string, unknown>> };
  delete owner.accounts[0]!.keychain;
  writeFileSync(staging, JSON.stringify(owner, null, 2) + '\n');
  const shared = sharedSingleGrantCoords(provider);
  kc.deleteSync(shared.service, shared.account);
  const legacy = legacyKmCoords(provider);
  kc.setSync(legacy.service, legacy.account, JSON.stringify({ ...FAKE_GRANTS[provider], generation: 0, writtenBy: 'fixture', extra: {} }));
  return { ...h, staging, crashAt };
}

function armCrash(h: OldFixture, window: CrashWindow): void {
  const kc = h.kc as CrashingStageKeychain;
  if (window === 'keychain-write-failed') kc.setMode = 'fail-before';
  else if (window === 'after-keychain-write') kc.setMode = 'fail-after';
  else h.crashAt.point = window;
}

function disarmCrash(h: OldFixture): void {
  (h.kc as CrashingStageKeychain).setMode = 'ok';
  h.crashAt.point = undefined;
}

function journalAccount(h: Harness, provider: string): Record<string, unknown> {
  const detail = JSON.parse(h.store.getMigration(`pi-${provider}`)!.detail_json) as { accounts: Array<Record<string, unknown>> };
  return detail.accounts[0]!;
}

function stagingAccount(h: OldFixture, provider: string): Record<string, unknown> | undefined {
  if (!existsSync(h.staging)) return undefined;
  const owner = JSON.parse(readFileSync(h.staging, 'utf8')) as { accounts: Array<Record<string, unknown>> };
  assert.equal(owner.accounts[0]?.provider, provider);
  return owner.accounts[0];
}

/** Everything a refused re-stage must leave alone (files other than the db, the journal, the account row). */
function snapshotRestage(h: OldFixture, provider: 'xai' | 'kimi-coding'): unknown {
  const files = [...fileSnapshot(h.dir)].filter(([name]) => !name.startsWith('qlb.db'));
  const legacy = legacyKmCoords(provider);
  return {
    files,
    journal: h.store.getMigration(`pi-${provider}`),
    account: h.store.getAccount(expectedId(provider)),
    generation: h.store.getGrantGeneration(expectedId(provider)),
    legacyItem: h.kc.getSync(legacy.service, legacy.account),
  };
}

describe('generic single-grant migration — xai / kimi-coding / openai-codex', () => {
  for (const provider of SINGLE_GRANT_PROVIDERS) {
    it(`happy path ${provider}`, async () => {
      const h = setup(provider);
      try {
        const before = readFileSync(h.authPath);
        const id = expectedId(provider);

        const staged = h.mig.stage();
        assert.equal(staged.state, 'MIRRORED');
        assert.equal(staged.ownerFile, 'staging');
        assert.equal(staged.nativeStore, 'intact');
        assert.equal(staged.piAtNextLaunch, 'native works');
        assert.equal(staged.nativeStrategy, 'shadow-retain');
        assert.equal(staged.provider, provider);
        assert.deepEqual(readFileSync(h.authPath), before, 'stage must not touch auth.json');
        assert.equal(keychainHas(h.kc, provider), true);
        assert.equal(h.store.getAccount(id)?.id, id);
        assert.equal(h.store.getAccount(id)?.provider, provider);

        const rehearseCalls: StagedAccount[] = [];
        const rehearsed = await h.mig.rehearse(mockRehearse(rehearseCalls));
        assert.equal(rehearsed.state, 'VALIDATED');
        assert.equal(rehearseCalls.length, 1);
        assert.equal(rehearseCalls[0]?.id, id);
        assert.equal(rehearseCalls[0]?.provider, provider);
        assert.equal(rehearseCalls[0]?.grant.access, FAKE_GRANTS[provider].access);
        assert.deepEqual(readFileSync(h.authPath), before, 'rehearse must not touch auth.json');

        const committed = h.mig.commit();
        assert.equal(committed.state, 'QLB_OWNED');
        assert.equal(committed.ownerFile, 'present');
        assert.equal(committed.nativeStore, 'intact', 'auth.json stays in place');
        assert.equal(committed.piAtNextLaunch, 'QLB works');
        assert.equal(committed.nativeStrategy, 'shadow-retain');
        const parsed = JSON.parse(readFileSync(h.authPath, 'utf8')) as Record<string, unknown>;
        assert.equal(isPiPlaceholder(parsed[provider]), true);
        for (const other of SINGLE_GRANT_PROVIDERS) {
          if (other !== provider) assert.deepEqual(parsed[other], FAKE_GRANTS[other]);
        }
        const owner = JSON.parse(readFileSync(join(h.dir, 'qlb-owner.json'), 'utf8')) as {
          providers: Record<string, { mode: string }>;
        };
        assert.equal(owner.providers[provider]?.mode, 'qlb');
        assert.equal(existsSync(join(h.dir, `qlb-owner-${provider}.json`)), false, 'no legacy sidecar is published');
        assert.equal(keychainHas(h.kc, provider), true);
      } finally {
        h.cleanup();
      }
    });
  }

  it('commit writes the owner entry before the placeholder', async () => {
    const h = setup('xai', new MockKeychain(), {
      afterWrite: (point) => {
        if (point === 'owner-entry') throw new Error('fixture crash after owner entry');
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      assert.throws(() => h.mig.commit(), /fixture crash after owner entry/);
      const map = join(h.dir, 'qlb-owner.json');
      assert.equal(JSON.parse(readFileSync(map, 'utf8')).providers.xai.mode, 'qlb');
      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')).xai, FAKE_GRANTS.xai);
      assert.ok(readPiAuthBackup(h.authPath, 'xai'));
      const changed = JSON.parse(readFileSync(h.authPath, 'utf8')) as typeof FAKE_GRANTS;
      changed.xai = { ...changed.xai, refresh: 'xai-refresh-after-owner-crash-fake' };
      writeFileSync(h.authPath, JSON.stringify(changed, null, 2) + '\n');
      const nativeAfterCrash = readFileSync(h.authPath);
      const backupAfterCrash = readFileSync(piAuthBackupPath(h.authPath, 'xai'));
      const resumed = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, h.ownerPath);
      assert.throws(() => resumed.resume(), (error: Error & { exitCode?: unknown }) => {
        assert.match(error.message, /native entry changed since stage; re-run stage/);
        assert.equal(error.exitCode, undefined, 'resume retains the commit refusal exit code');
        return true;
      });
      assert.deepEqual(readFileSync(h.authPath), nativeAfterCrash, 'resume preserves the newer native entry');
      assert.deepEqual(readFileSync(piAuthBackupPath(h.authPath, 'xai')), backupAfterCrash, 'resume preserves the pre-claim backup');
      resumed.rollback();
      assert.equal(existsSync(map), false, 'rollback removes the owner entry after the refused resume');
      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')).xai, changed.xai, 'rollback keeps the newer native entry');
    } finally { h.cleanup(); }
  });

  it('commit refuses when Pi refreshed the entry after stage', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const changed = JSON.parse(readFileSync(h.authPath, 'utf8')) as typeof FAKE_GRANTS;
      changed.xai = { ...changed.xai, refresh: 'xai-refreshed-after-stage-fake' };
      writeFileSync(h.authPath, JSON.stringify(changed, null, 2) + '\n');
      const authBefore = readFileSync(h.authPath);
      assert.throws(() => h.mig.commit(), /native entry changed since stage/);
      assert.deepEqual(readFileSync(h.authPath), authBefore);
      assert.equal(existsSync(join(h.dir, 'qlb-owner.json')), false);
      assert.equal(keychainHas(h.kc, 'xai'), true);
    } finally { h.cleanup(); }
  });

  it('D-B77 pre-commit rollback removes only this cycle backup', () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as { authBackupCycle: string };
      writePiAuthBackup(h.authPath, 'xai', detail.authBackupCycle);
      h.mig.rollback();
      assert.equal(readPiAuthBackup(h.authPath, 'xai'), null);
      h.mig.stage();
      writePiAuthBackup(h.authPath, 'xai', 'other-cycle');
      h.mig.rollback();
      assert.equal(readPiAuthBackup(h.authPath, 'xai')?.cycleId, 'other-cycle');
    } finally { h.cleanup(); }
  });

  it('VALIDATED + shared-map ownership: commit and resume finish hygiene and status does not report an invalid published owner', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const row = h.store.getMigration('pi-xai')!;
      h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({ ...JSON.parse(row.detail_json), commitGeneration: 0 }));
      writeFileSync(join(h.dir, 'qlb-owner.json'), JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }) + '\n');
      assert.notEqual(h.mig.status().resumeAction, 'invalid published owner; run `qlb migrate rollback`');
      assert.equal(h.mig.commit().state, 'QLB_OWNED');
      assert.equal(isPiPlaceholder(JSON.parse(readFileSync(h.authPath, 'utf8')).xai), true);
      assert.equal(h.mig.resume().state, 'QLB_OWNED');
    } finally { h.cleanup(); }
  });

  it('resume in steady-state QLB_OWNED does not replace a native re-login', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const native = JSON.parse(readFileSync(h.authPath, 'utf8')) as typeof FAKE_GRANTS;
      native.xai = { ...FAKE_GRANTS.xai, refresh: 'xai-native-relogin-fake' };
      writeFileSync(h.authPath, JSON.stringify(native, null, 2) + '\n');
      const before = readFileSync(h.authPath);
      assert.equal(h.mig.status().resumeAction, 'stale native writer: auth.json[xai] is not the placeholder; rollback or re-stage');
      assert.equal(h.mig.resume().state, 'QLB_OWNED');
      assert.deepEqual(readFileSync(h.authPath), before);
    } finally { h.cleanup(); }
  });

  it('uses the current-cycle native credential on a second migrate → rollback', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      h.mig.rollback();
      const current = { ...FAKE_GRANTS.xai, access: 'xai-access-second-cycle-fake', refresh: 'xai-refresh-second-cycle-fake' };
      writeFileSync(h.authPath, JSON.stringify({ ...FAKE_GRANTS, xai: current }, null, 2) + '\n');
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      h.mig.rollback();
      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')).xai, current, 'rollback restores this cycle\'s native entry');
    } finally { h.cleanup(); }
  });

  it('a crash after the backup and before the owner entry leaves native intact and rollback takes the pre-commit path', async () => {
    const h = setup('xai', new MockKeychain(), {
      afterWrite: (point) => { if (point === 'backup') throw new Error('fixture crash after backup'); },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      assert.throws(() => h.mig.commit(), /fixture crash after backup/);
      assert.deepEqual(readFileSync(h.authPath), h.originalBytes, 'backup crash leaves auth.json byte-identical');
      assert.equal(existsSync(ownerMapPath(h)), false, 'backup crash publishes no v2 owner entry');
      assert.ok(readPiAuthBackup(h.authPath, 'xai'), 'backup is durable for recovery');
      assert.equal(h.mig.rollback().state, 'NATIVE');
      assert.deepEqual(readFileSync(h.authPath), h.originalBytes, 'pre-commit rollback preserves native auth.json bytes');
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'xai')), false, 'current-cycle backup is removed');
    } finally { h.cleanup(); }
  });

  it('commit refuses into a legacy v1 Anthropic owner document', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const staging = stagingOwnerPath(ownerMapPath(h), 'xai');
      const stagingBefore = readFileSync(staging);
      const authBefore = readFileSync(h.authPath);
      const legacy = JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n';
      writeFileSync(ownerMapPath(h), legacy);
      assert.throws(() => h.mig.commit(), /legacy/);
      assert.deepEqual(readFileSync(ownerMapPath(h)), Buffer.from(legacy), 'refusal preserves the legacy document');
      assert.deepEqual(readFileSync(staging), stagingBefore, 'refusal preserves staging');
      assert.deepEqual(readFileSync(h.authPath), authBefore, 'refusal does not write a placeholder');
    } finally { h.cleanup(); }
  });

  it('legacy sidecar-owned xai: status present, resume keeps QLB_OWNED, rollback unlinks the sidecar and leaves the shadow-retained entry', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const row = h.store.getMigration('pi-xai')!;
      h.store.upsertMigration('pi-xai', 'QLB_OWNED', row.detail_json);
      const sidecar = legacySidecarPath(h);
      writeFileSync(sidecar, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');
      const nativeBefore = readFileSync(h.authPath);
      assert.equal(h.mig.status().ownerFile, 'present');
      assert.equal(h.mig.resume().state, 'QLB_OWNED');
      assert.deepEqual(readFileSync(h.authPath), nativeBefore, 'legacy resume shadow-retains native auth.json');
      assert.equal(h.mig.rollback().state, 'NATIVE');
      assert.equal(existsSync(sidecar), false, 'legacy rollback unlinks the sidecar');
      assert.deepEqual(readFileSync(h.authPath), nativeBefore, 'legacy rollback keeps the valid shadow-retained entry');
    } finally { h.cleanup(); }
  });

  it('safety property holds at every crash point (backup, owner-entry, placeholder)', async () => {
    for (const point of ['backup', 'owner-entry', 'placeholder'] as const) {
      const h = setup('xai', new MockKeychain(), {
        afterWrite: (written) => { if (written === point) throw new Error(`fixture crash after ${point}`); },
      });
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        assert.throws(() => h.mig.commit(), new RegExp(`fixture crash after ${point}`));
        if (point === 'backup') {
          assert.deepEqual(readFileSync(h.authPath), h.originalBytes, `${point}: native entry remains intact`);
          h.mig.rollback();
        } else {
          assert.equal(h.mig.resume().state, 'QLB_OWNED', `${point}: resume finishes ordered publication`);
          assert.equal(isPiPlaceholder(JSON.parse(readFileSync(h.authPath, 'utf8')).xai), true, `${point}: placeholder is durable after recovery`);
        }
      } finally { h.cleanup(); }
    }
  });

  for (const provider of ['xai', 'kimi-coding'] as const) {
    it(`T-KC4 [${provider}] rehearse reads the Keychain item the journal records`, async () => {
      const shared = sharedSingleGrantCoords(provider);
      const id = expectedId(provider);
      const label = expectedLabel(provider);
      const journalName = `pi-${provider}`;

      const stageWithSharedStaging = (): Harness & { mig: Migration } => {
        const kc = new ReadTrackingKeychain();
        const h = setup(provider, kc);
        h.mig.stage();
        const stagingPath = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), provider);
        const owner = JSON.parse(readFileSync(stagingPath, 'utf8')) as { accounts: Array<Record<string, unknown>> };
        owner.accounts[0]!.keychain = shared;
        writeFileSync(stagingPath, JSON.stringify(owner, null, 2) + '\n');
        kc.setSync(shared.service, shared.account, JSON.stringify({
          ...FAKE_GRANTS[provider], generation: 0, writtenBy: 'fixture', extra: {},
        }));
        kc.setSync(legacyKmCoords(provider).service, legacyKmCoords(provider).account, '{decoy');
        kc.getCalls.length = 0;
        return h;
      };

      const stageWithSharedJournal = (): Harness & { mig: Migration } => {
        const kc = new ReadTrackingKeychain();
        const h = setup(provider, kc);
        h.mig.stage();
        rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), provider));
        const row = h.store.getMigration(journalName)!;
        const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
        detail.accounts[0]!.keychain = shared;
        h.store.upsertMigration(journalName, 'MIRRORED', JSON.stringify(detail));
        kc.setSync(shared.service, shared.account, JSON.stringify({
          ...FAKE_GRANTS[provider], generation: 0, writtenBy: 'fixture', extra: {},
        }));
        kc.setSync(legacyKmCoords(provider).service, legacyKmCoords(provider).account, '{decoy');
        kc.getCalls.length = 0;
        return h;
      };

      for (const setupFixture of [stageWithSharedStaging, stageWithSharedJournal]) {
        const h = setupFixture();
        try {
          const calls: StagedAccount[] = [];
          await h.mig.rehearse(mockRehearse(calls));
          assert.equal(calls[0]?.id, id);
          assert.deepEqual((h.kc as ReadTrackingKeychain).getCalls, [shared]);
        } finally {
          h.cleanup();
        }
      }

      const h = setup(provider, new ReadTrackingKeychain());
      try {
        h.mig.stage();
        rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), provider));
        const row = h.store.getMigration(journalName)!;
        const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
        detail.accounts[0]!.keychain = { service: shared.service, account: label };
        h.store.upsertMigration(journalName, 'MIRRORED', JSON.stringify(detail));
        const journalBefore = h.store.getMigration(journalName)!;
        (h.kc as ReadTrackingKeychain).getCalls.length = 0;

        await assert.rejects(() => h.mig.rehearse(mockRehearse([])), /journal-keychain-invalid/);
        assert.deepEqual(h.store.getMigration(journalName), journalBefore);
        assert.deepEqual((h.kc as ReadTrackingKeychain).getCalls, []);
      } finally {
        h.cleanup();
      }
    });
  }

  for (const provider of ['xai', 'kimi-coding'] as const) {
    it(`T-KC10 [${provider}] stage journals the shared coordinates before writing the shared Keychain item`, () => {
      const kc = new StageWriteTrackingKeychain();
      const h = setup(provider, kc);
      try {
        const shared = sharedSingleGrantCoords(provider);
        const legacy = legacyKmCoords(provider);
        kc.beforeSet = () => {
          const detail = JSON.parse(h.store.getMigration(`pi-${provider}`)!.detail_json) as {
            accounts: Array<{ keychain?: unknown }>;
          };
          assert.deepEqual(detail.accounts[0]?.keychain, shared, 'journal precedes Keychain write');
        };

        h.mig.stage();

        assert.deepEqual(kc.setCalls, [shared]);
        assert.equal(kc.setCalls.some(({ service, account }) => service === legacy.service && account === legacy.account), false);
      } finally {
        h.cleanup();
      }
    });

    it(`T-KC10b [${provider}] a crash between the journal and the Keychain write leaves a journal whose pre-commit rollback completes cleanly`, () => {
      const h = setup(provider, new MockKeychain(), {
        afterStep: (point) => {
          if (point === 'S1-stage') throw new Error('fixture crash after stage journal');
        },
      });
      try {
        assert.throws(() => h.mig.stage(), /fixture crash after stage journal/);
        const row = h.store.getMigration(`pi-${provider}`)!;
        const detail = JSON.parse(row.detail_json) as { accounts: Array<{ keychain?: unknown }> };
        assert.equal(row.state, 'MIRRORED');
        assert.deepEqual(detail.accounts[0]?.keychain, sharedSingleGrantCoords(provider));

        const rolled = h.mig.rollback();
        assert.equal(rolled.state, 'NATIVE');
        const shared = sharedSingleGrantCoords(provider);
        assert.throws(() => h.kc.getSync(shared.service, shared.account), /item not found/);
      } finally {
        h.cleanup();
      }
    });

    it(`T-KC11 [${provider}] re-staging a journal staged under the old Keychain name removes the old staged copy and records the shared item`, () => {
      const legacy = legacyKmCoords(provider);
      const shared = sharedSingleGrantCoords(provider);
      const h = oldPreCommitFixture(provider, 'MIRRORED');
      try {
        h.mig.stage();
        assert.throws(() => h.kc.getSync(legacy.service, legacy.account), /item not found/);
        assert.equal(keychainHas(h.kc, provider), true);
        assert.deepEqual(journalAccount(h, provider).keychain, shared);
        assert.deepEqual(stagingAccount(h, provider)?.keychain, shared);
      } finally {
        h.cleanup();
      }

      // Plus a crash after the delete: the old journal and staging file are
      // left exactly as they were, and a new stage finishes the job.
      const crash = oldPreCommitFixture(provider, 'MIRRORED');
      try {
        const journalBefore = crash.store.getMigration(`pi-${provider}`);
        const stagingBefore = readFileSync(crash.staging);
        crash.crashAt.point = 'S1-legacy-delete';
        assert.throws(() => crash.mig.stage(), /fixture crash at S1-legacy-delete/);
        assert.throws(() => crash.kc.getSync(legacy.service, legacy.account), /item not found/);
        assert.deepEqual(crash.store.getMigration(`pi-${provider}`), journalBefore, 'journal untouched until the delete is done');
        assert.deepEqual(readFileSync(crash.staging), stagingBefore);
        assert.throws(() => crash.kc.getSync(shared.service, shared.account), /item not found/);

        crash.crashAt.point = undefined;
        crash.mig.stage();
        assert.deepEqual(journalAccount(crash, provider).keychain, shared);
        assert.deepEqual(stagingAccount(crash, provider)?.keychain, shared);
        assert.equal(keychainHas(crash.kc, provider), true);
      } finally {
        crash.cleanup();
      }
    });

    it(`T-KC11b [${provider}] every crash point of a re-stage over an old pre-commit journal recovers by rollback, resume or a new stage, and commit publishes nothing`, () => {
      const legacy = legacyKmCoords(provider);
      const shared = sharedSingleGrantCoords(provider);
      const windows: CrashWindow[] = ['S1-stage', 'keychain-write-failed', 'after-keychain-write', 'S1-legacy-delete', 'S1-legacy-unlink'];
      for (const oldState of ['MIRRORED', 'VALIDATED'] as const) {
        for (const window of windows) {
          for (const recovery of ['rollback', 'resume', 'stage'] as const) {
            const where = `${oldState} / ${window} / ${recovery}`;
            const h = oldPreCommitFixture(provider, oldState);
            try {
              armCrash(h, window);
              assert.throws(() => h.mig.stage(), /fixture crash/, where);
              disarmCrash(h);
              assert.throws(() => h.kc.getSync(legacy.service, legacy.account), /item not found/, `${where}: legacy deleted first`);

              // Journal and staging file never name different items.
              const staged = stagingAccount(h, provider);
              if (staged) {
                assert.deepEqual(staged.keychain, journalAccount(h, provider).keychain, `${where}: journal and staging agree`);
              }

              // Commit publishes nothing from any crash state.
              const journalBefore = h.store.getMigration(`pi-${provider}`);
              const stagingBefore = existsSync(h.staging) ? readFileSync(h.staging) : null;
              assert.throws(() => h.mig.commit(), Error, `${where}: commit refuses`);
              assert.equal(existsSync(h.ownerPath), false, `${where}: no owner file`);
              assert.deepEqual(h.store.getMigration(`pi-${provider}`), journalBefore, `${where}: commit wrote no journal`);
              assert.deepEqual(existsSync(h.staging) ? readFileSync(h.staging) : null, stagingBefore, `${where}: commit kept staging`);

              const atRest = oldState === 'VALIDATED' && window === 'S1-legacy-unlink';
              const oldValidatedStaged = oldState === 'VALIDATED' && window === 'S1-legacy-delete';
              if (recovery === 'stage') {
                const s = h.mig.stage();
                assert.equal(s.state, 'MIRRORED', where);
                assert.deepEqual(journalAccount(h, provider).keychain, shared, where);
                assert.deepEqual(stagingAccount(h, provider)?.keychain, shared, where);
                assert.equal(keychainHas(h.kc, provider), true, where);
              } else if (recovery === 'resume' && oldValidatedStaged) {
                // An old VALIDATED journal with its staging file is exactly
                // what commit refuses (OQ-2(a)); resume reaches commit.
                assert.throws(
                  () => h.mig.resume(),
                  (error: unknown) => (error as { code?: unknown }).code === 'staged-under-legacy-keychain'
                    && (error as { exitCode?: unknown }).exitCode === 3,
                  where,
                );
                assert.deepEqual(h.store.getMigration(`pi-${provider}`), journalBefore, where);
                assert.deepEqual(readFileSync(h.staging), stagingBefore, where);
              } else {
                const s = recovery === 'rollback' ? h.mig.rollback() : h.mig.resume();
                // C9: a VALIDATED journal with no staging file is at rest.
                assert.equal(s.state, atRest ? 'VALIDATED' : 'NATIVE', where);
                assert.equal(existsSync(h.staging), false, where);
                assert.throws(() => h.kc.getSync(shared.service, shared.account), /item not found/, `${where}: no orphan`);
              }
              assert.throws(() => h.kc.getSync(legacy.service, legacy.account), /item not found/, where);
            } finally {
              h.cleanup();
            }
          }
        }
      }
    });

    it(`T-KC11c [${provider}] a re-stage whose old staged copy cannot be deleted refuses with nothing else written`, () => {
      const legacy = legacyKmCoords(provider);
      const shared = sharedSingleGrantCoords(provider);
      for (const oldState of ['MIRRORED', 'VALIDATED'] as const) {
        const kc = new RollbackDeleteKeychain();
        const h = oldPreCommitFixture(provider, oldState, kc);
        try {
          const before = snapshotRestage(h, provider);
          kc.mode = 'denied';
          assert.throws(
            () => h.mig.stage(),
            new RegExp(`^Error: migration stage failed to delete staged Keychain credential for provider=${provider} `),
          );
          assert.deepEqual(snapshotRestage(h, provider), before, oldState);
          assert.throws(() => kc.getSync(shared.service, shared.account), /item not found/);
          assert.ok(kc.getSync(legacy.service, legacy.account));
        } finally {
          h.cleanup();
        }
      }
    });

    it(`T-KC11d [${provider}] a re-stage refuses before any delete when the old journal is malformed or disagrees with the staging file`, () => {
      const legacy = legacyKmCoords(provider);
      const shared = sharedSingleGrantCoords(provider);
      const breakers: Array<[string, (h: OldFixture) => void]> = [
        ['staging names the shared item', (h) => {
          const owner = JSON.parse(readFileSync(h.staging, 'utf8')) as { accounts: Array<Record<string, unknown>> };
          owner.accounts[0]!.keychain = shared;
          writeFileSync(h.staging, JSON.stringify(owner, null, 2) + '\n');
        }],
        ['journal holds two accounts', (h) => {
          const row = h.store.getMigration(`pi-${provider}`)!;
          const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
          detail.accounts.push({ ...detail.accounts[0]! });
          h.store.upsertMigration(`pi-${provider}`, row.state, JSON.stringify(detail));
        }],
      ];
      for (const [name, breakIt] of breakers) {
        const kc = new DeleteTrackingKeychain();
        const h = oldPreCommitFixture(provider, 'MIRRORED', kc);
        try {
          breakIt(h);
          const before = snapshotRestage(h, provider);
          kc.deleteCalls.length = 0;
          assert.throws(
            () => h.mig.stage(),
            (error: unknown) => (error as { code?: unknown }).code === 'journal-keychain-invalid'
              && (error as { exitCode?: unknown }).exitCode === 3,
            name,
          );
          assert.deepEqual(kc.deleteCalls, [], `${name}: nothing deleted`);
          assert.deepEqual(snapshotRestage(h, provider), before, name);
          assert.ok(kc.getSync(legacy.service, legacy.account), name);
        } finally {
          h.cleanup();
        }
      }
    });

    it(`T-KC11f [${provider}] a malformed staging file refuses before deleting the old staged copy`, () => {
      const legacy = legacyKmCoords(provider);
      const kc = new DeleteTrackingKeychain();
      const h = oldPreCommitFixture(provider, 'MIRRORED', kc);
      try {
        writeFileSync(h.staging, '{ malformed staging owner file');
        const before = snapshotRestage(h, provider);
        kc.deleteCalls.length = 0;

        assert.throws(
          () => h.mig.stage(),
          (error: unknown) => (error as { code?: unknown }).code === 'journal-keychain-invalid'
            && (error as { exitCode?: unknown }).exitCode === 3,
        );
        assert.deepEqual(kc.deleteCalls, []);
        assert.deepEqual(snapshotRestage(h, provider), before);
        assert.ok(kc.getSync(legacy.service, legacy.account));
      } finally {
        h.cleanup();
      }
    });

    it(`T-KC11h [${provider}] a dangling staging symlink refuses re-stage but rolls back like present staging`, () => {
      const legacy = legacyKmCoords(provider);
      const kc = new DeleteTrackingKeychain();
      const h = oldPreCommitFixture(provider, 'VALIDATED', kc);
      const normal = oldPreCommitFixture(provider, 'VALIDATED', new DeleteTrackingKeychain());
      try {
        rmSync(h.staging);
        const target = join(h.dir, 'missing-staging-owner');
        symlinkSync(target, h.staging);
        const before = snapshotRestage(h, provider);
        kc.deleteCalls.length = 0;

        assert.throws(
          () => h.mig.stage(),
          (error: unknown) => (error as { code?: unknown }).code === 'journal-keychain-invalid'
            && (error as { exitCode?: unknown }).exitCode === 3,
        );
        assert.deepEqual(kc.deleteCalls, []);
        assert.deepEqual(snapshotRestage(h, provider), before);
        assert.equal(readlinkSync(h.staging), target, 'the dangling staging symlink stays in place before recovery');
        assert.ok(kc.getSync(legacy.service, legacy.account));
        assert.equal(h.mig.status().ownerFile, 'staging', 'status reports the dangling staging path');

        const rolled = h.mig.rollback();
        const normalRolled = normal.mig.rollback();
        assert.deepEqual(
          {
            state: rolled.state,
            ownerFile: rolled.ownerFile,
            nativeStore: rolled.nativeStore,
            piAtNextLaunch: rolled.piAtNextLaunch,
            resumeAction: rolled.resumeAction,
          },
          {
            state: normalRolled.state,
            ownerFile: normalRolled.ownerFile,
            nativeStore: normalRolled.nativeStore,
            piAtNextLaunch: normalRolled.piAtNextLaunch,
            resumeAction: normalRolled.resumeAction,
          },
          'dangling staging recovers to the normal pre-commit rollback state',
        );
        assert.throws(
          () => lstatSync(h.staging),
          (error: unknown) => (error as { code?: unknown }).code === 'ENOENT',
          'rollback removes the dangling staging symlink',
        );
        assert.throws(() => kc.getSync(legacy.service, legacy.account), /item not found/);
      } finally {
        normal.cleanup();
        h.cleanup();
      }
    });

    it(`T-KC11i [${provider}] resume rolls back a dangling VALIDATED staging link before deleting its Keychain copy`, () => {
      const legacy = legacyKmCoords(provider);
      const kc = new DeleteTrackingKeychain();
      const h = oldPreCommitFixture(provider, 'VALIDATED', kc);
      try {
        rmSync(h.staging);
        symlinkSync(join(h.dir, 'missing-staging-owner'), h.staging);
        assert.equal(
          h.mig.status().resumeAction,
          'before commit: roll back staging (native untouched)',
          'status advises the recovery resume performs',
        );
        kc.deleteCalls.length = 0;
        kc.beforeDelete = () => {
          assert.throws(
            () => lstatSync(h.staging),
            (error: unknown) => (error as { code?: unknown }).code === 'ENOENT',
            'the dangling staging link is removable before its Keychain copy is deleted',
          );
        };

        const resumed = h.mig.resume();

        assert.equal(resumed.state, 'NATIVE');
        assert.equal(resumed.ownerFile, 'absent');
        assert.equal(resumed.resumeAction, 'nothing to roll back');
        assert.equal(kc.deleteCalls.length, 1, 'resume deletes the journaled staged copy');
        assert.throws(
          () => lstatSync(h.staging),
          (error: unknown) => (error as { code?: unknown }).code === 'ENOENT',
        );
        assert.throws(() => kc.getSync(legacy.service, legacy.account), /item not found/);
      } finally {
        h.cleanup();
      }
    });

    it(`T-KC11f [${provider}] foreign-owner and unreadable staging files refuse before deleting the old staged copy`, () => {
      const legacy = legacyKmCoords(provider);
      const cases: Array<[string, (h: OldFixture) => (() => void) | undefined]> = [
        ['foreign owner', (h) => {
          const owner = JSON.parse(readFileSync(h.staging, 'utf8')) as Record<string, unknown>;
          owner.owner = 'pi';
          writeFileSync(h.staging, JSON.stringify(owner, null, 2) + '\n');
          return undefined;
        }],
        ['unreadable file', (h) => {
          chmodSync(h.staging, 0o000);
          return () => chmodSync(h.staging, 0o600);
        }],
      ];
      for (const [name, makeInvalid] of cases) {
        const kc = new DeleteTrackingKeychain();
        const h = oldPreCommitFixture(provider, 'MIRRORED', kc);
        let restore: (() => void) | undefined;
        try {
          restore = makeInvalid(h);
          kc.deleteCalls.length = 0;

          assert.throws(
            () => h.mig.stage(),
            (error: unknown) => (error as { code?: unknown }).code === 'journal-keychain-invalid'
              && (error as { exitCode?: unknown }).exitCode === 3,
            name,
          );
          assert.deepEqual(kc.deleteCalls, [], `${name}: nothing deleted`);
          assert.ok(kc.getSync(legacy.service, legacy.account), `${name}: legacy item stays`);
        } finally {
          restore?.();
          h.cleanup();
        }
      }
    });

    it(`T-KC11g [${provider}] an unparseable auth.json refuses before deleting a VALIDATED journal's old staged copy`, () => {
      const legacy = legacyKmCoords(provider);
      const invalidAuthJson: Array<[string, string, RegExp]> = [
        ['not a JSON object', JSON.stringify('not an object'), /auth\.json is not a JSON object/],
        ['no importable grant', '{}', /missing importable OAuth grant under key/],
        ['no access and refresh', JSON.stringify({ [provider]: { type: 'oauth' } }), /is missing access\/refresh/],
      ];
      for (const [name, authJson, expected] of invalidAuthJson) {
        const kc = new DeleteTrackingKeychain();
        const h = oldPreCommitFixture(provider, 'VALIDATED', kc);
        try {
          writeFileSync(h.authPath, authJson + '\n');
          const before = snapshotRestage(h, provider);
          kc.deleteCalls.length = 0;

          assert.throws(() => h.mig.stage(), expected, name);
          assert.deepEqual(kc.deleteCalls, [], `${name}: nothing deleted`);
          assert.deepEqual(snapshotRestage(h, provider), before, name);
          assert.ok(kc.getSync(legacy.service, legacy.account), `${name}: legacy item stays`);
        } finally {
          h.cleanup();
        }
      }
    });

    it(`T-KC11g [${provider}] a missing auth.json refuses before deleting a VALIDATED journal's old staged copy`, () => {
      const legacy = legacyKmCoords(provider);
      const kc = new DeleteTrackingKeychain();
      const h = oldPreCommitFixture(provider, 'VALIDATED', kc);
      try {
        rmSync(h.authPath);
        const before = snapshotRestage(h, provider);
        kc.deleteCalls.length = 0;

        assert.throws(() => h.mig.stage(), /auth\.json not found/);
        assert.deepEqual(kc.deleteCalls, []);
        assert.deepEqual(snapshotRestage(h, provider), before);
        assert.ok(kc.getSync(legacy.service, legacy.account));
      } finally {
        h.cleanup();
      }
    });

    it(`T-KC11e [${provider}] stage never deletes a kept old copy under a NATIVE journal (C9, OQ-8)`, () => {
      const legacy = legacyKmCoords(provider);
      const kc = new DeleteTrackingKeychain();
      const h = setup(provider, kc);
      try {
        h.mig.stage();
        assert.equal(h.mig.rollback().state, 'NATIVE');
        const row = h.store.getMigration(`pi-${provider}`)!;
        const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
        delete detail.accounts[0]!.keychain;
        h.store.upsertMigration(`pi-${provider}`, 'NATIVE', JSON.stringify(detail));
        kc.setSync(legacy.service, legacy.account, 'kept-copy');
        kc.deleteCalls.length = 0;

        h.mig.stage();
        assert.deepEqual(kc.deleteCalls, []);
        assert.equal(kc.getSync(legacy.service, legacy.account), 'kept-copy');
        assert.equal(keychainHas(kc, provider), true);
      } finally {
        h.cleanup();
      }
    });

    it(`T-KC12 [${provider}] commit refuses a journal staged under the old Keychain name and writes nothing`, async () => {
      const h = setup(provider);
      try {
        h.mig.stage();
        const legacy = legacyKmCoords(provider);
        const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), provider);
        const detail = JSON.parse(h.store.getMigration(`pi-${provider}`)!.detail_json) as { accounts: Array<Record<string, unknown>> };
        delete detail.accounts[0]!.keychain;
        h.store.upsertMigration(`pi-${provider}`, 'MIRRORED', JSON.stringify(detail));
        const owner = JSON.parse(readFileSync(staging, 'utf8')) as { accounts: Array<Record<string, unknown>> };
        delete owner.accounts[0]!.keychain;
        writeFileSync(staging, JSON.stringify(owner, null, 2) + '\n');
        h.kc.setSync(legacy.service, legacy.account, JSON.stringify({ ...FAKE_GRANTS[provider], generation: 0, writtenBy: 'fixture', extra: {} }));
        await h.mig.rehearse(mockRehearse([]));
        const beforeJournal = h.store.getMigration(`pi-${provider}`)!;
        const beforeStaging = readFileSync(staging);
        const beforeKeychain = h.kc.getSync(legacy.service, legacy.account);

        assert.throws(
          () => h.mig.commit(),
          (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'staged-under-legacy-keychain'
            && (error as { exitCode?: unknown }).exitCode === 3,
        );
        assert.deepEqual(h.store.getMigration(`pi-${provider}`), beforeJournal);
        assert.deepEqual(readFileSync(staging), beforeStaging);
        assert.equal(h.kc.getSync(legacy.service, legacy.account), beforeKeychain);

        // resume() on VALIDATED + staging enters the same commit and refuses.
        assert.throws(
          () => h.mig.resume(),
          (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'staged-under-legacy-keychain'
            && (error as { exitCode?: unknown }).exitCode === 3,
        );
        assert.deepEqual(h.store.getMigration(`pi-${provider}`), beforeJournal);
        assert.deepEqual(readFileSync(staging), beforeStaging);
        assert.equal(h.kc.getSync(legacy.service, legacy.account), beforeKeychain);
        assert.equal(existsSync(h.ownerPath), false);
      } finally {
        h.cleanup();
      }
    });
  }

  it('rehearse refuses a generic journal with more than one account', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'));
      const row = h.store.getMigration('pi-xai')!;
      const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
      detail.accounts.push({ ...detail.accounts[0]! });
      h.store.upsertMigration('pi-xai', 'MIRRORED', JSON.stringify(detail));
      const journalBefore = h.store.getMigration('pi-xai')!;
      const calls: StagedAccount[] = [];

      await assert.rejects(
        () => h.mig.rehearse(mockRehearse(calls)),
        /no staged Keychain credentials to rehearse/,
      );
      assert.deepEqual(calls, []);
      assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore);
    } finally {
      h.cleanup();
    }
  });

  it('openai-codex pre-commit rollback with a multi-account journal still deletes the staged Keychain items', () => {
    const h = setup('openai-codex');
    try {
      h.mig.stage();
      rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'openai-codex'));
      const row = h.store.getMigration('pi-openai-codex')!;
      const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
      const secondId = 'fixture-user:second-account';
      detail.accounts.push({ ...detail.accounts[0]!, id: secondId, label: secondId });
      h.store.upsertMigration('pi-openai-codex', 'MIRRORED', JSON.stringify(detail));
      const second = { service: qlbKeychainService('openai-codex', secondId), account: secondId };
      h.kc.setSync(second.service, second.account, JSON.stringify({ fixture: 'second' }));
      assert.equal(keychainHas(h.kc, 'openai-codex'), true);

      h.mig.rollback();

      assert.equal(keychainHas(h.kc, 'openai-codex'), false);
      assert.throws(() => h.kc.getSync(second.service, second.account), /item not found/);
      assert.equal(h.mig.status().state, 'NATIVE');
    } finally {
      h.cleanup();
    }
  });

  for (const provider of ['xai', 'kimi-coding'] as const) {
    it(`T-KC5 [${provider}] pre-commit rollback deletes only the Keychain item the journal records`, () => {
      const shared = sharedSingleGrantCoords(provider);
      const legacy = legacyKmCoords(provider);
      const journalName = `pi-${provider}`;

      for (const [recorded, target, decoy] of [
        ['shared', shared, legacy],
        ['legacy', legacy, shared],
      ] as const) {
        const h = setup(provider);
        try {
          h.mig.stage();
          rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), provider));
          const row = h.store.getMigration(journalName)!;
          const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
          if (recorded === 'shared') detail.accounts[0]!.keychain = shared;
          else delete detail.accounts[0]!.keychain;
          h.store.upsertMigration(journalName, 'MIRRORED', JSON.stringify(detail));

          const targetBytes = JSON.stringify({ target: recorded });
          const decoyBytes = JSON.stringify({ decoy: recorded });
          h.kc.setSync(target.service, target.account, targetBytes);
          h.kc.setSync(decoy.service, decoy.account, decoyBytes);

          h.mig.rollback();

          assert.throws(() => h.kc.getSync(target.service, target.account), /item not found/);
          assert.equal(h.kc.getSync(decoy.service, decoy.account), decoyBytes);
        } finally {
          h.cleanup();
        }
      }
    });
  }

  for (const provider of ['xai', 'kimi-coding'] as const) {
    it(`T-KC6a [${provider}] a hand-back restores the P7b6 native backup before a non-refreshed shared item`, async () => {
      const h = setup(provider);
      try {
        const shared = sharedSingleGrantCoords(provider);
        const legacy = legacyKmCoords(provider);
        const sharedGrant = {
          ...FAKE_GRANTS[provider],
          access: `${provider}-access-shared-item-fake`,
          refresh: `${provider}-refresh-shared-item-fake`,
          generation: 1,
          writtenBy: 'fixture',
          extra: {},
        };
        const legacyGrant = {
          ...FAKE_GRANTS[provider],
          access: `${provider}-access-legacy-decoy-fake`,
          refresh: `${provider}-refresh-legacy-decoy-fake`,
          generation: 0,
          writtenBy: 'fixture',
          extra: {},
        };

        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        const row = h.store.getMigration(`pi-${provider}`)!;
        const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
        detail.accounts[0]!.keychain = shared;
        h.store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify(detail));
        h.kc.setSync(shared.service, shared.account, JSON.stringify(sharedGrant));
        h.kc.setSync(legacy.service, legacy.account, JSON.stringify(legacyGrant));
        writeFileSync(h.authPath, JSON.stringify({
          ...FAKE_GRANTS,
          [provider]: { type: 'oauth', access: 'qlb-managed', refresh: '' },
        }, null, 2) + '\n');

        const rolled = h.mig.rollback();

        assert.equal(rolled.state, 'NATIVE');
        const auth = JSON.parse(readFileSync(h.authPath, 'utf8')) as Record<string, typeof sharedGrant>;
        assert.equal(auth[provider]?.access, sharedGrant.access);
        assert.equal(auth[provider]?.refresh, sharedGrant.refresh);
        const decision = (rolled.detail.lastRollback as { decision: RollbackDecision }).decision;
        assert.equal(decision.kind, 'keychain');
        assert.equal(decision.fingerprint, createHash('sha256').update(sharedGrant.refresh).digest('hex'));
      } finally {
        h.cleanup();
      }
    });
  }

  for (const provider of ['xai', 'kimi-coding'] as const) {
    it(`T-KC6b [${provider}] the hand-back verdict reads, and a recorded delete removes, only the journal's Keychain item`, async () => {
      const shared = sharedSingleGrantCoords(provider);
      const legacy = legacyKmCoords(provider);
      const sharedGrant = {
        ...FAKE_GRANTS[provider],
        generation: 0,
        writtenBy: 'fixture',
        extra: {},
      };
      const legacyGrant = {
        ...sharedGrant,
        access: `${provider}-access-legacy-decoy-fake`,
        refresh: `${provider}-refresh-legacy-decoy-fake`,
      };
      const h = setup(provider, new MockKeychain(), {
        afterStep: (point) => {
          if (point === 'S5') throw new Error('fixture crash after S5');
        },
      });
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        const row = h.store.getMigration(`pi-${provider}`)!;
        const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
        detail.accounts[0]!.keychain = shared;
        h.store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify(detail));
        h.kc.setSync(shared.service, shared.account, JSON.stringify(sharedGrant));
        h.kc.setSync(legacy.service, legacy.account, JSON.stringify(legacyGrant));

        assert.throws(() => h.mig.rollback(), /fixture crash after S5/);
        const handback = JSON.parse(h.store.getMigration(`pi-${provider}`)!.detail_json).handback;
        assert.equal(handback.keychainDisposition, 'delete', 'S5 reads the shared item, not the legacy decoy');

        h.mig.resume();
        assert.throws(() => h.kc.getSync(shared.service, shared.account), /item not found/);
        assert.equal(h.kc.getSync(legacy.service, legacy.account), JSON.stringify(legacyGrant));
      } finally {
        h.cleanup();
      }

      const legacyJournal = setup(provider);
      try {
        legacyJournal.kc.setSync(shared.service, shared.account, JSON.stringify(sharedGrant));
        legacyJournal.kc.setSync(legacy.service, legacy.account, JSON.stringify(legacyGrant));
        legacyJournal.store.upsertAccount(expectedId(provider), provider, expectedLabel(provider), 'active');
        legacyJournal.store.upsertMigration(`pi-${provider}`, 'NATIVE', JSON.stringify({
          accounts: [{
            id: expectedId(provider),
            provider,
            label: expectedLabel(provider),
            fingerprint: 'fixture-fingerprint',
          }],
          handback: {
            phase: 'cleanup-pending',
            keychainDisposition: 'delete',
            piFingerprint: null,
            decision: null,
            fencedGeneration: null,
            rolledBackAt: 123,
          },
        }));

        legacyJournal.mig.resume();
        assert.equal(legacyJournal.kc.getSync(shared.service, shared.account), JSON.stringify(sharedGrant));
        assert.throws(() => legacyJournal.kc.getSync(legacy.service, legacy.account), /item not found/);
      } finally {
        legacyJournal.cleanup();
      }
    });
  }

  type JournalAccounts = Array<Record<string, unknown>>;

  /**
   * Stages, rewrites the journal's accounts (and the staging file's, with the
   * same edit unless one is given), plants both Keychain items, and asserts
   * that pre-commit rollback refuses journal-keychain-invalid with no delete
   * and the items, staging file, auth.json backup and journal byte-equal.
   */
  function assertPreCommitRollbackRefuses(
    provider: 'xai' | 'kimi-coding',
    editJournal: (accounts: JournalAccounts) => JournalAccounts,
    editStaging: (accounts: JournalAccounts) => JournalAccounts = editJournal,
  ): void {
    const kc = new DeleteTrackingKeychain();
    const h = setup(provider, kc);
    try {
      h.mig.stage();
      const journalName = `pi-${provider}`;
      const stagingPath = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), provider);
      const detail = JSON.parse(h.store.getMigration(journalName)!.detail_json) as { accounts: JournalAccounts };
      detail.accounts = editJournal(detail.accounts);
      h.store.upsertMigration(journalName, 'MIRRORED', JSON.stringify(detail));
      const owner = JSON.parse(readFileSync(stagingPath, 'utf8')) as { accounts: JournalAccounts };
      owner.accounts = editStaging(owner.accounts);
      writeFileSync(stagingPath, JSON.stringify(owner, null, 2) + '\n');

      const shared = sharedSingleGrantCoords(provider);
      const legacy = legacyKmCoords(provider);
      kc.setSync(shared.service, shared.account, '{"item":"shared"}');
      kc.setSync(legacy.service, legacy.account, '{"item":"legacy"}');
      writePiAuthBackup(h.authPath, provider, 'pre-commit-refusal');
      const backupPath = piAuthBackupPath(h.authPath, provider);
      const stagingBefore = readFileSync(stagingPath);
      const backupBefore = readFileSync(backupPath);
      const journalBefore = h.store.getMigration(journalName);
      kc.deleteCalls.length = 0;

      assert.throws(() => h.mig.rollback(), /journal-keychain-invalid/);

      assert.deepEqual(kc.deleteCalls, []);
      assert.equal(kc.getSync(shared.service, shared.account), '{"item":"shared"}');
      assert.equal(kc.getSync(legacy.service, legacy.account), '{"item":"legacy"}');
      assert.deepEqual(readFileSync(stagingPath), stagingBefore);
      assert.deepEqual(readFileSync(backupPath), backupBefore);
      assert.deepEqual(h.store.getMigration(journalName), journalBefore);
    } finally {
      h.cleanup();
    }
  }

  for (const provider of ['xai', 'kimi-coding'] as const) {
    it(`[${provider}] pre-commit rollback refuses when the staging file and the journal record different Keychain items and deletes nothing`, () => {
      const shared = sharedSingleGrantCoords(provider);
      const withShared = (accounts: JournalAccounts): JournalAccounts => [{ ...accounts[0], keychain: shared }];
      const asLegacy = (accounts: JournalAccounts): JournalAccounts => accounts.map((account) => {
        const legacy = { ...account };
        delete legacy.keychain;
        return legacy;
      });
      const otherLabel = (accounts: JournalAccounts): JournalAccounts => [{ ...accounts[0], label: 'other-label' }];

      assertPreCommitRollbackRefuses(provider, withShared, asLegacy);
      assertPreCommitRollbackRefuses(provider, asLegacy, withShared);
      assertPreCommitRollbackRefuses(provider, asLegacy, otherLabel);
    });

    it(`[${provider}] pre-commit rollback with a two-account single-grant journal deletes nothing`, () => {
      const shared = sharedSingleGrantCoords(provider);
      assertPreCommitRollbackRefuses(provider, (accounts) => [
        { ...accounts[0], keychain: shared },
        { ...accounts[0], id: 'bogus' },
      ]);
      assertPreCommitRollbackRefuses(provider, (accounts) => [
        accounts[0]!,
        { ...accounts[0], keychain: shared },
      ]);
    });

    it(`[${provider}] pre-commit rollback of an ${provider} journal whose account names openrouter refuses`, () => {
      assertPreCommitRollbackRefuses(provider, (accounts) => [{ ...accounts[0], provider: 'openrouter' }]);
    });

    it(`[${provider}] pre-commit rollback with an invalid recorded keychain deletes nothing`, () => {
      const other = sharedSingleGrantCoords(provider === 'xai' ? 'kimi-coding' : 'xai');
      assertPreCommitRollbackRefuses(provider, (accounts) => [{ ...accounts[0], keychain: other }]);
    });
  }

  it('T-RS re-stages xai and kimi-coding at the store generation, resets status, and clears prior hand-back detail', async () => {
    for (const provider of ['xai', 'kimi-coding'] as const) {
      for (const lifecycle of ['MIRRORED', 'VALIDATED', 'NATIVE'] as const) {
        const h = setup(provider);
        try {
          const id = expectedId(provider);
          h.mig.stage();
          if (lifecycle === 'VALIDATED') {
            await h.mig.rehearse(mockRehearse([]));
          } else if (lifecycle === 'NATIVE') {
            h.mig.rollback();
            assert.equal(keychainHas(h.kc, provider), false, 'precondition: rollback deleted the staged grant');
          }

          assert.equal(h.store.casGrantGeneration(id, 0, 7), 1);
          h.store.setAccountStatus(id, 'handed-back');
          h.store.upsertMigration(`pi-${provider}`, lifecycle, JSON.stringify({
            commitGeneration: 3,
            handback: { phase: 'completed' },
            lastRollback: { cleanedAt: 1 },
          }));

          const staged = h.mig.stage();
          const detail = JSON.parse(h.store.getMigration(`pi-${provider}`)!.detail_json) as Record<string, unknown>;
          const grant = parseGrant(h.kc.getSync(
            kmCoords(provider).service,
            kmCoords(provider).account,
          ));

          assert.equal(staged.state, 'MIRRORED', `${provider} re-stages from ${lifecycle}`);
          assert.equal(h.store.getAccount(id)?.status, 'imported-unvalidated');
          assert.equal(grant.generation, 7);
          assert.equal(detail.commitGeneration, undefined);
          assert.equal(detail.rollbackDecision, undefined);
          assert.equal(detail.handback, undefined);
          assert.equal(detail.lastRollback, undefined);
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-E1 stage and commit refuse while a hand-back marker is set', async () => {
    const markers: Array<{
      name: 'intent' | 'decision' | 'cleanup-pending';
      detail: Record<string, unknown>;
      code: 'rollback-in-progress' | 'handback-cleanup-pending';
    }> = [
      { name: 'intent', detail: { intent: 'rollback' }, code: 'rollback-in-progress' },
      { name: 'decision', detail: { rollbackDecision: { kind: 'keychain' } }, code: 'rollback-in-progress' },
      {
        name: 'cleanup-pending',
        detail: {
          handback: {
            phase: 'cleanup-pending',
            keychainDisposition: 'keep',
            piFingerprint: null,
            decision: null,
            fencedGeneration: null,
            rolledBackAt: 1,
          },
        },
        code: 'handback-cleanup-pending',
      },
    ];

    for (const command of ['stage', 'commit'] as const) {
      for (const marker of markers) {
        const h = setup('xai');
        try {
          if (command === 'commit') {
            h.mig.stage();
            await h.mig.rehearse(mockRehearse([]));
          }
          const row = h.store.getMigration('pi-xai');
          const state = command === 'stage' ? 'NATIVE' : row!.state;
          const detail = command === 'stage'
            ? marker.detail
            : { ...JSON.parse(row!.detail_json), ...marker.detail };
          h.store.upsertMigration('pi-xai', state, JSON.stringify(detail));
          const rowBefore = h.store.getMigration('pi-xai');
          const filesBefore = fileSnapshot(h.dir);
          const service = kmCoords('xai').service;
          const account = kmCoords('xai').account;
          const keychainBefore = (() => {
            try {
              return h.kc.getSync(service, account);
            } catch {
              return null;
            }
          })();
          // Pin the starting state so the before/after comparison cannot pass vacuously.
          assert.equal(keychainBefore === null, command === 'stage', `${command} starts with the staged item ${command === 'stage' ? 'absent' : 'present'}`);

          assert.throws(
            () => h.mig[command](),
            (error: Error & { exitCode?: unknown }) => {
              assert.match(error.message, new RegExp(marker.code));
              if (marker.code === 'rollback-in-progress') assert.equal(error.exitCode, 3);
              return true;
            },
            `${command}/${marker.name} refuses its active hand-back marker`,
          );
          const keychainAfter = (() => {
            try {
              return h.kc.getSync(service, account);
            } catch {
              return null;
            }
          })();
          assert.equal(keychainAfter, keychainBefore, `${command}/${marker.name} preserves Keychain`);
          assert.deepEqual(h.store.getMigration('pi-xai'), rowBefore, `${command}/${marker.name} preserves the journal`);
          assert.deepEqual(fileSnapshot(h.dir), filesBefore, `${command}/${marker.name} preserves files`);
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('stage and commit refuse a journal whose detail is not a JSON object', async () => {
    for (const command of ['stage', 'commit'] as const) {
      for (const detail of ['{not-json', '[]']) {
        const h = setup('xai');
        try {
          if (command === 'commit') {
            h.mig.stage();
            await h.mig.rehearse(mockRehearse([]));
          }
          const row = h.store.getMigration('pi-xai');
          h.store.upsertMigration('pi-xai', command === 'stage' ? 'NATIVE' : row!.state, detail);
          const rowBefore = h.store.getMigration('pi-xai');
          const filesBefore = fileSnapshot(h.dir);
          const service = kmCoords('xai').service;
          const account = kmCoords('xai').account;
          const keychainBefore = (() => {
            try {
              return h.kc.getSync(service, account);
            } catch {
              return null;
            }
          })();
          // Pin the starting state so the before/after comparison cannot pass vacuously.
          assert.equal(keychainBefore === null, command === 'stage', `${command} starts with the staged item ${command === 'stage' ? 'absent' : 'present'}`);

          assert.throws(
            () => h.mig[command](),
            (error: unknown) => {
              const refusal = error as { message?: unknown; exitCode?: unknown };
              assert.match(String(refusal.message), /journal-detail-malformed/);
              assert.equal(refusal.exitCode, 3);
              return true;
            },
            `${command} refuses malformed detail ${detail}`,
          );
          const keychainAfter = (() => {
            try {
              return h.kc.getSync(service, account);
            } catch {
              return null;
            }
          })();
          assert.deepEqual(h.store.getMigration('pi-xai'), rowBefore, `${command} preserves malformed journal`);
          assert.deepEqual(fileSnapshot(h.dir), filesBefore, `${command} preserves files`);
          assert.equal(keychainAfter, keychainBefore, `${command} preserves Keychain`);
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-CG commit journals commitGeneration before the owner write', async () => {
    const h = setup('xai');
    try {
      const id = expectedId('xai');
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      assert.equal(h.store.casGrantGeneration(id, 0, 7), 1);
      const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
      let journaledBeforeClaim = false;
      h.store.upsertMigration = (store, state, detail) => {
        const recorded = JSON.parse(detail ?? '{}') as { commitGeneration?: number };
        if (store === 'pi-xai' && state === 'VALIDATED' && recorded.commitGeneration === 7) {
          assert.equal(existsSync(ownerMapPath(h)), false, 'the v2 claim does not precede its baseline journal');
          journaledBeforeClaim = true;
        }
        return originalUpsertMigration(store, state, detail);
      };

      h.mig.commit();

      assert.equal(journaledBeforeClaim, true);
      const committed = h.store.getMigration('pi-xai');
      assert.equal(committed?.state, 'QLB_OWNED');
      assert.equal(
        JSON.parse(committed!.detail_json).commitGeneration,
        7,
        'the pre-claim journal records the store generation used as the commit baseline',
      );
      assert.equal(existsSync(ownerMapPath(h)), true, 'the v2 owner claim is written after the baseline journal');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0a every generic entry point refuses a provider P7a owns', () => {
    for (const ownershipFact of ['state', 'journal'] as const) {
      for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
        const h = setup('xai');
        try {
          const journalDir = join(h.dir, 'pi-migrate-journal');
          if (ownershipFact === 'state') {
            h.store.setConfig('pi.xai.state', 'migrated');
          } else {
            mkdirSync(journalDir, { recursive: true });
            writeFileSync(join(journalDir, 'pi-migrate-xai.json'), '{}\n');
          }
          const migration = new Migration(h.store, h.kc, h.authPath, h.ownerPath, 'pi-xai', {
            kind: 'single-grant',
            provider: 'xai',
            authJsonKey: 'xai',
            piMigrateJournalDir: journalDir,
          });

          let error: Error & { exitCode?: unknown };
          try {
            migration[command]();
            assert.fail('expected P7a ownership refusal');
          } catch (caught) {
            error = caught as Error & { exitCode?: unknown };
          }
          assert.match(error.message, /owned-by-pi-migrate: run `qlb pi rollback xai`/);
          assert.equal(error.exitCode, 3, `${ownershipFact}/${command} is an operator refusal`);
          assert.equal(h.store.getMigration('pi-xai'), null, `${ownershipFact}/${command} leaves no generic journal`);
          assert.equal(existsSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai')), false);
          assert.equal(keychainHas(h.kc, 'xai'), false);
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-S0e every generic entry point refuses a provider both paths own', async () => {
    for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        h.store.setConfig('pi.xai.state', 'migrated');

        let error: Error & { exitCode?: unknown };
        try {
          h.mig[command]();
          assert.fail('expected dual ownership refusal');
        } catch (caught) {
          error = caught as Error & { exitCode?: unknown };
        }
        assert.match(
          error.message,
          /dual-ownership: run `qlb pi rollback xai` first, then `qlb migrate rollback --provider xai`/,
        );
        assert.equal(error.exitCode, 3, `${command} is an operator refusal`);
        assert.equal(h.store.getMigration('pi-xai')?.state, 'QLB_OWNED');
        assert.equal(existsSync(ownerMapPath(h)), true, `${command} leaves the generic v2 claim intact`);
        assert.equal(keychainHas(h.kc, 'xai'), true, `${command} leaves the generic credential intact`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-OW2 a pi migrate journal written while stage waits for the auth lock makes stage refuse owned-by-pi-migrate with nothing written', () => {
    const h = setup('xai');
    try {
      const journalDir = join(h.dir, 'pi-migrate-journal');
      const p7aJournal = join(journalDir, 'pi-migrate-xai.json');
      let seamCalls = 0;
      const migration = new Migration(h.store, h.kc, h.authPath, h.ownerPath, 'pi-xai', {
        kind: 'single-grant',
        provider: 'xai',
        authJsonKey: 'xai',
        piMigrateJournalDir: journalDir,
        beforeOwnershipLock: () => {
          seamCalls += 1;
          mkdirSync(journalDir, { recursive: true });
          writeFileSync(p7aJournal, '{}\n');
        },
      });

      assert.throws(
        () => migration.stage(),
        (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owned-by-pi-migrate: run `qlb pi rollback xai`/);
          assert.equal(error.exitCode, 3);
          return true;
        },
      );
      assert.equal(seamCalls, 1, 'the P7a publication races immediately before the shared lock');
      assert.equal(h.store.getMigration('pi-xai'), null, 'stage writes no generic journal');
      assert.equal(existsSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai')), false);
      assert.equal(keychainHas(h.kc, 'xai'), false, 'stage writes no managed credential');
      assert.deepEqual(readFileSync(h.authPath), h.originalBytes, 'stage leaves auth.json unchanged');
    } finally {
      h.cleanup();
    }
  });

  it('T-OW2 stage classifies ownership and makes its first writes while holding the auth lock pi migrate takes', () => {
    const h = setup('xai');
    try {
      const lockDir = `${resolve(h.authPath)}.lock`;
      assert.equal(existsSync(lockDir), false);
      const heldAt: string[] = [];
      const store = h.store as unknown as Record<string, (...args: unknown[]) => unknown>;
      const originalUpsert = store.upsertMigration.bind(h.store);
      store.upsertMigration = (...args: unknown[]) => { heldAt.push(`journal:${existsSync(lockDir)}`); return originalUpsert(...args); };
      const originalSet = h.kc.setSync.bind(h.kc);
      h.kc.setSync = (service: string, account: string, value: string) => { heldAt.push(`keychain:${existsSync(lockDir)}`); originalSet(service, account, value); };
      h.mig.stage();
      assert.ok(heldAt.length > 0, 'stage wrote something');
      assert.ok(heldAt.every((entry) => entry.endsWith(':true')), `every stage write ran under ${lockDir}: ${heldAt.join(', ')}`);
      assert.equal(existsSync(lockDir), false, 'the auth lock is released after stage');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0d rebuilt default migration uses the journaled auth key', () => {
    const h = setup('xai');
    try {
      h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({ authJsonKey: 'grok' }));
      const rebuilt = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, h.ownerPath);

      const key = (rebuilt as unknown as { singleGrantAuthKey: () => string }).singleGrantAuthKey();

      assert.equal(key, 'grok');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0d conflicting explicit auth key is refused with auth-key-mismatch', () => {
    const h = setup('xai');
    try {
      const detail = JSON.stringify({ authJsonKey: 'grok' });
      h.store.upsertMigration('pi-xai', 'QLB_OWNED', detail);
      const conflicting = createSingleGrantMigration(
        h.store,
        h.kc,
        'xai',
        h.authPath,
        h.ownerPath,
        'other-alias',
      );

      assert.throws(
        () => (conflicting as unknown as { singleGrantAuthKey: () => string }).singleGrantAuthKey(),
        /auth\.json key mismatch/,
      );
      assert.equal(h.store.getMigration('pi-xai')?.detail_json, detail, 'refusal leaves the journal unchanged');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0f rollback after a crash between the commit point and QLB_OWNED finishes the commit and hands back', async () => {
    for (const claim of ['legacy-sidecar', 'owner-map'] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        const row = h.store.getMigration('pi-xai');
        assert.ok(row, 'staging records the generic migration');
        const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
        h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({
          ...detail,
          commitGeneration: h.store.getGrantGeneration(expectedId('xai')),
        }));

        const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
        if (claim === 'legacy-sidecar') {
          renameSync(staging, legacySidecarPath(h));
        } else {
          rmSync(staging);
          writeFileSync(join(h.dir, 'qlb-owner.json'), JSON.stringify({
            providers: { xai: { mode: 'qlb' } },
          }) + '\n');
        }

        const transitions: Array<{ state: string; intent?: unknown }> = [];
        const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
        h.store.upsertMigration = (store, state, nextDetail) => {
          if (store === 'pi-xai') {
            transitions.push({
              state,
              intent: (JSON.parse(nextDetail ?? '{}') as Record<string, unknown>).intent,
            });
          }
          return originalUpsertMigration(store, state, nextDetail);
        };

        const rolled = h.mig.rollback();

        const finishedForward = transitions.findIndex((entry) => entry.state === 'QLB_OWNED');
        const beganHandback = transitions.findIndex(
          (entry, index) => index > finishedForward && entry.intent === 'rollback',
        );
        assert.ok(finishedForward >= 0, `${claim}: finishHygiene completes the interrupted commit`);
        assert.ok(beganHandback > finishedForward, `${claim}: rollback starts only after the forward finish`);
        assert.equal(rolled.state, 'NATIVE');
        assert.equal(rolled.detail.intent, undefined);
        assert.equal((rolled.detail.lastRollback as { rolledBackFrom: unknown }).rolledBackFrom, 'post-commit');
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S1 rollback journals intent before any other write and keeps the journal state', async () => {
    {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        const writes: Array<{ state: string; detail: Record<string, unknown> }> = [];
        const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
        h.store.upsertMigration = (store, state, detail) => {
          if (store === 'pi-xai') writes.push({ state, detail: JSON.parse(detail ?? '{}') as Record<string, unknown> });
          return originalUpsertMigration(store, state, detail);
        };

        h.mig.rollback();

        assert.equal(writes[0]?.detail.intent, 'rollback', 'S1 is the first rollback write');
        assert.equal(writes[0]?.state, 'QLB_OWNED', 'S1 preserves a QLB_OWNED journal state');
      } finally {
        h.cleanup();
      }
    }

    {
      const dir = mkdtempSync(join(tmpdir(), 'qlb-s1-native-'));
      const poolPath = join(dir, 'anthropic-pool.json');
      const ownerPath = join(dir, 'qlb-owner.json');
      const store = openStore(join(dir, 'qlb.db'));
      const kc = new MockKeychain();
      const mig = new Migration(store, kc, poolPath, ownerPath);
      writeFileSync(poolPath, JSON.stringify({
        version: 1,
        accounts: [{
          id: 'fixture-account',
          name: 'Fixture Account',
          credentials: {
            type: 'oauth',
            access: 'pool-access-fake',
            refresh: 'pool-refresh-fake',
            expires: Date.now() + 7 * 24 * 3600 * 1000,
          },
        }],
      }) + '\n');
      try {
        mig.stage();
        await mig.rehearse(mockRehearse([]));
        mig.commit();
        const committed = store.getMigration('pi-pool');
        assert.ok(committed);
        store.upsertMigration('pi-pool', 'NATIVE', committed.detail_json);

        const writes: Array<{ state: string; detail: Record<string, unknown> }> = [];
        const originalUpsertMigration = store.upsertMigration.bind(store);
        let crashAfterS1 = true;
        store.upsertMigration = (storeName, state, detail) => {
          if (storeName === 'pi-pool') {
            const write = { state, detail: JSON.parse(detail ?? '{}') as Record<string, unknown> };
            writes.push(write);
            const result = originalUpsertMigration(storeName, state, detail);
            if (crashAfterS1 && write.detail.intent === 'rollback') throw new Error('fixture crash after S1');
            return result;
          }
          return originalUpsertMigration(storeName, state, detail);
        };

        assert.throws(() => mig.rollback(), /fixture crash after S1/);
        assert.equal(writes[0]?.detail.intent, 'rollback', 'S1 is the first rollback write');
        assert.equal(writes[0]?.state, 'NATIVE', 'S1 preserves a NATIVE journal state');
        assert.equal(mig.status().detail.intent, 'rollback', 'status reports the interrupted C4 hand-back');
        assert.match(mig.status().resumeAction, /continue rollback/, 'status directs C4 recovery');

        crashAfterS1 = false;
        assert.equal(mig.resume().state, 'VALIDATED', 'resume routes the NATIVE intent through C4 continuation');
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('T-S0b every command refuses an orphan or unreadable O, L, or Oc claim without changing durable state', () => {
    for (const claim of ['O', 'L', 'Oc', 'unreadable-O', 'unreadable-L', 'unreadable-Oc'] as const) {
      for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
        const h = setup('xai');
        try {
          const customPath = join(h.dir, 'custom-owner.json');
          const useDefaultPath = claim === 'O' || claim === 'L' || claim === 'unreadable-O' || claim === 'unreadable-L';
          const migration = useDefaultPath
            ? h.mig
            : createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
          const ownerPath = claim === 'O' || claim === 'unreadable-O' ? join(h.dir, 'qlb-owner.json')
            : claim === 'L' || claim === 'unreadable-L' ? legacySidecarPath(h)
              : customPath;
          const unreadable = claim.startsWith('unreadable-');
          const ownerBytes = unreadable
            ? '{not valid JSON\n'
            : claim === 'O'
              ? JSON.stringify({ providers: { xai: { mode: 'qlb' } } }) + '\n'
              : JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n';
          writeFileSync(ownerPath, ownerBytes);

          const service = kmCoords('xai').service;
          const keychainBytes = JSON.stringify({ preserved: `${claim}-${command}` });
          h.kc.setSync(service, kmCoords('xai').account, keychainBytes);
          const journalBefore = h.store.getMigration('pi-xai');

          assert.throws(
            () => migration[command](),
            (error: Error & { exitCode?: unknown }) => {
              assert.match(error.message, /owner-file-orphan/);
              assert.match(error.message, new RegExp(ownerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
              if (unreadable) {
                assert.match(error.message, /could not be read/);
              } else if (claim === 'O') {
                assert.match(error.message, /Remove only the xai entry.*do not delete the file/);
              } else {
                assert.match(error.message, /Remove the file/);
              }
              assert.equal(error.exitCode, 3);
              return true;
            },
            `${claim}/${command} is refused`,
          );

          assert.equal(
            h.kc.getSync(service, kmCoords('xai').account),
            keychainBytes,
            `${claim}/${command} leaves the Keychain bytes unchanged`,
          );
          assert.deepEqual(
            readFileSync(ownerPath),
            Buffer.from(ownerBytes),
            `${claim}/${command} leaves the owner file bytes unchanged`,
          );
          assert.deepEqual(
            h.store.getMigration('pi-xai'),
            journalBefore,
            `${claim}/${command} leaves the journal unchanged`,
          );
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-S0h refuses a later unreadable O/L/Oc claim even when an earlier claim is valid', async () => {
    const cases = [
      { name: 'valid O + dangling L', valid: 'O', unreadable: 'L' },
      { name: 'valid O + malformed L', valid: 'O', unreadable: 'L-malformed' },
      { name: 'valid L + unreadable Oc', valid: 'L', unreadable: 'Oc' },
    ] as const;

    for (const testCase of cases) {
      for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
        const h = setup('xai');
        try {
          const customPath = join(h.dir, 'custom-owner.json');
          const migration = testCase.unreadable === 'Oc'
            ? createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath)
            : h.mig;
          if (command !== 'stage') {
            migration.stage();
            await migration.rehearse(mockRehearse([]));
          }

          const mapPath = join(h.dir, 'qlb-owner.json');
          const validPath = testCase.valid === 'O' ? mapPath : legacySidecarPath(h);
          writeFileSync(validPath, testCase.valid === 'O'
            ? JSON.stringify({ providers: { xai: { mode: 'qlb' } } }) + '\n'
            : JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');
          const unreadablePath = testCase.unreadable.startsWith('L') ? legacySidecarPath(h) : customPath;
          if (testCase.unreadable === 'L') {
            const target = join(h.dir, `missing-${command}`);
            symlinkSync(target, unreadablePath);
          } else {
            writeFileSync(unreadablePath, '{not valid JSON\n');
          }

          const stagingPath = stagingOwnerPath(mapPath, 'xai');
          const service = kmCoords('xai').service;
          if (command === 'stage') {
            h.kc.setSync(service, kmCoords('xai').account, JSON.stringify({ preserved: testCase.name }));
          }
          const journalBefore = h.store.getMigration('pi-xai');
          const keychainBefore = h.kc.getSync(service, kmCoords('xai').account);
          const stagingBefore = existsSync(stagingPath) ? readFileSync(stagingPath) : null;
          const validBefore = readFileSync(validPath);
          const unreadableBefore = testCase.unreadable === 'L'
            ? readlinkSync(unreadablePath)
            : readFileSync(unreadablePath);

          assert.throws(() => migration[command](), (error: Error & { exitCode?: unknown }) => {
            assert.match(error.message, new RegExp(`owner-file-orphan: ${unreadablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could not be read`));
            assert.equal(error.exitCode, 3);
            return true;
          }, `${testCase.name}/${command} refuses the later unreadable claim`);
          assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, `${testCase.name}/${command} preserves the journal`);
          assert.equal(h.kc.getSync(kmCoords('xai').service, kmCoords('xai').account), keychainBefore, `${testCase.name}/${command} preserves Keychain`);
          assert.deepEqual(existsSync(stagingPath) ? readFileSync(stagingPath) : null, stagingBefore, `${testCase.name}/${command} preserves staging`);
          assert.deepEqual(readFileSync(validPath), validBefore, `${testCase.name}/${command} preserves the valid claim`);
          if (testCase.unreadable === 'L') {
            assert.equal(readlinkSync(unreadablePath), unreadableBefore, `${testCase.name}/${command} keeps the dangling link`);
          } else {
            assert.deepEqual(readFileSync(unreadablePath), unreadableBefore, `${testCase.name}/${command} preserves the unreadable claim`);
          }
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-S0i rehearse refuses an unreadable L before validating the journal', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      const sidecar = legacySidecarPath(h);
      writeFileSync(sidecar, '{not valid JSON\n');
      const journalBefore = h.store.getMigration('pi-xai');
      const stagingPath = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      const stagingBefore = readFileSync(stagingPath);
      const keychainBefore = h.kc.getSync(kmCoords('xai').service, kmCoords('xai').account);
      const ownerBefore = readFileSync(sidecar);

      await assert.rejects(
        () => h.mig.rehearse(mockRehearse([])),
        (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, new RegExp(`owner-file-orphan: ${sidecar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could not be read`));
          assert.equal(error.exitCode, 3);
          return true;
        },
      );
      assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore);
      assert.deepEqual(readFileSync(stagingPath), stagingBefore);
      assert.equal(h.kc.getSync(kmCoords('xai').service, kmCoords('xai').account), keychainBefore);
      assert.deepEqual(readFileSync(sidecar), ownerBefore);
    } finally {
      h.cleanup();
    }
  });

  it('T-S0g refuses unreadable claims with write-ahead commit evidence without changing recovery artifacts', async () => {
    for (const command of ['commit', 'rollback', 'resume'] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({
          ...detail,
          commitGeneration: h.store.getGrantGeneration(expectedId('xai')),
        }));
        const mapPath = join(h.dir, 'qlb-owner.json');
        const stagingPath = stagingOwnerPath(mapPath, 'xai');
        writeFileSync(mapPath, '{not valid JSON\n');

        const journalBefore = h.store.getMigration('pi-xai');
        const keychainBefore = h.kc.getSync(kmCoords('xai').service, kmCoords('xai').account);
        const stagingBefore = readFileSync(stagingPath);
        const mapBefore = readFileSync(mapPath);

        assert.throws(() => h.mig[command](), (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owner-file-orphan: .*qlb-owner\.json could not be read/);
          assert.equal(error.exitCode, 3);
          return true;
        }, `${command} refuses ambiguous C evidence`);
        assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, `${command} preserves the journal`);
        assert.equal(h.kc.getSync(kmCoords('xai').service, kmCoords('xai').account), keychainBefore, `${command} preserves the Keychain payload`);
        assert.deepEqual(readFileSync(stagingPath), stagingBefore, `${command} preserves staging`);
        assert.deepEqual(readFileSync(mapPath), mapBefore, `${command} preserves O`);
        assert.equal(existsSync(legacySidecarPath(h)), false, `${command} does not create L`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S0g refuses dangling O, L, and Oc symlinks before stage or commit writes', async () => {
    for (const claim of ['O', 'L', 'Oc'] as const) {
      for (const command of ['stage', 'commit'] as const) {
        const h = setup('xai');
        try {
          const customPath = join(h.dir, 'custom-owner.json');
          const migration = claim === 'Oc'
            ? createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath)
            : h.mig;
          if (command === 'commit') {
            migration.stage();
            await migration.rehearse(mockRehearse([]));
          }
          const claimPath = claim === 'O' ? join(h.dir, 'qlb-owner.json')
            : claim === 'L' ? legacySidecarPath(h)
              : customPath;
          const target = join(h.dir, `missing-${claim.toLowerCase()}-${command}`);
          symlinkSync(target, claimPath);
          const stagingPath = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
          const journalBefore = h.store.getMigration('pi-xai');
          const keychainBefore = command === 'commit'
            ? h.kc.getSync(kmCoords('xai').service, kmCoords('xai').account)
            : null;
          const stagingBefore = existsSync(stagingPath) ? readFileSync(stagingPath) : null;

          assert.throws(() => migration[command](), (error: Error & { exitCode?: unknown }) => {
            assert.match(error.message, /owner-file-orphan: .*could not be read/);
            assert.equal(error.exitCode, 3);
            return true;
          }, `${claim}/${command} refuses the dangling link`);
          assert.equal(readlinkSync(claimPath), target, `${claim}/${command} keeps the symlink`);
          assert.equal(existsSync(target), false, `${claim}/${command} does not create the target`);
          assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, `${claim}/${command} preserves the journal`);
          if (keychainBefore === null) {
            assert.throws(() => h.kc.getSync(kmCoords('xai').service, kmCoords('xai').account));
          } else {
            assert.equal(h.kc.getSync(kmCoords('xai').service, kmCoords('xai').account), keychainBefore, `${claim}/${command} preserves the Keychain payload`);
          }
          assert.deepEqual(existsSync(stagingPath) ? readFileSync(stagingPath) : null, stagingBefore, `${claim}/${command} preserves staging`);
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-S0b treats an ENOTDIR claim lookup as present before stage writes anything', () => {
    const h = setup('xai');
    try {
      const blockedParent = join(h.dir, 'not-a-directory');
      writeFileSync(blockedParent, 'not a directory');
      const customPath = join(blockedParent, 'custom-owner.json');
      const migration = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
      const journalBefore = h.store.getMigration('pi-xai');
      const service = kmCoords('xai').service;
      const keychainBytes = JSON.stringify({ preserved: 'ENOTDIR' });
      h.kc.setSync(service, kmCoords('xai').account, keychainBytes);

      assert.throws(
        () => migration.stage(),
        (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owner-file-orphan/);
          assert.match(error.message, /could not be read/);
          assert.equal(error.exitCode, 3);
          return true;
        },
      );
      assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore);
      assert.equal(h.kc.getSync(service, kmCoords('xai').account), keychainBytes);
    } finally {
      h.cleanup();
    }
  });

  it('T-S0f a crash-commit under a custom owner file (Oc) finishes forward and hands back', async () => {
    const h = setup('xai');
    try {
      const customPath = join(h.dir, 'custom-owner.json');
      const mig = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({
        ...detail,
        commitGeneration: h.store.getGrantGeneration(expectedId('xai')),
      }));
      rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'), { force: true });
      writeFileSync(customPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');

      const states: string[] = [];
      const original = h.store.upsertMigration.bind(h.store);
      h.store.upsertMigration = (store, state, next) => {
        if (store === 'pi-xai') states.push(state);
        return original(store, state, next);
      };
      const rolled = mig.rollback();
      assert.ok(states.includes('QLB_OWNED'), 'the Oc claim with own evidence is finished forward');
      assert.equal((rolled.detail.lastRollback as { rolledBackFrom: unknown }).rolledBackFrom, 'post-commit');
      assert.equal(existsSync(customPath), false, 'the hand-back removes the custom owner file');
    } finally {
      h.cleanup();
    }
  });

  it('rollback with a journaled intent over an Oc claim takes the post-commit path', async () => {
    const h = setup('xai');
    try {
      const customPath = join(h.dir, 'custom-owner.json');
      const mig = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({
        ...detail,
        commitGeneration: h.store.getGrantGeneration(expectedId('xai')),
        intent: 'rollback',
      }));
      rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'), { force: true });
      writeFileSync(customPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');

      const states: string[] = [];
      const original = h.store.upsertMigration.bind(h.store);
      h.store.upsertMigration = (store, state, next) => {
        if (store === 'pi-xai') states.push(state);
        return original(store, state, next);
      };
      const rolled = mig.rollback();

      assert.equal(states.includes('NATIVE'), true, 'S5 writes the OD-7 post-commit terminal state');
      assert.equal(existsSync(customPath), false, 'the post-commit hand-back removes the custom owner file');
      assert.equal((rolled.detail.lastRollback as { rolledBackFrom: unknown }).rolledBackFrom, 'post-commit');
    } finally {
      h.cleanup();
    }
  });

  it('resume after a crash between the C5 forward finish and the rollback intent keeps an Oc claim owned', async () => {
    const h = setup('xai');
    try {
      const customPath = join(h.dir, 'custom-owner.json');
      const mig = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'), { force: true });
      writeFileSync(customPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');
      // State right after C5's finishHygiene, before postCommitRollback journals its intent.
      h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({ ...detail, committedAt: Date.now() }));

      const resumed = mig.resume();
      assert.equal(resumed.state, 'QLB_OWNED', 'resume must not report a hand-back while the Oc claim remains');
      assert.equal(existsSync(customPath), true);
    } finally {
      h.cleanup();
    }
  });

  it('C5 never finishes forward without own evidence or over a journaled rollback', async () => {
    for (const fixture of ['orphan-owner-map', 'rollback-intent'] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
        if (fixture === 'orphan-owner-map') {
          // O alone, with no L and no commitGeneration, is not this path's commit.
          rmSync(staging);
          writeFileSync(join(h.dir, 'qlb-owner.json'), JSON.stringify({ providers: { xai: { mode: 'qlb' } } }) + '\n');
        } else {
          renameSync(staging, h.ownerPath);
          h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({
            ...detail,
            commitGeneration: h.store.getGrantGeneration(expectedId('xai')),
            intent: 'rollback',
          }));
        }

        const states: string[] = [];
        const original = h.store.upsertMigration.bind(h.store);
        h.store.upsertMigration = (store, state, next) => {
          if (store === 'pi-xai') states.push(state);
          return original(store, state, next);
        };
        try {
          h.mig.rollback();
        } catch {
          // Refusing is acceptable here; journaling QLB_OWNED is not.
        }
        assert.equal(states.includes('QLB_OWNED'), false, `${fixture}: C5 must not journal QLB_OWNED`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-E3 rollback and resume route C7-C9 without touching at-rest migration state', async () => {
    for (const command of ['rollback', 'resume'] as const) {
      const c7 = setup('xai');
      try {
        c7.mig.stage();
        await c7.mig.rehearse(mockRehearse([]));
        const result = c7.mig[command]();
        assert.equal(result.state, command === 'rollback' ? 'NATIVE' : 'QLB_OWNED', `C7/${command}`);
        assert.equal(
          keychainHas(c7.kc, 'xai'),
          command === 'resume',
          `C7/${command} ${command === 'rollback' ? 'removes' : 'keeps'} the staged grant`,
        );
      } finally {
        c7.cleanup();
      }

      const c8 = setup('xai');
      try {
        c8.mig.stage();
        const result = c8.mig[command]();
        assert.equal(result.state, 'NATIVE', `C8/${command}`);
        assert.equal(keychainHas(c8.kc, 'xai'), false, `C8/${command} removes the staged grant`);
      } finally {
        c8.cleanup();
      }

      for (const state of ['NATIVE', 'VALIDATED'] as const) {
        const c9 = setup('xai');
        try {
          c9.mig.stage();
          rmSync(stagingOwnerPath(join(c9.dir, 'qlb-owner.json'), 'xai'));
          const row = c9.store.getMigration('pi-xai');
          assert.ok(row, 'fixture has a generic journal');
          c9.store.upsertMigration('pi-xai', state, row.detail_json);
          const keychainBefore = c9.kc.getSync(
            kmCoords('xai').service,
            kmCoords('xai').account,
          );
          const journalBefore = c9.store.getMigration('pi-xai');
          const filesBefore = fileSnapshot(c9.dir);

          const result = c9.mig[command]();

          assert.equal(result.state, state, `C9 ${state}/${command} is a no-op`);
          assert.equal(result.resumeAction, 'nothing to roll back', `C9 ${state}/${command} reports the no-op`);
          assert.equal(
            c9.kc.getSync(kmCoords('xai').service, kmCoords('xai').account),
            keychainBefore,
            `C9 ${state}/${command} keeps K_m byte-for-byte`,
          );
          assert.deepEqual(c9.store.getMigration('pi-xai'), journalBefore, `C9 ${state}/${command} keeps the journal`);
          assert.deepEqual(fileSnapshot(c9.dir), filesBefore, `C9 ${state}/${command} keeps every file byte-for-byte`);
        } finally {
          c9.cleanup();
        }
      }
    }
  });

  it('a post-commit hand-back writes the full marker shape and ends through it', async () => {
    for (const [name, disposition] of [
      ['matching Pi entry', 'delete'],
      ['non-matching Pi entry', 'keep'],
    ] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        if (disposition === 'keep') {
          const auth = JSON.parse(readFileSync(h.authPath, 'utf8')) as typeof FAKE_GRANTS;
          auth.xai = { ...auth.xai, refresh: 'xai-refresh-nonmatching-fake' };
          writeFileSync(h.authPath, JSON.stringify(auth, null, 2) + '\n');
        }

        let marker: Record<string, unknown> | undefined;
        const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
        h.store.upsertMigration = (store, state, detail) => {
          const parsed = JSON.parse(detail ?? '{}') as Record<string, unknown>;
          if (store === 'pi-xai' && state === 'NATIVE' && parsed.handback) {
            marker = parsed.handback as Record<string, unknown>;
          }
          return originalUpsertMigration(store, state, detail);
        };

        const rolled = h.mig.rollback();
        assert.equal(rolled.state, 'NATIVE', `${name}: OD-7 terminal state`);
        assert.ok(marker, `${name}: S5 writes its cleanup-pending marker`);
        assert.deepEqual(Object.keys(marker!).sort(), [
          'decision',
          'fencedGeneration',
          'keychainDisposition',
          'phase',
          'piFingerprint',
          'rolledBackAt',
        ]);
        assert.equal(marker!.phase, 'cleanup-pending');
        assert.equal(marker!.keychainDisposition, disposition);
        assert.equal(typeof marker!.piFingerprint, 'string');
        assert.ok(marker!.decision, `${name}: S5 copies the recorded S2 decision`);
        assert.equal(
          marker!.fencedGeneration,
          (marker!.decision as RollbackDecision).fencedGeneration,
          `${name}: S5 copies the S2 fence`,
        );
        assert.equal(typeof marker!.rolledBackAt, 'number');
        const lastRollback = rolled.detail.lastRollback as Record<string, unknown>;
        const { rolledBackFrom, cleanedAt, ...lastMarker } = lastRollback;
        assert.deepEqual(lastMarker, marker, `${name}: S7 copies every H field verbatim`);
        assert.equal(rolledBackFrom, 'post-commit');
        assert.equal(typeof cleanedAt, 'number');
        assert.equal(rolled.detail.commitGeneration, undefined, `${name}: S5 clears commitGeneration`);
        assert.equal(rolled.detail.handback, undefined, `${name}: S7 clears the marker`);
        assert.equal(keychainHas(h.kc, 'xai'), disposition === 'keep', `${name}: recorded disposition controls K_m`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('a crash right after the S5 write resumes to the same terminal state and disposition', async () => {
    for (const disposition of ['delete', 'keep'] as const) {
      const h = setup('xai', new MockKeychain(), {
        afterStep: (point) => {
          if ((point as string) === 'S5') throw new Error('fixture crash after S5');
        },
      });
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        if (disposition === 'keep') {
          const auth = JSON.parse(readFileSync(h.authPath, 'utf8')) as typeof FAKE_GRANTS;
          auth.xai = { ...auth.xai, refresh: 'xai-refresh-nonmatching-fake' };
          writeFileSync(h.authPath, JSON.stringify(auth, null, 2) + '\n');
        }

        assert.throws(() => h.mig.rollback(), /fixture crash after S5/);
        const crashed = h.store.getMigration('pi-xai');
        assert.equal(crashed?.state, 'NATIVE');
        assert.equal((JSON.parse(crashed!.detail_json).handback as { keychainDisposition: unknown }).keychainDisposition, disposition);

        const resumed = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, h.ownerPath);
        const settled = resumed.resume();
        assert.equal(settled.state, 'NATIVE');
        assert.equal(
          (settled.detail.lastRollback as { keychainDisposition: unknown }).keychainDisposition,
          disposition,
          'resume uses the recorded S5 verdict rather than re-ranking',
        );
        assert.equal(keychainHas(h.kc, 'xai'), disposition === 'keep');
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-I4 a live lease makes S2 wait without spending retry attempts and a released lease lets it fence', async () => {
    const waits = 9;
    let now = 1_000_000;
    let sleeps = 0;
    let outsideReads = 0;
    const h = setup('xai', new MockKeychain(), {
      now: () => now,
      sleepSync: (ms) => {
        assert.equal(ms, 100);
        sleeps += 1;
        now += ms;
      },
      afterStep: (point) => {
        if (point === 'S2-reads') outsideReads += 1;
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const accountId = (JSON.parse(h.store.getMigration('pi-xai')!.detail_json).accounts as Array<{ id: string }>)[0].id;
      const originalGetLease = h.store.getLease.bind(h.store);
      h.store.getLease = (name) => name === `refresh:${accountId}` && sleeps < waits
        ? { name, holder_pid: 1, holder_id: 'fixture-refresher', until: now + 1_000, generation: 1 }
        : originalGetLease(name);

      const rolled = h.mig.rollback();

      assert.equal(rolled.state, 'NATIVE');
      assert.equal(sleeps, waits, 'the live lease is waited out');
      assert.equal(outsideReads, waits + 1, 'every wait re-runs outside reads without consuming a RETRY attempt');
      assert.equal(h.store.getGrantGeneration(accountId), 1, 'S2 fences after the lease is released');
    } finally {
      h.cleanup();
    }
  });

  it('T-I4 cap: a lease live past 30 s refuses refresh-in-progress with exit code 3 and keeps only the intent', async () => {
    let now = 2_000_000;
    let sleeps = 0;
    let outsideReads = 0;
    const h = setup('xai', new MockKeychain(), {
      now: () => now,
      sleepSync: (ms) => {
        assert.equal(ms, 100);
        sleeps += 1;
        now += ms;
      },
      afterStep: (point) => {
        if (point === 'S2-reads') outsideReads += 1;
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const accountId = (JSON.parse(h.store.getMigration('pi-xai')!.detail_json).accounts as Array<{ id: string }>)[0].id;
      const generationBefore = h.store.getGrantGeneration(accountId);
      const keychainPresentBefore = keychainHas(h.kc, 'xai');
      const originalGetLease = h.store.getLease.bind(h.store);
      h.store.getLease = (name) => name === `refresh:${accountId}`
        ? { name, holder_pid: 1, holder_id: 'fixture-refresher', until: now + 1_000, generation: 1 }
        : originalGetLease(name);

      assert.throws(
        () => h.mig.rollback(),
        (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /refresh-in-progress/);
          assert.equal(error.exitCode, 3);
          return true;
        },
      );
      const refused = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      assert.equal(sleeps, 300, 'the wait cap is 30 seconds at 100 ms intervals');
      assert.equal(outsideReads, 301, 'the last live-lease check also re-runs outside reads');
      assert.equal(refused.intent, 'rollback', 'the rollback intent stays durable');
      assert.equal(refused.rollbackDecision, undefined, 'S2 records no decision after the wait cap');
      assert.equal(h.store.getGrantGeneration(accountId), generationBefore, 'S2 does not fence under a live lease');
      assert.equal(keychainHas(h.kc, 'xai'), keychainPresentBefore, 'the Keychain copy is unchanged');
    } finally {
      h.cleanup();
    }
  });

  it('S2 keeps the Pi auth lock fresh while it waits and stops if the lock is taken over', async () => {
    let now = 2_500_000;
    let sleeps = 0;
    let authPath = '';
    const lockMtimes: number[] = [];
    const h = setup('xai', new MockKeychain(), {
      now: () => now,
      sleepSync: () => {
        sleeps += 1;
        now += 100;
        const lock = `${authPath}.lock`;
        lockMtimes.push(statSync(lock).mtimeMs);
        utimesSync(lock, new Date(0), new Date(0));
        if (sleeps === 3) writeFileSync(join(lock, 'qlb-lock-owner.json'), '{"pid":1,"nonce":"pi-takeover"}\n');
      },
    });
    try {
      authPath = h.authPath;
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const accountId = (JSON.parse(h.store.getMigration('pi-xai')!.detail_json).accounts as Array<{ id: string }>)[0].id;
      const generationBefore = h.store.getGrantGeneration(accountId);
      const originalGetLease = h.store.getLease.bind(h.store);
      h.store.getLease = (name) => name === `refresh:${accountId}`
        ? { name, holder_pid: 1, holder_id: 'fixture-refresher', until: now + 1_000, generation: 1 }
        : originalGetLease(name);

      assert.throws(() => h.mig.rollback(), /lock-lost/);
      assert.equal(sleeps, 3, 'S2 stops at the first refresh after the takeover');
      assert.ok(lockMtimes.slice(1).every((mtime) => mtime > 0), 'every wait step re-touches the lock');
      const refused = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      assert.equal(refused.intent, 'rollback', 'the rollback intent stays durable');
      assert.equal(refused.rollbackDecision, undefined, 'S2 records no decision');
      assert.equal(h.store.getGrantGeneration(accountId), generationBefore, 'S2 does not fence');
    } finally {
      h.cleanup();
    }
  });

  it('T-I5 a refresher whose lease expired before the fence is fenced at its write', async () => {
    let now = 3_000_000;
    let sleeps = 0;
    const h = setup('xai', new MockKeychain(), {
      now: () => now,
      sleepSync: () => { sleeps += 1; },
      afterStep: (point) => {
        if (point === 'S2') throw new Error('fixture crash after S2');
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const accountId = (JSON.parse(h.store.getMigration('pi-xai')!.detail_json).accounts as Array<{ id: string }>)[0].id;
      const originalGetLease = h.store.getLease.bind(h.store);
      h.store.getLease = (name) => name === `refresh:${accountId}`
        ? { name, holder_pid: 1, holder_id: 'fixture-refresher', until: now, generation: 0 }
        : originalGetLease(name);

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(sleeps, 0, 'an expired lease is not waited for');
      assert.equal(h.store.getGrantGeneration(accountId), 1, 'S2 fences despite the expired lease');
      let refresherWrote = false;
      const writeAtOldGeneration = (): number => {
        if (h.store.casGrantGeneration(accountId, 0, 1) !== 1) return 0;
        refresherWrote = true;
        return 1;
      };
      assert.equal(writeAtOldGeneration(), 0, 'the refresher\'s stale generation CAS is refused');
      assert.equal(refresherWrote, false, 'the refused stale CAS prevents the refresher write');
    } finally {
      h.cleanup();
    }
  });

  it('a refresh lease live at the S5 Keychain read refuses the hand-back and keeps the Keychain copy', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const accountId = (JSON.parse(h.store.getMigration('pi-xai')!.detail_json).accounts as Array<{ id: string }>)[0].id;
      const service = kmCoords('xai').service;
      const account = kmCoords('xai').account;
      let reads = 0;
      const originalGetLease = h.store.getLease.bind(h.store);
      const originalGetSync = h.kc.getSync.bind(h.kc);
      h.store.getLease = (name) => reads >= 3 && name === `refresh:${accountId}`
        ? { name, holder_pid: 1, holder_id: 'fixture-refresher', until: Date.now() + 60_000, generation: 1 }
        : originalGetLease(name);
      h.kc.getSync = (readService, readAccount) => {
        const raw = originalGetSync(readService, readAccount);
        if (readService === service && readAccount === account) reads += 1;
        return raw;
      };

      assert.throws(() => h.mig.rollback(), /refresh-in-progress/);
      assert.ok(reads >= 3, 'the refusal comes from the S5 read, after S2 fenced');
      const refused = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      assert.notEqual(refused.rollbackDecision, undefined, 'S2 already recorded its decision');
      assert.equal(refused.handback, undefined, 'no hand-back marker is recorded');
      assert.equal(keychainHas(h.kc, 'xai'), true, 'the Keychain copy is not deleted');

      h.store.getLease = originalGetLease;
      h.kc.getSync = originalGetSync;
      assert.equal(h.mig.resume().state, 'NATIVE', 'resume completes once the lease is gone');
    } finally {
      h.cleanup();
    }
  });

  it('S2 keychain sourceDigest is the S3 restore record built from the grant and the backup entry', async () => {
    let decision: RollbackDecision | undefined;
    const h = setup('openai-codex', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2') {
          decision = JSON.parse(h.store.getMigration('pi-openai-codex')!.detail_json).rollbackDecision as RollbackDecision;
          throw new Error('fixture crash after S2');
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const coords = kmCoords('openai-codex');
      const grant = parseGrant(h.kc.getSync(coords.service, coords.account))!;
      assert.equal(typeof grant.extra?.accountId, 'string', 'the fixture grant carries an accountId');
      const refreshedGrant = { ...grant, generation: 1 };
      h.kc.setSync(coords.service, coords.account, JSON.stringify(refreshedGrant));
      const backup = readPiAuthBackup(h.authPath, 'openai-codex');

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(decision?.kind, 'keychain');
      assert.equal(decision?.sourceDigest, canonicalDigest(restoreRecordFor({
        authPath: h.authPath,
        key: 'openai-codex',
        decidedAt: decision!.decidedAt,
        filePresent: true,
        entryPresent: true,
        entry: { ...backup!.entry as object, type: 'oauth', access: refreshedGrant.access, refresh: refreshedGrant.refresh, expires: refreshedGrant.expires, accountId: grant.extra!.accountId },
      })));
    } finally {
      h.cleanup();
    }
  });

  it('T-I2 a refresh that commits between the outside reads and the fence forces re-selection', async () => {
    let reads = 0;
    let observedFence: number | undefined;
    let observedDecision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2-reads' && reads++ === 0) {
          const id = expectedId('xai');
          const service = kmCoords('xai').service;
          const raw = h.kc.getSync(service, kmCoords('xai').account);
          h.kc.setSync(service, kmCoords('xai').account, JSON.stringify({
            ...JSON.parse(raw), generation: 1, refresh: 'xai-refresh-rotated-fake',
          }));
          assert.equal(h.store.casGrantGeneration(id, 0, 1), 1, 'fake refresher commits generation one');
        }
        if (point === 'S2') {
          observedDecision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
          observedFence = observedDecision.fencedGeneration;
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      h.mig.rollback();

      assert.equal(reads, 2, 'a generation mismatch re-runs the outside reads');
      assert.equal(observedFence, 2, 'the retry ranks and fences the committed refresher generation');
      assert.equal(observedDecision?.generation, 1, 'the retry re-ranked onto the refresher grant');
      assert.equal(observedDecision?.fingerprint, createHash('sha256').update('xai-refresh-rotated-fake', 'utf8').digest('hex'));
    } finally {
      h.cleanup();
    }
  });

  it('T-I3 a C3 Keychain write between the reads and a backup decision forces re-selection', async () => {
    let reads = 0;
    let observedDecision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2-reads' && reads++ === 0) {
          const service = kmCoords('xai').service;
          const raw = h.kc.getSync(service, kmCoords('xai').account);
          h.kc.setSync(service, kmCoords('xai').account, JSON.stringify({
            ...JSON.parse(raw), generation: 1, refresh: 'xai-refresh-c3-fake',
          }));
        }
        if (point === 'S2') {
          observedDecision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
          throw new Error('fixture crash after S2');
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);

      const service = kmCoords('xai').service;
      const rewritten = parseGrant(h.kc.getSync(service, kmCoords('xai').account));
      assert.equal(reads, 2, 'a Keychain digest mismatch re-runs the outside reads');
      assert.equal(observedDecision?.kind, 'keychain', 'the new C3 grant outranks the backup');
      assert.equal(observedDecision?.kd0, keychainDigest(rewritten), 'the committed decision records the rewritten Keychain digest');
    } finally {
      h.cleanup();
    }
  });

  it('T-I6 a native-resync copy between the reads and the fence is excluded by ranking', async () => {
    let reads = 0;
    let observedDecision: RollbackDecision | undefined;
    let resynced: string | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2-reads' && reads++ === 0) {
          const service = kmCoords('xai').service;
          const raw = h.kc.getSync(service, kmCoords('xai').account);
          resynced = JSON.stringify({ ...JSON.parse(raw), generation: 1, writtenBy: 'native-resync' });
          h.kc.setSync(service, kmCoords('xai').account, resynced);
        }
        if (point === 'S2') {
          observedDecision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();

      h.mig.rollback();

      assert.equal(reads, 2, 'a native-resync Keychain write re-runs the outside reads');
      assert.equal(observedDecision?.kind, 'exact-backup', 'ranking excludes the native-resync copy');
      assert.equal(observedDecision?.kd0, keychainDigest(parseGrant(resynced!)), 'the decision records the re-read Keychain digest');
      assert.equal(observedDecision?.fencedGeneration, 2, 'the fence is max(g0, k0) + 1 from the re-read k0 = 1');
    } finally {
      h.cleanup();
    }
  });

  it('T-S2a decision and fence commit in one transaction', async () => {
    let committedDecision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point !== 'S2') return;
        const row = h.store.getMigration('pi-xai')!;
        committedDecision = JSON.parse(row.detail_json).rollbackDecision as RollbackDecision;
        assert.equal(h.store.getGrantGeneration(expectedId('xai')), committedDecision.fencedGeneration);
        assert.equal(existsSync(ownerMapPath(h)), true, 'S2 commits before the existing v2 un-own path');
        throw new Error('fixture crash after S2');
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const runImmediate = h.store.runImmediate.bind(h.store);
      let inS2Transaction = false;
      let casInsideTransaction = false;
      let journalInsideTransaction = false;
      const cas = h.store.casGrantGeneration.bind(h.store);
      const journal = h.store.upsertMigration.bind(h.store);
      h.store.runImmediate = (<T>(fn: () => T): T => runImmediate(() => {
        inS2Transaction = true;
        try {
          return fn();
        } finally {
          inS2Transaction = false;
        }
      })) as typeof h.store.runImmediate;
      h.store.casGrantGeneration = (id, from, to) => {
        casInsideTransaction ||= inS2Transaction;
        return cas(id, from, to);
      };
      h.store.upsertMigration = (store, state, detail, updatedAt) => {
        if (store === 'pi-xai' && JSON.parse(detail ?? '{}').rollbackDecision) {
          journalInsideTransaction ||= inS2Transaction;
        }
        return journal(store, state, detail, updatedAt);
      };

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(casInsideTransaction, true, 'the fence CAS runs in S2\'s immediate transaction');
      assert.equal(journalInsideTransaction, true, 'the decision journal write runs in that transaction');
      assert.equal(committedDecision?.kind, 'exact-backup');
      assert.equal(committedDecision?.fencedGeneration, 1);
      assert.equal(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).intent, 'rollback');
    } finally {
      h.cleanup();
    }
  });

  it('T-S2b fence lands above a C3 Keychain generation', async () => {
    let decision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2') {
          decision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
          throw new Error('fixture crash after S2');
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const service = kmCoords('xai').service;
      const raw = h.kc.getSync(service, kmCoords('xai').account);
      h.kc.setSync(service, kmCoords('xai').account, JSON.stringify({ ...JSON.parse(raw), generation: 1 }));

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(decision?.generation, 1);
      assert.equal(decision?.fencedGeneration, 2);
      assert.equal(h.store.getGrantGeneration(expectedId('xai')), 2);
    } finally {
      h.cleanup();
    }
  });

  it('T-S2h backup-only rollback fences at g0+1', async () => {
    let decision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2') {
          decision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
          throw new Error('fixture crash after S2');
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const service = kmCoords('xai').service;
      const raw = h.kc.getSync(service, kmCoords('xai').account);
      h.kc.setSync(service, kmCoords('xai').account, JSON.stringify({ ...JSON.parse(raw), writtenBy: 'native-resync' }));

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(decision?.kind, 'exact-backup');
      assert.equal(decision?.sourceDigest, canonicalDigest(readPiAuthBackup(h.authPath, 'xai')), 'a backup kind digests the normalised backup');
      assert.equal(decision?.fencedGeneration, 1);
      assert.equal(h.store.getGrantGeneration(expectedId('xai')), 1);
    } finally {
      h.cleanup();
    }
  });

  it('T-S2c no restore source and no valid native entry keeps only the intent', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const id = expectedId('xai');
      const service = kmCoords('xai').service;
      const account = kmCoords('xai').account;
      h.kc.deleteSync(service, account);
      writeFileSync(h.authPath, JSON.stringify({ 'kimi-coding': FAKE_GRANTS['kimi-coding'] }, null, 2) + '\n');

      const generationBefore = h.store.getGrantGeneration(id);
      const authBefore = readFileSync(h.authPath);
      const ownerBefore = readFileSync(ownerMapPath(h));
      const exactBackup = piAuthBackupPath(h.authPath, 'xai');
      const legacyBackup = legacyPiAuthBackupPath(h.authPath, 'xai');
      rmSync(exactBackup, { force: true });
      assert.equal(existsSync(exactBackup), false, 'fixture removes P7b6\'s exact backup to exercise the no-source refusal');
      assert.equal(existsSync(legacyBackup), false, 'fixture has no legacy backup');

      assert.throws(
        () => h.mig.rollback(),
        (error: unknown) => {
          const refusal = error as { message?: unknown; exitCode?: unknown };
          assert.match(String(refusal.message), /^no-restore-source: log in to Pi natively, then run `qlb migrate resume --provider xai`$/);
          assert.equal(refusal.exitCode, 3);
          return true;
        },
      );

      const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      assert.equal(detail.intent, 'rollback', 'S1 intent remains durable');
      assert.equal(detail.rollbackDecision, undefined, 'S2 records no decision');
      assert.equal(h.store.getGrantGeneration(id), generationBefore, 'S2 does not fence');
      assert.deepEqual(readFileSync(h.authPath), authBefore, 'auth.json is unchanged');
      assert.equal(existsSync(ownerMapPath(h)), true, 'the v2 owner map remains present');
      assert.deepEqual(readFileSync(ownerMapPath(h)), ownerBefore, 'the v2 owner map is unchanged');
      assert.equal(existsSync(exactBackup), false, 'the exact backup remains absent');
      assert.equal(existsSync(legacyBackup), false, 'the legacy backup remains absent');
      assert.throws(() => h.kc.getSync(service, account), 'the missing Keychain item remains absent');
    } finally {
      h.cleanup();
    }
  });

  it('T-S2i malformed Keychain payload refuses rollback-source-malformed and an operational error refuses keychain-unavailable, both keeping only the intent', async () => {
    for (const fixture of [
      { name: 'outside malformed payload', fault: 'malformed' as const, faultOnGet: 1, message: 'rollback-source-malformed' },
      { name: 'outside operational error', fault: 'unavailable' as const, faultOnGet: 1, message: 'keychain-unavailable' },
      { name: 'in-transaction malformed payload', fault: 'malformed' as const, faultOnGet: 2, message: 'rollback-source-malformed' },
      { name: 'in-transaction operational error', fault: 'unavailable' as const, faultOnGet: 2, message: 'keychain-unavailable' },
    ]) {
      const kc = new S2ReadTaxonomyKeychain();
      const h = setup('xai', kc);
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        const id = expectedId('xai');
        const service = kmCoords('xai').service;
        const account = kmCoords('xai').account;
        const keychainBefore = kc.getSync(service, account);
        const generationBefore = h.store.getGrantGeneration(id);
        const authBefore = readFileSync(h.authPath);
        const ownerBefore = readFileSync(ownerMapPath(h));
        const backupPaths = [piAuthBackupPath(h.authPath, 'xai'), legacyPiAuthBackupPath(h.authPath, 'xai')];
        const backupsBefore = backupPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined);
        kc.getCalls = 0;
        kc.fault = fixture.fault;
        kc.faultOnGet = fixture.faultOnGet;

        assert.throws(
          () => h.mig.rollback(),
          (error: unknown) => {
            const refusal = error as { message?: unknown; exitCode?: unknown };
            assert.equal(refusal.message, fixture.message, fixture.name);
            assert.equal(refusal.exitCode, 3, fixture.name);
            return true;
          },
        );

        const callsAtRefusal = kc.getCalls;
        if (fixture.fault === 'unavailable') {
          assert.equal(callsAtRefusal, fixture.faultOnGet, `${fixture.name}: no retry loop`);
        }
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.equal(detail.intent, 'rollback', `${fixture.name}: intent remains durable`);
        assert.equal(detail.rollbackDecision, undefined, `${fixture.name}: no decision is recorded`);
        assert.equal(h.store.getGrantGeneration(id), generationBefore, `${fixture.name}: G is unchanged`);
        assert.deepEqual(readFileSync(h.authPath), authBefore, `${fixture.name}: auth.json is unchanged`);
        assert.deepEqual(readFileSync(ownerMapPath(h)), ownerBefore, `${fixture.name}: v2 owner map is unchanged`);
        assert.deepEqual(
          backupPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined),
          backupsBefore,
          `${fixture.name}: backups are unchanged`,
        );
        kc.fault = undefined;
        kc.faultOnGet = undefined;
        assert.equal(kc.getSync(service, account), keychainBefore, `${fixture.name}: Keychain is unchanged`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S3b a valid native entry that appears after S2 ranks and before S3 writes wins', async () => {
    const nativeLogin = JSON.stringify({
      ...FAKE_GRANTS,
      xai: { ...FAKE_GRANTS.xai, access: 'xai-access-native-fake', refresh: 'xai-refresh-native-fake' },
    }, null, 2) + '\n';
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2') writeFileSync(h.authPath, nativeLogin);
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();

      const rolled = h.mig.rollback();

      assert.equal(rolled.state, 'NATIVE', 'the hand-back completes');
      assert.deepEqual(readFileSync(h.authPath), Buffer.from(nativeLogin), 'S3 does not write over the native entry that appeared after ranking');
    } finally {
      h.cleanup();
    }
  });

  it('T-S3a restore write is verified under the auth lock and a failed write keeps everything', async () => {
    {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        writeFileSync(h.authPath, JSON.stringify({
          ...FAKE_GRANTS,
          xai: { type: 'oauth', access: 'qlb-managed', refresh: '' },
        }, null, 2) + '\n');
        const guarded = h.mig as unknown as {
          restoreSingleGrantPiAuthEntry: (key: string, record: unknown) => unknown;
        };
        const restore = guarded.restoreSingleGrantPiAuthEntry.bind(h.mig);
        let writes = 0;
        guarded.restoreSingleGrantPiAuthEntry = (key, record) => {
          writes += 1;
          assert.equal(existsSync(`${resolve(h.authPath)}.lock`), true, 'S3 writes while Pi auth lock is held');
          return restore(key, record);
        };

        h.mig.rollback();

        assert.equal(writes, 1, 'S3 has one durable restore write path');
        assert.deepEqual(readFileSync(h.authPath), h.originalBytes, 'the restored auth.json bytes match the Keychain source');
        assert.equal(existsSync(ownerMapPath(h)), false, 'S4 releases v2 ownership only after verified restore');
        assert.ok((h.store.getMigration('pi-xai') && JSON.parse(h.store.getMigration('pi-xai')!.detail_json).lastRollback), 'the rollback journal reaches its terminal record');
      } finally {
        h.cleanup();
      }
    }

    for (const failure of ['write', 'verify'] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        writeFileSync(h.authPath, JSON.stringify({
          ...FAKE_GRANTS,
          xai: { type: 'oauth', access: 'qlb-managed', refresh: '' },
        }, null, 2) + '\n');
        const id = expectedId('xai');
        const service = kmCoords('xai').service;
        const account = kmCoords('xai').account;
        const ownerBefore = readFileSync(ownerMapPath(h));
        const backupBefore = readFileSync(piAuthBackupPath(h.authPath, 'xai'));
        const keychainBefore = h.kc.getSync(service, account);
        const guarded = h.mig as unknown as {
          restoreSingleGrantPiAuthEntry: (key: string, record: unknown) => unknown;
          readSingleGrantAuth: () => Record<string, unknown>;
        };
        if (failure === 'write') {
          guarded.restoreSingleGrantPiAuthEntry = () => {
            assert.equal(existsSync(`${resolve(h.authPath)}.lock`), true, 'failed S3 write is attempted under the lock');
            throw new Error('injected S3 write failure');
          };
        } else {
          const read = guarded.readSingleGrantAuth.bind(h.mig);
          const restore = guarded.restoreSingleGrantPiAuthEntry.bind(h.mig);
          let restored = false;
          guarded.restoreSingleGrantPiAuthEntry = (key, record) => {
            const result = restore(key, record);
            restored = true;
            return result;
          };
          guarded.readSingleGrantAuth = () => {
            const auth = read();
            return restored ? { ...auth, xai: { ...FAKE_GRANTS.xai, refresh: 'verify-mismatch-fake' } } : auth;
          };
        }

        assert.throws(() => h.mig.rollback(), failure === 'write' ? /injected S3 write failure/ : /restore verification failed/);

        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.equal(detail.intent, 'rollback', `${failure}: S1 intent is retained`);
        assert.ok(detail.rollbackDecision, `${failure}: S2 decision is retained`);
        assert.deepEqual(readFileSync(ownerMapPath(h)), ownerBefore, `${failure}: S4 does not release the v2 owner claim`);
        assert.deepEqual(readFileSync(piAuthBackupPath(h.authPath, 'xai')), backupBefore, `${failure}: backup is retained`);
        assert.equal(h.kc.getSync(service, account), keychainBefore, `${failure}: K_m is unchanged`);
        if (failure === 'write') {
          assert.match(readFileSync(h.authPath, 'utf8'), /qlb-managed/, 'failed write leaves the auth bytes unchanged');
        } else {
          assert.match(readFileSync(h.authPath, 'utf8'), /xai-refresh-fake/, 'failed verify keeps the completed write for retry verification');
        }
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S3c an entryPresent:false source deletes the key and a retry does not resurrect it', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const withoutXai = { ...FAKE_GRANTS } as Record<string, unknown>;
      delete withoutXai.xai;
      writeFileSync(h.authPath, JSON.stringify(withoutXai, null, 2) + '\n');
      writePiAuthBackup(h.authPath, 'xai', 'entry-absent-fixture');
      writeFileSync(h.authPath, JSON.stringify({
        ...withoutXai,
        xai: { type: 'oauth', access: 'qlb-managed', refresh: '' },
      }, null, 2) + '\n');

      h.mig.rollback();
      const bytesAfterRollback = readFileSync(h.authPath);
      const authAfterRollback = JSON.parse(bytesAfterRollback.toString('utf8')) as Record<string, unknown>;
      assert.equal(Object.prototype.hasOwnProperty.call(authAfterRollback, 'xai'), false, 'the recorded absent entry deletes the placeholder key');
      assert.deepEqual(bytesAfterRollback, Buffer.from(JSON.stringify(withoutXai, null, 2) + '\n'), 'auth.json bytes contain no resurrected key');
      assert.equal(existsSync(h.ownerPath), false, 'S4 releases the owner after the deletion verifies');
      assert.ok(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).lastRollback, 'the terminal journal records the hand-back');

      h.mig.resume();
      assert.deepEqual(readFileSync(h.authPath), bytesAfterRollback, 'retry leaves the absent key absent');
    } finally {
      h.cleanup();
    }
  });

  it('T-S3c2 guard (c): an absent key with an entryPresent:false decision is satisfied without a write', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const withoutXai = { ...FAKE_GRANTS } as Record<string, unknown>;
      delete withoutXai.xai;
      writeFileSync(h.authPath, JSON.stringify(withoutXai, null, 2) + '\n');
      writePiAuthBackup(h.authPath, 'xai', 'entry-absent-guard-c');
      const before = readFileSync(h.authPath);

      h.mig.rollback();

      assert.deepEqual(readFileSync(h.authPath), before, 'guard (c) writes nothing and never resurrects the key');
      assert.equal(existsSync(h.ownerPath), false, 'S4 releases the owner once guard (c) is satisfied');
      assert.ok(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).lastRollback, 'the terminal journal records the hand-back');
    } finally {
      h.cleanup();
    }
  });

  it('T-S3d restore recreates a deleted auth.json from the backup', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      writePiAuthBackup(h.authPath, 'xai', 'recreate-file-fixture');
      rmSync(h.authPath, { force: true });

      h.mig.rollback();

      const expected = Buffer.from(JSON.stringify({ xai: FAKE_GRANTS.xai }, null, 2) + '\n');
      assert.deepEqual(readFileSync(h.authPath), expected, 'S3 recreates auth.json with the backed-up key');
      assert.equal(existsSync(ownerMapPath(h)), false, 'S4 follows only after the restore verifies');
      assert.ok(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).lastRollback, 'the terminal journal records the hand-back');
    } finally {
      h.cleanup();
    }
  });

  it('xai staged from key grok: auth.grok becomes the placeholder, auth.xai is untouched, backup keyed grok, providers.xai set', async () => {
    const h = setup('xai');
    try {
      const grok = { ...FAKE_GRANTS.xai, access: 'grok-access-fake', refresh: 'grok-refresh-fake' };
      writeFileSync(h.authPath, JSON.stringify({ ...FAKE_GRANTS, grok }, null, 2) + '\n');
      const migration = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, h.ownerPath, 'grok');
      migration.stage();
      await migration.rehearse(mockRehearse([]));
      migration.commit();
      const committedAuth = JSON.parse(readFileSync(h.authPath, 'utf8')) as Record<string, unknown>;
      assert.equal(isPiPlaceholder(committedAuth.grok), true, 'commit writes the placeholder at the staged auth key');
      assert.deepEqual(readPiAuthBackup(h.authPath, 'grok')?.entry, grok, 'commit backs up the staged auth key');
      assert.equal(JSON.parse(readFileSync(ownerMapPath(h), 'utf8')).providers.xai.mode, 'qlb', 'commit publishes xai in the v2 map');
      const xaiBefore = committedAuth.xai;

      migration.rollback();

      const bytes = readFileSync(h.authPath);
      const auth = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      assert.deepEqual(auth.grok, grok, 'S3 restores the journaled grok key');
      assert.deepEqual(auth.xai, xaiBefore, 'S3 never writes the provider-default xai key');
      assert.deepEqual(bytes, Buffer.from(JSON.stringify({ ...FAKE_GRANTS, grok }, null, 2) + '\n'), 'final auth.json bytes modify only auth.grok');
      assert.equal(existsSync(ownerMapPath(h)), false, 'S4 releases the final v2 owner after the grok write verifies');
      assert.ok(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).lastRollback, 'the terminal journal records the hand-back');
    } finally {
      h.cleanup();
    }
  });

  it('T-S3p a placeholder entry is restored, not refused', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      writeFileSync(h.authPath, JSON.stringify({
        ...FAKE_GRANTS,
        xai: { type: 'oauth', access: 'qlb-managed', refresh: '' },
      }, null, 2) + '\n');

      h.mig.rollback();

      const bytes = readFileSync(h.authPath);
      const auth = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      assert.deepEqual(auth.xai, FAKE_GRANTS.xai, 'the fenced Keychain source replaces the placeholder');
      assert.deepEqual(bytes, h.originalBytes, 'final auth.json bytes contain the restored native entry');
      assert.equal(existsSync(ownerMapPath(h)), false, 'restore and verify complete before S4 un-owns');
      assert.ok(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).lastRollback, 'the terminal journal records the hand-back');
    } finally {
      h.cleanup();
    }
  });

  it('T-S4a owner entry is removed only after the restore is verified', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const placeholder = { type: 'oauth', access: 'qlb-managed', refresh: '' };
      const placeholderBytes = Buffer.from(JSON.stringify({ ...FAKE_GRANTS, xai: placeholder }, null, 2) + '\n');
      const ownerMapPath = join(h.dir, 'qlb-owner.json');
      const otherEntry = { mode: 'qlb', since: 987_654 };
      writeFileSync(ownerMapPath, JSON.stringify({
        providers: {
          xai: { mode: 'qlb', since: 123_456 },
          'kimi-coding': otherEntry,
        },
      }, null, 2) + '\n');
      const ownerBefore = JSON.parse(readFileSync(ownerMapPath, 'utf8')) as { providers: Record<string, unknown> };
      const otherEntryBytes = Buffer.from(JSON.stringify(ownerBefore.providers['kimi-coding']));
      writeFileSync(h.authPath, placeholderBytes);

      const guarded = h.mig as unknown as {
        restoreSingleGrantPiAuthEntry: (key: string, record: unknown) => unknown;
      };
      const restore = guarded.restoreSingleGrantPiAuthEntry.bind(h.mig);
      let failRestore = true;
      guarded.restoreSingleGrantPiAuthEntry = (key, record) => {
        const ownerDuringRestore = JSON.parse(readFileSync(ownerMapPath, 'utf8')) as { providers: Record<string, unknown> };
        const authDuringRestore = JSON.parse(readFileSync(h.authPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(ownerDuringRestore.providers.xai, ownerBefore.providers.xai, 'S4a keeps the v2 entry until S3 has restored and verified');
        assert.deepEqual(authDuringRestore.xai, placeholder, 'the v2 entry is never removed while A is the placeholder');
        if (failRestore) throw new Error('injected S3 restore failure');
        const result = restore(key, record);
        const ownerAfterRestoreWrite = JSON.parse(readFileSync(ownerMapPath, 'utf8')) as { providers: Record<string, unknown> };
        assert.deepEqual(ownerAfterRestoreWrite.providers.xai, ownerBefore.providers.xai, 'S4a follows the S3 verification, not merely its write');
        return result;
      };

      assert.throws(() => h.mig.rollback(), /injected S3 restore failure/);
      const failedDetail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      const ownerAfterFailure = JSON.parse(readFileSync(ownerMapPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.deepEqual(readFileSync(h.authPath), placeholderBytes, 'failed S3 keeps auth.json');
      assert.deepEqual(ownerAfterFailure.providers.xai, ownerBefore.providers.xai, 'failed S3 keeps the v2 owner entry');
      assert.equal(failedDetail.intent, 'rollback', 'failed S3 keeps the rollback intent');
      assert.ok(failedDetail.rollbackDecision, 'failed S3 keeps the fenced decision');

      failRestore = false;
      h.mig.resume();

      const ownerAfterResume = JSON.parse(readFileSync(ownerMapPath, 'utf8')) as { providers: Record<string, unknown> };
      const authAfterResume = JSON.parse(readFileSync(h.authPath, 'utf8')) as Record<string, unknown>;
      assert.equal(Object.prototype.hasOwnProperty.call(ownerAfterResume.providers, 'xai'), false, 'S4a removes only this provider from the v2 map');
      assert.deepEqual(Buffer.from(JSON.stringify(ownerAfterResume.providers['kimi-coding'])), otherEntryBytes, 'S4a keeps the other v2 entry byte-for-byte');
      assert.deepEqual(authAfterResume.xai, FAKE_GRANTS.xai, 'A is the verified restored entry');
      assert.ok(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).lastRollback, 'the completed hand-back records lastRollback');
    } finally {
      h.cleanup();
    }
  });

  it('S4a takes the owner-map lock when the owner file is outside auth.json\'s directory (P7b5-40 r1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    try {
      const authPath = join(dir, 'auth.json');
      const ownerDir = join(dir, 'owner');
      mkdirSync(ownerDir);
      writeFileSync(authPath, fixtureAuthJson(), { encoding: 'utf8', mode: 0o600 });
      const mig = createSingleGrantMigration(store, new MockKeychain(), 'xai', authPath, join(ownerDir, 'qlb-owner-xai.json'), 'xai', {});
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      mig.commit();
      const ownerMapPath = join(ownerDir, 'qlb-owner.json');
      const otherEntry = { mode: 'qlb', since: 987_654 };
      writeFileSync(ownerMapPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 123_456 }, 'kimi-coding': otherEntry } }, null, 2) + '\n');
      writeFileSync(authPath, JSON.stringify({ ...FAKE_GRANTS, xai: { type: 'oauth', access: 'qlb-managed', refresh: '' } }, null, 2) + '\n');
      // A live holder of the owner-map lock in the owner file's directory.
      const lock = join(ownerDir, 'auth.json.lock');
      mkdirSync(lock);
      writeFileSync(join(lock, 'qlb-lock-owner.json'), `${JSON.stringify({ pid: process.pid, nonce: 'another-holder' })}\n`);

      assert.throws(() => mig.rollback(), (error: unknown) => {
        assert.match(String((error as Error).message), /pi-auth-locked/);
        assert.equal((error as { exitCode?: unknown }).exitCode, 3, 'a held owner-map lock refuses with exit 3');
        return true;
      });
      const held = JSON.parse(readFileSync(ownerMapPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(held.providers.xai, 'a held owner-map lock keeps the v2 entry');

      rmSync(lock, { recursive: true, force: true });
      mig.resume();
      const after = JSON.parse(readFileSync(ownerMapPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.equal(Object.prototype.hasOwnProperty.call(after.providers, 'xai'), false);
      assert.deepEqual(after.providers['kimi-coding'], otherEntry);
      assert.ok(JSON.parse(store.getMigration('pi-xai')!.detail_json).lastRollback);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S4a refuses on an owner map that became unreadable after the entry checks and keeps the decision (P7b5-40 r1)', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const ownerMapPath = join(h.dir, 'qlb-owner.json');
      writeFileSync(ownerMapPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }, null, 2) + '\n');
      writeFileSync(h.authPath, JSON.stringify({ ...FAKE_GRANTS, xai: { type: 'oauth', access: 'qlb-managed', refresh: '' } }, null, 2) + '\n');
      const guarded = h.mig as unknown as { restoreSingleGrantPiAuthEntry: (key: string, record: unknown) => unknown };
      const restore = guarded.restoreSingleGrantPiAuthEntry.bind(h.mig);
      let corrupt = true;
      guarded.restoreSingleGrantPiAuthEntry = (key, record) => {
        // The map turns unreadable after rollback's entry checks, before S4a.
        if (corrupt) writeFileSync(ownerMapPath, '{ not json');
        return restore(key, record);
      };

      assert.throws(() => h.mig.rollback());
      const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      assert.equal(detail.intent, 'rollback', 'an unreadable map keeps the rollback intent');
      assert.ok(detail.rollbackDecision, 'an unreadable map keeps the fenced decision');
      assert.equal(detail.lastRollback, undefined, 'the hand-back is not recorded over a stale claim');

      corrupt = false;
      writeFileSync(ownerMapPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }, null, 2) + '\n');
      h.mig.resume();
      assert.equal(existsSync(ownerMapPath), false, 'the emptied map is unlinked');
      assert.ok(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).lastRollback);
    } finally {
      h.cleanup();
    }
  });

  it('S4a removes the single provider v2 owner entry at the map path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    try {
      const authPath = join(dir, 'auth.json');
      const ownerMapPath = join(dir, 'qlb-owner.json');
      writeFileSync(authPath, fixtureAuthJson(), { encoding: 'utf8', mode: 0o600 });
      const mig = createSingleGrantMigration(store, new MockKeychain(), 'xai', authPath, ownerMapPath, 'xai', {});
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      mig.commit();
      assert.equal(JSON.parse(readFileSync(ownerMapPath, 'utf8')).providers.xai.mode, 'qlb', 'the commit wrote a v2 owner entry at the map path');

      mig.rollback();
      assert.equal(existsSync(ownerMapPath), false, 'the final v2 owner entry is removed');
      assert.ok(JSON.parse(store.getMigration('pi-xai')!.detail_json).lastRollback);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T-S4b legacy sidecar and a custom v1 owner file are unlinked; another provider's entry kept", async () => {
    {
      const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
      const store = openStore(join(dir, 'qlb.db'));
      try {
        const authPath = join(dir, 'auth.json');
        const ownerMapPath = join(dir, 'qlb-owner.json');
        writeFileSync(authPath, fixtureAuthJson(), { encoding: 'utf8', mode: 0o600 });
        const mig = createSingleGrantMigration(store, new MockKeychain(), 'xai', authPath, ownerMapPath);
        mig.stage();
        await mig.rehearse(mockRehearse([]));
        mig.commit();
        writeFileSync(ownerMapPath, JSON.stringify({
          providers: {
            xai: { mode: 'qlb', since: 123_456 },
            'kimi-coding': { mode: 'qlb', since: 987_654 },
          },
        }, null, 2) + '\n');

        mig.rollback();

        assert.equal(existsSync(ownerMapPath), true, 'S4b never unlinks the shared v2 map');
        const map = JSON.parse(readFileSync(ownerMapPath, 'utf8')) as { providers: Record<string, unknown> };
        assert.equal(map.providers.xai, undefined, 'S4a removes only this provider');
        assert.deepEqual(map.providers['kimi-coding'], { mode: 'qlb', since: 987_654 }, 'the other v2 provider survives');
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const h = setup('xai');
    try {
      const customOwnerPath = join(h.dir, 'custom-owner.json');
      const mig = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customOwnerPath);
      const ownerMapPath = join(h.dir, 'qlb-owner.json');
      const legacySidecarPath = join(h.dir, 'qlb-owner-xai.json');
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      mig.commit();
      writeFileSync(legacySidecarPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');
      writeFileSync(ownerMapPath, JSON.stringify({
        providers: {
          xai: { mode: 'qlb', since: 123_456 },
          'kimi-coding': { mode: 'qlb', since: 987_654 },
        },
      }, null, 2) + '\n');

      mig.rollback();

      assert.equal(existsSync(legacySidecarPath), false, 'S4b unlinks L');
      assert.equal(existsSync(customOwnerPath), false, 'S4b unlinks Oc');
      const map = JSON.parse(readFileSync(ownerMapPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.equal(map.providers.xai, undefined, 'S4a removes only this provider');
      assert.deepEqual(map.providers['kimi-coding'], { mode: 'qlb', since: 987_654 }, 'the other v2 provider survives S4b');
    } finally {
      h.cleanup();
    }
  });

  it('S4b leaves a foreign v1 pool document at the map path and unlinks this provider\'s legacy sidecar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    try {
      const authPath = join(dir, 'auth.json');
      const ownerMapPath = join(dir, 'qlb-owner.json');
      const sidecar = join(dir, 'qlb-owner-xai.json');
      writeFileSync(authPath, fixtureAuthJson(), { encoding: 'utf8', mode: 0o600 });
      const mig = createSingleGrantMigration(store, new MockKeychain(), 'xai', authPath, ownerMapPath);
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      mig.commit();
      const anthropicPool = JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n';
      writeFileSync(ownerMapPath, anthropicPool);
      writeFileSync(sidecar, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');

      assert.equal(mig.rollback().state, 'NATIVE');
      assert.deepEqual(readFileSync(ownerMapPath), Buffer.from(anthropicPool), 'S4b keeps the foreign v1 pool document byte-identical');
      assert.equal(existsSync(sidecar), false, 'S4b unlinks this provider\'s legacy sidecar');
      const detail = JSON.parse(store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      assert.ok(detail.lastRollback, 'the hand-back completes');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S4a\'s map write is made durable before S5 when S4b unlinks nothing (P7b5-41 r1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    try {
      const authPath = join(dir, 'auth.json');
      const ownerMapPath = join(dir, 'qlb-owner.json');
      writeFileSync(authPath, fixtureAuthJson(), { encoding: 'utf8', mode: 0o600 });
      const synced: string[] = [];
      const mig = createSingleGrantMigration(store, new MockKeychain(), 'xai', authPath, ownerMapPath, 'xai', {
        fsyncDirectory: (path) => { synced.push(resolve(path)); },
      });
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      mig.commit();
      const otherEntry = { mode: 'qlb', since: 987_654 };
      writeFileSync(ownerMapPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 }, 'kimi-coding': otherEntry } }, null, 2) + '\n');
      synced.length = 0;

      mig.rollback();
      assert.ok(synced.includes(resolve(dir)), `the owner map's directory is fsynced (synced: ${synced.join(', ')})`);
      const after = JSON.parse(readFileSync(ownerMapPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.deepEqual(after.providers, { 'kimi-coding': otherEntry }, 'the v2 map survives without this provider');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S4b applies the map-path rule to an unnormalised --owner-file and a refusal keeps the legacy sidecar (P7b5-41 r1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    try {
      const authPath = join(dir, 'auth.json');
      const ownerMapPath = join(dir, 'qlb-owner.json');
      writeFileSync(authPath, fixtureAuthJson(), { encoding: 'utf8', mode: 0o600 });
      const mig = createSingleGrantMigration(store, new MockKeychain(), 'xai', authPath, `${dir}/./qlb-owner.json`);
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      mig.commit();
      const mixedV1 = JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }, { provider: 'kimi-coding' }] }) + '\n';
      writeFileSync(ownerMapPath, mixedV1);
      const sidecar = join(dir, 'qlb-owner-xai.json');
      writeFileSync(sidecar, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');

      assert.throws(() => mig.rollback(), (error: Error & { exitCode?: unknown }) => {
        assert.match(error.message, /owner-file-orphan: .* names another provider/);
        assert.equal(error.exitCode, 3);
        return true;
      });
      assert.deepEqual(readFileSync(ownerMapPath), Buffer.from(mixedV1), 'the shared v1 file naming another provider is kept');
      assert.equal(existsSync(sidecar), true, 'a refusal unlinks nothing, not even the legacy sidecar');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S4b decides and unlinks a map-path v1 file under the owner-map lock when it is not the auth lock (P7b5-41 r1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    try {
      const authPath = join(dir, 'auth.json');
      const ownerDir = join(dir, 'owner');
      mkdirSync(ownerDir);
      const ownerMapPath = join(ownerDir, 'qlb-owner.json');
      writeFileSync(authPath, fixtureAuthJson(), { encoding: 'utf8', mode: 0o600 });
      const lock = join(ownerDir, 'auth.json.lock');
      let holdLock = false;
      const mig = createSingleGrantMigration(store, new MockKeychain(), 'xai', authPath, ownerMapPath, 'xai', {
        afterStep: (point) => {
          // Another writer takes the owner-map lock between S4a and S4b.
          if (point === 'S4a' && holdLock) {
            mkdirSync(lock);
            writeFileSync(join(lock, 'qlb-lock-owner.json'), `${JSON.stringify({ pid: process.pid, nonce: 'another-holder' })}\n`);
          }
        },
      });
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      mig.commit();
      assert.equal(JSON.parse(readFileSync(ownerMapPath, 'utf8')).providers.xai.mode, 'qlb', 'the commit wrote a v2 owner entry at the map path');
      writeFileSync(ownerMapPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');
      holdLock = true;

      assert.throws(() => mig.rollback(), (error: Error & { exitCode?: unknown }) => {
        assert.match(error.message, /pi-auth-locked/);
        assert.equal(error.exitCode, 3);
        return true;
      });
      assert.equal(existsSync(ownerMapPath), true, 'the planted v1 map path remains for S4b while the separate owner-map lock is contested');

      holdLock = false;
      rmSync(lock, { recursive: true, force: true });
      mig.resume();
      assert.equal(existsSync(ownerMapPath), false, 'S4b unlinks the planted v1 map path after the lock is released');
      assert.ok(JSON.parse(store.getMigration('pi-xai')!.detail_json).lastRollback);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('single-grant commits take the shared owner-map lock when auth files differ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    try {
      const ownerDir = join(dir, 'owner');
      const xaiDir = join(dir, 'xai');
      const kimiDir = join(dir, 'kimi');
      mkdirSync(ownerDir);
      mkdirSync(xaiDir);
      mkdirSync(kimiDir);
      const ownerMapPath = join(ownerDir, 'qlb-owner.json');
      const xaiAuth = join(xaiDir, 'auth.json');
      const kimiAuth = join(kimiDir, 'auth.json');
      writeFileSync(xaiAuth, fixtureAuthJson(), { encoding: 'utf8', mode: 0o600 });
      writeFileSync(kimiAuth, fixtureAuthJson(), { encoding: 'utf8', mode: 0o600 });
      const xai = createSingleGrantMigration(store, new MockKeychain(), 'xai', xaiAuth, ownerMapPath);
      const kimi = createSingleGrantMigration(store, new MockKeychain(), 'kimi-coding', kimiAuth, ownerMapPath);
      xai.stage();
      await xai.rehearse(mockRehearse([]));
      kimi.stage();
      await kimi.rehearse(mockRehearse([]));
      const lock = join(ownerDir, 'auth.json.lock');
      mkdirSync(lock);
      writeFileSync(join(lock, 'qlb-lock-owner.json'), `${JSON.stringify({ pid: process.pid, nonce: 'another-holder' })}\n`);
      assert.throws(() => xai.commit(), (error: Error & { exitCode?: unknown }) => {
        assert.match(error.message, /pi-auth-locked/);
        assert.equal(error.exitCode, 3);
        return true;
      });
      assert.equal(existsSync(ownerMapPath), false, 'a blocked commit does not publish a partial map entry');
      rmSync(lock, { recursive: true, force: true });
      xai.commit();
      kimi.commit();
      const providers = JSON.parse(readFileSync(ownerMapPath, 'utf8')).providers as Record<string, unknown>;
      assert.ok(providers.xai, 'xai survives the shared-map publication');
      assert.ok(providers['kimi-coding'], 'kimi-coding survives the shared-map publication');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T-S4c crash between map entry removal and sidecar unlink resumes without rewriting auth.json', async () => {
    let crash = true;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S4a' && crash) {
          crash = false;
          throw new Error('fixture crash after S4a');
        }
      },
    });
    try {
      const ownerMapPath = join(h.dir, 'qlb-owner.json');
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      writeFileSync(ownerMapPath, JSON.stringify({
        providers: {
          xai: { mode: 'qlb', since: 123_456 },
          'kimi-coding': { mode: 'qlb', since: 987_654 },
        },
      }, null, 2) + '\n');
      writeFileSync(h.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');

      assert.throws(() => h.mig.rollback(), /fixture crash after S4a/);
      assert.equal(existsSync(h.ownerPath), true, 'the crash leaves the legacy sidecar for S4b');
      const authBeforeResume = readFileSync(h.authPath);
      const authMtimeBeforeResume = statSync(h.authPath).mtimeMs;

      const resumed = h.mig.resume();

      assert.equal(existsSync(h.ownerPath), false, 'resume unlinks the legacy sidecar');
      assert.deepEqual(readFileSync(h.authPath), authBeforeResume, 'resume does not rewrite auth.json');
      assert.equal(statSync(h.authPath).mtimeMs, authMtimeBeforeResume, 'resume preserves auth.json mtime');
      assert.ok(resumed.detail.lastRollback, 'the hand-back completes after the S4a crash');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0c a v2-owned provider on main runs the full hand-back with auth.json byte-identical', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      assert.equal(existsSync(ownerMapPath(h)), true, 'main\'s commit created the v2 owner map entry');

      const rolled = h.mig.rollback();

      assert.deepEqual(readFileSync(h.authPath), h.originalBytes, 'S3 guard (a) restores the native auth bytes');
      assert.equal(existsSync(ownerMapPath(h)), false, 'S4a removes the final v2 owner entry');
      assert.ok(rolled.detail.lastRollback, 'the hand-back records lastRollback');
    } finally {
      h.cleanup();
    }
  });

  it('T-I7 after the hand-back every native-resync is refused until re-stage', async () => {
    const h = setup('xai');
    try {
      const id = expectedId('xai');
      const resync = bindDetectAndResync({
        store: h.store,
        keychain: h.kc,
        readNativeCredential: async () => ({
          ...FAKE_GRANTS.xai,
          access: 'xai-access-native-resync-fixture',
          generation: 0,
        }),
      });
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      h.mig.rollback();

      const refused = await resync(id, 'xai');
      assert.equal(refused.resynced, false, 'W2 refuses native-resync after the hand-back');
      assert.match(refused.reason, /not exclusively QLB-owned/);

      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const admitted = await resync(id, 'xai');
      assert.equal(admitted.resynced, true, 'a re-stage followed by commit re-admits native-resync');
    } finally {
      h.cleanup();
    }
  });

  it('T-S3f a recorded source whose bytes changed under the fence refuses rollback-source-tampered; a native login then completes the hand-back', async () => {
    for (const fixture of [
      { name: 'a Keychain source', kind: 'keychain' as const, tamper: 'bytes' },
      { name: 'an exact backup source', kind: 'exact-backup' as const, tamper: 'bytes' },
      { name: 'a deleted Keychain source', kind: 'keychain' as const, tamper: 'delete' },
      { name: 'a deleted exact backup source', kind: 'exact-backup' as const, tamper: 'delete' },
      { name: 'an exact backup source made unreadable', kind: 'exact-backup' as const, tamper: 'corrupt' },
    ]) {
      const h = setup('xai', new MockKeychain(), {
        afterStep: (point) => {
          if (point === 'S2') throw new Error('fixture crash after S2');
        },
      });
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        const id = expectedId('xai');
        const service = kmCoords('xai').service;
        const account = kmCoords('xai').account;
        const backupPaths = [piAuthBackupPath(h.authPath, 'xai'), legacyPiAuthBackupPath(h.authPath, 'xai')];
        const raw = h.kc.getSync(service, account);
        h.kc.setSync(service, account, JSON.stringify({
          ...JSON.parse(raw),
          generation: fixture.kind === 'keychain' ? 1 : 0,
          writtenBy: fixture.kind === 'keychain' ? 'fixture-refresher' : 'native-resync',
        }));

        assert.throws(() => h.mig.rollback(), /fixture crash after S2/, fixture.name);
        const decision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
        assert.equal(decision.kind, fixture.kind, `${fixture.name}: S2 records the expected source`);
        writeFileSync(h.authPath, JSON.stringify({
          ...FAKE_GRANTS,
          xai: { type: 'oauth', access: 'qlb-managed', refresh: '' },
        }, null, 2) + '\n');
        if (fixture.kind === 'keychain' && fixture.tamper === 'delete') {
          h.kc.deleteSync(service, account);
        } else if (fixture.kind === 'keychain') {
          const raw = h.kc.getSync(service, account);
          h.kc.setSync(service, account, JSON.stringify({ ...JSON.parse(raw), writtenBy: 's3f-tampered' }));
        } else if (fixture.tamper === 'delete') {
          rmSync(piAuthBackupPath(h.authPath, 'xai'), { force: true });
        } else if (fixture.tamper === 'corrupt') {
          writeFileSync(piAuthBackupPath(h.authPath, 'xai'), '{ not json');
        } else {
          const path = piAuthBackupPath(h.authPath, 'xai');
          const backup = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
          writeFileSync(path, JSON.stringify({
            ...backup,
            entry: { ...FAKE_GRANTS.xai, access: 'xai-access-tampered-fake' },
          }, null, 2) + '\n');
        }

        const journalBefore = h.store.getMigration('pi-xai');
        const detailBefore = JSON.parse(journalBefore!.detail_json) as Record<string, unknown>;
        const generationBefore = h.store.getGrantGeneration(id);
        const authBefore = readFileSync(h.authPath);
        const ownerBefore = readFileSync(ownerMapPath(h));
        const backupsBefore = backupPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined);
        const readKeychain = () => { try { return h.kc.getSync(service, account); } catch { return undefined; } };
        const keychainBefore = readKeychain();

        assert.throws(
          () => h.mig.resume(),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, 'rollback-source-tampered', fixture.name);
            assert.equal((error as Error & { exitCode?: number }).exitCode, 3, fixture.name);
            return true;
          },
        );
        const detailAfter = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.equal(detailAfter.intent, 'rollback', `${fixture.name}: intent is unchanged`);
        assert.deepEqual(detailAfter.rollbackDecision, detailBefore.rollbackDecision, `${fixture.name}: decision is unchanged`);
        assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, `${fixture.name}: journal is unchanged`);
        assert.equal(h.store.getGrantGeneration(id), generationBefore, `${fixture.name}: G is unchanged`);
        assert.deepEqual(readFileSync(h.authPath), authBefore, `${fixture.name}: auth.json is unchanged`);
        assert.deepEqual(readFileSync(ownerMapPath(h)), ownerBefore, `${fixture.name}: v2 owner claim is unchanged`);
        assert.deepEqual(backupPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined), backupsBefore, `${fixture.name}: backups are unchanged`);
        assert.equal(readKeychain(), keychainBefore, `${fixture.name}: Keychain fake is unchanged`);

        const nativeLogin = JSON.stringify({
          ...FAKE_GRANTS,
          xai: { ...FAKE_GRANTS.xai, access: 'xai-access-native-fake', refresh: 'xai-refresh-native-fake' },
        }, null, 2) + '\n';
        writeFileSync(h.authPath, nativeLogin);
        h.mig.resume();
        assert.equal(existsSync(ownerMapPath(h)), false, `${fixture.name}: guard (a) releases the v2 owner entry`);
        assert.ok(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).lastRollback, `${fixture.name}: terminal journal records the hand-back`);
        assert.deepEqual(readFileSync(h.authPath), Buffer.from(nativeLogin), `${fixture.name}: native login bytes are retained`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S3e a defined, non-placeholder, invalid native entry refuses native-entry-invalid', async () => {
    for (const fixture of [
      {
        name: 'an object with an empty refresh',
        entry: { ...FAKE_GRANTS.xai, refresh: '' },
      },
      { name: 'a string', entry: 'not-an-auth-entry' },
    ]) {
      const h = setup('xai', new MockKeychain(), {
        afterStep: (point) => {
          if (point === 'S2') throw new Error('fixture crash after S2');
        },
      });
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        assert.throws(() => h.mig.rollback(), /fixture crash after S2/);

        writeFileSync(h.authPath, JSON.stringify({
          ...FAKE_GRANTS,
          xai: fixture.entry,
        }, null, 2) + '\n');
        const id = expectedId('xai');
        const service = kmCoords('xai').service;
        const account = kmCoords('xai').account;
        const journalBefore = h.store.getMigration('pi-xai');
        const generationBefore = h.store.getGrantGeneration(id);
        const authBefore = readFileSync(h.authPath);
        const ownerBefore = readFileSync(ownerMapPath(h));
        const backupPaths = [piAuthBackupPath(h.authPath, 'xai'), legacyPiAuthBackupPath(h.authPath, 'xai')];
        const backupsBefore = backupPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined);
        const keychainBefore = h.kc.getSync(service, account);

        assert.throws(
          () => h.mig.resume(),
          (error: unknown) => {
            const refusal = error as { message?: unknown; exitCode?: unknown };
            assert.equal(refusal.message, 'native-entry-invalid', fixture.name);
            assert.equal(refusal.exitCode, 3, fixture.name);
            return true;
          },
        );

        const detailAfter = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.equal(detailAfter.intent, 'rollback', `${fixture.name}: intent is unchanged`);
        assert.ok(detailAfter.rollbackDecision, `${fixture.name}: decision is retained`);
        assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, `${fixture.name}: journal state is unchanged`);
        assert.equal(h.store.getGrantGeneration(id), generationBefore, `${fixture.name}: G is unchanged`);
        assert.deepEqual(readFileSync(h.authPath), authBefore, `${fixture.name}: auth.json is unchanged`);
        assert.deepEqual(readFileSync(ownerMapPath(h)), ownerBefore, `${fixture.name}: v2 owner claim is unchanged`);
        assert.deepEqual(
          backupPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined),
          backupsBefore,
          `${fixture.name}: backups are unchanged`,
        );
        assert.equal(h.kc.getSync(service, account), keychainBefore, `${fixture.name}: Keychain fake is unchanged`);

        const nativeLogin = JSON.stringify({ ...FAKE_GRANTS }, null, 2) + '\n';
        writeFileSync(h.authPath, nativeLogin);
        const resumed = h.mig.resume();
        assert.equal(resumed.state, 'NATIVE', `${fixture.name}: native login lets the hand-back complete`);
        assert.deepEqual(readFileSync(h.authPath), Buffer.from(nativeLogin), `${fixture.name}: guard (a) keeps the native login`);
        assert.equal(existsSync(ownerMapPath(h)), false, `${fixture.name}: completed hand-back releases the v2 owner claim`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S3g kind:none with the native entry gone refuses native-entry-missing', async () => {
    for (const fixture of [
      {
        name: 'the key absent',
        auth: { 'kimi-coding': FAKE_GRANTS['kimi-coding'] },
      },
      {
        name: 'the placeholder',
        auth: {
          ...FAKE_GRANTS,
          xai: { type: 'oauth', access: 'qlb-managed', refresh: '' },
        },
      },
      {
        name: 'the key absent under a decision recorded by an earlier build (entryPresent:false)',
        auth: { 'kimi-coding': FAKE_GRANTS['kimi-coding'] },
        legacyDecision: true,
      },
    ]) {
      const h = setup('xai', new MockKeychain(), {
        afterStep: (point) => {
          if (point === 'S2') throw new Error('fixture crash after S2');
        },
      });
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        const id = expectedId('xai');
        const service = kmCoords('xai').service;
        const account = kmCoords('xai').account;
        h.kc.deleteSync(service, account);
        rmSync(piAuthBackupPath(h.authPath, 'xai'), { force: true });
        writeFileSync(h.authPath, JSON.stringify({ ...FAKE_GRANTS }, null, 2) + '\n');
        assert.throws(() => h.mig.rollback(), /fixture crash after S2/);

        const detailBefore = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        let decisionBefore = detailBefore.rollbackDecision as RollbackDecision;
        assert.equal(decisionBefore.kind, 'none', `${fixture.name}: S2 records kind:none`);
        assert.equal(decisionBefore.entryPresent, true, `${fixture.name}: S2 records the native entry was present`);
        if ('legacyDecision' in fixture) {
          // Earlier builds always recorded entryPresent:false for kind:none.
          decisionBefore = { ...decisionBefore, entryPresent: false };
          const migration = h.store.getMigration('pi-xai')!;
          h.store.upsertMigration('pi-xai', migration.state,
            JSON.stringify({ ...detailBefore, rollbackDecision: decisionBefore }), migration.updated_at);
        }
        writeFileSync(h.authPath, JSON.stringify(fixture.auth, null, 2) + '\n');
        const journalBefore = h.store.getMigration('pi-xai');
        const generationBefore = h.store.getGrantGeneration(id);
        const authBefore = readFileSync(h.authPath);
        const ownerBefore = readFileSync(ownerMapPath(h));
        const backupPaths = [piAuthBackupPath(h.authPath, 'xai'), legacyPiAuthBackupPath(h.authPath, 'xai')];
        const backupsBefore = backupPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined);
        assert.equal(keychainHas(h.kc, 'xai'), false, `${fixture.name}: fixture has no Keychain source`);

        assert.throws(
          () => h.mig.resume(),
          (error: unknown) => {
            const refusal = error as { message?: unknown; exitCode?: unknown };
            assert.equal(refusal.message, 'native-entry-missing', fixture.name);
            assert.equal(refusal.exitCode, 3, fixture.name);
            return true;
          },
        );

        const detailAfter = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.equal(detailAfter.intent, 'rollback', `${fixture.name}: intent is unchanged`);
        assert.deepEqual(detailAfter.rollbackDecision, decisionBefore, `${fixture.name}: decision is unchanged`);
        assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, `${fixture.name}: journal state is unchanged`);
        assert.equal(h.store.getGrantGeneration(id), generationBefore, `${fixture.name}: G is unchanged`);
        assert.deepEqual(readFileSync(h.authPath), authBefore, `${fixture.name}: auth.json is unchanged`);
        assert.deepEqual(readFileSync(ownerMapPath(h)), ownerBefore, `${fixture.name}: v2 owner claim is unchanged`);
        assert.deepEqual(
          backupPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined),
          backupsBefore,
          `${fixture.name}: backups are unchanged`,
        );
        assert.equal(keychainHas(h.kc, 'xai'), false, `${fixture.name}: Keychain fake is unchanged`);

        const nativeLogin = JSON.stringify({ ...FAKE_GRANTS }, null, 2) + '\n';
        writeFileSync(h.authPath, nativeLogin);
        const resumed = h.mig.resume();
        assert.equal(resumed.state, 'NATIVE', `${fixture.name}: native login lets the hand-back complete`);
        assert.deepEqual(readFileSync(h.authPath), Buffer.from(nativeLogin), `${fixture.name}: guard (a) keeps the native login`);
        assert.equal(existsSync(ownerMapPath(h)), false, `${fixture.name}: completed hand-back releases the v2 owner claim`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-P2 Pi rotation of the restored entry before the retry is kept', async () => {
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2') throw new Error('fixture crash after S2');
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      const piRotation = JSON.stringify({
        ...FAKE_GRANTS,
        xai: { ...FAKE_GRANTS.xai, access: 'xai-access-rotated-fake', refresh: 'xai-refresh-rotated-fake' },
      }, null, 2) + '\n';
      writeFileSync(h.authPath, piRotation);

      const resumed = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, h.ownerPath).resume();

      assert.equal(resumed.state, 'NATIVE', 'the retry completes the hand-back');
      assert.deepEqual(readFileSync(h.authPath), Buffer.from(piRotation), 'S3 keeps Pi\'s rotated entry');
    } finally {
      h.cleanup();
    }
  });

  it('T-P4b a Pi process holding the auth lock at S3 makes rollback refuse pi-auth-locked and resume completes after release', async () => {
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2') throw new Error('fixture crash after S2');
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);

      const id = expectedId('xai');
      const service = kmCoords('xai').service;
      const account = kmCoords('xai').account;
      const journalBefore = h.store.getMigration('pi-xai');
      const detailBefore = JSON.parse(journalBefore!.detail_json) as Record<string, unknown>;
      const generationBefore = h.store.getGrantGeneration(id);
      const authBefore = readFileSync(h.authPath);
      const ownerBefore = readFileSync(ownerMapPath(h));
      const keychainBefore = h.kc.getSync(service, account);
      const backupPaths = [piAuthBackupPath(h.authPath, 'xai'), legacyPiAuthBackupPath(h.authPath, 'xai')];
      const backupsBefore = backupPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined);

      // Match a live Pi lock: fresh directory mtime plus a valid, live owner.
      const lock = `${resolve(h.authPath)}.lock`;
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, 'qlb-lock-owner.json'), `${JSON.stringify({ pid: process.pid, nonce: 'fixture-live-pi-owner' })}\n`, { mode: 0o600 });
      const refreshPiLock = () => utimesSync(lock, new Date(), new Date());
      refreshPiLock();
      const retry = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, h.ownerPath, 'xai', {
        authLockTiming: { retries: 0, retryMs: 1 },
      });

      refreshPiLock();
      assert.throws(
        () => retry.rollback(),
        (error: unknown) => {
          const refusal = error as { message?: unknown; exitCode?: unknown; code?: unknown };
          assert.equal(refusal.message, 'pi-auth-locked');
          assert.equal(refusal.code, 'pi-auth-locked', 'the established error code is kept');
          assert.equal(refusal.exitCode, 3);
          return true;
        },
      );

      const detailAfter = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      assert.equal(detailBefore.intent, 'rollback', 'the refusal starts from a recorded S1 intent');
      assert.ok(detailBefore.rollbackDecision && typeof detailBefore.rollbackDecision === 'object', 'the refusal starts from a recorded S2 decision');
      assert.equal(detailAfter.intent, detailBefore.intent, 'S1 intent is unchanged');
      assert.deepEqual(detailAfter.rollbackDecision, detailBefore.rollbackDecision, 'S2 decision is unchanged');
      assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, 'journal state is unchanged');
      assert.equal(h.store.getGrantGeneration(id), generationBefore, 'G is unchanged');
      assert.deepEqual(readFileSync(h.authPath), authBefore, 'auth.json is unchanged');
      assert.deepEqual(readFileSync(ownerMapPath(h)), ownerBefore, 'v2 owner claim is unchanged');
      assert.deepEqual(backupPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined), backupsBefore, 'backups are unchanged');
      assert.equal(h.kc.getSync(service, account), keychainBefore, 'Keychain fake is unchanged');

      rmSync(lock, { recursive: true, force: true });
      const resumed = retry.resume();
      assert.equal(resumed.state, 'NATIVE', 'resume completes the hand-back after Pi releases the lock');
    } finally {
      h.cleanup();
    }
  });

  it('T-P3 a native re-login over a placeholder is kept by rollback', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      writeFileSync(h.authPath, JSON.stringify({
        ...FAKE_GRANTS,
        xai: { type: 'oauth', access: 'qlb-managed', refresh: '' },
      }, null, 2) + '\n');
      const nativeLogin = JSON.stringify({
        ...FAKE_GRANTS,
        xai: { ...FAKE_GRANTS.xai, access: 'xai-access-relogin-fake', refresh: 'xai-refresh-relogin-fake' },
      }, null, 2) + '\n';
      writeFileSync(h.authPath, nativeLogin);

      const rolled = h.mig.rollback();

      assert.equal(rolled.state, 'NATIVE', 'the hand-back completes');
      assert.deepEqual(readFileSync(h.authPath), Buffer.from(nativeLogin), 'S3 keeps the native re-login');
    } finally {
      h.cleanup();
    }
  });

  it('after a native Pi login, resume completes the hand-back without a QLB source', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const id = expectedId('xai');
      const service = kmCoords('xai').service;
      const account = kmCoords('xai').account;
      h.kc.deleteSync(service, account);
      rmSync(piAuthBackupPath(h.authPath, 'xai'), { force: true });
      writeFileSync(h.authPath, JSON.stringify({ 'kimi-coding': FAKE_GRANTS['kimi-coding'] }, null, 2) + '\n');

      assert.throws(() => h.mig.rollback(), /no-restore-source/);
      const nativeLogin = JSON.stringify({ xai: FAKE_GRANTS.xai, 'kimi-coding': FAKE_GRANTS['kimi-coding'] }, null, 2) + '\n';
      writeFileSync(h.authPath, nativeLogin);

      const resumed = h.mig.resume();
      assert.equal(resumed.state, 'NATIVE');
      assert.equal((resumed.detail.lastRollback as { decision: RollbackDecision }).decision.kind, 'none');
      assert.deepEqual(readFileSync(h.authPath), Buffer.from(nativeLogin), 'resume keeps the native Pi login');
      assert.throws(() => h.kc.getSync(service, account), 'the completed hand-back has no QLB source');
    } finally {
      h.cleanup();
    }
  });

  it('T-I1 a refresh that commits before S2 is ranked first', async () => {
    let decision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S1') {
          const id = expectedId('xai');
          const service = kmCoords('xai').service;
          const raw = h.kc.getSync(service, kmCoords('xai').account);
          h.kc.setSync(service, kmCoords('xai').account, JSON.stringify({
            ...JSON.parse(raw), generation: 1, refresh: 'xai-refresh-refreshed-fake',
          }));
          assert.equal(h.store.casGrantGeneration(id, 0, 1), 1, 'fake refresher commits before S2 reads');
        }
        if (point === 'S2') {
          decision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
          throw new Error('fixture crash after S2');
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(decision?.kind, 'keychain');
      assert.equal(decision?.generation, 1);
      assert.equal(decision?.fencedGeneration, 2);
    } finally {
      h.cleanup();
    }
  });

  it('T-RR resume with a recorded decision never re-ranks', async () => {
    let reads = 0;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2-reads') reads += 1;
        if (point === 'S2') throw new Error('fixture crash after S2');
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      const decision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
      const service = kmCoords('xai').service;
      const raw = h.kc.getSync(service, kmCoords('xai').account);
      h.kc.setSync(service, kmCoords('xai').account, JSON.stringify({ ...JSON.parse(raw), generation: 99 }));

      const resumed = h.mig.resume();
      assert.equal(reads, 1, 'resume uses the durable decision instead of taking S2 reads');
      assert.deepEqual((resumed.detail.lastRollback as { decision: RollbackDecision }).decision, decision);
    } finally {
      h.cleanup();
    }
  });

  it('the owner claim is unlinked durably before S5 records the hand-back', async () => {
    const synced: string[] = [];
    const h = setup('xai', new MockKeychain(), { fsyncDirectory: (path) => { synced.push(path); } });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      let syncedBeforeMarker = false;
      const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
      h.store.upsertMigration = (store, state, detail) => {
        if (JSON.parse(detail ?? '{}').handback) syncedBeforeMarker ||= synced.includes(dirname(h.ownerPath));
        return originalUpsertMigration(store, state, detail);
      };

      h.mig.rollback();
      assert.equal(syncedBeforeMarker, true, 'the owner directory is fsynced before the S5 write');
    } finally {
      h.cleanup();
    }
  });

  it('a bad journal account refuses the hand-back with the owner claim intact', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const row = h.store.getMigration('pi-xai')!;
      const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
      h.store.upsertMigration('pi-xai', row.state, JSON.stringify({ ...detail, accounts: [] }));

      assert.throws(() => h.mig.rollback(), /no valid journal account coordinates/);
      assert.equal(existsSync(ownerMapPath(h)), true, 'the v2 claim is not dropped before validation');
    } finally {
      h.cleanup();
    }
  });

  it('hand-back S5 refuses a generic journal with more than one account', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const row = h.store.getMigration('pi-xai')!;
      const detail = JSON.parse(row.detail_json) as { accounts: Array<Record<string, unknown>> };
      detail.accounts.push({ ...detail.accounts[0]! });
      h.store.upsertMigration('pi-xai', row.state, JSON.stringify(detail));
      const { service, account } = kmCoords('xai');
      const keychainBefore = h.kc.getSync(service, account);
      const setSync = h.kc.setSync.bind(h.kc);
      const deleteSync = h.kc.deleteSync.bind(h.kc);
      const writes: string[] = [];
      const deletes: string[] = [];
      h.kc.setSync = (itemService, itemAccount, value) => {
        writes.push(`${itemService}/${itemAccount}`);
        return setSync(itemService, itemAccount, value);
      };
      h.kc.deleteSync = (itemService, itemAccount) => {
        deletes.push(`${itemService}/${itemAccount}`);
        return deleteSync(itemService, itemAccount);
      };

      assert.throws(() => h.mig.rollback(), /single-grant hand-back has no valid journal account coordinates/);
      assert.deepEqual(writes, []);
      assert.deepEqual(deletes, []);
      assert.equal(h.kc.getSync(service, account), keychainBefore);
      assert.equal(existsSync(ownerMapPath(h)), true, 'the v2 claim is not dropped before validation');
    } finally { h.cleanup(); }
  });

  it('T-S5s status reports cleanup-pending, shows a null fence as not fenced, and writes nothing', () => {
    const h = setup('xai');
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'keep',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const service = kmCoords('xai').service;
      const account = kmCoords('xai').account;
      h.kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));
      const rowBefore = h.store.getMigration('pi-xai');
      const filesBefore = fileSnapshot(h.dir);
      const keychainBefore = h.kc.getSync(service, account);

      const status = h.mig.status();

      assert.equal(status.resumeAction, 'hand-back complete, cleanup pending — run `qlb migrate resume`');
      assert.deepEqual(status.detail.handback, marker, 'status keeps the durable marker fields intact');
      assert.deepEqual(status.handback, {
        ...marker,
        decision: 'not fenced',
        fencedGeneration: 'not fenced',
      });
      assert.deepEqual(h.store.getMigration('pi-xai'), rowBefore, 'status does not write the journal');
      assert.deepEqual(fileSnapshot(h.dir), filesBefore, 'status does not write files');
      assert.equal(h.kc.getSync(service, account), keychainBefore, 'status does not write Keychain');
    } finally {
      h.cleanup();
    }
  });

  it('T-S7 resume with a cleanup-pending marker clears it into lastRollback, and a second resume is a no-op', () => {
    const h = setup('xai');
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'keep',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const service = kmCoords('xai').service;
      const account = kmCoords('xai').account;
      h.kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        handback: marker,
        intent: 'rollback',
        rollbackDecision: ROLLBACK_DECISION,
      }));

      const resumed = h.mig.resume();
      const detail = resumed.detail;
      assert.equal(resumed.state, 'NATIVE');
      assert.equal(detail.handback, undefined, 'S7 clears the cleanup-pending marker');
      assert.equal(detail.intent, undefined, 'S7 clears leftover rollback intent');
      assert.equal(detail.rollbackDecision, undefined, 'S7 clears leftover rollback decision');
      assert.deepEqual(
        detail.lastRollback,
        { ...marker, rolledBackFrom: 'post-commit', cleanedAt: (detail.lastRollback as { cleanedAt: unknown }).cleanedAt },
        'S7 preserves the complete marker as the rollback record',
      );
      assert.equal(typeof (detail.lastRollback as { cleanedAt: unknown }).cleanedAt, 'number');
      const journalAfterFirstResume = h.store.getMigration('pi-xai');
      const keychainAfterFirstResume = h.kc.getSync(service, account);

      const repeated = h.mig.resume();
      assert.deepEqual(repeated.detail, detail, 'a terminal second resume is a no-op');
      assert.deepEqual(h.store.getMigration('pi-xai'), journalAfterFirstResume, 'the second resume does not rewrite the journal');
      assert.equal(h.kc.getSync(service, account), keychainAfterFirstResume, 'the second resume keeps K_m');
    } finally {
      h.cleanup();
    }
  });

  it('T-S6a backups are removed only under the cleanup-pending marker', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const h = setup('xai');
    try {
      const exact = piAuthBackupPath(h.authPath, 'xai');
      const legacy = `${h.authPath}.qlb-xai.baseline.json`;
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      writeFileSync(legacy, JSON.stringify({ filePresent: true, entryPresent: true, entry: FAKE_GRANTS.xai }) + '\n');

      h.mig.resume();
      assert.equal(existsSync(exact), true, 'an at-rest resume does not remove the exact backup');
      assert.equal(existsSync(legacy), true, 'an at-rest resume does not remove the legacy backup');

      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));
      h.mig.resume();
      assert.equal(existsSync(exact), false, 'S6a removes the exact backup under the marker');
      assert.equal(existsSync(legacy), false, 'S6a removes the legacy backup under the marker');

      mkdirSync(exact, { recursive: true });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));
      assert.throws(() => h.mig.resume(), /EISDIR|directory/i, 'an S6a failure surfaces before S7');
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback,
        marker,
        'a failed S6a keeps the marker for retry',
      );

      rmSync(exact, { recursive: true, force: true });
      const settled = h.mig.resume();
      assert.equal(settled.detail.handback, undefined, 'the next resume retries S6a then clears S7');
    } finally {
      h.cleanup();
    }
  });

  it('a recorded delete removes the Keychain copy and a recorded keep, or any other value, leaves it untouched', () => {
    for (const fixture of [
      { disposition: 'delete', itemPresent: true, shouldRemain: false },
      { disposition: 'delete', itemPresent: false, shouldRemain: false },
      { disposition: 'keep', itemPresent: true, shouldRemain: true },
      { disposition: 'unknown', itemPresent: true, shouldRemain: true },
    ]) {
      const h = setup('xai');
      try {
        const marker = {
          phase: 'cleanup-pending',
          keychainDisposition: fixture.disposition,
          piFingerprint: null,
          decision: null,
          fencedGeneration: null,
          rolledBackAt: 123,
        };
        const service = kmCoords('xai').service;
        const account = kmCoords('xai').account;
        if (fixture.itemPresent) {
          h.kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
        }
        h.store.upsertAccount(expectedId('xai'), 'xai', expectedLabel('xai'), 'active');
        h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
          accounts: [{
            id: expectedId('xai'),
            provider: 'xai',
            label: expectedLabel('xai'),
            fingerprint: 'fixture-fingerprint',
            keychain: sharedSingleGrantCoords('xai'),
          }],
          handback: marker,
        }));

        const resumed = h.mig.resume();

        assert.equal(
          keychainHas(h.kc, 'xai'),
          fixture.shouldRemain,
          `${fixture.disposition} applies only the recorded disposition to J.accounts[0]`,
        );
        assert.equal(resumed.detail.handback, undefined, `${fixture.disposition} completes S7`);
        assert.equal(
          h.store.getAccount(expectedId('xai'))?.status,
          fixture.disposition === 'delete' ? 'handed-back' : 'active',
          `${fixture.disposition} writes account status only for the recorded delete verdict`,
        );
      } finally {
        h.cleanup();
      }
    }
  });

  it('crash between the Keychain delete and the status write resumes to the same disposition', () => {
    const h = setup('xai');
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'delete',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const id = expectedId('xai');
      const service = kmCoords('xai').service;
      const account = kmCoords('xai').account;
      h.kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      h.store.upsertAccount(id, 'xai', account, 'active');
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        accounts: [{ id, provider: 'xai', label: account, fingerprint: 'fixture-fingerprint', keychain: sharedSingleGrantCoords('xai') }],
        handback: marker,
      }));
      const crashing = createSingleGrantMigration(
        h.store,
        h.kc,
        'xai',
        h.authPath,
        h.ownerPath,
        'xai',
        { afterStep: (point) => { if (point === 'S6c1') throw new Error('fixture crash after S6c1'); } },
      );

      assert.throws(() => crashing.resume(), /fixture crash after S6c1/);
      assert.equal(keychainHas(h.kc, 'xai'), false, 'S6c1 deleted K_m before the crash');
      assert.equal(h.store.getAccount(id)?.status, 'active', 'S6c2 has not written the status');
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback,
        marker,
        'the marker remains set for retry',
      );

      const resumed = h.mig.resume();
      assert.equal(h.store.getAccount(id)?.status, 'handed-back', 'S6c2 writes on the recorded delete verdict');
      assert.equal(resumed.detail.handback, undefined, 'S7 clears the marker after S6c2');
      assert.equal(
        (resumed.detail.lastRollback as { keychainDisposition: unknown }).keychainDisposition,
        'delete',
        'the recorded disposition is retained through recovery',
      );
    } finally {
      h.cleanup();
    }
  });

  it('a Keychain delete error during S6c1 leaves the cleanup-pending marker', () => {
    const kc = new RollbackDeleteKeychain();
    const h = setup('xai', kc);
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'delete',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const service = kmCoords('xai').service;
      const account = kmCoords('xai').account;
      kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        accounts: [{
          id: expectedId('xai'),
          provider: 'xai',
          label: expectedLabel('xai'),
          fingerprint: 'fixture-fingerprint',
        }],
        handback: marker,
      }));
      kc.mode = 'denied';

      assert.throws(() => h.mig.resume(), /fixture Keychain access denied/);
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback,
        marker,
        'S6c1 errors before S7 clears the marker',
      );
      assert.equal(keychainHas(kc, 'xai'), true, 'failed delete retains the Keychain item');
    } finally {
      h.cleanup();
    }
  });

  it('hand-back S6c1 refuses a generic journal with more than one account', () => {
    const h = setup('xai');
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'delete',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const { service, account } = kmCoords('xai');
      h.kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        accounts: [
          { id: expectedId('xai'), provider: 'xai', label: expectedLabel('xai'), fingerprint: 'fixture-fingerprint' },
          { id: expectedId('xai'), provider: 'xai', label: expectedLabel('xai'), fingerprint: 'fixture-fingerprint' },
        ],
        handback: marker,
      }));
      const setSync = h.kc.setSync.bind(h.kc);
      const deleteSync = h.kc.deleteSync.bind(h.kc);
      const writes: string[] = [];
      const deletes: string[] = [];
      h.kc.setSync = (itemService, itemAccount, value) => {
        writes.push(`${itemService}/${itemAccount}`);
        return setSync(itemService, itemAccount, value);
      };
      h.kc.deleteSync = (itemService, itemAccount) => {
        deletes.push(`${itemService}/${itemAccount}`);
        return deleteSync(itemService, itemAccount);
      };

      assert.throws(() => h.mig.resume(), /cleanup-pending hand-back has no valid journal account coordinates/);
      assert.deepEqual(writes, []);
      assert.deepEqual(deletes, []);
      assert.equal(keychainHas(h.kc, 'xai'), true);
      assert.deepEqual(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback, marker);
    } finally { h.cleanup(); }
  });

  it('S6c1 refuses a journal account from another provider and leaves the marker and both Keychain items', () => {
    const kc = new MockKeychain();
    const h = setup('xai', kc);
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'delete',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const ownService = kmCoords('xai').service;
      kc.setSync(ownService, kmCoords('xai').account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      const otherService = kmCoords('kimi-coding').service;
      kc.setSync(otherService, kmCoords('kimi-coding').account, JSON.stringify({ ...FAKE_GRANTS['kimi-coding'], generation: 0 }));
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        accounts: [{
          id: expectedId('kimi-coding'),
          provider: 'kimi-coding',
          label: expectedLabel('kimi-coding'),
          fingerprint: 'fixture-fingerprint',
        }],
        handback: marker,
      }));

      assert.throws(() => h.mig.resume(), /journal names kimi-coding, not xai/);
      assert.deepEqual(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback, marker);
      assert.equal(keychainHas(kc, 'xai'), true, 'own item untouched');
      assert.equal(keychainHas(kc, 'kimi-coding'), true, 'other provider item untouched');
    } finally {
      h.cleanup();
    }
  });

  it('T-S6a backup removal is made durable before the marker is cleared', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const calls: string[] = [];
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: (path) => {
        calls.push(path);
        assert.equal(existsSync(piAuthBackupPath(h.authPath, 'xai')), false, 'S6a removes the exact backup before its directory sync');
        assert.equal(existsSync(legacyPiAuthBackupPath(h.authPath, 'xai')), false, 'S6a removes the legacy backup before its directory sync');
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.deepEqual(detail.handback, marker, 'S6a directory sync runs before S7 clears the durable marker');
      },
    });
    try {
      const exact = piAuthBackupPath(h.authPath, 'xai');
      const legacy = legacyPiAuthBackupPath(h.authPath, 'xai');
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      writeFileSync(legacy, JSON.stringify({ filePresent: true, entryPresent: true, entry: FAKE_GRANTS.xai }) + '\n');
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      const settled = h.mig.resume();

      assert.deepEqual(
        calls,
        [dirname(exact), dirname(legacy), dirname(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'))],
        'S6a syncs both backup parents before S6b re-syncs the staging directory',
      );
      assert.equal(settled.detail.handback, undefined, 'S7 clears the marker after durable S6a cleanup');
    } finally {
      h.cleanup();
    }
  });

  it('T-S6a a failed backup-directory sync leaves the marker for the next resume', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    let failSync = true;
    const retrySyncCalls: string[] = [];
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: (path) => {
        if (failSync && path === dirname(piAuthBackupPath(h.authPath, 'xai'))) {
          throw new Error('injected backup directory sync failure');
        }
        if (!failSync) {
          retrySyncCalls.push(path);
          const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
          assert.deepEqual(detail.handback, marker, 'retry sync runs before S7 clears the durable marker');
        }
      },
    });
    try {
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      assert.throws(() => h.mig.resume(), /injected backup directory sync failure/);
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback,
        marker,
        'a failed S6a directory sync keeps the marker for retry',
      );

      failSync = false;
      const settled = h.mig.resume();
      const exactBackupDirectory = dirname(piAuthBackupPath(h.authPath, 'xai'));
      const legacyBackupDirectory = dirname(legacyPiAuthBackupPath(h.authPath, 'xai'));
      assert.ok(retrySyncCalls.includes(exactBackupDirectory), 'a retry re-syncs the exact backup parent');
      if (existsSync(legacyBackupDirectory)) {
        assert.ok(retrySyncCalls.includes(legacyBackupDirectory), 'a retry syncs the legacy backup parent when it exists');
      }
      assert.equal(settled.detail.handback, undefined, 'a working retry completes S6a before S7');
    } finally {
      h.cleanup();
    }
  });

  it('T-S6a a crash between unlink and sync still syncs on the next resume', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const calls: string[] = [];
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: (path) => {
        calls.push(path);
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.deepEqual(detail.handback, marker, 'backup-parent sync runs before S7 clears the durable marker');
      },
    });
    try {
      const exact = piAuthBackupPath(h.authPath, 'xai');
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      rmSync(exact, { force: true });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      const settled = h.mig.resume();

      assert.ok(calls.includes(dirname(exact)), 'resume syncs the exact backup parent after an unlink-before-sync crash');
      assert.equal(settled.detail.handback, undefined, 'S7 clears the marker after the retry sync');
    } finally {
      h.cleanup();
    }
  });

  it('the staging-directory sync runs after the staging unlink even when the legacy backup parent is the same directory', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const events: string[] = [];
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: (path) => {
        const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
        if (path === dirname(staging)) {
          const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
          assert.deepEqual(detail.handback, marker, 'each directory sync runs before S7 clears the durable marker');
          events.push(existsSync(staging) ? 'sync-before-staging-unlink' : 'sync-after-staging-unlink');
        }
      },
    });
    try {
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      writeFileSync(legacyPiAuthBackupPath(h.authPath, 'xai'), JSON.stringify({ filePresent: true }) + '\n');
      writeFileSync(staging, JSON.stringify({ fixture: 'staging' }), { mode: 0o600 });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      const settled = h.mig.resume();

      assert.deepEqual(
        events,
        ['sync-before-staging-unlink', 'sync-after-staging-unlink'],
        'the same staging directory is synced again after S6b unlinks staging',
      );
      assert.equal(settled.detail.handback, undefined, 'S7 clears the marker only after the post-unlink sync');
    } finally {
      h.cleanup();
    }
  });

  it('a non-ENOENT stat error on a sync directory propagates and leaves the marker', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const h = setupOpenRouter();
    const staging = stagingOwnerPath(h.ownerPath, 'openrouter');
    const originalStatSync = fs.statSync;
    const statMock = mock.method(fs, 'statSync', ((path: string | Buffer | URL) => {
      if (path === dirname(staging)) {
        throw Object.assign(new Error('injected sync-directory stat failure'), { code: 'EACCES' });
      }
      return originalStatSync(path);
    }) as typeof fs.statSync);
    try {
      h.store.upsertMigration('pi-openrouter', 'NATIVE', JSON.stringify({ handback: marker }));

      assert.throws(
        () => h.mig.resume(),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES',
        'only ENOENT may be skipped before the S7 marker write',
      );
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-openrouter')!.detail_json).handback,
        marker,
        'a non-ENOENT stat failure leaves the durable marker for retry',
      );
    } finally {
      statMock.mock.restore();
      h.cleanup();
    }
  });

  it('T-S6b staging unlink is made durable before the marker is cleared', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const calls: string[] = [];
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: (path) => {
        calls.push(path);
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.deepEqual(detail.handback, marker, 'S6b sync runs before S7 clears the durable marker');
      },
    });
    try {
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      writeFileSync(staging, JSON.stringify({ fixture: 'staging' }), { mode: 0o600 });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      const settled = h.mig.resume();

      assert.deepEqual(calls, [dirname(staging), dirname(staging)], 'S6b re-syncs the staging directory after its unlink');
      assert.equal(settled.state, 'NATIVE');
      assert.equal(existsSync(staging), false, 'S6b removes the staging file under the marker');
      assert.equal(existsSync(h.ownerPath), false, 'C3 cleanup does not commit the staging file');
      assert.equal(settled.detail.handback, undefined, 'S7 clears the marker after durable hygiene');
    } finally {
      h.cleanup();
    }
  });

  it('T-S6b a failed directory sync leaves the marker for the next resume', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    let failSync = true;
    let syncCalls = 0;
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: () => {
        syncCalls += 1;
        if (failSync) throw new Error('injected directory sync failure');
      },
    });
    try {
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      writeFileSync(staging, JSON.stringify({ fixture: 'staging' }), { mode: 0o600 });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      assert.throws(() => h.mig.resume(), /injected directory sync failure/);
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback,
        marker,
        'a failed S6b sync leaves the durable marker for retry',
      );

      failSync = false;
      const settled = h.mig.resume();
      assert.equal(syncCalls, 3, 'the next resume retries S6a and then syncs S6b after its unlink');
      assert.equal(settled.detail.handback, undefined, 'the working retry clears S7');
    } finally {
      h.cleanup();
    }
  });

  it('decision-only resume settles: second resume is a no-op and stage works again', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const row = h.store.getMigration('pi-xai')!;
      h.store.upsertMigration('pi-xai', row.state, JSON.stringify({
        ...JSON.parse(row.detail_json),
        rollbackDecision: currentExactBackupDecision(h),
      }));

      const resumed = h.mig.resume();
      assert.equal(resumed.detail.rollbackDecision, undefined, 'terminal rollback clears the decision');
      const rolledBackAt = resumed.detail.rolledBackAt;
      const journalAfterFirstResume = h.store.getMigration('pi-xai');

      const repeated = h.mig.resume();
      assert.equal(repeated.detail.rolledBackAt, rolledBackAt, 'second resume does not rewrite rolledBackAt');
      assert.deepEqual(h.store.getMigration('pi-xai'), journalAfterFirstResume, 'second resume does not rewrite the journal');
      assert.doesNotThrow(() => h.mig.stage(), 'stage is no longer refused by the settled journal');
    } finally {
      h.cleanup();
    }
  });

  it('T-E2 rollback with a marker set routes exactly as resume', async () => {
    const handback = {
      phase: 'cleanup-pending' as const,
      keychainDisposition: 'keep' as const,
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };

    // C3 takes precedence over C4, clears the cleanup marker, and makes the
    // terminal rollback repeat-safe just as resume does.
    {
      const h = setup('xai');
      try {
        h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
          handback,
          intent: 'rollback',
          rollbackDecision: ROLLBACK_DECISION,
        }));

        assert.doesNotThrow(() => h.mig.rollback(), 'cleanup-pending rollback must not demand resume');
        const afterFirst = h.store.getMigration('pi-xai');
        assert.equal(JSON.parse(afterFirst!.detail_json).handback, undefined, 'C3 clears the hand-back marker');
        assert.equal(JSON.parse(afterFirst!.detail_json).rollbackDecision, undefined, 'C3 clears the recorded decision');
        assert.ok(JSON.parse(afterFirst!.detail_json).lastRollback, 'C3 records the completed hand-back');

        assert.doesNotThrow(() => h.mig.rollback(), 'a second terminal rollback is a no-op, never a resume refusal');
        assert.deepEqual(h.store.getMigration('pi-xai'), afterFirst, 'a second rollback does not rewrite the terminal journal');
      } finally {
        h.cleanup();
      }
    }

    // A crash inside continueRollback can leave intent without a decision.
    // C4 must settle it directly rather than refusing with the resume hint.
    {
      const h = setup('xai');
      try {
        h.mig.stage();
        const staged = h.store.getMigration('pi-xai')!;
        h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({
          ...JSON.parse(staged.detail_json),
          intent: 'rollback',
        }));

        assert.doesNotThrow(() => h.mig.rollback(), 'intent-only C4 rollback must not demand resume');
        const afterFirst = h.store.getMigration('pi-xai');
        assert.equal(afterFirst?.state, 'NATIVE', 'intent-only C4 ends through S5/S7 at the OD-7 terminal state');
        assert.equal(JSON.parse(afterFirst!.detail_json).intent, undefined, 'intent-only C4 clears intent');

        assert.doesNotThrow(() => h.mig.rollback(), 'a settled intent-only C4 fixture is never refused with the resume hint');
        assert.deepEqual(h.store.getMigration('pi-xai'), afterFirst, 'a second intent-only C4 rollback is a no-op');
      } finally {
        h.cleanup();
      }
    }

    // C4 must continue the existing rollback directly, without re-journaling
    // intent through postCommitRollback. Use the complete eight-field decision
    // shape required for a committed QLB_OWNED fixture.
    {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        const row = h.store.getMigration('pi-xai')!;
        h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({
          ...JSON.parse(row.detail_json),
          rollbackDecision: currentExactBackupDecision(h),
        }));

        const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
        const writes: Array<{ state: string; detail: Record<string, unknown> }> = [];
        h.store.upsertMigration = (store, state, detail) => {
          if (store === 'pi-xai') writes.push({ state, detail: JSON.parse(detail ?? '{}') as Record<string, unknown> });
          return originalUpsertMigration(store, state, detail);
        };

        assert.doesNotThrow(() => h.mig.rollback(), 'rollback-decision must not demand resume');
        assert.equal(writes.some((write) => write.state === 'QLB_OWNED' && write.detail.intent === 'rollback'), false,
          'C4 continues directly instead of re-journaling intent');
        const afterFirst = h.store.getMigration('pi-xai');
        assert.equal(afterFirst?.state, 'NATIVE', 'C4 finishes through S5/S7 at the OD-7 terminal state');
        assert.equal(JSON.parse(afterFirst!.detail_json).rollbackDecision, undefined, 'terminal path clears the recorded decision');

        assert.doesNotThrow(() => h.mig.rollback(), 'a second C4-completed rollback is a no-op, never a resume refusal');
        assert.deepEqual(h.store.getMigration('pi-xai'), afterFirst, 'a second C4-completed rollback does not rewrite the journal');
      } finally {
        h.cleanup();
      }
    }

    // C3 and C4 use the same terminal journal path regardless of whether the
    // caller chose resume or rollback. Timestamps are deliberately ignored.
    const stripTimestamps = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripTimestamps);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !['rolledBackAt', 'cleanedAt', 'decidedAt', 'sourceDigest', 'nativeMtime', 'poolFilePath', 'ownerFilePath', 'stagedAt', 'authBackupCycle'].includes(key))
          .map(([key, child]) => [key, stripTimestamps(child)]));
      }
      return value;
    };
    const finish = (fixture: 'C3' | 'C4', command: 'resume' | 'rollback') => {
      const h = setup('xai');
      try {
        if (fixture === 'C3') {
          h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
            handback,
            intent: 'rollback',
            rollbackDecision: ROLLBACK_DECISION,
          }));
        } else {
          h.mig.stage();
          const staged = h.store.getMigration('pi-xai')!;
          h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({
            ...JSON.parse(staged.detail_json),
            intent: 'rollback',
          }));
        }
        h.mig[command]();
        return JSON.parse(h.store.getMigration('pi-xai')!.detail_json);
      } finally {
        h.cleanup();
      }
    };
    for (const fixture of ['C3', 'C4'] as const) {
      assert.deepEqual(
        stripTimestamps(finish(fixture, 'resume')),
        stripTimestamps(finish(fixture, 'rollback')),
        `${fixture} resume and rollback have matching terminal journal detail`,
      );
    }
  });

  it('cleanup-pending with leftover rollback intent and decision settles in one resume', () => {
    const h = setup('xai');
    try {
      const handback = {
        phase: 'cleanup-pending' as const,
        keychainDisposition: 'keep' as const,
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        handback,
        intent: 'rollback',
        rollbackDecision: ROLLBACK_DECISION,
      }));

      const resumed = h.mig.resume();
      assert.equal(resumed.detail.handback, undefined);
      assert.equal(resumed.detail.intent, undefined);
      assert.equal(resumed.detail.rollbackDecision, undefined);
      assert.ok(resumed.detail.lastRollback);
      const journalAfterFirstResume = h.store.getMigration('pi-xai');

      const repeated = h.mig.resume();
      assert.deepEqual(repeated.detail, resumed.detail, 'second resume is a no-op');
      assert.deepEqual(h.store.getMigration('pi-xai'), journalAfterFirstResume, 'second resume does not rewrite the journal');
    } finally {
      h.cleanup();
    }
  });

  it('resume is never refused with a resume hint', async () => {
    const cleanupPending = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    for (const marker of ['intent', 'decision', 'cleanup-pending'] as const) {
      const h = setup('xai');
      try {
        if (marker === 'decision') {
          h.mig.stage();
          await h.mig.rehearse(mockRehearse([]));
          h.mig.commit();
          const row = h.store.getMigration('pi-xai')!;
          h.store.upsertMigration('pi-xai', row.state, JSON.stringify({
            ...JSON.parse(row.detail_json),
            rollbackDecision: currentExactBackupDecision(h),
          }));
        } else if (marker === 'intent') {
          h.mig.stage();
          const staged = h.store.getMigration('pi-xai')!;
          h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
            ...JSON.parse(staged.detail_json),
            intent: 'rollback',
          }));
        } else {
          h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: cleanupPending }));
        }

        assert.doesNotThrow(() => h.mig.resume(), `${marker} routes through resume instead of refusing with a resume hint`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('rollback before commit: auth.json untouched; staged Keychain entries cleaned up', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      assert.equal(keychainHas(h.kc, 'xai'), true);
      assert.equal(h.mig.status().state, 'MIRRORED');

      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'NATIVE');
      assert.equal(rolled.ownerFile, 'absent');
      assert.equal(rolled.nativeStore, 'intact');
      assert.equal(rolled.piAtNextLaunch, 'native works');
      assert.deepEqual(readFileSync(h.authPath), h.originalBytes);
      assert.equal(keychainHas(h.kc, 'xai'), false, 'staging Keychain deleted on rollback');
      const parsed = JSON.parse(readFileSync(h.authPath, 'utf8')) as {
        xai?: { access?: string };
      };
      assert.equal(parsed.xai?.access, FAKE_GRANTS.xai.access);
    } finally {
      h.cleanup();
    }
  });

  it('T-OD6-13c a pre-commit rollback marker fences stage and commit after a denied Keychain delete', async () => {
    const kc = new RollbackDeleteKeychain();
    const h = setup('xai', kc);
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      kc.mode = 'denied';
      assert.throws(() => h.mig.rollback(), /migration rollback failed to delete staged Keychain credential/);
      assert.equal(h.mig.status().detail.intent, 'pre-commit-rollback', 'failed delete keeps the durable recovery marker');

      for (const command of [() => h.mig.stage(), () => h.mig.commit()]) {
        assert.throws(
          command,
          (error: unknown) => (error as { message?: unknown; exitCode?: unknown }).message === 'rollback-in-progress: run `qlb migrate resume`'
            && (error as { exitCode?: unknown }).exitCode === 3,
          'forward mutation is fenced until resume completes the marked rollback',
        );
      }
      await assert.rejects(
        () => h.mig.rehearse(mockRehearse([])),
        (error: unknown) => (error as { message?: unknown; exitCode?: unknown }).message === 'rollback-in-progress: run `qlb migrate resume`'
          && (error as { exitCode?: unknown }).exitCode === 3,
        'rehearse is also a forward mutation fenced until resume completes the marked rollback',
      );

      kc.mode = 'succeed';
      assert.equal(h.mig.resume().state, 'NATIVE', 'resume completes the marked rollback');
    } finally {
      h.cleanup();
    }
  });

  it('T-OD6-13c refuses regular malformed or mismatched staging before commit or resume preserves native state', async () => {
    const corruptions: Array<[string, (staging: string) => void]> = [
      ['missing owner document fields', (staging) => writeFileSync(staging, JSON.stringify({ owner: 'qlb' }) + '\n')],
      ['wrong provider account', (staging) => {
        const owner = JSON.parse(readFileSync(staging, 'utf8')) as { accounts: Array<Record<string, unknown>> };
        owner.accounts[0]!.provider = 'kimi-coding';
        writeFileSync(staging, JSON.stringify(owner, null, 2) + '\n');
      }],
      ['wrong account id', (staging) => {
        const owner = JSON.parse(readFileSync(staging, 'utf8')) as { qlbAccountIds: string[]; accounts: Array<Record<string, unknown>> };
        owner.qlbAccountIds[0] = 'wrong-account';
        owner.accounts[0]!.id = 'wrong-account';
        writeFileSync(staging, JSON.stringify(owner, null, 2) + '\n');
      }],
    ];
    for (const [corruption, corrupt] of corruptions) {
      for (const command of ['commit', 'resume'] as const) {
        const h = setup('xai');
        try {
          h.mig.stage();
          await h.mig.rehearse(mockRehearse([]));
          const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
          corrupt(staging);
          const journalBefore = h.store.getMigration('pi-xai');
          const nativeBefore = readFileSync(h.authPath);

          assert.throws(
            () => h.mig[command](),
            (error: unknown) => (error as { message?: unknown; exitCode?: unknown }).message === `cannot commit: invalid staging ${staging}; run \`qlb migrate rollback\``
              && (error as { exitCode?: unknown }).exitCode === 3,
            `${corruption}/${command}`,
          );
          assert.equal(existsSync(h.ownerPath), false, `${corruption}/${command}: staging is never published`);
          assert.equal(existsSync(staging), true, `${corruption}/${command}: staging remains for explicit rollback`);
          assert.deepEqual(readFileSync(h.authPath), nativeBefore, `${corruption}/${command}: native auth stays untouched`);
          assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, `${corruption}/${command}: journal stays unchanged`);
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-OD6-13c shared-map ownership is the durable claim after P7b6 publication', async () => {
    const swaps: Array<[string, (staging: string, dir: string) => void]> = [
      ['symlink swap', (staging, dir) => {
        const target = join(dir, 'post-validation-target.json');
        writeFileSync(target, readFileSync(staging), { mode: 0o644 });
        chmodSync(target, 0o644);
        rmSync(staging);
        symlinkSync(target, staging);
      }],
      ['regular mismatched file', (staging) => {
        const owner = JSON.parse(readFileSync(staging, 'utf8')) as { accounts: Array<Record<string, unknown>> };
        owner.accounts[0]!.id = 'wrong-account';
        writeFileSync(staging, JSON.stringify(owner, null, 2) + '\n');
      }],
    ];

    for (const [swapName, swap] of swaps) {
      let h: (Harness & { mig: Migration }) | undefined;
      let journalAtSwap: ReturnType<ReturnType<typeof openStore>['getMigration']> | undefined;
      h = setup('xai', new MockKeychain(), {
        beforeOwnerFileRename: () => {
          const staging = stagingOwnerPath(join(h!.dir, 'qlb-owner.json'), 'xai');
          swap(staging, h!.dir);
          journalAtSwap = h!.store.getMigration('pi-xai');
        },
      });
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        const nativeBefore = readFileSync(h.authPath);
        const assertRefusalPreservesState = (command: 'first commit' | 'commit retry' | 'resume retry', fn: () => unknown) => {
          assert.throws(
            fn,
            (error: unknown) => (error as { message?: unknown; exitCode?: unknown }).message === `cannot commit: invalid published owner ${h!.ownerPath}; run \`qlb migrate rollback\``
              && (error as { exitCode?: unknown }).exitCode === 3,
            `${swapName}/${command} refuses the invalid published owner`,
          );
          assert.ok(journalAtSwap, `${swapName}/${command}: the seam captured the pre-rename journal`);
          assert.equal(journalAtSwap.state, 'VALIDATED', `${swapName}/${command}: journal phase remains VALIDATED`);
          assert.deepEqual(h!.store.getMigration('pi-xai'), journalAtSwap, `${swapName}/${command}: journal stays unchanged`);
          assert.deepEqual(readFileSync(h!.authPath), nativeBefore, `${swapName}/${command}: native auth stays untouched`);
        };

        assert.equal(h!.mig.commit().state, 'QLB_OWNED', `${swapName}: v2 publication ignores the unpublishable legacy staging swap`);
        assert.equal(isPiPlaceholder(JSON.parse(readFileSync(h!.authPath, 'utf8')).xai), true, `${swapName}: placeholder follows the v2 owner entry`);
        assert.equal(JSON.parse(readFileSync(ownerMapPath(h!), 'utf8')).providers.xai.mode, 'qlb', `${swapName}: shared map owns xai`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-OD6-13c resume finishes a claim-rename crash before a pre-commit rollback marker and preserves K_m', async () => {
    const kc = new DeleteTrackingKeychain();
    const h = setup('xai', kc);
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      const row = h.store.getMigration('pi-xai')!;
      const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
      detail.commitGeneration = h.store.getGrantGeneration(expectedId('xai'));
      detail.intent = 'pre-commit-rollback';
      h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify(detail));
      renameSync(staging, legacySidecarPath(h));
      kc.deleteCalls.length = 0;
      assert.equal(
        h.mig.status().resumeAction,
        'already committed; finish hygiene → QLB_OWNED',
        'status gives the live committed claim priority over the stale rollback marker',
      );

      const resumed = h.mig.resume();
      assert.equal(resumed.state, 'QLB_OWNED', 'the committed claim wins over the stale rollback marker');
      assert.equal(resumed.ownerFile, 'present');
      assert.deepEqual(kc.deleteCalls, [], 'resume never deletes K_m under the live owner claim');
      assert.equal(keychainHas(kc, 'xai'), true, 'K_m remains available to the committed owner');
    } finally {
      h.cleanup();
    }
  });

  it('T-OD6-13c resume routes a readable staging symlink to pre-commit rollback instead of commit', async () => {
    const kc = new DeleteTrackingKeychain();
    const h = setup('xai', kc);
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      const target = join(h.dir, 'readable-staging-target.json');
      writeFileSync(target, readFileSync(staging));
      rmSync(staging);
      symlinkSync(target, staging);

      assert.equal(h.mig.status().resumeAction, 'before commit: roll back staging (native untouched)');
      const resumed = h.mig.resume();

      assert.equal(resumed.state, 'NATIVE');
      assert.equal(existsSync(h.ownerPath), false, 'the symlink is never published as the owner claim');
      assert.equal(kc.deleteCalls.length, 1, 'the staged Keychain copy is removed only on rollback');
    } finally {
      h.cleanup();
    }
  });

  it('T-OD6-13c resume refuses a directory staging entry before deleting its Keychain copy', async () => {
    const kc = new DeleteTrackingKeychain();
    const h = setup('xai', kc);
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      rmSync(staging);
      mkdirSync(staging);

      assert.equal(h.mig.status().resumeAction, 'before commit: roll back staging (native untouched)');
      assert.throws(
        () => h.mig.resume(),
        (error: unknown) => (error as { message?: unknown; exitCode?: unknown }).message === `cannot roll back: staging entry is not removable ${staging}`
          && (error as { exitCode?: unknown }).exitCode === 3,
      );
      assert.deepEqual(kc.deleteCalls, [], 'the non-removable entry refuses before deleting K_m');
      assert.equal(keychainHas(kc, 'xai'), true);
    } finally {
      h.cleanup();
    }
  });

  it('T-OD6-13c recovery-entry refusal exits 3 and preserves the staged credential', () => {
    const kc = new DeleteTrackingKeychain();
    const h = setup('xai', kc);
    try {
      h.mig.stage();
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      writeFileSync(`${staging}.rollback`, 'fixture recovery entry');
      assert.throws(
        () => h.mig.rollback(),
        (error: unknown) => (error as { message?: unknown; exitCode?: unknown }).message === `cannot roll back: staging recovery entry exists ${staging}.rollback`
          && (error as { exitCode?: unknown }).exitCode === 3,
      );
      assert.deepEqual(kc.deleteCalls, [], 'the refusal occurs before the staged Keychain credential is deleted');
      assert.equal(keychainHas(kc, 'xai'), true);
    } finally {
      h.cleanup();
    }
  });

  it('pre-commit rollback keeps a staged migration retryable when its Keychain delete fails', () => {
    const kc = new RollbackDeleteKeychain();
    const h = setup('xai', kc);
    try {
      h.mig.stage();
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      assert.equal(existsSync(staging), true, 'precondition: staging file exists');
      assert.equal(keychainHas(kc, 'xai'), true, 'precondition: staged Keychain item exists');

      kc.mode = 'denied';
      assert.throws(
        () => h.mig.rollback(),
        /migration rollback failed to delete staged Keychain credential for provider=xai account=Grok \(xAI\)/,
      );
      assert.equal(h.store.getMigration('pi-xai')?.state, 'MIRRORED', 'failed delete keeps journal retryable');
      assert.equal(existsSync(staging), true, 'failed delete keeps staging file');
      assert.equal(keychainHas(kc, 'xai'), true, 'failed delete keeps staged Keychain item');

      kc.mode = 'succeed';
      assert.equal(h.mig.rollback().state, 'NATIVE', 'retry succeeds after Keychain recovers');
      assert.equal(keychainHas(kc, 'xai'), false, 'retry removes staged Keychain item');

      h.mig.stage();
      kc.deleteSync(kmCoords('xai').service, kmCoords('xai').account);
      kc.mode = 'not-found';
      assert.equal(h.mig.rollback().state, 'NATIVE', 'not-found remains idempotent');
      assert.equal(existsSync(staging), false, 'not-found cleanup removes staging file');
    } finally {
      h.cleanup();
    }
  });

  it('T-PRE pre-commit rollback removes its current-cycle leftover backup', () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      const cycle = (JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as { authBackupCycle: string }).authBackupCycle;
      writePiAuthBackup(h.authPath, 'xai', cycle);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'xai')), true, 'fixture backup exists');

      h.mig.rollback();

      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'xai')), false);
    } finally {
      h.cleanup();
    }
  });

  it('T-PRE a conflicting auth key refuses pre-commit rollback before any cleanup', () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      const row = h.store.getMigration('pi-xai');
      const detail = { ...(JSON.parse(row?.detail_json ?? '{}') as Record<string, unknown>), authJsonKey: 'grok' };
      h.store.upsertMigration('pi-xai', row!.state, JSON.stringify(detail));
      const conflicting = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, h.ownerPath, 'other-alias');

      assert.throws(() => conflicting.rollback(), /auth\.json key mismatch/);

      assert.equal(keychainHas(h.kc, 'xai'), true, 'staged Keychain item kept');
      assert.equal(h.store.getMigration('pi-xai')?.state, row!.state, 'journal state unchanged');
    } finally {
      h.cleanup();
    }
  });

  it('createOwnedCredentialSource returns Keychain access token when QLB_OWNED', async () => {
    const h = setup('openai-codex');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      assert.equal(h.mig.status().state, 'QLB_OWNED');

      const getCred = createOwnedCredentialSource({ store: h.store, keychain: h.kc });
      const token = await getCred(expectedId('openai-codex'));
      assert.equal(token, FAKE_GRANTS['openai-codex'].access);
    } finally {
      h.cleanup();
    }
  });

  it('createOwnedCredentialSource errors clearly when Codex is not yet migrated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    const kc = new MockKeychain();
    try {
      const getCred = createOwnedCredentialSource({ store, keychain: kc });
      await assert.rejects(
        () => getCred('codex-default'),
        /Codex credential not yet owned by QLB — run migration first/,
      );
    } finally {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no stage can create a bare-id Codex takeover after activation', () => {
    const h = setup('openai-codex');
    try {
      const staged = stageGenericGrant(h.store, h.kc, 'openai-codex', h.authPath, 'openai-codex', h.ownerPath);
      const db = (h.store as unknown as { db: import('node:sqlite').DatabaseSync }).db;
      assert.equal(staged.state, 'MIRRORED');
      assert.equal(db.prepare("SELECT 1 FROM accounts WHERE id = 'fixture-account'").get(), undefined);
      assert.equal(db.prepare("SELECT 1 FROM migrations WHERE store = 'pi-openai-codex' AND detail_json LIKE '%fixture-account%'").get() !== undefined, true);
      assert.equal(db.prepare("SELECT 1 FROM migrations WHERE store = 'pi-openai-codex' AND detail_json LIKE '%\"fixture-account\"%'").get(), undefined);
      assert.doesNotThrow(() => h.kc.getSync(
        qlbKeychainService('openai-codex', 'fixture-user:fixture-account'),
        'fixture-user:fixture-account',
      ));
      assert.throws(() => h.kc.getSync(qlbKeychainService('openai-codex', 'fixture-account'), 'fixture-account'));
    } finally { h.cleanup(); }
  });

  it('stageGenericGrant helper stages xai without modifying the fixture file', () => {
    const h = setup('xai');
    try {
      const before = readFileSync(h.authPath);
      const staged = stageGenericGrant(
        h.store,
        h.kc,
        'xai',
        h.authPath,
        'xai',
        h.ownerPath,
      );
      assert.equal(staged.state, 'MIRRORED');
      assert.ok(readFileSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'), 'utf8').length > 0);
      assert.deepEqual(readFileSync(h.authPath), before);
      assert.equal(keychainHas(h.kc, 'xai'), true);
    } finally {
      h.cleanup();
    }
  });
});

/**
 * OpenRouter is a static API key (no OAuth Grant). Tests inject a fake key
 * and use MockKeychain — the real `pi-openrouter` service and any real
 * `qlb:openrouter:*` entry are never touched.
 */
const FAKE_OPENROUTER_KEY = 'sk-or-fake-test-key-not-real';
const OPENROUTER_ID = ADAPTER_ACCOUNT_IDS.openrouter;
const OPENROUTER_LABEL = ADAPTER_ACCOUNT_LABELS.openrouter;

function mockOpenRouterRehearse(calls: StagedAccount[]): RehearseFn {
  return async (account) => {
    calls.push(account);
    assert.equal(account.provider, 'openrouter');
    assert.equal(account.id, OPENROUTER_ID);
    assert.equal(account.grant.access, FAKE_OPENROUTER_KEY);
    assert.equal(account.grant.expires, 0);
    return { ok: true };
  };
}

function openrouterKeychainHas(kc: MockKeychain): boolean {
  try {
    const raw = kc.getSync(
      OPENROUTER_GATE_KEYCHAIN_SERVICE,
      QLB_KEYCHAIN_ACCOUNT,
    );
    return parseApiKeyPayload(raw).access === FAKE_OPENROUTER_KEY;
  } catch {
    return false;
  }
}

function runMapWriterChild(root: string, dir: string, provider: 'openrouter' | 'xai'): Promise<void> {
  const script = `
    const path = require('node:path');
    const src = process.argv[1];
    const dir = process.argv[2];
    const provider = process.argv[3];
    const { openStore } = require(path.join(src, 'store.js'));
    const { MockKeychain } = require(path.join(src, 'keychain.js'));
    if (provider === 'openrouter') {
      const { createStaticKeyMigration } = require(path.join(src, 'migration.js'));
      const store = openStore(path.join(dir, 'openrouter.db'));
      const migration = createStaticKeyMigration(store, new MockKeychain(), 'openrouter', path.join(dir, '.pi', 'agent', 'qlb-owner.json'), () => 'test-openrouter-key');
      migration.stage();
      migration.rehearse(async () => ({ ok: true })).then(() => migration.commit()).then(() => store.close());
    } else {
      const { migratePiSingleProvider } = require(path.join(src, 'pi-migrate.js'));
      const agent = path.join(dir, '.pi', 'agent');
      migratePiSingleProvider('xai', {
        authJsonPath: path.join(agent, 'auth.json'),
        ownerPath: path.join(agent, 'qlb-owner.json'),
        journalPath: path.join(dir, '.qlb', 'journal'),
        baselineDir: path.join(dir, '.qlb', 'backups', 'pi-auth'),
      }, { keychain: new MockKeychain() });
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, root, dir, provider], {
      env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: dir, HOME: dir },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer child exited ${code}`)));
  });
}

function setupOpenRouter(): {
  dir: string;
  ownerPath: string;
  store: ReturnType<typeof openStore>;
  kc: MockKeychain;
  mig: ReturnType<typeof createStaticKeyMigration>;
  nativeReads: number;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-openrouter-mig-'));
  const ownerPath = join(dir, 'qlb-owner.json');
  const store = openStore(join(dir, 'qlb.db'));
  const kc = new MockKeychain();
  let nativeReads = 0;
  const mig = createStaticKeyMigration(store, kc, 'openrouter', ownerPath, () => {
    nativeReads += 1;
    return FAKE_OPENROUTER_KEY;
  });
  return {
    dir,
    ownerPath,
    store,
    kc,
    mig,
    get nativeReads() {
      return nativeReads;
    },
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('static-key migration — openrouter (single API key, no OAuth)', () => {
  it('happy path: stage → rehearse → commit; accountId matches adapter; native Keychain retained', async () => {
    const h = setupOpenRouter();
    try {
      const before = h.mig.status();
      assert.equal(before.state, 'NATIVE');
      assert.equal(before.ownerFile, 'absent');
      assert.equal(before.nativeStore, 'intact');
      assert.equal(before.piAtNextLaunch, 'native works');
      assert.equal(before.nativeStrategy, 'keychain-retain');
      assert.equal(before.provider, 'openrouter');
      assert.equal(before.store, 'pi-openrouter');

      const staged = h.mig.stage();
      assert.equal(staged.state, 'MIRRORED');
      assert.equal(staged.ownerFile, 'staging');
      assert.equal(staged.nativeStore, 'intact');
      assert.equal(staged.piAtNextLaunch, 'native works');
      assert.equal(staged.nativeStrategy, 'keychain-retain');
      assert.equal(h.nativeReads, 1, 'stage reads the injected key once');
      assert.equal(openrouterKeychainHas(h.kc), true);
      assert.equal(h.store.getAccount(OPENROUTER_ID)?.id, OPENROUTER_ID);
      assert.equal(h.store.getAccount(OPENROUTER_ID)?.provider, 'openrouter');

      const rawPayload = h.kc.getSync(
        OPENROUTER_GATE_KEYCHAIN_SERVICE,
        QLB_KEYCHAIN_ACCOUNT,
      );
      const payload: ApiKeyPayload = parseApiKeyPayload(rawPayload);
      assert.equal(payload.type, 'api-key');
      assert.equal(payload.access, FAKE_OPENROUTER_KEY);
      assert.equal(
        'refresh' in JSON.parse(rawPayload),
        false,
        'persisted payload must not be an OAuth Grant',
      );

      const ownerStaging = JSON.parse(
        readFileSync(stagingOwnerPath(h.ownerPath, 'openrouter'), 'utf8'),
      ) as {
        nativeStrategy?: string;
        nativeKeychainService?: string;
        qlbAccountIds: string[];
      };
      assert.equal(ownerStaging.nativeStrategy, 'keychain-retain');
      assert.equal(ownerStaging.nativeKeychainService, NATIVE_OPENROUTER_KEYCHAIN_SERVICE);
      assert.deepEqual(ownerStaging.qlbAccountIds, [OPENROUTER_ID]);

      const rehearseCalls: StagedAccount[] = [];
      const rehearsed = await h.mig.rehearse(mockOpenRouterRehearse(rehearseCalls));
      assert.equal(rehearsed.state, 'VALIDATED');
      assert.equal(rehearseCalls.length, 1);
      assert.equal(rehearseCalls[0]?.id, OPENROUTER_ID);
      assert.equal(rehearseCalls[0]?.provider, 'openrouter');
      assert.equal(rehearseCalls[0]?.grant.access, FAKE_OPENROUTER_KEY);

      const committed = h.mig.commit();
      assert.equal(committed.state, 'QLB_OWNED');
      assert.equal(committed.ownerFile, 'present');
      assert.equal(committed.nativeStore, 'intact');
      assert.equal(committed.piAtNextLaunch, 'QLB works');
      assert.equal(committed.nativeStrategy, 'keychain-retain');
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as {
        providers: Record<string, { mode?: string }>;
      };
      assert.equal(owner.providers.openrouter?.mode, 'qlb');
      assert.equal(existsSync(join(h.dir, 'qlb-owner-openrouter.json')), false);
      assert.equal(openrouterKeychainHas(h.kc), true);
      assert.equal(h.store.getMigration('pi-openrouter')?.state, 'QLB_OWNED');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0e recognizes an OpenRouter crash-commit as dual ownership, finishes it without P7a, and clears commitStarted on re-stage and hand-back', async () => {
    for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
      const h = setupOpenRouter();
      try {
        h.mig.stage();
        await h.mig.rehearse(mockOpenRouterRehearse([]));
        const row = h.store.getMigration('pi-openrouter');
        assert.ok(row, 'stage recorded the OpenRouter migration');
        h.store.upsertMigration('pi-openrouter', 'VALIDATED', JSON.stringify({
          ...JSON.parse(row.detail_json),
          commitStarted: true,
        }));
        writeFileSync(h.ownerPath, JSON.stringify({
          providers: { openrouter: { mode: 'qlb' } },
        }) + '\n');
        h.store.setConfig('pi.openrouter.state', 'migrated');
        const before = h.store.getMigration('pi-openrouter')!;
        const ownerBefore = readFileSync(h.ownerPath);
        const credentialBefore = h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT);

        assert.throws(
          () => h.mig[command](),
          (error: Error & { exitCode?: unknown }) => {
            assert.match(error.message, /dual-ownership: run `qlb pi rollback openrouter` first, then `qlb migrate rollback --provider openrouter`/);
            assert.equal(error.exitCode, 3);
            return true;
          },
        );
        assert.deepEqual(h.store.getMigration('pi-openrouter'), before, `${command} leaves the crash journal unchanged`);
        assert.deepEqual(readFileSync(h.ownerPath), ownerBefore, `${command} leaves O unchanged`);
        assert.equal(h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT), credentialBefore, `${command} leaves the managed key unchanged`);
      } finally {
        h.cleanup();
      }
    }

    for (const command of ['resume', 'commit'] as const) {
      const h = setupOpenRouter();
      try {
        h.mig.stage();
        await h.mig.rehearse(mockOpenRouterRehearse([]));
        const row = h.store.getMigration('pi-openrouter');
        assert.ok(row);
        h.store.upsertMigration('pi-openrouter', 'VALIDATED', JSON.stringify({
          ...JSON.parse(row.detail_json),
          commitStarted: true,
        }));
        writeFileSync(h.ownerPath, JSON.stringify({
          providers: { openrouter: { mode: 'qlb' } },
        }) + '\n');

        const completed = h.mig[command]();
        assert.equal(completed.state, 'QLB_OWNED', `${command} completes C5 without P7a ownership`);
      } finally {
        h.cleanup();
      }
    }

    const h = setupOpenRouter();
    try {
      h.mig.stage();
      const staged = h.store.getMigration('pi-openrouter')!;
      h.store.upsertMigration('pi-openrouter', 'MIRRORED', JSON.stringify({
        ...JSON.parse(staged.detail_json),
        commitStarted: true,
      }));
      h.mig.stage();
      assert.equal(JSON.parse(h.store.getMigration('pi-openrouter')!.detail_json).commitStarted, undefined, 're-stage clears commitStarted');

      await h.mig.rehearse(mockOpenRouterRehearse([]));
      const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
      let journaledBeforeOwner = false;
      h.store.upsertMigration = (store, state, detail) => {
        const recorded = JSON.parse(detail ?? '{}') as { commitStarted?: boolean };
        if (store === 'pi-openrouter' && state === 'VALIDATED' && recorded.commitStarted === true) {
          assert.equal(existsSync(`${join(h.dir, 'auth.json')}.lock`), true, 'commitStarted is journaled while the owner-map lock is held');
          assert.equal(existsSync(h.ownerPath), false, 'commitStarted is journaled before O exists');
          journaledBeforeOwner = true;
        }
        return originalUpsertMigration(store, state, detail);
      };

      h.mig.commit();

      assert.equal(journaledBeforeOwner, true, 'normal OpenRouter commit journals before writing O');
      assert.equal(JSON.parse(h.store.getMigration('pi-openrouter')!.detail_json).commitStarted, true);
      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(rolled.detail.commitStarted, undefined, 'hand-back terminal write clears commitStarted');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0g refuses an unreadable static-key O with commitStarted without changing recovery artifacts', async () => {
    for (const command of ['commit', 'rollback', 'resume'] as const) {
      const h = setupOpenRouter();
      try {
        h.mig.stage();
        await h.mig.rehearse(mockOpenRouterRehearse([]));
        const detail = JSON.parse(h.store.getMigration('pi-openrouter')!.detail_json) as Record<string, unknown>;
        h.store.upsertMigration('pi-openrouter', 'VALIDATED', JSON.stringify({ ...detail, commitStarted: true }));
        const stagingPath = stagingOwnerPath(h.ownerPath, 'openrouter');
        writeFileSync(h.ownerPath, '{not valid JSON\n');

        const journalBefore = h.store.getMigration('pi-openrouter');
        const keychainBefore = h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT);
        const stagingBefore = readFileSync(stagingPath);
        const ownerBefore = readFileSync(h.ownerPath);

        assert.throws(() => h.mig[command](), (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owner-file-orphan: .*qlb-owner\.json could not be read/);
          assert.equal(error.exitCode, 3);
          return true;
        }, `${command} refuses ambiguous O evidence`);
        assert.deepEqual(h.store.getMigration('pi-openrouter'), journalBefore, `${command} preserves the journal`);
        assert.equal(h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT), keychainBefore, `${command} preserves the Keychain payload`);
        assert.deepEqual(readFileSync(stagingPath), stagingBefore, `${command} preserves staging`);
        assert.deepEqual(readFileSync(h.ownerPath), ownerBefore, `${command} preserves O`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S0g refuses a dangling OpenRouter O symlink before stage or commit writes', async () => {
    for (const command of ['stage', 'commit'] as const) {
      const h = setupOpenRouter();
      try {
        if (command === 'commit') {
          h.mig.stage();
          await h.mig.rehearse(mockOpenRouterRehearse([]));
        }
        const target = join(h.dir, `missing-openrouter-o-${command}`);
        symlinkSync(target, h.ownerPath);
        const stagingPath = stagingOwnerPath(h.ownerPath, 'openrouter');
        const journalBefore = h.store.getMigration('pi-openrouter');
        const keychainBefore = command === 'commit'
          ? h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT)
          : null;
        const stagingBefore = existsSync(stagingPath) ? readFileSync(stagingPath) : null;

        assert.throws(() => h.mig[command](), (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owner-file-orphan: .*could not be read/);
          assert.equal(error.exitCode, 3);
          return true;
        }, `${command} refuses the dangling O link`);
        assert.equal(readlinkSync(h.ownerPath), target, `${command} keeps the symlink`);
        assert.equal(existsSync(target), false, `${command} does not create the target`);
        assert.deepEqual(h.store.getMigration('pi-openrouter'), journalBefore, `${command} preserves the journal`);
        if (keychainBefore === null) {
          assert.throws(() => h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT));
        } else {
          assert.equal(h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT), keychainBefore, `${command} preserves the Keychain payload`);
        }
        assert.deepEqual(existsSync(stagingPath) ? readFileSync(stagingPath) : null, stagingBefore, `${command} preserves staging`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S0e resumes or re-enters a static-key commit that crashes after the O write without classifying it as an orphan', async () => {
    for (const recovery of ['resume', 'commit'] as const) {
      const h = setupOpenRouter();
      try {
        h.mig.stage();
        await h.mig.rehearse(mockOpenRouterRehearse([]));
        const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
        let crashed = false;
        h.store.upsertMigration = (store, state, detail) => {
          if (!crashed && store === 'pi-openrouter' && state === 'QLB_OWNED') {
            crashed = true;
            throw new Error('simulated crash after O');
          }
          return originalUpsertMigration(store, state, detail);
        };

        assert.throws(() => h.mig.commit(), /simulated crash after O/);
        assert.equal(crashed, true, 'the simulated crash follows the O write');
        assert.equal(
          JSON.parse(h.store.getMigration('pi-openrouter')!.detail_json).commitStarted,
          true,
          'the static-key commit journals commitStarted before O',
        );
        assert.equal(
          JSON.parse(readFileSync(h.ownerPath, 'utf8')).providers.openrouter.mode,
          'qlb',
          'O was written before the crash',
        );

        h.store.upsertMigration = originalUpsertMigration;
        const completed = h.mig[recovery]();
        assert.equal(completed.state, 'QLB_OWNED', `${recovery} finishes C5 forward`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('openrouter commit refuses into a legacy v1 Anthropic owner document, leaving staging, Keychain and the document byte-identical', async () => {
    const h = setupOpenRouter();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockOpenRouterRehearse([]));
      writeFileSync(h.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n');
      const documentBefore = readFileSync(h.ownerPath);
      const stagingPath = stagingOwnerPath(h.ownerPath, 'openrouter');
      const stagingBefore = readFileSync(stagingPath);
      const managedBefore = h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT);

      assert.throws(() => h.mig.commit(), /owner-file-legacy-v1/);

      assert.deepEqual(readFileSync(h.ownerPath), documentBefore);
      assert.deepEqual(readFileSync(stagingPath), stagingBefore);
      assert.equal(h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT), managedBefore);
    } finally {
      h.cleanup();
    }
  });

  it('rolls back OpenRouter credentials at both gate and legacy coordinates', () => {
    const h = setupOpenRouter();
    try {
      const legacyPath = join(h.dir, 'qlb-owner-openrouter.json');
      const legacyService = qlbKeychainService('openrouter', OPENROUTER_ID);
      writeFileSync(legacyPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'openrouter' }] }) + '\n');
      h.kc.setSync(
        OPENROUTER_GATE_KEYCHAIN_SERVICE,
        QLB_KEYCHAIN_ACCOUNT,
        JSON.stringify({ type: 'api-key', access: FAKE_OPENROUTER_KEY }),
      );
      h.kc.setSync(
        legacyService,
        OPENROUTER_LABEL,
        JSON.stringify({ type: 'api-key', access: FAKE_OPENROUTER_KEY }),
      );
      h.store.upsertMigration('pi-openrouter', 'QLB_OWNED', '{}');

      assert.equal(h.mig.status().piAtNextLaunch, 'QLB works', 'status recognizes the legacy credential');
      const rolled = h.mig.rollback();

      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(rolled.ownerFile, 'absent');
      assert.equal(existsSync(legacyPath), false);
      assert.equal(openrouterKeychainHas(h.kc), false, 'gate credential removed');
      assert.throws(() => h.kc.getSync(legacyService, OPENROUTER_LABEL), /not found/i);
    } finally {
      h.cleanup();
    }
  });

  it('fails rollback on a non-not-found OpenRouter Keychain delete error and names its coordinates', async () => {
    const h = setupOpenRouter();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockOpenRouterRehearse([]));
      h.mig.commit();
      const originalDelete = h.kc.deleteSync.bind(h.kc);
      h.kc.deleteSync = (service, account) => {
        if (service === OPENROUTER_GATE_KEYCHAIN_SERVICE && account === QLB_KEYCHAIN_ACCOUNT) {
          throw new Error('fixture Keychain access denied');
        }
        originalDelete(service, account);
      };

      assert.throws(
        () => h.mig.rollback(),
        new RegExp(`service=${OPENROUTER_GATE_KEYCHAIN_SERVICE} account=${QLB_KEYCHAIN_ACCOUNT}`),
      );
      assert.equal(h.mig.status().ownerFile, 'present', 'failed rollback retains QLB ownership for retry');
    } finally {
      h.cleanup();
    }
  });

  it('keeps the gate credential and owner entry when the legacy delete fails, then retries safely', async () => {
    const h = setupOpenRouter();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockOpenRouterRehearse([]));
      h.mig.commit();
      const legacyService = qlbKeychainService('openrouter', OPENROUTER_ID);
      h.kc.setSync(
        legacyService,
        OPENROUTER_LABEL,
        JSON.stringify({ type: 'api-key', access: FAKE_OPENROUTER_KEY }),
      );
      const originalDelete = h.kc.deleteSync.bind(h.kc);
      h.kc.deleteSync = (service, account) => {
        if (service === legacyService && account === OPENROUTER_LABEL) {
          throw new Error('fixture Keychain access denied');
        }
        originalDelete(service, account);
      };

      assert.throws(
        () => h.mig.rollback(),
        new RegExp(`service=${legacyService} account=${OPENROUTER_LABEL}`),
      );
      assert.equal(openrouterKeychainHas(h.kc), true, 'legacy failure leaves the working gate credential readable');
      const ownerBeforeRetry = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as {
        providers: Record<string, { mode?: string }>;
      };
      assert.equal(ownerBeforeRetry.providers.openrouter?.mode, 'qlb', 'legacy failure leaves the owner entry present');

      h.kc.deleteSync = originalDelete;
      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(openrouterKeychainHas(h.kc), false, 'retry removes the gate credential');
      assert.throws(() => h.kc.getSync(legacyService, OPENROUTER_LABEL), /not found/i);
      assert.equal(existsSync(h.ownerPath), false, 'retry removes the final owner entry');
    } finally {
      h.cleanup();
    }
  });

  it("openrouter rollback removes only its entry and keeps xai's", () => {
    const h = setupOpenRouter();
    try {
      writeFileSync(h.ownerPath, JSON.stringify({ providers: {
        openrouter: { mode: 'qlb', since: 1 },
        xai: { mode: 'qlb', since: 2 },
      } }) + '\n');
      h.store.upsertMigration('pi-openrouter', 'QLB_OWNED', '{}');

      h.mig.rollback();

      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.equal(owner.providers.openrouter, undefined);
      assert.deepEqual(owner.providers.xai, { mode: 'qlb', since: 2 });
    } finally {
      h.cleanup();
    }
  });

  it('serializes concurrent openrouter and xai map writers so both entries survive', async () => {
    const h = setupOpenRouter();
    try {
      const agentDir = join(h.dir, '.pi', 'agent');
      const ownerPath = join(agentDir, 'qlb-owner.json');
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ xai: FAKE_GRANTS.xai }) + '\n', { mode: 0o600 });
      await Promise.all([
        runMapWriterChild(join(process.cwd(), 'dist-test', 'src'), h.dir, 'openrouter'),
        runMapWriterChild(join(process.cwd(), 'dist-test', 'src'), h.dir, 'xai'),
      ]);

      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { providers: Record<string, { mode?: string }> };
      assert.equal(owner.providers.openrouter?.mode, 'qlb');
      assert.equal(owner.providers.xai?.mode, 'qlb');
    } finally {
      h.cleanup();
    }
  });

  it('stage refuses an orphan legacy sidecar claim for the provider', () => {
    const h = setupOpenRouter();
    try {
      const legacyPath = join(h.dir, 'qlb-owner-openrouter.json');
      writeFileSync(legacyPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'openrouter' }] }) + '\n');

      assert.throws(
        () => h.mig.stage(),
        (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owner-file-orphan/);
          assert.equal(error.exitCode, 3);
          return true;
        },
      );
      assert.equal(openrouterKeychainHas(h.kc), false);
    } finally {
      h.cleanup();
    }
  });

  it('rollback before commit: staged Keychain entries cleaned up; native never written', () => {
    const h = setupOpenRouter();
    try {
      h.mig.stage();
      assert.equal(openrouterKeychainHas(h.kc), true);
      assert.equal(h.mig.status().state, 'MIRRORED');

      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'NATIVE');
      assert.equal(rolled.ownerFile, 'absent');
      assert.equal(rolled.nativeStore, 'intact');
      assert.equal(rolled.piAtNextLaunch, 'native works');
      assert.equal(rolled.nativeStrategy, 'keychain-retain');
      assert.equal(
        openrouterKeychainHas(h.kc),
        false,
        'staging Keychain deleted on rollback',
      );
    } finally {
      h.cleanup();
    }
  });

  it('createOwnedCredentialSource errors clearly when OpenRouter is not yet migrated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-openrouter-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    const kc = new MockKeychain();
    try {
      const getCred = createOwnedCredentialSource({ store, keychain: kc });
      await assert.rejects(
        () => getCred('openrouter-default'),
        /OpenRouter credential not yet owned by QLB — run migration first/,
      );
    } finally {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stage without readNativeKey fails closed (never calls real Keychain)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-openrouter-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    const kc = new MockKeychain();
    try {
      const mig = createStaticKeyMigration(
        store,
        kc,
        'openrouter',
        join(dir, 'qlb-owner.json'),
        () => {
          throw new Error('injected reader must not be the real security CLI');
        },
      );
      // Replace-path coverage: a reader that throws must not leave Keychain entries.
      assert.throws(() => mig.stage(), /injected reader must not be the real security CLI/);
      assert.equal(openrouterKeychainHas(kc), false);
    } finally {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
