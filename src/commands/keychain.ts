import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultKeychainHelperPath, KeychainHelperMissingError, MACOS_SECURITY_TIMEOUT_MS } from '../keychain';
import { assertKeychainAccess, macosKeychainAccountName } from '../keychain-allowlist';
import { listCswapProcesses } from '../cswap-processes';
import { assertAdmitted } from '../lifecycle';
import {
  inspectHelperSigning,
  verifyHelperIdentity,
  type HelperIdentityVerification,
  type HelperSigningState,
} from '../diagnostics';
import { openStore } from '../store';
import type { CommandDefinition, CommandContext } from '../registry';

export type HelperMatrixCase = 'pass' | 'fail' | 'not-applicable';
type HelperMatrixCaseName = 'securityCreated' | 'securityUntrusted' | 'previousHelper' | 'helperCreated';
export interface HelperMatrixResult {
  cases: Record<HelperMatrixCaseName, HelperMatrixCase>;
  /** S50 prompt evidence retained separately for each disposable case. */
  casePrompted: Record<HelperMatrixCaseName, boolean>;
  /** A first install has no previous helper, so that one case is not applicable. */
  caseReasons: Record<HelperMatrixCaseName, string | null>;
  prompted: boolean;
}

type MatrixRunner = (path: string, args: string[]) => string;

class MatrixReceiptError extends Error {
  constructor(readonly result: HelperMatrixResult | null) {
    super('helper matrix receipt is not green');
  }
}

function helperPath(): string {
  return defaultKeychainHelperPath();
}

type KeychainSubcommand = 'matrix' | 'check-launchd' | 'authorize';

function usage(ctx: CommandContext): number {
  ctx.stderr('usage: qlb keychain matrix|check-launchd [--json] | authorize [cswap] [--json]');
  return 2;
}

function parse(args: string[]): { subcommand: KeychainSubcommand; json: boolean; cswap: boolean } | null {
  const [subcommand, ...flags] = args;
  if (subcommand === 'matrix' || subcommand === 'check-launchd') {
    if (flags.some((flag) => flag !== '--json')) return null;
    return { subcommand, json: flags.includes('--json'), cswap: false };
  }
  if (subcommand === 'authorize') {
    const cswap = flags.filter((flag) => flag === 'cswap').length === 1;
    if (flags.some((flag) => flag !== '--json' && flag !== 'cswap') || flags.filter((flag) => flag === '--json').length > 1 || flags.filter((flag) => flag === 'cswap').length > 1) return null;
    return { subcommand, json: flags.includes('--json'), cswap };
  }
  return null;
}

