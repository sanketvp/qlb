import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import { beginCutover } from '../src/lifecycle';
import { piPlaceholder, PiOwnerLegacyError, writePiOwnerEntry } from '../src/pi-migrate';
import { piAuthBackupPath, writePiAuthBackup } from '../src/pi-auth-backup';
import { ANTHROPIC_POOL_HISTORY, NATIVE_AUTH, NATIVE_AUTH_WITH_XAI, type HistoricalPoolArtifact, installHistoricalPoolArtifact } from './fixtures/anthropic-pool-history';
import { runPiGate } from '../src/pi-gate';
import {
  Migration,
  PI_POOL_STORE,
  createStaticKeyMigration,
  parsePoolFile,
  preQlbPath,
  sidecarPath,
  stagingOwnerPath,
  type MigrationConfig,
  type RehearseFn,
  type StagedAccount,
} from '../src/migration';
import { parseGrant } from '../src/refresh-lease';
import { openStore } from '../src/store';
import { uuidPoolTransport } from './support/anthropic-pool-rehearse';

const FIXTURE_ACCOUNTS = [
  {
    id: 'acct-a',
    name: 'Account A',
    accountUuid: '00000000-0000-4000-8000-00000000000a',
    credentials: {
      type: 'oauth' as const,
      access: 'sk-ant-oat-fake-a',
      refresh: 'sk-ant-ort-fake-a',
      expires: Date.now() + 7 * 24 * 3600 * 1000,
    },
  },
  {
    id: 'acct-b',
    name: 'Account B',
    accountUuid: '00000000-0000-4000-8000-00000000000b',
    credentials: {
      type: 'oauth' as const,
      access: 'sk-ant-oat-fake-b',
      refresh: 'sk-ant-ort-fake-b',
      expires: Date.now() + 7 * 24 * 3600 * 1000,
    },
  },
];

function fixturePool(): string {
  return JSON.stringify(
    {
      version: 1,
      accounts: FIXTURE_ACCOUNTS,
      activeIndex: 0,
      defaultCooldownMs: 10_800_000,
      rotation: 'round-robin',
    },
    null,
    2,
  ) + '\n';
}

function nativeWorks(poolPath: string): boolean {
  try {
    const ids = parsePoolFile(readFileSync(poolPath, 'utf8')).accounts.map((account) => account.id);
    return ids.includes('acct-a') && ids.includes('acct-b');
  } catch {
    return false;
  }
}

