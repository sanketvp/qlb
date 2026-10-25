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
  it('marks only services with every operation allowed as safe', () => {
    assert.equal(isSafeKeychainService('qlb:anthropic:acct-1'), true);
    assert.equal(isSafeKeychainService('claude-swap'), false);
    assert.equal(isSafeKeychainService('Claude Code-credentials'), false);
    assert.equal(isSafeKeychainService('pi-openrouter'), false);
    assert.equal(isSafeKeychainService('qlb-test-roundtrip'), true);
    assert.equal(isSafeKeychainService(''), false);
    assert.equal(isSafeKeychainService('generic'), false);
    assert.doesNotThrow(() => assertSafeKeychainService('qlb:anthropic:acct-1'));
    assert.doesNotThrow(() => assertSafeKeychainService('qlb-test-roundtrip'));
    for (const service of ['claude-swap', 'Claude Code-credentials', 'pi-openrouter', 'generic']) {
      assert.throws(() => assertSafeKeychainService(service));
    }
  });

  it('qlbKeychainService uses qlb:<provider>:<accountId>', () => {
    assert.equal(qlbKeychainService('anthropic', 'acct-1'), 'qlb:anthropic:acct-1');
  });

  it('real keychainSet/Get/Delete refuse unsafe service names before calling security', async () => {
    await assert.rejects(
      () => keychainSet('claude-swap', 'x', '{"access":"nope"}'),
      /claude-swap is read-only/,
    );
    await assert.rejects(
      () => keychainGet('~/.pi/agent/auth.json', 'x'),
      /service is not allowlisted/,
    );
    await assert.rejects(
      () => keychainDelete('codex-auth', 'x'),
      /service is not allowlisted/,
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
