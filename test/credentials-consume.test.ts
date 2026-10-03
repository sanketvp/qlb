import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOwnedCredentialSource, notOwnedError } from '../src/credentials';
import { CSWAP_ACTIVE_ID, CSWAP_ANTHROPIC_STORE, CONSUME_STATE } from '../src/cswap-consume';
import { MockKeychain } from '../src/keychain';
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
});
