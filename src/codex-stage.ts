/**
 * Pure rules for taking Codex switching live in stages: the stop latch, what
 * it admits, which rows are stops, and whether a stage passed. No I/O. The
 * switch path, the refresh path, the owner commands, the stage report and the
 * Lean model's replayed cases all go through these functions, so they are the
 * one tie between the model and the shipped code.
 */

export type StageStatus = 'pass' | 'not-yet' | 'stop';

export interface StageEventRow {
  id: number;
  kind: 'stage-start' | 'stage-close' | 'latch-set' | 'latch-clear' | 'initialize-required' | 'initialize';
  recordedAt: number;
  stage: 1 | 2 | null;
  /** Latch-clear only: the newest stop the owner reviewed. */
  throughId: number | null;
  /** Stage close: that stage's frozen result. Stage 2 start: Stage 1's frozen result. */
  frozenStatus: StageStatus | null;
}

export interface StageSwitchRow {
  id: number;
  ts: number;
  committedAt: number | null;
  trigger: string;
  outcome: string;
  detail: string | null;
  toAccount: string;
}

export interface StageReloginRow {
  id: number;
  ts: number;
  kind: string;
}

export interface StageVerdictRow {
  switchId: number;
  verdict: string;
  recordedAt: number;
}

export interface StageLineageRow {
  id: number;
  ts: number;
  accountId: string;
  by: string;
  cause: string;
}

export interface StopRules {
  /** Every refusal cause the switch path can persist. */
  namedRefusals: ReadonlySet<string>;
}

export type StopRule =
  | 'forced-relogin'
  | 'half-finished-switch'
  | 'unconfirmed-switch'
  | 'unexplained-refusal'
  | 'unrecognized-row'
  | 'recorded-stop';

export interface StopFinding {
  /** The evidence row, as `<table>:<id>`; for a recorded stop, `codex_stage_events:<id>`. */
  pointer: string;
  rule: StopRule;
  ts: number;
}

// ---------------------------------------------------------------------------
// Stop classifier

const STOP_RELOGIN_KINDS = new Set(['identity-replaced', 'wiped', 'dead']);
const CLEAN_RELOGIN_KINDS = new Set(['external-login', 'healed']);
const CLEAN_FAILED_DETAILS = new Set(['not-published', 'target-changed']);
const HALF_FINISHED_DETAILS = new Set(['unknown-live-identity', 'wiped']);
const NEUTRAL_VERDICTS = new Set(['confirmed', 'late', 'superseded', 'not-admitted']);
const HALF_FINISHED_VERDICTS = new Set(['unresolved', 'wiped', 'unknown-live-identity']);
const UNCONFIRMED_VERDICTS = new Set(['reverted', 'inconclusive']);

export function classifyReloginRow(row: StageReloginRow): StopFinding | null {
  const pointer = `relogin_events:${row.id}`;
  if (STOP_RELOGIN_KINDS.has(row.kind)) return { pointer, rule: 'forced-relogin', ts: row.ts };
  if (CLEAN_RELOGIN_KINDS.has(row.kind)) return null;
  return { pointer, rule: 'unrecognized-row', ts: row.ts };
}

export function classifySwitchRow(row: StageSwitchRow, rules: StopRules): StopFinding | null {
  const stop = (rule: StopRule): StopFinding => ({ pointer: `switch_log:${row.id}`, rule, ts: row.ts });
  switch (row.outcome) {
    case 'ok':
    case 'noop':
      return null;
    case 'refused':
      return row.detail != null && rules.namedRefusals.has(row.detail) ? null : stop('unexplained-refusal');
    case 'failed':
      if (row.detail != null && CLEAN_FAILED_DETAILS.has(row.detail)) return null;
      return stop(row.detail != null && HALF_FINISHED_DETAILS.has(row.detail) ? 'half-finished-switch' : 'unrecognized-row');
    case 'reverted-by-codex':
      // The watch's verdict records the same incident; this row is kept as
      // evidence in case the verdict is missing. One clear covers both.
      return stop('unconfirmed-switch');
    default:
      return stop('unrecognized-row');
  }
}

