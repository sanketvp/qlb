import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { codexStopLatchCheck } from '../src/checks/codex-stop-latch';
import { defaultConfig } from '../src/config';
import { doctorQlb, S64_BLOCKING_WARN, s64DoctorVerdict } from '../src/diagnostics';
import { openStore, type Store } from '../src/store';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const PROVIDER = 'openai-codex';

/** A current-version store, optionally seeded through the store API. */
function fixture(seed?: (store: Store) => void): string {
  const path = join(mkdtempSync(join(tmpdir(), 'qlb-codex-stop-latch-check-')), 'qlb.db');
  const store = openStore(path);
  try { seed?.(store); } finally { store.close(); }
  return path;
}

function sql(path: string, statement: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(path);
  try { db.prepare(statement).run(...params); } finally { db.close(); }
}

const stageStart = (store: Store, at = NOW - 10_000): void => {
  store.appendCodexStageEvent({ kind: 'stage-start', now: at, lifecycleId: 1, buildStamp: null, flagEnabled: true, stage: 1, detail: { allow: [] } });
};

const latchSet = (store: Store, evidence: string, at = NOW - 5_000): number => {
  const id = store.appendCodexStageEvent({ kind: 'latch-set', now: at, lifecycleId: 1, buildStamp: null, flagEnabled: true, evidence,
    detail: { rule: 'forced-relogin' } });
  assert.ok(id !== null);
  return id;
};

const stageRows = (path: string): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return (db.prepare('SELECT COUNT(*) AS n FROM codex_stage_events').get() as { n: number }).n; } finally { db.close(); }
};

