import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { defaultKeychainHelperPath, KeychainHelperMissingError, MACOS_SECURITY_TIMEOUT_MS } from '../keychain';
import { CONFIG_ENV_VARS } from '../config';
import { qlbHomeDir } from '../home';
import { assertKeychainAccess, macosKeychainAccountName } from '../keychain-allowlist';
import { listCswapProcesses } from '../cswap-processes';
import { assertAdmitted } from '../lifecycle';
import {
  inspectHelperSigning,
  verifyHelperIdentity,
  type HelperIdentityVerification,
  type HelperSigningState,
} from '../diagnostics';
import { openStore, openStoreConnection } from '../store';
import type { CommandDefinition, CommandContext } from '../registry';

export type HelperMatrixCase = 'pass' | 'fail';
type HelperMatrixCaseName = 'securityCreated' | 'securityUpdated' | 'helperDeleted';
export interface HelperMatrixResult {
  cases: Record<HelperMatrixCaseName, HelperMatrixCase>;
  /** S50 prompt evidence retained separately for each disposable case. */
  casePrompted: Record<HelperMatrixCaseName, boolean>;
  /** Stable, payload-free operational reason for a failed disposable case. */
  caseReasons: Record<HelperMatrixCaseName, string | null>;
  prompted: boolean;
}

export type MatrixCommandRunner = (path: string, args: readonly string[]) => void;

export interface HelperMatrixDependencies {
  /** Injectable so matrix tests use fakes and never invoke the real Keychain. */
  run?: MatrixCommandRunner;
  now?: () => number;
  randomId?: () => string;
  platform?: NodeJS.Platform;
  /** Private LaunchAgent handoff: written before any disposable item exists. */
  cleanupManifestPath?: string;
}

class MatrixReceiptError extends Error {
  constructor(readonly result: HelperMatrixResult | null, message = 'helper matrix receipt is not green') {
    super(message);
  }
}

function helperPath(): string {
  return defaultKeychainHelperPath();
}

type KeychainSubcommand = 'matrix' | 'check-launchd' | 'authorize';

function usage(ctx: CommandContext): number {
  ctx.stderr('usage: qlb keychain matrix|check-launchd [--json]|check-launchd --live [--json] | authorize [cswap] [--json]');
  return 2;
}

function parse(args: string[]): { subcommand: KeychainSubcommand; json: boolean; cswap: boolean; live: boolean; internalMatrix: boolean; internalHelperPath: string | null; cleanupManifestPath: string | null; privateRunDirectory: string | null } | null {
  const [subcommand, ...flags] = args;
  if (subcommand === 'matrix' || subcommand === 'check-launchd') {
    const internalMatrix = subcommand === 'matrix' && flags[0] === '--internal';
    if (internalMatrix) {
      const helperFlag = flags[1];
      const manifestFlag = flags[2];
      const runDirectoryFlag = flags[3];
      const helperPath = helperFlag?.startsWith('--helper-path=') ? helperFlag.slice('--helper-path='.length) : null;
      const cleanupManifestPath = manifestFlag?.startsWith('--cleanup-manifest=') ? manifestFlag.slice('--cleanup-manifest='.length) : null;
      const privateRunDirectory = runDirectoryFlag?.startsWith('--run-directory=') ? runDirectoryFlag.slice('--run-directory='.length) : null;
      if (flags.length !== 4 || !helperPath || !cleanupManifestPath || !privateRunDirectory || !isAbsolute(helperPath) || !isAbsolute(cleanupManifestPath) || !isAbsolute(privateRunDirectory)) return null;
      return { subcommand, json: false, cswap: false, live: false, internalMatrix: true, internalHelperPath: helperPath, cleanupManifestPath, privateRunDirectory };
    }
    const live = flags.filter((flag) => flag === '--live').length === 1;
    if (flags.some((flag) => flag !== '--json' && flag !== '--live') || flags.filter((flag) => flag === '--json').length > 1 || flags.filter((flag) => flag === '--live').length > 1) return null;
    if (subcommand !== 'check-launchd' && live) return null;
    return { subcommand, json: flags.includes('--json'), cswap: false, live, internalMatrix: false, internalHelperPath: null, cleanupManifestPath: null, privateRunDirectory: null };
  }
  if (subcommand === 'authorize') {
    const cswap = flags.filter((flag) => flag === 'cswap').length === 1;
    if (flags.some((flag) => flag !== '--json' && flag !== 'cswap') || flags.filter((flag) => flag === '--json').length > 1 || flags.filter((flag) => flag === 'cswap').length > 1) return null;
    return { subcommand, json: flags.includes('--json'), cswap, live: false, internalMatrix: false, internalHelperPath: null, cleanupManifestPath: null, privateRunDirectory: null };
  }
  return null;
}

/** Parses QLB's deliberately payload-free matrix receipt. */
export function parseHelperMatrixResult(text: string): HelperMatrixResult {
  const value = JSON.parse(text) as {
    cases?: Record<string, unknown>;
    casePrompted?: Record<string, unknown>;
    caseReasons?: Record<string, unknown>;
    prompted?: unknown;
  };
  const { cases, casePrompted, caseReasons } = value;
  const keys = ['securityCreated', 'securityUpdated', 'helperDeleted'] as const;
  if (!cases || !casePrompted || !caseReasons || typeof cases !== 'object' || typeof casePrompted !== 'object' || typeof caseReasons !== 'object' || typeof value.prompted !== 'boolean') throw new Error('invalid helper matrix receipt');
  for (const key of keys) {
    const outcome = cases[key];
    if ((outcome !== 'pass' && outcome !== 'fail') || typeof casePrompted[key] !== 'boolean' || (caseReasons[key] !== null && typeof caseReasons[key] !== 'string')) {
      throw new Error('invalid helper matrix receipt');
    }
  }
  return {
    cases: cases as HelperMatrixResult['cases'],
    casePrompted: casePrompted as HelperMatrixResult['casePrompted'],
    caseReasons: caseReasons as HelperMatrixResult['caseReasons'],
    prompted: value.prompted,
  };
}

export function helperMatrixIsOk(result: HelperMatrixResult): boolean {
  return !result.prompted &&
    result.cases.securityCreated === 'pass' &&
    result.cases.securityUpdated === 'pass' &&
    result.cases.helperDeleted === 'pass';
}

