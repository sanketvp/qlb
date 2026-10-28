import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ABSENT_KEYCHAIN_DIGEST,
  canonicalDigest,
  fencedGeneration,
  keychainDigest,
  NoSingleGrantRestoreSourceError,
  rankSingleGrantSource,
  restoreRecordFor,
  type SingleGrantBackup,
} from '../src/pi-handback-source';
import type { Grant } from '../src/types';

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    access: 'access-fake',
    refresh: 'refresh-fake',
    expires: 4_102_444_800_000,
    generation: 7,
    writtenBy: 'migrate-stage',
    ...overrides,
  };
}

function backup(refresh = 'backup-refresh-fake'): SingleGrantBackup {
  return {
    entryPresent: true,
    entry: { type: 'oauth', access: 'backup-access-fake', refresh, expires: 4_102_444_800_000 },
  };
}

function rank(overrides: Partial<Parameters<typeof rankSingleGrantSource>[0]> = {}) {
  const defaults: Parameters<typeof rankSingleGrantSource>[0] = {
    keychainGrant: null,
    storeGeneration: 7,
    commitGeneration: 7,
    exactBackup: null,
    legacyBackup: null,
    nativeEntryPresent: true,
    nativeEntry: {
      type: 'oauth',
      access: 'native-access-fake',
      refresh: 'native-refresh-fake',
      expires: 4_102_444_800_000,
    },
  };
  return rankSingleGrantSource({ ...defaults, ...overrides });
}

describe('T-FD — pure fence arithmetic and digests', () => {
  it('lands the fence above the store and Keychain generations, including an absent Keychain grant', () => {
    assert.equal(fencedGeneration(7, -1), 8);
    assert.equal(fencedGeneration(7, 7), 8);
    assert.equal(fencedGeneration(7, 8), 9);
  });

  it('uses the ABSENT sentinel for an absent Keychain grant and digests every fencing field', () => {
    const current = grant({ generation: 8, writtenBy: 'native-resync' });
    assert.equal(keychainDigest(null), ABSENT_KEYCHAIN_DIGEST);
    assert.equal(keychainDigest(undefined), ABSENT_KEYCHAIN_DIGEST);
    assert.notEqual(keychainDigest(current), keychainDigest({ ...current, generation: 9 }));
    assert.notEqual(keychainDigest(current), keychainDigest({ ...current, writtenBy: 'migrate-stage' }));
    assert.notEqual(keychainDigest(current), keychainDigest({ ...current, refresh: 'other-refresh-fake' }));
    assert.notEqual(keychainDigest(current), keychainDigest({ ...current, access: 'other-access-fake' }));
  });

  it('creates a stable canonical restore-record digest that changes when any field changes', () => {
    const record = restoreRecordFor({
      authPath: '/tmp/pi/auth.json',
      key: 'xai',
      decidedAt: 123,
      filePresent: true,
      entryPresent: true,
      entry: { type: 'oauth', access: 'access-fake', refresh: 'refresh-fake', expires: 4_102_444_800_000 },
    });
    const reordered = restoreRecordFor({
      authPath: '/tmp/pi/auth.json',
      key: 'xai',
      decidedAt: 123,
      filePresent: true,
      entryPresent: true,
      entry: { refresh: 'refresh-fake', expires: 4_102_444_800_000, access: 'access-fake', type: 'oauth' },
    });

    const digest = canonicalDigest(record);
    assert.equal(digest, canonicalDigest(reordered));
    const { entry: _entry, ...recordWithoutEntry } = record;
    for (const changed of [
      { ...record, authPath: '/tmp/pi/other-auth.json' },
      { ...record, key: 'kimi-coding' },
      { ...record, cycleId: 'handback:124' },
      { ...recordWithoutEntry, filePresent: false, entryPresent: false },
      { ...record, entry: { ...record.entry as Record<string, unknown>, access: 'other-access-fake' } },
    ]) {
      assert.notEqual(canonicalDigest(changed), digest);
    }
  });
});

