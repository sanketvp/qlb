import { readFileSync } from 'node:fs';
import { platformKeychain } from '../keychain';
import {
  inventoryPool,
  readCswapInventoryLineages,
  readPoolInventoryEntries,
  slotInventoryLineages,
  type PoolInventoryEntry,
  type PoolInventoryStore,
  type SourceLineage,
} from '../pool-inventory';
import { openStore } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

export interface PoolInventoryCommandStore extends PoolInventoryStore {
  close(): void;
  listAnthropicSlotLineages(): Array<{ accountId: string; fingerprint: string | null }>;
}

export interface PiPoolInventoryCommandDeps {
  openStore(dbPath: string): PoolInventoryCommandStore;
  loadEntries(path: string): PoolInventoryEntry[];
  loadCswapLineages(sequencePath: string): SourceLineage[];
  loadSlotLineages(store: PoolInventoryCommandStore): SourceLineage[];
  now(): number;
}

const defaultDeps: PiPoolInventoryCommandDeps = {
  openStore,
  loadEntries: (path) => readPoolInventoryEntries(path, readFileSync),
  loadCswapLineages: (path) => readCswapInventoryLineages(path, platformKeychain, readFileSync),
  loadSlotLineages: slotInventoryLineages,
  now: Date.now,
};

function parse(args: string[]): { against: 'cswap' | 'slots'; json: boolean } | null {
  let against: 'cswap' | 'slots' = 'cswap';
  let againstSet = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    if (arg === '--against' && !againstSet && index + 1 < args.length && (args[index + 1] === 'cswap' || args[index + 1] === 'slots')) {
      against = args[index + 1] as 'cswap' | 'slots';
      againstSet = true;
      index += 1;
      continue;
    }
    return null;
  }
  return { against, json };
}

/** `qlb pi pool-inventory [--against cswap|slots] [--json]`. */
export function runPiPoolInventoryCommand(
  args: string[],
  ctx: CommandContext,
  deps: PiPoolInventoryCommandDeps = defaultDeps,
): number {
  const options = parse(args);
  if (!options) {
    ctx.stderr('usage: qlb pi pool-inventory [--against cswap|slots] [--json]');
    return 2;
  }

  const store = deps.openStore(ctx.config.dbPath);
  try {
    const entries = deps.loadEntries(ctx.config.anthropicPoolPath);
    const lineages = options.against === 'cswap'
      ? deps.loadCswapLineages(ctx.config.cswapSequencePath)
      : deps.loadSlotLineages(store);
    const result = inventoryPool({ entries, lineages, store, now: deps.now });
    const output = { against: options.against, entries: result.entries };
    if (options.json) ctx.stdout(JSON.stringify(output));
    else ctx.stdout(`${result.entries.length} pool entries; ${result.targets.length} shared lineages`);
    return 0;
  } catch (error) {
    // Never surface filesystem/Keychain diagnostics here: either can contain a
    // native value. The command dispatcher performs its normal redaction too.
    void error;
    ctx.stderr('qlb pi pool-inventory: inventory unavailable');
    return 1;
  } finally {
    store.close();
  }
}

const command: CommandDefinition = { name: 'pi pool-inventory', execute: runPiPoolInventoryCommand };
export default command;
