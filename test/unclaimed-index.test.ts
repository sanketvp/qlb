import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { listStashes, recordStash, removeStash } from '../src/unclaimed-index';

describe('unclaimed stash index', () => {
  it('still rejects a colon in a NEW stash id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-unclaimed-index-'));
    await assert.rejects(recordStash(root, {
      provider: 'anthropic', accountId: 'account-a', stashId: 'invalid:stash', consumedFp: 'sha256:lineage-a',
      location: 'keychain', createdAt: 1_000,
    }), /invalid unclaimed index stash id/);
  });

  it('lists a legacy index row whose stash id contains colons', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-unclaimed-index-'));
    const entry = {
      provider: 'anthropic', accountId: 'account-a', stashId: '2026-10-25T12:00:00Z', consumedFp: 'sha256:lineage-a',
      location: 'file' as const, createdAt: 1_000,
    };
    const index = join(root, 'index', 'anthropic');
    mkdirSync(index, { recursive: true, mode: 0o700 });
    writeFileSync(join(index, `${entry.stashId}.json`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });

    assert.deepEqual(await listStashes(root, 'anthropic'), [entry]);
    await removeStash(root, entry);
    assert.deepEqual(await listStashes(root, 'anthropic'), []);
  });

  it('skips directory fsync on win32', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-unclaimed-index-'));
    await recordStash(root, {
      provider: 'anthropic', accountId: 'account-a', stashId: 'win32-stash', consumedFp: 'sha256:lineage-a',
      location: 'keychain', createdAt: 1_000,
    }, {
      platform: 'win32',
      directorySync: async () => { throw new Error('directory fsync must not run on Windows'); },
    });
  });

  it('round trips a pending writer marker while legacy rows remain optional', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-unclaimed-index-'));
    const entry = {
      provider: 'anthropic', accountId: 'account-a', stashId: 'pending-stash', consumedFp: 'sha256:lineage-a',
      location: 'keychain' as const, createdAt: 1_000, pending: 123,
    };

    await recordStash(root, entry);
    assert.deepEqual(await listStashes(root, 'anthropic'), [entry]);
  });

  it('atomically records, lists by account, and removes non-secret stash metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-unclaimed-index-'));
    const entry = {
      provider: 'anthropic', accountId: 'account-a', stashId: 'stash-a', consumedFp: 'sha256:lineage-a',
      location: 'keychain' as const, createdAt: 1_000,
    };
    const path = await recordStash(root, entry);
    assert.equal(statSync(join(root, 'index', 'anthropic')).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(await listStashes(root, 'anthropic', 'account-a'), [entry]);
    assert.deepEqual(await listStashes(root, 'anthropic', 'account-b'), []);
    const persisted = readFileSync(path, 'utf8');
    assert.doesNotMatch(persisted, /access|refresh|credential/i);

    await removeStash(root, entry);
    assert.deepEqual(await listStashes(root, 'anthropic', 'account-a'), []);
  });
});
