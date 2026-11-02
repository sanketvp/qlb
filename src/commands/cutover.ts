import { join } from 'node:path';

import { productionLaunchctlCswapAgent, unavailableCswapAgent, type CswapAgent } from '../cswap-agent';
import { runUndoCswapCommand, type UndoCswapCommandDependencies } from './undo-cswap';
import {
  abortCutoverBegin,
  assertAdmitted,
  beginCutover,
  completeCutoverBegin,
  commitCutover,
  CUTOVER_BEGIN_IN_PROGRESS,
  phase,
} from '../lifecycle';
import { qlbHomeDir } from '../home';
import { currentReleaseSha, readReleaseManifest } from '../release';
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

function parseCommitArgs(args: string[]): { json: boolean; piDeferred: boolean } | null {
  const allowed = new Set(['--json', '--pi-deferred']);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length) return null;
  return { json: args.includes('--json'), piDeferred: args.includes('--pi-deferred') };
}

function currentReleaseManifestSha(ctx: CommandContext): string | undefined {
  const appDir = ctx.env.QLB_TEST_MODE === '1' && ctx.env.QLB_HOME
    ? join(ctx.env.QLB_HOME, 'app')
    : join(ctx.home, '.qlb', 'app');
  const current = currentReleaseSha(appDir);
  return current == null ? undefined : readReleaseManifest(join(appDir, current))?.sha;
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
      if (failureCode == null) {
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

export interface CutoverCommandDeps {
  /** Tests replace the S57 C-swap agent before the command begins its transaction. */
  makeAgent?: (ctx: CommandContext) => CswapAgent;
  /** G18's hand-back seams; tests inject every process and plist effect. */
  undoCswap?: UndoCswapCommandDependencies;
}

function defaultMakeAgent(ctx: CommandContext): CswapAgent {
  // Tests must never construct the adapter that can invoke launchctl.
  if (process.env.QLB_TEST_MODE === '1' || ctx.env.QLB_TEST_MODE === '1') return unavailableCswapAgent;
  return productionLaunchctlCswapAgent(ctx.home, qlbHomeDir(ctx.env), ctx.config.cswapSequencePath);
}

async function execute(args: string[], ctx: CommandContext, deps: CutoverCommandDeps): Promise<number> {
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
    const result = await cutoverBegin(ctx.config.dbPath, (deps.makeAgent ?? defaultMakeAgent)(ctx));
    if (beginArgs.json) json(ctx, result);
    else ctx.stderr(result.ok ? 'cutover begin admitted' : `cutover begin refused: ${result.code}`);
    return result.ok ? 0 : 3;
  }
  const commitArgs = subcommand === 'commit' ? parseCommitArgs(rest) : null;
  if (subcommand === 'commit' && commitArgs) {
    const store = openStore(ctx.config.dbPath);
    try {
      const result = commitCutover(store, {
        piDeferred: commitArgs.piDeferred,
        releaseSha: currentReleaseManifestSha(ctx),
      });
      if (commitArgs.json) json(ctx, { ...result, state: phase(store).state });
      else ctx.stderr(result.ok ? 'cutover committed' : `cutover commit refused: ${result.code}`);
      return result.ok ? 0 : 3;
    } finally { store.close(); }
  }
  if (subcommand === 'abort' && (rest.length === 0 || parseJson(rest))) {
    // The CLI admission normally owns this guard; retain the complete policy
    // (including cutover-begin's in-progress fence) for direct callers.
    const store = openStore(ctx.config.dbPath);
    try {
      const admission = assertAdmitted(store, 'cutover-abort');
      if (!admission.ok) {
        const code = admission.code ?? `phase=${phase(store).state}`;
        if (rest[0] === '--json') json(ctx, { ok: false, code });
        else ctx.stderr(`cutover abort refused: ${code}`);
        return 3;
      }
    } finally { store.close(); }
    return runUndoCswapCommand(rest, ctx, {
      ...deps.undoCswap,
      cswapAgent: deps.undoCswap?.cswapAgent ?? (deps.makeAgent ?? defaultMakeAgent)(ctx),
    });
  }
  ctx.stderr('usage: qlb cutover begin|commit [--pi-deferred] [--json]|abort [--json]');
  return 2;
}

/** `qlb cutover begin|commit|abort [--json]` (AC49). */
export function createCutoverCommand(deps: CutoverCommandDeps = {}): CommandDefinition {
  return { name: 'cutover', execute: (args, ctx) => execute(args, ctx, deps) };
}

const command = createCutoverCommand();
export default command;
