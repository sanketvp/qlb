/**
 * `qlb codex stage report`: each Codex go-live stage's state and the rows
 * behind it (U12, R17-R19, KTD9).
 *
 * Read-only: it opens the store read-only, as `qlb status --history` does,
 * and never runs the sweep. It evaluates stages with the same pure classifier
 * the sweep uses, so a stop the sweep has not recorded yet still shows.
 *
 * The output goes on flag-flip PRs in a public repo, so it is a shareable
 * projection (docs/CREDENTIAL-SAFETY.md, migration receipt rule): accounts show
 * as report-local aliases, evidence rows as an allowlisted projection, clear
 * reasons only as "recorded", and the whole report passes through redactJson.
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { codexFirstSwitchCheck } from '../checks/codex-first-switch';
import { codexL13ReceiptAt } from '../codex-l13-receipt';
import { CODEX_NAMED_REFUSALS } from '../codex-refusals';
import { deriveLatch, evaluateStages, type StageResult, type StopFinding } from '../codex-stage';
import { codexStopEvidenceFrom, findSweepStops, readBuildStamp, readCodexStageInputFrom, toStageLog } from '../codex-stop';
import { CODEX_SWITCH_COMMAND_ENABLED } from '../codex-switch';
import { lifecyclePhase } from '../lifecycle-read';
import { redactJson } from '../redact';
import { readUserVersion, SCHEMA_VERSION } from '../schema-version';
import { openStoreConnection, readCodexStageLogFrom, readOnlySchemaRefusal, type CodexStageEvent } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';
import { CODEX_STAGE_PREREQUISITES, type CodexStagePrerequisite } from './codex-stage';

/** An evidence row, projected to fields that are safe to share. */
export type EvidenceRow =
  | { table: 'switch_log'; id: number; at: string; trigger: string; outcome: string; detail: string | null }
  | { table: 'relogin_events'; id: number; at: string; kind: string }
  | { table: 'codex_watch_verdicts'; switchId: number; at: string; verdict: string }
  | { table: 'codex_stage_events'; id: number; at: string; rule: string; evidence: string }
  | { table: string; missing: true };

export interface ReportStop {
  evidence: string;
  rule: string;
  at: string;
  row: EvidenceRow;
}

export interface CodexStageReport {
  build: { stamp: string | null; flagEnabled: boolean };
  phase: string;
  preconditions: Array<{ name: string; gates: Array<1 | 2>; status: 'pass' | 'fail'; detail: string }>;
  latch: {
    state: 'unarmed' | 'armed' | 'latched' | 'unknown';
    reason?: string;
    /** Recorded latch-set rows; `cleared` when a later clear covers it. */
    stops: Array<{ id: number; at: string; rule: string; evidence: string; cleared: boolean; row: EvidenceRow }>;
    /** Stops in the rows that the sweep has not recorded yet. */
    pending: ReportStop[];
    clears: Array<{ id: number; at: string; throughId: number | null; reason: 'recorded' }>;
  };
  starts: Array<{ id: number; stage: 1 | 2 | null; at: string; buildStamp: string | null; flagEnabled: boolean | null }>;
  stages: Array<{
    stage: 1 | 2;
    status: StageResult['status'] | 'unknown';
    startId: number | null;
    frozen: boolean;
    confirmed: Array<{ id: number; at: string; to: string }>;
    days: string[];
    refreshes: Array<{ id: number; account: string; at: string; by: string; cause: string }>;
    stops: ReportStop[];
  }>;
}

export interface CodexStageReportDeps {
  now: () => number;
  knownSecrets: readonly string[];
  prerequisites?: readonly CodexStagePrerequisite[];
  buildStamp?: string | null;
  flagEnabled?: boolean;
}

export type CodexStageReportResult = { ok: true; report: CodexStageReport } | { ok: false; reason: string };

/** Detail codes the switch path writes; any other detail (an error string, say) shows as `unrecognized`. */
const KNOWN_DETAILS: ReadonlySet<string> = new Set([
  ...CODEX_NAMED_REFUSALS, 'not-published', 'target-changed', 'unknown-live-identity', 'wiped',
]);
const CODE = /^[a-z][a-z0-9-]{0,63}$/;
const LEVELS: ReadonlySet<string> = new Set(['PASS', 'WARN', 'FAIL', 'INFO', 'N/A']);
const SHA = /^[0-9a-f]{7,64}$/;
const POINTER = /^([a-z_]+):(\d+)$/;

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A build stamp as the commit it was built from: the `.build-sha` JSON
 * (`{sha, dirty, buildDigest}`) shows as its sha, `-dirty` when built from a
 * dirty tree; a bare sha shows as is; anything else as `unrecognized`.
 */
