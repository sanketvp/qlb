import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultKeychainHelperPath, MACOS_SECURITY_TIMEOUT_MS } from '../keychain';
import { openStore } from '../store';
import type { CommandDefinition, CommandContext } from '../registry';

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

/** Executes only the disposable helper matrix; no credential bytes are accepted here. */
function assertHelperReady(path: string): void {
  if (process.platform !== 'darwin') throw new Error('Keychain helper matrix is available only on macOS');
  if (!existsSync(path)) throw new Error(`Keychain helper is not built: ${path}; run npm run build:helper`);
}

/** Executes only the disposable helper matrix; no credential bytes are accepted here. */
export function runHelperMatrix(path: string = helperPath()): void {
  assertHelperReady(path);
  execFileSync(path, ['matrix', 'qlb-test-matrix-'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: MACOS_SECURITY_TIMEOUT_MS,
  });
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Runs the disposable helper matrix in a temporary one-shot LaunchAgent. */
export function runHelperMatrixUnderLaunchd(path: string = helperPath()): void {
  assertHelperReady(path);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('could not determine the macOS user id');
  const dir = mkdtempSync(join(tmpdir(), 'qlb-helpercheck-'));
  const label = `com.modus.qlb-helpercheck.${process.pid}.${Date.now()}`;
  const plist = join(dir, `${label}.plist`);
  const status = join(dir, 'status');
  const domain = `gui/${uid}`;
  const shell = '"$1" matrix "$2"; rc=$?; printf "%s" "$rc" > "$3"';
  const args = ['/bin/sh', '-c', shell, '--', path, 'qlb-test-matrix-', status];
  const values = args.map((arg) => `      <string>${xml(arg)}</string>`).join('\n');
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array>\n${values}\n  </array>\n  <key>RunAtLoad</key><true/>\n</dict></plist>\n`, { mode: 0o600 });
  try {
    execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { encoding: 'utf8', timeout: MACOS_SECURITY_TIMEOUT_MS });
    const deadline = Date.now() + MACOS_SECURITY_TIMEOUT_MS;
    while (!existsSync(status) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (!existsSync(status) || readFileSync(status, 'utf8').trim() !== '0') {
      throw new Error('helper matrix did not succeed under launchd');
    }
  } finally {
    try { execFileSync('/bin/launchctl', ['bootout', domain, plist], { encoding: 'utf8', timeout: MACOS_SECURITY_TIMEOUT_MS }); } catch { /* cleanup */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runKeychainCommand(args: string[], ctx: CommandContext): Promise<number> {
  const options = parse(args);
  if (!options) return usage(ctx);
  if (ctx.env.QLB_TEST_MODE === '1') {
    ctx.stderr('qlb keychain: native helper commands are disabled in test mode');
    return 2;
  }

  try {
    if (options.subcommand === 'check-launchd') runHelperMatrixUnderLaunchd();
    else runHelperMatrix();
    const store = openStore(ctx.config.dbPath);
    try {
      store.setConfig('keychain.helperCheckAt', String(Date.now()));
      store.setConfig('keychain.helperCheckResult', 'ok');
    } finally {
      store.close();
    }
    const result = { command: options.subcommand, helperCheckResult: 'ok' };
    ctx.stdout(options.json ? JSON.stringify(result) : 'Keychain helper matrix passed');
    return 0;
  } catch {
    // Native command errors can contain implementation details. Do not relay
    // stderr because this boundary must never carry Keychain values.
    ctx.stderr('qlb keychain: helper matrix failed');
    return 1;
  }
}

const command: CommandDefinition = {
  name: 'keychain',
  execute: runKeychainCommand,
};

export default command;
