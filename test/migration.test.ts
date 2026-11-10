import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import { beginCutover } from '../src/lifecycle';
import { isPiPlaceholder, piPlaceholder, PiOwnerLegacyError, writePiOwnerEntry } from '../src/pi-migrate';
import { piAuthBackupPath, writePiAuthBackup } from '../src/pi-auth-backup';
import { ANTHROPIC_POOL_HISTORY, NATIVE_AUTH, type HistoricalPoolArtifact, installHistoricalPoolArtifact } from './fixtures/anthropic-pool-history';
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

const FIXTURE_ACCOUNTS = [
  {
    id: 'acct-a',
    name: 'Account A',
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(path: string, description: string): void {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path) && Date.now() < deadline) sleepSync(10);
  assert.ok(existsSync(path), `timed out waiting for ${description}`);
}

function waitForChild(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

function startV2MapWriter(
  dir: string,
  ownerPath: string,
  readyPath: string,
  acquiredPath: string,
): ChildProcess {
  const sourceDir = join(__dirname, '..', 'src');
  const script = `
    const { writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const sourceDir = process.argv[1];
    const dir = process.argv[2];
    const ownerPath = process.argv[3];
    const readyPath = process.argv[4];
    const acquiredPath = process.argv[5];
    const { withPiAuthLock, writePiOwnerEntry } = require(join(sourceDir, 'pi-migrate.js'));
    writeFileSync(readyPath, 'ready\\n');
    withPiAuthLock(join(dir, 'auth.json'), () => {
      writeFileSync(acquiredPath, 'acquired\\n');
      writePiOwnerEntry(ownerPath, 'openrouter', true);
    });
  `;
  return spawn(process.execPath, ['-e', script, sourceDir, dir, ownerPath, readyPath, acquiredPath], {
    env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: dir, HOME: dir },
    stdio: 'ignore',
  });
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
  cleanup: () => void;
}

