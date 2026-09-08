import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MockKeychain,
  assertSafeKeychainService,
  isSafeKeychainService,
  keychainDelete,
  keychainGet,
  keychainSet,
  qlbKeychainService,
} from '../src/keychain';

describe('keychain service-name safety', () => {
  it('accepts qlb: and qlb-test- prefixes only', () => {
    assert.equal(isSafeKeychainService('qlb:anthropic:acct-1'), true);
    assert.equal(isSafeKeychainService('qlb-test-roundtrip'), true);
    assert.equal(isSafeKeychainService('Claude Code-credentials'), false);
    assert.equal(isSafeKeychainService(''), false);
    assert.equal(isSafeKeychainService('generic'), false);
    assert.throws(
      () => assertSafeKeychainService('Claude Code-credentials'),
      /must start with 'qlb:' or 'qlb-test-'/,
    );
  });

  it('qlbKeychainService uses qlb:<provider>:<accountId>', () => {
    assert.equal(qlbKeychainService('anthropic', 'acct-1'), 'qlb:anthropic:acct-1');
  });

  it('real keychainSet/Get/Delete refuse unsafe service names before calling security', async () => {
    await assert.rejects(
      () => keychainSet('Claude Code-credentials', 'x', '{"access":"nope"}'),
      /must start with 'qlb:' or 'qlb-test-'/,
    );
    await assert.rejects(
      () => keychainGet('~/.pi/agent/auth.json', 'x'),
      /must start with 'qlb:' or 'qlb-test-'/,
    );
    await assert.rejects(
      () => keychainDelete('codex-auth', 'x'),
      /must start with 'qlb:' or 'qlb-test-'/,
    );
  });
});

describe('MockKeychain', () => {
  it('set/get/delete roundtrip', async () => {
    const kc = new MockKeychain();
    const service = 'qlb:anthropic:acct-1';
    const account = 'Test Account';
    const blob = JSON.stringify({
      access: 'tok',
      refresh: 'rt',
      expires: 1,
      generation: 0,
    });
    await kc.set(service, account, blob);
    assert.equal(await kc.get(service, account), blob);
    await kc.delete(service, account);
    await assert.rejects(() => kc.get(service, account), /item not found/);
  });

  it('set overwrites (like security -U)', async () => {
    const kc = new MockKeychain();
    await kc.set('qlb:xai:a', 'A', 'one');
    await kc.set('qlb:xai:a', 'A', 'two');
    assert.equal(await kc.get('qlb:xai:a', 'A'), 'two');
  });

  it('get and delete throw when missing', async () => {
    const kc = new MockKeychain();
    await assert.rejects(() => kc.get('qlb:missing', 'x'), /item not found/);
    await assert.rejects(() => kc.delete('qlb:missing', 'x'), /item not found/);
  });

  it('isolates items by service+account', async () => {
    const kc = new MockKeychain();
    await kc.set('qlb:a:1', 'L', 'v1');
    await kc.set('qlb:a:2', 'L', 'v2');
    await kc.set('qlb:a:1', 'M', 'v3');
    assert.equal(await kc.get('qlb:a:1', 'L'), 'v1');
    assert.equal(await kc.get('qlb:a:2', 'L'), 'v2');
    assert.equal(await kc.get('qlb:a:1', 'M'), 'v3');
  });
});
