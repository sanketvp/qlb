import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { isCredentialNotFound } from '../src/credential-backends';
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
  linuxSecretToolClearArgs,
  linuxSecretToolLookupArgs,
  linuxSecretToolStoreArgs,
  markFakeExecutor,
  selectBackendKind,
  type ExecFileSyncFn,
} from '../src/keychain';

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
