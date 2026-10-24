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

  it('allows pi-openrouter reads only', () => {
    const { backend, calls } = guardedFakeSecurity();
    assert.equal(backend.getSync('pi-openrouter', 'any-account'), 'saved-value');
    assert.throws(
      () => backend.setSync('pi-openrouter', 'any-account', 'secret'),
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

  it('uses security -i below its line-buffer guard and argv -X above it', () => {
    const service = 'qlb:anthropic:acct-1';
    const account = 'account';
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    const exec: ExecFileSyncFn = (file, args, options) => {
      calls.push({
        file,
        args: [...args],
        input: typeof options?.input === 'string' ? options.input : undefined,
      });
      return '';
    };
    const backend = withServiceGuard(new MacosKeychainBackend({ execFileSync: exec }), {
      macosUserName: () => MACOS_USER,
    });
    const commandBytes = (value: string) => Buffer.byteLength(
      `add-generic-password -U -a "${account}" -s "${service}" -X ${Buffer.from(value).toString('hex')}\n`,
      'utf8',
    );
    const under = 'x'.repeat(Math.floor((4032 - commandBytes('')) / 2));
    const over = `${under}x`;

    assert.ok(commandBytes(under) <= 4032);
    assert.ok(commandBytes(over) > 4032);
    backend.setSync(service, account, under);
    backend.setSync(service, account, over);

    assert.deepEqual(calls[0], {
      file: '/usr/bin/security',
      args: ['-i'],
      input: `add-generic-password -U -a "${account}" -s "${service}" -X ${Buffer.from(under).toString('hex')}\n`,
    });
    assert.deepEqual(calls[1], {
      file: '/usr/bin/security',
      args: [
        'add-generic-password', '-U', '-a', account, '-s', service, '-X', Buffer.from(over).toString('hex'),
      ],
      input: undefined,
    });
  });

  it('quotes security -i fields and rejects line separators before writing', () => {
    const { backend, calls } = guardedFakeSecurity();
    backend.setSync('qlb:service\\"name', 'account\\"name', 'safe-value');
    assert.deepEqual(calls[0], {
      file: '/usr/bin/security',
      args: ['-i'],
      input: 'add-generic-password -U -a "account\\\\\\"name" -s "qlb:service\\\\\\"name" -X 736166652d76616c7565\n',
    });
    assert.throws(
      () => backend.setSync('qlb:service', 'account\ninjected-command', 'safe-value'),
      /must not contain CR, LF, or NUL/,
    );
    assert.equal(calls.length, 1);
  });

  it('redacts both plaintext and hex payloads from write failures', () => {
    const secret = 'UNIQUE_SYNTHETIC_SECRET';
    const hex = Buffer.from(secret).toString('hex');
    const exec: ExecFileSyncFn = () => {
      throw new Error(`security rejected ${secret} (${hex})`);
    };
    const backend = withServiceGuard(new MacosKeychainBackend({ execFileSync: exec }), {
      macosUserName: () => MACOS_USER,
    });

    assert.throws(
      () => backend.setSync('Claude Code-credentials', MACOS_USER, secret),
      (err: Error) => {
        assert.equal(err.message.includes(secret), false);
        assert.equal(err.message.includes(hex), false);
        assert.equal(err.message, `keychain set failed for service=Claude Code-credentials account=${MACOS_USER}`);
        return true;
      },
    );
  });
});
