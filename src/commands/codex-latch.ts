/**
 * `qlb codex latch clear`: the owner's only way past a Codex stop (U11, R5).
 *
 * Before judging the latch it settles what is already decided: recovery
 * reconciliation (which may resolve a fence, or commit an orphaned journal
 * and open a watch), then the due-watch runner (which may record a verdict),
 * then the stop sweep (which records any stop those produced). Only then,
 * under the Codex switch and auth locks, does it decide (KTD16). It never
 * starts a stage: after a clear no run is active until the next stage start.
 * `--initialize` skips the first two steps: on a restored database it must not
 * act on restored recovery or watch state before the owner has initialized.
 */

import { ClaudeCodeLockTimeout } from '../cc-locks';
import { decideLatchClear, deriveLatch, type LatchView } from '../codex-stage';
import { readBuildStamp, sweepCodexStops, toStageLog } from '../codex-stop';
import {
  CODEX_SWITCH_COMMAND_ENABLED,
  codexRecoveryFenceState,
  reconcileCodexRecovery,
  runDueCodexWatches,
  withCodexSwitchLocks,
  type CodexSwitchDeps,
} from '../codex-switch';
import { assertAdmitted } from '../lifecycle';
import { openStore, openStoreConnection, type Store } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';
import { defaultSwitchDeps } from './switch-openai-codex';

export interface CodexLatchDeps {
  store: Store;
  /** The switch engine's deps (locks, journal, slots, clock) that reconciliation and the watch runner use; they get `store` too. */
  switchDeps: Omit<CodexSwitchDeps, 'store'>;
  buildStamp: string | null;
  /** Recorded on each row; a clear does not need the flag, so a dark build can clear a stop. */
  flagEnabled: boolean;
  autoLog?: (line: string) => void;
  reconcile?: (deps: CodexSwitchDeps) => Promise<unknown>;
  runDueWatches?: (deps: CodexSwitchDeps, now: number) => Promise<void>;
}

export type CodexLatchRequest =
  | { kind: 'clear'; throughId: number; reason: string }
  | { kind: 'initialize'; reason: string }
  | { kind: 'probe' };

/**
 * A named refusal: empty-reason, multi-line-reason, not-latched, latch-unknown
 * (detail: why), newer-stop (detail: the newest stop id), open-watch (detail:
 * the latest until, then any fence), fence-set (detail: the fence reason),
 * not-required or codex-lock-busy; a lifecycle refusal passes its admission
 * code through.
 */
export type CodexLatchRefused = { ok: false; reason: string; detail?: string };
export type CodexLatchOutcome =
  | { ok: true; kind: 'clear'; throughId: number; eventId: number }
  | { ok: true; kind: 'initialize'; eventId: number }
  | { ok: true; kind: 'probe'; latch: 'clear' | 'latched' | 'unknown'; newestStopId: number | null; blockers: string[] }
  | CodexLatchRefused;

const refuse = (reason: string, detail?: string): CodexLatchRefused =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

function reasonRefusal(reason: string): CodexLatchRefused | null {
  if (reason.trim() === '') return refuse('empty-reason');
  if (/[\r\n]/.test(reason)) return refuse('multi-line-reason');
  return null;
}

/** The latest open watch's until, as an ISO time (no clear can pass before it), or null with no open watch. */
function openWatchUntil(store: Store): string | null {
  const db = openStoreConnection(store.dbPath, true);
  try {
    const row = db.prepare('SELECT until FROM codex_watch ORDER BY until DESC LIMIT 1').get() as { until: number } | undefined;
    return row === undefined ? null : new Date(row.until).toISOString();
  } finally {
    db.close();
  }
}

interface Blockers {
  latch: LatchView;
  openWatch: string | null;
  fence: string | null;
}

