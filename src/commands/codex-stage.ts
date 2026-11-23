/**
 * `qlb codex stage start|close`: the owner's stage markers (U10, R3, R4).
 *
 * Both run under the Codex switch and auth locks and read the clock only once
 * they are held, so no switch, refresh or `codex add` is in flight across a
 * marker: every stop row stamped before the marker was written before it, and
 * the sweep (which starts at the first stage start) cannot miss one (owner
 * decision, 2026-11-23).
 */

import type { DatabaseSync } from 'node:sqlite';

import { AUTO_BINDINGS } from '../auto';
import type { HealthCheck } from '../checks/claude-slots';
import { codexFirstSwitchCheck } from '../checks/codex-first-switch';
import { codexSlotsCheck } from '../checks/codex-slots';
import { ClaudeCodeLockTimeout, type CodexAuthLockOptions } from '../cc-locks';
import { codexL13ReceiptAt } from '../codex-l13-receipt';
import { evaluateStages, type StageStatus } from '../codex-stage';
import { readBuildStamp, readCodexLatch, readCodexStageInputFrom, sweepCodexStops } from '../codex-stop';
import { CODEX_SWITCH_COMMAND_ENABLED, codexRecoveryFenceState, codexSwitchJournalDir, withCodexSwitchLocks } from '../codex-switch';
import { assertAdmitted, type LifecycleOperation } from '../lifecycle';
import { lifecyclePhase, type LifecyclePhaseResult } from '../lifecycle-read';
import { openStore, openStoreConnection, type CodexStageEvent, type Store } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

/** A piece of code a stage needs that does not exist yet; flip `present` in the PR that adds it. */
export interface CodexStagePrerequisite {
  name: 'auto-tick-wired' | 'decide-and-switch-tick' | 'l13-receipt-writer';
  /** The stages it gates; the receipt writer gates none (the receipt precondition already needs it). */
  gates: ReadonlyArray<1 | 2>;
  present: boolean;
}

export const CODEX_STAGE_PREREQUISITES: readonly CodexStagePrerequisite[] = [
  { name: 'auto-tick-wired', gates: [1, 2], present: (AUTO_BINDINGS as readonly string[]).includes('openai-codex') },
  { name: 'decide-and-switch-tick', gates: [2], present: false },
  { name: 'l13-receipt-writer', gates: [], present: false },
];

/** Every `<check>:<code>` the two Codex checks can emit at WARN; an allow-list may name only these (a FAIL is never allowed). */
export const CODEX_STAGE_ALLOWABLE_CODES: ReadonlySet<string> = new Set([
  'codex:slots:phase-unavailable',
  'codex:first-switch:phase-unavailable', 'codex:first-switch:receipt-invalid',
  'codex:first-switch:cutover-at-missing', 'codex:first-switch:receipt-overdue',
]);

export interface CodexStageDeps {
  now: () => number;
  flagEnabled: boolean;
  buildStamp: string | null;
  journalDir: string;
  prerequisites: readonly CodexStagePrerequisite[];
  runChecks: (dbPath: string, lifecycle: LifecyclePhaseResult, now: number) => HealthCheck[];
  /** Holds the Codex switch and auth locks; `assertHeld` throws if either was lost. */
  withLock: <T>(dbPath: string, fn: (assertHeld: () => void) => Promise<T>) => Promise<T>;
  autoLog?: (line: string) => void;
}

/**
 * A named refusal: flag-off, latched, latch-unknown, open-watch, recovery-fence,
 * run-open, precondition-failing, check-fail, check-not-allowed,
 * stage-1-not-passed, stage-2-inherits-allow-list, no-open-run or
 * codex-lock-busy; a lifecycle refusal passes its admission code through
 * (e.g. `phase=retired`).
 */
export type CodexStageRefused = { ok: false; reason: string; detail?: string[] };
export type CodexStageStartOutcome = { ok: true; stage: 1 | 2; eventId: number; allow: string[] } | CodexStageRefused;
export type CodexStageCloseOutcome = { ok: true; stage: 1 | 2; eventId: number; status: StageStatus } | CodexStageRefused;

const refuse = (reason: string, detail?: string[]): CodexStageRefused =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

/** The markers' locks: the Codex switch lock, then the auth lock, as every Codex write takes them. */
export function codexStageLocks(authLockOptions: CodexAuthLockOptions): CodexStageDeps['withLock'] {
  return (dbPath, fn) => withCodexSwitchLocks({ dbPath, authLockOptions }, fn);
}

function runCodexChecks(dbPath: string, lifecycle: LifecyclePhaseResult, now: number): HealthCheck[] {
  return [codexSlotsCheck(dbPath, lifecycle.phase), codexFirstSwitchCheck(dbPath, lifecycle, now)];
}

function allowListOf(event: CodexStageEvent | undefined): string[] {
  const allow = (event?.detail as { allow?: unknown } | null | undefined)?.allow;
  return Array.isArray(allow) ? allow.filter((pair): pair is string => typeof pair === 'string') : [];
}