export function classifyVerdictRow(row: StageVerdictRow): StopFinding | null {
  const stop = (rule: StopRule): StopFinding => ({ pointer: `codex_watch_verdicts:${row.switchId}`, rule, ts: row.recordedAt });
  if (NEUTRAL_VERDICTS.has(row.verdict)) return null;
  if (HALF_FINISHED_VERDICTS.has(row.verdict)) return stop('half-finished-switch');
  if (UNCONFIRMED_VERDICTS.has(row.verdict)) return stop('unconfirmed-switch');
  return stop('unrecognized-row');
}

/** Every stop among the evidence rows, oldest first. */
export function findStops(
  evidence: { switches: StageSwitchRow[]; relogins: StageReloginRow[]; verdicts: StageVerdictRow[] },
  rules: StopRules,
): StopFinding[] {
  const found = [
    ...evidence.switches.map((row) => classifySwitchRow(row, rules)),
    ...evidence.relogins.map(classifyReloginRow),
    ...evidence.verdicts.map(classifyVerdictRow),
  ].filter((finding): finding is StopFinding => finding !== null);
  return found.sort((a, b) => a.ts - b.ts || a.pointer.localeCompare(b.pointer));
}

// ---------------------------------------------------------------------------
// Latch

export type LatchState =
  | { state: 'unarmed' }
  | { state: 'armed' }
  | { state: 'latched'; newestStopId: number; stopIds: number[] };

export type LatchView = LatchState | { state: 'unknown'; reason: string };

export type LatchEvent =
  | { kind: 'stage-start' }
  | { kind: 'stage-close' }
  | { kind: 'stop'; id: number }
  | { kind: 'clear'; throughId: number };

/** One step of the latch state machine. A clear not through the newest stop changes nothing. */
export function latchStep(current: LatchState, event: LatchEvent): LatchState {
  switch (event.kind) {
    case 'stage-start':
    case 'stage-close':
      return current.state === 'unarmed' ? { state: 'armed' } : current;
    case 'stop':
      return current.state === 'latched'
        ? { state: 'latched', newestStopId: event.id, stopIds: [...current.stopIds, event.id] }
        : { state: 'latched', newestStopId: event.id, stopIds: [event.id] };
    case 'clear':
      return current.state === 'latched' && event.throughId === current.newestStopId ? { state: 'armed' } : current;
  }
}

function latchEventOf(row: StageEventRow): LatchEvent | null {
  switch (row.kind) {
    case 'stage-start':
    case 'stage-close':
      return { kind: row.kind };
    case 'latch-set':
      return { kind: 'stop', id: row.id };
    case 'latch-clear':
      return row.throughId == null ? null : { kind: 'clear', throughId: row.throughId };
    default:
      return null;
  }
}

export type StageLog =
  | { status: 'readable'; events: StageEventRow[] }
  | { status: 'unknown'; reason: string };

export function deriveLatch(log: StageLog): LatchView {
  if (log.status === 'unknown') return { state: 'unknown', reason: log.reason };
  let current: LatchState = { state: 'unarmed' };
  for (const row of log.events) {
    const event = latchEventOf(row);
    if (event) current = latchStep(current, event);
  }
  return current;
}

export type ClearRefusal = 'not-latched' | 'newer-stop' | 'open-watch' | 'fence-set' | 'empty-reason';