function stampOf(value: string | null): string | null {
  if (value === null) return null;
  if (SHA.test(value)) return value;
  try {
    const parsed = JSON.parse(value) as { sha?: unknown; dirty?: unknown };
    if (typeof parsed.sha === 'string' && SHA.test(parsed.sha)) return `${parsed.sha}${parsed.dirty === true ? '-dirty' : ''}`;
  } catch { /* not the JSON stamp */ }
  return 'unrecognized';
}
/** A value the code wrote as a short code; anything else is not printed. */
const code = (value: unknown): string => (typeof value === 'string' && CODE.test(value) ? value : 'unrecognized');

/** Report-local aliases: `account-01`, ... in order of first appearance. */
class Aliases {
  private readonly names = new Map<string, string>();
  of(account: string): string {
    let name = this.names.get(account);
    if (name === undefined) {
      name = `account-${String(this.names.size + 1).padStart(2, '0')}`;
      this.names.set(account, name);
    }
    return name;
  }
}

function evidenceRow(db: DatabaseSync, pointer: string, events: CodexStageEvent[]): EvidenceRow {
  const match = POINTER.exec(pointer);
  if (!match) return { table: 'unrecognized', missing: true };
  const [, table, rawId] = match;
  const id = Number(rawId);
  switch (table) {
    case 'switch_log': {
      const row = db.prepare('SELECT id, ts, trigger, outcome, detail FROM switch_log WHERE id = ?').get(id) as
        { id: number; ts: number; trigger: string; outcome: string; detail: string | null } | undefined;
      if (!row) break;
      const detail = row.detail == null ? null : KNOWN_DETAILS.has(row.detail) ? row.detail : 'unrecognized';
      return { table, id: row.id, at: iso(row.ts), trigger: code(row.trigger), outcome: code(row.outcome), detail };
    }
    case 'relogin_events': {
      const row = db.prepare('SELECT id, ts, kind FROM relogin_events WHERE id = ?').get(id) as { id: number; ts: number; kind: string } | undefined;
      if (!row) break;
      return { table, id: row.id, at: iso(row.ts), kind: code(row.kind) };
    }
    case 'codex_watch_verdicts': {
      const row = db.prepare('SELECT switch_id, recorded_at, verdict FROM codex_watch_verdicts WHERE switch_id = ?').get(id) as
        { switch_id: number; recorded_at: number; verdict: string } | undefined;
      if (!row) break;
      return { table, switchId: row.switch_id, at: iso(row.recorded_at), verdict: code(row.verdict) };
    }
    case 'codex_stage_events': {
      const event = events.find((row) => row.id === id && row.kind === 'latch-set');
      if (!event) break;
      return { table, id, at: iso(event.recordedAt), rule: ruleOf(event), evidence: safePointer(event.evidence) };
    }
    default:
      return { table: code(table), missing: true };
  }
  return { table, missing: true };
}

const safePointer = (pointer: string | null): string => (pointer !== null && POINTER.test(pointer) ? pointer : 'unrecognized');
const ruleOf = (event: CodexStageEvent): string => code((event.detail as { rule?: unknown } | null)?.rule);

function preconditions(
  dbPath: string,
  db: DatabaseSync,
  now: number,
  prerequisites: readonly CodexStagePrerequisite[],
): { phase: string; rows: CodexStageReport['preconditions'] } {
  const lifecycle = lifecyclePhase(dbPath);
  const firstSwitch = codexFirstSwitchCheck(dbPath, lifecycle, now);
  const receipt = db.prepare("SELECT value FROM config WHERE key = 'codex.l13VerifiedAt'").get() as { value: string | null } | undefined;
  const receiptAt = codexL13ReceiptAt(receipt?.value ?? null);
  const both: Array<1 | 2> = [1, 2];
  const level = LEVELS.has(firstSwitch.level) ? firstSwitch.level : 'unrecognized';
  return {
    phase: code(lifecycle.phase),
    rows: [
      { name: 'lifecycle-cutover', gates: both, status: lifecycle.phase === 'cutover' ? 'pass' : 'fail', detail: `phase=${code(lifecycle.phase)}` },
      {
        name: 'codex-first-switch-pass', gates: both, status: firstSwitch.level === 'PASS' ? 'pass' : 'fail',
        detail: firstSwitch.code === undefined ? level : `${level} ${code(firstSwitch.code)}`,
      },
      { name: 'l13-receipt', gates: both, status: receiptAt === null ? 'fail' : 'pass', detail: receiptAt === null ? 'absent' : `recorded ${iso(receiptAt)}` },
      ...prerequisites.map((row) => ({
        name: row.name, gates: [...row.gates], status: row.present ? 'pass' as const : 'fail' as const,
        detail: row.present ? 'present' : 'not built',
      })),
    ],
  };
}

