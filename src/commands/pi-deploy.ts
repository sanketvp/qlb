import { qlbHomeDir } from '../home';
import { deployPiExtension, piReleaseAppDir } from '../pi-deploy';
import type { CommandContext, CommandDefinition } from '../registry';

export interface PiDeployCommandDeps {
  deploy: typeof deployPiExtension;
  appDirFor: (home: string, env: NodeJS.ProcessEnv) => string;
}

function parseArgs(args: string[]): { dryRun: boolean; json: boolean } | null {
  const seen = new Set<string>();
  for (const arg of args) {
    if ((arg !== '--dry-run' && arg !== '--json') || seen.has(arg)) return null;
    seen.add(arg);
  }
  return { dryRun: seen.has('--dry-run'), json: seen.has('--json') };
}

/** Executing registry fragment for `qlb pi deploy [--dry-run] [--json]`. */
export function runPiDeployCommand(
  args: string[],
  ctx: CommandContext,
  deps: PiDeployCommandDeps = {
    deploy: deployPiExtension,
    appDirFor: piReleaseAppDir,
  },
): number {
  const parsed = parseArgs(args);
  if (!parsed) {
    ctx.stderr('qlb pi deploy: expected [--dry-run] [--json]');
    return 2;
  }
  const home = qlbHomeDir(ctx.env);
  try {
    const result = deps.deploy({
      home,
      appDir: deps.appDirFor(home, ctx.env),
      dbPath: ctx.config.dbPath,
      dryRun: parsed.dryRun,
    });
    if (parsed.json) {
      ctx.stdout(JSON.stringify({
        source: result.source,
        target: result.target,
        hash: result.hash,
        dryRun: result.dryRun,
      }));
    } else if (result.dryRun) {
      ctx.stdout(`would deploy ${result.hash} from ${result.source} to ${result.target}`);
    } else {
      ctx.stdout(`deployed ${result.hash} from ${result.source} to ${result.target}`);
    }
    return 0;
  } catch (err) {
    ctx.stderr(`qlb pi deploy: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const command: CommandDefinition = {
  name: 'pi deploy',
  execute: runPiDeployCommand,
};

export default command;
