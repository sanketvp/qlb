import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { defaultConfig } from '../src/config';
import { createReportCutoverCommand } from '../src/commands/report-cutover';
import { runExecutingCommand } from '../src/app';
import type { CommandContext } from '../src/registry';
import { openStore } from '../src/store';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 20 * DAY;

function fixture(): { root: string; dbPath: string; output: string[]; context: CommandContext; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'qlb-report-cutover-'));
  const dbPath = join(root, 'qlb.db');
  const store = openStore(dbPath);
  store.close();
  const config = { ...defaultConfig(root), dbPath };
  const output: string[] = [];
  return {
    root, dbPath, output,
    context: { stdout: (line) => output.push(line), stderr: (line) => output.push(line), env: { QLB_TEST_MODE: '1', QLB_HOME: root, HOME: root }, config, loadConfig: () => config, home: root, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [] },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seed(subject: ReturnType<typeof fixture>, options: { piDeferred?: boolean; switches?: number; deadSlots?: string[]; drill?: boolean; healthOverall?: 'PASS' | 'FAIL' } = {}): void {
  const db = new DatabaseSync(subject.dbPath);
  try {
    const cutoverAt = NOW - 15 * DAY;
    const windowEnd = cutoverAt + 7 * DAY;
    db.prepare(`INSERT INTO lifecycle (state, began_at, cutover_at, window_end, drill_began_at) VALUES ('cutover', ?, ?, ?, ?)`)
      .run(cutoverAt, cutoverAt, windowEnd, cutoverAt);
    db.prepare(`INSERT INTO health_log (ts, phase, overall, failing_json, dead_slots_json) VALUES (?, 'cutover', ?, '[]', ?)`)
      .run(cutoverAt + 1, options.healthOverall ?? 'PASS', JSON.stringify(options.deadSlots ?? []));
    for (let index = 0; index < (options.switches ?? 10); index++) {
      db.prepare(`INSERT INTO switch_log (ts, provider, to_account, trigger, outcome, injected) VALUES (?, 'anthropic', ?, 'proactive', 'ok', 0)`)
        .run(cutoverAt + 2 + index, `a-${index}`);
    }
    if (options.drill) {
      for (const [outcome, detail, trigger, error] of [
        ['ok', 'fault-injection:usage-5xx', 'failover', null],
        ['rolled-back', 'fault-injection:fail-step-8', 'manual', null],
        ['refused', 'fault-injection:breaker-rows', 'failover', 'breaker'],
      ]) db.prepare(`INSERT INTO switch_log (ts, provider, to_account, trigger, outcome, injected, detail, error) VALUES (?, 'anthropic', 'drill', ?, ?, 1, ?, ?)`).run(NOW, trigger, outcome, detail, error);
      db.prepare(`INSERT INTO config (key, value) VALUES ('drill.undoDryRunAt', ?)`).run(String(NOW));
    }
    if (options.piDeferred) db.prepare(`INSERT INTO config (key, value) VALUES ('cutover.piDeferredAt', ?)`).run(String(cutoverAt));
  } finally { db.close(); }
}

function run(subject: ReturnType<typeof fixture>): Promise<number | null> {
  return runExecutingCommand({ command: createReportCutoverCommand({ now: () => NOW }), args: ['--json'] }, subject.context);
}

function runText(subject: ReturnType<typeof fixture>): Promise<number | null> {
  return runExecutingCommand({ command: createReportCutoverCommand({ now: () => NOW }), args: [] }, subject.context);
}

function setPiMigrated(db: DatabaseSync): void {
  for (const provider of ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter']) {
    db.prepare(`INSERT INTO config (key, value) VALUES (?, 'migrated')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`pi.${provider}.state`);
  }
}

test('refuses before the window ends and when a rollback is recorded', async () => {
  const subject = fixture();
  try {
    seed(subject, { drill: true });
    const db = new DatabaseSync(subject.dbPath);
    db.prepare('UPDATE lifecycle SET window_end = ?').run(NOW + 1);
    db.close();
    assert.equal(await run(subject), 3);
    assert.match(subject.output[0]!, /window-not-ended/);
    subject.output.length = 0;
    const db2 = new DatabaseSync(subject.dbPath);
    db2.prepare('UPDATE lifecycle SET window_end = ?, rollback_at = ?').run(NOW - 1, NOW);
    db2.close();
    assert.equal(await run(subject), 3);
    assert.match(subject.output[0]!, /rollback-recorded/);
  } finally { subject.close(); }
});

test('ten non-injected automatic rows pass AC19 despite an injected rollback in the window', async () => {
  const subject = fixture();
  try {
    seed(subject, { drill: true });
    const db = new DatabaseSync(subject.dbPath);
    db.prepare(`INSERT INTO switch_log (ts, provider, to_account, trigger, outcome, injected) VALUES (?, 'anthropic', 'drill', 'failover', 'rolled-back', 1)`)
      .run(NOW - 14 * DAY);
    const injected = db.prepare('SELECT id FROM switch_log ORDER BY id DESC LIMIT 1').get() as { id: number };
    db.close();
    assert.equal(await run(subject), 1, 'strict Pi/Codex rows still fail without the marker');
    const report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'anthropic:automatic-switches').status, 'PASS');
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'AC19:anthropic-switches').status, 'PASS');
    const injectedRow = report.rows.find((value: { name: string }) => value.name === 'injected:switches');
    assert.equal(injectedRow.status, 'PASS');
    assert.match(injectedRow.message, new RegExp(`rolled-back#${injected.id}`));
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'codex:L13-switch').code, 'codex-coverage-missing');
    assert.equal(report.rows.filter((value: { name: string }) => value.name.startsWith('pi:')).every((value: { status: string; code: string }) => value.status === 'FAIL' && value.code === 'pi-deferred'), true);
  } finally { subject.close(); }
});

