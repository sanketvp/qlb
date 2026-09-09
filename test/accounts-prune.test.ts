import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import {
  checkAccountOwnership,
  parseAccountIds,
  pruneAccount,
  PruneRefusedError,
} from '../src/accounts-prune';
import { MockKeychain } from '../src/keychain';
import { Migration } from '../src/migration';
import { openStore, refreshLeaseName, type Store } from '../src/store';

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

function seedOrphanAccount(store: Store, id = 'account-orphan'): void {
  store.upsertAccount(id, 'anthropic', 'orphan@example.com', 'active');
  store.upsertSnapshot(id, '5h', {
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

const cliPath = join(__dirname, '..', 'src', 'cli.js');

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
    };
  }
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
    assert.equal(result.removed.leases, 0);
    assert.equal(store.getAccount('account-orphan'), null);
    assert.deepEqual(store.getAllSnapshots('account-orphan'), {});
    store.close();
  });

  it('REFUSES to prune a QLB_OWNED account under any circumstances', () => {
    const store = openTempStore();
    seedOwnedAccount(store);

    assert.throws(
      () => pruneAccount(store, { accountId: 'account-owned', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /QLB_OWNED/.test(err.message),
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
      (err: unknown) => err instanceof PruneRefusedError && /not_confirmed/.test(err.message),
    );
    assert.ok(store.getAccount('account-orphan'));
    store.close();
  });

  it('refuses for an account id that does not exist', () => {
    const store = openTempStore();
    assert.throws(
      () => pruneAccount(store, { accountId: 'does-not-exist', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /no_such_account/.test(err.message),
    );
    store.close();
  });
});

describe('accounts-prune fail-closed journal parse', () => {
  it('parseAccountIds: well-formed qlbAccountIds + accounts[].id fallback', () => {
    const both = parseAccountIds(
      JSON.stringify({
        qlbAccountIds: ['account-owned'],
        accounts: [{ id: 'account-owned', provider: 'anthropic' }],
      }),
    );
    assert.equal(both.ok, true);
    if (both.ok) {
      assert.deepEqual([...both.ids], ['account-owned']);
    }

    const fallback = parseAccountIds(
      JSON.stringify({ accounts: [{ id: 'account-fallback', label: 'x' }] }),
    );
    assert.equal(fallback.ok, true);
    if (fallback.ok) {
      assert.deepEqual([...fallback.ids], ['account-fallback']);
    }
  });

  it('parseAccountIds: malformed JSON, {}, and wrong-shaped fields are not ok', () => {
    assert.equal(parseAccountIds('this is not json{').ok, false);
    assert.equal(parseAccountIds('{}').ok, false);
    assert.equal(parseAccountIds('[]').ok, false);
    assert.equal(parseAccountIds(null).ok, false);
    assert.equal(parseAccountIds(undefined).ok, false);
    assert.equal(parseAccountIds(JSON.stringify({ qlbAccountIds: 'account-owned' })).ok, false);
    assert.equal(parseAccountIds(JSON.stringify({ qlbAccountIds: [1, 2] })).ok, false);
    assert.equal(parseAccountIds(JSON.stringify({ accounts: { id: 'x' } })).ok, false);
    assert.equal(parseAccountIds(JSON.stringify({ accounts: [{}] })).ok, false);
    assert.equal(parseAccountIds(JSON.stringify({ accounts: [{ id: '' }] })).ok, false);
    assert.equal(
      parseAccountIds(JSON.stringify({ accounts: [{ id: 'ok' }, {}] })).ok,
      false,
    );
    assert.equal(parseAccountIds(JSON.stringify({ qlbAccountIds: [''] })).ok, false);
    assert.equal(parseAccountIds(JSON.stringify({ qlbAccountIds: ['ok', ''] })).ok, false);
  });

  it('refuses prune when a QLB_OWNED journal row is malformed JSON', () => {
    const store = openTempStore();
    store.upsertAccount('acct-malformed', 'anthropic', 'm@example.com', 'active');
    store.upsertMigration('pi-pool', 'QLB_OWNED', 'this is not json{', Date.now());
    assert.equal(checkAccountOwnership(store, 'acct-malformed').owned, true);
    assert.throws(
      () => pruneAccount(store, { accountId: 'acct-malformed', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /untrusted:/.test(err.message),
    );
    assert.ok(store.getAccount('acct-malformed'));
    store.close();
  });

  it('refuses prune when a QLB_OWNED journal row is {} (wrong-shaped)', () => {
    const store = openTempStore();
    store.upsertAccount('acct-empty', 'anthropic', 'e@example.com', 'active');
    store.upsertMigration('pi-pool', 'QLB_OWNED', '{}', Date.now());
    assert.throws(
      () => pruneAccount(store, { accountId: 'acct-empty', confirm: true }),
      PruneRefusedError,
    );
    assert.ok(store.getAccount('acct-empty'));
    store.close();
  });

  it('refuses prune when qlbAccountIds / accounts fields are the wrong shape', () => {
    const store = openTempStore();
    store.upsertAccount('acct-wrong', 'anthropic', 'w@example.com', 'active');
    store.upsertMigration(
      'pi-pool',
      'QLB_OWNED',
      JSON.stringify({ qlbAccountIds: 'acct-wrong' }),
      Date.now(),
    );
    assert.throws(
      () => pruneAccount(store, { accountId: 'acct-wrong', confirm: true }),
      PruneRefusedError,
    );
    assert.ok(store.getAccount('acct-wrong'));
    store.close();
  });

  it('refuses prune when QLB_OWNED detail is {"accounts":[{}]} (missing id is untrusted)', () => {
    const store = openTempStore();
    store.upsertAccount('acct-empty-id', 'anthropic', 'empty@example.com', 'active');
    store.upsertMigration('pi-pool', 'QLB_OWNED', '{"accounts":[{}]}', Date.now());
    assert.equal(parseAccountIds('{"accounts":[{}]}').ok, false);
    assert.equal(checkAccountOwnership(store, 'acct-empty-id').owned, true);
    assert.throws(
      () => pruneAccount(store, { accountId: 'acct-empty-id', confirm: true }),
      (err: unknown) =>
        err instanceof PruneRefusedError && /untrusted:/.test(err.message),
    );
    assert.ok(store.getAccount('acct-empty-id'));
    store.close();
  });

  it('refuses prune when qlbAccountIds is [""] (empty string id is untrusted)', () => {
    const store = openTempStore();
    store.upsertAccount('victim', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [''] }), Date.now());
    assert.throws(
      () => pruneAccount(store, { accountId: 'victim', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /untrusted:/.test(err.message),
    );
    assert.ok(store.getAccount('victim'));
    store.close();
  });

  it('refuses prune when qlbAccountIds is ["ok",""] (mixed empty id is whole-row untrusted)', () => {
    const store = openTempStore();
    store.upsertAccount('victim', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration(
      'pi-pool',
      'QLB_OWNED',
      JSON.stringify({ qlbAccountIds: ['ok', ''] }),
      Date.now(),
    );
    assert.throws(
      () => pruneAccount(store, { accountId: 'victim', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /untrusted:/.test(err.message),
    );
    assert.ok(store.getAccount('victim'));
    store.close();
  });

});

describe('accounts-prune fail-closed journal parse (owned via accounts[].id)', () => {
  it('refuses a well-formed accounts[].id-only QLB_OWNED row', () => {
    const store = openTempStore();
    store.upsertAccount('account-fallback', 'anthropic', 'fb@example.com', 'active');
    store.upsertMigration(
      'pi-pool',
      'QLB_OWNED',
      JSON.stringify({
        accounts: [{ id: 'account-fallback', provider: 'anthropic', label: 'fb@example.com' }],
      }),
      Date.now(),
    );
    const check = checkAccountOwnership(store, 'account-fallback');
    assert.equal(check.owned, true);
    assert.throws(
      () => pruneAccount(store, { accountId: 'account-fallback', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /QLB_OWNED/.test(err.message),
    );
    assert.ok(store.getAccount('account-fallback'));
    store.close();
  });

  it('fail-closed: malformed QLB_OWNED journal refuses prune of an unrelated account', () => {
    const store = openTempStore();
    seedOrphanAccount(store);
    store.upsertMigration('other-pool', 'QLB_OWNED', 'not-json', Date.now());
    assert.throws(
      () => pruneAccount(store, { accountId: 'account-orphan', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /untrusted:/.test(err.message),
    );
    assert.ok(store.getAccount('account-orphan'));
    store.close();
  });
});

describe('accounts-prune in-flight migration refusal', () => {
  it('REFUSES to prune an account listed in a MIRRORED journal row', () => {
    const store = openTempStore();
    store.upsertAccount('account-mirrored', 'anthropic', 'm@example.com', 'active');
    store.upsertMigration(
      'pi-pool',
      'MIRRORED',
      JSON.stringify({ qlbAccountIds: ['account-mirrored'] }),
      Date.now(),
    );
    assert.throws(
      () => pruneAccount(store, { accountId: 'account-mirrored', confirm: true }),
      (err: unknown) =>
        err instanceof PruneRefusedError &&
        /protected:/.test(err.message) &&
        /MIRRORED/.test(err.message),
    );
    assert.ok(store.getAccount('account-mirrored'));
    store.close();
  });

  it('REFUSES to prune an account listed in a pre-commit VALIDATED journal row', () => {
    const store = openTempStore();
    const ownerFile = join(dirname(store.dbPath), 'qlb-owner.json');
    writeFileSync(`${ownerFile}.staging`, '{"owner":"qlb"}\n');
    store.upsertAccount('account-validated', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration(
      'pi-pool',
      'VALIDATED',
      JSON.stringify({
        qlbAccountIds: ['account-validated'],
        ownerFilePath: ownerFile,
      }),
      Date.now(),
    );
    assert.throws(
      () => pruneAccount(store, { accountId: 'account-validated', confirm: true }),
      (err: unknown) =>
        err instanceof PruneRefusedError &&
        /protected:/.test(err.message) &&
        /VALIDATED/.test(err.message),
    );
    assert.ok(store.getAccount('account-validated'));
    store.close();
  });

  it('REFUSES prune of a completed post-commit-rollback VALIDATED (option A)', () => {
    const store = openTempStore();
    seedOrphanAccount(store, 'account-rolled-back');
    const ownerFile = join(dirname(store.dbPath), 'qlb-owner.json');
    store.upsertMigration(
      'pi-pool',
      'VALIDATED',
      JSON.stringify({
        qlbAccountIds: ['account-rolled-back'],
        ownerFilePath: ownerFile,
        rolledBackFrom: 'post-commit',
      }),
      Date.now(),
    );
    const check = checkAccountOwnership(store, 'account-rolled-back');
    assert.equal(check.owned, true);
    assert.equal(check.token, 'protected:VALIDATED');
    assert.throws(
      () => pruneAccount(store, { accountId: 'account-rolled-back', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /protected:VALIDATED/.test((err as Error).message),
    );
    assert.ok(store.getAccount('account-rolled-back'));
    store.close();
  });

  function refuseUntrustedValidated(detailJson: string, extra?: { stagingAt?: string }): void {
    const store = openTempStore();
    if (extra?.stagingAt) writeFileSync(`${extra.stagingAt}.staging`, '{"owner":"qlb"}\n');
    store.upsertAccount('victim', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration('pi-pool', 'VALIDATED', detailJson, Date.now());
    assert.throws(
      () => pruneAccount(store, { accountId: 'victim', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /untrusted:|protected:/.test((err as Error).message),
    );
    assert.ok(store.getAccount('victim'));
    store.close();
  }

  it('refuses VALIDATED with malformed JSON (does not skip before ID validation)', () => {
    refuseUntrustedValidated('not-json');
  });

  it('refuses VALIDATED with missing ownerFilePath (does not guess a default path)', () => {
    refuseUntrustedValidated(JSON.stringify({
      qlbAccountIds: ['victim'],
      rolledBackFrom: 'post-commit',
    }));
  });

  it('refuses VALIDATED with empty ownerFilePath', () => {
    refuseUntrustedValidated(JSON.stringify({
      qlbAccountIds: ['victim'],
      ownerFilePath: '',
      rolledBackFrom: 'post-commit',
    }));
  });

  it('refuses VALIDATED with wrong-typed ownerFilePath even if a custom staging file exists', () => {
    const store = openTempStore();
    const customOwner = join(dirname(store.dbPath), 'custom-owner.json');
    writeFileSync(`${customOwner}.staging`, '{"owner":"qlb"}\n');
    store.upsertAccount('victim', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration(
      'pi-pool',
      'VALIDATED',
      JSON.stringify({ qlbAccountIds: ['victim'], ownerFilePath: 123 }),
      Date.now(),
    );
    assert.throws(
      () => pruneAccount(store, { accountId: 'victim', confirm: true }),
      PruneRefusedError,
    );
    assert.ok(store.getAccount('victim'));
    store.close();
  });

  it('refuses VALIDATED with files absent but missing rolledBackFrom (not proven terminal)', () => {
    const store = openTempStore();
    const ownerFile = join(dirname(store.dbPath), 'qlb-owner.json');
    store.upsertAccount('victim', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration(
      'pi-pool',
      'VALIDATED',
      JSON.stringify({ qlbAccountIds: ['victim'], ownerFilePath: ownerFile }),
      Date.now(),
    );
    assert.throws(
      () => pruneAccount(store, { accountId: 'victim', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /protected:VALIDATED/.test((err as Error).message),
    );
    assert.ok(store.getAccount('victim'));
    store.close();
  });

  it('refuses VALIDATED with invalid rolledBackFrom even when owner files are absent', () => {
    const store = openTempStore();
    const ownerFile = join(dirname(store.dbPath), 'qlb-owner.json');
    store.upsertAccount('victim', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration(
      'pi-pool',
      'VALIDATED',
      JSON.stringify({
        qlbAccountIds: ['victim'],
        ownerFilePath: ownerFile,
        rolledBackFrom: 'pre-commit',
      }),
      Date.now(),
    );
    assert.throws(
      () => pruneAccount(store, { accountId: 'victim', confirm: true }),
      PruneRefusedError,
    );
    assert.ok(store.getAccount('victim'));
    store.close();
  });

  it('refuses VALIDATED with empty/mixed qlbAccountIds even with rollback evidence', () => {
    const store = openTempStore();
    const ownerFile = join(dirname(store.dbPath), 'qlb-owner.json');
    store.upsertAccount('victim', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration(
      'pi-pool',
      'VALIDATED',
      JSON.stringify({
        qlbAccountIds: ['ok', ''],
        ownerFilePath: ownerFile,
        rolledBackFrom: 'post-commit',
      }),
      Date.now(),
    );
    assert.throws(
      () => pruneAccount(store, { accountId: 'victim', confirm: true }),
      PruneRefusedError,
    );
    assert.ok(store.getAccount('victim'));
    store.close();
  });

  it('allows prune when the journal is NATIVE (clean rollback) even if the id is listed', () => {
    const store = openTempStore();
    seedOrphanAccount(store);
    store.upsertMigration(
      'pi-pool',
      'NATIVE',
      JSON.stringify({ qlbAccountIds: ['account-orphan'] }),
      Date.now(),
    );
    const result = pruneAccount(store, { accountId: 'account-orphan', confirm: true });
    assert.equal(result.ok, true);
    assert.equal(store.getAccount('account-orphan'), null);
    store.close();
  });
});

describe('accounts-prune TOCTOU / two-connection', () => {
  it('store B committing QLB_OWNED is observed by store A prune (refuses rather than deleting)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-accounts-prune-'));
    temps.push(dir);
    const dbPath = join(dir, 'qlb.db');
    const storeA = openStore(dbPath);
    const storeB = openStore(dbPath);
    storeA.upsertAccount('account-race', 'anthropic', 'race@example.com', 'active');

    const before = checkAccountOwnership(storeA, 'account-race');
    assert.equal(before.owned, false);

    storeB.upsertMigration(
      'pi-pool',
      'QLB_OWNED',
      JSON.stringify({ qlbAccountIds: ['account-race'] }),
      Date.now(),
    );

    assert.throws(
      () => pruneAccount(storeA, { accountId: 'account-race', confirm: true }),
      (err: unknown) => err instanceof PruneRefusedError && /QLB_OWNED/.test(err.message),
    );
    assert.ok(storeA.getAccount('account-race'), 'must not delete after B committed QLB_OWNED');
    storeA.close();
    storeB.close();
  });

  it('holds BEGIN IMMEDIATE across check+delete so a concurrent QLB_OWNED commit cannot land', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-accounts-prune-'));
    temps.push(dir);
    const dbPath = join(dir, 'qlb.db');
    const storeA = openStore(dbPath);
    storeA.upsertAccount('account-race', 'anthropic', 'race@example.com', 'active');

    const orig = storeA.listMigrations.bind(storeA);
    let concurrentWriteAttempted = false;
    let concurrentWriteLanded = false;
    storeA.listMigrations = () => {
      const rows = orig();
      concurrentWriteAttempted = true;
      const raw = new DatabaseSync(dbPath);
      try {
        raw.exec('PRAGMA busy_timeout = 0');
        raw.exec('BEGIN IMMEDIATE');
        raw
          .prepare(
            `INSERT INTO migrations (store, state, updated_at, detail_json)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(store) DO UPDATE SET
               state = excluded.state,
               updated_at = excluded.updated_at,
               detail_json = excluded.detail_json`,
          )
          .run(
            'pi-pool',
            'QLB_OWNED',
            Date.now(),
            JSON.stringify({ qlbAccountIds: ['account-race'] }),
          );
        raw.exec('COMMIT');
        concurrentWriteLanded = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/locked|busy/i.test(msg)) throw err;
      } finally {
        try {
          raw.close();
        } catch {
          // already closed
        }
      }
      return rows;
    };

    const result = pruneAccount(storeA, { accountId: 'account-race', confirm: true });
    assert.equal(concurrentWriteAttempted, true, 'ownership check ran inside prune');
    assert.equal(
      concurrentWriteLanded,
      false,
      'concurrent QLB_OWNED commit must not land during the prune transaction',
    );
    assert.equal(result.ok, true);
    assert.equal(storeA.getAccount('account-race'), null);
    assert.equal(storeA.getMigration('pi-pool'), null);
    storeA.close();
  });
});

describe('accounts-prune vs Migration.stage() pre-journal window', () => {
  it('refuses concurrent prune at upsertAccount: MIRRORED journal already names the id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-accounts-prune-stage-'));
    temps.push(dir);
    const poolPath = join(dir, 'anthropic-pool.json');
    const ownerPath = join(dir, 'qlb-owner.json');
    const dbPath = join(dir, 'qlb.db');
    writeFileSync(
      poolPath,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'acct-stage-race',
            name: 'Stage Race',
            credentials: {
              type: 'oauth',
              access: 'sk-ant-oat-fake',
              refresh: 'sk-ant-ort-fake',
              expires: Date.now() + 7 * 24 * 3600 * 1000,
            },
          },
        ],
      }) + '\n',
    );
    const store = openStore(dbPath);
    const kc = new MockKeychain();
    const mig = new Migration(store, kc, poolPath, ownerPath);
    const origUpsert = store.upsertAccount.bind(store);
    let pruneRefusedWhileVisible = false;
    let upserts = 0;
    store.upsertAccount = (id, provider, label, status) => {
      const peer = openStore(dbPath);
      try {
        const journal = peer.getMigration('pi-pool');
        assert.ok(journal, 'MIRRORED journal must exist before upsertAccount');
        assert.equal(journal.state, 'MIRRORED');
        const parsed = parseAccountIds(journal.detail_json);
        assert.equal(parsed.ok, true);
        if (parsed.ok) {
          assert.ok(
            parsed.ids.has(id),
            'journal must name the account before the row becomes visible',
          );
        }
        origUpsert(id, provider, label, status);
        upserts += 1;
        assert.throws(
          () => pruneAccount(peer, { accountId: id, confirm: true }),
          (err: unknown) =>
            err instanceof PruneRefusedError &&
            /protected:/.test((err as Error).message) &&
            /MIRRORED/.test((err as Error).message),
        );
        pruneRefusedWhileVisible = true;
      } finally {
        peer.close();
      }
    };
    mig.stage();
    assert.equal(upserts, 1);
    assert.equal(pruneRefusedWhileVisible, true);
    assert.ok(store.getAccount('acct-stage-race'));
    store.close();
  });
});

describe('accounts-prune cascade includes refresh lease', () => {
  it('removes a held refresh lease for the pruned account', () => {
    const store = openTempStore();
    seedOrphanAccount(store);
    const acquired = store.acquireRefreshLease('account-orphan', 'holder-1', process.pid, 0, 15_000);
    assert.equal(acquired, 'acquired');
    assert.ok(store.getLease(refreshLeaseName('account-orphan')));

    const result = pruneAccount(store, { accountId: 'account-orphan', confirm: true });
    assert.equal(result.ok, true);
    assert.equal(result.removed.accounts, 1);
    assert.equal(result.removed.leases, 1);
    assert.equal(store.getLease(refreshLeaseName('account-orphan')), null);
    assert.equal(store.getAccount('account-orphan'), null);
    store.close();
  });
});

describe('accounts-prune CLI exit codes', () => {
  it('exits 2 (not 1) when pruning a QLB_OWNED account', () => {
    const store = openTempStore();
    seedOwnedAccount(store);
    const dbPath = store.dbPath;
    store.close();

    const result = runCli(
      ['accounts', 'prune', '--account', 'account-owned', '--confirm', '--db', dbPath],
      { ...process.env, QLB_DB_PATH: dbPath },
    );
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /QLB_OWNED/);
    assert.equal(
      result.stderr.includes('PruneRefusedError') || /REFUSED:/.test(result.stderr),
      true,
    );
  });

  it('exits 2 when QLB_OWNED detail is {"accounts":[{}]} (missing id is untrusted)', () => {
    const store = openTempStore();
    store.upsertAccount('acct-empty-id', 'anthropic', 'empty@example.com', 'active');
    store.upsertMigration('pi-pool', 'QLB_OWNED', '{"accounts":[{}]}', Date.now());
    const dbPath = store.dbPath;
    store.close();

    const result = runCli(
      ['accounts', 'prune', '--account', 'acct-empty-id', '--confirm', '--db', dbPath],
      { ...process.env, QLB_DB_PATH: dbPath },
    );
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /untrusted:/);
  });

  it('exits 2 when QLB_OWNED qlbAccountIds is [""]', () => {
    const store = openTempStore();
    store.upsertAccount('victim', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [''] }), Date.now());
    const dbPath = store.dbPath;
    store.close();
    const result = runCli(
      ['accounts', 'prune', '--account', 'victim', '--confirm', '--db', dbPath],
      { ...process.env, QLB_DB_PATH: dbPath },
    );
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /untrusted:/);
  });

  it('exits 2 when QLB_OWNED qlbAccountIds is ["ok",""]', () => {
    const store = openTempStore();
    store.upsertAccount('victim', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration(
      'pi-pool',
      'QLB_OWNED',
      JSON.stringify({ qlbAccountIds: ['ok', ''] }),
      Date.now(),
    );
    const dbPath = store.dbPath;
    store.close();
    const result = runCli(
      ['accounts', 'prune', '--account', 'victim', '--confirm', '--db', dbPath],
      { ...process.env, QLB_DB_PATH: dbPath },
    );
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /untrusted:/);
  });

  it('exits 2 when VALIDATED detail is malformed JSON', () => {
    const store = openTempStore();
    store.upsertAccount('victim', 'anthropic', 'v@example.com', 'active');
    store.upsertMigration('pi-pool', 'VALIDATED', 'not-json', Date.now());
    const dbPath = store.dbPath;
    store.close();
    const isolatedAuth = join(dirname(dbPath), 'auth.json');
    const result = runCli(
      ['accounts', 'prune', '--account', 'victim', '--confirm', '--db', dbPath],
      { ...process.env, QLB_DB_PATH: dbPath, QLB_PI_AUTH_JSON_PATH: isolatedAuth },
    );
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /untrusted:/);
  });

  it('exits 2 when the account id does not exist', () => {
    const store = openTempStore();
    const dbPath = store.dbPath;
    store.close();
    const result = runCli(
      ['accounts', 'prune', '--account', 'does-not-exist', '--confirm', '--db', dbPath],
      { ...process.env, QLB_DB_PATH: dbPath },
    );
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /no_such_account/);
  });

  it('T-EXIT-1: missing --confirm exits 2 with not_confirmed',
    () => {
      const store = openTempStore();
      seedOrphanAccount(store);
      const dbPath = store.dbPath;
      store.close();
      const result = runCli(
        ['accounts', 'prune', '--account', 'account-orphan', '--db', dbPath],
        { ...process.env, QLB_DB_PATH: dbPath },
      );
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.match(result.stderr, /^qlb accounts prune: REFUSED: not_confirmed|^REFUSED: not_confirmed/m);
    },
  );

  it('missing --account is usage exit 1',
    () => {
      const store = openTempStore();
      const dbPath = store.dbPath;
      store.close();
      const result = runCli(['accounts', 'prune', '--confirm', '--db', dbPath], {
        ...process.env,
        QLB_DB_PATH: dbPath,
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
    },
  );
});

describe('T-PRUNE-1 valid Pi inventory',
  () => {
    it('equal dual lists prune an unrelated target and protect named ones', () => {
      const store = openTempStore();
      store.upsertAccount('a', 'anthropic', 'a');
      store.upsertAccount('b', 'anthropic', 'b');
      store.upsertAccount('z', 'anthropic', 'z');
      store.upsertMigration(
        'pi-pool',
        'QLB_OWNED',
        JSON.stringify({
          qlbAccountIds: ['a', 'b'],
          accounts: [{ id: 'b' }, { id: 'a' }],
        }),
        Date.now(),
      );
      assert.throws(
        () => pruneAccount(store, { accountId: 'a', confirm: true }),
        (err: unknown) => err instanceof PruneRefusedError && /protected:QLB_OWNED/.test((err as Error).message),
      );
      const result = pruneAccount(store, { accountId: 'z', confirm: true });
      assert.equal(result.ok, true);
      assert.equal(store.getAccount('z'), null);
      assert.ok(store.getAccount('a'));
      store.close();
    });
  },
);

describe('T-ID provider consistency',
  () => {
    it('global provider_mismatch refuses an unrelated target', () => {
      const store = openTempStore();
      store.upsertAccount('a', 'anthropic', 'a');
      store.upsertAccount('z', 'anthropic', 'z');
      store.upsertMigration(
        'pi-pool',
        'QLB_OWNED',
        JSON.stringify({
          qlbAccountIds: ['a'],
          accounts: [{ id: 'a', provider: 'xai' }],
        }),
        Date.now(),
      );
      assert.throws(
        () => pruneAccount(store, { accountId: 'z', confirm: true }),
        (err: unknown) =>
          err instanceof PruneRefusedError && /untrusted:provider_mismatch/.test((err as Error).message),
      );
      assert.ok(store.getAccount('z'));
      store.close();
    });

    it('SQL NULL provider on an existing row is not treated as a missing row', () => {
      const store = openTempStore();
      seedOrphanAccount(store, 'victim');
      store.upsertOverride({ kind: 'pin', accountId: 'victim', until: Date.now() + 60_000 });
      store.claimPoll('victim', 'h', 15_000);
      store.acquireRefreshLease('victim', 'h', process.pid, 0, 15_000);
      store.recordDecision({
        requested_model: 'x',
        mode: 'proxy',
        reason: 'ok',
        snapshot_json: '{}',
        account_id: 'victim',
      });
      store.upsertAccount('a', 'anthropic', 'a');
      const db = (store as unknown as { db: DatabaseSync }).db;
      db.exec("UPDATE accounts SET provider = NULL WHERE id = 'a'");
      store.upsertMigration(
        'pi-pool',
        'QLB_OWNED',
        JSON.stringify({
          qlbAccountIds: ['a'],
          accounts: [{ id: 'a', provider: 'anthropic' }],
        }),
        Date.now(),
      );
      assert.throws(
        () => pruneAccount(store, { accountId: 'victim', confirm: true }),
        (err: unknown) =>
          err instanceof PruneRefusedError && /untrusted:provider_mismatch/.test((err as Error).message),
      );
      assert.ok(store.getAccount('victim'));
      assert.ok(store.getAllSnapshots('victim')['5h']);
      assert.ok(store.getOverride('victim'));
      assert.ok(store.getPollClaim('victim'));
      assert.ok(store.getLease(refreshLeaseName('victim')));
      assert.equal(store.listDecisions().filter((d) => d.account_id === 'victim').length, 1);
      store.close();
    });

    it('pending MIRRORED participant without an account row is allowed',
      () => {
        const store = openTempStore();
        store.upsertAccount('z', 'anthropic', 'z');
        store.upsertMigration(
          'pi-pool',
          'MIRRORED',
          JSON.stringify({
            qlbAccountIds: ['pending'],
            accounts: [{ id: 'pending', provider: 'anthropic' }],
          }),
          Date.now(),
        );
        const result = pruneAccount(store, { accountId: 'z', confirm: true });
        assert.equal(result.ok, true);
        store.close();
      },
    );
  },
);

function seedSix(store: Store, id = 'victim'): void {
  store.upsertAccount(id, 'anthropic', 'Victim');
  store.upsertSnapshot(id, '5h', {
    usedPct: 1,
    fetchedAt: Date.now(),
    source: 'poll',
    confidence: 'authoritative',
  });
  store.upsertOverride({ kind: 'pin', accountId: id, until: Date.now() + 60_000 });
  store.claimPoll(id, 'holder', 15_000);
  store.acquireRefreshLease(id, 'holder', process.pid, 0, 15_000);
  store.recordDecision({
    requested_model: 'x',
    mode: 'proxy',
    reason: 'ok',
    snapshot_json: '{}',
    account_id: id,
  });
}

function assertSixSurvive(store: Store, id: string): void {
  assert.ok(store.getAccount(id), 'accounts');
  assert.ok(store.getAllSnapshots(id)['5h'], 'snapshots');
  assert.ok(store.getOverride(id), 'overrides');
  assert.ok(store.getPollClaim(id), 'poll_claims');
  assert.ok(store.getLease(refreshLeaseName(id)), 'leases');
  assert.equal(store.listDecisions().filter((d) => d.account_id === id).length, 1, 'decisions');
}

function storeDb(store: Store): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

describe('T-TXN delete/commit faults',
  () => {
    const tables = [
      { table: 'snapshots', col: 'account_id' },
      { table: 'overrides', col: 'account_id' },
      { table: 'poll_claims', col: 'account_id' },
      { table: 'leases', col: 'name' },
      { table: 'accounts', col: 'id' },
    ];

    const statementFields: Record<string, string> = {
      snapshots: 'deleteSnapshotsByAccountStmt',
      overrides: 'deleteOverridesByAccountStmt',
      poll_claims: 'deletePollClaimsByAccountStmt',
      leases: 'deleteLeaseByNameStmt',
      accounts: 'deleteAccountStmt',
    };

    function captureStatementError(store: Store, field: string): () => unknown {
      const statement = (store as unknown as Record<string, { run: (...args: unknown[]) => unknown }>)[field];
      const originalRun = statement.run.bind(statement);
      let originating: unknown;
      statement.run = (...args: unknown[]) => {
        try {
          return originalRun(...args);
        } catch (err) {
          originating = err;
          throw err;
        }
      };
      return () => originating;
    }

    for (const { table } of tables) {
      it(`T-TXN-2a RAISE(ABORT) on ${table} restores all six rows`, () => {
        const store = openTempStore();
        seedSix(store, 'victim');
        storeDb(store).exec(
          `CREATE TRIGGER abort_${table} BEFORE DELETE ON ${table} BEGIN
            SELECT RAISE(ABORT, 'review-${table}-abort');
          END;`,
        );
        const originating = captureStatementError(store, statementFields[table]);
        let caught: unknown;
        try {
          pruneAccount(store, { accountId: 'victim', confirm: true });
        } catch (err) {
          caught = err;
        }
        assert.ok(caught instanceof Error);
        const rec = caught as Error & { code?: string; errcode?: number };
        assert.equal(caught, originating(), 'library must rethrow the exact statement error object');
        assert.equal(rec.code, 'ERR_SQLITE_ERROR');
        assert.equal(rec.errcode, 1811);
        assert.match(rec.message, new RegExp(`review-${table}-abort`));
        assertSixSurvive(store, 'victim');
        const dbPath = store.dbPath;
        store.close();
        const cli = runCli(
          ['accounts', 'prune', '--account', 'victim', '--confirm', '--db', dbPath],
          { ...process.env, QLB_DB_PATH: dbPath },
        );
        assert.equal(cli.status, 1, cli.stderr);
        assert.match(cli.stderr, /code=ERR_SQLITE_ERROR errcode=1811/);
        assert.match(cli.stderr, new RegExp(`review-${table}-abort`));
        const reopened = openStore(dbPath);
        assertSixSurvive(reopened, 'victim');
        reopened.close();
      });
    }

    it('T-TXN-2b AFTER DELETE on accounts aborts before COMMIT with original error + CLI diagnostics', () => {
      const store = openTempStore();
      seedSix(store, 'victim');
      storeDb(store).exec(
        `CREATE TRIGGER precommit_abort AFTER DELETE ON accounts BEGIN
          SELECT RAISE(ABORT, 'review-precommit-abort');
        END;`,
      );
      const originating = captureStatementError(store, 'deleteAccountStmt');
      let caught: unknown;
      try {
        pruneAccount(store, { accountId: 'victim', confirm: true });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof Error);
      const rec = caught as Error & { code?: string; errcode?: number };
      assert.equal(caught, originating(), 'library must rethrow the exact pre-COMMIT statement error');
      assert.equal(rec.code, 'ERR_SQLITE_ERROR');
      assert.equal(rec.errcode, 1811);
      assert.match(rec.message, /review-precommit-abort/);
      assertSixSurvive(store, 'victim');
      const dbPath = store.dbPath;
      store.close();
      const cli = runCli(
        ['accounts', 'prune', '--account', 'victim', '--confirm', '--db', dbPath],
        { ...process.env, QLB_DB_PATH: dbPath },
      );
      assert.equal(cli.status, 1, cli.stderr);
      assert.match(cli.stderr, /review-precommit-abort/);
      assert.match(cli.stderr, /code=ERR_SQLITE_ERROR errcode=1811/);
      const reopened = openStore(dbPath);
      assertSixSurvive(reopened, 'victim');
      reopened.close();
    });

    it('T-TXN-2c real COMMIT fails via deferred FK without a production seam', () => {
      const store = openTempStore();
      seedSix(store, 'victim');
      const db = storeDb(store);
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(`
        CREATE TABLE prune_commit_trap (
          account_id TEXT NOT NULL,
          FOREIGN KEY (account_id) REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER prune_commit_trap_ins AFTER DELETE ON accounts BEGIN
          INSERT INTO prune_commit_trap(account_id) VALUES (OLD.id);
        END;
      `);
      const originalExec = db.exec.bind(db);
      let originating: unknown;
      db.exec = (sql: string) => {
        try {
          return originalExec(sql);
        } catch (err) {
          if (sql === 'COMMIT') originating = err;
          throw err;
        }
      };
      let caught: unknown;
      try {
        pruneAccount(store, { accountId: 'victim', confirm: true });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof Error);
      const rec = caught as Error & { code?: string; errcode?: number };
      assert.equal(caught, originating, 'library must rethrow the exact SQLite COMMIT error');
      assert.equal(rec.code, 'ERR_SQLITE_ERROR');
      assert.equal(rec.errcode, 787);
      assert.match(rec.message, /FOREIGN KEY/i);
      assertSixSurvive(store, 'victim');
      const dbPath = store.dbPath;
      const preload = join(dirname(dbPath), 'foreign-keys-preload.cjs');
      writeFileSync(preload, `
        const sqlite = require('node:sqlite');
        const Original = sqlite.DatabaseSync;
        sqlite.DatabaseSync = class ForeignKeysDatabaseSync extends Original {
          constructor(...args) { super(...args); this.exec('PRAGMA foreign_keys = ON'); }
        };
      `);
      store.close();
      const cliRun = spawnSync(
        process.execPath,
        ['--require', preload, cliPath, 'accounts', 'prune', '--account', 'victim', '--confirm', '--db', dbPath],
        { encoding: 'utf8', env: { ...process.env, QLB_DB_PATH: dbPath }, timeout: 30_000 },
      );
      const cliStderr = cliRun.stderr || '';
      assert.equal(cliRun.status, 1, cliStderr || cliRun.stdout);
      assert.match(cliStderr, /FOREIGN KEY constraint failed/i);
      assert.match(cliStderr, /code=ERR_SQLITE_ERROR errcode=787/);
      const reopened = openStore(dbPath);
      assertSixSurvive(reopened, 'victim');
      reopened.close();
    });
  },
);

describe('T-KIND native-retirement writer',
  () => {
    it('retireNativeStore without inherited inventory: unrelated prune allowed; doctor PASS', async () => {
      const { checkRetirementEligibility, MIN_OK_DECISIONS, retireNativeStore, SOAK_MS } = await import('../src/retire');
      const { doctorQlb } = await import('../src/diagnostics');
      const { defaultConfig } = await import('../src/config');
      const dir = mkdtempSync(join(tmpdir(), 'qlb-kind-retire-'));
      temps.push(dir);
      const nativePath = join(dir, 'auth.json');
      writeFileSync(nativePath, '{"tokens":{}}\n');
      const store = openStore(join(dir, 'qlb.db'));
      const committedAt = Date.now() - SOAK_MS - 86400000;
      store.upsertMigration('codex-cli', 'QLB_OWNED', JSON.stringify({ committedAt }), committedAt);
      for (let i = 0; i < MIN_OK_DECISIONS; i++) {
        store.recordDecision({
          ts: committedAt + 1000 + i,
          harness: 'codex-cli',
          requested_model: 'gpt-5.4',
          mode: 'proxy',
          reason: 'ok',
          snapshot_json: JSON.stringify({ outcome: 'ok' }),
        });
      }
      store.upsertAccount('unrelated', 'anthropic', 'u');
      await retireNativeStore(store, 'codex-cli', {
        nativePathToRemove: nativePath,
        confirmRealRetirement: true,
        pingFn: async () => true,
      });
      const result = pruneAccount(store, { accountId: 'unrelated', confirm: true });
      assert.equal(result.ok, true);
      const cfg = defaultConfig(dir);
      cfg.dbPath = store.dbPath;
      const report = await doctorQlb(cfg, { command: () => 'ok' });
      const migration = report.checks.find((c) => c.name === 'migrations');
      assert.equal(migration?.level, 'PASS');
      store.close();
    });

    it('inherited nonempty inventory protects the named account', async () => {
      const { MIN_OK_DECISIONS, retireNativeStore, SOAK_MS } = await import('../src/retire');
      const dir = mkdtempSync(join(tmpdir(), 'qlb-kind-protect-'));
      temps.push(dir);
      const nativePath = join(dir, 'auth.json');
      writeFileSync(nativePath, '{"x":1}\n');
      const store = openStore(join(dir, 'qlb.db'));
      const committedAt = Date.now() - SOAK_MS - 86400000;
      store.upsertMigration(
        'claude-code',
        'QLB_OWNED',
        JSON.stringify({
          committedAt,
          qlbAccountIds: ['victim'],
          accounts: [{ id: 'victim', provider: 'anthropic' }],
        }),
        committedAt,
      );
      for (let i = 0; i < MIN_OK_DECISIONS; i++) {
        store.recordDecision({
          ts: committedAt + 1000 + i,
          harness: 'claude-code',
          requested_model: 'opus',
          mode: 'proxy',
          reason: 'ok',
          snapshot_json: JSON.stringify({ outcome: 'ok' }),
        });
      }
      store.upsertAccount('victim', 'anthropic', 'v');
      store.upsertAccount('unrelated', 'anthropic', 'u');
      await retireNativeStore(store, 'claude-code', {
        nativePathToRemove: nativePath,
        confirmRealRetirement: true,
        pingFn: async () => true,
      });
      assert.throws(
        () => pruneAccount(store, { accountId: 'victim', confirm: true }),
        (err: unknown) => err instanceof PruneRefusedError && /protected:RETIRED/.test((err as Error).message),
      );
      const result = pruneAccount(store, { accountId: 'unrelated', confirm: true });
      assert.equal(result.ok, true);
      store.close();
    });
  },
);

function independentHead(root: string): string {
  const receipt = join(root, 'HEAD.receipt');
  if (existsSync(receipt)) {
    const value = readFileSync(receipt, 'utf8').trim().split(/\s+/)[0];
    assert.match(value, /^[0-9a-f]{40}$/);
    return value;
  }
  const gitHead = join(root, '.git', 'HEAD');
  if (!existsSync(gitHead)) {
    assert.fail('no independent head at build-root (HEAD.receipt or .git)');
  }
  let head = readFileSync(gitHead, 'utf8').trim();
  if (head.startsWith('ref: ')) {
    head = readFileSync(join(root, '.git', head.slice(5).trim()), 'utf8').trim();
  }
  assert.match(head, /^[0-9a-f]{40}$/);
  return head;
}

describe('T-SCEN parameterized driver',
  () => {
    function sourceOracle(root: string, head: string, trustedDir: string): string {
      const supplied = process.env.QLB_TEST_SOURCE_ORACLE;
      if (supplied) return supplied;
      const oracle = join(trustedDir, 'source-oracle.json');
      const generator = join(root, 'test', 'support', 'source-oracle.cjs');
      const result = spawnSync(
        process.execPath,
        [
          generator, '--trusted-repo', root, '--expect-head', head,
          '--candidate-root', root, '--output', oracle,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return oracle;
    }

    function runProvenance(root: string, head: string, oracle: string, output: string) {
      const builder = join(root, 'test', 'support', 'build-provenance.cjs');
      return spawnSync(
        process.execPath,
        [
          builder, '--build-root', root, '--expect-head', head,
          '--source-oracle', oracle, '--output', output,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
    }

    function prepareProvenance(root: string, head: string, oracle: string, output: string): void {
      const result = runProvenance(root, head, oracle, output);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    function runScenarioDriver(opts: {
      root: string;
      expectHead: string;
      provenance: string;
      oracle: string;
      artifact: string;
      guarded?: boolean;
    }) {
      const driver = join(opts.root, 'test', 'support', 'prune-scenarios.cjs');
      const guard = join(opts.root, 'test', 'support', 'guard.cjs');
      return spawnSync(
        process.execPath,
        [
          ...(opts.guarded === false ? [] : ['--require', guard]),
          driver,
          '--build-root', opts.root,
          '--expect-head', opts.expectHead,
          '--provenance-manifest', opts.provenance,
          '--source-oracle', opts.oracle,
          '--artifact-root', opts.artifact,
        ],
        { encoding: 'utf8', timeout: 90_000 },
      );
    }

    it('binds actual source, clean-compiled build, guard, and driver to an external verifier manifest', () => {
      const root = join(__dirname, '..', '..');
      const artifact = mkdtempSync(join(tmpdir(), 'qlb-scen-'));
      const trusted = mkdtempSync(join(tmpdir(), 'qlb-provenance-'));
      temps.push(artifact, trusted);
      const head = independentHead(root);
      const oracle = sourceOracle(root, head, trusted);
      const provenance = join(trusted, 'build-provenance.json');
      prepareProvenance(root, head, oracle, provenance);
      writeFileSync(join(artifact, 'HEAD.receipt'), `${'f'.repeat(40)}\n`);
      const result = runScenarioDriver({ root, expectHead: head, provenance, oracle, artifact });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(readFileSync(join(artifact, 'scenarios.json'), 'utf8')) as {
        testedHead: string;
        guardLoaded: boolean;
        sourceTreeSha256: string;
        buildTreeSha256: string;
        ok: boolean;
        results: Array<{ id: string }>;
      };
      assert.equal(report.testedHead, head);
      assert.equal(report.guardLoaded, true);
      assert.match(report.sourceTreeSha256, /^[0-9a-f]{64}$/);
      assert.match(report.buildTreeSha256, /^[0-9a-f]{64}$/);
      assert.equal(report.ok, true);
      assert.ok(report.results.length >= 20, `expected >=20 scenarios, got ${report.results.length}`);
      assert.ok(report.results.some((row) => row.id.includes('fresh-post-commit-rollback')));
      assert.ok(report.results.some((row) => row.id.includes('second-cycle-static-key')));
      assert.ok(report.results.some((row) => row.id.includes('true-enotdir')));
    });

    it('rejects mismatched head, stale binary, and modified source before scenarios', () => {
      const root = join(__dirname, '..', '..');
      const head = independentHead(root);
      const fixture = mkdtempSync(join(tmpdir(), 'qlb-provenance-negative-'));
      const trusted = mkdtempSync(join(tmpdir(), 'qlb-provenance-negative-manifest-'));
      temps.push(fixture, trusted);
      for (const rel of ['src', 'dist', 'test/support']) {
        mkdirSync(join(fixture, rel), { recursive: true });
        cpSync(join(root, rel), join(fixture, rel), { recursive: true });
      }
      for (const rel of ['package.json', 'package-lock.json', 'tsconfig.json']) {
        cpSync(join(root, rel), join(fixture, rel));
      }
      symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
      writeFileSync(join(fixture, 'HEAD.receipt'), `${head}\n`);
      const oracle = sourceOracle(root, head, trusted);
      const source = join(fixture, 'src', 'accounts-prune.ts');
      const originalSource = readFileSync(source, 'utf8');
      writeFileSync(source, `${originalSource}\n// mixed-source-before-preflight\n`);
      const mixed = runProvenance(fixture, head, oracle, join(trusted, 'must-not-exist.json'));
      assert.equal(mixed.status, 2, mixed.stderr || mixed.stdout);
      assert.match(mixed.stderr, /source does not match Git oracle/);
      writeFileSync(source, originalSource);

      const provenance = join(trusted, 'build-provenance.json');
      prepareProvenance(fixture, head, oracle, provenance);

      const fake = 'f'.repeat(40);
      const mismatch = runScenarioDriver({
        root: fixture, expectHead: fake, provenance, oracle,
        artifact: join(trusted, 'mismatch-artifacts'), guarded: false,
      });
      assert.equal(mismatch.status, 2, mismatch.stderr || mismatch.stdout);
      assert.match(mismatch.stderr, /provenance head mismatch/);

      const binary = join(fixture, 'dist', 'accounts-prune.js');
      const originalBinary = readFileSync(binary, 'utf8');
      writeFileSync(binary, `${originalBinary}\n// stale binary fixture\n`);
      const stale = runScenarioDriver({
        root: fixture, expectHead: head, provenance, oracle,
        artifact: join(trusted, 'stale-artifacts'), guarded: false,
      });
      assert.equal(stale.status, 2, stale.stderr || stale.stdout);
      assert.match(stale.stderr, /build provenance mismatch: dist\/accounts-prune\.js/);
      writeFileSync(binary, originalBinary);

      writeFileSync(source, `${readFileSync(source, 'utf8')}\n// modified source fixture\n`);
      const modified = runScenarioDriver({
        root: fixture, expectHead: head, provenance, oracle,
        artifact: join(trusted, 'modified-artifacts'), guarded: false,
      });
      assert.equal(modified.status, 2, modified.stderr || modified.stdout);
      assert.match(modified.stderr, /source provenance mismatch: src\/accounts-prune\.ts/);
    });
  },
);
