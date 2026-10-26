import assert from 'node:assert/strict';
import { execFileSync, execFileSync as runFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  MacosKeychainBackend,
  defaultKeychainHelperPath,
  KeychainHelperMissingError,
  markFakeExecutor,
  type ExecFileSyncFn,
} from '../src/keychain';
import {
  helperMatrixConfig, helperMatrixIsOk, helperSigningState, parseHelperMatrixResult, runKeychainCommand,
} from '../src/commands/keychain';
import { exitCodeForError, runExecutingCommand } from '../src/cli';
import { KeychainHelperUntrustedError } from '../src/credential-backends';
import { inspectHelperSigning, verifyHelperIdentity } from '../src/diagnostics';
import type { CommandContext } from '../src/registry';
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

  it('requires a clean refusal for the untrusted security-created matrix item', () => {
    const receipt = '{"cases":{"securityCreated":"pass","securityUntrusted":"pass","previousHelper":"pass","helperCreated":"pass"},"casePrompted":{"securityCreated":false,"securityUntrusted":true,"previousHelper":false,"helperCreated":false},"caseReasons":{"securityCreated":null,"securityUntrusted":null,"previousHelper":null,"helperCreated":null},"prompted":false}';
    const green = parseHelperMatrixResult(receipt);
    assert.equal(helperMatrixIsOk(green), true);
    const signing = { authority: 'QLB Keychain Helper', binaryHash: 'a'.repeat(40), identityHash: 'b'.repeat(40) };
    assert.equal(helperMatrixConfig(green, signing)['keychain.helperCheckResult'], 'ok');
    assert.throws(() => parseHelperMatrixResult(receipt.replace(',"securityUntrusted":"pass"', '')),
      /invalid helper matrix receipt/);
    const untrustedFailed = parseHelperMatrixResult(receipt.replace('"securityUntrusted":"pass"', '"securityUntrusted":"fail"'));
    assert.equal(helperMatrixIsOk(untrustedFailed), false);
    const prompted = { ...green, prompted: true };
    assert.equal(helperMatrixIsOk(prompted), false);
    const firstInstall = {
      ...green,
      cases: { ...green.cases, previousHelper: 'not-applicable' as const },
      caseReasons: { ...green.caseReasons, previousHelper: 'no previous helper' },
    };
    assert.equal(helperMatrixIsOk(firstInstall), true);
    const recorded = helperMatrixConfig(prompted);
    assert.equal(recorded['keychain.helperCheckResult'], 'failed');
    assert.equal(recorded['keychain.helperCheckPrompted'], 'true');
  });

  it('models post-Always-Allow and user-cancelled matrix behavior in the helper source', () => {
    const source = readFileSync('native/keychain-helper/main.swift', 'utf8');
    assert.match(source, /add-generic-password", "-a", account, "-s", services\[0\], "-w",[^\n]+"-T", helperExecutablePath\(\)/);
    assert.match(source, /promptFailure[\s\S]*errSecUserCanceled[\s\S]*status -25293[\s\S]*status -25308[\s\S]*status -128/);
    assert.match(source, /private func modificationDate[\s\S]*find-generic-password", "-a", account, "-s", service\]\)/);
    assert.match(source, /untrustedMdatBefore[\s\S]*untrustedMdatAfter[\s\S]*untrustedUpdate\.status != 0[\s\S]*untrustedMdatBefore\.value == untrustedMdatAfter\.value/);
    assert.doesNotMatch(source, /let untrustedRead =/);
    assert.doesNotMatch(source, /prompted = prompted \|\| casePrompted\["securityUntrusted"\]!/);
  });

  it('stores an injected failing matrix receipt and returns a non-zero exit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-keychain-command-'));
    const config = defaultConfig(home);
    const output: string[] = [];
    const errors: string[] = [];
    const exit = await runKeychainCommand(['matrix'], {
      config, env: {}, home, stdout: (message) => output.push(message), stderr: (message) => errors.push(message),
      loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    }, {
      runMatrix: () => ({
        cases: { securityCreated: 'fail', securityUntrusted: 'pass', previousHelper: 'fail', helperCreated: 'pass' },
        casePrompted: { securityCreated: true, securityUntrusted: false, previousHelper: false, helperCreated: false },
        caseReasons: { securityCreated: null, securityUntrusted: null, previousHelper: null, helperCreated: null },
        prompted: true,
      }),
      helperSigning: () => ({ authority: 'QLB Keychain Helper', binaryHash: 'a'.repeat(40), identityHash: 'b'.repeat(40) }),
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

  it('returns exit 3 with the helper-missing message for a missing native helper command', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-keychain-command-missing-'));
    const config = defaultConfig(home);
    const errors: string[] = [];
    const exit = await runKeychainCommand(['matrix'], {
      config, env: {}, home, stdout: () => {}, stderr: (message) => errors.push(message),
      loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    }, {
      runMatrix: () => { throw new KeychainHelperMissingError('/tmp/missing-helper'); },
      helperSigning: () => ({ authority: 'QLB Keychain Helper', binaryHash: 'a'.repeat(40), identityHash: 'b'.repeat(40) }),
    });
    assert.equal(exit, 3);
    assert.deepEqual(errors, ['helper-missing: /tmp/missing-helper; run npm run build:helper']);
    assert.equal(exitCodeForError(new KeychainHelperMissingError('/tmp/missing-helper')), 3);
  });

  it('parses the Authority, CDHash, and leaf identity from captured -vvv codesign output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-codesign-fixture-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    const identityHash = 'b'.repeat(40);
    const binaryHash = 'a'.repeat(40);
    const fixture = `Executable=${helper}\nAuthority=QLB Keychain Helper\nCDHash=${binaryHash}\nDesignated Requirement=designated => certificate leaf = H"${identityHash}"\n`;
    const calls: string[][] = [];
    try {
      const signing = inspectHelperSigning(helper, (_command, args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: args[0] === '-d' ? fixture : '' };
      });
      assert.deepEqual(signing, { authority: 'QLB Keychain Helper', binaryHash, identityHash });
      assert.deepEqual(calls[1], ['-d', '-vvv', '-r-', helper]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects captured single-verbose codesign output because it has no authority or CDHash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-codesign-v-fixture-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    try {
      const signing = inspectHelperSigning(helper, (_command, args) => ({
        status: 0,
        stdout: '',
        stderr: args[0] === '-d' ? 'Executable=/fixture\nDesignated Requirement=designated => certificate leaf = H"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"\n' : '',
      }));
      assert.equal(signing, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an untrusted helper before writing stdin and maps the typed error to exit 3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-helper-untrusted-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    let helperCalls = 0;
    const backend = new MacosKeychainBackend({
      helperPath: helper,
      execFileSync: markFakeExecutor(() => { helperCalls += 1; return ''; }),
      helperConfigReader: () => 'b'.repeat(40),
      helperIdentityVerifier: () => ({ trusted: false, reason: 'pinned leaf certificate did not verify' }),
    });
    try {
      assert.throws(() => backend.setSync('qlb-test-helper', 'qlb', 'credential'), KeychainHelperUntrustedError);
      assert.equal(helperCalls, 0);
      assert.equal(exitCodeForError(new KeychainHelperUntrustedError('not signed')), 3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('verifies a trusted helper immediately before every credential write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-helper-trusted-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    let verifierCalls = 0;
    let helperCalls = 0;
    const backend = new MacosKeychainBackend({
      helperPath: helper,
      execFileSync: markFakeExecutor(() => { helperCalls += 1; return ''; }),
      helperConfigReader: () => 'b'.repeat(40),
      helperIdentityVerifier: () => {
        verifierCalls += 1;
        return { trusted: true };
      },
    });
    try {
      backend.setSync('qlb-test-helper', 'qlb', 'credential-one');
      backend.setSync('qlb-test-helper', 'qlb', 'credential-two');
      assert.equal(verifierCalls, 2);
      assert.equal(helperCalls, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a helper with a matching authority but a leaf that differs from the pin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-helper-wrong-leaf-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    let helperCalls = 0;
    let verifiedPin: string | undefined;
    const backend = new MacosKeychainBackend({
      helperPath: helper,
      execFileSync: markFakeExecutor(() => { helperCalls += 1; return ''; }),
      helperConfigReader: () => 'a'.repeat(40),
      helperIdentityVerifier: (_path, pin) => {
        verifiedPin = pin;
        return { trusted: false, reason: 'pinned leaf certificate did not verify' };
      },
    });
    try {
      assert.throws(() => backend.setSync('qlb-test-helper', 'qlb', 'credential'), KeychainHelperUntrustedError);
      assert.equal(verifiedPin, 'a'.repeat(40));
      assert.equal(helperCalls, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses without a recorded helper pin before spawning the helper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-helper-no-pin-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    let helperCalls = 0;
    const backend = new MacosKeychainBackend({
      helperPath: helper,
      execFileSync: markFakeExecutor(() => { helperCalls += 1; return ''; }),
      helperConfigReader: () => null,
      helperIdentityVerifier: () => ({ trusted: true }),
    });
    try {
      assert.throws(
        () => backend.setSync('qlb-test-helper', 'qlb', 'credential'),
        /helper-untrusted: no pinned helper identity; run qlb keychain check-launchd/,
      );
      assert.equal(helperCalls, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('passes the exact designated requirement to codesign for a pinned leaf', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-helper-pin-requirement-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    const pin = 'c'.repeat(40);
    const calls: string[][] = [];
    try {
      assert.deepEqual(verifyHelperIdentity(helper, pin, (_command, args) => {
        calls.push(args);
        return { status: 0 };
      }), { trusted: true });
      assert.deepEqual(calls, [[
        '--verify', '--strict', '-R', `certificate leaf = H"${pin}"`, helper,
      ]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses the diagnostics signing inspector as the keychain signing inspector', () => {
    assert.equal(helperSigningState, inspectHelperSigning);
  });

  it('records a green matrix with null signing as failed and returns non-zero', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-keychain-command-signing-'));
    const config = defaultConfig(home);
    const errors: string[] = [];
    const exit = await runKeychainCommand(['matrix'], {
      config, env: {}, home, stdout: () => {}, stderr: (message) => errors.push(message),
      loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    }, {
      runMatrix: () => ({
        cases: { securityCreated: 'pass', securityUntrusted: 'pass', previousHelper: 'pass', helperCreated: 'pass' },
        casePrompted: { securityCreated: false, securityUntrusted: false, previousHelper: false, helperCreated: false },
        caseReasons: { securityCreated: null, securityUntrusted: null, previousHelper: null, helperCreated: null },
        prompted: false,
      }),
      helperSigning: () => null,
    });
    assert.equal(exit, 1);
    assert.deepEqual(errors, ['qlb keychain: helper matrix failed']);
    const store = openStore(config.dbPath);
    try { assert.equal(store.getConfig('keychain.helperCheckResult'), 'failed'); } finally { store.close(); }
  });

  it('does not run the matrix when its pre-check fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-keychain-precheck-'));
    const config = defaultConfig(home);
    let matrixCalls = 0;
    const exit = await runKeychainCommand(['matrix'], {
      config, env: {}, home, stdout: () => {}, stderr: () => {},
      loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    }, {
      runMatrix: () => { matrixCalls += 1; throw new Error('must not run'); },
      helperSigning: () => null,
    });
    assert.equal(exit, 1);
    assert.equal(matrixCalls, 0);
  });

  it('fails the matrix and does not record a pin when the helper CDHash changes during it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-keychain-cdhash-change-'));
    const config = defaultConfig(home);
    let inspections = 0;
    let matrixCalls = 0;
    const green = {
      cases: { securityCreated: 'pass' as const, securityUntrusted: 'pass' as const, previousHelper: 'pass' as const, helperCreated: 'pass' as const },
      casePrompted: { securityCreated: false, securityUntrusted: false, previousHelper: false, helperCreated: false },
      caseReasons: { securityCreated: null, securityUntrusted: null, previousHelper: null, helperCreated: null },
      prompted: false,
    };
    const exit = await runKeychainCommand(['matrix'], {
      config, env: {}, home, stdout: () => {}, stderr: () => {},
      loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    }, {
      runMatrix: () => { matrixCalls += 1; return green; },
      helperSigning: () => ({
        authority: 'QLB Keychain Helper', binaryHash: (inspections++ === 0 ? 'a' : 'b').repeat(40), identityHash: 'c'.repeat(40),
      }),
    });
    assert.equal(exit, 1);
    assert.equal(matrixCalls, 1);
    const store = openStore(config.dbPath);
    try {
      assert.equal(store.getConfig('keychain.helperCheckResult'), 'failed');
      assert.equal(store.getConfig('keychain.helperCheckIdentityHash'), null);
    } finally { store.close(); }
  });

  it('returns exit 3 and the helper-missing error through the redacting command boundary', async () => {
    const errors: string[] = [];
    const context: CommandContext = {
      config: defaultConfig(mkdtempSync(join(tmpdir(), 'qlb-keychain-boundary-'))), env: {}, home: '/tmp',
      stdout: () => {}, stderr: (message) => errors.push(message), loadConfig: () => { throw new Error('not used'); },
      registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    };

    const exit = await runExecutingCommand({
      command: {
        name: 'fixture',
        execute: async () => { throw new KeychainHelperMissingError('/tmp/missing-helper'); },
      },
      args: [],
    }, context);

    assert.equal(exit, 3);
    assert.deepEqual(errors, ['qlb fixture: helper-missing: /tmp/missing-helper; run npm run build:helper']);
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
    skip: process.env.QLB_REAL_KEYCHAIN_TESTS !== '1' || !existsSync('/usr/bin/swiftc'),
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-keychain-helper-build-'));
    const keychain = join(dir, 't.keychain-db');
    const output = join(dir, 'qlb-keychain-helper');
    const password = randomBytes(24).toString('hex');
    const previous = join(dir, 'helper-prev');
    const env = { ...process.env, QLB_HELPER_PREVIOUS_DIR: previous };
    const hashes = () => runFile('/usr/bin/security', [
      'find-certificate', '-c', 'QLB Keychain Helper', '-a', '-Z', keychain,
    ], { encoding: 'utf8' }).match(/SHA-1 hash:\s*([0-9A-Fa-f]{40})/)?.[1];
    try {
      runFile('/usr/bin/security', ['create-keychain', '-p', password, keychain], { stdio: 'ignore' });
      runFile('/usr/bin/security', ['unlock-keychain', '-p', password, keychain], { stdio: 'ignore' });
      runFile(process.execPath, ['scripts/build-helper.mjs', '--keychain', keychain, '--no-trust', '--out', output], { env, stdio: 'ignore', timeout: 30_000 });
      const first = hashes();
      runFile(process.execPath, ['scripts/build-helper.mjs', '--keychain', keychain, '--no-trust', '--out', output], { env, stdio: 'ignore', timeout: 30_000 });
      assert.equal(hashes(), first);
      assert.ok(first);
      const details = spawnSync('/usr/bin/codesign', ['-d', '-r-', output], { encoding: 'utf8' });
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
