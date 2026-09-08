import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import {
  Migration,
  preQlbPath,
  sidecarPath,
  stagingOwnerPath,
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
    const parsed = JSON.parse(readFileSync(poolPath, 'utf8')) as {
      accounts?: Array<{ id?: string }>;
    };
    const ids = (parsed.accounts ?? []).map((a) => a.id);
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

interface Harness {
  dir: string;
  poolPath: string;
  ownerPath: string;
  originalBytes: Buffer;
  store: ReturnType<typeof openStore>;
  kc: MockKeychain;
  mig: Migration;
  cleanup: () => void;
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-migration-test-'));
  const poolPath = join(dir, 'anthropic-pool.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  const original = fixturePool();
  writeFileSync(poolPath, original, { encoding: 'utf8', mode: 0o600 });
  const originalBytes = readFileSync(poolPath);
  const store = openStore(join(dir, 'qlb.db'));
  const kc = new MockKeychain();
  const mig = new Migration(store, kc, poolPath, ownerPath);
  return {
    dir,
    poolPath,
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
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { owner: string };
      assert.equal(owner.owner, 'qlb');
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
      h.mig.stage();
      const rehearseCalls: StagedAccount[] = [];
      await h.mig.rehearse(mockRehearse(rehearseCalls));
      const callsAfterRehearse = rehearseCalls.length;

      // Simulate crash after C: rename staging → owner ourselves, leave native.
      renameSync(stagingOwnerPath(h.ownerPath), h.ownerPath);
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
      assert.equal(rehearseCalls.length, callsAfterRehearse, 'resume must not re-run rehearse');
      assert.equal(qlbWorks(h.kc), true);
      assertSafety(h.poolPath, h.kc);
      assert.deepEqual(readFileSync(preQlbPath(h.poolPath)), h.originalBytes);
    } finally {
      h.cleanup();
    }
  });

  it('rollback after full commit restores native byte-identical and removes owner file', async () => {
    const h = setup();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      assert.equal(h.mig.status().state, 'QLB_OWNED');
      assertSafety(h.poolPath, h.kc);

      const rolled = h.mig.rollback();
      assert.equal(rolled.ownerFile, 'absent');
      assert.equal(rolled.piAtNextLaunch, 'native works');
      assert.equal(rolled.state, 'VALIDATED');
      assert.deepEqual(
        readFileSync(h.poolPath),
        h.originalBytes,
        'restored native must be byte-identical to original',
      );
      assert.equal(nativeWorks(h.poolPath), true);
      assertSafety(h.poolPath, h.kc);
    } finally {
      h.cleanup();
    }
  });

  it('safety property holds at every crash point (S2, S3, C, H1, R4, RC)', async () => {
    const h = setup();
    try {
      // S2
      h.mig.stage();
      assertSafety(h.poolPath, h.kc);

      // S3 (rehearse in progress simulated by VALIDATED not yet — after success)
      await h.mig.rehearse(mockRehearse([]));
      assertSafety(h.poolPath, h.kc);

      // C: owner renamed, native not
      renameSync(stagingOwnerPath(h.ownerPath), h.ownerPath);
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
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const again = h.mig.resume();
      assert.equal(again.state, 'QLB_OWNED');
      assert.equal(again.ownerFile, 'present');
      // sidecar exists once, native stays retired
      assert.equal(nativeWorks(h.poolPath), false);
      assert.ok(readFileSync(sidecarPath(h.poolPath), 'utf8').length > 0);
      assertSafety(h.poolPath, h.kc);
    } finally {
      h.cleanup();
    }
  });
});
