import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import xaiGate, { read } from '../src/gate/xai';

describe('xai gate module', () => {
  it('reads the QLB-owned default credential through the P6 resolver', () => {
    const credential = read({
      resolve: () => ({
        token: 'fixture-xai-access',
        accountId: 'default',
        expiresAt: 4_102_444_800_000,
        source: 'keychain',
      }),
    });

    assert.deepEqual(credential, {
      token: 'fixture-xai-access',
      accountId: 'default',
      expiresAt: 4_102_444_800_000,
      source: 'keychain',
    });
    assert.equal(xaiGate.read, read);
    assert.equal(typeof xaiGate.refresh, 'function');
  });
});
