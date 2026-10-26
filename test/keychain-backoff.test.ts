import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KeychainBackedOff, KeychainReadBackoff } from '../src/keychain';

describe('Keychain read backoff', () => {
  it('backs off cached reads after an error but lets fresh reads through', () => {
    let now = 1_000;
    const backoff = new KeychainReadBackoff({ now: () => now });
    const failure = new Error('fixture keychain unavailable');

    assert.throws(() => backoff.read(() => { throw failure; }, { fresh: false }), /fixture keychain unavailable/);
    assert.throws(() => backoff.read(() => 'not reached', { fresh: false }), KeychainBackedOff);
    assert.equal(backoff.read(() => 'fresh value', { fresh: true }), 'fresh value');

    now += 60_001;
    assert.equal(backoff.read(() => 'cached value', { fresh: false }), 'cached value');
  });
});