export const HELPER_MATRIX_CASE_TIMEOUT_MS = 20_000;
/** Security/helper operations exceeding this cannot establish a prompt-free result. */
export const HELPER_MATRIX_PROMPT_SIGNAL_MS = 1_000;
// Two create/read steps, three create/update/read steps, three create/delete/read
// steps, and three cleanup steps all run serially in the LaunchAgent.
const HELPER_MATRIX_STEP_COUNT = 11;
// Reserve a minute for LaunchAgent scheduling beyond every bounded serial step.
export const HELPER_MATRIX_LAUNCHD_TIMEOUT_MS = HELPER_MATRIX_STEP_COUNT * HELPER_MATRIX_CASE_TIMEOUT_MS + 60_000;

function assertHelperReady(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') throw new Error('Keychain helper matrix is available only on macOS');
  if (!existsSync(path)) throw new KeychainHelperMissingError(path);
}

function executeMatrixCommand(path: string, args: readonly string[]): void {
  // Never collect stdout/stderr: the matrix neither needs nor may expose values.
  execFileSync(path, args, {
    encoding: 'utf8', stdio: 'ignore', timeout: HELPER_MATRIX_CASE_TIMEOUT_MS,
  });
}

function isMissingItem(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { status?: unknown }).status === 44;
}

/**
 * Runs only prompt-free disposable cases. QLB itself owns creation and reads;
 * the helper is exercised solely for its retained delete capability.
 */
export function runHelperMatrix(path: string = helperPath(), dependencies: HelperMatrixDependencies = {}): HelperMatrixResult {
  assertHelperReady(path, dependencies.platform);
  const run = dependencies.run ?? executeMatrixCommand;
  const now = dependencies.now ?? Date.now;
  const suffix = (dependencies.randomId ?? randomUUID)().toLowerCase();
  const account = 'qlb';
  const services: Record<HelperMatrixCaseName, string> = {
    securityCreated: `qlb-test-matrix-${suffix}-create`,
    securityUpdated: `qlb-test-matrix-${suffix}-update`,
    helperDeleted: `qlb-test-matrix-${suffix}-delete`,
  };
  const cases: Record<HelperMatrixCaseName, HelperMatrixCase> = {
    securityCreated: 'fail', securityUpdated: 'fail', helperDeleted: 'fail',
  };
  const casePrompted: Record<HelperMatrixCaseName, boolean> = {
    securityCreated: false, securityUpdated: false, helperDeleted: false,
  };
  const caseReasons: Record<HelperMatrixCaseName, string | null> = {
    securityCreated: null, securityUpdated: null, helperDeleted: null,
  };
  // The parent reads this only if the one-shot LaunchAgent fails or times out.
  // Write before the first create so it can remove only our disposable services.
  if (dependencies.cleanupManifestPath) {
    writeFileSync(dependencies.cleanupManifestPath, JSON.stringify(Object.values(services)), { mode: 0o600 });
  }
  const payloadHex = Buffer.from('qlb-matrix-disposable', 'utf8').toString('hex');
  const updatedPayloadHex = Buffer.from('qlb-matrix-disposable-updated', 'utf8').toString('hex');
  const createArgs = (service: string) => [
    'add-generic-password', '-a', account, '-s', service, '-X', payloadHex,
    '-T', path, '-T', '/usr/bin/security',
  ];
  const readArgs = (service: string) => ['find-generic-password', '-a', account, '-w', '-s', service];
  const updateArgs = (service: string) => ['add-generic-password', '-U', '-a', account, '-s', service, '-X', updatedPayloadHex];
  const runStep = (caseName: HelperMatrixCaseName, executable: string, args: readonly string[]): boolean => {
    const started = now();
    try {
      run(executable, args);
      return true;
    } catch {
      return false;
    } finally {
      if (now() - started > HELPER_MATRIX_PROMPT_SIGNAL_MS) casePrompted[caseName] = true;
    }
  };

  try {
    const created = runStep('securityCreated', '/usr/bin/security', createArgs(services.securityCreated));
    const read = created && runStep('securityCreated', '/usr/bin/security', readArgs(services.securityCreated));
    if (created && read) cases.securityCreated = 'pass'; else caseReasons.securityCreated = 'security create or read failed';

    const updateCreated = runStep('securityUpdated', '/usr/bin/security', createArgs(services.securityUpdated));
    const updated = updateCreated && runStep('securityUpdated', '/usr/bin/security', updateArgs(services.securityUpdated));
    const updateRead = updated && runStep('securityUpdated', '/usr/bin/security', readArgs(services.securityUpdated));
    if (updateCreated && updated && updateRead) cases.securityUpdated = 'pass'; else caseReasons.securityUpdated = 'security update or read failed';

    const deleteCreated = runStep('helperDeleted', '/usr/bin/security', createArgs(services.helperDeleted));
    const deleted = deleteCreated && runStep('helperDeleted', path, ['delete', services.helperDeleted, account]);
    let absent = false;
    if (deleted) {
      const started = now();
      try { run('/usr/bin/security', readArgs(services.helperDeleted)); } catch (err) { absent = isMissingItem(err); }
      finally { if (now() - started > HELPER_MATRIX_PROMPT_SIGNAL_MS) casePrompted.helperDeleted = true; }
    }
    if (deleteCreated && deleted && absent) cases.helperDeleted = 'pass'; else caseReasons.helperDeleted = 'helper delete did not remove item';
  } finally {
    for (const [caseName, service] of Object.entries(services) as Array<[HelperMatrixCaseName, string]>) {
      const started = now();
      let cleaned = false;
      try {
        run('/usr/bin/security', ['delete-generic-password', '-a', account, '-s', service]);
        cleaned = true;
      } catch (err) {
        // A successful helper-delete leaves no item for security to remove.
        cleaned = isMissingItem(err);
      } finally {
        if (now() - started > HELPER_MATRIX_PROMPT_SIGNAL_MS) casePrompted[caseName] = true;
      }
      if (!cleaned) {
        cases[caseName] = 'fail';
        caseReasons[caseName] = caseReasons[caseName]
          ? `${caseReasons[caseName]}; cleanup failed`
          : 'cleanup failed';
      }
    }
  }
  for (const caseName of Object.keys(cases) as HelperMatrixCaseName[]) {
    if (casePrompted[caseName]) {
      cases[caseName] = 'fail';
      caseReasons[caseName] = caseReasons[caseName]
        ? `${caseReasons[caseName]}; prompt-free deadline exceeded`
        : 'prompt-free deadline exceeded';
    }
  }
  const prompted = Object.values(casePrompted).some(Boolean);
  return { cases, casePrompted, caseReasons, prompted };
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Validates the receipt/status pair published by the one-shot LaunchAgent. */
export function parseLaunchdMatrixReceipt(receipt: string, status: string): HelperMatrixResult {
  const result = parseHelperMatrixResult(receipt);
  if (status.trim() !== '0' || !helperMatrixIsOk(result)) throw new MatrixReceiptError(result);
  return result;
}

export interface LaunchdMatrixDependencies {
  /** Injectable so launchd matrix tests never invoke launchctl or security. */
  run?: MatrixCommandRunner;
  now?: () => number;
  wait?: () => void;
  platform?: NodeJS.Platform;
  uid?: number;
  /** Resolved parent configuration passed to the one-shot child. */
  environment?: Record<string, string>;
  /** Test seam for confirming a booted-out child has exited. */
  jobExited?: () => boolean;
}

function executeLaunchdMatrixCommand(executable: string, args: readonly string[]): void {
  execFileSync(executable, args, { encoding: 'utf8', stdio: 'ignore', timeout: MACOS_SECURITY_TIMEOUT_MS });
}

function cleanupLaunchdMatrixManifest(manifest: string, run: MatrixCommandRunner): string[] {
  let names: unknown;
  try { names = JSON.parse(readFileSync(manifest, 'utf8')); } catch { return []; }
  if (!Array.isArray(names)) return [];
  const failures: string[] = [];
  for (const name of names) {
    // The child-controlled manifest is a cleanup capability boundary.
    if (typeof name !== 'string' || !name.startsWith('qlb-test-matrix-')) continue;
    try {
      run('/usr/bin/security', ['delete-generic-password', '-a', 'qlb', '-s', name]);
    } catch (err) {
      if (!isMissingItem(err)) failures.push(name);
    }
  }
  return failures;
}

function failedLaunchdMatrixResult(code: string): HelperMatrixResult {
  return {
    cases: { securityCreated: 'fail', securityUpdated: 'fail', helperDeleted: 'fail' },
    casePrompted: { securityCreated: false, securityUpdated: false, helperDeleted: false },
    caseReasons: { securityCreated: code, securityUpdated: code, helperDeleted: code },
    prompted: false,
  };
}

function recordLaunchdCleanupFailures(result: HelperMatrixResult, failures: string[]): void {
  if (failures.length === 0) return;
  const caseName = (Object.keys(result.cases) as HelperMatrixCaseName[])
    .find((name) => result.cases[name] === 'fail') ?? 'helperDeleted';
  result.cases[caseName] = 'fail';
  result.caseReasons[caseName] = result.caseReasons[caseName]
    ? `${result.caseReasons[caseName]}; parent-cleanup-failed`
    : 'parent-cleanup-failed';
}

function recordLaunchdCleanupSkipped(result: HelperMatrixResult): void {
  const caseName = (Object.keys(result.cases) as HelperMatrixCaseName[])
    .find((name) => result.cases[name] === 'fail') ?? 'helperDeleted';
  result.cases[caseName] = 'fail';
  result.caseReasons[caseName] = result.caseReasons[caseName]
    ? `${result.caseReasons[caseName]}; parent-cleanup-skipped-child-running`
    : 'parent-cleanup-skipped-child-running';
}

function isPrivateRunPath(runDirectory: string, path: string, uid: number): boolean {
  try {
    const directoryStat = lstatSync(runDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== uid || (directoryStat.mode & 0o077) !== 0) return false;
    // Check lexical containment before resolving the run directory. macOS /tmp
    // may itself resolve through /private, but that does not make its child paths
    // escapes. Every existing component is then checked for a symlink.
    const child = relative(resolve(runDirectory), resolve(path));
    if (!child || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) return false;
    let current = runDirectory;
    for (const segment of child.split(/[\\/]/).slice(0, -1)) {
      current = join(current, segment);
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) return false;
    }
    if (existsSync(path)) {
      const pathStat = lstatSync(path);
      if (pathStat.isSymbolicLink() || pathStat.uid !== uid) return false;
    }
    // Resolve after the component checks so a symlinked /tmp cannot make an
    // outside path look like a child of the private run directory.
    realpathSync(runDirectory);
    return true;
  } catch { return false; }
}