test('nine rows extend once, and a later miss fails extended-once', async () => {
  const subject = fixture();
  try {
    seed(subject, { switches: 9, drill: true, piDeferred: true });
    const db = new DatabaseSync(subject.dbPath);
    db.prepare(`INSERT INTO switch_log (ts, provider, to_account, trigger, outcome, injected) VALUES (?, 'anthropic', 'injected', 'proactive', 'ok', 1)`)
      .run(NOW - 9 * DAY);
    db.prepare(`INSERT INTO switch_log (ts, provider, to_account, trigger, outcome, injected) VALUES (?, 'anthropic', 'manual', 'manual', 'ok', 0)`)
      .run(NOW - 9 * DAY);
    db.close();
    assert.equal(await run(subject), 1);
    let report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'anthropic:automatic-switches').status, 'EXTEND');
    assert.equal(report.lifecycle.windowEnd, NOW - 15 * DAY + 14 * DAY);
    assert.equal(report.lifecycle.extendedAt, NOW);
    subject.output.length = 0;
    assert.equal(await run(subject), 1);
    report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'anthropic:automatic-switches').code, 'extended-once');
  } finally { subject.close(); }
});

test('the deferred marker makes missing Pi and Codex coverage advisory but not drill evidence', async () => {
  const subject = fixture();
  try {
    seed(subject, { piDeferred: true, drill: true });
    assert.equal(await run(subject), 0);
    const report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'codex:L13-switch').status, 'DEFERRED');
    assert.equal(report.rows.filter((value: { name: string }) => value.name.startsWith('pi:')).every((value: { status: string }) => value.status === 'DEFERRED'), true);
  } finally { subject.close(); }
});

test('a deferred marker from another lifecycle does not soften strict coverage', async () => {
  const subject = fixture();
  try {
    seed(subject, { piDeferred: true, drill: true });
    const db = new DatabaseSync(subject.dbPath);
    db.prepare("UPDATE config SET value = ? WHERE key = 'cutover.piDeferredAt'").run(String(NOW - 16 * DAY));
    db.close();
    assert.equal(await run(subject), 1);
    const report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'codex:L13-switch').code, 'codex-coverage-missing');
    assert.equal(report.rows.filter((value: { name: string }) => value.name.startsWith('pi:')).every((value: { status: string }) => value.status === 'FAIL'), true);
  } finally { subject.close(); }
});

