import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { AUTO_BINDINGS } from '../src/auto';
import { CODEX_STAGE_PREREQUISITES } from '../src/commands/codex-stage';
import command, { buildCodexStageReport, codexStageReportText, createCodexStageReportCommand, type CodexStageReport } from '../src/commands/codex-stage-report';
import type { CommandContext } from '../src/registry';
import { sweepCodexStops } from '../src/codex-stop';
import { openStore, type Store } from '../src/store';

const PROVIDER = 'openai-codex';
/** Noon local time on one day, so a few hours either way stay on the same local date. */
const DAY1 = new Date(2026, 10, 20, 12, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

interface Fixture {
  root: string;
  dbPath: string;
  store: Store;
  db: DatabaseSync;
}

function fixture(phase = 'cutover'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-stage-report-'));
  const dbPath = join(root, 'qlb.db');
  const store = openStore(dbPath);
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare('INSERT INTO lifecycle (state, began_at, cutover_at) VALUES (?, ?, ?)').run(phase, DAY1 - 30 * DAY_MS, DAY1 - 20 * DAY_MS);
  return { root, dbPath, store, db };
}

function start(f: Fixture, stage: 1 | 2, at: number, detail: unknown = { allow: [] }, buildStamp = 'build-abc', flagEnabled = true): number {
  const id = f.store.appendCodexStageEvent({ kind: 'stage-start', now: at, lifecycleId: 1, buildStamp, flagEnabled, stage, detail });
  assert.ok(id !== null);
  return id;
}

function closeStage(f: Fixture, stage: 1 | 2, at: number, frozenStatus: string): void {
  f.store.appendCodexStageEvent({ kind: 'stage-close', now: at, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, stage, detail: { frozenStatus } });
}

/** A committed Codex switch with a confirmed (or other) watch verdict; returns its switch_log id. */
function confirmedSwitch(f: Fixture, at: number, trigger = 'manual', to = 'user-b:acct', verdict = 'confirmed'): number {
  const result = f.db.prepare(`INSERT INTO switch_log (ts, provider, from_account, to_account, trigger, outcome, committed_at, published_at)
    VALUES (?, ?, 'user-a:acct', ?, ?, 'ok', ?, ?)`).run(at, PROVIDER, to, trigger, at, at);
  const id = Number(result.lastInsertRowid);
  f.store.insertCodexWatchVerdict({ switchId: id, verdict: verdict as never, now: at + 300_000 });
  return id;
}

function relogin(f: Fixture, at: number, kind = 'wiped', accountId = 'user-a:acct'): number {
  return f.store.recordRelogin({ ts: at, provider: PROVIDER, accountId, kind });
}

function lineage(f: Fixture, at: number, by: string, cause: string, accountId = 'user-b:acct'): number {
  return Number(f.db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, from_fp, to_fp, cause, by)
    VALUES (?, ?, ?, 'fp-old', 'fp-new', ?, ?)`).run(at, PROVIDER, accountId, cause, by).lastInsertRowid);
}

/**
 * Every entry in the store's directory, by name, with each file's bytes (a
 * directory shows as its listing). A read-only open of a WAL database leaves
 * SQLite's shared-memory index (`-shm`) and an empty `-wal`; as elsewhere in
 * this suite those are not store state, but a `-wal` with any content is.
 */
function snapshot(f: Fixture): Map<string, string> {
  const walk = (dir: string, prefix: string): Array<[string, string]> => readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.endsWith('-shm') && !(entry.name.endsWith('-wal') && statSync(join(dir, entry.name)).size === 0))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry): Array<[string, string]> => entry.isDirectory()
      ? [[`${prefix}${entry.name}/`, 'dir'], ...walk(join(dir, entry.name), `${prefix}${entry.name}/`)]
      : [[`${prefix}${entry.name}`, readFileSync(join(dir, entry.name)).toString('base64')]]);
  return new Map(walk(f.root, ''));
}

function finish(f: Fixture): Map<string, string> {
  f.store.close();
  return snapshot(f);
}

function report(f: Fixture, now = DAY1 + 10 * DAY_MS): CodexStageReport {
  const result = buildCodexStageReport(f.dbPath, { now: () => now, knownSecrets: [] });
  assert.ok(result.ok, JSON.stringify(result));
  return result.report;
}

function ctx(dbPath: string, secrets: string[] = []): { ctx: CommandContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    ctx: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line), env: {}, config: { dbPath }, knownSecrets: () => secrets } as unknown as CommandContext,
  };
}

const stageOf = (r: CodexStageReport, stage: 1 | 2) => r.stages.find((row) => row.stage === stage)!;

describe('qlb codex stage report', () => {
  it('AE5: with a recorded stop it shows STOP with the evidence row, and the database is byte-identical afterwards', async () => {
    const f = fixture();
    try {
      start(f, 1, DAY1);
      const reloginId = relogin(f, DAY1 + 1_000);
      const stopId = f.store.appendCodexStageEvent({ kind: 'latch-set', now: DAY1 + 2_000, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true,
        evidence: `relogin_events:${reloginId}`, detail: { rule: 'forced-relogin' } });
      const before = finish(f);
      const c = ctx(f.dbPath);
      assert.equal(await command.execute?.(['--json'], c.ctx), 0, c.err.join('\n'));
      const text = ctx(f.dbPath);
      assert.equal(await command.execute?.([], text.ctx), 0, text.err.join('\n'));
      assert.deepEqual(snapshot(f), before, 'the report wrote nothing');

      const r = JSON.parse(c.out[0]) as CodexStageReport;
      assert.equal(stageOf(r, 1).status, 'stop');
      assert.equal(r.latch.state, 'latched');
      const relRow = { table: 'relogin_events', id: reloginId, at: new Date(DAY1 + 1_000).toISOString(), kind: 'wiped' };
      assert.deepEqual(r.latch.stops, [{ id: stopId, at: new Date(DAY1 + 2_000).toISOString(), rule: 'forced-relogin', evidence: `relogin_events:${reloginId}`, cleared: false, row: relRow }]);
      assert.deepEqual(r.latch.pending, []);
      // The run ends at its first stop, the relogin; the latch-set recorded after it is listed under the latch.
      assert.deepEqual(stageOf(r, 1).stops, [{ evidence: `relogin_events:${reloginId}`, rule: 'forced-relogin', at: relRow.at, row: relRow }]);
      assert.ok(text.out.some((line) => line.startsWith('Stage 1: STOP')), text.out.join('\n'));
      assert.ok(text.out.some((line) => line.includes(`relogin_events:${reloginId}`) && line.includes('wiped')), text.out.join('\n'));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('a stop the sweep has not recorded shows as STOP and as pending, and no latch-set row is written', () => {
    const f = fixture();
    try {
      start(f, 1, DAY1);
      const reloginId = relogin(f, DAY1 + 1_000, 'identity-replaced');
      const before = finish(f);
      const r = report(f);
      assert.deepEqual(snapshot(f), before);
      assert.equal(stageOf(r, 1).status, 'stop');
      assert.equal(r.latch.state, 'armed');
      assert.deepEqual(r.latch.stops, []);
      assert.deepEqual(r.latch.pending.map((stop) => [stop.evidence, stop.rule]), [[`relogin_events:${reloginId}`, 'forced-relogin']]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('a stop row from before the first stage start is not pending and does not stop Stage 1', () => {
    const f = fixture();
    try {
      relogin(f, DAY1 - 1_000);
      start(f, 1, DAY1);
      finish(f);
      const r = report(f);
      assert.deepEqual(r.latch.pending, []);
      assert.equal(stageOf(r, 1).status, 'not-yet');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('AE1: six confirmed manual switches on one local date leave Stage 1 not yet, with the switch ids and the one date', () => {
    const f = fixture();
    try {
      start(f, 1, DAY1 - 60_000);
      const ids = [0, 1, 2, 3, 4, 5].map((i) => confirmedSwitch(f, DAY1 + i * 60_000));
      finish(f);
      const r = report(f);
      assert.ok(codexStageReportText(r).includes('Stage 1: NOT YET — 6 confirmed switches on 1 days'), codexStageReportText(r).join('\n'));
      const s1 = stageOf(r, 1);
      assert.equal(s1.status, 'not-yet');
      assert.deepEqual(s1.confirmed.map((row) => row.id), ids);
      assert.equal(s1.days.length, 1);
      assert.equal(s1.frozen, false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('AE8: a Stage 2 stop still shows Stage 1 as passed', () => {
    const f = fixture();
    try {
      start(f, 1, DAY1 - DAY_MS);
      closeStage(f, 1, DAY1 - 1_000, 'pass');
      start(f, 2, DAY1, { allow: [], frozenStatus: 'pass' });
      const reloginId = relogin(f, DAY1 + 1_000);
      f.store.appendCodexStageEvent({ kind: 'latch-set', now: DAY1 + 2_000, lifecycleId: 1, buildStamp: null, flagEnabled: true,
        evidence: `relogin_events:${reloginId}`, detail: { rule: 'forced-relogin' } });
      finish(f);
      const r = report(f);
      assert.equal(r.latch.state, 'latched');
      assert.deepEqual([stageOf(r, 1).status, stageOf(r, 1).frozen], ['pass', true]);
      assert.equal(stageOf(r, 2).status, 'stop');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('a Stage 2 report lists the counted qlb-auto post lineage rows by alias; stash-adopt and qlb-cli rows are not counted', () => {
    const f = fixture();
    try {
      start(f, 2, DAY1, { allow: [], frozenStatus: 'pass' });
      const switchId = confirmedSwitch(f, DAY1 + 1_000, 'auto');
      const counted = lineage(f, DAY1 + 5_000, 'qlb-auto', 'post');
      lineage(f, DAY1 + 6_000, 'qlb-auto', 'stash-adopt');
      lineage(f, DAY1 + 7_000, 'qlb-cli', 'post');
      finish(f);
      const s2 = stageOf(report(f), 2);
      assert.deepEqual(s2.confirmed, [{ id: switchId, at: new Date(DAY1 + 1_000).toISOString(), to: 'account-01' }]);
      assert.deepEqual(s2.refreshes, [{ id: counted, account: 'account-01', at: new Date(DAY1 + 5_000).toISOString(), by: 'qlb-auto', cause: 'post' }]);
      const text = codexStageReportText(report(f));
      assert.ok(text.includes(`  refresh: lineage ${counted} account-01 at ${new Date(DAY1 + 5_000).toISOString()} by qlb-auto (post)`), text.join('\n'));
      assert.ok(text.some((line) => line.startsWith('Stage 2: NOT YET — 1 confirmed switches on 1 days, 1 qlb refreshes')), text.join('\n'));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('shows the build stamp and flag value of each stage start', () => {
    const f = fixture();
    try {
      const sha = 'e436c3a3e08faab0ddb766ef77a3d2262a261910';
      const first = start(f, 1, DAY1, { allow: [] }, JSON.stringify({ sha, dirty: true, buildDigest: 'f'.repeat(64) }), false);
      const second = start(f, 2, DAY1 + 1_000, { allow: [], frozenStatus: 'pass' }, 'a1b2c3d4');
      const third = start(f, 2, DAY1 + 2_000, { allow: [], frozenStatus: 'pass' }, 'chatgpt-user-7f3a9c');
      finish(f);
      const r = report(f);
      assert.deepEqual(r.starts, [
        { id: first, stage: 1, at: new Date(DAY1).toISOString(), buildStamp: `${sha}-dirty`, flagEnabled: false },
        { id: second, stage: 2, at: new Date(DAY1 + 1_000).toISOString(), buildStamp: 'a1b2c3d4', flagEnabled: true },
        { id: third, stage: 2, at: new Date(DAY1 + 2_000).toISOString(), buildStamp: 'unrecognized', flagEnabled: true },
      ]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('with today\'s code the auto-tick, decide-and-switch and receipt-writer preconditions fail, and so does the receipt', () => {
    const f = fixture();
    try {
      finish(f);
      const pre = Object.fromEntries(report(f).preconditions.map((row) => [row.name, row]));
      assert.deepEqual(Object.keys(pre), ['lifecycle-cutover', 'codex-first-switch-pass', 'l13-receipt', 'auto-tick-wired', 'decide-and-switch-tick', 'l13-receipt-writer']);
      assert.deepEqual([pre['lifecycle-cutover'].status, pre['lifecycle-cutover'].gates], ['pass', [1, 2]]);
      assert.deepEqual([pre['l13-receipt'].status, pre['l13-receipt'].gates], ['fail', [1, 2]]);
      assert.deepEqual([pre['auto-tick-wired'].status, pre['auto-tick-wired'].gates], ['fail', [1, 2]]);
      assert.deepEqual([pre['decide-and-switch-tick'].status, pre['decide-and-switch-tick'].gates], ['fail', [2]]);
      assert.deepEqual([pre['l13-receipt-writer'].status, pre['l13-receipt-writer'].gates], ['fail', []]);
      assert.deepEqual(pre['codex-first-switch-pass'].gates, [1, 2]);
      // The check's level and code, never `unrecognized` for a real level.
      assert.match(pre['codex-first-switch-pass'].detail, /^(PASS|WARN|FAIL)( [a-z][a-z0-9-]*)?$/);
      assert.equal(pre['codex-first-switch-pass'].status, pre['codex-first-switch-pass'].detail.startsWith('PASS') ? 'pass' : 'fail');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('the auto-tick precondition follows AUTO_BINDINGS, and every prerequisite comes from the stage command\'s table', () => {
    const f = fixture();
    try {
      finish(f);
      const pre = report(f).preconditions;
      const autoTick = CODEX_STAGE_PREREQUISITES.find((row) => row.name === 'auto-tick-wired');
      assert.equal(autoTick?.present, (AUTO_BINDINGS as readonly string[]).includes(PROVIDER));
      for (const row of CODEX_STAGE_PREREQUISITES) {
        assert.equal(pre.find((entry) => entry.name === row.name)?.status, row.present ? 'pass' : 'fail', row.name);
      }
      const stub = buildCodexStageReport(f.dbPath, { now: () => DAY1, knownSecrets: [],
        prerequisites: CODEX_STAGE_PREREQUISITES.map((row) => ({ ...row, present: true })) });
      assert.ok(stub.ok);
      assert.equal(stub.report.preconditions.find((row) => row.name === 'auto-tick-wired')?.status, 'pass');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('marks the lifecycle precondition failing outside cutover', () => {
    const f = fixture('cutting-over');
    try {
      finish(f);
      const lifecycle = report(f).preconditions.find((row) => row.name === 'lifecycle-cutover');
      assert.deepEqual([lifecycle?.status, lifecycle?.detail], ['fail', 'phase=cutting-over']);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('a current-version database without the stage tables shows the latch state unknown, not unset', async () => {
    const f = fixture();
    try {
      f.db.exec('DROP TABLE codex_stage_events; DROP TABLE codex_watch_verdicts');
      const before = finish(f);
      const r = report(f);
      assert.deepEqual([r.latch.state, r.latch.reason], ['unknown', 'tables-missing']);
      assert.deepEqual(r.stages.map((row) => row.status), ['unknown', 'unknown']);
      const c = ctx(f.dbPath);
      assert.equal(await command.execute?.([], c.ctx), 0, c.err.join('\n'));
      assert.ok(c.out.some((line) => line.includes('latch state unknown (tables-missing)')), c.out.join('\n'));
      assert.ok(c.out.includes('Stage 1: UNKNOWN (the stage log cannot be read)'), c.out.join('\n'));
      assert.deepEqual(snapshot(f), before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('refuses a database that needs migration and writes nothing', async () => {
    const f = fixture();
    try {
      const version = Number((f.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      f.db.exec(`PRAGMA user_version = ${version - 1}`);
      const before = finish(f);
      const c = ctx(f.dbPath);
      assert.equal(await command.execute?.([], c.ctx), 3);
      assert.deepEqual(c.err, ['codex stage report refused: schema-migration-required']);
      assert.deepEqual(snapshot(f), before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('pending stops match what the next sweep records, even when the stage log needs initialize or has an unreadable row', () => {
    for (const damage of ['initialize-required', 'unreadable-row', 'readable']) {
      const f = fixture();
      try {
        start(f, 1, DAY1);
        if (damage === 'initialize-required') f.db.prepare("INSERT INTO codex_stage_events (kind, recorded_at) VALUES ('initialize-required', ?)").run(DAY1 + 10);
        const reloginId = relogin(f, DAY1 + 1_000);
        const reverted = confirmedSwitch(f, DAY1 + 2_000, 'manual', 'user-b:acct', 'reverted');
        if (damage === 'unreadable-row') f.db.prepare("INSERT INTO codex_stage_events (kind, recorded_at) VALUES ('latch-clear', ?)").run(DAY1 + 20);
        finish(f);
        const pending = report(f).latch.pending;
        assert.deepEqual(pending.map((stop) => stop.evidence).sort(),
          [`codex_watch_verdicts:${reverted}`, `relogin_events:${reloginId}`].sort(), damage);
        const verdictRow = pending.find((stop) => stop.evidence.startsWith('codex_watch_verdicts'))?.row;
        assert.deepEqual(verdictRow, { table: 'codex_watch_verdicts', switchId: reverted, at: new Date(DAY1 + 2_000 + 300_000).toISOString(), verdict: 'reverted' }, damage);
        // The sweep, run afterwards on the same rows, records exactly those.
        const store = openStore(f.dbPath);
        try {
          sweepCodexStops({ store, now: () => DAY1 + 9_000, buildStamp: null, flagEnabled: true, lifecycleId: 1, autoLog: () => undefined });
          // Read with plain SQL: an unreadable row cuts the parsed log short, hiding rows written after it.
          const recorded = ((store as unknown as { db: DatabaseSync }).db
            .prepare("SELECT evidence FROM codex_stage_events WHERE kind = 'latch-set'").all() as Array<{ evidence: string }>)
            .map((row) => row.evidence).sort();
          assert.deepEqual(recorded, pending.map((stop) => stop.evidence).sort(), damage);
        } finally { store.close(); }
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  });

  it('a recorded stop whose evidence row is gone shows the row as missing', () => {
    const f = fixture();
    try {
      start(f, 1, DAY1);
      f.store.appendCodexStageEvent({ kind: 'latch-set', now: DAY1 + 1_000, lifecycleId: 1, buildStamp: null, flagEnabled: true,
        evidence: 'switch_log:999', detail: { rule: 'unrecognized-row' } });
      finish(f);
      assert.deepEqual(report(f).latch.stops[0].row, { table: 'switch_log', missing: true });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('a recorded l13 receipt passes its precondition, and an early first-switch INFO shows its level', () => {
    const f = fixture();
    try {
      f.store.setConfig('codex.l13VerifiedAt', String(DAY1 - 19 * DAY_MS));
      finish(f);
      const pre = report(f).preconditions;
      assert.deepEqual(pre.find((row) => row.name === 'l13-receipt')?.status, 'pass');
      const g = fixture();
      try {
        finish(g);
        const firstSwitch = report(g, DAY1 - 19 * DAY_MS).preconditions.find((row) => row.name === 'codex-first-switch-pass');
        assert.match(firstSwitch?.detail ?? '', /^INFO/);
        assert.equal(firstSwitch?.status, 'fail');
      } finally { rmSync(g.root, { recursive: true, force: true }); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('refuses a newer schema and an unreadable file by name, without the path, and prints the refusal as JSON under --json', async () => {
    const f = fixture();
    try {
      const version = Number((f.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      f.db.exec(`PRAGMA user_version = ${version + 1}`);
      finish(f);
      const c = ctx(f.dbPath);
      assert.equal(await command.execute?.([], c.ctx), 3);
      assert.deepEqual(c.err, ['codex stage report refused: schema-newer']);
      const j = ctx(f.dbPath);
      assert.equal(await command.execute?.(['--json'], j.ctx), 3);
      assert.deepEqual(j.out.map((line) => JSON.parse(line) as unknown), [{ ok: false, reason: 'schema-newer' }]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-stage-report-bad-'));
    try {
      writeFileSync(join(root, 'qlb.db'), 'not a database at all, just text that is long enough to have a header');
      const c = ctx(join(root, 'qlb.db'));
      assert.equal(await command.execute?.([], c.ctx), 3);
      assert.deepEqual(c.err, ['codex stage report refused: store-unreadable']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses when there is no database, and creates none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-stage-report-none-'));
    try {
      const c = ctx(join(root, 'qlb.db'));
      assert.equal(await command.execute?.([], c.ctx), 3);
      assert.deepEqual(c.err, ['codex stage report refused: no-store']);
      assert.deepEqual(readdirSync(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never shows a slot identity, a token-shaped detail or a clear reason, in text or JSON', async () => {
    const f = fixture();
    try {
      const identity = 'chatgpt-user-7f3a9c:acct-91b2e4';
      const token = 'sk-proj-AbCdEf0123456789AbCdEf0123456789';
      start(f, 2, DAY1, { allow: [], frozenStatus: 'pass' });
      confirmedSwitch(f, DAY1 + 1_000, 'auto', identity);
      lineage(f, DAY1 + 2_000, 'qlb-auto', 'post', identity);
      const failed = Number(f.db.prepare(`INSERT INTO switch_log (ts, provider, from_account, to_account, trigger, outcome, detail, error)
        VALUES (?, ?, ?, ?, 'auto', 'failed', ?, ?)`).run(DAY1 + 3_000, PROVIDER, identity, identity, `refresh failed ${token}`, token).lastInsertRowid);
      // Code-shaped but unknown: the detail allowlist, not only the code shape, must hold it back.
      const codeShaped = Number(f.db.prepare(`INSERT INTO switch_log (ts, provider, from_account, to_account, trigger, outcome, detail)
        VALUES (?, ?, ?, ?, ?, 'failed', 'acct-91b2e4')`).run(DAY1 + 3_100, PROVIDER, identity, identity, identity).lastInsertRowid);
      relogin(f, DAY1 + 3_200, identity, identity);
      const verdictSwitch = confirmedSwitch(f, DAY1 + 3_300, 'auto', identity, identity);
      f.store.appendCodexStageEvent({ kind: 'latch-set', now: DAY1 + 3_400, lifecycleId: 1, buildStamp: null, flagEnabled: true,
        evidence: identity, detail: { rule: identity } });
      const stopId = f.store.appendCodexStageEvent({ kind: 'latch-set', now: DAY1 + 4_000, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true,
        evidence: `switch_log:${failed}`, detail: { rule: 'unrecognized-row' } });
      f.store.appendCodexStageEvent({ kind: 'latch-clear', now: DAY1 + 5_000, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true,
        throughId: stopId ?? 0, reason: 'cleared after talking to the identity owner' });
      finish(f);
      const json = ctx(f.dbPath);
      assert.equal(await command.execute?.(['--json'], json.ctx), 0, json.err.join('\n'));
      const text = ctx(f.dbPath);
      assert.equal(await command.execute?.([], text.ctx), 0, text.err.join('\n'));
      const all = [...json.out, ...text.out].join('\n');
      for (const secret of [identity, 'chatgpt-user-7f3a9c', 'acct-91b2e4', token, 'talking to the identity owner']) {
        assert.ok(!all.includes(secret), `leaked ${secret}`);
      }
      const r = JSON.parse(json.out[0]) as CodexStageReport;
      const rows = [...r.latch.pending, ...r.stages.flatMap((stage) => stage.stops)].map((stop) => stop.row);
      assert.ok(rows.some((row) => 'kind' in row && row.kind === 'unrecognized'), 'the hostile relogin kind is shown as unrecognized');
      assert.ok(rows.some((row) => 'switchId' in row && row.switchId === verdictSwitch && row.verdict === 'unrecognized'));
      assert.ok(rows.some((row) => 'outcome' in row && row.id === codeShaped && row.detail === 'unrecognized' && row.trigger === 'unrecognized'));
      assert.ok(r.latch.stops.some((stop) => stop.evidence === 'unrecognized' && stop.rule === 'unrecognized'));
      assert.deepEqual(r.latch.clears.map((row) => row.reason), ['recorded']);
      assert.deepEqual(r.latch.stops.map((stop) => stop.cleared), [true, true]);
      assert.deepEqual(r.latch.stops.find((stop) => stop.id === stopId)?.row, { table: 'switch_log', id: failed, at: new Date(DAY1 + 3_000).toISOString(), trigger: 'auto', outcome: 'failed', detail: 'unrecognized' });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('redacts the output with the context\'s known secrets', async () => {
    const f = fixture();
    try {
      start(f, 1, DAY1, { allow: [] }, 'a1b2c3d4e5f60718');
      finish(f);
      const c = ctx(f.dbPath, ['a1b2c3d4e5f60718']);
      assert.equal(await command.execute?.(['--json'], c.ctx), 0, c.err.join('\n'));
      assert.ok(!c.out[0].includes('a1b2c3d4e5f60718'));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('is registered as `codex stage report` and rejects unknown arguments with exit 2', async () => {
    assert.equal(command.name, 'codex stage report');
    const cmd = createCodexStageReportCommand();
    const c = ctx('/nonexistent/qlb.db');
    assert.equal(await cmd.execute?.(['--stage', '1'], c.ctx), 2);
  });
});
