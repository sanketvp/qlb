import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { listStashes, recordStash, removeStash } from '../src/unclaimed-index';

describe('unclaimed stash index', () => {
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