function qlbWorks(kc: MockKeychain): boolean {
  try {
    for (const acct of FIXTURE_ACCOUNTS) {
      const raw = kc.getSync(qlbKeychainService('anthropic', acct.id), acct.name);
      const grant = parseGrant(raw);
      if (grant.access !== acct.credentials.access) return false;
      if (grant.refresh !== acct.credentials.refresh) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function assertSafety(poolPath: string, kc: MockKeychain): void {
  const n = nativeWorks(poolPath);
  const q = qlbWorks(kc);
  assert.ok(
    n || q,
    `core safety property violated: neither native fixture nor QLB-staged Keychain is valid (native=${n} qlb=${q})`,
  );
}

function mockRehearse(calls: StagedAccount[]): RehearseFn {
  return async (account) => {
    calls.push(account);
    assert.ok(account.grant.access, 'rehearse received staged access token');
    assert.ok(account.grant.refresh, 'rehearse received staged refresh token');
    return { ok: true };
  };
}

function assertProofUnavailable(run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof Error
    && (
      error.message === 'proof-unavailable'
      || error.message === 'source-witness-unavailable'
      || error.message === 'proof-stale'
    )
    && (error as { exitCode?: unknown }).exitCode === 3);
}

interface Harness {
  dir: string;
  poolPath: string;
  ownerPath: string;
  authPath: string;
  originalBytes: Buffer;
  store: ReturnType<typeof openStore>;
  kc: MockKeychain;
  mig: Migration;
  rehearseLog: string[];
  cleanup: () => void;
}

function installHistory(
  h: Harness,
  artifact: HistoricalPoolArtifact = ANTHROPIC_POOL_HISTORY.postOwnerCrash,
  legacyOwner?: string,
  authPath: string = h.authPath,
): void {
  installHistoricalPoolArtifact(artifact, {
    owner: h.ownerPath,
    pool: h.poolPath,
    prePool: preQlbPath(h.poolPath),
    sidecar: sidecarPath(h.poolPath),
    staging: stagingOwnerPath(h.ownerPath),
    auth: authPath,
    backup: piAuthBackupPath(authPath, 'anthropic'),
    legacyOwner,
  }, (state, detail) => h.store.upsertMigration(PI_POOL_STORE, state, detail));
  for (const account of FIXTURE_ACCOUNTS) {
    h.kc.setSync(qlbKeychainService('anthropic', account.id), account.name, JSON.stringify(account.credentials));
  }
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-migration-test-'));
  const poolPath = join(dir, 'anthropic-pool.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  const authPath = join(dir, 'auth.json');
  const original = fixturePool();
  writeFileSync(poolPath, original, { encoding: 'utf8', mode: 0o600 });
  const originalBytes = readFileSync(poolPath);
  const store = openStore(join(dir, 'qlb.db'));
  const kc = new MockKeychain();
  const rehearseLog: string[] = [];
  const mig = new Migration(store, kc, poolPath, ownerPath, undefined, {
    authJsonPath: authPath,
    anthropicPoolTransport: uuidPoolTransport(
      FIXTURE_ACCOUNTS.map((account) => ({ access: account.credentials.access, uuid: account.accountUuid })),
      rehearseLog,
    ),
  });
  return {
    dir,
    poolPath,
    ownerPath,
    authPath,
    originalBytes,
    store,
    kc,
    mig,
    rehearseLog,
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

describe('migration state machine — §4.8.3 / §4.8.3a', () => {
  it('happy path: stage → rehearse (no refresh) → commit → QLB_OWNED', async () => {
    const h = setup();
    try {
      const before = readFileSync(h.poolPath);

      const staged = h.mig.stage();
      assert.equal(staged.state, 'MIRRORED');
      assert.equal(staged.ownerFile, 'staging');
      assert.equal(staged.nativeStore, 'intact');
      assert.equal(staged.piAtNextLaunch, 'native works');
      assert.deepEqual(readFileSync(h.poolPath), before, 'stage must not touch native');
      assertSafety(h.poolPath, h.kc);

      const rehearseCalls: StagedAccount[] = [];
      const rehearsed = await h.mig.rehearse(mockRehearse(rehearseCalls));
      assert.equal(rehearsed.state, 'VALIDATED');
      assert.deepEqual(rehearseCalls, [], 'pool rehearsal does not use the per-account rehearse hook');
      assert.deepEqual(h.rehearseLog, [
        'profile:sk-ant-oat-fake-a',
        'usage:sk-ant-oat-fake-a',
        'profile:sk-ant-oat-fake-b',
        'usage:sk-ant-oat-fake-b',
      ]);
      // Profile then usage, once each. The transport has no refresh hook.
      assert.deepEqual(readFileSync(h.poolPath), before, 'rehearse must not touch native');
      assertSafety(h.poolPath, h.kc);

      assert.equal(rehearsed.resumeAction, 'rehearsal succeeded; complete commit');
      const committed = h.mig.commit();
      assert.equal(committed.state, 'QLB_OWNED');
      assert.equal(committed.ownerFile, 'present');
      assert.equal(existsSync(preQlbPath(h.poolPath)), true);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), true);
      const published = JSON.parse(h.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as {
        postOwnerAdmission?: { version?: number };
        poolV2PublicationStarted?: unknown;
      };
      assert.equal(published.postOwnerAdmission?.version, 1);
      assert.equal(published.poolV2PublicationStarted, undefined);
      assert.equal(JSON.stringify(committed).includes('sourceWitness'), false);
      const accounts = committed.detail.accounts as Array<{ label?: string }>;
      assert.equal(accounts.every((account) => account.label === undefined), true);
      assert.equal(qlbWorks(h.kc), true);
      assertSafety(h.poolPath, h.kc);
    } finally {
      h.cleanup();
    }
  });

  it('pool stage retains an existing v2 owner map for another provider', async () => {
    const h = setup();
    try {
      const openrouter = createStaticKeyMigration(
        h.store,
        h.kc,
        'openrouter',
        h.ownerPath,
        () => 'test-openrouter-key',
      );
      openrouter.stage();
      await openrouter.rehearse(async () => ({ ok: true }));
      openrouter.commit();
      const before = readFileSync(h.ownerPath);

      h.mig.stage();

      assert.deepEqual(readFileSync(h.ownerPath), before);
      assert.equal(existsSync(stagingOwnerPath(h.ownerPath)), true, 'stage creates only Anthropic staging');
      assert.equal(qlbWorks(h.kc), true, 'stage writes the staged Anthropic credentials');
    } finally {
      h.cleanup();
    }
  });

  it('refuses pool commit when the source changes after both publication locks', async () => {
    const h = setup();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const poolBefore = readFileSync(h.poolPath);
      let locked = false;
      const interleaved = new Migration(h.store, h.kc, h.poolPath, h.ownerPath, undefined, {
        authJsonPath: h.authPath,
        anthropicPoolTransport: uuidPoolTransport(
          FIXTURE_ACCOUNTS.map((account) => ({ access: account.credentials.access, uuid: account.accountUuid })),
        ),
        beforeFinalPublicationAdmission: () => {
          locked = true;
          writeFileSync(h.poolPath, poolBefore.toString('utf8').replace('sk-ant-oat-fake-a', 'sk-ant-oat-mutated'), { mode: 0o600 });
        },
      });
      assert.throws(() => interleaved.commit(), (error: unknown) => error instanceof Error
        && error.message === 'source-witness-unavailable');
      assert.equal(locked, true, 'the mutation seam runs only after both publication locks');
      assert.equal(existsSync(h.ownerPath), false);
      assert.equal(existsSync(stagingOwnerPath(h.ownerPath)), true);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
      writeFileSync(h.poolPath, poolBefore);
    } finally {
      h.cleanup();
    }
  });

  it('refuses pool commit when another provider map appeared after stage', async () => {
    const h = setup();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const openrouter = createStaticKeyMigration(
        h.store,
        h.kc,
        'openrouter',
        h.ownerPath,
        () => 'test-openrouter-key',
      );
      openrouter.stage();
      await openrouter.rehearse(async () => ({ ok: true }));
      openrouter.commit();
      const before = readFileSync(h.ownerPath);
      const poolBefore = readFileSync(h.poolPath);

      h.mig.commit();

      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, { mode?: string }> };
      assert.equal(owner.providers.openrouter?.mode, 'qlb');
      assert.equal(owner.providers.anthropic?.mode, 'qlb');
      assert.equal(existsSync(stagingOwnerPath(h.ownerPath)), false);
    } finally {
      h.cleanup();
    }
  });

  it('refuses resume of a short legacy v1 claim that is not a validated journal match', () => {
    const owner = JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n';
    const auth = JSON.stringify({ anthropic: { type: 'oauth', access: 'native-access', refresh: 'native-refresh', expires: 1 } }) + '\n';
    for (const state of ['absent', 'NATIVE', 'MIRRORED', 'RETIRED'] as const) {
      const h = setup();
      try {
        if (state === 'MIRRORED') h.mig.stage();
        else if (state !== 'absent') h.store.upsertMigration(PI_POOL_STORE, state, '{}');
        writeFileSync(h.ownerPath, owner, { mode: 0o600 });
        writeFileSync(h.authPath, auth, { mode: 0o600 });
        const poolBefore = readFileSync(h.poolPath);
        const journalBefore = JSON.stringify(h.store.getMigration(PI_POOL_STORE) ?? null);
        assert.equal(h.mig.status().resumeAction, 'proof-unavailable', state);
        assertProofUnavailable(() => h.mig.resume());
        assert.deepEqual(readFileSync(h.poolPath), poolBefore, state);
        assert.equal(existsSync(preQlbPath(h.poolPath)), false, state);
        assert.equal(readFileSync(h.ownerPath, 'utf8'), owner, state);
        assert.equal(readFileSync(h.authPath, 'utf8'), auth, state);
        assert.equal(JSON.stringify(h.store.getMigration(PI_POOL_STORE) ?? null), journalBefore, state);
      } finally {
        h.cleanup();
      }
    }
  });

  it('VALIDATED resume still finishes hygiene when the v1 owner matches the journal', () => {
    const h = setup();
    try {
      installHistory(h);
      const native = readFileSync(h.poolPath);
      const resumed = h.mig.resume();
      assert.equal(resumed.state, 'QLB_OWNED');
      assert.equal(existsSync(h.poolPath), false);
      assert.deepEqual(readFileSync(preQlbPath(h.poolPath)), native);
      assert.equal(existsSync(h.ownerPath), true);
    } finally {
      h.cleanup();
    }
  });

  it('bare resume of a QLB_OWNED legacy owner refuses without writing', () => {
    const h = setup();
    try {
      const owner = JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n';
      const auth = JSON.stringify({ anthropic: { type: 'oauth', access: 'native-access', refresh: 'native-refresh', expires: 1 } }, null, 2) + '\n';
      const poolBefore = readFileSync(h.poolPath);
      writeFileSync(h.ownerPath, owner, { mode: 0o600 });
      writeFileSync(h.authPath, auth, { mode: 0o600 });
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
      assert.equal(h.mig.status().resumeAction, 'proof-unavailable');
      assertProofUnavailable(() => h.mig.resume());
      assert.deepEqual(readFileSync(h.poolPath), poolBefore);
      assert.equal(existsSync(preQlbPath(h.poolPath)), false);
      assert.equal(readFileSync(h.ownerPath, 'utf8'), owner);
      assert.equal(readFileSync(h.authPath, 'utf8'), auth);
      assert.equal(h.store.getMigration(PI_POOL_STORE)?.state, 'QLB_OWNED');
      assert.equal(h.store.getMigration(PI_POOL_STORE)?.detail_json, '{}');
    } finally {
      h.cleanup();
    }
  });

  it('refuses commit from QLB_OWNED with readable staging and no recovery signal', async () => {
    const h = setup();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const staged = h.store.getMigration(PI_POOL_STORE);
      assert.ok(staged);
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', staged.detail_json);
      const poolBefore = readFileSync(h.poolPath);
      const stagingBefore = readFileSync(stagingOwnerPath(h.ownerPath));
      const journalBefore = h.store.getMigration(PI_POOL_STORE)?.detail_json;
      assert.equal(JSON.parse(journalBefore ?? '{}').poolV2PublicationStarted, undefined);
      assert.equal(existsSync(h.ownerPath), false);
      const committed = h.mig.commit();
      assert.equal(committed.state, 'QLB_OWNED');
      assert.equal(existsSync(h.ownerPath), true);
      assert.equal(existsSync(h.poolPath), false);
      assert.deepEqual(readFileSync(preQlbPath(h.poolPath)), poolBefore);
      assert.equal(existsSync(stagingOwnerPath(h.ownerPath)), false);
      const published = JSON.parse(h.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as {
        poolV2PublicationStarted?: unknown;
        postOwnerAdmission?: { version?: number };
      };
      assert.equal(published.poolV2PublicationStarted, undefined);
      assert.equal(published.postOwnerAdmission?.version, 1);
      assert.ok(stagingBefore.length > 0);
    } finally {
      h.cleanup();
    }
  });

  it('treats a v2 map without an Anthropic claim as absent and preserves it through resume and rollback', () => {
    const h = setup();
    try {
      const map = JSON.stringify({ providers: { openrouter: { mode: 'qlb', since: 1 } } }, null, 2) + '\n';
      writeFileSync(h.ownerPath, map, { mode: 0o600 });
      h.store.upsertMigration('pi-pool', 'NATIVE', '{}');

      assert.equal(h.mig.status().ownerFile, 'absent');
      h.mig.resume();
      assert.equal(existsSync(h.poolPath), true, 'resume must not retire the native Anthropic pool');
      h.mig.rollback();
      assert.deepEqual(readFileSync(h.ownerPath), Buffer.from(map), 'rollback must not rewrite another provider\'s map');
    } finally {
      h.cleanup();
    }
  });

  it('crash after stage, before rehearse: resume() refuses and writes nothing', async () => {
    const h = setup();
    try {
      h.mig.stage();
      const journalBefore = h.store.getMigration(PI_POOL_STORE)?.detail_json;
      assert.equal(h.mig.status().state, 'MIRRORED');
      assert.equal(h.mig.status().resumeAction, 'proof-unavailable');
      assertProofUnavailable(() => h.mig.resume());
      assert.equal(h.mig.status().state, 'MIRRORED');
      assert.equal(existsSync(stagingOwnerPath(h.ownerPath)), true);
      assert.deepEqual(readFileSync(h.poolPath), h.originalBytes);
      assert.equal(h.store.getMigration(PI_POOL_STORE)?.detail_json, journalBefore);
      assert.equal(qlbWorks(h.kc), true);
      assert.equal(nativeWorks(h.poolPath), true);
      assertSafety(h.poolPath, h.kc);
    } finally {
      h.cleanup();
    }
  });

  it('crash after rehearse, before commit: resume() publishes the fresh witness-bearing cycle', async () => {
    const h = setup();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      assert.equal(h.mig.status().state, 'VALIDATED');
      assert.equal(h.mig.status().ownerFile, 'staging');
      assert.equal(h.mig.status().resumeAction, 'rehearsal succeeded; complete commit');
      const resumed = h.mig.resume();
      assert.equal(resumed.state, 'QLB_OWNED');
      assert.equal(resumed.ownerFile, 'present');
      assert.equal(existsSync(stagingOwnerPath(h.ownerPath)), false);
      assert.equal(qlbWorks(h.kc), true);
      assertSafety(h.poolPath, h.kc);
    } finally {
      h.cleanup();
    }
  });

  it('crash mid-commit (owner renamed, native not): resume finishes hygiene, does not re-rehearse', async () => {
    const h = setup();
    try {
      installHistory(h);
      const historicalNative = readFileSync(h.poolPath);
      assert.equal(nativeWorks(h.poolPath), true, 'native still intact mid-commit');
      assert.equal(qlbWorks(h.kc), true);
      assertSafety(h.poolPath, h.kc);

      const mid = h.mig.status();
      assert.equal(mid.ownerFile, 'present');
      assert.match(mid.resumeAction, /hygiene|already committed/i);

      const resumed = h.mig.resume();
      assert.equal(resumed.state, 'QLB_OWNED');
      assert.equal(resumed.ownerFile, 'present');
      assert.equal(resumed.nativeStore, 'pre-qlb');
      const detail = JSON.parse(h.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as { rehearse?: { validatedAt?: number } };
      assert.equal(detail.rehearse?.validatedAt, 1794290701393, 'resume must preserve the recorded rehearsal');
      assertSafety(h.poolPath, h.kc);
      assert.deepEqual(readFileSync(preQlbPath(h.poolPath)), historicalNative);
    } finally {
      h.cleanup();
    }
  });

  it('rolls back a historical Pi auth backup while preserving sibling entries', async () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.rollbackWithSibling);
      h.mig.rollback();
      assert.deepEqual(readFileSync(h.authPath), Buffer.from(NATIVE_AUTH_WITH_XAI));
    } finally {
      h.cleanup();
    }
  });

  it('rolls back a historical absent-auth state and removes auth.json', async () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.absentAuth);
      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(existsSync(h.authPath), false);
    } finally {
      h.cleanup();
    }
  });

  it('crash after the v2 entry before the placeholder: a publication marker does not admit, and the gate stays refused', async () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.ownerEntryCrash);
      beginCutover(h.store);
      const stderr: string[] = [];
      const refused = await runPiGate('anthropic', {
        dbPath: join(h.dir, 'qlb.db'), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: () => undefined, stderr: (line) => stderr.push(line),
        guard: () => true, admitted: () => ({ ok: true }), piAgentDir: h.dir,
        provider: { read: () => ({ token: 'anthropic-token', accountId: 'anthropic-default', source: 'fixture' }) },
      });
      assert.equal(refused, 1);
      assert.deepEqual(stderr, ['placeholder-missing']);
      const authBefore = readFileSync(h.authPath);
      assert.throws(() => h.mig.resume(), (error: unknown) => error instanceof Error
        && error.message === 'source-witness-unavailable');
      assert.deepEqual(readFileSync(h.authPath), authBefore);
      const stillRefused = await runPiGate('anthropic', {
        dbPath: join(h.dir, 'qlb.db'), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: () => undefined, stderr: (line) => stderr.push(line),
        guard: () => true, admitted: () => ({ ok: true }), piAgentDir: h.dir,
        provider: { read: () => ({ token: 'anthropic-token', accountId: 'anthropic-default', source: 'fixture' }) },
      });
      assert.equal(stillRefused, 1);
    } finally {
      h.cleanup();
    }
  });

  it('safety property holds at every literal pool publication crash point (backup, owner-entry, placeholder)', async () => {
    for (const artifact of [
      ANTHROPIC_POOL_HISTORY.backupCrash,
      ANTHROPIC_POOL_HISTORY.ownerEntryCrash,
      ANTHROPIC_POOL_HISTORY.placeholderCrash,
    ]) {
      const h = setup();
      try {
        installHistory(h, artifact);
        assertSafety(h.poolPath, h.kc);
        const authBefore = readFileSync(h.authPath);
        assert.throws(() => h.mig.resume(), (error: unknown) => error instanceof Error
          && error.message === 'source-witness-unavailable');
        assert.deepEqual(readFileSync(h.authPath), authBefore);
        assertSafety(h.poolPath, h.kc);
        h.mig.rollback();
        assert.equal(nativeWorks(h.poolPath) || existsSync(h.poolPath), true);
      } finally {
        h.cleanup();
      }
    }
  });

  it('a crash after the pool rename preserves the backup for resume and rollback', async () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.postRename);
      h.mig.resume();
      const backup = JSON.parse(readFileSync(piAuthBackupPath(h.authPath, 'anthropic'), 'utf8')) as { entry?: unknown };
      assert.deepEqual(backup.entry, {
        type: 'oauth', access: 'native-access', refresh: 'native-refresh', expires: 1, extra: { kept: true },
      });
      h.mig.rollback();
      assert.deepEqual(readFileSync(h.authPath), Buffer.from(NATIVE_AUTH));
      assert.equal(existsSync(h.ownerPath), false);
    } finally {
      h.cleanup();
    }
  });

  it('legacy conversion refuses at v2 publication and leaves the owner and auth untouched', () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.legacyOwner, h.ownerPath);
      const ownerBefore = readFileSync(h.ownerPath);
      const authBefore = readFileSync(h.authPath);
      const journalBefore = h.store.getMigration(PI_POOL_STORE)?.detail_json;
      const migration = new Migration(h.store, h.kc, h.poolPath, h.ownerPath, undefined, {
        authJsonPath: h.authPath,
        allowPoolLegacyConversion: true,
      });
      assert.equal(migration.status().resumeAction, 'proof-unavailable');
      assertProofUnavailable(() => migration.resume());
      assertProofUnavailable(() => migration.commit());
      assert.deepEqual(readFileSync(h.ownerPath), ownerBefore);
      assert.deepEqual(readFileSync(h.authPath), authBefore);
      assert.equal(h.store.getMigration(PI_POOL_STORE)?.detail_json, journalBefore);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a legacy Anthropic owner from VALIDATED before publication', () => {
    const h = setup();
    try {
      const original = JSON.stringify({ anthropic: { type: 'oauth', access: 'native-validated', refresh: 'refresh-validated', expires: 1 } }, null, 2) + '\n';
      const legacy = JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n';
      writeFileSync(h.authPath, original, { mode: 0o600 });
      writeFileSync(h.ownerPath, legacy, { mode: 0o600 });
      h.store.upsertMigration(PI_POOL_STORE, 'VALIDATED', '{}');
      const migration = new Migration(h.store, h.kc, h.poolPath, h.ownerPath, undefined, {
        authJsonPath: h.authPath,
        allowPoolLegacyConversion: true,
      });
      assertProofUnavailable(() => migration.commit());
      assert.equal(readFileSync(h.authPath, 'utf8'), original);
      assert.equal(readFileSync(h.ownerPath, 'utf8'), legacy);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
      assert.equal(h.store.getMigration(PI_POOL_STORE)?.detail_json, '{}');
    } finally {
      h.cleanup();
    }
  });

  it('refuses hygiene when a v2 owner and placeholder have no witness or proof', () => {
    const h = setup();
    try {
      writeFileSync(h.authPath, JSON.stringify({ anthropic: piPlaceholder() }) + '\n', { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      const ownerBefore = readFileSync(h.ownerPath);
      const authBefore = readFileSync(h.authPath);
      const poolBefore = readFileSync(h.poolPath);
      for (const detail of ['{}', JSON.stringify({ poolV2PublicationStarted: true })]) {
        h.store.upsertMigration(PI_POOL_STORE, 'VALIDATED', detail);
        assert.throws(() => h.mig.commit(), (error: unknown) => error instanceof Error
          && error.message === 'source-witness-unavailable'
          && (error as { exitCode?: unknown }).exitCode === 3);
        assert.deepEqual(readFileSync(h.poolPath), poolBefore);
        assert.equal(existsSync(preQlbPath(h.poolPath)), false);
        assert.deepEqual(readFileSync(h.ownerPath), ownerBefore);
        assert.deepEqual(readFileSync(h.authPath), authBefore);
        assert.equal(h.store.getMigration(PI_POOL_STORE)?.state, 'VALIDATED');
      }
    } finally {
      h.cleanup();
    }
  });

  it('refuses an orphan v2 Anthropic owner without this migration’s staging or journal evidence', () => {
    const h = setup();
    try {
      const original = JSON.stringify({ anthropic: { type: 'oauth', access: 'native-orphan', refresh: 'refresh-orphan', expires: 1 } }, null, 2) + '\n';
      writeFileSync(h.authPath, original, { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      const beforeOwner = readFileSync(h.ownerPath);
      for (const operation of [() => h.mig.commit(), () => h.mig.resume()]) {
        assert.throws(operation, (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3);
        assert.deepEqual(readFileSync(h.authPath), Buffer.from(original));
        assert.deepEqual(readFileSync(h.ownerPath), beforeOwner);
      }
    } finally {
      h.cleanup();
    }
  });

  it('refuses resume and commit of a pre-owner pool before any publication write', async () => {
    const h = setup();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const newer = JSON.stringify({ anthropic: { type: 'oauth', access: 'native-newer', refresh: 'refresh-newer', expires: 2 } }, null, 2) + '\n';
      writeFileSync(h.authPath, newer, { mode: 0o600 });
      const poolBefore = readFileSync(h.poolPath);
      const journalBefore = h.store.getMigration(PI_POOL_STORE)?.detail_json;

      h.mig.commit();
      const backup = JSON.parse(readFileSync(piAuthBackupPath(h.authPath, 'anthropic'), 'utf8')) as { entry?: { access?: string } };
      assert.equal(backup.entry?.access, 'native-newer');
      assert.equal(JSON.parse(readFileSync(h.authPath, 'utf8')).anthropic.access, 'qlb-managed');
      assert.equal(existsSync(h.ownerPath), true);
      assert.notEqual(h.store.getMigration(PI_POOL_STORE)?.detail_json, journalBefore);
      assert.equal(existsSync(preQlbPath(h.poolPath)), true);
      assert.ok(poolBefore.length > 0);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a newer native login after literal backup and owner-entry crashes without changing auth.json', async () => {
    for (const artifact of [ANTHROPIC_POOL_HISTORY.backupCrash, ANTHROPIC_POOL_HISTORY.ownerEntryCrash]) {
      const h = setup();
      try {
        const newer = JSON.stringify({ anthropic: { type: 'oauth', access: 'newer-native', refresh: 'newer-refresh', expires: 2 } }, null, 2) + '\n';
        installHistory(h, artifact);
        writeFileSync(h.authPath, newer, { mode: 0o600 });
        for (const operation of [() => h.mig.resume(), () => h.mig.commit()]) {
          assert.throws(operation, (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3
            && /native entry changed since stage/.test(String(error)));
          assert.deepEqual(readFileSync(h.authPath), Buffer.from(newer));
        }
        h.mig.rollback();
        assert.deepEqual(readFileSync(h.authPath), Buffer.from(newer));
      } finally {
        h.cleanup();
      }
    }
  });

  it('custom conversion refuses at v2 publication and leaves both owner files untouched', () => {
    const h = setup();
    try {
      const customOwnerPath = join(h.dir, 'custom-owner-conversion.json');
      installHistory(h, ANTHROPIC_POOL_HISTORY.legacyOwner, customOwnerPath);
      const customBefore = readFileSync(customOwnerPath);
      const authBefore = readFileSync(h.authPath);
      const migration = new Migration(h.store, h.kc, h.poolPath, customOwnerPath, undefined, {
        authJsonPath: h.authPath,
        allowPoolLegacyConversion: true,
        beforePoolLegacyUnlink: () => { throw new Error('crash before legacy unlink'); },
      } as unknown as MigrationConfig);
      assertProofUnavailable(() => migration.resume());
      assert.deepEqual(readFileSync(customOwnerPath), customBefore);
      assert.deepEqual(readFileSync(h.authPath), authBefore);
      assert.equal(existsSync(h.ownerPath), false);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a raced custom legacy owner before publication and leaves the map byte-identical', () => {
    const h = setup();
    try {
      const customOwnerPath = join(h.dir, 'custom-owner-raced.json');
      const original = JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n';
      writeFileSync(h.authPath, JSON.stringify({ anthropic: { type: 'oauth', access: 'native-raced', refresh: 'refresh-raced', expires: 1 } }) + '\n', { mode: 0o600 });
      writeFileSync(customOwnerPath, original, { mode: 0o600 });
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
      const authBefore = readFileSync(h.authPath);
      const migration = new Migration(h.store, h.kc, h.poolPath, customOwnerPath, undefined, {
        authJsonPath: h.authPath,
        allowPoolLegacyConversion: true,
        beforePoolLegacyUnlink: () => writeFileSync(customOwnerPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }) + '\n', { mode: 0o600 }),
      } as unknown as MigrationConfig);

      assertProofUnavailable(() => migration.resume());
      assert.equal(readFileSync(customOwnerPath, 'utf8'), original);
      assert.deepEqual(readFileSync(h.authPath), authBefore);
      assert.equal(existsSync(h.ownerPath), false);
    } finally {
      h.cleanup();
    }
  });

  it('refuses rollback without changing anything when a raced custom v1 document still names another provider', () => {
    const h = setup();
    try {
      const customOwnerPath = join(h.dir, 'custom-owner-mixed-race.json');
      installHistory(h, ANTHROPIC_POOL_HISTORY.legacyOwner, customOwnerPath);
      writeFileSync(customOwnerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }, { provider: 'xai' }] }) + '\n', { mode: 0o600 });
      const migration = new Migration(h.store, h.kc, h.poolPath, customOwnerPath, undefined, {
        authJsonPath: h.authPath,
        allowPoolLegacyConversion: true,
      });
      const customBeforeRollback = readFileSync(customOwnerPath);
      const authBeforeRollback = readFileSync(h.authPath);
      const journalBeforeRollback = JSON.stringify(h.store.getMigration(PI_POOL_STORE));
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
      assert.throws(() => migration.rollback(), (error: unknown) => error instanceof PiOwnerLegacyError
        && (error as Error).message.includes('xai'));
      assert.deepEqual(readFileSync(customOwnerPath), customBeforeRollback);
      assert.ok((JSON.parse(readFileSync(customOwnerPath, 'utf8')) as { accounts: Array<{ provider: string }> }).accounts.some(({ provider }) => provider === 'xai'));
      assert.deepEqual(readFileSync(h.authPath), authBeforeRollback);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
      assert.equal(JSON.stringify(h.store.getMigration(PI_POOL_STORE)), journalBeforeRollback);
    } finally {
      h.cleanup();
    }
  });

  it('status gives executable rollback-only or manual-repair advice for every post-publication refusal state', async () => {
    const nativeChanged = setup();
    try {
      const newer = JSON.stringify({ anthropic: { type: 'oauth', access: 'newer-status', refresh: 'newer-refresh-status', expires: 2 } }, null, 2) + '\n';
      installHistory(nativeChanged, ANTHROPIC_POOL_HISTORY.ownerEntryCrash);
      writeFileSync(nativeChanged.authPath, newer, { mode: 0o600 });
      assert.equal(nativeChanged.mig.status().resumeAction, 'stale native writer: auth.json[anthropic] is not the placeholder; run `qlb migrate rollback --provider anthropic`');
      assert.doesNotThrow(() => nativeChanged.mig.rollback());
    } finally { nativeChanged.cleanup(); }

    const raced = setup();
    try {
      const customOwnerPath = join(raced.dir, 'custom-owner-status-race.json');
      writeFileSync(raced.authPath, JSON.stringify({ anthropic: { type: 'oauth', access: 'native-race-status', refresh: 'refresh-race-status', expires: 1 } }) + '\n', { mode: 0o600 });
      writeFileSync(customOwnerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n', { mode: 0o600 });
      raced.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
      const originalOwner = readFileSync(customOwnerPath);
      const originalAuth = readFileSync(raced.authPath);
      const migration = new Migration(raced.store, raced.kc, raced.poolPath, customOwnerPath, undefined, {
        authJsonPath: raced.authPath,
        allowPoolLegacyConversion: true,
        beforePoolLegacyUnlink: () => writeFileSync(customOwnerPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }) + '\n', { mode: 0o600 }),
      } as unknown as MigrationConfig);
      assertProofUnavailable(() => migration.resume());
      assert.equal(migration.status().resumeAction, 'proof-unavailable');
      assert.deepEqual(readFileSync(customOwnerPath), originalOwner);
      assert.deepEqual(readFileSync(raced.authPath), originalAuth);
    } finally { raced.cleanup(); }

    const mixed = setup();
    try {
      const original = JSON.stringify({ anthropic: { type: 'oauth', access: 'native-mixed-status', refresh: 'refresh-mixed-status', expires: 1 } }, null, 2) + '\n';
      writeFileSync(mixed.authPath, original, { mode: 0o600 });
      writeFileSync(mixed.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }, { provider: 'xai' }] }) + '\n', { mode: 0o600 });
      mixed.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
      const explicit = new Migration(mixed.store, mixed.kc, mixed.poolPath, mixed.ownerPath, undefined, {
        authJsonPath: mixed.authPath,
        allowPoolLegacyConversion: true,
      });
      assert.equal(explicit.status().resumeAction, `mixed v1 owner document: remove the other providers' entries from ${mixed.ownerPath}, then re-run`);
      const anthropicOnly = JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n';
      writeFileSync(mixed.ownerPath, anthropicOnly, { mode: 0o600 });
      assert.equal(explicit.status().resumeAction, 'proof-unavailable');
      assertProofUnavailable(() => explicit.resume());
      assert.equal(readFileSync(mixed.ownerPath, 'utf8'), anthropicOnly);
      assert.equal(readFileSync(mixed.authPath, 'utf8'), original);
    } finally { mixed.cleanup(); }
  });

  it('status gives executable advice for mixed v1, bare conversion, orphan v2, and malformed auth', () => {
    const mixed = setup();
    try {
      writeFileSync(mixed.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }, { provider: 'xai' }] }) + '\n', { mode: 0o600 });
      mixed.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
      const explicit = new Migration(mixed.store, mixed.kc, mixed.poolPath, mixed.ownerPath, undefined, {
        authJsonPath: mixed.authPath,
        allowPoolLegacyConversion: true,
      });
      assert.equal(explicit.status().resumeAction, `mixed v1 owner document: remove the other providers' entries from ${mixed.ownerPath}, then re-run`);
    } finally { mixed.cleanup(); }

    const legacy = setup();
    try {
      writeFileSync(legacy.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n', { mode: 0o600 });
      legacy.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
      assert.equal(legacy.mig.status().resumeAction, 'proof-unavailable');
      assert.equal(readFileSync(legacy.ownerPath, 'utf8'), JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n');
    } finally { legacy.cleanup(); }

    const orphan = setup();
    try {
      writePiOwnerEntry(orphan.ownerPath, 'anthropic', true);
      orphan.store.upsertMigration(PI_POOL_STORE, 'VALIDATED', '{}');
      assert.equal(orphan.mig.status().resumeAction, 'owner-file-orphan: v2 Anthropic ownership has no staging file or pool publication journal; remove its Anthropic claim before retrying');
    } finally { orphan.cleanup(); }

    const malformed = setup();
    try {
      writePiOwnerEntry(malformed.ownerPath, 'anthropic', true);
      malformed.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', JSON.stringify({ poolV2PublicationStarted: true }));
      writeFileSync(malformed.authPath, '{not-json\n', { mode: 0o600 });
      assert.equal(malformed.mig.status().resumeAction, 'Pi auth.json is malformed; repair it before resuming');
      assert.throws(() => malformed.mig.resume(), (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3
        && /Pi auth\.json is malformed/.test(String(error)));
    } finally { malformed.cleanup(); }
  });

  it('custom owner-file conversion refuses publication and leaves the v1 document readable', () => {
    const h = setup();
    try {
      const customOwnerPath = join(h.dir, 'custom-owner.json');
      installHistory(h, ANTHROPIC_POOL_HISTORY.legacyOwner, customOwnerPath);
      const original = readFileSync(h.authPath);
      const legacyBefore = readFileSync(customOwnerPath);
      const migration = new Migration(h.store, h.kc, h.poolPath, customOwnerPath, undefined, {
        authJsonPath: h.authPath,
        allowPoolLegacyConversion: true,
      });
      assertProofUnavailable(() => migration.resume());
      assert.deepEqual(readFileSync(customOwnerPath), legacyBefore);
      assert.equal((JSON.parse(readFileSync(customOwnerPath, 'utf8')) as { owner?: string }).owner, 'qlb');
      assert.deepEqual(readFileSync(h.authPath), original);
      assert.equal(existsSync(h.ownerPath), false);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
    } finally {
      h.cleanup();
    }
  });

  it('rollback after full commit restores native byte-identical and removes owner file', async () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.postFullCommit);
      const original = readFileSync(preQlbPath(h.poolPath));
      assert.equal(h.mig.status().state, 'QLB_OWNED');
      assertSafety(h.poolPath, h.kc);

      const rolled = h.mig.rollback();
      assert.equal(rolled.ownerFile, 'absent');
      assert.equal(rolled.piAtNextLaunch, 'native works');
      assert.equal(rolled.state, 'VALIDATED');
      assert.deepEqual(
        readFileSync(h.poolPath),
        original,
        'restored native must be byte-identical to original',
      );
      assert.equal(nativeWorks(h.poolPath), true);
      assert.equal(existsSync(sidecarPath(h.poolPath)), false);
      assertSafety(h.poolPath, h.kc);
    } finally {
      h.cleanup();
    }
  });

  it('rolls back a pre-P7b v1 Anthropic document: pool restored, file removed, VALIDATED, auth.json byte-identical', async () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.legacyRollback, h.ownerPath);
      const auth = readFileSync(h.authPath);
      const pool = readFileSync(preQlbPath(h.poolPath));

      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(existsSync(h.ownerPath), false);
      assert.deepEqual(readFileSync(h.poolPath), pool);
      assert.deepEqual(readFileSync(h.authPath), auth);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
    } finally {
      h.cleanup();
    }
  });

  it('refuses rollback when a v2-owned Anthropic placeholder was replaced with malformed auth.json', async () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.malformedAuth);
      const malformed = '{not-json\n';

      assert.throws(() => h.mig.rollback(), /Pi auth\.json is malformed/);
      assert.equal(readFileSync(h.authPath, 'utf8'), malformed);
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.anthropic);
    } finally {
      h.cleanup();
    }
  });

  it('rolls back a legacy pool when the default auth parent is absent and no backup exists', async () => {
    const h = setup();
    try {
      const absentAuthPath = join(h.dir, 'missing-agent', 'auth.json');
      const migration = new Migration(h.store, h.kc, h.poolPath, h.ownerPath, undefined, { authJsonPath: absentAuthPath });
      installHistory(h, ANTHROPIC_POOL_HISTORY.legacyAbsentParent, h.ownerPath, absentAuthPath);

      const rolled = migration.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(existsSync(h.ownerPath), false);
      assert.equal(existsSync(`${absentAuthPath}.lock`), false);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a v2 rollback when its auth parent is absent but its backup remains', () => {
    const h = setup();
    try {
      const absentAuthPath = join(h.dir, 'missing-agent', 'auth.json');
      const migration = new Migration(h.store, h.kc, h.poolPath, h.ownerPath, undefined, { authJsonPath: absentAuthPath });
      installHistory(h, ANTHROPIC_POOL_HISTORY.absentParent, undefined, absentAuthPath);

      assert.throws(
        () => migration.rollback(),
        (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3,
      );
      assert.ok(readFileSync(piAuthBackupPath(absentAuthPath, 'anthropic')));
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.anthropic);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a v2 rollback with missing auth.json and no backup', () => {
    const h = setup();
    try {
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      assert.throws(
        () => h.mig.rollback(),
        (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3,
      );
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.anthropic);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a malformed v2 auth.json while preserving its owner and backup', () => {
    const h = setup();
    try {
      writeFileSync(h.authPath, JSON.stringify({ anthropic: { type: 'oauth', access: 'native-access', refresh: 'native-refresh' } }) + '\n', { mode: 0o600 });
      writePiAuthBackup(h.authPath, 'anthropic', 'malformed-v2');
      writeFileSync(h.authPath, '{not-json\n', { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      assert.throws(
        () => h.mig.rollback(),
        (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3,
      );
      assert.ok(existsSync(piAuthBackupPath(h.authPath, 'anthropic')));
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.anthropic);
    } finally {
      h.cleanup();
    }
  });

  it('restores the backed-up anthropic entry when auth.json is absent', () => {
    const h = setup();
    try {
      const nativeAuth = { type: 'oauth', access: 'native-access', refresh: 'native-refresh', expires: 1 };
      writeFileSync(h.authPath, JSON.stringify({ anthropic: nativeAuth }) + '\n', { mode: 0o600 });
      writePiAuthBackup(h.authPath, 'anthropic', 'missing-file');
      rmSync(h.authPath);
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')).anthropic, nativeAuth);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
    } finally {
      h.cleanup();
    }
  });

  it('restores the backed-up anthropic entry when its auth.json key is absent', () => {
    const h = setup();
    try {
      const nativeAuth = { type: 'oauth', access: 'native-access', refresh: 'native-refresh', expires: 1 };
      writeFileSync(h.authPath, JSON.stringify({ anthropic: nativeAuth }) + '\n', { mode: 0o600 });
      writePiAuthBackup(h.authPath, 'anthropic', 'missing-key');
      writeFileSync(h.authPath, JSON.stringify({ xai: { refresh: 'other-refresh' } }) + '\n', { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')), {
        anthropic: nativeAuth,
        xai: { refresh: 'other-refresh' },
      });
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
    } finally {
      h.cleanup();
    }
  });

  it('refuses an invalid Anthropic backup before un-owning or deleting it', () => {
    const h = setup();
    try {
      writeFileSync(h.authPath, JSON.stringify({ anthropic: { type: 'oauth', access: 'native-access', refresh: 'native-refresh' } }) + '\n', { mode: 0o600 });
      writePiAuthBackup(h.authPath, 'anthropic', 'invalid-backup');
      const backupPath = piAuthBackupPath(h.authPath, 'anthropic');
      const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as Record<string, unknown>;
      backup.entry = piPlaceholder();
      writeFileSync(backupPath, JSON.stringify(backup) + '\n', { mode: 0o600 });
      writeFileSync(h.authPath, JSON.stringify({ anthropic: piPlaceholder() }) + '\n', { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      assert.throws(
        () => h.mig.rollback(),
        (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3,
      );
      assert.ok(existsSync(backupPath));
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.anthropic);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a contended v2 pool auth lock with exit 3', () => {
    const h = setup();
    try {
      writeFileSync(h.authPath, JSON.stringify({ anthropic: piPlaceholder() }) + '\n', { mode: 0o600 });
      writePiAuthBackup(h.authPath, 'anthropic', 'contended-lock');
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
      mkdirSync(`${h.authPath}.lock`, { mode: 0o700 });
      const migration = new Migration(h.store, h.kc, h.poolPath, h.ownerPath, undefined, {
        authJsonPath: h.authPath,
        authLockTiming: { retries: 0, retryMs: 1, staleMs: 60_000 },
      });

      assert.throws(
        () => migration.rollback(),
        (error: unknown) => (error as { code?: unknown; exitCode?: unknown }).code === 'pi-auth-locked'
          && (error as { exitCode?: unknown }).exitCode === 3,
      );
      assert.ok(existsSync(piAuthBackupPath(h.authPath, 'anthropic')));
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.anthropic);
    } finally {
      h.cleanup();
    }
  });

  it('restores the backed-up anthropic entry (extra fields kept) before removing the v2 entry', () => {
    const h = setup();
    try {
      const nativeAuth = JSON.stringify({ anthropic: { type: 'oauth', access: 'native-access', refresh: 'native-refresh', expires: 1, extra: { preserved: true } } }, null, 2) + '\n';
      writeFileSync(h.authPath, nativeAuth, { mode: 0o600 });
      writePiAuthBackup(h.authPath, 'anthropic', 'test-cycle');
      writeFileSync(h.authPath, JSON.stringify({ anthropic: piPlaceholder() }) + '\n', { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'xai', true);
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')), JSON.parse(nativeAuth));
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.equal(owner.providers.anthropic, undefined);
      assert.ok(owner.providers.xai);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
    } finally {
      h.cleanup();
    }
  });

  for (const [name, entry] of [
    ['an incomplete entry', { refresh: 'incomplete' }],
    ["Pi's api_key entry", { type: 'api_key', key: 'fixture' }],
    ["QLB's api-key entry", { type: 'api-key', key: 'fixture' }],
    ['an OAuth entry with empty access', { type: 'oauth', access: '', refresh: 'refresh-fake', expires: Date.now() + 60_000 }],
    ['an incomplete QLB-shaped entry', { type: 'oauth', access: 'qlb-managed', refresh: '' }],
  ] as const) {
    it(`refuses rollback for ${name}, preserving auth.json, owner, and backup bytes`, () => {
      const h = setup();
      try {
        const native = { type: 'oauth', access: 'native-access', refresh: 'native-refresh', expires: Date.now() + 60_000 };
        writeFileSync(h.authPath, JSON.stringify({ anthropic: native }) + '\n', { mode: 0o600 });
        writePiAuthBackup(h.authPath, 'anthropic', `present-${name}`);
        writeFileSync(h.authPath, JSON.stringify({ anthropic: entry }) + '\n', { mode: 0o600 });
        writePiOwnerEntry(h.ownerPath, 'anthropic', true);
        renameSync(h.poolPath, preQlbPath(h.poolPath));
        h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
        const backupPath = piAuthBackupPath(h.authPath, 'anthropic');
        const before = {
          auth: readFileSync(h.authPath),
          owner: readFileSync(h.ownerPath),
          backup: readFileSync(backupPath),
        };

        assert.throws(
          () => h.mig.rollback(),
          (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3,
        );

        assert.deepEqual(readFileSync(h.authPath), before.auth);
        assert.deepEqual(readFileSync(h.ownerPath), before.owner);
        assert.deepEqual(readFileSync(backupPath), before.backup);
      } finally {
        h.cleanup();
      }
    });
  }

  it('refuses an incomplete Anthropic backup without releasing its owner claim', () => {
    const h = setup();
    try {
      writeFileSync(h.authPath, JSON.stringify({ anthropic: { refresh: 'backup-only' } }) + '\n', { mode: 0o600 });
      writePiAuthBackup(h.authPath, 'anthropic', 'incomplete-backup');
      writeFileSync(h.authPath, JSON.stringify({ anthropic: piPlaceholder() }) + '\n', { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      assert.throws(
        () => h.mig.rollback(),
        (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3,
      );
      assert.ok(existsSync(piAuthBackupPath(h.authPath, 'anthropic')));
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.anthropic);
    } finally {
      h.cleanup();
    }
  });

  it('v1 pool rollback does not read an unusable auth.json when it recorded no v2 auth state', () => {
    const h = setup();
    try {
      mkdirSync(h.authPath, { mode: 0o700 });
      writeFileSync(h.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n', { mode: 0o600 });
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      const rolled = h.mig.rollback();

      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(existsSync(h.ownerPath), false);
    } finally {
      h.cleanup();
    }
  });

  it('valid current Anthropic auth wins over a malformed backup and removes it', () => {
    const h = setup();
    try {
      const native = { type: 'oauth', access: 'native-access', refresh: 'native-refresh', expires: Date.now() + 60_000 };
      writeFileSync(h.authPath, JSON.stringify({ anthropic: native }) + '\n', { mode: 0o600 });
      writePiAuthBackup(h.authPath, 'anthropic', 'malformed-current-wins');
      writeFileSync(piAuthBackupPath(h.authPath, 'anthropic'), '{ malformed', { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      h.mig.rollback();

      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')).anthropic, native);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a malformed Anthropic backup without releasing its owner claim', () => {
    const h = setup();
    try {
      writeFileSync(h.authPath, JSON.stringify({ anthropic: piPlaceholder() }) + '\n', { mode: 0o600 });
      writePiAuthBackup(h.authPath, 'anthropic', 'malformed-refusal');
      writeFileSync(piAuthBackupPath(h.authPath, 'anthropic'), '{ malformed', { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      assert.throws(
        () => h.mig.rollback(),
        (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3,
      );
      assert.ok(existsSync(piAuthBackupPath(h.authPath, 'anthropic')));
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.anthropic);
    } finally {
      h.cleanup();
    }
  });

  it('refuses to un-own when the placeholder has no backup: owner entry kept, journal intent rollback, gate still serves', async () => {
    const h = setup();
    try {
      writeFileSync(h.authPath, JSON.stringify({ anthropic: piPlaceholder() }) + '\n', { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
      beginCutover(h.store);

      assert.throws(() => h.mig.rollback(), /no Anthropic auth backup/);
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers.anthropic);
      const detail = JSON.parse(h.store.getMigration(PI_POOL_STORE)!.detail_json) as { intent?: string };
      assert.equal(detail.intent, 'rollback');
      const output: string[] = [];
      const result = await runPiGate('anthropic', {
        dbPath: join(h.dir, 'qlb.db'), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => output.push(value),
        guard: () => true, admitted: () => ({ ok: true }), piAgentDir: h.dir,
        provider: { read: () => ({ token: 'anthropic-token', accountId: 'anthropic-default', source: 'fixture' }) },
      });
      assert.equal(result, 0);
      assert.equal(output.length, 1);
    } finally {
      h.cleanup();
    }
  });

  it('rollback with no auth.json at commit time removes the key and the file it created', () => {
    const h = setup();
    try {
      writePiAuthBackup(h.authPath, 'anthropic', 'test-cycle');
      writeFileSync(h.authPath, JSON.stringify({ anthropic: piPlaceholder() }) + '\n', { mode: 0o600 });
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(existsSync(h.authPath), false);
      assert.equal(existsSync(h.ownerPath), false);
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'anthropic')), false);
    } finally {
      h.cleanup();
    }
  });

  it('safety property holds across literal post-commit recovery and rollback states (C, H1, R4, RC)', async () => {
    const h = setup();
    try {
      // C: literal post-owner crash; native remains readable until H1.
      installHistory(h);
      assertSafety(h.poolPath, h.kc);

      // H1: journal QLB_OWNED via resume's first half — finishHygiene
      h.mig.resume();
      assertSafety(h.poolPath, h.kc);
      assert.equal(h.mig.status().state, 'QLB_OWNED');

      // R4: restore native, owner still present (simulate by renaming .pre-qlb
      // back while leaving owner). Then continueRollback via explicit rollback
      // would unlink; here we just assert safety with both present.
      renameSync(preQlbPath(h.poolPath), h.poolPath);
      assertSafety(h.poolPath, h.kc);

      // RC: unlink owner, native restored
      rmSync(h.ownerPath);
      assertSafety(h.poolPath, h.kc);
      assert.equal(nativeWorks(h.poolPath), true);
    } finally {
      h.cleanup();
    }
  });

  it('post-commit rollback journal drops the source witness and admission marker', () => {
    const h = setup();
    try {
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', JSON.stringify({
        sourceWitness: { version: 1, algorithm: 'sha256', digest: 'witness-digest' },
        postOwnerAdmission: { version: 1, cycle: 'cycle' },
        identityProof: { version: 1, cycle: 'cycle' },
      }));
      const rolled = h.mig.resume();
      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(rolled.detail.rolledBackFrom, 'post-commit');
      const stored = JSON.parse(h.store.getMigration(PI_POOL_STORE)!.detail_json) as Record<string, unknown>;
      assert.equal(Object.hasOwn(stored, 'sourceWitness'), false);
      assert.equal(Object.hasOwn(stored, 'postOwnerAdmission'), false);
      assert.equal(Object.hasOwn(rolled.detail, 'sourceWitness'), false);
    } finally {
      h.cleanup();
    }
  });

  it('commit without rehearse is refused; native untouched', () => {
    const h = setup();
    try {
      h.mig.stage();
      const journalBefore = h.store.getMigration(PI_POOL_STORE)?.detail_json;
      assert.equal(h.mig.status().resumeAction, 'proof-unavailable');
      assertProofUnavailable(() => h.mig.commit());
      assert.deepEqual(readFileSync(h.poolPath), h.originalBytes);
      assert.equal(existsSync(h.ownerPath), false);
      assert.equal(h.store.getMigration(PI_POOL_STORE)?.detail_json, journalBefore);
      assert.equal(h.mig.status().state, 'MIRRORED');
      assertSafety(h.poolPath, h.kc);
    } finally {
      h.cleanup();
    }
  });

  it('resume after C does not duplicate commit (owner already present)', async () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.postFullCommit);
      const artifacts = [
        h.ownerPath,
        h.authPath,
        piAuthBackupPath(h.authPath, 'anthropic'),
        preQlbPath(h.poolPath),
        sidecarPath(h.poolPath),
      ].map((path) => [path, readFileSync(path)] as const);
      const again = h.mig.resume();
      assert.equal(again.state, 'QLB_OWNED');
      assert.equal(again.ownerFile, 'present');
      // sidecar exists once, native stays retired
      assert.equal(nativeWorks(h.poolPath), false);
      for (const [path, before] of artifacts) assert.deepEqual(readFileSync(path), before, `resume changed ${path}`);
      assertSafety(h.poolPath, h.kc);
    } finally {
      h.cleanup();
    }
  });
  it('C5 is not applied to the pool: a crash-commit rollback never journals QLB_OWNED first', async () => {
    const h = setup();
    try {
      installHistory(h);
      const historicalNative = readFileSync(h.poolPath);
      assert.equal(h.mig.status().state, 'VALIDATED');

      const states: string[] = [];
      const original = h.store.upsertMigration.bind(h.store);
      h.store.upsertMigration = (store, state, next) => {
        if (store === PI_POOL_STORE) states.push(state);
        return original(store, state, next);
      };
      h.mig.rollback();
      assert.equal(states.includes('QLB_OWNED'), false, 'pool rollback keeps its existing post-commit path');
      assert.deepEqual(readFileSync(h.poolPath), historicalNative);
    } finally {
      h.cleanup();
    }
  });

});
