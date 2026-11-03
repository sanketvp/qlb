import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import childProcess = require('node:child_process');
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import {
  isCredentialNotFound,
  isSecurityTimeout,
  keychainClientExecFileSync,
  macosKeychainExec,
  wrapCredentialError,
} from '../src/credential-backends';
import {
  DPAPI_DECRYPT_SCRIPT,
  DPAPI_ENCRYPT_SCRIPT,
  LinuxEncryptedFileBackend,
  LinuxLibsecretBackend,
  MacosKeychainBackend,
  WINDOWS_POWERSHELL_BASE_ARGS,
  WINDOWS_POWERSHELL_EXE,
  WindowsDpapiBackend,
  createRawCredentialBackend,
  defaultCredentialBackendHost,
  linuxSecretToolClearArgs,
  linuxSecretToolLookupArgs,
  linuxSecretToolStoreArgs,
  markFakeExecutor,
  selectBackendKind,
  type ExecFileSyncFn,
} from '../src/keychain';
import {
  KeychainRequestStillWaiting,
  isKeychainStillWaiting,
  keychainRequestFromArgv,
  runKeychainClientSync,
} from '../src/keychain-client';
import { portableLockf } from './support/portable-lockf';

describe('isCredentialNotFound', () => {
  it('accepts only definitive absent-item errors, including wrapped causes', () => {
    assert.equal(isCredentialNotFound({ status: 44 }), true);
    assert.equal(isCredentialNotFound(new Error('The specified item could not be found in the keychain.')), true);
    assert.equal(isCredentialNotFound(new Error('keychain delete failed: item not found')), true);
    assert.equal(
      isCredentialNotFound(Object.assign(new Error('credential operation failed'), {
        cause: new Error('The specified item could not be found in the keychain.'),
      })),
      true,
    );
  });

  it('rejects missing keychains, access failures, other statuses, and non-errors', () => {
    assert.equal(isCredentialNotFound(new Error('The specified keychain could not be found.')), false);
    assert.equal(isCredentialNotFound(new Error('User interaction is not allowed.')), false);
    assert.equal(isCredentialNotFound({ status: 51 }), false);
    assert.equal(isCredentialNotFound({ status: 36 }), false);
    assert.equal(isCredentialNotFound(null), false);
    assert.equal(isCredentialNotFound('item not found'), false);
  });
});

function withNoKillState<T>(fn: (state: { home: string; dir: string; lockfPath: string }) => T): T {
  const state = {
    home: mkdtempSync(join(tmpdir(), 'qlb-nokill-home-')),
    dir: mkdtempSync(join(tmpdir(), 'qlb-nokill-fake-')),
    lockfPath: '',
  };
  state.lockfPath = portableLockf(state.dir);
  const before = { QLB_TEST_MODE: process.env.QLB_TEST_MODE, QLB_HOME: process.env.QLB_HOME, HOME: process.env.HOME };
  Object.assign(process.env, { QLB_TEST_MODE: '1', QLB_HOME: state.home, HOME: state.home });
  try { return fn(state); } finally {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

function noKillFake(dir: string, body: string, name = 'security-fake'): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nset -eu\nd=$(dirname "$0")\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function waitForOwnExit(path: string, timeoutMs = 20_000): void {
  if (!existsSync(path)) return;
  const pid = Number(readFileSync(path, 'utf8'));
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return; }
    childProcess.spawnSync('/bin/sh', ['-c', 'sleep 0.05'], {
      env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: process.env.QLB_HOME!, HOME: process.env.HOME! },
    });
  }
  assert.fail('own fake did not exit in time');
}

