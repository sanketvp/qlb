import { join } from 'node:path';

import { platformKeychain } from '../keychain';
import { qlbHomeDir } from '../home';
import { defaultPiMigratePaths, rollbackPiSingleProvider, type PiSingleProvider } from '../pi-migrate';
import { openStore } from '../store';
import { assertAdmitted, retirementLockPath, withRetirementMutationLock } from '../lifecycle';
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
    return await withRetirementMutationLock(retirementLockPath(join(qlbHomeDir(ctx.env), '.qlb')), async () => {
      const admission = assertAdmitted(store, 'pi-rollback');
      if (!admission.ok) {
        ctx.stderr(`qlb pi rollback: refused: ${admission.code}`);
        return 3;
      }
      rollbackPiSingleProvider(selected, defaultPiMigratePaths(qlbHomeDir(ctx.env), ctx.config.piAuthJsonPath), { keychain: platformKeychain, store });
      ctx.stdout(`${selected}: rolled back`);
      return 0;
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'pi-auth-locked' || code === 'retirement-locked') {
      ctx.stderr(code === 'retirement-locked' ? 'retirement-in-progress' : 'pi-auth-locked');
      return 3;
    }
    throw error;
  } finally {
    store.close();
  }
}

const command: CommandDefinition = { name: 'pi rollback', execute };
export default command;