function installHistory(
  h: Harness,
  artifact: HistoricalPoolArtifact = ANTHROPIC_POOL_HISTORY.postOwnerCrash,
  legacyOwner?: string,
): void {
  installHistoricalPoolArtifact(artifact, {
    owner: h.ownerPath,
    pool: h.poolPath,
    prePool: preQlbPath(h.poolPath),
    sidecar: sidecarPath(h.poolPath),
    staging: stagingOwnerPath(h.ownerPath),
    auth: h.authPath,
    backup: piAuthBackupPath(h.authPath, 'anthropic'),
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
  const mig = new Migration(store, kc, poolPath, ownerPath, undefined, { authJsonPath: authPath });
  return {
    dir,
    poolPath,
    ownerPath,
    authPath,
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

describe('migration state machine — §4.8.3 / §4.8.3a', () => {
  it('historical fixture installation rejects an omitted required payload', () => {
    const h = setup();
    try {
      assert.throws(() => installHistoricalPoolArtifact({ state: 'VALIDATED', required: ['owner'] }, {
        owner: h.ownerPath, pool: h.poolPath, prePool: preQlbPath(h.poolPath), staging: stagingOwnerPath(h.ownerPath),
        auth: h.authPath, backup: piAuthBackupPath(h.authPath, 'anthropic'), sidecar: sidecarPath(h.poolPath),
      }, () => undefined), /missing required owner payload/);
    } finally { h.cleanup(); }
  });

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
      assert.equal(rehearseCalls.length, 2);
      assert.equal(rehearseCalls[0]?.grant.access, 'sk-ant-oat-fake-a');
      assert.equal(rehearseCalls[1]?.grant.access, 'sk-ant-oat-fake-b');
      // Migration.rehearse has no refresh hook — staged tokens are used as-is.
      assert.deepEqual(readFileSync(h.poolPath), before, 'rehearse must not touch native');
      assertSafety(h.poolPath, h.kc);

      const committed = h.mig.commit();
      assert.equal(committed.state, 'QLB_OWNED');
      assert.equal(committed.ownerFile, 'present');
      assert.equal(committed.nativeStore, 'pre-qlb');
      assert.equal(committed.piAtNextLaunch, 'QLB works');
      assert.equal(nativeWorks(h.poolPath), false, 'native path gone after commit');
      assert.equal(qlbWorks(h.kc), true, 'QLB Keychain valid after commit');
      assertSafety(h.poolPath, h.kc);

      const retired = readFileSync(preQlbPath(h.poolPath));
      assert.deepEqual(retired, h.originalBytes, '.pre-qlb is byte-identical to original');
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: { anthropic?: { mode?: string } } };
      assert.equal(owner.providers.anthropic?.mode, 'qlb');
      const auth = JSON.parse(readFileSync(h.authPath, 'utf8')) as { anthropic?: unknown };
      assert.equal(isPiPlaceholder(auth.anthropic), true);
      beginCutover(h.store);
      const output: string[] = [];
      const gate = await runPiGate('anthropic', {
        dbPath: join(h.dir, 'qlb.db'), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => output.push(value),
        guard: () => true, admitted: () => ({ ok: true }), piAgentDir: h.dir,
        provider: { read: () => ({ token: 'anthropic-token', accountId: 'anthropic-default', source: 'fixture' }) },
      });
      assert.equal(gate, 0);
      assert.equal(output.length, 1);
      assert.equal(existsSync(join(h.dir, 'extensions', 'anthropic-pool')), false);
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

  it('holds the owner-map lock through the pool commit final check and rename', async () => {
    const h = setup();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      const readyPath = join(h.dir, 'v2-writer-ready');
      const acquiredPath = join(h.dir, 'v2-writer-acquired');
      let writer: ChildProcess | undefined;
      const interleaved = new Migration(
        h.store,
        h.kc,
        h.poolPath,
        h.ownerPath,
        undefined,
        {
          authJsonPath: h.authPath,
          beforePoolCommitLock: () => {
            writer = startV2MapWriter(h.dir, h.ownerPath, readyPath, acquiredPath);
            waitForFile(readyPath, 'the v2 writer to attempt the owner-map lock');
            sleepSync(100);
            assert.equal(
              existsSync(acquiredPath),
              false,
              'the v2 writer must still wait while pool commit holds the owner-map lock',
            );
          },
        },
      );

      interleaved.commit();
      assert.ok(writer, 'pool barrier starts the concurrent v2 writer');
      assert.equal(
        await waitForChild(writer),
        0,
        'after commit releases its lock, the v2 writer publishes alongside Anthropic',
      );
      assert.equal(existsSync(acquiredPath), true, 'the waiting v2 writer proceeds only after commit releases');
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, { mode?: string }> };
      assert.equal(owner.providers.anthropic?.mode, 'qlb');
      assert.equal(owner.providers.openrouter?.mode, 'qlb');
      assert.equal(existsSync(stagingOwnerPath(h.ownerPath)), false, 'commit consumes staging');
    } finally {
      h.cleanup();
    }
  });

  it('pool commit publishes Anthropic into a v2 map that appeared after stage', async () => {
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

      h.mig.commit();

      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, { mode?: string }> };
      assert.equal(owner.providers.openrouter?.mode, 'qlb');
      assert.equal(owner.providers.anthropic?.mode, 'qlb');
      assert.equal(existsSync(stagingOwnerPath(h.ownerPath)), false, 'commit consumes staging');
      assert.equal(existsSync(h.poolPath), false, 'commit retires the native pool');
      assert.notDeepEqual(readFileSync(h.ownerPath), before);
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

  it('crash after stage, before rehearse: resume() rolls back; native untouched', async () => {
    const h = setup();
    try {
      h.mig.stage();
      assert.equal(h.mig.status().state, 'MIRRORED');
      assertSafety(h.poolPath, h.kc);

      const resumed = h.mig.resume();
      assert.equal(resumed.state, 'NATIVE');
      assert.equal(resumed.ownerFile, 'absent');
      assert.equal(resumed.nativeStore, 'intact');
      assert.equal(resumed.piAtNextLaunch, 'native works');
      assert.deepEqual(readFileSync(h.poolPath), h.originalBytes);
      assert.equal(qlbWorks(h.kc), false, 'staging Keychain deleted on rollback');
      assert.equal(nativeWorks(h.poolPath), true);
      assertSafety(h.poolPath, h.kc);
    } finally {
      h.cleanup();
    }
  });

  it('crash after rehearse, before commit: resume() completes commit (rehearsal proved it)', async () => {
    const h = setup();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      assert.equal(h.mig.status().state, 'VALIDATED');
      assert.equal(h.mig.status().ownerFile, 'staging');
      assertSafety(h.poolPath, h.kc);

      const resumed = h.mig.resume();
      assert.equal(resumed.state, 'QLB_OWNED');
      assert.equal(resumed.ownerFile, 'present');
      assert.equal(resumed.nativeStore, 'pre-qlb');
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
      assert.equal(qlbWorks(h.kc), true, 'resume must not need to re-run rehearse');
      assert.equal(qlbWorks(h.kc), true);
      assertSafety(h.poolPath, h.kc);
      assert.deepEqual(readFileSync(preQlbPath(h.poolPath)), historicalNative);
    } finally {
      h.cleanup();
    }
  });

  it('backs up Pi auth.json before replacing Anthropic and restores it on rollback', async () => {
    const h = setup();
    try {
      const original = `{
  "anthropic": {
    "type": "oauth",
    "access": "native-access",
    "refresh": "native-refresh",
    "expires": 1,
    "metadata": {
      "kept": true
    }
  },
  "xai": {
    "type": "oauth",
    "access": "other-access",
    "refresh": "other-refresh",
    "expires": 2
  }
}\n`;
      installHistory(h, ANTHROPIC_POOL_HISTORY.rollbackWithSibling);
      assert.equal(isPiPlaceholder(JSON.parse(readFileSync(h.authPath, 'utf8')).anthropic), true);
      h.mig.rollback();
      assert.deepEqual(readFileSync(h.authPath), Buffer.from(original));
    } finally {
      h.cleanup();
    }
  });

  it('commit with no auth.json records filePresent:false, creates the file with only the placeholder, rollback removes the file', async () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.absentAuth);
      const backup = JSON.parse(readFileSync(piAuthBackupPath(h.authPath, 'anthropic'), 'utf8')) as { filePresent?: boolean };
      assert.equal(backup.filePresent, false);
      const auth = JSON.parse(readFileSync(h.authPath, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(Object.keys(auth), ['anthropic']);
      assert.equal(isPiPlaceholder(auth.anthropic), true);
      h.mig.rollback();
      assert.equal(existsSync(h.authPath), false);
    } finally {
      h.cleanup();
    }
  });

  it('crash after the v2 entry before the placeholder: gate refuses placeholder-missing, resume writes the placeholder, gate serves', async () => {
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
      h.mig.resume();
      const output: string[] = [];
      const served = await runPiGate('anthropic', {
        dbPath: join(h.dir, 'qlb.db'), env: { QLB_PI_TOKEN_CALL: '1' }, deliver: (value) => output.push(value),
        guard: () => true, admitted: () => ({ ok: true }), piAgentDir: h.dir,
        provider: { read: () => ({ token: 'anthropic-token', accountId: 'anthropic-default', source: 'fixture' }) },
      });
      assert.equal(served, 0);
      assert.equal(output.length, 1);
    } finally {
      h.cleanup();
    }
  });

  it('safety property holds at every literal pool publication crash point (backup, owner-entry, placeholder)', async () => {
    const original = `{
  "anthropic": {
    "type": "oauth",
    "access": "native-access",
    "refresh": "native-refresh",
    "expires": 1,
    "extra": {
      "kept": true
    }
  }
}\n`;
    for (const artifact of [
      ANTHROPIC_POOL_HISTORY.backupCrash,
      ANTHROPIC_POOL_HISTORY.ownerEntryCrash,
      ANTHROPIC_POOL_HISTORY.placeholderCrash,
    ]) {
      const h = setup();
      try {
        installHistory(h, artifact);
        assertSafety(h.poolPath, h.kc);
        h.mig.resume();
        assert.equal(h.mig.status().state, 'QLB_OWNED');
        const backup = JSON.parse(readFileSync(piAuthBackupPath(h.authPath, 'anthropic'), 'utf8')) as { entry?: unknown };
        assert.deepEqual(backup.entry, JSON.parse(original).anthropic);
        h.mig.rollback();
        assert.deepEqual(readFileSync(h.authPath), Buffer.from(original));
        assert.equal(existsSync(h.ownerPath), false);
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

  it('conversion crash recovery preserves the original Anthropic backup and rollback round-trip', async () => {
    for (const point of ['backup', 'owner-entry', 'placeholder'] as const) {
      const h = setup();
      try {
        installHistory(h, ANTHROPIC_POOL_HISTORY.legacyOwner, h.ownerPath);
        const original = readFileSync(h.authPath);
        const crashing = new Migration(h.store, h.kc, h.poolPath, h.ownerPath, undefined, {
          authJsonPath: h.authPath,
          allowPoolLegacyConversion: true,
          afterWrite: (actual) => { if (actual === point) throw new Error(`fixture crash after ${point}`); },
        });
        assert.throws(() => crashing.resume(), new RegExp(`fixture crash after ${point}`));
        if (point === 'owner-entry') {
          assert.equal(crashing.status().resumeAction, 'v2 Anthropic owner is missing its Pi auth.json placeholder; run `qlb migrate resume --provider anthropic`');
        }
        const recovery = new Migration(h.store, h.kc, h.poolPath, h.ownerPath, undefined, {
          authJsonPath: h.authPath,
          allowPoolLegacyConversion: true,
        });
        recovery.resume();
        const backup = JSON.parse(readFileSync(piAuthBackupPath(h.authPath, 'anthropic'), 'utf8')) as { entry?: unknown };
        assert.deepEqual(backup.entry, JSON.parse(original.toString('utf8')).anthropic);
        recovery.rollback();
        assert.deepEqual(readFileSync(h.authPath), original);
        assert.equal(existsSync(h.ownerPath), false);
      } finally {
        h.cleanup();
      }
    }
  });

  it('converts a legacy Anthropic owner from VALIDATED when explicitly permitted', () => {
    const h = setup();
    try {
      const original = JSON.stringify({ anthropic: { type: 'oauth', access: 'native-validated', refresh: 'refresh-validated', expires: 1 } }, null, 2) + '\n';
      writeFileSync(h.authPath, original, { mode: 0o600 });
      writeFileSync(h.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n', { mode: 0o600 });
      h.store.upsertMigration(PI_POOL_STORE, 'VALIDATED', '{}');
      const migration = new Migration(h.store, h.kc, h.poolPath, h.ownerPath, undefined, {
        authJsonPath: h.authPath,
        allowPoolLegacyConversion: true,
      });
      migration.commit();
      assert.equal(isPiPlaceholder(JSON.parse(readFileSync(h.authPath, 'utf8')).anthropic), true);
      migration.rollback();
      assert.deepEqual(readFileSync(h.authPath), Buffer.from(original));
      assert.equal(existsSync(h.ownerPath), false);
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

  it('refuses resume and commit rather than replacing a newer native Anthropic login', async () => {
    const h = setup();
    try {
      const original = JSON.stringify({ anthropic: { type: 'oauth', access: 'native-original', refresh: 'refresh-original', expires: 1 } }, null, 2) + '\n';
      const newer = JSON.stringify({ anthropic: { type: 'oauth', access: 'native-newer', refresh: 'refresh-newer', expires: 2 } }, null, 2) + '\n';
      writeFileSync(h.authPath, original, { mode: 0o600 });
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      writeFileSync(h.authPath, newer, { mode: 0o600 });
      const beforeOwner = readFileSync(h.ownerPath);

      for (const operation of [() => h.mig.resume(), () => h.mig.commit()]) {
        assert.throws(operation, (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3
          && /native entry changed since stage/.test(String(error)));
        assert.deepEqual(readFileSync(h.authPath), Buffer.from(newer));
        assert.deepEqual(readFileSync(h.ownerPath), beforeOwner);
      }
      assert.equal(h.mig.status().resumeAction, 'stale native writer: auth.json[anthropic] is not the placeholder; run `qlb migrate rollback --provider anthropic`');
      h.mig.rollback();
      assert.deepEqual(readFileSync(h.authPath), Buffer.from(newer));
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

  it('custom conversion crash between v2 write and v1 unlink rolls back both claims or resumes idempotently', () => {
    for (const recovery of ['rollback', 'resume'] as const) {
      const h = setup();
      try {
        const customOwnerPath = join(h.dir, `custom-owner-${recovery}.json`);
        installHistory(h, ANTHROPIC_POOL_HISTORY.legacyOwner, customOwnerPath);
        const original = readFileSync(h.authPath);
        const crashing = new Migration(h.store, h.kc, h.poolPath, customOwnerPath, undefined, {
          authJsonPath: h.authPath,
          allowPoolLegacyConversion: true,
          beforePoolLegacyUnlink: () => { throw new Error('crash before legacy unlink'); },
        } as unknown as MigrationConfig);
        assert.throws(() => crashing.resume(), /crash before legacy unlink/);
        assert.ok(existsSync(customOwnerPath));
        assert.ok(existsSync(h.ownerPath));

        if (recovery === 'rollback') {
          const rollback = new Migration(h.store, h.kc, h.poolPath, customOwnerPath, undefined, { authJsonPath: h.authPath });
          rollback.rollback();
          assert.equal(existsSync(customOwnerPath), false);
          assert.equal(existsSync(h.ownerPath), false);
          assert.deepEqual(readFileSync(h.authPath), Buffer.from(original));
        } else {
          const resumed = new Migration(h.store, h.kc, h.poolPath, customOwnerPath, undefined, {
            authJsonPath: h.authPath,
            allowPoolLegacyConversion: true,
          });
          resumed.resume();
          assert.equal(existsSync(customOwnerPath), false);
          assert.equal(isPiPlaceholder(JSON.parse(readFileSync(h.authPath, 'utf8')).anthropic), true);
          resumed.rollback();
          assert.equal(existsSync(h.ownerPath), false);
          assert.deepEqual(readFileSync(h.authPath), Buffer.from(original));
        }
      } finally {
        h.cleanup();
      }
    }
  });

  it('refuses to unlink a custom legacy owner path swapped to a v2 map during conversion', () => {
    const h = setup();
    try {
      const customOwnerPath = join(h.dir, 'custom-owner-raced.json');
      writeFileSync(h.authPath, JSON.stringify({ anthropic: { type: 'oauth', access: 'native-raced', refresh: 'refresh-raced', expires: 1 } }) + '\n', { mode: 0o600 });
      writeFileSync(customOwnerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n', { mode: 0o600 });
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
      const migration = new Migration(h.store, h.kc, h.poolPath, customOwnerPath, undefined, {
        authJsonPath: h.authPath,
        allowPoolLegacyConversion: true,
        beforePoolLegacyUnlink: () => writeFileSync(customOwnerPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }) + '\n', { mode: 0o600 }),
      } as unknown as MigrationConfig);

      assert.throws(() => migration.resume(), (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3);
      const custom = JSON.parse(readFileSync(customOwnerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(custom.providers.xai);
    } finally {
      h.cleanup();
    }
  });

  it('refuses rollback without changing anything when a raced custom v1 document still names another provider', () => {
    const h = setup();
    try {
      const customOwnerPath = join(h.dir, 'custom-owner-mixed-race.json');
      installHistory(h, ANTHROPIC_POOL_HISTORY.legacyOwner, customOwnerPath);
      const migration = new Migration(h.store, h.kc, h.poolPath, customOwnerPath, undefined, {
        authJsonPath: h.authPath,
        allowPoolLegacyConversion: true,
        beforePoolLegacyUnlink: () => writeFileSync(customOwnerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }, { provider: 'xai' }] }) + '\n', { mode: 0o600 }),
      } as unknown as MigrationConfig);

      assert.throws(() => migration.resume(), PiOwnerLegacyError);
      const customBeforeRollback = readFileSync(customOwnerPath);
      const authBeforeRollback = readFileSync(h.authPath);
      const backupBeforeRollback = readFileSync(piAuthBackupPath(h.authPath, 'anthropic'));
      const journalBeforeRollback = JSON.stringify(h.store.getMigration(PI_POOL_STORE));
      assert.throws(() => migration.rollback(), (error: unknown) => error instanceof PiOwnerLegacyError
        && (error as Error).message.includes('xai'));
      assert.deepEqual(readFileSync(customOwnerPath), customBeforeRollback);
      assert.ok((JSON.parse(readFileSync(customOwnerPath, 'utf8')) as { accounts: Array<{ provider: string }> }).accounts.some(({ provider }) => provider === 'xai'));
      assert.deepEqual(readFileSync(h.authPath), authBeforeRollback);
      assert.deepEqual(readFileSync(piAuthBackupPath(h.authPath, 'anthropic')), backupBeforeRollback);
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
      const migration = new Migration(raced.store, raced.kc, raced.poolPath, customOwnerPath, undefined, {
        authJsonPath: raced.authPath,
        allowPoolLegacyConversion: true,
        beforePoolLegacyUnlink: () => writeFileSync(customOwnerPath, JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }) + '\n', { mode: 0o600 }),
      } as unknown as MigrationConfig);
      assert.throws(() => migration.resume(), (error: unknown) => (error as { exitCode?: unknown }).exitCode === 3);
      assert.equal(migration.status().resumeAction, 'owner-file-orphan: custom owner document changed during conversion; run `qlb migrate rollback --provider anthropic`');
      assert.doesNotThrow(() => migration.rollback());
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
      writeFileSync(mixed.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n', { mode: 0o600 });
      assert.doesNotThrow(() => explicit.resume());
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
      assert.equal(legacy.mig.status().resumeAction, 'legacy Anthropic conversion requires `qlb migrate resume --provider anthropic`');
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

  it('custom owner-file conversion retires its v1 document and is idempotent', () => {
    const h = setup();
    try {
      const customOwnerPath = join(h.dir, 'custom-owner.json');
      installHistory(h, ANTHROPIC_POOL_HISTORY.legacyOwner, customOwnerPath);
      const original = readFileSync(h.authPath);
      const migration = new Migration(h.store, h.kc, h.poolPath, customOwnerPath, undefined, {
        authJsonPath: h.authPath,
        allowPoolLegacyConversion: true,
      });
      migration.resume();
      assert.equal(existsSync(customOwnerPath), false);
      migration.resume();
      const backup = JSON.parse(readFileSync(piAuthBackupPath(h.authPath, 'anthropic'), 'utf8')) as { entry?: unknown };
      assert.deepEqual(backup.entry, JSON.parse(original.toString('utf8')).anthropic);
      migration.rollback();
      assert.deepEqual(readFileSync(h.authPath), Buffer.from(original));
      assert.equal(existsSync(h.ownerPath), false);
    } finally {
      h.cleanup();
    }
  });

  it('rollback after full commit restores native byte-identical and removes owner file', async () => {
    const h = setup();
    try {
      installHistory(h, ANTHROPIC_POOL_HISTORY.rollback);
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
      mkdirSync(join(h.dir, 'missing-agent'), { mode: 0o700 });
      const migration = new Migration(h.store, h.kc, h.poolPath, h.ownerPath, undefined, { authJsonPath: absentAuthPath });
      migration.stage();
      await migration.rehearse(mockRehearse([]));
      migration.commit();

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
      writePiAuthBackup(absentAuthPath, 'anthropic', 'missing-parent');
      writePiOwnerEntry(h.ownerPath, 'anthropic', true);
      renameSync(h.poolPath, preQlbPath(h.poolPath));
      h.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');

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

  it('safety property holds at every crash point (S2, S3, C, H1, R4, RC)', async () => {
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

  it('commit without rehearse is refused; native untouched', () => {
    const h = setup();
    try {
      h.mig.stage();
      assert.throws(() => h.mig.commit(), /rehearse must succeed first/);
      assert.deepEqual(readFileSync(h.poolPath), h.originalBytes);
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
