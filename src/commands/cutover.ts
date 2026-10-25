import { DatabaseSync } from 'node:sqlite';

import { unavailableCswapAgent, type CswapAgent } from '../cswap-agent';
import { beginCutover, commitCutover, phase } from '../lifecycle';
import { openStore } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

function json(ctx: CommandContext, value: unknown): void {
  ctx.stdout(JSON.stringify(value));
}

function parseBeginArgs(args: string[]): { json: boolean; dryRun: boolean } | null {
  const allowed = new Set(['--json', '--dry-run']);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length) return null;
  return { json: args.includes('--json'), dryRun: args.includes('--dry-run') };
}

function parseJson(args: string[]): boolean {
  return args.length === 1 && args[0] === '--json';
}

/** Exported for AC49's injected C-swap-agent fake. */
export async function cutoverBegin(storePath: string, agent: CswapAgent = unavailableCswapAgent): Promise<{ ok: boolean; code?: string; state: string }> {
  const store = openStore(storePath);
  try {
    const row = beginCutover(store);
    for (const operation of [agent.bootout, agent.disable, agent.movePlist]) {
      const result = await operation.call(agent);
      if (result.ok) continue;
      // Idempotent restoration covers a move that failed after its rename.
      await agent.restorePlist();
      // The K13 stub must not leave an apparently-safe cutting-over state.
      const db = new DatabaseSync(store.dbPath);
      try {
        db.prepare("UPDATE lifecycle SET state = 'aborted', rollback_at = ?, pre_fence_state = 'cutting-over' WHERE id = ?")
          .run(Date.now(), row.id);
      } finally { db.close(); }
      return { ok: false, code: result.code ?? 'cswap-agent-failed', state: 'aborted' };
    }
    return { ok: true, state: row.state };
  } finally { store.close(); }
}

async function execute(args: string[], ctx: CommandContext): Promise<number> {
  const [subcommand, ...rest] = args;
  const beginArgs = subcommand === 'begin' ? parseBeginArgs(rest) : null;
  if (subcommand === 'begin' && beginArgs) {
    if (beginArgs.dryRun) {
      const store = openStore(ctx.config.dbPath);
      try {
        const current = phase(store);
        const result = { ok: current.state === 'pre-cutover', phase: current.state, wouldBegin: current.state === 'pre-cutover' };
        if (beginArgs.json) json(ctx, result);
        else ctx.stderr(result.ok ? 'cutover begin dry-run: preconditions pending later slices' : `cutover begin refused: phase=${current.state}`);
        return result.ok ? 0 : 3;
      } finally { store.close(); }
    }
    const result = await cutoverBegin(ctx.config.dbPath);
    if (beginArgs.json) json(ctx, result);
    else ctx.stderr(result.ok ? 'cutover begin admitted' : `cutover begin refused: ${result.code}`);
    return result.ok ? 0 : 3;
  }
  if (subcommand === 'commit' && (rest.length === 0 || parseJson(rest))) {
    const store = openStore(ctx.config.dbPath);
    try {
      const result = commitCutover(store);
      if (rest[0] === '--json') json(ctx, { ...result, state: phase(store).state });
      else ctx.stderr(result.ok ? 'cutover committed' : `cutover commit refused: ${result.code}`);
      return result.ok ? 0 : 3;
    } finally { store.close(); }
  }
  if (subcommand === 'abort' && (rest.length === 0 || parseJson(rest))) {
    const store = openStore(ctx.config.dbPath);
    try {
      const current = phase(store);
      if (current.state !== 'cutting-over') {
        if (rest[0] === '--json') json(ctx, { ok: false, code: `phase=${current.state}` });
        else ctx.stderr(`cutover abort refused: phase=${current.state}`);
        return 3;
      }
      // K12 owns the fence/drain/undo engine; refusing is safer than a partial abort.
      if (rest[0] === '--json') json(ctx, { ok: false, code: 'not-yet-available' });
      else ctx.stderr('cutover abort refused: not-yet-available');
      return 3;
    } finally { store.close(); }
  }
  ctx.stderr('usage: qlb cutover begin|commit|abort [--json]');
  return 2;
}

const command: CommandDefinition = { name: 'cutover', execute };
export default command;
