import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkAccountOwnership, pruneAccount } from '../src/accounts-prune';
import { openStore, type Store } from '../src/store';

const temps: string[] = [];
after(() => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function openTempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-accounts-prune-'));
  temps.push(dir);
  return openStore(join(dir, 'qlb.db'));
}

function seedOrphanAccount(store: Store): void {
  store.upsertAccount('account-orphan', 'anthropic', 'orphan@example.com', 'active');
  store.upsertSnapshot('account-orphan', '5h', {
    usedPct: 5,
    resetAt: Date.now() + 1000,
    fetchedAt: Date.now(),
    source: 'poll',
    confidence: 'authoritative',
  });
}

function seedOwnedAccount(store: Store): void {
  store.upsertAccount('account-owned', 'anthropic', 'owned@example.com', 'validated');
  store.upsertMigration(
    'pi-pool',
    'QLB_OWNED',
    JSON.stringify({
      qlbAccountIds: ['account-owned'],
      accounts: [{ id: 'account-owned', provider: 'anthropic', label: 'owned@example.com' }],
      committedAt: Date.now(),
    }),
    Date.now(),
  );
}

describe('accounts-prune', () => {
  it('checkAccountOwnership: false for an account absent from any migration journal', () => {
    const store = openTempStore();
    seedOrphanAccount(store);
    const check = checkAccountOwnership(store, 'account-orphan');
    assert.equal(check.owned, false);
    store.close();
  });

  it('checkAccountOwnership: true for an account listed in a QLB_OWNED migration row', () => {
    const store = openTempStore();
    seedOwnedAccount(store);
    const check = checkAccountOwnership(store, 'account-owned');
    assert.equal(check.owned, true);
    assert.equal(check.store, 'pi-pool');
    assert.equal(check.state, 'QLB_OWNED');
    store.close();
  });

  it('prunes an orphaned account: removes accounts + snapshots rows', () => {
    const store = openTempStore();
    seedOrphanAccount(store);
    assert.ok(store.getAccount('account-orphan'));
    assert.ok(store.getAllSnapshots('account-orphan')['5h']);

    const result = pruneAccount(store, { accountId: 'account-orphan', confirm: true });

    assert.equal(result.ok, true);
    assert.equal(result.removed.accounts, 1);
    assert.equal(result.removed.snapshots, 1);
    assert.equal(store.getAccount('account-orphan'), null);
    assert.deepEqual(store.getAllSnapshots('account-orphan'), {});
    store.close();
  });

  it('REFUSES to prune a QLB_OWNED account under any circumstances', () => {
    const store = openTempStore();
    seedOwnedAccount(store);

    assert.throws(
      () => pruneAccount(store, { accountId: 'account-owned', confirm: true }),
      /QLB_OWNED/,
    );
    // Row must still be present after the refused attempt.
    assert.ok(store.getAccount('account-owned'));
    store.close();
  });

  it('refuses without --confirm even for an orphaned account', () => {
    const store = openTempStore();
    seedOrphanAccount(store);

    assert.throws(
      () => pruneAccount(store, { accountId: 'account-orphan', confirm: false }),
      /--confirm/,
    );
    assert.ok(store.getAccount('account-orphan'));
    store.close();
  });

  it('refuses for an account id that does not exist', () => {
    const store = openTempStore();
    assert.throws(
      () => pruneAccount(store, { accountId: 'does-not-exist', confirm: true }),
      /no account found/,
    );
    store.close();
  });
});
