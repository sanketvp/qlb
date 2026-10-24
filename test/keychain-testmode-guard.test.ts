import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bootstrap, nativeAccessEnabled } from '../src/bootstrap';
import {
  MacosKeychainBackend,
  NativeKeychainDisabled,
  createRawCredentialBackend,
  markFakeExecutor,
  readNativeOpenRouterKey,
  type ExecFileSyncFn,
} from '../src/keychain';
import { execFileUtf8 } from '../src/credential-backends';
import { KeychainAccessDeniedError, assertKeychainAccess } from '../src/keychain-allowlist';

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
  const previous = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;
  Object.assign(process.env, updates);
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('test-mode Keychain guard', () => {
  it('uses an in-memory backend and blocks real macOS Keychain construction before security can run', () => {
    let securityCalls = 0;
    const spawnSpy: ExecFileSyncFn = () => {
      securityCalls += 1;
      throw new Error('security must not run in test mode');
    };

    withEnv({ QLB_TEST_MODE: '1', QLB_HOME: '/tmp/qlb-test-home' }, () => {
      assert.throws(() => new MacosKeychainBackend(), NativeKeychainDisabled);
      const backend = createRawCredentialBackend({
        platform: 'darwin',
        homedir: () => '/not-used',
        execFileSync: spawnSpy,
        commandExists: () => true,
      });
      backend.setSync('qlb:anthropic:test', 'test', 'fixture');
      assert.equal(backend.getSync('qlb:anthropic:test', 'test'), 'fixture');
      assert.equal(securityCalls, 0);
      assert.throws(
        () => assertKeychainAccess('qlb:anthropic:test', 'test', 'read'),
        KeychainAccessDeniedError,
      );
    });
  });

  it('blocks unbranded executors before they can access the native Keychain', () => {
    withEnv({ QLB_TEST_MODE: '1' }, () => {
      let calls = 0;
      const wrapper: ExecFileSyncFn = (...args) => {
        calls += 1;
        return execFileUtf8(...args);
      };
      assert.throws(() => new MacosKeychainBackend({ execFileSync: execFileUtf8 }), NativeKeychainDisabled);
      assert.throws(() => new MacosKeychainBackend({ execFileSync: wrapper }), NativeKeychainDisabled);
      assert.throws(() => readNativeOpenRouterKey('pi-openrouter', wrapper, 'darwin'), NativeKeychainDisabled);
      assert.equal(calls, 0);

      const fake = markFakeExecutor((file: string, args: readonly string[]) =>
        args[0] === 'find-generic-password' ? 'fake-key\n' : '');
      assert.doesNotThrow(() => new MacosKeychainBackend({ execFileSync: fake }));
      assert.equal(readNativeOpenRouterKey('pi-openrouter', fake, 'darwin'), 'fake-key');
    });
  });

  it('enables native access only when test mode is unset', () => {
    assert.equal(nativeAccessEnabled({}), true);
    assert.equal(nativeAccessEnabled({ QLB_TEST_MODE: '1' }), false);
    assert.equal(nativeAccessEnabled({ QLB_TEST_MODE: '0' }), false);
  });

  it('refuses a test home unless test mode is explicitly enabled', async () => {
    await assert.rejects(
      () => bootstrap({}, { QLB_HOME: '/tmp/qlb-test-home' }),
      /QLB_HOME requires QLB_TEST_MODE=1/,
    );
    await assert.doesNotReject(() => bootstrap({}, {
      QLB_HOME: '/tmp/qlb-test-home',
      QLB_TEST_MODE: '1',
    }));
  });
});