test('strict Pi and Codex coverage passes only with a valid L13 receipt and real switch', async () => {
  const subject = fixture();
  try {
    seed(subject, { drill: true });
    const db = new DatabaseSync(subject.dbPath);
    setPiMigrated(db);
    db.prepare("INSERT INTO config (key, value) VALUES ('codex.l13VerifiedAt', ?)").run(String(NOW));
    db.prepare(`INSERT INTO switch_log (ts, provider, from_account, to_account, trigger, outcome, injected)
      VALUES (?, 'openai-codex', 'from', 'to', 'proactive', 'ok', 0)`).run(NOW - 9 * DAY);
    db.close();
    assert.equal(await run(subject), 0);
    const report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'codex:L13-switch').status, 'PASS');
    assert.equal(report.rows.filter((value: { name: string }) => value.name.startsWith('pi:')).every((value: { status: string }) => value.status === 'PASS'), true);
  } finally { subject.close(); }
});

test('an invalid L13 receipt does not satisfy strict Codex coverage', async () => {
  const subject = fixture();
  try {
    seed(subject, { drill: true });
    const db = new DatabaseSync(subject.dbPath);
    setPiMigrated(db);
    db.prepare("INSERT INTO config (key, value) VALUES ('codex.l13VerifiedAt', '')").run();
    db.prepare(`INSERT INTO switch_log (ts, provider, from_account, to_account, trigger, outcome, injected)
      VALUES (?, 'openai-codex', 'from', 'to', 'proactive', 'ok', 0)`).run(NOW - 9 * DAY);
    db.close();
    assert.equal(await run(subject), 1);
    const report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'codex:L13-switch').code, 'codex-coverage-missing');
  } finally { subject.close(); }
});

test('no health log in the window fails AC21 rather than passing', async () => {
  const subject = fixture();
  try {
    seed(subject, { piDeferred: true, drill: true });
    const db = new DatabaseSync(subject.dbPath);
    db.exec('DELETE FROM health_log');
    db.close();
    assert.equal(await run(subject), 1);
    const report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'AC21:health-log').code, 'no-health-log');
  } finally { subject.close(); }
});

test('text and JSON report output redact token-shaped values', async () => {
  const subject = fixture();
  const secret = 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  try {
    seed(subject, { piDeferred: true, deadSlots: [secret], drill: true });
    assert.equal(await run(subject), 1);
    assert.doesNotMatch(subject.output.join('\n'), new RegExp(secret));
    subject.output.length = 0;
    const code = await runExecutingCommand({ command: createReportCutoverCommand({ now: () => NOW }), args: [] }, subject.context);
    assert.equal(code, 1);
    assert.doesNotMatch(subject.output.join('\n'), new RegExp(secret));
  } finally { subject.close(); }
});

test('a dead health-log slot fails AC21 even when its overall is FAIL for another reason', async () => {
  const subject = fixture();
  try {
    seed(subject, { piDeferred: true, deadSlots: ['dead-slot'], drill: true, healthOverall: 'FAIL' });
    assert.equal(await run(subject), 1);
    const report = JSON.parse(subject.output[0]!);
    const deadSlots = report.rows.find((value: { name: string }) => value.name === 'AC21:dead-slots');
    assert.equal(deadSlots.code, 'dead-slot-in-window');
    assert.match(deadSlots.message, new RegExp(`dead-slot@${NOW - 15 * DAY + 1}`));
  } finally { subject.close(); }
});