export async function codexLatchClear(deps: CodexLatchDeps, request: CodexLatchRequest): Promise<CodexLatchOutcome> {
  if (request.kind !== 'probe') {
    const bad = reasonRefusal(request.reason);
    if (bad) return bad;
  }
  const store = deps.store;
  const engine: CodexSwitchDeps = { ...deps.switchDeps, store };
  const journalDir = engine.journalDir;
  // Without the journal directory the fence could not be read, and a clear must not pass a fence it cannot see.
  if (!journalDir) throw new Error('codex latch clear requires the switch journal directory');
  const admission = assertAdmitted(store, 'codex-latch-clear');
  if (!admission.ok) return refuse(admission.code ?? 'not-admitted');

  if (request.kind !== 'initialize') {
    // KTD16: settle recovery and due watches first, so a fence or watch that is
    // already decidable does not block the clear, and any stop they produce is
    // recorded by the sweep below before the latch is judged.
    await (deps.reconcile ?? reconcileCodexRecovery)(engine);
    await (deps.runDueWatches ?? runDueCodexWatches)(engine, engine.now());
  }

  return withCodexSwitchLocks(engine, (assertHeld) => {
    const held = assertAdmitted(store, 'codex-latch-clear');
    if (!held.ok) return refuse(held.code ?? 'not-admitted');
    const lifecycleId = held.row?.id ?? null;
    sweepCodexStops({ store, now: engine.now, buildStamp: deps.buildStamp, flagEnabled: deps.flagEnabled, lifecycleId, autoLog: deps.autoLog });
    const log = store.readCodexStageLog();
    const fence = codexRecoveryFenceState(journalDir, store);
    const blockers: Blockers = {
      latch: deriveLatch(toStageLog(log)),
      openWatch: openWatchUntil(store),
      fence: fence.state === 'fenced' ? fence.reason : null,
    };
    // Read under the locks and after the sweep, so the row follows every stop the sweep recorded.
    const row = { now: engine.now(), lifecycleId, buildStamp: deps.buildStamp, flagEnabled: deps.flagEnabled };

    if (request.kind === 'probe') return probe(blockers);

    if (request.kind === 'initialize') {
      if (log.status === 'readable') return refuse('not-required');
      // An unreadable row or missing tables is not something an initialize can settle.
      if (log.reason !== 'initialize-required') return refuse('latch-unknown', log.reason);
      assertHeld();
      const eventId = store.appendCodexStageEvent({ ...row, kind: 'initialize', reason: request.reason });
      if (eventId === null) throw new Error('codex initialize row was not recorded');
      return { ok: true, kind: 'initialize', eventId };
    }

    const decision = decideLatchClear({
      latch: blockers.latch,
      throughId: request.throughId,
      openWatch: blockers.openWatch !== null,
      fenceSet: blockers.fence !== null,
      reason: request.reason,
    });
    if (!decision.ok) {
      switch (decision.refusal) {
        case 'latch-unknown': return refuse('latch-unknown', decision.reason);
        case 'newer-stop': return refuse('newer-stop', String(decision.newestStopId));
        case 'open-watch': {
          // A fence keeps the watch open past its until, so name it too.
          const fence = blockers.fence === null ? '' : `; fence-set: ${blockers.fence}`;
          return refuse('open-watch', `${blockers.openWatch}${fence}`);
        }
        case 'fence-set': return refuse('fence-set', blockers.fence ?? undefined);
        default: return refuse(decision.refusal);
      }
    }
    assertHeld();
    const eventId = store.appendCodexStageEvent({ ...row, kind: 'latch-clear', throughId: request.throughId, reason: request.reason });
    if (eventId === null) throw new Error('codex latch-clear row was not recorded');
    return { ok: true, kind: 'clear', throughId: request.throughId, eventId };
  });
}

function probe(blockers: Blockers): CodexLatchOutcome {
  const { latch } = blockers;
  const found: string[] = [];
  if (latch.state === 'unknown') found.push(`latch-unknown:${latch.reason}`);
  if (blockers.openWatch !== null) found.push(`open-watch:${blockers.openWatch}`);
  if (blockers.fence !== null) found.push(`fence-set:${blockers.fence}`);
  return {
    ok: true,
    kind: 'probe',
    latch: latch.state === 'unknown' ? 'unknown' : latch.state === 'latched' ? 'latched' : 'clear',
    newestStopId: latch.state === 'latched' ? latch.newestStopId : null,
    blockers: found,
  };
}

