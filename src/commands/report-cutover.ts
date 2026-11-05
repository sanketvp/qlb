import { DatabaseSync } from 'node:sqlite';

import { codexL13ReceiptAt } from '../codex-l13-receipt';
import { configValue, drillRowsPresent, extendWindow, phase, PI_PROVIDERS, type LifecycleRow } from '../lifecycle';
import { redactSecrets } from '../redact';
import { reloginsInWindow } from '../relogin';
import { openStore } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

export type CutoverReportStatus = 'PASS' | 'FAIL' | 'EXTEND' | 'DEFERRED';
export interface CutoverReportRow {
  group: 'correctness' | 'coverage';
  name: string;
  status: CutoverReportStatus;
  code?: string;
  message: string;
}
export interface CutoverReport {
  ok: boolean;
  lifecycle: { id: number; state: string; cutoverAt: number; windowEnd: number; extendedAt: number | null };
  rows: CutoverReportRow[];
}

export interface ReportCutoverCommandDeps { now?: () => number; }

function row(group: CutoverReportRow['group'], name: string, status: CutoverReportStatus, message: string, code?: string): CutoverReportRow {
  return { group, name, status, ...(code ? { code } : {}), message };
}

function reportRows(db: DatabaseSync, lifecycle: LifecycleRow, now: number): CutoverReportRow[] {
  const start = lifecycle.cutoverAt!;
  const end = lifecycle.windowEnd!;
  const inWindow = [start, end];
  const rows: CutoverReportRow[] = [];

  const badSwitches = db.prepare(`SELECT id, outcome FROM switch_log WHERE provider = 'anthropic' AND injected = 0
    AND outcome IN ('rolled-back', 'failed') AND (detail IS NULL OR detail NOT LIKE 'republish%')
    AND ts >= ? AND ts <= ? ORDER BY ts, id`).all(...inWindow) as Array<{ id: number; outcome: string }>;
  rows.push(badSwitches.length === 0
    ? row('correctness', 'AC19:anthropic-switches', 'PASS', 'no non-injected failed or rolled-back Anthropic switches')
    : row('correctness', 'AC19:anthropic-switches', 'FAIL', `non-injected failed or rolled-back Anthropic switches: ${badSwitches.map((value) => `${value.outcome}#${value.id}`).join(', ')}`, 'anthropic-switch-failed'));

  const health = db.prepare('SELECT id, ts, overall, dead_slots_json FROM health_log WHERE ts >= ? AND ts <= ? ORDER BY ts, id')
    .all(...inWindow) as Array<{ id: number; ts: number; overall: string; dead_slots_json: string }>;
  if (health.length === 0) rows.push(row('correctness', 'AC21:health-log', 'FAIL', 'no health log row in cutover window', 'no-health-log'));
  else rows.push(row('correctness', 'AC21:health-log', 'PASS', `${health.length} health log row(s) in cutover window`));
  const dead = health.flatMap((value) => {
    try {
      const slots = JSON.parse(value.dead_slots_json);
      return Array.isArray(slots) && slots.length > 0 ? slots.map((slot) => ({ slot: String(slot), ts: value.ts, id: value.id })) : [];
    } catch { return [{ slot: 'unreadable', ts: value.ts, id: value.id }]; }
  });
  rows.push(dead.length === 0
    ? row('correctness', 'AC21:dead-slots', 'PASS', 'no health log row records a dead slot')
    : row('correctness', 'AC21:dead-slots', 'FAIL', `dead slot in window: ${dead.map((value) => `${value.slot}@${value.ts}`).join(', ')}`, 'dead-slot-in-window'));

  const relogins = reloginsInWindow(db, { start, end })
    .filter((value) => value.provider === 'anthropic' || value.provider === 'openai-codex');
  rows.push(relogins.length === 0
    ? row('correctness', 'AC18:relogins', 'PASS', 'no Anthropic or Codex relogin events')
    : row('correctness', 'AC18:relogins', 'FAIL', `relogin events: ${relogins.map((value) => `#${value.id}@${value.ts} ${value.provider}:${value.kind}${value.detail ? `:${value.detail}` : ''}${value.evidence ? ` [${value.evidence}]` : ''}`).join(', ')}`, 'relogin-in-window'));

  const automatic = db.prepare(`SELECT count(*) AS count FROM switch_log WHERE provider = 'anthropic' AND outcome = 'ok'
    AND injected = 0 AND trigger <> 'manual' AND (detail IS NULL OR detail NOT LIKE 'republish%')
    AND ts >= ? AND ts <= ?`).get(...inWindow) as { count: number };
  const correctnessPass = rows.every((value) => value.group !== 'correctness' || value.status === 'PASS');
  if (automatic.count >= 10) rows.push(row('coverage', 'anthropic:automatic-switches', 'PASS', `${automatic.count} non-injected automatic Anthropic switches`));
  else if (lifecycle.extendedAt == null && correctnessPass) rows.push(row('coverage', 'anthropic:automatic-switches', 'EXTEND', `${automatic.count}/10 non-injected automatic Anthropic switches; cutover window extended once`, 'insufficient-anthropic-coverage'));
  else if (lifecycle.extendedAt == null) rows.push(row('coverage', 'anthropic:automatic-switches', 'FAIL', `${automatic.count}/10 non-injected automatic Anthropic switches; correctness checks must pass before extending the cutover window`, 'insufficient-anthropic-coverage'));
  else rows.push(row('coverage', 'anthropic:automatic-switches', 'FAIL', `${automatic.count}/10 non-injected automatic Anthropic switches after the one extension`, 'extended-once'));

  const codexVerified = codexL13ReceiptAt(configValue(db, 'codex.l13VerifiedAt')) != null;
  const codexSwitches = db.prepare(`SELECT count(*) AS count FROM switch_log WHERE provider = 'openai-codex' AND outcome = 'ok'
    AND injected = 0 AND from_account IS NOT NULL AND from_account <> to_account AND ts >= ? AND ts <= ?`).get(...inWindow) as { count: number };
  const codexPass = codexVerified && codexSwitches.count >= 1;
  const piDeferred = configValue(db, 'cutover.piDeferredAt') === String(lifecycle.cutoverAt);
  rows.push(codexPass
    ? row('coverage', 'codex:L13-switch', 'PASS', 'L13 verification and a non-injected Codex switch are recorded')
    : piDeferred
      ? row('coverage', 'codex:L13-switch', 'DEFERRED', 'Codex L13 verification or non-injected switch coverage deliberately deferred', 'codex-deferred')
      : row('coverage', 'codex:L13-switch', 'FAIL', 'missing Codex L13 verification or non-injected switch coverage', 'codex-coverage-missing'));

  const drill = drillRowsPresent(db, lifecycle.drillBeganAt ?? start, now);
  rows.push(drill.ok
    ? row('coverage', 'drill:four-facts', 'PASS', 'all four fire-drill facts are present')
    : row('coverage', 'drill:four-facts', 'FAIL', `missing fire-drill facts: ${drill.missing.join(', ')}`, 'drill-rows-missing'));

  const injected = db.prepare(`SELECT id, outcome, detail FROM switch_log
    WHERE injected = 1 AND ts >= ? AND ts <= ? ORDER BY ts, id`).all(start, now) as Array<{ id: number; outcome: string; detail: string | null }>;
  rows.push(row('coverage', 'injected:switches', 'PASS', injected.length === 0
    ? 'no injected switch rows'
    : `injected switch rows: ${injected.map((value) => `${value.outcome}#${value.id}${value.detail ? `:${value.detail}` : ''}`).join(', ')}`));

  for (const provider of PI_PROVIDERS) {
    const state = configValue(db, `pi.${provider}.state`);
    const migrated = state === 'migrated' || state === 'not-applicable';
    rows.push(migrated
      ? row('coverage', `pi:${provider}`, 'PASS', `Pi ${provider} state is ${state}`)
      : piDeferred
        ? row('coverage', `pi:${provider}`, 'DEFERRED', `Pi ${provider} migration deliberately deferred`, 'pi-deferred')
        : row('coverage', `pi:${provider}`, 'FAIL', `Pi ${provider} migration is missing`, 'pi-deferred'));
  }
  return rows;
}

export function buildCutoverReport(db: DatabaseSync, lifecycle: LifecycleRow, now: number): CutoverReport {
  const rows = reportRows(db, lifecycle, now);
  return {
    ok: rows.every((value) => value.status === 'PASS' || value.status === 'DEFERRED'),
    lifecycle: { id: lifecycle.id, state: lifecycle.state, cutoverAt: lifecycle.cutoverAt!, windowEnd: lifecycle.windowEnd!, extendedAt: lifecycle.extendedAt },
    rows,
  };
}

function parse(args: string[]): boolean | null {
  return args.length === 0 ? false : args.length === 1 && args[0] === '--json' ? true : null;
}

function formatText(report: CutoverReport): string[] {
  return [
    `lifecycle cutoverAt=${new Date(report.lifecycle.cutoverAt).toISOString()} windowEnd=${new Date(report.lifecycle.windowEnd).toISOString()} extendedAt=${report.lifecycle.extendedAt === null ? 'none' : new Date(report.lifecycle.extendedAt).toISOString()}`,
    ...report.rows.map((value) => `${value.status} ${value.group} ${value.name}${value.code ? ` [${value.code}]` : ''}: ${value.message}`),
  ];
}

async function execute(args: string[], ctx: CommandContext, deps: ReportCutoverCommandDeps): Promise<number> {
  const json = parse(args);
  if (json == null) { ctx.stderr('usage: qlb report cutover [--json]'); return 2; }
  const store = openStore(ctx.config.dbPath);
  try {
    const lifecycle = phase(store);
    if (lifecycle.rollbackAt != null) { ctx.stderr('report cutover refused: rollback-recorded'); return 3; }
    if (lifecycle.cutoverAt == null || lifecycle.windowEnd == null) {
      ctx.stderr('report cutover refused: no-open-lifecycle'); return 3;
    }
    const now = (deps.now ?? Date.now)();
    if (now < lifecycle.windowEnd) { ctx.stderr(`report cutover refused: window-not-ended; windowEnd=${new Date(lifecycle.windowEnd).toISOString()}`); return 3; }
    const db = (store as unknown as { db: DatabaseSync }).db;
    const report = buildCutoverReport(db, lifecycle, now);
    if (report.rows.some((value) => value.status === 'EXTEND')) {
      const extended = extendWindow(store, now);
      if (!extended.ok) { ctx.stderr(`report cutover refused: ${extended.code}`); return 3; }
      report.lifecycle.windowEnd = extended.row!.windowEnd!;
      report.lifecycle.extendedAt = extended.row!.extendedAt;
    }
    const redacted = JSON.parse(redactSecrets(JSON.stringify(report), ctx.knownSecrets())) as CutoverReport;
    if (json) ctx.stdout(JSON.stringify(redacted));
    else for (const line of formatText(redacted)) ctx.stdout(line);
    return redacted.ok ? 0 : 1;
  } finally { store.close(); }
}

export function createReportCutoverCommand(deps: ReportCutoverCommandDeps = {}): CommandDefinition {
  return { name: 'report cutover', execute: (args, ctx) => execute(args, ctx, deps) };
}

export default createReportCutoverCommand();
