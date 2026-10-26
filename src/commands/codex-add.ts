import { addCodexAccount, productionCodexAddDeps } from '../codex-add';
import { platformKeychain } from '../keychain';
import { assertAdmitted } from '../lifecycle';
import type { CommandContext, CommandDefinition } from '../registry';
import { openStore, type Store } from '../store';

export interface CodexAddCommandDeps {
  openStore: (path: string) => Store;
  add: typeof addCodexAccount;
  productionDeps: typeof productionCodexAddDeps;
}

function parse(args: string[]): { replace?: string } | null {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--replace' && args[1]!.length > 0) return { replace: args[1] };
  return null;
}

/** Executing registry fragment for `qlb codex add [--replace <id>]`. */
export async function runCodexAddCommand(
  args: string[],
  ctx: CommandContext,
  deps: CodexAddCommandDeps = {
    openStore,
    add: addCodexAccount,
    productionDeps: productionCodexAddDeps,
  },
): Promise<number> {
  const parsed = parse(args);
  if (!parsed) {
    ctx.stderr('usage: qlb codex add [--replace <id>]');
    return 2;
  }

  const store = deps.openStore(ctx.config.dbPath);
  try {
    const admission = assertAdmitted(store, 'codex-add');
    if (!admission.ok) {
      ctx.stderr(`codex add refused: ${admission.code}`);
      return 3;
    }
    const result = await deps.add({
      home: ctx.home,
      nativeAuthPath: ctx.config.codexAuthJsonPath,
      replace: parsed.replace,
    }, deps.productionDeps(store, platformKeychain, ctx.env));
    ctx.stdout(result.added ? `added ${result.slotId}` : `replaced ${result.slotId}`);
    return 0;
  } finally {
    store.close();
  }
}

const command: CommandDefinition = { name: 'codex add', execute: runCodexAddCommand };
export default command;
