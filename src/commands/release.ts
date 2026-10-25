import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { installRelease, releaseSourceDir } from '../release';
import type { CommandContext, CommandDefinition } from '../registry';

export interface ReleaseCommandDeps {
  sourceDir: string;
  install: typeof installRelease;
  shaForSource: (sourceDir: string) => string;
}

function defaultShaForSource(sourceDir: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: sourceDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('cannot determine release SHA; pass --sha <sha>');
  }
}

function releaseAppDir(ctx: CommandContext): string {
  // Test mode deliberately redirects the release tree into the disposable QLB root.
  if (ctx.env.QLB_TEST_MODE === '1' && ctx.env.QLB_HOME) return join(ctx.env.QLB_HOME, 'app');
  return join(ctx.home, '.qlb', 'app');
}

function releaseDbPath(ctx: CommandContext): string {
  if (ctx.env.QLB_TEST_MODE === '1' && ctx.env.QLB_HOME) return join(ctx.env.QLB_HOME, 'qlb.db');
  return ctx.config.dbPath;
}

function parseInstallArgs(args: string[], defaultSha: () => string): string | null {
  if (args[0] !== 'install') return null;
  if (args.length === 1) return defaultSha();
  if (args.length === 3 && args[1] === '--sha' && args[2]) return args[2];
  return null;
}

/** Executing registry fragment for `qlb release install [--sha <sha>]`. */
export async function runReleaseCommand(
  args: string[],
  ctx: CommandContext,
  deps: ReleaseCommandDeps = {
    sourceDir: releaseSourceDir(),
    install: installRelease,
    shaForSource: defaultShaForSource,
  },
): Promise<number> {
  const sha = parseInstallArgs(args, () => deps.shaForSource(deps.sourceDir));
  if (!sha) {
    ctx.stderr('qlb release: expected install [--sha <sha>]');
    return 2;
  }
  const result = await deps.install({
    sourceDir: deps.sourceDir,
    appDir: releaseAppDir(ctx),
    sha,
    dbPath: releaseDbPath(ctx),
  });
  ctx.stdout(`installed ${sha} at ${result.releaseDir}`);
  return 0;
}

const command: CommandDefinition = {
  name: 'release',
  execute: runReleaseCommand,
};

export default command;
