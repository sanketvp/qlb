import { unavailableCswapAgent, type CswapAgent } from '../cswap-agent';
import {
  abortCutoverBegin,
  assertAdmitted,
  beginCutover,
  completeCutoverBegin,
  commitCutover,
  CUTOVER_BEGIN_IN_PROGRESS,
  phase,
} from '../lifecycle';
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
    const admission = assertAdmitted(store, 'cutover-begin');
    if (!admission.ok) return { ok: false, code: admission.code, state: admission.row!.state };

    let row;
    try {
      row = beginCutover(store, Date.now(), CUTOVER_BEGIN_IN_PROGRESS);
    } catch (err) {
      // The partial unique index is the cross-process backstop after admission.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('SQLITE_CONSTRAINT')) throw err;
      const current = phase(store);
      return { ok: false, code: `phase=${current.state}`, state: current.state };
    }

    let failureCode: string | undefined;
    try {
      for (const operation of [agent.bootout, agent.disable, agent.movePlist]) {
        const result = await operation.call(agent);
        if (result.ok) continue;
        failureCode = result.code ?? 'cswap-agent-failed';
        break;
      }
      // K13's existing injection fakes predate S57. The production stub has a
      // drain and fails closed; the optional call keeps those narrow unit fakes
      // focused on their launch-agent seam.
      if (failureCode == null && agent.drain != null) {
        const result = await agent.drain();
        if (!result.ok) failureCode = result.code ?? 'cswap-agent-failed';
      }
    } catch (err) {
      failureCode = err instanceof Error ? err.message : String(err);
    }
    if (failureCode == null) {
      const completed = completeCutoverBegin(store, row.id);
      return completed.ok
        ? { ok: true, state: completed.row!.state }
        : { ok: false, code: completed.code, state: completed.row!.state };
    }

    // restorePlist is the compensation for every successful preceding step and
    // also covers a move that threw after its rename. The in-progress marker
    // remains if restoration fails, so commit cannot claim a possibly restored
    // external state.
    let restored = false;
    try { restored = (await agent.restorePlist()).ok; } catch { /* recorded below */ }
    if (restored) {
      const aborted = abortCutoverBegin(store, row.id, failureCode);
      if (aborted.ok) return { ok: false, code: failureCode, state: 'aborted' };
      return { ok: false, code: aborted.code, state: aborted.row!.state };
    }
    return { ok: false, code: 'cswap-restore-failed', state: phase(store).state };
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
