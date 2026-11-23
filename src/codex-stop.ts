/**
 * The Codex stop sweep and latch read. The sweep is the only writer of
 * latch-set rows from evidence: it classifies `switch_log`, `relogin_events`
 * and `codex_watch_verdicts` rows newer than the first stage start with the
 * pure classifier in `codex-stage.ts`, and records each new stop once (the
 * evidence pointer is unique). The latch read is fail-closed: callers treat
 * `unreadable` as set.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { CODEX_NAMED_REFUSALS } from './codex-refusals';
import {
  deriveLatch,
  findStops,
  type StageEventRow,
  type StageInput,
  type StageLineageRow,
  type StageLog,
  type StageReloginRow,
  type StageStatus,
  type StageSwitchRow,
} from './codex-stage';
import {
  appendCodexStageEventTo,
  listCodexStopEvidenceFrom,
  listCodexWatchVerdictsFrom,
  readCodexStageLogFrom,
  type CodexStageEvent,
  type CodexStageLog,
  type Store,
} from './store';

export interface CodexStopContext {
  store: Pick<Store, 'readCodexStageLog' | 'listCodexStopEvidence' | 'listCodexWatchVerdicts' | 'appendCodexStageEvent' | 'dbPath'>;
  now: () => number;
  /** The running build's stamp; see `readBuildStamp`. */
  buildStamp: string | null;
  /** `CODEX_SWITCH_COMMAND_ENABLED` as the caller sees it; passed in to avoid an import cycle with the switch path. */
  flagEnabled: boolean;
  lifecycleId: number | null;
  /** Defaults to appending to `auto.log` beside the store. */
  autoLog?: (line: string) => void;
}

export type CodexLatchRead =
  | { state: 'clear' }
  | { state: 'set'; newestStopId: number; stopIds: number[] }
  | { state: 'unreadable'; reason: string };

const STAGE_STATUSES: ReadonlySet<string> = new Set<StageStatus>(['pass', 'not-yet', 'stop']);

/** A stage-close row, and a Stage 2 start row, carry the frozen result as `detail.frozenStatus`. */
function frozenStatusOf(detail: unknown): StageStatus | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const value = (detail as { frozenStatus?: unknown }).frozenStatus;
  return typeof value === 'string' && STAGE_STATUSES.has(value) ? value as StageStatus : null;
}

function toStageEventRow(event: CodexStageEvent): StageEventRow {
  return {
    id: event.id,
    kind: event.kind,
    recordedAt: event.recordedAt,
    stage: event.stage,
    throughId: event.throughId,
    frozenStatus: frozenStatusOf(event.detail),
  };
}

/** The store's stage log in the evaluator's shape. */
export function toStageLog(log: CodexStageLog): StageLog {
  return log.status === 'readable'
    ? { status: 'readable', events: log.events.map(toStageEventRow) }
    : { status: 'unknown', reason: log.reason };
}

/** The sweep's store methods over one connection, for a caller that holds a connection rather than a `Store`. */
export function codexStopStoreOn(db: DatabaseSync, dbPath: string): CodexStopContext['store'] {
  return {
    dbPath,
    readCodexStageLog: () => readCodexStageLogFrom(db),
    listCodexStopEvidence: (sinceTs) => listCodexStopEvidenceFrom(db, sinceTs),
    listCodexWatchVerdicts: () => listCodexWatchVerdictsFrom(db),
    appendCodexStageEvent: (input) => appendCodexStageEventTo(db, input),
  };
}

export function readCodexLatch(store: Pick<Store, 'readCodexStageLog'>): CodexLatchRead {
  const latch = deriveLatch(toStageLog(store.readCodexStageLog()));
  switch (latch.state) {
    case 'unknown':
      return { state: 'unreadable', reason: latch.reason };
    case 'latched':
      return { state: 'set', newestStopId: latch.newestStopId, stopIds: latch.stopIds };
    default:
      return { state: 'clear' };
  }
}

