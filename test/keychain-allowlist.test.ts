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

  it('writes large macOS payloads through argv and redacts child errors', () => {
    const secret = JSON.stringify({ grant: `UNIQUE_SECRET_${'x'.repeat(4 * 1024)}` });
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    const exec: ExecFileSyncFn = (file, args, options) => {
      calls.push({
        file,
        args: [...args],
        input: typeof options?.input === 'string' ? options.input : undefined,
      });
      throw new Error(`security rejected ${secret}`);
    };
    const backend = withServiceGuard(new MacosKeychainBackend({ execFileSync: exec }), {
      macosUserName: () => MACOS_USER,
    });

    assert.ok(Buffer.byteLength(secret, 'utf8') > 4095);
    assert.throws(
      () => backend.setSync('Claude Code-credentials', MACOS_USER, secret),
      (err: Error) => {
        assert.equal(err.message.includes(secret), false);
        assert.equal(err.message, `keychain set failed for service=Claude Code-credentials account=${MACOS_USER}`);
        return true;
      },
    );
    assert.deepEqual(calls, [{
      file: 'security',
      args: [
        'add-generic-password', '-a', MACOS_USER, '-s', 'Claude Code-credentials', '-w', secret, '-U',
      ],
      input: undefined,
    }]);
  });
});
