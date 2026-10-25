import { platformKeychain } from '../keychain';
import { qlbHomeDir } from '../home';
import { defaultPiMigratePaths, rollbackPiSingleProvider, type PiSingleProvider } from '../pi-migrate';
import { openStore } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

function provider(args: string[]): PiSingleProvider | null {
  if (args.length !== 1) return null;
  return args[0] === 'xai' || args[0] === 'kimi-coding' || args[0] === 'openrouter' ? args[0] : null;
}

async function execute(args: string[], ctx: CommandContext): Promise<number> {
  const selected = provider(args);
  if (!selected) {
    ctx.stderr('usage: qlb pi rollback xai|kimi-coding|openrouter');
    return 2;
  }
  const store = openStore(ctx.config.dbPath);
  try {
    rollbackPiSingleProvider(selected, defaultPiMigratePaths(qlbHomeDir(), ctx.config.piAuthJsonPath), { keychain: platformKeychain, store });
    ctx.stdout(`${selected}: rolled back`);
    return 0;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'pi-auth-locked') {
      ctx.stderr('pi-auth-locked');
      return 3;
    }
    throw error;
  } finally {
    store.close();
  }
}

const command: CommandDefinition = { name: 'pi rollback', execute };
export default command;