describe('T-RK — ranks the sources per §5.1', () => {
  it('prefers a trusted Keychain successor over exact and legacy backups', () => {
    const result = rank({
      keychainGrant: grant({ generation: 8 }),
      exactBackup: backup(),
      legacyBackup: backup('legacy-refresh-fake'),
    });

    assert.equal(result.kind, 'keychain');
    assert.equal(result.generation, 8);
  });

  it('ranks exact backup, then legacy backup, then a trusted unrefreshed Keychain grant', () => {
    assert.equal(rank({ keychainGrant: grant(), exactBackup: backup(), legacyBackup: backup('legacy-refresh-fake') }).kind, 'exact-backup');
    assert.equal(rank({ exactBackup: { entryPresent: false }, keychainGrant: grant() }).kind, 'exact-backup');
    assert.equal(rank({ keychainGrant: grant(), legacyBackup: backup('legacy-refresh-fake') }).kind, 'legacy-backup');
    assert.equal(rank({ keychainGrant: grant() }).kind, 'keychain');
  });

  it('rejects stale, malformed, and native-resync Keychain grants from ranking', () => {
    assert.equal(rank({ keychainGrant: grant({ generation: 6 }), exactBackup: backup() }).kind, 'exact-backup');
    assert.equal(rank({ keychainGrant: { generation: 8 }, exactBackup: backup() }).kind, 'exact-backup');
    assert.equal(rank({ keychainGrant: grant({ generation: 8, writtenBy: 'native-resync' }), exactBackup: backup() }).kind, 'exact-backup');
    assert.equal(rank({ keychainGrant: grant({ expires: Number.NaN }), exactBackup: backup() }).kind, 'exact-backup');
    assert.equal(rank({ keychainGrant: grant({ expires: Number.NaN }) }).kind, 'none');
  });

  it('skips malformed backups in favour of a trusted unrefreshed Keychain grant', () => {
    assert.equal(
      rank({
        keychainGrant: grant(),
        exactBackup: { entryPresent: true, entry: { refresh: 'backup-refresh-fake' } },
      }).kind,
      'keychain',
    );

    for (const expires of [Number.NaN, '4_102_444_800_000']) {
      assert.equal(
        rank({
          keychainGrant: grant(),
          exactBackup: {
            entryPresent: true,
            entry: { type: 'oauth', access: 'backup-access-fake', refresh: 'backup-refresh-fake', expires },
          },
        }).kind,
        'keychain',
      );
    }
  });

  it('allows none only when Pi already has a fully valid native entry', () => {
    assert.equal(rank().kind, 'none');
    for (const nativeEntry of [
      { type: 'oauth', refresh: '' },
      { type: 'oauth', refresh: 'native-refresh-fake' },
      { type: 'oauth', access: 'native-access-fake', refresh: 'native-refresh-fake', expires: Number.NaN },
    ]) {
      assert.throws(
        () => rank({ nativeEntry }),
        (error: unknown) => error instanceof NoSingleGrantRestoreSourceError && error.code === 'no-restore-source',
      );
    }
    assert.throws(
      () => rank({ nativeEntryPresent: false, nativeEntry: undefined }),
      NoSingleGrantRestoreSourceError,
    );
  });

  it('ranks a legacy journal by its writtenBy stamp (OD-1)', () => {
    assert.equal(
      rank({
        commitGeneration: undefined,
        keychainGrant: grant({ writtenBy: 'migrate-stage' }),
        exactBackup: backup(),
      }).kind,
      'exact-backup',
    );
    assert.equal(
      rank({
        commitGeneration: undefined,
        keychainGrant: grant({
          writtenBy: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
        }),
        exactBackup: backup(),
      }).kind,
      'keychain',
    );
  });

  it('ranks openai-codex exactly like xai (OD-8)', () => {
    const xai = rank({
      keychainGrant: grant({ access: 'xai-access-fake', refresh: 'xai-refresh-fake', generation: 8 }),
      exactBackup: backup(),
    });
    const openaiCodex = rank({
      keychainGrant: grant({ access: 'codex-access-fake', refresh: 'codex-refresh-fake', generation: 8 }),
      exactBackup: backup(),
    });

    assert.equal(xai.kind, 'keychain');
    assert.equal(openaiCodex.kind, 'keychain');
  });
});
