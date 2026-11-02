import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KeychainAccessDeniedError,
  MacosKeychainBackend,
  assertKeychainAccess,
  assertNativeOpenRouterService,
  defaultKeychainHelperPath,
  MACOS_SECURITY_BIN,
  MACOS_SECURITY_TIMEOUT_MS,
  markFakeExecutor,
  readNativeOpenRouterKey,
  withServiceGuard,
  type ExecFileSyncFn,
} from '../src/keychain';
import { withUndoCapability } from '../src/keychain-allowlist';

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
    backend: withServiceGuard(new MacosKeychainBackend({ execFileSync: markFakeExecutor(exec) }), {
      macosUserName: () => MACOS_USER,
      env: {},
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

  it('allows qlb-test-* services for reads, writes, and deletes only', () => {
    const { backend, calls } = guardedFakeSecurity();
    backend.setSync('qlb-test-roundtrip', 'any-account', 'secret');
    assert.equal(backend.getSync('qlb-test-roundtrip', 'any-account'), 'saved-value');
    backend.deleteSync('qlb-test-roundtrip', 'any-account');
    assert.equal(calls.length, 3);

    for (const service of ['qlbtest-roundtrip', 'qlb-tes-roundtrip']) {
      for (const operation of ['read', 'write'] as const) {
        assert.throws(
          () => assertKeychainAccess(service, 'any-account', operation),
          KeychainAccessDeniedError,
        );
      }
    }
  });

  it('allows claude-swap reads only outside the undo capability', () => {
    const { backend, calls } = guardedFakeSecurity();
    assert.equal(backend.getSync('claude-swap', 'legacy-account'), 'saved-value');
    assert.throws(
      () => backend.setSync('claude-swap', 'legacy-account', 'secret'),
      KeychainAccessDeniedError,
    );
    assert.throws(
      () => backend.deleteSync('claude-swap', 'legacy-account'),
      KeychainAccessDeniedError,
    );
    assert.equal(calls.length, 1);
  });

  it('grants claude-swap writes and deletes only while the undo capability is held', () => {
    const { backend, calls } = guardedFakeSecurity();

    assert.throws(
      () => backend.setSync('claude-swap', 'legacy-account', 'secret'),
      KeychainAccessDeniedError,
    );
    assert.throws(
      () => backend.deleteSync('claude-swap', 'legacy-account'),
      KeychainAccessDeniedError,
    );

    withUndoCapability(() => {
      backend.setSync('claude-swap', 'legacy-account', 'secret');
      backend.deleteSync('claude-swap', 'legacy-account');
      assert.throws(
        () => backend.setSync('pi-openrouter', 'legacy-account', 'secret'),
        KeychainAccessDeniedError,
      );
    });

    assert.throws(
      () => backend.setSync('claude-swap', 'legacy-account', 'secret'),
      KeychainAccessDeniedError,
    );
    assert.equal(calls.length, 2);
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

  it('allows only pi-openrouter for native OpenRouter reads before backend access', () => {
    assert.doesNotThrow(() => assertNativeOpenRouterService('pi-openrouter', { env: {} }));
    for (const service of ['some-other-app', 'qlb:openrouter:x', 'claude-swap']) {
      assert.throws(
        () => assertNativeOpenRouterService(service),
        KeychainAccessDeniedError,
      );
    }
  });

  it('bounds native OpenRouter reads and surfaces a timeout distinctly from a miss', () => {
    let timeoutMs: number | undefined;
    const timeout = Object.assign(new Error('fake security timed out'), { code: 'ETIMEDOUT' });

    assert.throws(
      () => readNativeOpenRouterKey('pi-openrouter', markFakeExecutor((_file, _args, options) => {
        timeoutMs = options?.timeout;
        throw timeout;
      }), 'darwin'),
      /security find-generic-password timed out after 5s/,
    );
    assert.equal(timeoutMs, MACOS_SECURITY_TIMEOUT_MS);
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
      { macosUserName: () => MACOS_USER, env: {} },
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

  it('creates a new item through security with both trusted applications', () => {
    const service = 'qlb:anthropic:acct-1';
    const account = 'account';
    const calls: Array<{ file: string; args: string[]; input?: string; stdio?: unknown }> = [];
    const exec: ExecFileSyncFn = (file, args, options) => {
      calls.push({
        file, args: [...args], input: typeof options?.input === 'string' ? options.input : undefined,
        stdio: options?.stdio,
      });
      return '';
    };
    const backend = withServiceGuard(new MacosKeychainBackend({ execFileSync: markFakeExecutor(exec) }), {
      macosUserName: () => MACOS_USER, env: {},
    });
    const payload = 'x'.repeat(16 * 1024);
    backend.setSync(service, account, payload);
    assert.deepEqual(calls, [{
      file: MACOS_SECURITY_BIN,
      args: [
        'add-generic-password', '-a', account, '-s', service,
        '-X', Buffer.from(payload, 'utf8').toString('hex'),
        '-T', defaultKeychainHelperPath(), '-T', MACOS_SECURITY_BIN,
      ],
      input: undefined,
      stdio: 'ignore',
    }]);
  });

  it('updates an existing item after the create reports a duplicate', () => {
    const service = 'qlb:anthropic:acct-1';
    const account = 'account';
    const payload = 'safe-value';
    const calls: Array<{ file: string; args: string[] }> = [];
    const duplicate = Object.assign(new Error('duplicate item'), { status: 45 });
    const exec: ExecFileSyncFn = (file, args) => {
      calls.push({ file, args: [...args] });
      if (calls.length === 1) throw duplicate;
      return '';
    };
    const backend = withServiceGuard(new MacosKeychainBackend({ execFileSync: markFakeExecutor(exec) }), {
      macosUserName: () => MACOS_USER, env: {},
    });

    backend.setSync(service, account, payload);

    assert.deepEqual(calls, [
      {
        file: MACOS_SECURITY_BIN,
        args: [
          'add-generic-password', '-a', account, '-s', service,
          '-X', Buffer.from(payload, 'utf8').toString('hex'),
          '-T', defaultKeychainHelperPath(), '-T', MACOS_SECURITY_BIN,
        ],
      },
      {
        file: MACOS_SECURITY_BIN,
        args: [
          'add-generic-password', '-U', '-a', account, '-s', service,
          '-X', Buffer.from(payload, 'utf8').toString('hex'),
        ],
      },
    ]);
    assert.equal(calls[1]!.args.includes('-T'), false);
  });

  it('passes unusual fields as security argv values without constructing an interactive command', () => {
    const { backend, calls } = guardedFakeSecurity();
    const service = 'qlb:service\\"name';
    const account = 'account\\"name';
    const payload = 'safe-value';
    backend.setSync(service, account, payload);
    assert.deepEqual(calls[0], {
      file: MACOS_SECURITY_BIN,
      args: [
        'add-generic-password', '-a', account, '-s', service,
        '-X', Buffer.from(payload, 'utf8').toString('hex'),
        '-T', defaultKeychainHelperPath(), '-T', MACOS_SECURITY_BIN,
      ],
      input: undefined,
    });
  });

  it('bounds every macOS security operation and reports timeouts without command output', () => {
    const calls: Array<{ args: string[]; timeout?: number }> = [];
    const timeout = Object.assign(new Error('fake runner timed out'), { code: 'ETIMEDOUT' });
    const exec: ExecFileSyncFn = (_file, args, options) => {
      calls.push({ args: [...args], timeout: options?.timeout });
      throw timeout;
    };
    const backend = new MacosKeychainBackend({ execFileSync: markFakeExecutor(exec) });

    assert.throws(
      () => backend.setSync('qlb:timeout', 'account', 'secret'),
      /security add-generic-password timed out after 5s/
    );
    assert.throws(
      () => backend.getSync('qlb:timeout', 'account'),
      /security find-generic-password timed out after 5s/,
    );
    assert.throws(
      () => backend.deleteSync('qlb:timeout', 'account'),
      /security keychain helper delete timed out after 5s/
    );
    assert.deepEqual(calls.map((call) => call.timeout), [5000, 5000, 5000]);
  });

  it('does not update when create fails for a status other than duplicate and redacts the error', () => {
    const secret = 'UNIQUE_SYNTHETIC_SECRET';
    const hex = Buffer.from(secret).toString('hex');
    let calls = 0;
    const exec: ExecFileSyncFn = () => {
      calls += 1;
      throw Object.assign(new Error(`security rejected ${secret} (${hex})`), {
        status: 36,
        cmd: `${MACOS_SECURITY_BIN} add-generic-password -X ${hex}`,
        spawnargs: ['-X', hex],
        stdout: secret,
        stderr: hex,
      });
    };
    const backend = withServiceGuard(new MacosKeychainBackend({ execFileSync: markFakeExecutor(exec) }), {
      macosUserName: () => MACOS_USER,
      env: {},
    });

    assert.throws(
      () => backend.setSync('Claude Code-credentials', MACOS_USER, secret),
      (err: Error) => {
        assert.equal(err.message.includes(secret), false);
        assert.equal(err.message.includes(hex), false);
        assert.equal(err.stack?.includes(secret) ?? false, false);
        assert.equal(err.stack?.includes(hex) ?? false, false);
        for (const key of Reflect.ownKeys(err)) {
          const value = Object.getOwnPropertyDescriptor(err, key)?.value;
          assert.equal(String(value).includes(secret), false);
          assert.equal(String(value).includes(hex), false);
        }
        assert.equal(err.message, `keychain set failed for service=Claude Code-credentials account=${MACOS_USER}`);
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  for (const stage of ['create', 'update'] as const) {
    it(`redacts a timed-out ${stage} write`, () => {
      const secret = 'UNIQUE_SYNTHETIC_TIMEOUT_SECRET';
      const hex = Buffer.from(secret).toString('hex');
      let calls = 0;
      const timeout = Object.assign(new Error(`security timed out ${secret} (${hex})`), {
        code: 'ETIMEDOUT', cmd: `${MACOS_SECURITY_BIN} add-generic-password -X ${hex}`,
      });
      const exec: ExecFileSyncFn = () => {
        calls += 1;
        if (stage === 'update' && calls === 1) throw Object.assign(new Error('duplicate item'), { status: 45 });
        throw timeout;
      };
      const backend = withServiceGuard(new MacosKeychainBackend({ execFileSync: markFakeExecutor(exec) }), {
        macosUserName: () => MACOS_USER, env: {},
      });

      assert.throws(() => backend.setSync('Claude Code-credentials', MACOS_USER, secret), (err: Error) => {
        assert.equal(err.message, 'security add-generic-password timed out after 5s');
        assert.equal(err.message.includes(secret), false);
        assert.equal(err.message.includes(hex), false);
        assert.equal(err.stack?.includes(secret) ?? false, false);
        assert.equal(err.stack?.includes(hex) ?? false, false);
        for (const key of Reflect.ownKeys(err)) {
          const value = Object.getOwnPropertyDescriptor(err, key)?.value;
          assert.equal(String(value).includes(secret), false);
          assert.equal(String(value).includes(hex), false);
        }
        return true;
      });
      assert.equal(calls, stage === 'create' ? 1 : 2);
    });
  }
});
