import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AutoAdmissionRefused, runAuto, type AutoDependencies, type AutoRunResult, type RunAutoOptions } from '../auto';
import type { CommandContext, CommandDefinition } from '../registry';

type AutoCommandOptions = RunAutoOptions & { json: boolean };

type FlockLease = { release(): Promise<void> };

export interface AutoCommandDeps {
  runAuto: (options: RunAutoOptions, dependencies: AutoDependencies) => Promise<AutoRunResult>;
  acquireFlock(lockPath: string, env: NodeJS.ProcessEnv): Promise<FlockLease | null>;
}

const FLOCK_HOLDER = String.raw`
import fcntl, os, sys
lock = sys.argv[1]
os.makedirs(os.path.dirname(lock), mode=0o700, exist_ok=True)
fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.stdout.write("busy\n")
    sys.stdout.flush()
    sys.exit(75)
sys.stdout.write("held\n")
sys.stdout.flush()
sys.stdin.buffer.read()
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
`;

/**
 * Hold a real advisory flock in a small owned helper for the lifetime of the
 * Node command. The lock file is intentionally retained after release.
 */
export function acquireAutoFlock(lockPath: string, env: NodeJS.ProcessEnv): Promise<FlockLease | null> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const child = spawn('/usr/bin/python3', ['-c', FLOCK_HOLDER, lockPath], {
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const complete = (lease: FlockLease | null): void => {
      if (settled) return;
      settled = true;
      resolve(lease);
    };
    let response = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      const status = response.slice(0, newline);
      if (status === 'busy') complete(null);
      else if (status === 'held') {
        complete({
          release: () => new Promise<void>((release) => {
            if (child.exitCode !== null) return release();
            child.once('exit', () => release());
            child.stdin.end();
          }),
        });
      } else fail(new Error('auto lock helper returned an invalid status'));
    });
    child.once('error', (error) => fail(new Error(`cannot start auto lock helper: ${error.message}`)));
    child.once('exit', (code) => {
      if (!settled) fail(new Error(`auto lock helper exited before acquiring the lock (${code ?? 'signal'})`));
    });
  });
}

const defaultDeps: AutoCommandDeps = { runAuto, acquireFlock: acquireAutoFlock };

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
  const lease = options.dryRun ? null : await deps.acquireFlock(lockPath, ctx.env);
  if (!options.dryRun && lease === null) {
    ctx.stderr('qlb auto: auto-already-running');
    return 3;
  }

  try {
    const result = await deps.runAuto(options, { env: ctx.env, home: ctx.home, config: ctx.config, log: ctx.stderr });
    ctx.stdout(receipt(result, options.json));
    return 0;
  } catch (error) {
    if (error instanceof AutoAdmissionRefused) {
      ctx.stderr(`qlb auto: refused: ${error.code}`);
      return 3;
    }
    throw error;
  } finally {
    await lease?.release();
  }
}

const command: CommandDefinition = { name: 'auto', execute: runAutoCommand };
export default command;