describe('doctor codex:stop-latch (U13)', () => {
  it('latched: WARN naming the newest stop and its evidence row, and doctor still does not FAIL', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-stop-latch-doctor-'));
    const config = defaultConfig(home);
    let newest = 0;
    const store = openStore(config.dbPath);
    try {
      stageStart(store);
      latchSet(store, 'relogin_events:3', NOW - 6_000);
      newest = latchSet(store, 'switch_log:7');
    } finally { store.close(); }
    sql(config.dbPath, 'INSERT INTO lifecycle (state, began_at, cutover_at) VALUES (?, ?, ?)', 'cutover', NOW - 100_000, NOW - 90_000);

    assert.deepEqual(codexStopLatchCheck(config.dbPath), {
      name: 'codex:stop-latch', level: 'WARN', code: 'latched',
      message: `Codex stop latch set by stop ${newest} (evidence switch_log:7): new Codex switches and refreshes are refused; see qlb codex stage report, then qlb codex latch clear --through ${newest} --reason <text>`,
    });

    const doctor = () => doctorQlb(config, { command: () => '', hostCommand: () => '', now: () => NOW });
    const failing = (checks: Array<{ name: string; level: string }>) => checks.filter((check) => check.level === 'FAIL').map((check) => check.name);
    const report = await doctor();
    const row = report.checks.find((check) => check.name === 'codex:stop-latch');
    assert.equal(row?.level, 'WARN');
    // The test home has no signed Keychain helper, so doctor can FAIL here for that alone; the latch adds no FAIL row.
    const latchedFailures = failing(report.checks);
    assert.ok(!latchedFailures.includes('codex:stop-latch'));
    sql(config.dbPath, "INSERT INTO codex_stage_events (kind, recorded_at, flag_enabled, through_id, reason) VALUES ('latch-clear', ?, 1, ?, 'checked')", NOW - 1, newest);
    const cleared = await doctor();
    assert.equal(cleared.checks.find((check) => check.name === 'codex:stop-latch')?.level, 'INFO');
    assert.deepEqual(latchedFailures, failing(cleared.checks));
    assert.equal(report.overall, cleared.overall);
    // KTD10: a WARN, so it never blocks the cutover receipt's clean doctor.
    assert.equal(s64DoctorVerdict({ checks: [row!], providers: [] }).overall, 'PASS');
    assert.ok(!(S64_BLOCKING_WARN as readonly string[]).includes('codex:stop-latch'));
  });

  it('cleared: INFO', () => {
    const path = fixture((store) => {
      stageStart(store);
      const stop = latchSet(store, 'switch_log:7');
      store.appendCodexStageEvent({ kind: 'latch-clear', now: NOW - 1_000, lifecycleId: 1, buildStamp: null, flagEnabled: true, throughId: stop, reason: 'checked' });
    });
    assert.deepEqual(codexStopLatchCheck(path), { name: 'codex:stop-latch', level: 'INFO', message: 'Codex stop latch clear' });
  });

  it('a current-version database without the new tables: WARN latch state unknown', () => {
    const path = fixture();
    sql(path, 'DROP TABLE codex_stage_events');
    sql(path, 'DROP TABLE codex_watch_verdicts');
    assert.deepEqual(codexStopLatchCheck(path), {
      name: 'codex:stop-latch', level: 'WARN', code: 'latch-unknown',
      message: 'Codex stop latch state unknown (tables-missing): every Codex switch and refresh treats it as set; see qlb codex stage report',
    });
  });

  it('an unreadable row or an uninitialized restore: WARN latch state unknown, naming --initialize when it applies', () => {
    const restored = fixture();
    sql(restored, "INSERT INTO codex_stage_events (kind, recorded_at, flag_enabled) VALUES ('initialize-required', ?, 0)", NOW - 1);
    assert.deepEqual(codexStopLatchCheck(restored), {
      name: 'codex:stop-latch', level: 'WARN', code: 'latch-unknown',
      message: 'Codex stop latch state unknown (initialize-required): every Codex switch and refresh treats it as set; see qlb codex stage report, then qlb codex latch clear --initialize --reason <text>',
    });
    const unreadable = fixture((store) => stageStart(store));
    sql(unreadable, "UPDATE codex_stage_events SET kind = 'not-a-kind'");
    assert.equal(codexStopLatchCheck(unreadable).message,
      'Codex stop latch state unknown (unreadable-row): every Codex switch and refresh treats it as set; see qlb codex stage report');
  });

  it('no stage start: not applicable', () => {
    assert.deepEqual(codexStopLatchCheck(fixture()), {
      name: 'codex:stop-latch', level: 'N/A', message: 'not applicable: no Codex stage has started',
    });
  });

  it('no database: not applicable, and nothing is created', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-codex-stop-latch-missing-')), 'qlb.db');
    assert.deepEqual(codexStopLatchCheck(path), {
      name: 'codex:stop-latch', level: 'N/A', message: 'not applicable: no database',
    });
    assert.equal(existsSync(path), false);
  });

  it('a database that cannot be read: WARN latch state unknown, never FAIL', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-codex-stop-latch-garbage-')), 'qlb.db');
    writeFileSync(path, 'not a sqlite database, padded past the header size '.repeat(4));
    const result = codexStopLatchCheck(path);
    assert.equal(result.level, 'WARN');
    assert.equal(result.code, 'latch-unknown');
    assert.match(result.message, /^Codex stop latch state unknown \(database unreadable: /);
  });

  it('a latch-set with no stage start is still reported as latched, not as not applicable', () => {
    let stop = 0;
    const path = fixture((store) => { stop = latchSet(store, 'switch_log:7'); });
    assert.equal(codexStopLatchCheck(path).code, 'latched');
    assert.match(codexStopLatchCheck(path).message, new RegExp(`by stop ${stop} `));
  });

  it('is read-only and does not run the sweep: an unrecorded stop leaves the check at INFO and records nothing', () => {
    const path = fixture((store) => {
      stageStart(store);
      store.recordRelogin({ ts: NOW - 1_000, provider: PROVIDER, accountId: 'a:account', kind: 'wiped' });
    });
    const before = readFileSync(path);
    assert.equal(stageRows(path), 1);
    assert.equal(codexStopLatchCheck(path).level, 'INFO');
    assert.deepEqual(readFileSync(path), before);
    assert.equal(stageRows(path), 1);
  });

  it('prints only a sweep-shaped evidence pointer', () => {
    let stop = 0;
    const path = fixture((store) => {
      stageStart(store);
      stop = latchSet(store, 'switch_log:7 sk-not-a-pointer');
    });
    assert.equal(codexStopLatchCheck(path).message,
      `Codex stop latch set by stop ${stop} (evidence unrecognized): new Codex switches and refreshes are refused; see qlb codex stage report, then qlb codex latch clear --through ${stop} --reason <text>`);
  });
});