function stopOwnFake(pidPath: string): void {
  if (!existsSync(pidPath)) return;
  try { process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGKILL'); } catch { /* own fake already exited */ }
}

function noKillExecutor(fake: string, lockfPath: string): ExecFileSyncFn {
  return markFakeExecutor((_file, args, options) => String(runKeychainClientSync({
    ...keychainRequestFromArgv(options!.keychainKind!, fake, args, {
      timeoutMs: options!.timeout as number,
      lockfPath,
    }),
    lockfPath,
  })));
}

describe('CredentialBackend dispatch', () => {
  it('selects macos-keychain on darwin regardless of secret-tool', () => {
    assert.equal(
      selectBackendKind({ platform: 'darwin', commandExists: () => true }),
      'macos-keychain',
    );
    assert.equal(
      selectBackendKind({ platform: 'darwin', commandExists: () => false }),
      'macos-keychain',
    );
    const backend = createRawCredentialBackend({
      platform: 'darwin',
      homedir: () => '/tmp',
      execFileSync: markFakeExecutor(() => ''),
      commandExists: () => true,
    }, { env: {} });
    assert.equal(backend.kind, 'macos-keychain');
    assert.ok(backend instanceof MacosKeychainBackend);
  });

  it('selects linux-libsecret when secret-tool exists', () => {
    assert.equal(
      selectBackendKind({
        platform: 'linux',
        commandExists: (name) => name === 'secret-tool',
      }),
      'linux-libsecret',
    );
    const backend = createRawCredentialBackend({
      platform: 'linux',
      homedir: () => '/tmp',
      execFileSync: () => '',
      commandExists: (name) => name === 'secret-tool',
    }, { env: {} });
    assert.equal(backend.kind, 'linux-libsecret');
    assert.ok(backend instanceof LinuxLibsecretBackend);
  });

  it('falls back to linux-file when secret-tool is missing', () => {
    assert.equal(
      selectBackendKind({ platform: 'linux', commandExists: () => false }),
      'linux-file',
    );
    const dir = mkdtempSync(join(tmpdir(), 'qlb-dispatch-linux-'));
    const backend = createRawCredentialBackend({
      platform: 'linux',
      homedir: () => dir,
      execFileSync: () => {
        throw new Error('exec should not run for the file backend');
      },
      commandExists: () => false,
    }, { env: {} });
    assert.equal(backend.kind, 'linux-file');
    assert.ok(backend instanceof LinuxEncryptedFileBackend);
  });

  it('selects windows-dpapi on win32', () => {
    assert.equal(
      selectBackendKind({ platform: 'win32', commandExists: () => false }),
      'windows-dpapi',
    );
    const dir = mkdtempSync(join(tmpdir(), 'qlb-dispatch-win-'));
    const backend = createRawCredentialBackend({
      platform: 'win32',
      homedir: () => dir,
      execFileSync: () => '',
      commandExists: () => false,
    }, { env: {} });
    assert.equal(backend.kind, 'windows-dpapi');
    assert.ok(backend instanceof WindowsDpapiBackend);
  });

  it('uses the no-kill adapter for production macOS and retains marked test executors', () => {
    const host = defaultCredentialBackendHost();
    assert.equal(macosKeychainExec(host), keychainClientExecFileSync);
    const marked = markFakeExecutor(() => '');
    assert.equal(macosKeychainExec({ ...host, execFileSync: marked }), marked);
  });

  it('refuses an adapter call without a Keychain kind before spawning', () => {
    const spawnMock = mock.method(childProcess, 'spawnSync');
    try {
      assert.throws(
        () => keychainClientExecFileSync('/usr/bin/security', ['find-generic-password', '-s', 'x', '-w'], { timeout: 1_000 }),
        (err: unknown) => (err as { code?: unknown }).code === 'EQLBKEYCHAINNOTSTARTED',
      );
      assert.equal(spawnMock.mock.callCount(), 0);
    } finally {
      spawnMock.mock.restore();
    }
  });
});

describe('MacosKeychainBackend no-kill wiring', () => {
  it('preserves waiting, timeout and unknown-write outcomes through the runner', { timeout: 30_000 }, () => {
    withNoKillState((state) => {
      const get = noKillFake(state.dir, 'echo $$ > "$d/get.pid"\nsleep 15', 'get-fake');
      const backend = new MacosKeychainBackend({ execFileSync: noKillExecutor(get, state.lockfPath) });
      const started = Date.now();
      try {
        assert.throws(() => backend.getSync('svc-d', 'a1'), (err: unknown) => {
          const error = err as Error & { code?: unknown };
          assert.equal(error.message, 'keychain get failed for service=svc-d account=a1: security find-generic-password timed out after 5s');
          assert.equal(error.code, 'ETIMEDOUT');
          return true;
        });
        assert.ok(Date.now() - started >= 4_500);
        assert.throws(() => backend.getSync('svc-d', 'a2'), (err: unknown) => {
          const error = err as Error & { reason?: unknown };
          assert.match(error.message, /is still waiting for an answer/);
          assert.equal(isSecurityTimeout(error), true);
          assert.equal(isKeychainStillWaiting(error), true);
          assert.equal(error.reason, 'still-waiting');
          return true;
        });
        assert.throws(() => backend.setSync('svc-d', 'a3', '{}'), (err: unknown) => {
          assert.equal((err as { writeOutcome?: unknown }).writeOutcome, 'not-started');
          assert.match((err as Error).message, /is still waiting for an answer/);
          return true;
        });
      } finally {
        stopOwnFake(join(state.dir, 'get.pid'));
        waitForOwnExit(join(state.dir, 'get.pid'));
      }

      const set = noKillFake(state.dir, 'echo $$ > "$d/set.pid"\nsleep 15', 'set-fake');
      const timedSet = new MacosKeychainBackend({ execFileSync: noKillExecutor(set, state.lockfPath) });
      try {
        assert.throws(() => timedSet.setSync('svc-set', 'a', '{}'), (err: unknown) => {
          const error = err as Error & { code?: unknown; writeOutcome?: unknown };
          assert.equal(error.message, 'security add-generic-password timed out after 5s');
          assert.equal(error.code, 'ETIMEDOUT');
          assert.equal(error.writeOutcome, 'unknown');
          return true;
        });
      } finally {
        stopOwnFake(join(state.dir, 'set.pid'));
        waitForOwnExit(join(state.dir, 'set.pid'));
      }

      const del = noKillFake(state.dir, 'echo $$ > "$d/delete.pid"\nsleep 15', 'delete-fake');
      const timedDelete = new MacosKeychainBackend({ execFileSync: noKillExecutor(del, state.lockfPath) });
      try {
        assert.throws(() => timedDelete.deleteSync('svc-delete', 'a'), (err: unknown) => {
          const error = err as Error & { code?: unknown; writeOutcome?: unknown };
          assert.match(error.message, /^keychain delete failed for service=svc-delete account=a:/);
          assert.equal(error.code, 'ETIMEDOUT');
          assert.equal(error.writeOutcome, 'unknown');
          return true;
        });
      } finally {
        stopOwnFake(join(state.dir, 'delete.pid'));
        waitForOwnExit(join(state.dir, 'delete.pid'));
      }
    });
  });

  it('turns a no-proof write into a content-free unknown outcome', () => {
    withNoKillState((state) => {
      const fake = noKillFake(state.dir, 'exit 0');
      const noProofLockf = noKillFake(state.dir, 'exit 0', 'no-proof-lockf');
      const backend = new MacosKeychainBackend({ execFileSync: noKillExecutor(fake, noProofLockf) });
      assert.throws(() => backend.setSync('svc-i', 'a', '{}'), (err: unknown) => {
        const error = err as Error & { code?: unknown; writeOutcome?: unknown };
        assert.equal(error.message, 'keychain set failed for service=svc-i account=a');
        assert.equal(error.code, 'EQLBKEYCHAINWRAPPERNOPROOF');
        assert.equal(error.writeOutcome, 'unknown');
        return true;
      });
    });
  });

  it('wrapCredentialError retains reason and write outcome', () => {
    const wrapped = wrapCredentialError('delete', 'svc', 'a', Object.assign(
      new KeychainRequestStillWaiting('svc'), { writeOutcome: 'not-started' },
    ));
    assert.equal((wrapped as { reason?: unknown }).reason, 'still-waiting');
    assert.equal((wrapped as { writeOutcome?: unknown }).writeOutcome, 'not-started');
  });
});

describe('Linux encrypted-file backend', () => {
  it('encrypts, writes 0600, round-trips, and overwrites', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-linux-file-'));
    const backend = new LinuxEncryptedFileBackend({ dir });
    const service = 'qlb-test-linux-file';
    const account = 'acct';
    const blob = JSON.stringify({
      access: 'UNIQUE_PLAINTEXT_TOKEN_XYZ',
      refresh: 'UNIQUE_REFRESH_TOKEN_XYZ',
      expires: 1,
    });

    await backend.set(service, account, blob);
    assert.equal(await backend.get(service, account), blob);
    assert.equal(statSync(backend.filePath).mode & 0o777, 0o600);
    assert.equal(statSync(backend.keyPath).mode & 0o777, 0o600);

    const onDisk = readFileSync(backend.filePath, 'utf8');
    assert.equal(
      onDisk.includes('UNIQUE_PLAINTEXT_TOKEN_XYZ'),
      false,
      'plaintext must not appear in the store file',
    );

    backend.setSync(service, account, 'two');
    assert.equal(backend.getSync(service, account), 'two');

    backend.deleteSync(service, account);
    assert.throws(() => backend.getSync(service, account), /item not found/);
  });

  it('fails closed on a wrong key and on a tampered ciphertext', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-linux-tamper-'));
    const backend = new LinuxEncryptedFileBackend({ dir });
    const service = 'qlb-test-tamper';
    const account = 'acct';
    backend.setSync(service, account, 'hello-secret');

    writeFileSync(backend.keyPath, randomBytes(32));
    const wrongKey = new LinuxEncryptedFileBackend({ dir });
    assert.throws(
      () => wrongKey.getSync(service, account),
      /keychain get failed for service=qlb-test-tamper/,
    );

    const dir2 = mkdtempSync(join(tmpdir(), 'qlb-linux-tamper2-'));
    const honest = new LinuxEncryptedFileBackend({ dir: dir2 });
    honest.setSync(service, account, 'hello-secret');
    const store = JSON.parse(readFileSync(honest.filePath, 'utf8')) as {
      items: Record<string, { iv: string; tag: string; data: string }>;
    };
    const itemKey = Object.keys(store.items)[0];
    const buf = Buffer.from(store.items[itemKey].data, 'base64');
    buf[0] ^= 0xff;
    store.items[itemKey].data = buf.toString('base64');
    writeFileSync(honest.filePath, JSON.stringify(store));
    assert.throws(
      () => honest.getSync(service, account),
      /keychain get failed for service=qlb-test-tamper/,
    );
  });
});