export function decideLatchClear(input: {
  latch: LatchView;
  throughId: number;
  openWatch: boolean;
  fenceSet: boolean;
  reason: string;
}): { ok: true } | { ok: false; refusal: Exclude<ClearRefusal, 'newer-stop'> } | { ok: false; refusal: 'newer-stop'; newestStopId: number } {
  if (input.reason.trim() === '') return { ok: false, refusal: 'empty-reason' };
  if (input.latch.state !== 'latched') return { ok: false, refusal: 'not-latched' };
  if (input.throughId !== input.latch.newestStopId) {
    return { ok: false, refusal: 'newer-stop', newestStopId: input.latch.newestStopId };
  }
  if (input.openWatch) return { ok: false, refusal: 'open-watch' };
  if (input.fenceSet) return { ok: false, refusal: 'fence-set' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Admission

export type CodexAction =
  | { kind: 'switch'; trigger: string }
  | { kind: 'refresh' }
  | { kind: 'import' | 'adopt' | 'stash' };

export type AdmissionRefusal = 'codex-stop-latched' | 'codex-switch-dark' | 'codex-stage-not-automatic';

/**
 * Whether an automatic switch is in scope: a Stage 2 run is open, or Stage 2
 * closed passed. A stop ends the run, and after a clear no run is active
 * until the next stage start.
 */
function automaticSwitchingAllowed(events: StageEventRow[]): boolean {
  let allowed = false;
  for (const row of events) {
    if (row.kind === 'stage-start') allowed = row.stage === 2;
    else if (row.kind === 'stage-close') allowed = row.stage === 2 && row.frozenStatus === 'pass';
    else if (row.kind === 'latch-set' || row.kind === 'latch-clear') allowed = false;
  }
  return allowed;
}

export function admitCodexAction(input: {
  log: StageLog;
  flagEnabled: boolean;
  action: CodexAction;
}): { admitted: true } | { admitted: false; refusal: AdmissionRefusal } {
  const { action } = input;
  if (action.kind !== 'switch' && action.kind !== 'refresh') return { admitted: true };
  const latch = deriveLatch(input.log);
  if (latch.state === 'latched' || latch.state === 'unknown') return { admitted: false, refusal: 'codex-stop-latched' };
  if (action.kind === 'refresh') return { admitted: true };
  if (!input.flagEnabled) return { admitted: false, refusal: 'codex-switch-dark' };
  if (action.trigger === 'manual') return { admitted: true };
  return input.log.status === 'readable' && automaticSwitchingAllowed(input.log.events)
    ? { admitted: true }
    : { admitted: false, refusal: 'codex-stage-not-automatic' };
}

// ---------------------------------------------------------------------------
// Stage evaluator

const PASS_BARS = {
  1: { switches: 5, days: 2, refreshes: 0 },
  2: { switches: 10, days: 7, refreshes: 1 },
} as const;

export interface StageInput {
  events: StageEventRow[];
  switches: StageSwitchRow[];
  relogins: StageReloginRow[];
  verdicts: StageVerdictRow[];
  lineage: StageLineageRow[];
  rules: StopRules;
  /** Maps a timestamp to the owner's local calendar date. */
  localDateOf?: (ms: number) => string;
}

export interface StageResult {
  stage: 1 | 2;
  status: StageStatus | 'not-started';
  /** The stage-start row this result is for. */
  startId: number | null;
  /** True when the run has ended and the status was frozen then. */
  frozen: boolean;
  /** Switch ids with a confirmed verdict inside the evidence window. */
  confirmed: number[];
  /** Distinct local dates of the confirmed switches. */
  days: string[];
  /** Lineage ids of the qualifying qlb refreshes (Stage 2 only). */
  refreshes: number[];
  stops: StopFinding[];
}

function defaultLocalDate(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function lastIndex<T>(items: T[], match: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (match(items[index])) return index;
  return -1;
}

function emptyResult(stage: 1 | 2, status: StageResult['status'], startId: number | null, frozen: boolean): StageResult {
  return { stage, status, startId, frozen, confirmed: [], days: [], refreshes: [], stops: [] };
}

function evaluateStage(input: StageInput, stage: 1 | 2): StageResult {
  const { events } = input;
  const startIndex = lastIndex(events, (row) => row.kind === 'stage-start' && row.stage === stage);
  if (startIndex < 0) return emptyResult(stage, 'not-started', null, false);
  const start = events[startIndex];
  const later = events.slice(startIndex + 1);

  // A later start of the same or an earlier stage replaces this run.
  const nextStart = later.find((row) => row.kind === 'stage-start');
  if (nextStart && nextStart.stage !== null && nextStart.stage <= stage) {
    return emptyResult(stage, 'not-started', null, false);
  }
  const close = later.find((row) => row.kind === 'stage-close' && row.stage === stage);
  const frozenBy = [nextStart, close]
    .filter((row): row is StageEventRow => row !== undefined)
    .sort((a, b) => a.id - b.id)[0];

  // Every stop from the start marker on, judged from the rows and from the log.
  const recorded: StopFinding[] = later
    .filter((row) => row.kind === 'latch-set')
    .map((row) => ({ pointer: `codex_stage_events:${row.id}`, rule: 'recorded-stop', ts: row.recordedAt }));
  const allStops = [...findStops(input, input.rules), ...recorded]
    .filter((finding) => finding.ts >= start.recordedAt)
    .sort((a, b) => a.ts - b.ts);
  const firstStop = allStops[0];

  // The run ends at the earliest of the next start, its own close, or its first stop.
  const frozenAt = frozenBy?.recordedAt ?? Number.POSITIVE_INFINITY;
  if (frozenBy && (!firstStop || frozenAt <= firstStop.ts) && frozenBy.frozenStatus !== null) {
    return emptyResult(stage, frozenBy.frozenStatus, start.id, true);
  }
  const end = Math.min(frozenAt, firstStop ? firstStop.ts + 1 : Number.POSITIVE_INFINITY);
  const stops = allStops.filter((finding) => finding.ts < end);

  const inRun = (ts: number): boolean => ts >= start.recordedAt && ts < end;
  const ofStage = (row: StageSwitchRow): boolean => (stage === 1 ? row.trigger === 'manual' : row.trigger !== 'manual');
  const runSwitches = input.switches.filter((row) => ofStage(row) && inRun(row.committedAt ?? row.ts));
  const confirmedIds = new Set(input.verdicts.filter((row) => row.verdict === 'confirmed').map((row) => row.switchId));
  const confirmedRows = runSwitches.filter((row) => row.outcome === 'ok' && confirmedIds.has(row.id));
  const localDateOf = input.localDateOf ?? defaultLocalDate;
  const days = [...new Set(confirmedRows.map((row) => localDateOf(row.committedAt ?? row.ts)))].sort();

  let refreshes: number[] = [];
  if (stage === 2) {
    const firstSwitchAt = Math.min(...runSwitches.map((row) => row.committedAt ?? row.ts));
    // A pre-switch refresh is credited to the run of the switch it preceded,
    // even when it was logged before the evidence window opened.
    const precededRunSwitch = (row: StageLineageRow): boolean => runSwitches.some((switchRow) =>
      switchRow.toAccount === row.accountId && row.ts >= start.recordedAt && row.ts <= (switchRow.committedAt ?? switchRow.ts));
    refreshes = input.lineage
      .filter((row) => row.by === 'qlb-auto' && row.cause === 'post')
      .filter((row) => (row.ts >= firstSwitchAt && row.ts < end) || precededRunSwitch(row))
      .map((row) => row.id);
  }

  const bar = PASS_BARS[stage];
  const status: StageStatus = stops.length > 0
    ? 'stop'
    : confirmedRows.length >= bar.switches && days.length >= bar.days && refreshes.length >= bar.refreshes
      ? 'pass'
      : 'not-yet';
  return {
    stage, status, startId: start.id, frozen: false,
    confirmed: confirmedRows.map((row) => row.id), days, refreshes, stops,
  };
}

export function evaluateStages(input: StageInput): { stage1: StageResult; stage2: StageResult } {
  return { stage1: evaluateStage(input, 1), stage2: evaluateStage(input, 2) };
}