test('correctness failures prevent consuming the one permitted coverage extension', async () => {
  const subject = fixture();
  try {
    seed(subject, { piDeferred: true, switches: 9, drill: true });
    const db = new DatabaseSync(subject.dbPath);
    db.prepare(`INSERT INTO switch_log (ts, provider, to_account, trigger, outcome, injected) VALUES (?, 'anthropic', 'failed', 'auto', 'rolled-back', 0)`)
      .run(NOW - 14 * DAY);
    db.close();
    assert.equal(await run(subject), 1);
    const report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'anthropic:automatic-switches').status, 'FAIL');
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'anthropic:automatic-switches').code, 'insufficient-anthropic-coverage');
    assert.equal(report.lifecycle.windowEnd, NOW - 8 * DAY);
    assert.equal(report.lifecycle.extendedAt, null);
  } finally { subject.close(); }
});

test('missing fire-drill facts fail the report', async () => {
  const subject = fixture();
  try {
    seed(subject, { piDeferred: true });
    assert.equal(await run(subject), 1);
    const report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'drill:four-facts').code, 'drill-rows-missing');
  } finally { subject.close(); }
});

test('breaker seed rows do not satisfy the fire-drill breaker fact', async () => {
  const subject = fixture();
  try {
    seed(subject, { piDeferred: true, drill: true });
    const db = new DatabaseSync(subject.dbPath);
    db.prepare(`UPDATE switch_log SET detail = 'fault-injection:breaker-rows:seed' WHERE detail = 'fault-injection:breaker-rows'`)
      .run();
    db.close();
    assert.equal(await run(subject), 1);
    const report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'drill:four-facts').code, 'drill-rows-missing');
  } finally { subject.close(); }
});

test('republish failures do not count against AC19', async () => {
  const subject = fixture();
  try {
    seed(subject, { piDeferred: true, drill: true });
    const db = new DatabaseSync(subject.dbPath);
    db.prepare(`INSERT INTO switch_log (ts, provider, to_account, trigger, outcome, injected, detail)
      VALUES (?, 'anthropic', 'republish', 'manual', 'rolled-back', 0, 'republish:step-7')`).run(NOW - 9 * DAY);
    db.close();
    assert.equal(await run(subject), 0);
    const report = JSON.parse(subject.output[0]!);
    assert.equal(report.rows.find((value: { name: string }) => value.name === 'AC19:anthropic-switches').status, 'PASS');
  } finally { subject.close(); }
});

test('relogin evidence fails only for Anthropic and Codex events', async () => {
  const subject = fixture();
  try {
    seed(subject, { piDeferred: true, drill: true });
    const db = new DatabaseSync(subject.dbPath);
    for (const [provider, kind, detail, evidence] of [
      ['anthropic', 'dead', 'dead', 'dead'],
      ['openai-codex', 'external-login', 'unattributed-rotation', 'unattributed-rotation'],
      ['xai', 'dead', 'dead', 'dead'],
    ]) db.prepare(`INSERT INTO relogin_events (ts, provider, kind, detail, evidence) VALUES (?, ?, ?, ?, ?)`)
      .run(NOW - 9 * DAY, provider, kind, detail, evidence);
    db.close();
    assert.equal(await run(subject), 1);
    const report = JSON.parse(subject.output[0]!);
    const relogins = report.rows.find((value: { name: string }) => value.name === 'AC18:relogins');
    assert.equal(relogins.code, 'relogin-in-window');
    assert.match(relogins.message, /anthropic:dead:dead/);
    assert.match(relogins.message, /openai-codex:external-login:unattributed-rotation/);
    assert.match(relogins.message, /soft unattributed-rotation: 1/);
    assert.doesNotMatch(relogins.message, /xai/);
  } finally { subject.close(); }
});

test('text output includes lifecycle dates and report codes', async () => {
  const subject = fixture();
  try {
    seed(subject, { switches: 9, piDeferred: true, drill: true });
    assert.equal(await runText(subject), 1);
    assert.match(subject.output[0]!, new RegExp(`windowEnd=${NOW - DAY}`));
    assert.match(subject.output[0]!, new RegExp(`extendedAt=${NOW}`));
    assert.equal(subject.output.some((line) => line.includes('[insufficient-anthropic-coverage]')), true);
    assert.equal(subject.output.some((line) => line.includes('[codex-deferred]')), true);
  } finally { subject.close(); }
});