describe('Linux libsecret command construction', () => {
  it('store/lookup/clear use secret-tool argv and pass the secret on stdin', () => {
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    const exec: ExecFileSyncFn = (file, args, opts) => {
      calls.push({
        file,
        args: [...args],
        input: typeof opts?.input === 'string' ? opts.input : undefined,
      });
      if (args[0] === 'lookup') return 'secret-value\n';
      return '';
    };
    const backend = new LinuxLibsecretBackend({ execFileSync: exec });
    const service = 'qlb:test:a';
    const account = 'acct';

    backend.setSync(service, account, '{"a":1}');
    assert.equal(calls[0]?.file, 'secret-tool');
    assert.deepEqual(calls[0]?.args, linuxSecretToolStoreArgs(service, account));
    assert.deepEqual(calls[0]?.args, [
      'store', '--label', service, 'service', service, 'account', account,
    ]);
    assert.equal(calls[0]?.input, '{"a":1}');
    assert.equal(calls[0]?.args.includes('{"a":1}'), false);

    assert.equal(backend.getSync(service, account), 'secret-value');
    assert.deepEqual(calls[1]?.args, linuxSecretToolLookupArgs(service, account));

    backend.deleteSync(service, account);
    assert.deepEqual(calls[2]?.args, linuxSecretToolClearArgs(service, account));
  });

  it('linux secret-tool lookups pass a timeout and a timeout is an operational error, not not-found', () => {
    const calls: Array<{ timeout?: number }> = [];
    const exec: ExecFileSyncFn = (_file, args, opts) => {
      calls.push({ timeout: opts?.timeout });
      return args[0] === 'lookup' ? 'stored-value\n' : '';
    };
    const backend = new LinuxLibsecretBackend({ execFileSync: exec });

    backend.setSync('qlb-test-linux-timeout', 'acct', '{"test":true}');
    assert.equal(backend.getSync('qlb-test-linux-timeout', 'acct'), 'stored-value');
    backend.deleteSync('qlb-test-linux-timeout', 'acct');
    assert.deepEqual(calls.map((call) => call.timeout), [5_000, 5_000, 5_000]);

    const timeout = Object.assign(new Error('secret-tool timed out'), {
      code: 'ETIMEDOUT',
      signal: 'SIGTERM',
    });
    const timedOutBackend = new LinuxLibsecretBackend({
      execFileSync: () => { throw timeout; },
    });
    let thrown: unknown;
    assert.throws(() => timedOutBackend.getSync('qlb-test-linux-timeout', 'acct'), (error: unknown) => {
      thrown = error;
      return error instanceof Error && /timed out/.test(error.message);
    });
    assert.equal(isCredentialNotFound(thrown), false);
    // qlb doctor classifies timeouts with isSecurityTimeout; the wrapped error must keep its code.
    assert.equal(isSecurityTimeout(thrown), true);
  });
});