/**
 * Records a latch-set for every stop not yet recorded and returns the new row
 * ids. Before the first stage start the sweep is unarmed and records nothing;
 * once armed it never disarms.
 */
export function sweepCodexStops(ctx: CodexStopContext): { recorded: number[] } {
  const log = ctx.store.readCodexStageLog();
  // A store without the tables is a read-only open; nothing can be recorded there.
  if (log.status === 'unknown' && log.reason === 'tables-missing') return { recorded: [] };
  const firstStart = log.events.find((event) => event.kind === 'stage-start');
  if (!firstStart) return { recorded: [] };

  const since = firstStart.recordedAt;
  const evidence = ctx.store.listCodexStopEvidence(since);
  const findings = findStops({
    // The classifier reads only id, ts, outcome and detail from a switch row.
    switches: evidence.switches.map((row): StageSwitchRow => ({ ...row, committedAt: null, toAccount: '' })),
    relogins: evidence.relogins,
    verdicts: ctx.store.listCodexWatchVerdicts().filter((row) => row.recordedAt >= since),
  }, { namedRefusals: CODEX_NAMED_REFUSALS });

  const recorded: number[] = [];
  for (const finding of findings) {
    const now = ctx.now();
    const id = ctx.store.appendCodexStageEvent({
      kind: 'latch-set',
      now,
      lifecycleId: ctx.lifecycleId,
      buildStamp: ctx.buildStamp,
      flagEnabled: ctx.flagEnabled,
      evidence: finding.pointer,
      detail: { rule: finding.rule },
    });
    if (id === null) continue;
    recorded.push(id);
    const line = `codex:stop-latched stop=${id} rule=${finding.rule} evidence=${finding.pointer} at=${now}`;
    // The stop is already recorded; a failed audit line must not undo or repeat it.
    try { (ctx.autoLog ?? ((text) => appendAutoLog(ctx.store, text)))(line); } catch { /* recorded above */ }
  }
  return { recorded };
}

/**
 * Everything the stage evaluator reads, from any connection (a read-only one
 * included). Null when the stage log is not readable, which callers treat as
 * latched.
 */
export function readCodexStageInputFrom(db: DatabaseSync): StageInput | null {
  const log = toStageLog(readCodexStageLogFrom(db));
  if (log.status !== 'readable') return null;
  const rows = <T>(sql: string): T[] => (db.prepare(sql).all() as T[]).map((row) => ({ ...row }));
  return {
    events: log.events,
    switches: rows<StageSwitchRow>(`SELECT id, ts, committed_at AS committedAt, trigger, outcome, detail, to_account AS toAccount
      FROM switch_log WHERE provider = 'openai-codex' ORDER BY id`),
    relogins: rows<StageReloginRow>("SELECT id, ts, kind FROM relogin_events WHERE provider = 'openai-codex' ORDER BY id"),
    verdicts: listCodexWatchVerdictsFrom(db).map(({ switchId, verdict, recordedAt }) => ({ switchId, verdict, recordedAt })),
    lineage: rows<StageLineageRow>(`SELECT id, ts, account_id AS accountId, by, cause
      FROM lineage_log WHERE provider = 'openai-codex' ORDER BY id`),
    rules: { namedRefusals: CODEX_NAMED_REFUSALS },
  };
}

function appendAutoLog(store: Pick<Store, 'dbPath'>, line: string): void {
  const directory = dirname(store.dbPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  appendFileSync(join(directory, 'auto.log'), `${line}\n`, { mode: 0o600 });
}

/** The stamp `npm run build` writes beside the compiled modules (`release.ts` names it), or null when absent. */
export function readBuildStamp(directory: string = __dirname): string | null {
  try {
    const stamp = readFileSync(join(directory, '.build-sha'), 'utf8').trim();
    return stamp === '' ? null : stamp;
  } catch {
    return null;
  }
}
