import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOwnedCredentialSource, notOwnedError } from '../src/credentials';
import { CSWAP_ACTIVE_ID, CSWAP_ANTHROPIC_STORE, CONSUME_STATE } from '../src/cswap-consume';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import { sharedSingleGrantCoords } from '../src/single-grant-ownership';
import { openStore } from '../src/store';

describe('credentials consume gating', () => {
  it('Anthropic injects iff cswap-anthropic=CONSUMED; other providers reject CONSUMED', async () => {
    const store = openStore(':memory:');
    const keychain = new MockKeychain();
    const srcOff = createOwnedCredentialSource({
      store,
      keychain,
      getConsumedAccess: () => 'consumed-access',
    });
    await assert.rejects(() => srcOff(CSWAP_ACTIVE_ID), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /not yet owned/);
      return true;
    });

    store.upsertMigration(CSWAP_ANTHROPIC_STORE, CONSUME_STATE, '{}');
    const srcOn = createOwnedCredentialSource({
      store,
      keychain,
      getConsumedAccess: () => 'consumed-access',
    });
    assert.equal(await srcOn(CSWAP_ACTIVE_ID), 'consumed-access');
    await assert.rejects(() => srcOn('org-other'), (err: unknown) => err instanceof Error);

    for (const [storeName, accountId] of [
      ['pi-xai', 'xai-default'],
      ['pi-openai-codex', 'codex-default'],
      ['pi-kimi-coding', 'kimi-default'],
      ['pi-openrouter', 'openrouter-default'],
    ] as const) {
      store.upsertMigration(storeName, CONSUME_STATE, '{}');
      await assert.rejects(
        () => srcOn(accountId),
        (err: unknown) => err instanceof Error && err.message.includes('not yet owned'),
      );
    }
    store.close();
    void notOwnedError;
  });

  it('the proxy reads the Keychain item the generic journal records', async () => {
    for (const [provider, accountId] of [
      ['xai', 'xai-default'],
      ['kimi-coding', 'kimi-default'],
    ] as const) {
      const store = openStore(':memory:');
      const keychain = new MockKeychain();
      const shared = sharedSingleGrantCoords(provider);
      const journalLabel = `${provider}-journal-label`;
      store.upsertAccount(accountId, provider, 'label-overwritten-by-pi-migrate');
      keychain.setSync(shared.service, shared.account, JSON.stringify({
        access: `${provider}-shared`, refresh: 'fixture-refresh', expires: 1,
      }));
      keychain.setSync(qlbKeychainService(provider, accountId), journalLabel, JSON.stringify({
        access: `${provider}-legacy`, refresh: 'fixture-refresh', expires: 1,
      }));

      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({
        accounts: [{ id: accountId, provider, label: journalLabel, keychain: shared }],
      }));
      const source = createOwnedCredentialSource({ store, keychain });
      assert.equal(await source(accountId), `${provider}-shared`, `${provider} shared`);

      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({
        accounts: [{ id: accountId, provider, label: journalLabel }],
      }));
      assert.equal(await source(accountId), `${provider}-legacy`, `${provider} legacy`);
      store.close();
    }
  });

  it('proxy owned read refuses a generic journal with more than one account', async () => {
    for (const [provider, accountId] of [
      ['xai', 'xai-default'],
      ['kimi-coding', 'kimi-default'],
    ] as const) {
      const store = openStore(':memory:');
      const keychain = new MockKeychain();
      const shared = sharedSingleGrantCoords(provider);
      const account = { id: accountId, provider, label: `${provider}-fixture`, keychain: shared };
      keychain.setSync(shared.service, shared.account, JSON.stringify({
        access: `${provider}-fixture`, refresh: 'fixture-refresh', expires: 1,
      }));
      const setSync = keychain.setSync.bind(keychain);
      const deleteSync = keychain.deleteSync.bind(keychain);
      const writes: string[] = [];
      const deletes: string[] = [];
      keychain.setSync = (service, name, value) => {
        writes.push(`${service}/${name}`);
        return setSync(service, name, value);
      };
      keychain.deleteSync = (service, name) => {
        deletes.push(`${service}/${name}`);
        return deleteSync(service, name);
      };
      store.upsertAccount(accountId, provider, account.label);
      store.upsertMigration(`pi-${provider}`, 'QLB_OWNED', JSON.stringify({ accounts: [account, { ...account }] }));

      await assert.rejects(() => createOwnedCredentialSource({ store, keychain })(accountId), /journal-keychain-invalid/);
      assert.deepEqual(writes, []);
      assert.deepEqual(deletes, []);
      store.close();
    }
  });

  it('the proxy refuses a malformed or mismatched generic journal without reading the Keychain', async () => {
    for (const detailJson of [
      '{not-json',
      JSON.stringify({ accounts: [{ id: 'xai-default', provider: 'kimi-coding', label: 'fixture' }] }),
    ]) {
      const store = openStore(':memory:');
      const keychain = new MockKeychain();
      const getSync = keychain.getSync.bind(keychain);
      let getSyncCalls = 0;
      keychain.getSync = (service: string, account: string): string => {
        getSyncCalls += 1;
        return getSync(service, account);
      };
      store.upsertAccount('xai-default', 'xai', 'account-row-fallback');
      store.upsertMigration('pi-xai', 'QLB_OWNED', detailJson);

      await assert.rejects(() => createOwnedCredentialSource({ store, keychain })('xai-default'));
      assert.equal(getSyncCalls, 0);
      store.close();
    }
  });
});