/** Opens the store read-only, or names why it cannot be read; never creates or migrates it. */
function openReadOnly(dbPath: string): { db: DatabaseSync } | { ok: false; reason: string } {
  // A read-only open of a missing file would fail; never create one.
  if (!existsSync(dbPath)) return { ok: false, reason: 'no-store' };
  let db: DatabaseSync;
  try {
    db = openStoreConnection(dbPath, true);
  } catch {
    // The SQLite error can carry the absolute path; the report names the refusal only.
    return { ok: false, reason: 'store-unreadable' };
  }
  let reason: string | null;
  try {
    // A newer schema is a refusal here, where the migrating store would throw.
    reason = readUserVersion(db) > SCHEMA_VERSION ? 'schema-newer' : readOnlySchemaRefusal(db);
  } catch {
    reason = 'store-unreadable';
  }
  if (reason === null) return { db };
  db.close();
  return { ok: false, reason };
}

export function buildCodexStageReport(dbPath: string, deps: CodexStageReportDeps): CodexStageReportResult {
  const opened = openReadOnly(dbPath);
  if (!('db' in opened)) return opened;
  const { db } = opened;
  // One read transaction, so every row in the report comes from one snapshot.
  db.exec('BEGIN');
  try {
    const now = deps.now();
    const pre = preconditions(dbPath, db, now, deps.prerequisites ?? CODEX_STAGE_PREREQUISITES);
    const aliases = new Aliases();
    const log = readCodexStageLogFrom(db);
    const latch = deriveLatch(toStageLog(log));
    const input = readCodexStageInputFrom(db);
    const toStop = (finding: StopFinding): ReportStop => ({
      evidence: finding.pointer, rule: finding.rule, at: iso(finding.ts), row: evidenceRow(db, finding.pointer, log.events),
    });

    const latchSets = log.events.filter((event) => event.kind === 'latch-set');
    const recorded = new Set(latchSets.map((event) => event.evidence));
    // Exactly what the next sweep would record, even when the log is not readable.
    const pending = findSweepStops(log, codexStopEvidenceFrom(db)).filter((finding) => !recorded.has(finding.pointer)).map(toStop);
    const clears = log.events.filter((event) => event.kind === 'latch-clear');

    const evaluated = input === null ? null : evaluateStages(input);
    const switchById = new Map((input?.switches ?? []).map((row) => [row.id, row]));
    const lineageById = new Map((input?.lineage ?? []).map((row) => [row.id, row]));
    const stage = (number: 1 | 2): CodexStageReport['stages'][number] => {
      const result = evaluated === null ? null : number === 1 ? evaluated.stage1 : evaluated.stage2;
      if (result === null) return { stage: number, status: 'unknown', startId: null, frozen: false, confirmed: [], days: [], refreshes: [], stops: [] };
      return {
        stage: number,
        status: result.status,
        startId: result.startId,
        frozen: result.frozen,
        confirmed: result.confirmed.map((id) => {
          const row = switchById.get(id)!;
          return { id, at: iso(row.committedAt ?? row.ts), to: aliases.of(row.toAccount) };
        }),
        days: result.days,
        refreshes: result.refreshes.map((id) => {
          const row = lineageById.get(id)!;
          return { id, account: aliases.of(row.accountId), at: iso(row.ts), by: code(row.by), cause: code(row.cause) };
        }),
        stops: result.stops.map(toStop),
      };
    };

    const report: CodexStageReport = {
      build: { stamp: stampOf(deps.buildStamp === undefined ? readBuildStamp() : deps.buildStamp), flagEnabled: deps.flagEnabled ?? CODEX_SWITCH_COMMAND_ENABLED },
      phase: pre.phase,
      preconditions: pre.rows,
      latch: {
        state: latch.state,
        ...(latch.state === 'unknown' ? { reason: latch.reason } : {}),
        stops: latchSets.map((event) => {
          const evidence = safePointer(event.evidence);
          const cleared = clears.some((clear) => clear.id > event.id && clear.throughId !== null && clear.throughId >= event.id);
          return { id: event.id, at: iso(event.recordedAt), rule: ruleOf(event), evidence, cleared, row: evidenceRow(db, evidence, log.events) };
        }),
        pending,
        clears: clears.map((event) => ({ id: event.id, at: iso(event.recordedAt), throughId: event.throughId, reason: 'recorded' as const })),
      },
      starts: log.events.filter((event) => event.kind === 'stage-start').map((event) => ({
        id: event.id, stage: event.stage, at: iso(event.recordedAt), buildStamp: stampOf(event.buildStamp), flagEnabled: event.flagEnabled,
      })),
      stages: [stage(1), stage(2)],
    };
    const redacted: unknown = JSON.parse(redactJson(report, deps.knownSecrets));
    // redactJson falls back to a bare "[REDACTED]" string when it cannot walk the value.
    if (redacted === null || typeof redacted !== 'object') return { ok: false, reason: 'redaction-failed' };
    return { ok: true, report: redacted as CodexStageReport };
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
}

const STATUS_TEXT: Record<CodexStageReport['stages'][number]['status'], string> = {
  pass: 'PASS', 'not-yet': 'NOT YET', stop: 'STOP', 'not-started': 'NOT STARTED', unknown: 'UNKNOWN',
};

function rowText(row: EvidenceRow): string {
  if ('missing' in row) return `${row.table} row missing`;
  switch (row.table) {
    case 'switch_log': return `switch ${row.id} at ${row.at}: ${row.trigger} ${row.outcome}${row.detail === null ? '' : ` (${row.detail})`}`;
    case 'relogin_events': return `relogin ${row.id} at ${row.at}: ${row.kind}`;
    case 'codex_watch_verdicts': return `watch verdict for switch ${row.switchId} at ${row.at}: ${row.verdict}`;
    case 'codex_stage_events': return `recorded stop ${row.id} at ${row.at}: ${row.rule}, ${row.evidence}`;
  }
}

const stopText = (stop: ReportStop): string => `    ${stop.evidence} ${stop.rule} — ${rowText(stop.row)}`;
const flagText = (flag: boolean | null): string => (flag === null ? 'unknown' : flag ? 'on' : 'off');

export function codexStageReportText(report: CodexStageReport): string[] {
  const lines = [`codex stage report (build ${report.build.stamp ?? 'unknown'}, flag ${flagText(report.build.flagEnabled)}, phase ${report.phase})`, 'Preconditions:'];
  for (const row of report.preconditions) {
    const gates = row.gates.length === 0 ? 'informational' : `stage ${row.gates.join(', ')}`;
    lines.push(`  ${row.status.toUpperCase()} ${row.name} (${gates}): ${row.detail}`);
  }
  const { latch } = report;
  lines.push(latch.state === 'unknown' ? `Latch: latch state unknown (${latch.reason})` : `Latch: ${latch.state}`);
  for (const stop of latch.stops) {
    lines.push(`  stop ${stop.id} at ${stop.at}${stop.cleared ? ' (cleared)' : ''}: ${stop.rule}, ${stop.evidence} — ${rowText(stop.row)}`);
  }
  for (const clear of latch.clears) lines.push(`  clear ${clear.id} at ${clear.at} through stop ${clear.throughId}: reason ${clear.reason}`);
  if (latch.pending.length > 0) {
    lines.push('  not yet recorded by the sweep:');
    for (const stop of latch.pending) lines.push(stopText(stop));
  }
  for (const start of report.starts) {
    lines.push(`Stage ${start.stage} start ${start.id} at ${start.at}: build ${start.buildStamp ?? 'unknown'}, flag ${flagText(start.flagEnabled)}`);
  }
  for (const stage of report.stages) {
    if (stage.status === 'unknown') {
      lines.push(`Stage ${stage.stage}: UNKNOWN (the stage log cannot be read)`);
      continue;
    }
    lines.push(`Stage ${stage.stage}: ${STATUS_TEXT[stage.status]}${stage.frozen ? ' (frozen)' : ''}`
      + ` — ${stage.confirmed.length} confirmed switches on ${stage.days.length} days${stage.stage === 2 ? `, ${stage.refreshes.length} qlb refreshes` : ''}`);
    if (stage.confirmed.length > 0) lines.push(`  confirmed: ${stage.confirmed.map((row) => `${row.id} (${row.to}, ${row.at})`).join(', ')}`);
    if (stage.days.length > 0) lines.push(`  days: ${stage.days.join(', ')}`);
    for (const row of stage.refreshes) lines.push(`  refresh: lineage ${row.id} ${row.account} at ${row.at} by ${row.by} (${row.cause})`);
    if (stage.stops.length > 0) {
      lines.push('  stops:');
      for (const stop of stage.stops) lines.push(stopText(stop));
    }
  }
  return lines;
}

const USAGE = 'usage: qlb codex stage report [--json]';

export function createCodexStageReportCommand(overrides: Partial<CodexStageReportDeps> = {}): CommandDefinition {
  return {
    name: 'codex stage report',
    async execute(args: string[], ctx: CommandContext): Promise<number> {
      if (args.some((arg) => arg !== '--json')) {
        ctx.stderr(USAGE);
        return 2;
      }
      const json = args.includes('--json');
      const result = buildCodexStageReport(ctx.config.dbPath, { now: Date.now, knownSecrets: ctx.knownSecrets(), ...overrides });
      if (!result.ok) {
        if (json) ctx.stdout(JSON.stringify(result));
        else ctx.stderr(`codex stage report refused: ${result.reason}`);
        return 3;
      }
      if (json) ctx.stdout(JSON.stringify(result.report));
      else for (const line of codexStageReportText(result.report)) ctx.stdout(line);
      return 0;
    },
  };
}

const command = createCodexStageReportCommand();
export default command;
