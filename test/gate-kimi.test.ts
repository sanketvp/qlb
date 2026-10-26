import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import gate from '../src/gate/kimi-coding';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { resolve } from '../src/token/kimi-coding';

describe('Kimi Coding gate', () => {
  it('reads only the QLB-owned default credential', () => {
    const keychain = new MockKeychain();
    keychain.setSync(
      qlbKeychainService('kimi-coding', 'default'),
      QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify({ access: 'kimi-test-access', refresh: 'not-returned', expires: 123 }),
    );

    assert.deepEqual(resolve({ keychain }), {
      token: 'kimi-test-access', accountId: 'default', expiresAt: 123, source: 'keychain',
    });
  });

  it('leaves synchronous refresh unimplemented until P13 owns single-consume', () => {
    assert.throws(() => gate.refresh!(), /not-implemented/);
  });
});
