import { platformKeychain } from '../keychain';
import { defaultPiMigratePaths, migratePiSingleProvider, type PiSingleProvider } from '../pi-migrate';
import { openStore } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

function parse(args: string[]): { provider: PiSingleProvider; dryRun: boolean; json: boolean } | null {
  const [provider, ...flags] = args;
  if (provider !== 'xai' && provider !== 'kimi-coding' && provider !== 'openrouter') return null;
  if (flags.some((flag) => flag !== '--dry-run' && flag !== '--json')) return null;
  return { provider, dryRun: flags.includes('--dry-run'), json: flags.includes('--json') };
}

async function execute(args: string[], ctx: CommandContext): Promise<number> {
  const opts = parse(args);
  if (!opts) {
    ctx.stderr('usage: qlb pi migrate xai|kimi-coding|openrouter [--dry-run] [--json]');
    return 2;
  }
  const paths = defaultPiMigratePaths(ctx.home);
  const store = openStore(ctx.config.dbPath);
  try {
    const result = migratePiSingleProvider(opts.provider, paths, { keychain: platformKeychain, store }, { dryRun: opts.dryRun });
    if (opts.json) ctx.stdout(JSON.stringify(result));
    else ctx.stdout(`${result.provider}: ${result.state}`);
    return 0;
  } finally {
    store.close();
  }
}

const command: CommandDefinition = { name: 'pi migrate', execute };
export default command;
