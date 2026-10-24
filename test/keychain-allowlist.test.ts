import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KeychainAccessDeniedError,
  MacosKeychainBackend,
  assertKeychainAccess,
  withServiceGuard,
  type ExecFileSyncFn,
} from '../src/keychain';

const MACOS_USER = 'test-macos-user';

function guardedFakeSecurity() {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const exec: ExecFileSyncFn = (file, args, options) => {
    calls.push({
      file,
      args: [...args],
      input: typeof options?.input === 'string' ? options.input : undefined,
    });
    return args[0] === 'find-generic-password' ? 'saved-value\n' : '';
  };
  return {
    calls,
    backend: withServiceGuard(new MacosKeychainBackend({ execFileSync: exec }), {
      macosUserName: () => MACOS_USER,
    }),
  };
}

const CLAUDE_SERVICES = [
  'Claude Code-credentials',
  'Claude Code-credentials-deadbeef',
];

describe('Keychain access allowlist', () => {
  it('allows qlb services for reads and writes', () => {
    const { backend, calls } = guardedFakeSecurity();
    backend.setSync('qlb:anthropic:acct-1', 'any-account', 'secret');
    assert.equal(backend.getSync('qlb:anthropic:acct-1', 'any-account'), 'saved-value');
    assert.equal(calls.length, 2);
  });

  it('allows claude-swap reads only', () => {
    const { backend, calls } = guardedFakeSecurity();
    assert.equal(backend.getSync('claude-swap', 'legacy-account'), 'saved-value');
    assert.throws(
      () => backend.setSync('claude-swap', 'legacy-account', 'secret'),
      KeychainAccessDeniedError,
    );
    assert.equal(calls.length, 1);
  });

  for (const service of CLAUDE_SERVICES) {
    it(`allows ${service} reads and writes for the macOS user`, () => {
      const { backend, calls } = guardedFakeSecurity();
      backend.setSync(service, MACOS_USER, 'secret');
      assert.equal(backend.getSync(service, MACOS_USER), 'saved-value');
      assert.equal(calls.length, 2);
    });

    it(`refuses ${service} for a different account on reads and writes`, () => {
      const { backend, calls } = guardedFakeSecurity();
      assert.throws(
        () => backend.setSync(service, 'another-user', 'secret'),
        KeychainAccessDeniedError,
      );
      assert.throws(
        () => backend.getSync(service, 'another-user'),
        KeychainAccessDeniedError,
      );
      assert.equal(calls.length, 0);
    });
  }

  it('refuses unknown services for reads and writes', () => {
    const { backend, calls } = guardedFakeSecurity();
    assert.throws(
      () => backend.setSync('unrelated-service', 'account', 'secret'),
      KeychainAccessDeniedError,
    );
    assert.throws(
      () => backend.getSync('unrelated-service', 'account'),
      KeychainAccessDeniedError,
    );
    assert.equal(calls.length, 0);
  });

  it('accepts exactly eight lowercase hexadecimal suffix characters', () => {
    assert.doesNotThrow(() => assertKeychainAccess(
      'Claude Code-credentials-0123abcd', MACOS_USER, 'read',
      { macosUserName: () => MACOS_USER },
    ));
    for (const suffix of ['1234abc', '1234abcde', '1234ABCD', '1234abcd!', 'not-hex!']) {
      for (const operation of ['read', 'write'] as const) {
        assert.throws(
          () => assertKeychainAccess(
            `Claude Code-credentials-${suffix}`, MACOS_USER, operation,
            { macosUserName: () => MACOS_USER },
          ),
          KeychainAccessDeniedError,
        );
      }
    }
  });

  it('passes macOS secret material only through security -i stdin', () => {
    const secret = 'secret-that-must-not-be-in-argv';
    const { backend, calls } = guardedFakeSecurity();
    backend.setSync('Claude Code-credentials', MACOS_USER, secret);
    const call = calls[0];
    assert.equal(call?.file, 'security');
    assert.deepEqual(call?.args, ['-i']);
    assert.match(call?.input ?? '', /^add-generic-password -U /);
    assert.match(call?.input ?? '', / -X [0-9a-f]+\n$/);
    assert.equal(call?.input?.includes(secret), false);
    assert.equal(call?.args.some((arg) => arg.includes(secret)), false);
  });
});
