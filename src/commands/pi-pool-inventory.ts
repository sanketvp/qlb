import { readFileSync } from 'node:fs';
import { platformKeychain } from '../keychain';
import {
  classify,
  readCswapInventoryLineages,
  readPoolInventoryEntries,
  recordPoolInventoryForPiMigrate,
  slotInventoryLineages,
  type PoolInventoryEntry,
  type PoolInventoryStore,
  type SourceLineage,
} from '../pool-inventory';
import { assertAdmitted } from '../lifecycle';
import { openStore, type PiExportTargetRow, type Store } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

export interface PoolInventoryCommandStore extends PoolInventoryStore {
  close(): void;
  listPiExportTargets(provider: string): PiExportTargetRow[];
  listAnthropicSlotLineageChains(): Array<{ accountId: string; lineages: string[] }>;
}

export interface PiPoolInventoryCommandDeps {
  openStore(dbPath: string): PoolInventoryCommandStore;
  loadEntries(path: string): PoolInventoryEntry[];
  loadCswapLineages(sequencePath: string): SourceLineage[];
  loadSlotLineages(store: PoolInventoryCommandStore): SourceLineage[];
  /** Writing uses pi-migrate's lifecycle admission until it is called in-process by migration. */
  admitRecord(store: PoolInventoryCommandStore): { ok: boolean; code?: string };
  now(): number;
}

const defaultDeps: PiPoolInventoryCommandDeps = {
  openStore,
  loadEntries: (path) => readPoolInventoryEntries(path, readFileSync),
  loadCswapLineages: (path) => readCswapInventoryLineages(path, platformKeychain, readFileSync),
  loadSlotLineages: (store) => slotInventoryLineages(store as Pick<Store, 'listAnthropicSlotLineageChains'>),
  admitRecord: (store) => assertAdmitted(store as unknown as Store, 'pi-migrate'),
  now: Date.now,
};

function parse(args: string[]): { against: 'cswap' | 'slots'; json: boolean; record: boolean } | null {
  let against: 'cswap' | 'slots' = 'cswap';
  let againstSet = false;
  let json = false;
  let record = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    if (arg === '--record' && !record) {
      record = true;
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
  if (record && against !== 'slots') return null;
  return { against, json, record };
}

/** `qlb pi pool-inventory [--against cswap|slots] [--record] [--json]`. */
export function runPiPoolInventoryCommand(
  args: string[],
  ctx: CommandContext,
  deps: PiPoolInventoryCommandDeps = defaultDeps,
): number {
  const options = parse(args);
  if (!options) {
    ctx.stderr('usage: qlb pi pool-inventory [--against cswap|slots] [--record] [--json]');
    return 2;
  }

  // X1's default C-swap comparison must not even open the QLB store: opening
  // SQLite can create WAL state, which violates the rehearsal's no-mutation rule.
  if (options.against === 'cswap') {
    try {
      const result = classify(deps.loadEntries(ctx.config.anthropicPoolPath), deps.loadCswapLineages(ctx.config.cswapSequencePath), deps.now());
      const output = { against: options.against, entries: result.entries };
      if (options.json) ctx.stdout(JSON.stringify(output));
      else ctx.stdout(`${result.entries.length} pool entries; ${result.targets.length} shared lineages`);
      return 0;
    } catch {
      ctx.stderr('qlb pi pool-inventory: inventory unavailable');
      return 1;
    }
  }

  const store = deps.openStore(ctx.config.dbPath);
  try {
    const entries = deps.loadEntries(ctx.config.anthropicPoolPath);
    const lineages = deps.loadSlotLineages(store);
    const result = classify(entries, lineages, deps.now());
    if (options.record) {
      const admission = deps.admitRecord(store);
      if (!admission.ok) {
        ctx.stderr(`qlb pi pool-inventory: refused: ${admission.code ?? 'lifecycle-refused'}`);
        return 3;
      }
      // An operator-facing command never overwrites migrate's durable fact.
      // The dedicated migration helper above is the only replacement path.
      if (store.listPiExportTargets('anthropic').length !== 0) {
        ctx.stderr('qlb pi pool-inventory: inventory unavailable');
        return 1;
      }
      recordPoolInventoryForPiMigrate({ entries, lineages, store, now: deps.now });
    }
    const output = { against: options.against, entries: result.entries };
    if (options.json) ctx.stdout(JSON.stringify(output));
    else ctx.stdout(`${result.entries.length} pool entries; ${result.targets.length} shared lineages`);
    return 0;
  } catch {
    // Never surface filesystem/Keychain diagnostics here: either can contain a
    // native value. The command dispatcher performs its normal redaction too.
    ctx.stderr('qlb pi pool-inventory: inventory unavailable');
    return 1;
  } finally {
    store.close();
  }
}

const command: CommandDefinition = { name: 'pi pool-inventory', execute: runPiPoolInventoryCommand };
export default command;
