import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AutoAdmissionRefused, runAuto, type AutoDependencies, type AutoRunResult, type RunAutoOptions } from '../auto';

import { productionTryAcquireLock, type CswapLockRelease } from '../cswap-agent';
import { atomicWriteText } from '../fsutil';
import type { CommandContext, CommandDefinition } from '../registry';

type AutoCommandOptions = RunAutoOptions & { json: boolean };

export interface AutoCommandDeps {
  runAuto: (options: RunAutoOptions, dependencies: AutoDependencies) => Promise<AutoRunResult>;
  acquireFlock(lockPath: string): Promise<CswapLockRelease | null>;
}

const defaultDeps: AutoCommandDeps = { runAuto, acquireFlock: productionTryAcquireLock };

function parse(args: string[]): AutoCommandOptions | null {
  const known = new Set(['--once', '--dry-run', '--json']);
  if (args.some((arg) => !known.has(arg)) || new Set(args).size !== args.length) return null;
  return {
    once: args.includes('--once'), dryRun: args.includes('--dry-run'), json: args.includes('--json'),
  };
}

function xmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!);
}

/** Render the per-user LaunchAgent plist without inheriting the caller's environment. */
export function renderAutoLaunchAgent(nodePath: string, home: string, cliPath: string): string {
  const logPath = join(home, '.qlb', 'auto.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.modus.qlb-auto</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlText(nodePath)}</string>
    <string>${xmlText(cliPath)}</string>
    <string>auto</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${xmlText(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlText(logPath)}</string>
</dict>
</plist>
`;
}

function launchAgentPath(ctx: CommandContext): string {
  const home = ctx.env.QLB_TEST_MODE === '1' && ctx.env.QLB_HOME ? ctx.env.QLB_HOME : ctx.home;
  return join(home, 'Library', 'LaunchAgents', 'com.modus.qlb-auto.plist');
}

function installAutoLaunchAgent(ctx: CommandContext): string {
  const target = launchAgentPath(ctx);
  const home = ctx.env.QLB_TEST_MODE === '1' ? ctx.env.QLB_HOME! : ctx.home;
  const qlbDir = join(home, '.qlb');
  const cliPath = ctx.env.QLB_TEST_MODE === '1'
    ? join(home, 'app', 'current', 'dist', 'cli.js')
    : join(qlbDir, 'app', 'current', 'dist', 'cli.js');
  const logPath = join(qlbDir, 'auto.log');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  mkdirSync(qlbDir, { recursive: true, mode: 0o700 });
  chmodSync(qlbDir, 0o700);
  try {
    let descriptor: number;
    try {
      const logStats = lstatSync(logPath);
      if (!logStats.isFile()) throw new Error('auto.log must be a regular file');
      descriptor = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        fchmodSync(descriptor, 0o600);
      } finally {
        closeSync(descriptor);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      descriptor = openSync(
        logPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(descriptor);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to secure auto.log: ${detail}`);
  }
  atomicWriteText(target, renderAutoLaunchAgent(process.execPath, home, cliPath), { mode: 0o600 });
  return target;
}

function receipt(result: AutoRunResult, json: boolean): string {
  return json
    ? JSON.stringify(result)
    : `ticks=${result.ticks} decisions=${JSON.stringify(result.decisions)} executed=${JSON.stringify(result.executed)}`;
}

/** `qlb auto [--once] [--dry-run] [--json]` runs the loop; `install-agent` installs its LaunchAgent. */
export async function runAutoCommand(
  args: string[],
  ctx: CommandContext,
  deps: AutoCommandDeps = defaultDeps,
): Promise<number> {
  if (args[0] === 'install-agent') {
    if (args.length !== 1) {
      ctx.stderr('usage: qlb auto install-agent');
      return 2;
    }
    if (ctx.env.QLB_TEST_MODE === '1' && !ctx.env.QLB_HOME) {
      ctx.stderr('qlb auto install-agent: QLB_HOME is required when QLB_TEST_MODE=1');
      return 2;
    }
    try {
      const target = installAutoLaunchAgent(ctx);
      ctx.stdout(`installed ${target}`);
      return 0;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.stderr(`qlb auto install-agent: ${detail}`);
      return 1;
    }
  }

  const options = parse(args);
  if (!options) {
    ctx.stderr('usage: qlb auto [--once] [--dry-run] [--json] | qlb auto install-agent');
    return 2;
  }

  const lockPath = join(ctx.home, '.qlb', 'locks', 'auto.lock');
  if (!options.dryRun) mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lease = options.dryRun ? null : await deps.acquireFlock(lockPath);
  if (!options.dryRun && lease === null) {
    ctx.stderr('qlb auto: auto-already-running');
    return 3;
  }

  try {
    const result = await deps.runAuto(options, {
      env: ctx.env, home: ctx.home, config: ctx.config, log: ctx.stderr,
      stopWhen: lease?.lost, stopIf: lease?.isLost,
    });
    ctx.stdout(receipt(result, options.json));
    return 0;
  } catch (error) {
    if (error instanceof AutoAdmissionRefused) {
      ctx.stderr(`qlb auto: refused: ${error.code}`);
      return 3;
    }
    throw error;
  } finally {
    await lease?.();
  }
}

const command: CommandDefinition = { name: 'auto', execute: runAutoCommand };
export default command;