function readHelperConfigReadOnly(dbPath: string, key: string): string | null {
  // The hidden child is a verifier only. It must never create or migrate a store.
  const db = openStoreConnection(dbPath, true);
  try {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  } finally { db.close(); }
}

/** Runs the disposable QLB-side matrix in a temporary one-shot LaunchAgent. */
export function runHelperMatrixUnderLaunchd(
  path: string = helperPath(),
  cliPath: string | undefined = process.argv[1],
  dependencies: LaunchdMatrixDependencies = {},
): HelperMatrixResult {
  assertHelperReady(path, dependencies.platform);
  if (!cliPath) throw new Error('could not determine QLB CLI path');
  const uid = dependencies.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error('could not determine the macOS user id');
  const run = dependencies.run ?? executeLaunchdMatrixCommand;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? (() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50));
  const dir = mkdtempSync(join(tmpdir(), 'qlb-helpercheck-'));
  chmodSync(dir, 0o700);
  const label = `com.modus.qlb-helpercheck.${process.pid}.${now()}`;
  const plist = join(dir, `${label}.plist`);
  const status = join(dir, 'status');
  const receipt = join(dir, 'receipt.json');
  const manifest = join(dir, 'disposable-items.json');
  const domain = `gui/${uid}`;
  let succeeded = false;
  let timedOut = false;
  let failedResult: HelperMatrixResult | null = null;
  if (![plist, status, receipt, manifest].every((candidate) => isPrivateRunPath(dir, candidate, process.getuid?.() ?? -1))) {
    throw new Error('invalid private launchd run path');
  }
  // Publish status atomically so the polling side never observes an empty file.
  // The helper path and private run directory are passed explicitly so the child
  // tests the parent-verified binary and cannot redirect its cleanup capability.
  const shell = '"$1" "$2" keychain matrix --internal "--helper-path=$3" "--cleanup-manifest=$4" "--run-directory=$5" > "$6"; rc=$?; printf "%s" "$rc" > "$7.tmp" && mv "$7.tmp" "$7"';
  const args = ['/bin/sh', '-c', shell, '--', process.execPath, resolve(cliPath), path, manifest, dir, receipt, status];
  const values = args.map((arg) => `      <string>${xml(arg)}</string>`).join('\n');
  const environment = dependencies.environment ? `\n  <key>EnvironmentVariables</key><dict>\n${plistDictionary(dependencies.environment)}\n  </dict>` : '';
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array>\n${values}\n  </array>${environment}\n  <key>RunAtLoad</key><true/>\n</dict></plist>\n`, { mode: 0o600 });
  try {
    run('/bin/launchctl', ['bootstrap', domain, plist]);
    const deadline = now() + HELPER_MATRIX_LAUNCHD_TIMEOUT_MS;
    while (!existsSync(status) && now() < deadline) wait();
    if (!existsSync(status)) {
      timedOut = true;
      failedResult = failedLaunchdMatrixResult('launchd-timeout');
      throw new MatrixReceiptError(failedResult, 'helper matrix timed out under launchd');
    }
    try {
      const result = parseLaunchdMatrixReceipt(readFileSync(receipt, 'utf8'), readFileSync(status, 'utf8'));
      succeeded = true;
      return result;
    } catch (err) {
      if (err instanceof MatrixReceiptError) {
        failedResult = err.result ?? failedLaunchdMatrixResult('launchd-receipt-failed');
        throw err;
      }
      failedResult = failedLaunchdMatrixResult('launchd-receipt-unreadable');
      throw new MatrixReceiptError(failedResult, 'helper matrix receipt unreadable under launchd');
    }
  } finally {
    try { run('/bin/launchctl', ['bootout', domain, plist]); } catch { /* cleanup */ }
    if (!succeeded) {
      // A timeout means the child could still be using its disposable items. Do
      // not race it: cleanup is permitted only after launchd confirms it exited.
      let childExited = !timedOut;
      if (timedOut) {
        const exited = dependencies.jobExited ?? (() => {
          if (dependencies.run) return false;
          try {
            execFileSync('/bin/launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8', stdio: 'ignore', timeout: MACOS_SECURITY_TIMEOUT_MS });
            return false;
          } catch (err) { return (err as { status?: unknown }).status === 113; }
        });
        for (let attempt = 0; attempt < 20 && !childExited; attempt++) {
          childExited = exited();
          if (!childExited) wait();
        }
      }
      const result = failedResult ?? failedLaunchdMatrixResult('launchd-receipt-unavailable');
      if (childExited) recordLaunchdCleanupFailures(result, cleanupLaunchdMatrixManifest(manifest, run));
      else recordLaunchdCleanupSkipped(result);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Re-export the sole signing inspector used by diagnostics and release installation. */
export type { HelperSigningState };
export const helperSigningState = inspectHelperSigning;

function helperMatrixFailureCode(result: HelperMatrixResult | null): string {
  if (!result) return 'helper-matrix-failed';
  const reason = Object.values(result.caseReasons).find((value) => typeof value === 'string') ?? '';
  for (const code of ['parent-cleanup-failed', 'parent-cleanup-skipped-child-running', 'launchd-timeout', 'launchd-receipt-unreadable', 'launchd-receipt-failed', 'launchd-child-failed']) {
    if (reason.includes(code)) return code;
  }
  return 'helper-matrix-failed';
}

export function helperMatrixConfig(
  result: HelperMatrixResult | null,
  signing: HelperSigningState | null = null,
): Record<string, string> {
  const passed = !!result && helperMatrixIsOk(result) && signing?.authority === 'QLB Keychain Helper';
  const config: Record<string, string> = {
    'keychain.helperCheckAt': String(Date.now()),
    'keychain.helperCheckResult': passed ? 'ok' : 'failed',
    'keychain.helperCheckError': passed ? '' : helperMatrixFailureCode(result),
    'keychain.helperCheckPrompted': String(result?.prompted === true),
    'keychain.helperCheckCasePrompted': JSON.stringify(result?.casePrompted ?? {}),
  };
  // A failed matrix must never establish a pin for a helper that did not run.
  if (passed && signing) {
    config['keychain.helperCheckBinaryHash'] = signing.binaryHash;
    config['keychain.helperCheckIdentityHash'] = signing.identityHash;
  }
  return config;
}

function writeMatrixConfig(
  dbPath: string,
  result: HelperMatrixResult | null,
  signing: HelperSigningState | null,
): void {
  const store = openStore(dbPath);
  try {
    for (const [key, value] of Object.entries(helperMatrixConfig(result, signing))) store.setConfig(key, value);
  } finally {
    store.close();
  }
}

/**
 * `verifiedFd` identifies the staged inode observed before verification; the default
 * runner compares it with the spawned path before opening stdin for input.
 */
type HelperRunner = (path: string, args: string[], input?: Buffer, verifiedFd?: number, expectedSigning?: HelperSigningState | null) => void | Promise<void>;
type CswapItemReader = (service: string, account: string) => Buffer;

export interface LiveSwitchReceipt {
  outcome: 'ok' | 'noop' | 'refused' | 'failed' | 'rolled-back';
  from: string | null;
  to: string;
  switchId: number | null;
  attempt: string;
  reason: string | null;
  error: string | null;
  outgoingKind: string | null;
  steps: { failedStep?: number; cleanup?: string[]; restoreFailures?: string[] } | null;
  injected: boolean;
}

type LaunchdRunner = (args: string[]) => string | void;
type LaunchdPrintState = 'running' | 'stopped' | 'not-loaded' | 'unknown';

export interface LaunchdLiveSwitchDependencies {
  /** Injectable so runner tests never invoke the host launchctl. */
  launchdRunner?: LaunchdRunner;
  /** Injectable only for hermetic runner tests on non-macOS hosts. */
  platform?: NodeJS.Platform;
  /** Injectable so timeout tests do not wait for a real 90-second deadline. */
  now?: () => number;
  wait?: () => void;
}

export interface KeychainCommandDependencies {
  runMatrix?: () => HelperMatrixResult;
  runLaunchdMatrix?: (path: string, environment?: Record<string, string>) => HelperMatrixResult;
  /** Runs the self-republish in a one-shot LaunchAgent. */
  runLaunchdLiveSwitch?: (activeId: string, env: NodeJS.ProcessEnv) => LiveSwitchReceipt | { timeout: true } | { inProgress: string };
  /** Test seam for the production runner's launchctl effect. */
  launchdRunner?: LaunchdRunner;
  /** Injectable so receipt handling can be tested without codesign. */
  helperSigning?: (path: string) => HelperSigningState | null;
  /** Injectable config lookup for the matrix-recorded leaf certificate pin. */
  helperConfigReader?: (key: string) => string | null;
  /** Injectable so pinned identity checks remain hermetic in tests. */
  helperIdentityVerifier?: (path: string, pin: string) => HelperIdentityVerification;
  /** Test seam: no test invokes a compiled helper. */
  helperPath?: () => string;
  /** Test seam: records helper forms without handling credential bytes. */
  helperRunner?: HelperRunner;
  /** Test seam: exercise staged-helper verification even with an injected runner. */
  stageAuthorizedHelper?: boolean;
  /** Test seam: simulates a same-user pathname replacement after verification. */
  afterAuthorizedHelperVerified?: (stagedPath: string) => void;
  /** Test seam: reads a disposable C-swap item without invoking security. */
  readCswapItem?: CswapItemReader;
  /** Test seam for S24 immediately before each CAS write. */
  listCswapProcesses?: () => Array<{ pid: number }>;
  now?: () => number;
}

function activeClaudeCodeServices(env: NodeJS.ProcessEnv, home: string): string[] {
  const base = 'Claude Code-credentials';
  const secureDirectory = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const configDirectory = secureDirectory === undefined ? env.CLAUDE_CONFIG_DIR : secureDirectory;
  if (!configDirectory) return [base];
  const digest = createHash('sha256').update(configDirectory.normalize('NFC'), 'utf8').digest('hex').slice(0, 8);
  const services = [`${base}-${digest}`];
  try {
    if (secureDirectory === undefined && realpathSync(configDirectory) === realpathSync(resolve(home, '.claude'))) services.push(base);
  } catch { /* An unresolved profile must not be mistaken for the default profile. */ }
  return services;
}

function cswapItems(sequencePath: string): Array<{ service: 'claude-swap'; account: string }> {
  const parsed = JSON.parse(readFileSync(sequencePath, 'utf8')) as { sequence?: unknown; accounts?: unknown };
  if (!Array.isArray(parsed.sequence) || !parsed.accounts || typeof parsed.accounts !== 'object') throw new Error('C-swap account registry is unreadable');
  const accounts = parsed.accounts as Record<string, unknown>;
  const items: Array<{ service: 'claude-swap'; account: string }> = [];
  for (const number of parsed.sequence) {
    if ((typeof number !== 'number' && typeof number !== 'string') || String(number).length === 0) throw new Error('C-swap account registry is unreadable');
    const entry = accounts[String(number)];
    if (!entry || typeof entry !== 'object' || typeof (entry as { email?: unknown }).email !== 'string' || !(entry as { email: string }).email) {
      throw new Error('C-swap account registry is unreadable');
    }
    items.push({ service: 'claude-swap', account: `account-${number}-${(entry as { email: string }).email}` });
  }
  return items;
}

async function defaultHelperRunner(
  path: string,
  args: string[],
  input?: Buffer,
  verifiedFd?: number,
  expectedSigning?: HelperSigningState | null,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(path, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.stdin?.end();
      child.kill();
      reject(error);
    };
    timeout = setTimeout(() => fail(new Error('keychain helper failed')), MACOS_SECURITY_TIMEOUT_MS);
    child.once('error', () => fail(new Error('keychain helper failed')));
    child.once('spawn', () => {
      try {
        if (verifiedFd !== undefined) {
          const verified = fstatSync(verifiedFd);
          const executed = statSync(path);
          // The child is spawned before this check; Node documents `spawn` as the
          // successful child-process creation event. Its executable cannot change
          // afterwards, and stdin remains unopened until this inode check passes.
          // https://nodejs.org/api/child_process.html#event-spawn
          if (verified.dev !== executed.dev || verified.ino !== executed.ino) {
            fail(new Error('keychain helper changed after verification'));
            return;
          }
        }
        if (expectedSigning) {
          const after = helperSigningState(path);
          if (!after || after.binaryHash !== expectedSigning.binaryHash || after.identityHash !== expectedSigning.identityHash) {
            fail(new Error('keychain helper changed after verification'));
            return;
          }
        }
        child.stdin?.end(input);
      } catch {
        fail(new Error('keychain helper changed after verification'));
      }
    });
    child.once('close', (status) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (status === 0) resolve();
      else if (status === 3) reject(Object.assign(new Error('keychain item changed'), { exitCode: 3 }));
      else if (status === 4) reject(Object.assign(new Error('keychain item not found'), { exitCode: 4 }));
      else reject(new Error('keychain helper failed'));
    });
  });
}

function defaultCswapItemReader(service: string, account: string, env: NodeJS.ProcessEnv): Buffer {
  assertKeychainAccess(service, account, 'read', { env });
  let output: Buffer;
  try {
    output = execFileSync('/usr/bin/security', ['find-generic-password', '-a', account, '-w', '-s', service], {
      encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], timeout: MACOS_SECURITY_TIMEOUT_MS,
    }) as Buffer;
  } catch {
    throw new Error('C-swap item could not be read');
  }
  try {
    const end = output[output.length - 1] === 0x0a ? output.length - 1 : output.length;
    return Buffer.from(output.subarray(0, end));
  } finally { output.fill(0); }
}

function writeAuthorizationConfig(dbPath: string, key: string, value: string | number): void {
  const store = openStore(dbPath);
  try { store.setConfig(key, String(value)); } finally { store.close(); }
}

/** Production probes and CAS writes use the pinned helper trust boundary retained for helper access. */
function assertAuthorizationHelper(path: string, dbPath: string, dependencies: KeychainCommandDependencies): HelperSigningState | null {
  // A runner-only injection cannot inspect a real helper; it is a hermetic test double.
  if (dependencies.helperRunner && !dependencies.helperSigning && !dependencies.helperIdentityVerifier && !dependencies.helperConfigReader) return null;
  const signing = (dependencies.helperSigning ?? helperSigningState)(path);
  if (!signing || signing.authority !== 'QLB Keychain Helper') throw new Error('helper identity is not trusted');
  const configReader = dependencies.helperConfigReader ?? ((key: string) => {
    const store = openStore(dbPath);
    try { return store.getConfig(key); } finally { store.close(); }
  });
  const pin = configReader('keychain.helperCheckIdentityHash');
  if (pin && !(dependencies.helperIdentityVerifier ?? verifyHelperIdentity)(path, pin).trusted) {
    throw new Error('helper identity is not trusted');
  }
  return signing;
}

/**
 * Residual risk (D-B38): the post-spawn check inspects the pathname, so a same-user process
 * that swaps the file before exec and restores it before 'spawn' is not detected. Such a
 * process can already read these items through /usr/bin/security, so this gives it no new access.
 * Verify the opened staged inode, then spawn by path and compare that pathname's
 * inode before the child receives stdin. Node emits `spawn` only after creating the
 * child (https://nodejs.org/api/child_process.html#event-spawn), so a one-way replacement
 * is detected before any secret bytes are written to the replacement process.
 */
async function withAuthorizedHelper<T>(
  path: string,
  dbPath: string,
  dependencies: KeychainCommandDependencies,
  action: (authorizedPath: string, signing: HelperSigningState | null, verifiedFd?: number) => T | Promise<T>,
): Promise<T> {
  if (dependencies.helperRunner && !dependencies.stageAuthorizedHelper) {
    return action(path, assertAuthorizationHelper(path, dbPath, dependencies));
  }
  const directory = mkdtempSync(join(tmpdir(), 'qlb-authorized-helper-'));
  const staged = join(directory, 'qlb-keychain-helper');
  let fd: number | undefined;
  try {
    copyFileSync(path, staged);
    chmodSync(staged, 0o500);
    fd = openSync(staged, 'r');
    // Keep the pre-verification inode open; it is compared after spawn before stdin.
    const signing = assertAuthorizationHelper(staged, dbPath, dependencies);
    dependencies.afterAuthorizedHelperVerified?.(staged);
    return await action(staged, signing, fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function authorize(options: { cswap: boolean; json: boolean }, ctx: CommandContext, dependencies: KeychainCommandDependencies): Promise<number> {
  const helper = dependencies.helperPath?.() ?? helperPath();
  const runner = dependencies.helperRunner ?? defaultHelperRunner;
  const now = dependencies.now ?? Date.now;
  try {
    if (!options.cswap) {
      const account = macosKeychainAccountName(ctx.env);
      const claudeCodeServices = activeClaudeCodeServices(ctx.env, ctx.home);
      const cswap = cswapItems(ctx.config.cswapSequencePath);
      let authorized = 0;
      const signing = await withAuthorizedHelper(helper, ctx.config.dbPath, dependencies, async (authorizedHelper, helperSigning, inheritedFd) => {
        // Claude Code gives these services in try-order. Only the first existing
        // active-profile item is required; an absent fallback is not a failure.
        let claudeCodeAuthorized = false;
        for (const service of claudeCodeServices) {
          try {
            await runner(authorizedHelper, ['probe-read', service, account], undefined, inheritedFd, helperSigning);
            claudeCodeAuthorized = true;
            authorized += 1;
            break;
          } catch (err) {
            if ((err as { exitCode?: unknown }).exitCode !== 4) throw err;
          }
        }
        if (!claudeCodeAuthorized) throw new Error('Claude Code item could not be read');
        for (const item of cswap) {
          await runner(authorizedHelper, ['probe-read', item.service, item.account], undefined, inheritedFd, helperSigning);
          authorized += 1;
        }
        return helperSigning;
      });
      writeAuthorizationConfig(ctx.config.dbPath, 'keychain.liveItemsReadAuthorizedAt', now());
      if (signing) writeAuthorizationConfig(ctx.config.dbPath, 'keychain.liveItemsReadAuthorizedIdentityHash', signing.identityHash);
      ctx.stdout(options.json ? JSON.stringify({ command: 'authorize', authorized }) : 'Keychain live items read-authorized');
      return 0;
    }

    const store = openStore(ctx.config.dbPath);
    try {
      const admission = assertAdmitted(store, 'keychain-authorize-cswap');
      if (!admission.ok) {
        ctx.stderr(`qlb keychain: refused: ${admission.code}`);
        return 3;
      }
    } finally { store.close(); }

    const reader = dependencies.readCswapItem ?? ((service: string, account: string) => defaultCswapItemReader(service, account, ctx.env));
    const processList = dependencies.listCswapProcesses ?? listCswapProcesses;
    const items = cswapItems(ctx.config.cswapSequencePath);
    for (const item of items) {
      const payload = reader(item.service, item.account);
      try {
        const digest = createHash('sha256').update(payload).digest('hex');
        // S24 is deliberately rechecked immediately before every write.
        if (processList().length > 0) {
          ctx.stderr('qlb keychain: refused: C-swap process is alive');
          return 3;
        }
        await withAuthorizedHelper(helper, ctx.config.dbPath, dependencies, async (authorizedHelper, _signing, inheritedFd) => {
          await runner(authorizedHelper, ['set', '--if-sha256', digest, item.service, item.account], payload, inheritedFd, _signing);
        });
      } finally { payload.fill(0); }
    }
    writeAuthorizationConfig(ctx.config.dbPath, 'keychain.cswapItemsAuthorizedAt', now());
    ctx.stdout(options.json ? JSON.stringify({ command: 'authorize cswap', authorized: items.length }) : 'C-swap items CAS-authorized');
    return 0;
  } catch (err) {
    const changed = (err as { exitCode?: unknown }).exitCode === 3;
    ctx.stderr(changed ? 'qlb keychain: authorization changed; nothing was written' : 'qlb keychain: authorization failed');
    return changed ? 3 : 1;
  }
}

export function liveSwitchEnvironment(ctx: CommandContext): Record<string, string> {
  const inherited = ctx.env;
  const environment: Record<string, string> = { QLB_CONFIG_PATH: ctx.config.configPath };
  // These values are copied, never inferred: setting QLB_HOME in a production
  // child would trip the CLI's isolated-test-home guard before it dispatches.
  for (const key of ['HOME', 'PATH', 'QLB_HOME', 'QLB_TEST_MODE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] as const) {
    if (inherited[key] !== undefined) environment[key] = inherited[key]!;
  }
  for (const [field, variable] of Object.entries(CONFIG_ENV_VARS)) environment[variable] = ctx.config[field as keyof typeof CONFIG_ENV_VARS];
  return environment;
}

function plistDictionary(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `  <key>${xml(key)}</key><string>${xml(value)}</string>`).join('\n');
}

function requestedConfigPath(): string | null {
  const index = process.argv.indexOf('--config');
  return index >= 0 && typeof process.argv[index + 1] === 'string' ? process.argv[index + 1]! : null;
}

/** Runs a self-republish under launchd so macOS records the prompt provenance. */
export function runLaunchdLiveSwitch(
  activeId: string,
  ctx: CommandContext,
  dependencies: LaunchdLiveSwitchDependencies = {},
): LiveSwitchReceipt | { timeout: true } | { inProgress: string } {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('live launchd check is available only on macOS');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('could not determine the macOS user id');
  const launchd = dependencies.launchdRunner ?? ((args: string[]) => (
    execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: MACOS_SECURITY_TIMEOUT_MS }) as string
  ));
  const domain = `gui/${uid}`;
  const printState = (label: string): LaunchdPrintState => {
    try {
      const service = `${domain}/${label}`;
      const detail = launchd(['print', service]);
      if (typeof detail !== 'string') return 'unknown';
      const lines = detail.split(/\r?\n/);
      const root = lines.findIndex((line) => line.trim() === `${service} = {`);
      if (root < 0) return 'unknown';
      const firstProperty = lines.slice(root + 1).find((line) => /\S/.test(line));
      const indent = firstProperty?.match(/^([ \t]+)\S/)?.[1];
      if (!indent) return 'unknown';
      const statePattern = new RegExp(`^${indent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}state = (running|not running|exited)\\s*$`);
      const state = lines.slice(root + 1).find((line) => statePattern.test(line))?.match(statePattern)?.[1];
      if (state === 'running') return 'running';
      if (state === 'not running' || state === 'exited') return 'stopped';
      return 'unknown';
    } catch (err) {
      // launchctl print uses exit 113 specifically for a missing service. Other
      // failures (including timeouts) must fail closed and preserve the run dir.
      return (err as { status?: unknown }).status === 113 ? 'not-loaded' : 'unknown';
    }
  };
  const root = join(qlbHomeDir(ctx.env), '.qlb', 'launchd-live');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !['com.modus.qlb-livecheck.', 'com.modus.qlb.live-switch.'].some((prefix) => entry.name.startsWith(prefix))) continue;
    const previous = join(root, entry.name);
    const prior = printState(entry.name);
    if (prior === 'running') return { inProgress: entry.name };
    if (prior === 'unknown') throw new Error('could not determine prior live check status');
    try { launchd(['bootout', `${domain}/${entry.name}`]); } catch { /* already unloaded */ }
    rmSync(previous, { recursive: true, force: true });
  }

  const label = `com.modus.qlb-livecheck.${process.pid}.${Date.now()}`;
  const directory = join(root, label);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receiptPath = join(directory, 'receipt.json');
  const statusPath = join(directory, 'status');
  const plistPath = join(directory, `${label}.plist`);
  const shell = 'r="$1"; s="$2"; shift 2; "$@" > "$r"; rc=$?; printf "%s" "$rc" > "$s.tmp" && mv "$s.tmp" "$s"';
  const args = ['/bin/sh', '-c', shell, '--', receiptPath, statusPath, process.execPath, process.argv[1]!, 'switch', 'anthropic', activeId, '--trigger', 'manual', '--republish', '--json'];
  if (requestedConfigPath() !== null) args.push('--config', ctx.config.configPath);
  const values = args.map((arg) => `      <string>${xml(arg)}</string>`).join('\n');
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array>\n${values}\n  </array>\n  <key>EnvironmentVariables</key><dict>\n${plistDictionary(liveSwitchEnvironment(ctx))}\n  </dict>\n  <key>RunAtLoad</key><true/>\n</dict></plist>\n`, { mode: 0o600 });

  let bootstrapped = false;
  let receiptArrived = false;
  try {
    launchd(['bootstrap', domain, plistPath]);
    bootstrapped = true;
    const now = dependencies.now ?? Date.now;
    const wait = dependencies.wait ?? (() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50));
    const deadline = now() + 90_000;
    while (!existsSync(statusPath) && now() < deadline) wait();
    if (!existsSync(statusPath)) return { timeout: true };
    receiptArrived = true;
    return JSON.parse(readFileSync(receiptPath, 'utf8')) as LiveSwitchReceipt;
  } finally {
    // On timeout the agent may still be running. Leave both it and its receipt for
    // a later sweep, which boots out only a job launchctl confirms has stopped.
    if (receiptArrived || (!bootstrapped && printState(label) === 'not-loaded')) {
      try { launchd(['bootout', `${domain}/${label}`]); } catch { /* cleanup */ }
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function recordLiveAuthorization(store: ReturnType<typeof openStore>, identityHash: string): void {
  store.runImmediate(() => {
    store.setConfig('keychain.liveItemsAuthorizedIdentityHash', identityHash);
    store.setConfig('keychain.liveItemsAuthorizedAt', String(Date.now()));
  });
}

function validLiveReceipt(value: unknown): value is LiveSwitchReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<LiveSwitchReceipt>;
  return (receipt.outcome === 'ok' || receipt.outcome === 'noop' || receipt.outcome === 'refused' || receipt.outcome === 'failed' || receipt.outcome === 'rolled-back')
    && typeof receipt.to === 'string' && typeof receipt.attempt === 'string' && typeof receipt.injected === 'boolean'
    && (receipt.from === null || typeof receipt.from === 'string')
    && (receipt.switchId === null || typeof receipt.switchId === 'number')
    && (receipt.reason === null || typeof receipt.reason === 'string')
    && (receipt.error === null || typeof receipt.error === 'string')
    && (receipt.outgoingKind === null || typeof receipt.outgoingKind === 'string')
    && (receipt.steps === null || (typeof receipt.steps === 'object' && receipt.steps !== undefined
      && (receipt.steps.failedStep === undefined || typeof receipt.steps.failedStep === 'number')
      && (receipt.steps.cleanup === undefined || (Array.isArray(receipt.steps.cleanup) && receipt.steps.cleanup.every((entry) => typeof entry === 'string')))
      && (receipt.steps.restoreFailures === undefined || (Array.isArray(receipt.steps.restoreFailures) && receipt.steps.restoreFailures.every((entry) => typeof entry === 'string')))));
}

function runLiveLaunchdCheck(options: { json: boolean }, ctx: CommandContext, dependencies: KeychainCommandDependencies): number {
  const store = openStore(ctx.config.dbPath);
  try {
    const admission = assertAdmitted(store, 'keychain-check-launchd-live');
    if (!admission.ok) {
      ctx.stderr(`qlb keychain: refused: ${admission.code}`);
      return 3;
    }
    const activeId = store.getActiveLogin('anthropic')?.accountId;
    if (!activeId) {
      ctx.stderr('qlb keychain: refused: active-login-unset');
      return 3;
    }
    if (!store.getConfig('keychain.liveItemsReadAuthorizedAt')) {
      ctx.stderr('qlb keychain: refused: live-items-read-not-authorized');
      return 3;
    }
    const pin = (dependencies.helperConfigReader ?? ((key: string) => store.getConfig(key)))('keychain.helperCheckIdentityHash');
    const path = dependencies.helperPath?.() ?? helperPath();
    if (!pin || !(dependencies.helperIdentityVerifier ?? verifyHelperIdentity)(path, pin).trusted) {
      ctx.stderr('qlb keychain: refused: helper identity is not trusted');
      return 3;
    }
    if (store.getConfig('keychain.liveItemsReadAuthorizedIdentityHash') !== pin) {
      ctx.stderr('qlb keychain: refused: live-items-read-authorization-identity-mismatch');
      return 3;
    }

    let result: LiveSwitchReceipt | { timeout: true } | { inProgress: string };
    try {
      result = (dependencies.runLaunchdLiveSwitch ?? ((id, _env) => runLaunchdLiveSwitch(id, ctx, { launchdRunner: dependencies.launchdRunner })))(activeId, ctx.env);
    } catch {
      ctx.stderr('qlb keychain: live check failed');
      return 1;
    }
    if ('inProgress' in result) {
      ctx.stderr('qlb keychain: refused: live-check-in-progress');
      return 1;
    }
    if ('timeout' in result) {
      ctx.stderr('qlb keychain: live check timed out');
      return 1;
    }
    if (!validLiveReceipt(result)) {
      ctx.stderr('qlb keychain: live check failed');
      return 1;
    }
    if (result.outcome === 'ok' && result.from === activeId && result.to === activeId) {
      recordLiveAuthorization(store, pin);
      ctx.stdout(options.json ? JSON.stringify({ command: 'check-launchd --live', liveItemsAuthorized: true }) : 'Keychain live item write-authorized under launchd');
      return 0;
    }
    if (result.outcome === 'rolled-back' && result.steps?.failedStep === 7
      && (result.error === 'keychain-write-failed' || result.error === 'keychain-timeout')
      && !(result.steps.restoreFailures?.length)) {
      const hint = 'a stored login that lost its Keychain permission must be read once in a GUI session with the password and Always Allow, then retry';
      ctx.stdout(options.json
        ? JSON.stringify({ command: 'check-launchd --live', liveItemsAuthorized: false, reason: 'launchd-write-not-authorized' })
        : hint);
      return 1;
    }
    const reason = result.outcome === 'ok' && (result.from !== activeId || result.to !== activeId)
      ? 'receipt account mismatch'
      : (result.reason ?? 'none');
    ctx.stderr(`qlb keychain: live check failed: ${result.outcome}: ${reason}`);
    return 1;
  } finally { store.close(); }
}

export async function runKeychainCommand(
  args: string[],
  ctx: CommandContext,
  dependencies: KeychainCommandDependencies = {},
): Promise<number> {
  const options = parse(args);
  if (!options) return usage(ctx);
  // Tests may exercise the receipt handler only through its injected runner;
  // production launchctl/keychain access remains disabled in test mode, including
  // the hidden LaunchAgent child command.
  if (ctx.env.QLB_TEST_MODE === '1' && !(options.subcommand === 'check-launchd' && options.live && (dependencies.runLaunchdLiveSwitch || dependencies.launchdRunner))) {
    ctx.stderr('qlb keychain: native helper commands are disabled in test mode');
    return 2;
  }
  if (options.subcommand === 'check-launchd' && options.live) return runLiveLaunchdCheck(options, ctx, dependencies);
  if (options.subcommand === 'authorize') return authorize(options, ctx, dependencies);

  const path = options.internalHelperPath ?? dependencies.helperPath?.() ?? helperPath();
  const inspect = dependencies.helperSigning ?? helperSigningState;
  const configReader = dependencies.helperConfigReader ?? ((key: string) => {
    if (options.internalMatrix) return readHelperConfigReadOnly(ctx.config.dbPath, key);
    const store = openStore(ctx.config.dbPath);
    try { return store.getConfig(key); } finally { store.close(); }
  });
  const verify = dependencies.helperIdentityVerifier ?? verifyHelperIdentity;
  const trustedSigning = (): HelperSigningState => {
    const pin = configReader('keychain.helperCheckIdentityHash');
    const signing = inspect(path);
    if (!signing || signing.authority !== 'QLB Keychain Helper') throw new MatrixReceiptError(null);
    if (pin && !verify(path, pin).trusted) throw new MatrixReceiptError(null);
    return signing;
  };

  // This hidden subcommand is used only by the one-shot LaunchAgent. It writes a
  // payload-free receipt, but is not a trust bypass: it verifies the parent-pinned
  // helper before it can invoke the helper or security.
  if (options.internalMatrix) {
    if (!isPrivateRunPath(options.privateRunDirectory!, options.cleanupManifestPath!, process.getuid?.() ?? -1)) return 2;
    let result = failedLaunchdMatrixResult('launchd-child-failed');
    try {
      const signing = trustedSigning();
      result = dependencies.runMatrix
        ? dependencies.runMatrix()
        : runHelperMatrix(path, { cleanupManifestPath: options.cleanupManifestPath! });
      const after = inspect(path);
      if (!helperMatrixIsOk(result) || !after || after.authority !== 'QLB Keychain Helper'
        || after.binaryHash !== signing.binaryHash) throw new MatrixReceiptError(result);
      ctx.stdout(JSON.stringify(result));
      return 0;
    } catch (err) {
      if (err instanceof MatrixReceiptError && err.result) result = err.result;
      // launchd captures stdout as receipt.json: publish a payload-free failed
      // receipt even when helper verification itself failed.
      ctx.stdout(JSON.stringify(result));
      return 1;
    }
  }

  let result: HelperMatrixResult | null = null;
  let signing: HelperSigningState | null = null;
  try {
    signing = trustedSigning();

    result = options.subcommand === 'check-launchd'
      ? (dependencies.runLaunchdMatrix
        ? dependencies.runLaunchdMatrix(path, liveSwitchEnvironment(ctx))
        : runHelperMatrixUnderLaunchd(path, undefined, { environment: liveSwitchEnvironment(ctx) }))
      : (dependencies.runMatrix ? dependencies.runMatrix() : runHelperMatrix(path));
    const after = inspect(path);
    if (!helperMatrixIsOk(result) || !after || after.authority !== 'QLB Keychain Helper'
      || after.binaryHash !== signing.binaryHash) {
      throw new MatrixReceiptError(result);
    }
    // Only a green matrix on an unchanged helper may establish or replace the pin.
    writeMatrixConfig(ctx.config.dbPath, result, after);
    const body = {
      command: options.subcommand, helperCheckResult: 'ok', prompted: result.prompted,
      casePrompted: result.casePrompted, cases: result.cases,
    };
    ctx.stdout(options.json ? JSON.stringify(body) : 'Keychain helper matrix passed');
    return 0;
  } catch (err) {
    if (err instanceof MatrixReceiptError) result = err.result;
    if (err instanceof KeychainHelperMissingError) {
      ctx.stderr(err.message);
      return err.exitCode;
    }
    // Native command errors can contain implementation details. Do not relay stderr
    // because this boundary must never carry Keychain values. Do not record a new
    // identity unless the matrix passed and its post-run CDHash matched the pre-run one.
    writeMatrixConfig(ctx.config.dbPath, result, null);
    ctx.stderr('qlb keychain: helper matrix failed');
    return 1;
  }
}

const command: CommandDefinition = { name: 'keychain', execute: runKeychainCommand };
export default command;
