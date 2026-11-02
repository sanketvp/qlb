import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AutoAdmissionRefused, runAuto, type AutoDependencies, type AutoRunResult, type RunAutoOptions } from '../auto';

import { productionTryAcquireLock, type CswapLockRelease } from '../cswap-agent';
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
  return { once: args.includes('--once'), dryRun: args.includes('--dry-run'), json: args.includes('--json') };
}

function receipt(result: AutoRunResult, json: boolean): string {
  return json
    ? JSON.stringify(result)
    : `ticks=${result.ticks} decisions=${JSON.stringify(result.decisions)} executed=${JSON.stringify(result.executed)}`;
}

/** `qlb auto [--once] [--dry-run] [--json]`: run the single Anthropic auto loop. */
export async function runAutoCommand(
  args: string[],
  ctx: CommandContext,
  deps: AutoCommandDeps = defaultDeps,
): Promise<number> {
  const options = parse(args);
  if (!options) {
    ctx.stderr('usage: qlb auto [--once] [--dry-run] [--json]');
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