const USAGE = 'usage: qlb codex latch clear [--through <stop-id> --reason <text> | --initialize --reason <text>] [--json]';

type Parsed = { request: CodexLatchRequest; json: boolean };

function parse(args: string[]): Parsed | null {
  if (args[0] !== 'clear') return null;
  let through: string | undefined;
  let reason: string | undefined;
  let initialize = false;
  let json = false;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--initialize') initialize = true;
    else if (arg === '--through' || arg === '--reason') {
      const value = args[i + 1];
      if (value === undefined) return null;
      if (arg === '--through') through = value;
      else reason = value;
      i += 1;
    } else return null;
  }
  if (initialize) {
    if (through !== undefined || reason === undefined) return null;
    return { request: { kind: 'initialize', reason }, json };
  }
  if (through === undefined && reason === undefined) return { request: { kind: 'probe' }, json };
  if (through === undefined || reason === undefined || !/^[1-9]\d*$/.test(through)) return null;
  return { request: { kind: 'clear', throughId: Number(through), reason }, json };
}

function text(outcome: Exclude<CodexLatchOutcome, CodexLatchRefused>): string[] {
  switch (outcome.kind) {
    case 'clear': return [`codex latch cleared through stop ${outcome.throughId} (event ${outcome.eventId})`];
    case 'initialize': return [`codex stage log initialized (event ${outcome.eventId})`];
    case 'probe': {
      const head = outcome.latch === 'latched' ? `codex latch: latched, newest stop ${outcome.newestStopId}` : `codex latch: ${outcome.latch}`;
      if (outcome.blockers.length > 0) return [head, `blocked by: ${outcome.blockers.join(', ')}`];
      return [head, outcome.latch === 'latched' ? `nothing else blocks a clear through stop ${outcome.newestStopId}` : 'nothing to clear'];
    }
  }
}

export interface CodexLatchCommandOverrides {
  /** Builds the deps; the command closes `store` when done. */
  makeDeps?: (ctx: CommandContext) => Promise<CodexLatchDeps>;
}

async function productionDeps(ctx: CommandContext): Promise<CodexLatchDeps> {
  const store = openStore(ctx.config.dbPath);
  // The auth lock resolves from the command's env, as the journal directory and the stage markers' locks do.
  const switchDeps = { ...defaultSwitchDeps(ctx, store, {}), authLockOptions: { env: ctx.env } };
  return { store, switchDeps, buildStamp: readBuildStamp(), flagEnabled: CODEX_SWITCH_COMMAND_ENABLED };
}

export function createCodexLatchCommand(overrides: CodexLatchCommandOverrides = {}): CommandDefinition {
  return {
    name: 'codex latch',
    async execute(args: string[], ctx: CommandContext): Promise<number> {
      const parsed = parse(args);
      if (!parsed) {
        ctx.stderr(USAGE);
        return 2;
      }
      const deps = await (overrides.makeDeps ?? productionDeps)(ctx);
      try {
        let outcome: CodexLatchOutcome;
        try {
          outcome = await codexLatchClear(deps, parsed.request);
        } catch (error) {
          // A switch, refresh or `codex add` holds a lock. No clear or initialize row
          // was recorded, though recovery or a watch verdict may have been.
          if (!(error instanceof ClaudeCodeLockTimeout)) throw error;
          outcome = refuse('codex-lock-busy');
        }
        if (parsed.json) ctx.stdout(JSON.stringify(outcome));
        if (!outcome.ok) {
          if (!parsed.json) ctx.stderr(`codex latch clear refused: ${outcome.reason}${outcome.detail === undefined ? '' : `: ${outcome.detail}`}`);
          return 3;
        }
        if (!parsed.json) for (const line of text(outcome)) ctx.stdout(line);
        return 0;
      } finally {
        deps.store.close();
      }
    },
  };
}

const command = createCodexLatchCommand();
export default command;
