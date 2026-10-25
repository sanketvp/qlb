import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  MacosKeychainBackend,
  defaultKeychainHelperPath,
  markFakeExecutor,
  type ExecFileSyncFn,
} from '../src/keychain';

describe('Swift Keychain helper write path', () => {
  it('sends a large payload only on helper stdin', () => {
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    const exec: ExecFileSyncFn = (file, args, options) => {
      calls.push({ file, args: [...args], input: typeof options?.input === 'string' ? options.input : undefined });
      return '';
    };
    const payload = 'x'.repeat(16 * 1024);
    const backend = new MacosKeychainBackend({
      execFileSync: markFakeExecutor(exec),
      helperPath: '/fixture/qlb-keychain-helper',
    });

    backend.setSync('qlb-test-helper', 'qlb', payload);

    assert.deepEqual(calls, [{
      file: '/fixture/qlb-keychain-helper',
      args: ['set', 'qlb-test-helper', 'qlb'],
      input: payload,
    }]);
    assert.equal(calls[0]!.args.some((arg) => arg.includes(payload)), false);
  });

  it('uses the repository helper build location by default', () => {
    assert.match(defaultKeychainHelperPath(), /native\/keychain-helper\/build\/qlb-keychain-helper$/);
  });

  it('round-trips a 16 KiB disposable value through the real Keychain', {
    skip: process.env.QLB_REAL_KEYCHAIN_TESTS !== '1' || process.platform !== 'darwin',
  }, () => {
    const helper = defaultKeychainHelperPath();
    assert.equal(existsSync(helper), true, 'run npm run build:helper first');
    const service = `qlb-test-a2b-${randomBytes(8).toString('hex')}`;
    const account = 'qlb';
    const payload = randomBytes(8 * 1024).toString('hex');
    try {
      execFileSync(helper, ['set', service, account], { input: payload, encoding: 'utf8', timeout: 5_000 });
      const read = execFileSync('/usr/bin/security', [
        'find-generic-password', '-a', account, '-s', service, '-w',
      ], { encoding: 'utf8', timeout: 5_000 }).replace(/\n$/, '');
      assert.equal(read, payload);
    } finally {
      try {
        execFileSync(helper, ['delete', service, account], {
          encoding: 'utf8', timeout: 5_000, stdio: 'ignore',
        });
      } catch {
        // Preserve the assertion failure; cleanup is best effort for a disposable item.
      }
    }
  });
});
