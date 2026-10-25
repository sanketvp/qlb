import assert from 'node:assert/strict';
import { execFileSync, execFileSync as runFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  MacosKeychainBackend,
  defaultKeychainHelperPath,
  markFakeExecutor,
  type ExecFileSyncFn,
} from '../src/keychain';
import { helperMatrixConfig, helperMatrixIsOk, parseHelperMatrixResult, runKeychainCommand } from '../src/commands/keychain';
import { defaultConfig } from '../src/config';
import { openStore } from '../src/store';

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

  it('parses matrix receipts and records a failing prompted result', () => {
    const green = parseHelperMatrixResult('{"cases":{"securityCreated":"pass","previousHelper":"pass","helperCreated":"pass"},"casePrompted":{"securityCreated":false,"previousHelper":false,"helperCreated":false},"prompted":false}');
    assert.equal(helperMatrixIsOk(green), true);
    assert.equal(helperMatrixConfig(green)['keychain.helperCheckResult'], 'ok');
    const prompted = { ...green, prompted: true };
    assert.equal(helperMatrixIsOk(prompted), false);
    const recorded = helperMatrixConfig(prompted);
    assert.equal(recorded['keychain.helperCheckResult'], 'failed');
    assert.equal(recorded['keychain.helperCheckPrompted'], 'true');
  });

  it('stores an injected failing matrix receipt and returns a non-zero exit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-keychain-command-'));
    const config = defaultConfig(home);
    const output: string[] = [];
    const errors: string[] = [];
    const exit = await runKeychainCommand(['matrix'], {
      config, env: {}, home, stdout: (message) => output.push(message), stderr: (message) => errors.push(message),
      loadConfig: () => config, registerSecret: () => {},
    }, {
      runMatrix: () => ({
        cases: { securityCreated: 'fail', previousHelper: 'fail', helperCreated: 'pass' },
        casePrompted: { securityCreated: true, previousHelper: false, helperCreated: false },
        prompted: true,
      }),
    });
    assert.equal(exit, 1);
    assert.deepEqual(output, []);
    assert.deepEqual(errors, ['qlb keychain: helper matrix failed']);
    const store = openStore(config.dbPath);
    try {
      assert.equal(store.getConfig('keychain.helperCheckResult'), 'failed');
      assert.equal(store.getConfig('keychain.helperCheckPrompted'), 'true');
    } finally { store.close(); }
  });

  it('compiles the helper and self-tests only a disposable Keychain', {
    skip: !existsSync('/usr/bin/swiftc'),
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-keychain-helper-selftest-'));
    const keychain = join(dir, 't.keychain-db');
    const binary = join(dir, 'qlb-keychain-helper');
    const password = randomBytes(24).toString('hex');
    try {
      runFile('/usr/bin/security', ['create-keychain', '-p', password, keychain], { stdio: 'ignore' });
      runFile('/usr/bin/security', ['unlock-keychain', '-p', password, keychain], { stdio: 'ignore' });
      runFile('/usr/bin/swiftc', ['-o', binary, 'native/keychain-helper/main.swift'], { stdio: 'ignore' });
      runFile(binary, ['--keychain', keychain, 'selftest', `qlb-test-a2b-${randomBytes(8).toString('hex')}`], {
        stdio: 'ignore', timeout: 5_000,
      });
    } finally {
      try { runFile('/usr/bin/security', ['delete-keychain', keychain], { stdio: 'ignore' }); } catch { /* cleanup */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds twice with one stable identity in a disposable Keychain', {
    skip: !existsSync('/usr/bin/swiftc'),
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-keychain-helper-build-'));
    const keychain = join(dir, 't.keychain-db');
    const password = randomBytes(24).toString('hex');
    const previous = join(dir, 'helper-prev');
    const env = { ...process.env, QLB_HELPER_PREVIOUS_DIR: previous };
    const hashes = () => runFile('/usr/bin/security', [
      'find-certificate', '-c', 'QLB Keychain Helper', '-a', '-Z', keychain,
    ], { encoding: 'utf8' }).match(/SHA-1 hash:\s*([0-9A-Fa-f]{40})/)?.[1];
    try {
      runFile('/usr/bin/security', ['create-keychain', '-p', password, keychain], { stdio: 'ignore' });
      runFile('/usr/bin/security', ['unlock-keychain', '-p', password, keychain], { stdio: 'ignore' });
      runFile(process.execPath, ['scripts/build-helper.mjs', '--keychain', keychain], { env, stdio: 'ignore', timeout: 30_000 });
      const first = hashes();
      runFile(process.execPath, ['scripts/build-helper.mjs', '--keychain', keychain], { env, stdio: 'ignore', timeout: 30_000 });
      assert.equal(hashes(), first);
      assert.ok(first);
      const details = spawnSync('/usr/bin/codesign', ['-d', '-r-', defaultKeychainHelperPath()], { encoding: 'utf8' });
      assert.equal(details.status, 0);
      assert.match(`${details.stdout}\n${details.stderr}`, new RegExp(first!, 'i'));
    } finally {
      try { runFile('/usr/bin/security', ['delete-keychain', keychain], { stdio: 'ignore' }); } catch { /* cleanup */ }
      rmSync(dir, { recursive: true, force: true });
    }
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