/** Parses the native helper's deliberately payload-free matrix receipt. */
export function parseHelperMatrixResult(text: string): HelperMatrixResult {
  const value = JSON.parse(text) as {
    cases?: Record<string, unknown>;
    casePrompted?: Record<string, unknown>;
    caseReasons?: Record<string, unknown>;
    prompted?: unknown;
  };
  const { cases, casePrompted, caseReasons } = value;
  const keys = ['securityCreated', 'securityUntrusted', 'previousHelper', 'helperCreated'] as const;
  if (!cases || !casePrompted || !caseReasons || typeof cases !== 'object' || typeof casePrompted !== 'object' || typeof caseReasons !== 'object' || typeof value.prompted !== 'boolean') throw new Error('invalid helper matrix receipt');
  for (const key of keys) {
    const outcome = cases[key];
    if ((outcome !== 'pass' && outcome !== 'fail' && outcome !== 'not-applicable') || typeof casePrompted[key] !== 'boolean' || (caseReasons[key] !== null && typeof caseReasons[key] !== 'string')) {
      throw new Error('invalid helper matrix receipt');
    }
    if (outcome === 'not-applicable' && (key !== 'previousHelper' || caseReasons[key] !== 'no previous helper')) {
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
    result.cases.securityUntrusted === 'pass' &&
    result.cases.helperCreated === 'pass' &&
    (result.cases.previousHelper === 'pass' || result.cases.previousHelper === 'not-applicable');
}

function assertHelperReady(path: string): void {
  if (process.platform !== 'darwin') throw new Error('Keychain helper matrix is available only on macOS');
  if (!existsSync(path)) throw new KeychainHelperMissingError(path);
}

function executeMatrix(path: string, args: string[]): string {
  try {
    return execFileSync(path, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: MACOS_SECURITY_TIMEOUT_MS,
    });
  } catch (err) {
    // The helper prints its payload-free receipt before returning a failing exit code.
    const stdout = (err as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.length > 0) return stdout;
    if (Buffer.isBuffer(stdout)) return stdout.toString('utf8');
    throw err;
  }
}

/** Executes only the disposable four-case helper matrix; no credential bytes are accepted here. */
export function runHelperMatrix(path: string = helperPath(), runner: MatrixRunner = executeMatrix): HelperMatrixResult {
  assertHelperReady(path);
  return parseHelperMatrixResult(runner(path, ['matrix', 'qlb-test-matrix-', join(process.env.HOME ?? '', '.qlb/helper-prev/qlb-keychain-helper')]));
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Runs the disposable four-case helper matrix in a temporary one-shot LaunchAgent. */
export function runHelperMatrixUnderLaunchd(path: string = helperPath()): HelperMatrixResult {
  assertHelperReady(path);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('could not determine the macOS user id');
  const dir = mkdtempSync(join(tmpdir(), 'qlb-helpercheck-'));
  const label = `com.modus.qlb-helpercheck.${process.pid}.${Date.now()}`;
  const plist = join(dir, `${label}.plist`);
  const status = join(dir, 'status');
  const receipt = join(dir, 'receipt.json');
  const domain = `gui/${uid}`;
  const previous = join(process.env.HOME ?? '', '.qlb/helper-prev/qlb-keychain-helper');
  // Publish status atomically so the polling side never observes an empty file.
  const shell = '"$1" matrix "$2" "$3" > "$4"; rc=$?; printf "%s" "$rc" > "$5.tmp" && mv "$5.tmp" "$5"';
  const args = ['/bin/sh', '-c', shell, '--', path, 'qlb-test-matrix-', previous, receipt, status];
  const values = args.map((arg) => `      <string>${xml(arg)}</string>`).join('\n');
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array>\n${values}\n  </array>\n  <key>RunAtLoad</key><true/>\n</dict></plist>\n`, { mode: 0o600 });
  try {
    execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { encoding: 'utf8', timeout: MACOS_SECURITY_TIMEOUT_MS });
    const deadline = Date.now() + MACOS_SECURITY_TIMEOUT_MS;
    while (!existsSync(status) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (!existsSync(status)) throw new Error('helper matrix timed out under launchd');
    const result = parseHelperMatrixResult(readFileSync(receipt, 'utf8'));
    if (readFileSync(status, 'utf8').trim() !== '0' || !helperMatrixIsOk(result)) {
      throw new MatrixReceiptError(result);
    }
    return result;
  } finally {
    try { execFileSync('/bin/launchctl', ['bootout', domain, plist], { encoding: 'utf8', timeout: MACOS_SECURITY_TIMEOUT_MS }); } catch { /* cleanup */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Re-export the sole signing inspector used by diagnostics and release installation. */
export type { HelperSigningState };
export const helperSigningState = inspectHelperSigning;

export function helperMatrixConfig(
  result: HelperMatrixResult | null,
  signing: HelperSigningState | null = null,
): Record<string, string> {
  const passed = !!result && helperMatrixIsOk(result) && signing?.authority === 'QLB Keychain Helper';
  const config: Record<string, string> = {
    'keychain.helperCheckAt': String(Date.now()),
    'keychain.helperCheckResult': passed ? 'ok' : 'failed',
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

type HelperRunner = (path: string, args: string[], input?: Buffer) => void;
type CswapItemReader = (service: string, account: string) => Buffer;

export interface KeychainCommandDependencies {
  runMatrix?: () => HelperMatrixResult;
  runLaunchdMatrix?: () => HelperMatrixResult;
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

function defaultHelperRunner(path: string, args: string[], input?: Buffer): void {
  try {
    execFileSync(path, args, { input, stdio: ['pipe', 'ignore', 'ignore'], timeout: MACOS_SECURITY_TIMEOUT_MS });
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 3) throw Object.assign(new Error('keychain item changed'), { exitCode: 3 });
    if (status === 4) throw Object.assign(new Error('keychain item not found'), { exitCode: 4 });
    throw new Error('keychain helper failed');
  }
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

/** Production probes and CAS writes use the same pinned helper trust boundary as normal writes. */
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
 * Execute a verified private copy, not the pathname inspected earlier. This prevents
 * replacing or retargeting the release helper from redirecting a later stdin payload.
 * The private copy is verified after it is made and removed immediately after use.
 */
function withAuthorizedHelper<T>(
  path: string,
  dbPath: string,
  dependencies: KeychainCommandDependencies,
  action: (authorizedPath: string, signing: HelperSigningState | null) => T,
): T {
  if (dependencies.helperRunner) return action(path, assertAuthorizationHelper(path, dbPath, dependencies));
  const directory = mkdtempSync(join(tmpdir(), 'qlb-authorized-helper-'));
  const staged = join(directory, 'qlb-keychain-helper');
  try {
    copyFileSync(path, staged);
    chmodSync(staged, 0o500);
    return action(staged, assertAuthorizationHelper(staged, dbPath, dependencies));
  } finally {
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
      const signing = withAuthorizedHelper(helper, ctx.config.dbPath, dependencies, (authorizedHelper, helperSigning) => {
        // Claude Code gives these services in try-order. Only the first existing
        // active-profile item is required; an absent fallback is not a failure.
        let claudeCodeAuthorized = false;
        for (const service of claudeCodeServices) {
          try {
            runner(authorizedHelper, ['probe-read', service, account]);
            claudeCodeAuthorized = true;
            authorized += 1;
            break;
          } catch (err) {
            if ((err as { exitCode?: unknown }).exitCode !== 4) throw err;
          }
        }
        if (!claudeCodeAuthorized) throw new Error('Claude Code item could not be read');
        for (const item of cswap) {
          runner(authorizedHelper, ['probe-read', item.service, item.account]);
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
        withAuthorizedHelper(helper, ctx.config.dbPath, dependencies, (authorizedHelper) => {
          runner(authorizedHelper, ['set', '--if-sha256', digest, item.service, item.account], payload);
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

export async function runKeychainCommand(
  args: string[],
  ctx: CommandContext,
  dependencies: KeychainCommandDependencies = {},
): Promise<number> {
  const options = parse(args);
  if (!options) return usage(ctx);
  if (ctx.env.QLB_TEST_MODE === '1') {
    ctx.stderr('qlb keychain: native helper commands are disabled in test mode');
    return 2;
  }
  if (options.subcommand === 'authorize') return authorize(options, ctx, dependencies);

  let result: HelperMatrixResult | null = null;
  const path = helperPath();
  let signing: HelperSigningState | null = null;
  try {
    const inspect = dependencies.helperSigning ?? helperSigningState;
    const configReader = dependencies.helperConfigReader ?? (() => {
      const store = openStore(ctx.config.dbPath);
      try { return store.getConfig('keychain.helperCheckIdentityHash'); } finally { store.close(); }
    });
    const pin = configReader('keychain.helperCheckIdentityHash');
    const verify = dependencies.helperIdentityVerifier ?? verifyHelperIdentity;
    signing = inspect(path);
    if (!signing || signing.authority !== 'QLB Keychain Helper') throw new MatrixReceiptError(null);
    if (pin && !verify(path, pin).trusted) throw new MatrixReceiptError(null);

    result = options.subcommand === 'check-launchd'
      ? (dependencies.runLaunchdMatrix ?? runHelperMatrixUnderLaunchd)()
      : (dependencies.runMatrix ?? runHelperMatrix)();
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
