import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NoSingleGrantRestoreSourceError,
  rankSingleGrantSource,
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
    nativeEntry: { type: 'oauth', refresh: 'native-refresh-fake' },
  };
  return rankSingleGrantSource({ ...defaults, ...overrides });
}

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
  });

  it('allows none only when Pi already has a valid native entry', () => {
    assert.equal(rank().kind, 'none');
    assert.throws(
      () => rank({ nativeEntry: { type: 'oauth', refresh: '' } }),
      (error: unknown) => error instanceof NoSingleGrantRestoreSourceError && error.code === 'no-restore-source',
    );
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