describe('Windows DPAPI command construction', () => {
  it('encrypts via powershell stdin and never puts plaintext on argv', () => {
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    const exec: ExecFileSyncFn = (file, args, opts) => {
      const input = typeof opts?.input === 'string' ? opts.input : undefined;
      calls.push({ file, args: [...args], input });
      const script = args[args.length - 1];
      if (script === DPAPI_ENCRYPT_SCRIPT) return '01000000DPAPIBLOB\n';
      if (script === DPAPI_DECRYPT_SCRIPT) return 'plain-secret';
      throw new Error(`unexpected script: ${String(script).slice(0, 40)}`);
    };
    const filePath = join(mkdtempSync(join(tmpdir(), 'qlb-win-dpapi-')), 'credentials-windows.json');
    const backend = new WindowsDpapiBackend({ filePath, execFileSync: exec });
    const service = 'qlb:test:a';
    const account = 'acct';
    const secret = 'plain-secret';

    backend.setSync(service, account, secret);
    assert.equal(calls[0]?.file, WINDOWS_POWERSHELL_EXE);
    assert.deepEqual(calls[0]?.args.slice(0, 5), [...WINDOWS_POWERSHELL_BASE_ARGS]);
    assert.equal(calls[0]?.args[5], DPAPI_ENCRYPT_SCRIPT);
    assert.equal(calls[0]?.input, secret);
    assert.equal(calls[0]?.args.some((a) => a.includes(secret)), false);

    const stored = JSON.parse(readFileSync(filePath, 'utf8')) as { items: Record<string, string> };
    assert.equal(Object.values(stored.items)[0], '01000000DPAPIBLOB');
    assert.equal(JSON.stringify(stored).includes(secret), false);

    assert.equal(backend.getSync(service, account), secret);
    assert.equal(calls[1]?.args[5], DPAPI_DECRYPT_SCRIPT);
    assert.equal(calls[1]?.input, '01000000DPAPIBLOB');
    assert.equal(calls[1]?.args.some((a) => a.includes(secret)), false);

    backend.deleteSync(service, account);
    assert.throws(() => backend.getSync(service, account), /item not found/);
  });
});
