import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AutoAdmissionRefused, runAuto, type AutoDependencies, type AutoRunResult, type RunAutoOptions } from '../auto';

import { productionTryAcquireLock, type CswapLockRelease } from '../cswap-agent';
import { atomicWriteText } from '../fsutil';
import { assertAdmitted, markDrillBegan } from '../lifecycle';
import type { CommandContext, CommandDefinition } from '../registry';
import { openStore } from '../store';

type AutoCommandOptions = RunAutoOptions & { json: boolean };

export interface AutoCommandDeps {
  runAuto: (options: RunAutoOptions, dependencies: AutoDependencies) => Promise<AutoRunResult>;
  acquireFlock(lockPath: string): Promise<CswapLockRelease | null>;
  /** Platform seam for drill-begin; absent in test mode so tests cannot boot the real agent. */
  exec?: (file: string, args: string[], options: { stdio: ['ignore', 'pipe', 'ignore']; timeout: number }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultDeps: AutoCommandDeps = { runAuto, acquireFlock: productionTryAcquireLock };

function parse(args: string[]): AutoCommandOptions | null {
  const known = new Set(['--once', '--dry-run', '--json']);
  if (args.some((arg) => !known.has(arg)) || new Set(args).size !== args.length) return null;
  return {
    once: args.includes('--once'), dryRun: args.includes('--dry-run'), json: args.includes('--json'),
  };
}

function parseResume(args: string[]): { provider: string; json: boolean } | null {
  const [provider, ...flags] = args;
  if (!provider || flags.some((flag) => flag !== '--json') || new Set(flags).size !== flags.length) return null;
  return { provider, json: flags.includes('--json') };
}

function resumeAnthropic(ctx: CommandContext, args: string[]): number {
  const options = parseResume(args);
  if (!options) {
    ctx.stderr('usage: qlb auto resume anthropic [--json]');
    return 2;
  }
  if (options.provider !== 'anthropic') {
    ctx.stderr('qlb auto resume: provider-not-enabled');
    return 2;
  }

  const store = openStore(ctx.config.dbPath);
  try {
    const admission = assertAdmitted(store, 'auto:resume');
    if (!admission.ok) {
      ctx.stderr(`qlb auto resume: refused: ${admission.code}`);
      return 3;
    }
    const resumed = store.runImmediate(() => {
      const suspendedUntil = store.getConfig('auto.anthropic.suspendedUntil');
      store.setConfig('auto.anthropic.lastResumeAt', String(Date.now()));
      if (suspendedUntil !== null && suspendedUntil !== '') store.setConfig('auto.anthropic.suspendedUntil', '');
      return suspendedUntil;
    });
    const cleared = resumed !== null && resumed !== '';
    const suspendedUntil = cleared ? new Date(Number(resumed)).toISOString() : null;
    if (options.json) {
      ctx.stdout(JSON.stringify({ provider: 'anthropic', resumed: cleared, suspendedUntil }));
    } else if (cleared) {
      ctx.stdout(`resumed anthropic (suspended until ${suspendedUntil} cleared)`);
    } else {
      ctx.stdout('nothing to resume');
    }
    return 0;
  } finally {
    store.close();
  }
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

type BootoutResult = { ok: true } | { ok: false; code: string };

function bootoutAutoAgent(ctx: CommandContext, deps: AutoCommandDeps): BootoutResult {
  const exec = deps.exec ?? (ctx.env.QLB_TEST_MODE === '1' ? undefined : execFileSync);
  if (!exec) return { ok: false, code: 'exec-seam-required' };
  try {
    const uid = process.getuid?.() ?? 0;
    exec('/bin/launchctl', ['bootout', `gui/${uid}/com.modus.qlb-auto`], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    });
    return { ok: true };
  } catch (error) {
    const record = error as { code?: unknown; status?: unknown } | undefined;
    const code = typeof record?.code === 'string' ? record.code : 'bootout-failed';
    // launchctl reports a missing job as status 3; some exec seams surface it
    // as ESRCH or ENOENT instead. All mean the agent is already out.
    if (code === 'ESRCH' || code === 'ENOENT' || record?.status === 3) return { ok: true };
    if (code === 'ETIMEDOUT') return { ok: false, code: 'bootout-timeout' };
    return { ok: false, code };
  }
}

async function autoLockIsFree(lockPath: string, deps: AutoCommandDeps): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 60_000;
  for (;;) {
    try {
      const lease = await deps.acquireFlock(lockPath);
      if (lease !== null) {
        await lease();
        return true;
      }
    } catch {
      // A failed probe is indeterminate, so fail closed as if the lock were held.
    }
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(1_000, remaining));
  }
}

async function drillBegin(ctx: CommandContext, args: string[], deps: AutoCommandDeps): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    ctx.stderr('usage: qlb auto drill-begin [--json]');
    return 2;
  }
  // This must precede even opening the store: test-mode command paths must
  // never accidentally reach a real platform process.
  if (ctx.env.QLB_TEST_MODE === '1' && !deps.exec) {
    ctx.stderr('qlb auto drill-begin: refused: exec-seam-required');
    return 3;
  }

  const store = openStore(ctx.config.dbPath);
  try {
    const admission = assertAdmitted(store, 'auto:drill-begin');
    if (!admission.ok) {
      ctx.stderr(`qlb auto drill-begin: refused: ${admission.code}`);
      return 3;
    }
    if (admission.row!.drillBeganAt != null && admission.row!.drillDoneAt == null) {
      ctx.stderr('qlb auto drill-begin: refused: drill-already-begun');
      return 3;
    }

    const bootout = bootoutAutoAgent(ctx, deps);
    if (!bootout.ok) {
      ctx.stderr(`qlb auto drill-begin: refused: ${bootout.code}`);
      return 3;
    }

    const lockPath = join(ctx.home, '.qlb', 'locks', 'auto.lock');
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    if (!await autoLockIsFree(lockPath, deps)) {
      ctx.stderr('qlb auto drill-begin: refused: auto-lock-still-held');
      return 3;
    }

    const result = markDrillBegan(store, (deps.now ?? Date.now)());
    if (!result.ok) {
      ctx.stderr(`qlb auto drill-begin: refused: ${result.code}`);
      return 3;
    }
    if (args[0] === '--json') ctx.stdout(JSON.stringify(result.row));
    else ctx.stdout('auto drill began');
    return 0;
  } finally {
    store.close();
  }
}

/** `qlb auto [--once] [--dry-run] [--json]` runs the loop; `install-agent` installs its LaunchAgent. */
export async function runAutoCommand(
  args: string[],
  ctx: CommandContext,
  deps: AutoCommandDeps = defaultDeps,
): Promise<number> {
  if (args[0] === 'resume') return resumeAnthropic(ctx, args.slice(1));
  if (args[0] === 'drill-begin') return drillBegin(ctx, args.slice(1), deps);

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
    ctx.stderr('usage: qlb auto [--once] [--dry-run] [--json] | qlb auto install-agent | qlb auto resume anthropic [--json] | qlb auto drill-begin [--json]');
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
