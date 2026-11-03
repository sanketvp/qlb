import assert from 'node:assert/strict';
import { execFileSync, execFileSync as runFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  MacosKeychainBackend,
  defaultKeychainHelperPath,
  KeychainHelperMissingError,
  markFakeExecutor,
  type ExecFileSyncFn,
} from '../src/keychain';
import {
  HELPER_MATRIX_CASE_TIMEOUT_MS, HELPER_MATRIX_LAUNCHD_TIMEOUT_MS, helperMatrixConfig, helperMatrixIsOk, helperSigningState,
  parseHelperMatrixResult, parseLaunchdMatrixReceipt, runHelperMatrix, runHelperMatrixUnderLaunchd, runKeychainCommand,
} from '../src/commands/keychain';
import { exitCodeForError, runExecutingCommand } from '../src/cli';
import { KeychainHelperUntrustedError } from '../src/credential-backends';
import { inspectHelperSigning, verifyHelperIdentity } from '../src/diagnostics';
import type { CommandContext } from '../src/registry';
import { defaultConfig } from '../src/config';
import { openStore } from '../src/store';

describe('Swift Keychain helper trust path', () => {
  it('creates a large payload through security with both required trusted applications', () => {
    const calls: Array<{ file: string; args: string[]; input?: string; stdio?: unknown }> = [];
    const exec: ExecFileSyncFn = (file, args, options) => {
      calls.push({
        file, args: [...args], input: typeof options?.input === 'string' ? options.input : undefined,
        stdio: options?.stdio,
      });
      return '';
    };
    const payload = 'x'.repeat(16 * 1024);
    const helper = '/fixture/qlb-keychain-helper';
    const backend = new MacosKeychainBackend({ execFileSync: markFakeExecutor(exec), helperPath: helper });

    backend.setSync('qlb-test-helper', 'qlb', payload);

    assert.equal(calls[0]?.file, '/usr/bin/security');
    assert.deepEqual(calls[0]?.args, [
      'add-generic-password', '-a', 'qlb', '-s', 'qlb-test-helper',
      '-X', Buffer.from(payload, 'utf8').toString('hex'),
      '-T', helper, '-T', '/usr/bin/security',
    ]);
    assert.equal(calls[0]?.input, undefined);
    assert.equal(calls[0]?.stdio, 'ignore');
  });

  it('uses the repository helper build location by default', () => {
    assert.match(defaultKeychainHelperPath(), /native\/keychain-helper\/build\/qlb-keychain-helper$/);
  });

  it('parses only the three prompt-free QLB-side matrix cases', () => {
    const receipt = '{"cases":{"securityCreated":"pass","securityUpdated":"pass","helperDeleted":"pass"},"casePrompted":{"securityCreated":false,"securityUpdated":false,"helperDeleted":false},"caseReasons":{"securityCreated":null,"securityUpdated":null,"helperDeleted":null},"prompted":false}';
    const green = parseHelperMatrixResult(receipt);
    assert.equal(helperMatrixIsOk(green), true);
    const signing = { authority: 'QLB Keychain Helper', binaryHash: 'a'.repeat(40), identityHash: 'b'.repeat(40) };
    assert.equal(helperMatrixConfig(green, signing)['keychain.helperCheckResult'], 'ok');
    assert.throws(() => parseHelperMatrixResult(receipt.replace(',"securityUpdated":"pass"', '')), /invalid helper matrix receipt/);
    const failed = parseHelperMatrixResult(receipt.replace('"helperDeleted":"pass"', '"helperDeleted":"fail"'));
    assert.equal(helperMatrixIsOk(failed), false);
    assert.equal(helperMatrixIsOk({ ...green, prompted: true }), false);
    assert.throws(() => parseLaunchdMatrixReceipt(receipt, '1'), /helper matrix receipt is not green/);
    assert.deepEqual(parseLaunchdMatrixReceipt(receipt, '0'), green);
  });

  it('refuses the hidden matrix path in test mode before helper trust or execution', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-matrix-internal-'));
    const config = defaultConfig(home);
    const runDirectory = join(home, 'run');
    const manifest = join(runDirectory, 'manifest.json');
    mkdirSync(runDirectory, { mode: 0o700 });
    let signingCalls = 0;
    let matrixCalls = 0;
    try {
      const exit = await runKeychainCommand(['matrix', '--internal', '--helper-path=/fixture/helper', `--cleanup-manifest=${manifest}`, `--run-directory=${runDirectory}`], {
        config, env: { QLB_TEST_MODE: '1' }, home, stdout: () => {}, stderr: () => {},
        loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
      }, { runMatrix: () => { matrixCalls += 1; throw new Error('not used'); }, helperSigning: () => { signingCalls += 1; return null; } });
      assert.equal(exit, 2);
      assert.equal(signingCalls, 0);
      assert.equal(matrixCalls, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('verifies the forwarded helper and existing pin before hidden matrix execution', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-matrix-internal-trust-'));
    const helper = join(home, 'qlb-keychain-helper');
    const runDirectory = join(home, 'run');
    const manifest = join(runDirectory, 'manifest.json');
    const config = defaultConfig(home);
    const output: string[] = [];
    const green = {
      cases: { securityCreated: 'pass' as const, securityUpdated: 'pass' as const, helperDeleted: 'pass' as const },
      casePrompted: { securityCreated: false, securityUpdated: false, helperDeleted: false },
      caseReasons: { securityCreated: null, securityUpdated: null, helperDeleted: null },
      prompted: false,
    };
    let matrixCalls = 0;
    let verifiedPath: string | null = null;
    writeFileSync(helper, 'fixture helper');
    mkdirSync(runDirectory, { mode: 0o700 });
    try {
      const exit = await runKeychainCommand(['matrix', '--internal', `--helper-path=${helper}`, `--cleanup-manifest=${manifest}`, `--run-directory=${runDirectory}`], {
        config, env: {}, home, stdout: (message) => output.push(message), stderr: () => {},
        loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
      }, {
        runMatrix: () => { matrixCalls += 1; return green; },
        helperSigning: () => ({ authority: 'QLB Keychain Helper', binaryHash: 'a'.repeat(40), identityHash: 'b'.repeat(40) }),
        helperConfigReader: () => 'b'.repeat(40),
        helperIdentityVerifier: (path, pin) => {
          verifiedPath = path;
          return pin === 'b'.repeat(40) ? { trusted: true } : { trusted: false, reason: 'fixture pin mismatch' };
        },
      });
      assert.equal(exit, 0);
      assert.equal(matrixCalls, 1);
      assert.equal(verifiedPath, helper);
      assert.deepEqual(parseHelperMatrixResult(output[0]!), green);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('always publishes a payload-free failed child receipt without creating a store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-matrix-internal-failed-'));
    const runDirectory = join(home, 'run');
    const helper = join(home, 'qlb-keychain-helper');
    const manifest = join(runDirectory, 'manifest.json');
    const config = defaultConfig(home);
    const output: string[] = [];
    mkdirSync(runDirectory, { mode: 0o700 });
    writeFileSync(helper, 'fixture helper');
    try {
      const exit = await runKeychainCommand(['matrix', '--internal', `--helper-path=${helper}`, `--cleanup-manifest=${manifest}`, `--run-directory=${runDirectory}`], {
        config, env: {}, home, stdout: (message) => output.push(message), stderr: () => {},
        loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
      }, { helperSigning: () => null });
      assert.equal(exit, 1);
      assert.equal(output.length, 1);
      assert.equal(helperMatrixIsOk(parseHelperMatrixResult(output[0]!)), false);
      assert.equal(existsSync(config.dbPath), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('rejects child cleanup paths outside the private parent run directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-matrix-internal-path-'));
    const runDirectory = join(home, 'run');
    const helper = join(home, 'qlb-keychain-helper');
    const config = defaultConfig(home);
    let signingCalls = 0;
    mkdirSync(runDirectory, { mode: 0o700 });
    writeFileSync(helper, 'fixture helper');
    try {
      const exit = await runKeychainCommand(['matrix', '--internal', `--helper-path=${helper}`, `--cleanup-manifest=${join(home, 'outside.json')}`, `--run-directory=${runDirectory}`], {
        config, env: {}, home, stdout: () => {}, stderr: () => {},
        loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
      }, { helperSigning: () => { signingCalls += 1; return null; } });
      assert.equal(exit, 2);
      assert.equal(signingCalls, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('runs only security create/update/read and helper delete, then cleans every disposable item', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-matrix-helper-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const existing = new Set<string>();
    try {
      const result = runHelperMatrix(helper, {
        platform: 'darwin', randomId: () => 'fixture',
        run: (file, args) => {
          calls.push({ file, args });
          const service = args[args.indexOf('-s') + 1];
          if (args[0] === 'add-generic-password') existing.add(service!);
          if (args[0] === 'delete' && file === helper) existing.delete(args[1]!);
          if (args[0] === 'delete-generic-password') existing.delete(service!);
          if (args[0] === 'find-generic-password' && !existing.has(service!)) throw Object.assign(new Error('missing'), { status: 44 });
        },
      });
      assert.equal(helperMatrixIsOk(result), true);
      assert.deepEqual(result.cases, { securityCreated: 'pass', securityUpdated: 'pass', helperDeleted: 'pass' });
      assert.ok(calls.some(({ file, args }) => file === helper && args[0] === 'delete'));
      assert.equal(calls.some(({ file, args }) => file === helper && (args[0] === 'set' || args[0] === 'probe-read')), false);
      assert.equal(calls.filter(({ args }) => args[0] === 'delete-generic-password').length, 3);
      for (const { file, args } of calls.filter(({ args }) => args[0] === 'add-generic-password' && args[1] !== '-U')) {
        assert.equal(file, '/usr/bin/security');
        assert.deepEqual(args.slice(-4), ['-T', helper, '-T', '/usr/bin/security']);
      }
      assert.ok(calls.some(({ args }) => args[0] === 'add-generic-password' && args[1] === '-U' && !args.includes('-T')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('marks a slow matrix step prompted and still cleans up after a failed case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-matrix-slow-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    let clock = 0;
    const calls: string[][] = [];
    try {
      const result = runHelperMatrix(helper, {
        platform: 'darwin', now: () => clock, randomId: () => 'slow',
        run: (_file, args) => {
          calls.push([...args]);
          clock += 1_001;
          if (args[0] === 'add-generic-password') throw new Error('fixture failure');
        },
      });
      assert.equal(result.prompted, true);
      assert.equal(result.cases.securityCreated, 'fail');
      assert.match(result.caseReasons.securityCreated!, /prompt-free deadline exceeded/);
      assert.equal(calls.filter((args) => args[0] === 'delete-generic-password').length, 3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('forwards the verified helper to launchd and reports cleanup failures in a failed receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-launchd-matrix-'));
    const helper = join(dir, 'qlb-keychain-helper');
    const cleaned: string[] = [];
    writeFileSync(helper, 'fixture helper');
    try {
      assert.throws(() => runHelperMatrixUnderLaunchd(helper, '/fixture/qlb-cli.js', {
        platform: 'darwin', uid: 501,
        jobExited: () => true,
        run: (file, args) => {
          if (file === '/bin/launchctl' && args[0] === 'bootstrap') {
            const plist = readFileSync(args[2]!, 'utf8');
            assert.match(plist, /--helper-path=\$3/);
            assert.ok(plist.includes(`<string>${helper}</string>`));
            const manifest = [...plist.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1])
              .find((value) => value.endsWith('/disposable-items.json'));
            assert.ok(manifest);
            writeFileSync(manifest!, JSON.stringify(['qlb-test-matrix-failed', 'Claude Code-credentials']));
            writeFileSync(join(dirname(manifest!), 'receipt.json'), JSON.stringify({
              cases: { securityCreated: 'fail', securityUpdated: 'pass', helperDeleted: 'pass' },
              casePrompted: { securityCreated: true, securityUpdated: false, helperDeleted: false },
              caseReasons: { securityCreated: 'security create or read failed', securityUpdated: null, helperDeleted: null },
              prompted: true,
            }));
            writeFileSync(join(dirname(manifest!), 'status'), '1');
          } else if (file === '/usr/bin/security') {
            cleaned.push(args[args.indexOf('-s') + 1]!);
            throw new Error('fixture cleanup failure');
          }
        },
      }), (err: unknown) => {
        const result = (err as { result?: { prompted: boolean; caseReasons: Record<string, string | null> } }).result;
        assert.ok(result, String(err));
        assert.equal(result.prompted, true);
        assert.match(result.caseReasons.securityCreated ?? '', /parent-cleanup-failed/);
        return true;
      });
      assert.deepEqual(cleaned, ['qlb-test-matrix-failed']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('forwards the parent resolved database selection to the launchd child', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-launchd-matrix-config-'));
    const config = { ...defaultConfig(home), dbPath: join(home, 'configured', 'qlb.db') };
    const green = {
      cases: { securityCreated: 'pass' as const, securityUpdated: 'pass' as const, helperDeleted: 'pass' as const },
      casePrompted: { securityCreated: false, securityUpdated: false, helperDeleted: false },
      caseReasons: { securityCreated: null, securityUpdated: null, helperDeleted: null },
      prompted: false,
    };
    let childEnvironment: Record<string, string> | undefined;
    try {
      assert.equal(await runKeychainCommand(['check-launchd'], {
        config, env: { HOME: home }, home, stdout: () => {}, stderr: () => {},
        loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
      }, {
        helperPath: () => '/fixture/helper',
        helperSigning: () => ({ authority: 'QLB Keychain Helper', binaryHash: 'a'.repeat(40), identityHash: 'b'.repeat(40) }),
        runLaunchdMatrix: (_path, environment) => { childEnvironment = environment; return green; },
      }), 0);
      assert.equal(childEnvironment?.QLB_DB_PATH, config.dbPath);
      assert.equal(childEnvironment?.QLB_CONFIG_PATH, config.configPath);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('uses three 20-second case budgets plus launchd grace and cleans a timed-out child manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-launchd-matrix-timeout-'));
    const helper = join(dir, 'qlb-keychain-helper');
    const cleaned: string[] = [];
    let clock = 0;
    writeFileSync(helper, 'fixture helper');
    try {
      assert.equal(HELPER_MATRIX_CASE_TIMEOUT_MS, 20_000);
      assert.equal(HELPER_MATRIX_LAUNCHD_TIMEOUT_MS, 11 * HELPER_MATRIX_CASE_TIMEOUT_MS + 60_000);
      assert.throws(() => runHelperMatrixUnderLaunchd(helper, '/fixture/qlb-cli.js', {
        platform: 'darwin', uid: 501, now: () => clock, wait: () => { clock = HELPER_MATRIX_LAUNCHD_TIMEOUT_MS; }, jobExited: () => true,
        run: (file, args) => {
          if (file === '/bin/launchctl' && args[0] === 'bootstrap') {
            const plist = readFileSync(args[2]!, 'utf8');
            const manifest = [...plist.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1])
              .find((value) => value.endsWith('/disposable-items.json'));
            assert.ok(manifest);
            writeFileSync(manifest!, JSON.stringify(['qlb-test-matrix-timeout']));
          } else if (file === '/usr/bin/security') {
            cleaned.push(args[args.indexOf('-s') + 1]!);
          }
        },
      }), /timed out under launchd/);
      assert.deepEqual(cleaned, ['qlb-test-matrix-timeout']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('skips parent cleanup after a timeout until launchd confirms the child exited', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-launchd-matrix-timeout-running-'));
    const helper = join(dir, 'qlb-keychain-helper');
    const cleaned: string[] = [];
    let clock = 0;
    writeFileSync(helper, 'fixture helper');
    try {
      assert.throws(() => runHelperMatrixUnderLaunchd(helper, '/fixture/qlb-cli.js', {
        platform: 'darwin', uid: 501, now: () => clock, wait: () => { clock = HELPER_MATRIX_LAUNCHD_TIMEOUT_MS; }, jobExited: () => false,
        run: (file, args) => {
          if (file === '/bin/launchctl' && args[0] === 'bootstrap') {
            const plist = readFileSync(args[2]!, 'utf8');
            const manifest = [...plist.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1])
              .find((value) => value.endsWith('/disposable-items.json'));
            assert.ok(manifest);
            writeFileSync(manifest!, JSON.stringify(['qlb-test-matrix-still-running']));
          } else if (file === '/usr/bin/security') cleaned.push(args[args.indexOf('-s') + 1]!);
        },
      }), (err: unknown) => {
        const result = (err as { result?: { caseReasons: Record<string, string | null> } }).result;
        assert.match(result?.caseReasons.securityCreated ?? '', /parent-cleanup-skipped-child-running/);
        return true;
      });
      assert.deepEqual(cleaned, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains an unreadable launchd receipt and parent cleanup failure as a stored error code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-launchd-matrix-unreadable-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    try {
      assert.throws(() => runHelperMatrixUnderLaunchd(helper, '/fixture/qlb-cli.js', {
        platform: 'darwin', uid: 501,
        run: (file, args) => {
          if (file === '/bin/launchctl' && args[0] === 'bootstrap') {
            const plist = readFileSync(args[2]!, 'utf8');
            const manifest = [...plist.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1])
              .find((value) => value.endsWith('/disposable-items.json'));
            assert.ok(manifest);
            writeFileSync(manifest!, JSON.stringify(['qlb-test-matrix-unreadable']));
            writeFileSync(join(dirname(manifest!), 'receipt.json'), '{not-json');
            writeFileSync(join(dirname(manifest!), 'status'), '1');
          } else if (file === '/usr/bin/security') throw new Error('fixture cleanup failure');
        },
      }), (err: unknown) => {
        const result = (err as { result?: Parameters<typeof helperMatrixConfig>[0] }).result;
        assert.ok(result);
        assert.equal(helperMatrixConfig(result)['keychain.helperCheckError'], 'parent-cleanup-failed');
        return true;
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
        cases: { securityCreated: 'fail', securityUpdated: 'pass', helperDeleted: 'pass' },
        casePrompted: { securityCreated: true, securityUpdated: false, helperDeleted: false },
        caseReasons: { securityCreated: null, securityUpdated: null, helperDeleted: null },
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

  it('verifies a trusted helper immediately before every credential write that grants it access', () => {
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

  it('allows a validly signed helper with the exact authority when no pin is recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-helper-no-pin-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    let helperCalls = 0;
    const backend = new MacosKeychainBackend({
      helperPath: helper,
      execFileSync: markFakeExecutor(() => { helperCalls += 1; return ''; }),
      helperConfigReader: () => null,
      helperSigningInspector: () => ({
        authority: 'QLB Keychain Helper', binaryHash: 'a'.repeat(40), identityHash: 'b'.repeat(40),
      }),
    });
    try {
      backend.setSync('qlb-test-helper', 'qlb', 'credential');
      assert.equal(helperCalls, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a pinless helper with the wrong authority before spawning it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-helper-no-pin-wrong-authority-'));
    const helper = join(dir, 'qlb-keychain-helper');
    writeFileSync(helper, 'fixture helper');
    let helperCalls = 0;
    const backend = new MacosKeychainBackend({
      helperPath: helper,
      execFileSync: markFakeExecutor(() => { helperCalls += 1; return ''; }),
      helperConfigReader: () => null,
      helperSigningInspector: () => ({
        authority: 'Other Signing Identity', binaryHash: 'a'.repeat(40), identityHash: 'b'.repeat(40),
      }),
    });
    try {
      assert.throws(
        () => backend.setSync('qlb-test-helper', 'qlb', 'credential'),
        /helper-untrusted: helper signed by Other Signing Identity, expected QLB Keychain Helper/,
      );
      assert.equal(helperCalls, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses instead of using the pinless check when the configured database cannot be read', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-helper-unreadable-db-'));
    const brokenDb = join(home, 'custom', 'qlb.db');
    const helper = join(home, 'qlb-keychain-helper');
    const previous = {
      QLB_HOME: process.env.QLB_HOME,
      QLB_TEST_MODE: process.env.QLB_TEST_MODE,
      QLB_DB_PATH: process.env.QLB_DB_PATH,
    };
    writeFileSync(helper, 'fixture helper');
    mkdirSync(join(home, 'custom'), { recursive: true });
    writeFileSync(brokenDb, 'not a sqlite database');
    process.env.QLB_DB_PATH = brokenDb;
    process.env.QLB_TEST_MODE = '1';
    process.env.QLB_HOME = home;
    let helperCalls = 0;
    let inspected = 0;
    try {
      const backend = new MacosKeychainBackend({
        helperPath: helper,
        execFileSync: markFakeExecutor(() => { helperCalls += 1; return ''; }),
        helperSigningInspector: () => { inspected += 1; return { authority: 'QLB Keychain Helper' } as never; },
        helperIdentityVerifier: () => ({ trusted: true }),
      });
      assert.throws(() => backend.setSync('qlb-test-helper', 'qlb', 'credential'), KeychainHelperUntrustedError);
      assert.equal(helperCalls, 0);
      assert.equal(inspected, 0);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads the helper pin from the configured database rather than the default database', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-helper-configured-db-'));
    const customDb = join(home, 'custom', 'qlb.db');
    const helper = join(home, 'qlb-keychain-helper');
    const previous = {
      QLB_HOME: process.env.QLB_HOME,
      QLB_TEST_MODE: process.env.QLB_TEST_MODE,
      QLB_DB_PATH: process.env.QLB_DB_PATH,
    };
    writeFileSync(helper, 'fixture helper');
    mkdirSync(join(home, '.qlb'), { recursive: true });
    writeFileSync(join(home, '.qlb', 'config.json'), JSON.stringify({ dbPath: customDb }));
    const store = openStore(customDb);
    const pin = 'd'.repeat(40);
    store.setConfig('keychain.helperCheckIdentityHash', pin);
    store.close();
    delete process.env.QLB_DB_PATH;
    process.env.QLB_TEST_MODE = '1';
    process.env.QLB_HOME = home;
    let seenPin: string | undefined;
    try {
      const backend = new MacosKeychainBackend({
        helperPath: helper,
        execFileSync: markFakeExecutor(() => ''),
        helperIdentityVerifier: (_path, candidate) => {
          seenPin = candidate;
          return { trusted: true };
        },
      });
      backend.setSync('qlb-test-helper', 'qlb', 'credential');
      assert.equal(seenPin, pin);
      assert.equal(existsSync(defaultConfig(home).dbPath), false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
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
        '--verify', '--strict', '-R', `=certificate leaf = H"${pin}"`, helper,
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
        cases: { securityCreated: 'pass', securityUpdated: 'pass', helperDeleted: 'pass' },
        casePrompted: { securityCreated: false, securityUpdated: false, helperDeleted: false },
        caseReasons: { securityCreated: null, securityUpdated: null, helperDeleted: null },
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
      cases: { securityCreated: 'pass' as const, securityUpdated: 'pass' as const, helperDeleted: 'pass' as const },
      casePrompted: { securityCreated: false, securityUpdated: false, helperDeleted: false },
      caseReasons: { securityCreated: null, securityUpdated: null, helperDeleted: null },
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
    // Opt-in only: ordinary test runs must not access any real Keychain.
    skip: process.env.QLB_REAL_KEYCHAIN_TESTS !== '1' || !existsSync('/usr/bin/swiftc'),
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
      new MacosKeychainBackend({ helperPath: helper }).setSync(service, account, payload);
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