/**
 * The checks every marker shares, under the lock: lifecycle admission, the
 * sweep, an open watch and a recovery fence. Returns a refusal or the
 * lifecycle id and the marker's timestamp, read after the lock was taken.
 */
function guardUnderLock(
  store: Store,
  deps: CodexStageDeps,
  operation: LifecycleOperation,
): CodexStageRefused | { lifecycleId: number | null; now: number } {
  const admission = assertAdmitted(store, operation);
  if (!admission.ok) return refuse(admission.code ?? 'not-admitted');
  const lifecycleId = admission.row?.id ?? null;
  sweepCodexStops({ store, now: deps.now, buildStamp: deps.buildStamp, flagEnabled: deps.flagEnabled, lifecycleId, autoLog: deps.autoLog });
  if (hasOpenWatch(store)) return refuse('open-watch');
  if (codexRecoveryFenceState(deps.journalDir, store).state === 'fenced') return refuse('recovery-fence');
  // Read after the sweep, so the marker is never stamped before a latch-set it follows.
  return { lifecycleId, now: deps.now() };
}

function readOnly<T>(store: Store, read: (db: DatabaseSync) => T): T {
  const db = openStoreConnection(store.dbPath, true);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const hasOpenWatch = (store: Store): boolean =>
  readOnly(store, (db) => db.prepare('SELECT 1 FROM codex_watch LIMIT 1').get() !== undefined);

/** Both stages' results, or null when the stage log is not readable. */
function evaluate(store: Store): ReturnType<typeof evaluateStages> | null {
  return readOnly(store, (db) => {
    const input = readCodexStageInputFrom(db);
    return input === null ? null : evaluateStages(input);
  });
}

/** The latest stage start's run, unless its stage was closed after it. */
function currentRun(events: CodexStageEvent[]): { start: CodexStageEvent; stage: 1 | 2 } | null {
  let index = events.length - 1;
  while (index >= 0 && events[index].kind !== 'stage-start') index -= 1;
  const start = events[index];
  if (!start || start.stage === null) return null;
  const stage = start.stage;
  return events.slice(index + 1).some((event) => event.kind === 'stage-close' && event.stage === stage) ? null : { start, stage };
}

export async function codexStageStart(
  store: Store,
  request: { stage: 1 | 2; allow: string[] },
  deps: CodexStageDeps,
): Promise<CodexStageStartOutcome> {
  if (!deps.flagEnabled) return refuse('flag-off');
  if (request.stage === 2 && request.allow.length > 0) return refuse('stage-2-inherits-allow-list');
  return deps.withLock(store.dbPath, async (assertHeld) => {
    const guard = guardUnderLock(store, deps, 'codex-stage-start');
    if ('ok' in guard) return guard;
    const latch = readCodexLatch(store);
    if (latch.state === 'set') return refuse('latched');
    if (latch.state === 'unreadable') return refuse('latch-unknown');
    const evaluated = evaluate(store);
    if (evaluated === null) return refuse('latch-unknown');
    const { events } = store.readCodexStageLog();
    // Owner decision (2026-11-23): a start never silently replaces an open run of
    // this stage or a later one; close it first, which freezes its result. A
    // stopped run may be restarted, and Stage 2 over an open Stage 1 run is the
    // promotion R4 describes.
    const run = currentRun(events);
    if (run && run.stage >= request.stage && evaluated[run.stage === 1 ? 'stage1' : 'stage2'].status !== 'stop') {
      return refuse('run-open');
    }

    const checks = deps.runChecks(store.dbPath, lifecyclePhase(store.dbPath), guard.now);
    const firstSwitch = checks.find((check) => check.name === 'codex:first-switch');
    const failing = [
      ...(firstSwitch?.level === 'PASS' ? [] : ['codex-first-switch-pass']),
      ...(codexL13ReceiptAt(store.getConfig('codex.l13VerifiedAt')) === null ? ['l13-receipt'] : []),
      ...deps.prerequisites.filter((row) => row.gates.includes(request.stage) && !row.present).map((row) => row.name),
    ];
    if (failing.length > 0) return refuse('precondition-failing', failing);

    const stage1Start = [...events].reverse()
      .find((event) => event.kind === 'stage-start' && event.stage === 1);
    const allow = request.stage === 1 ? request.allow : allowListOf(stage1Start);
    const pairs = (level: string): string[] => checks
      .filter((check) => check.level === level)
      .map((check) => `${check.name}:${check.code ?? 'uncoded'}`);
    const failed = pairs('FAIL');
    if (failed.length > 0) return refuse('check-fail', failed);
    const notAllowed = pairs('WARN').filter((pair) => !allow.includes(pair));
    if (notAllowed.length > 0) return refuse('check-not-allowed', notAllowed);
    if (request.stage === 2 && evaluated.stage1.status !== 'pass') return refuse('stage-1-not-passed');

    assertHeld();
    const eventId = store.appendCodexStageEvent({
      kind: 'stage-start',
      now: guard.now,
      lifecycleId: guard.lifecycleId,
      buildStamp: deps.buildStamp,
      flagEnabled: deps.flagEnabled,
      stage: request.stage,
      detail: request.stage === 2 ? { allow, frozenStatus: evaluated.stage1.status } : { allow },
    });
    if (eventId === null) throw new Error('codex stage start row was not recorded');
    return { ok: true, stage: request.stage, eventId, allow };
  });
}

export async function codexStageClose(store: Store, deps: CodexStageDeps): Promise<CodexStageCloseOutcome> {
  return deps.withLock(store.dbPath, async (assertHeld) => {
    const guard = guardUnderLock(store, deps, 'codex-stage-close');
    if ('ok' in guard) return guard;
    const log = store.readCodexStageLog();
    if (log.status !== 'readable') return refuse('latch-unknown');
    const run = currentRun(log.events);
    if (!run) return refuse('no-open-run');
    const { stage } = run;
    const evaluated = evaluate(store);
    if (evaluated === null) return refuse('latch-unknown');
    const result = stage === 1 ? evaluated.stage1 : evaluated.stage2;
    const status: StageStatus = result.status === 'not-started' ? 'not-yet' : result.status;
    assertHeld();
    const eventId = store.appendCodexStageEvent({
      kind: 'stage-close',
      now: guard.now,
      lifecycleId: guard.lifecycleId,
      buildStamp: deps.buildStamp,
      flagEnabled: deps.flagEnabled,
      stage,
      detail: {
        frozenStatus: status,
        confirmed: result.confirmed,
        days: result.days,
        refreshes: result.refreshes,
        stops: result.stops.map((stop) => stop.pointer),
      },
    });
    if (eventId === null) throw new Error('codex stage close row was not recorded');
    return { ok: true, stage, eventId, status };
  });
}

type Parsed = { action: 'start'; stage: 1 | 2; allow: string[]; json: boolean } | { action: 'close'; json: boolean };

function parse(args: string[]): Parsed | null {
  const json = args.includes('--json');
  const rest = args.filter((arg) => arg !== '--json');
  const [action, ...flags] = rest;
  if (action === 'close') return flags.length === 0 ? { action, json } : null;
  if (action !== 'start') return null;
  let stage: 1 | 2 | undefined;
  const allow: string[] = [];
  for (let index = 0; index < flags.length; index += 2) {
    const [flag, value] = [flags[index], flags[index + 1]];
    if (value === undefined) return null;
    if (flag === '--stage' && stage === undefined && (value === '1' || value === '2')) stage = Number(value) as 1 | 2;
    else if (flag === '--allow' && CODEX_STAGE_ALLOWABLE_CODES.has(value) && !allow.includes(value)) allow.push(value);
    else return null;
  }
  return stage === undefined ? null : { action, stage, allow, json };
}

const USAGE = 'usage: qlb codex stage start --stage <1|2> [--allow <check>:<code>]... [--json] | qlb codex stage close [--json]';

export function createCodexStageCommand(overrides: Partial<CodexStageDeps> = {}): CommandDefinition {
  return {
    name: 'codex stage',
    async execute(args: string[], ctx: CommandContext): Promise<number> {
      const flagEnabled = overrides.flagEnabled ?? CODEX_SWITCH_COMMAND_ENABLED;
      // As for the switch command, a dark build refuses before parsing or opening the store.
      if (args[0] === 'start' && !flagEnabled) {
        ctx.stderr('codex stage start refused: flag-off');
        return 3;
      }
      const parsed = parse(args);
      if (!parsed) {
        ctx.stderr(USAGE);
        return 2;
      }
      const deps: CodexStageDeps = {
        now: Date.now,
        flagEnabled,
        buildStamp: readBuildStamp(),
        journalDir: overrides.journalDir ?? codexSwitchJournalDir({ env: ctx.env }),
        prerequisites: CODEX_STAGE_PREREQUISITES,
        runChecks: runCodexChecks,
        withLock: codexStageLocks({ env: ctx.env }),
        ...overrides,
      };
      const store = openStore(ctx.config.dbPath);
      try {
        let outcome: CodexStageStartOutcome | CodexStageCloseOutcome;
        try {
          outcome = parsed.action === 'start'
            ? await codexStageStart(store, { stage: parsed.stage, allow: parsed.allow }, deps)
            : await codexStageClose(store, deps);
        } catch (error) {
          // A switch, refresh or `codex add` holds a lock; nothing was recorded.
          if (!(error instanceof ClaudeCodeLockTimeout)) throw error;
          outcome = refuse('codex-lock-busy');
        }
        if (parsed.json) ctx.stdout(JSON.stringify(outcome));
        if (!outcome.ok) {
          const detail = outcome.detail ? `: ${outcome.detail.join(', ')}` : '';
          if (!parsed.json) ctx.stderr(`codex stage ${parsed.action} refused: ${outcome.reason}${detail}`);
          return 3;
        }
        if (!parsed.json) {
          ctx.stdout('status' in outcome
            ? `codex stage ${outcome.stage} closed: ${outcome.status} (event ${outcome.eventId})`
            : `codex stage ${outcome.stage} started (event ${outcome.eventId})`);
        }
        return 0;
      } finally {
        store.close();
      }
    },
  };
}

const command = createCodexStageCommand();
export default command;
