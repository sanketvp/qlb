import { join } from 'node:path';
import { ClaudeSlots, SqliteClaudeSlotRepository, type RestoreUnclaimedResult } from '../cc-slots';
import { qlbHomeDir } from '../home';
import { platformKeychain } from '../keychain';
import type { CommandContext, CommandDefinition } from '../registry';
import { openStore } from '../store';

export interface ClaudeRestoreUnclaimedDeps {
  restore: (timestamp: string, slot: string) => Promise<RestoreUnclaimedResult | void>;
}

function defaultDeps(ctx: CommandContext): ClaudeRestoreUnclaimedDeps {
  // Open through Store first so its migration owns schema setup. The slot
  // adapter then opens its short-lived connection to the same injected db.
  const store = openStore(ctx.config.dbPath);
  store.close();
  const repository = SqliteClaudeSlotRepository.open(ctx.config.dbPath);
  const slots = new ClaudeSlots({
    backend: platformKeychain,
    repository,
    stashDir: join(qlbHomeDir(ctx.env), '.qlb', 'unclaimed'),
  });
  return {
    async restore(timestamp: string, slot: string): Promise<void> {
      try {
        await slots.restoreUnclaimed(timestamp, slot);
      } finally {
        repository.close();
      }
    },
  };
}

/** `qlb claude restore-unclaimed <timestamp> <slot>` (S36 / AC48). */
export async function runClaudeRestoreUnclaimedCommand(
  args: string[],
  ctx: CommandContext,
  deps?: ClaudeRestoreUnclaimedDeps,
): Promise<number> {
  if (args.length !== 2 || !args[0] || /[\0/\\]/.test(args[0]) || !args[1] || /[\0/\\:]/.test(args[1])) {
    ctx.stderr('qlb claude restore-unclaimed: expected <timestamp> <slot>');
    return 2;
  }
  const [timestamp, slot] = args;
  try {
    const result = await (deps ?? defaultDeps(ctx)).restore(timestamp, slot);
    ctx.stdout(`restored unclaimed credential to ${slot}`);
    if (result?.cleanupPending) ctx.stderr('qlb claude restore-unclaimed: warning: stash cleanup pending');
    return 0;
  } catch (error) {
    // The slot module deliberately uses non-secret messages; do not include
    // any backend stdout/stderr or credential bytes here.
    ctx.stderr(`qlb claude restore-unclaimed: ${error instanceof Error ? error.message : 'failed'}`);
    return 3;
  }
}

const command: CommandDefinition = {
  name: 'claude restore-unclaimed',
  execute: runClaudeRestoreUnclaimedCommand,
};

export default command;
