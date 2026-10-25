import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultKeychainHelperPath, MACOS_SECURITY_TIMEOUT_MS } from '../keychain';
import { openStore } from '../store';
import type { CommandDefinition, CommandContext } from '../registry';

export type HelperMatrixCase = 'pass' | 'fail' | 'skipped';
export interface HelperMatrixResult {
  cases: Record<'securityCreated' | 'previousHelper' | 'helperCreated', HelperMatrixCase>;
  prompted: boolean;
}

type MatrixRunner = (path: string, args: string[]) => string;

class MatrixReceiptError extends Error {
  constructor(readonly result: HelperMatrixResult) {
    super('helper matrix receipt is not green');
  }
}

function helperPath(): string {
  return defaultKeychainHelperPath();
}

function usage(ctx: CommandContext): number {
  ctx.stderr('usage: qlb keychain matrix|check-launchd [--json]');
  return 2;
}

function parse(args: string[]): { subcommand: 'matrix' | 'check-launchd'; json: boolean } | null {
  const [subcommand, ...flags] = args;
  if ((subcommand !== 'matrix' && subcommand !== 'check-launchd') || flags.some((flag) => flag !== '--json')) return null;
  return { subcommand, json: flags.includes('--json') };
}

/** Parses the native helper's deliberately payload-free matrix receipt. */
export function parseHelperMatrixResult(text: string): HelperMatrixResult {
  const value = JSON.parse(text) as { cases?: Record<string, unknown>; prompted?: unknown };
  const cases = value.cases;
  const keys = ['securityCreated', 'previousHelper', 'helperCreated'] as const;
  if (!cases || typeof cases !== 'object' || typeof value.prompted !== 'boolean') throw new Error('invalid helper matrix receipt');
  for (const key of keys) {
    if (cases[key] !== 'pass' && cases[key] !== 'fail' && cases[key] !== 'skipped') {
      throw new Error('invalid helper matrix receipt');
    }
  }
  return { cases: cases as HelperMatrixResult['cases'], prompted: value.prompted };
}

export function helperMatrixIsOk(result: HelperMatrixResult): boolean {
  return !result.prompted && Object.values(result.cases).every((outcome) => outcome === 'pass' || outcome === 'skipped');
}

function assertHelperReady(path: string): void {
  if (process.platform !== 'darwin') throw new Error('Keychain helper matrix is available only on macOS');
  if (!existsSync(path)) throw new Error(`Keychain helper is not built: ${path}; run npm run build:helper`);
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

/** Executes only the disposable three-case helper matrix; no credential bytes are accepted here. */
export function runHelperMatrix(path: string = helperPath(), runner: MatrixRunner = executeMatrix): HelperMatrixResult {
  assertHelperReady(path);
  return parseHelperMatrixResult(runner(path, ['matrix', 'qlb-test-matrix-', join(process.env.HOME ?? '', '.qlb/helper-prev/qlb-keychain-helper')]));
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Runs the disposable three-case helper matrix in a temporary one-shot LaunchAgent. */
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
  const shell = '"$1" matrix "$2" "$3" > "$4"; rc=$?; printf "%s" "$rc" > "$5"';
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

export function helperMatrixConfig(result: HelperMatrixResult | null): Record<string, string> {
  return {
    'keychain.helperCheckAt': String(Date.now()),
    'keychain.helperCheckResult': result && helperMatrixIsOk(result) ? 'ok' : 'failed',
    'keychain.helperCheckPrompted': String(result?.prompted === true),
  };
}

function writeMatrixConfig(dbPath: string, result: HelperMatrixResult | null): void {
  const store = openStore(dbPath);
  try {
    for (const [key, value] of Object.entries(helperMatrixConfig(result))) store.setConfig(key, value);
  } finally {
    store.close();
  }
}

export interface KeychainCommandDependencies {
  runMatrix?: () => HelperMatrixResult;
  runLaunchdMatrix?: () => HelperMatrixResult;
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

  let result: HelperMatrixResult | null = null;
  try {
    result = options.subcommand === 'check-launchd'
      ? (dependencies.runLaunchdMatrix ?? runHelperMatrixUnderLaunchd)()
      : (dependencies.runMatrix ?? runHelperMatrix)();
    if (!helperMatrixIsOk(result)) throw new MatrixReceiptError(result);
    writeMatrixConfig(ctx.config.dbPath, result);
    const body = { command: options.subcommand, helperCheckResult: 'ok', prompted: result.prompted, cases: result.cases };
    ctx.stdout(options.json ? JSON.stringify(body) : 'Keychain helper matrix passed');
    return 0;
  } catch (err) {
    if (err instanceof MatrixReceiptError) result = err.result;
    // Native command errors can contain implementation details. Do not relay stderr
    // because this boundary must never carry Keychain values.
    writeMatrixConfig(ctx.config.dbPath, result);
    ctx.stderr('qlb keychain: helper matrix failed');
    return 1;
  }
}

const command: CommandDefinition = { name: 'keychain', execute: runKeychainCommand };
export default command;
