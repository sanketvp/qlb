import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  admitCodexAction,
  classifyReloginRow,
  classifySwitchRow,
  classifyVerdictRow,
  decideLatchClear,
  deriveLatch,
  evaluateStages,
  type StageEventRow,
  type StageInput,
  type StageLineageRow,
  type StageReloginRow,
  type StageSwitchRow,
  type StageVerdictRow,
} from '../src/codex-stage';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const rules = { namedRefusals: new Set(['codex-writing', 'codex-logged-out']) };

let nextId = 1;
function event(kind: StageEventRow['kind'], at: number, extra: Partial<StageEventRow> = {}): StageEventRow {
  return { id: nextId++, kind, recordedAt: at, stage: null, throughId: null, frozenStatus: null, ...extra };
}
function start(stage: 1 | 2, at: number, frozenStatus: StageEventRow['frozenStatus'] = null): StageEventRow {
  return event('stage-start', at, { stage, frozenStatus });
}
function sw(at: number, extra: Partial<StageSwitchRow> = {}): StageSwitchRow {
  return { id: nextId++, ts: at, committedAt: at, trigger: 'manual', outcome: 'ok', detail: null, toAccount: 'acct-b', ...extra };
}
function confirmed(row: StageSwitchRow, at = (row.committedAt ?? row.ts) + 300_000): StageVerdictRow {
  return { switchId: row.id, verdict: 'confirmed', recordedAt: at };
}
function input(parts: Partial<StageInput>): StageInput {
  return { events: [], switches: [], relogins: [], verdicts: [], lineage: [], rules, localDateOf: utcDate, ...parts };
}

describe('stop classifier', () => {
  it('treats forced re-logins as stops and other re-login rows as clean', () => {
    const row = (kind: string): StageReloginRow => ({ id: 4, ts: T0, kind });
    assert.equal(classifyReloginRow(row('identity-replaced'))?.rule, 'forced-relogin');
    assert.equal(classifyReloginRow(row('wiped'))?.rule, 'forced-relogin');
    assert.equal(classifyReloginRow(row('dead'))?.rule, 'forced-relogin');
    assert.equal(classifyReloginRow(row('external-login')), null);
    assert.equal(classifyReloginRow(row('healed')), null);
    assert.equal(classifyReloginRow(row('wiped'))?.pointer, 'relogin_events:4');
  });

  it('judges a refusal by whether its cause is named (AE6)', () => {
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'refused', detail: 'codex-writing' }), rules), null);
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'refused', detail: null }), rules)?.rule, 'unexplained-refusal');
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'refused', detail: 'never-heard-of-it' }), rules)?.rule, 'unexplained-refusal');
  });

  it('treats half-finished switches as stops and the other outcomes as clean', () => {
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'failed', detail: 'unknown-live-identity' }), rules)?.rule, 'half-finished-switch');
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'failed', detail: 'wiped' }), rules)?.rule, 'half-finished-switch');
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'failed', detail: 'not-published' }), rules), null);
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'failed', detail: 'target-changed' }), rules), null);
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'noop' }), rules), null);
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'ok' }), rules), null);
  });

  it('treats rows it does not recognise as stops', () => {
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'reverted-by-codex' }), rules)?.rule, 'unconfirmed-switch');
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'paused' }), rules)?.rule, 'unrecognized-row');
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'failed', detail: null }), rules)?.rule, 'unrecognized-row');
    assert.equal(classifySwitchRow(sw(T0, { outcome: 'failed', detail: 'disk-full' }), rules)?.rule, 'unrecognized-row');
    assert.equal(classifyReloginRow({ id: 5, ts: T0, kind: 'rotated' })?.rule, 'unrecognized-row');
    assert.equal(classifyVerdictRow({ switchId: 8, verdict: 'maybe', recordedAt: T0 })?.rule, 'unrecognized-row');
  });

  it('maps verdicts to stops, counts and neutral endings', () => {
    const verdict = (value: string): StageVerdictRow => ({ switchId: 7, verdict: value, recordedAt: T0 });
    assert.equal(classifyVerdictRow(verdict('confirmed')), null);
    assert.equal(classifyVerdictRow(verdict('late')), null);
    assert.equal(classifyVerdictRow(verdict('superseded')), null);
    assert.equal(classifyVerdictRow(verdict('not-admitted')), null);
    assert.equal(classifyVerdictRow(verdict('unresolved'))?.rule, 'half-finished-switch');
    assert.equal(classifyVerdictRow(verdict('wiped'))?.rule, 'half-finished-switch');
    assert.equal(classifyVerdictRow(verdict('unknown-live-identity'))?.rule, 'half-finished-switch');
    assert.equal(classifyVerdictRow(verdict('reverted'))?.rule, 'unconfirmed-switch');
    assert.equal(classifyVerdictRow(verdict('inconclusive'))?.rule, 'unconfirmed-switch');
    assert.equal(classifyVerdictRow(verdict('reverted'))?.pointer, 'codex_watch_verdicts:7');
  });
});

describe('latch', () => {
  it('is unarmed before any stage start, armed after one, latched by a stop and cleared only through the newest stop', () => {
    assert.equal(deriveLatch({ status: 'readable', events: [] }).state, 'unarmed');
    const s = start(1, T0);
    assert.equal(deriveLatch({ status: 'readable', events: [s] }).state, 'armed');
    const stop1 = event('latch-set', T0 + 1);
    const stop2 = event('latch-set', T0 + 2);
    const latched = deriveLatch({ status: 'readable', events: [s, stop1, stop2] });
    assert.deepEqual(latched, { state: 'latched', newestStopId: stop2.id, stopIds: [stop1.id, stop2.id] });
    const partial = event('latch-clear', T0 + 3, { throughId: stop1.id });
    assert.equal(deriveLatch({ status: 'readable', events: [s, stop1, stop2, partial] }).state, 'latched');
    const full = event('latch-clear', T0 + 4, { throughId: stop2.id });
    assert.equal(deriveLatch({ status: 'readable', events: [s, stop1, stop2, full] }).state, 'armed');
  });

  it('stays latched across a stage start, re-latches on a stop after a clear, and ignores initialize rows', () => {
    const s = start(1, T0);
    const stop1 = event('latch-set', T0 + 1);
    assert.equal(deriveLatch({ status: 'readable', events: [s, stop1, start(2, T0 + 2)] }).state, 'latched');
    const clear = event('latch-clear', T0 + 3, { throughId: stop1.id });
    const stop2 = event('latch-set', T0 + 4);
    assert.deepEqual(deriveLatch({ status: 'readable', events: [s, stop1, clear, stop2] }),
      { state: 'latched', newestStopId: stop2.id, stopIds: [stop2.id] });
    assert.equal(deriveLatch({ status: 'readable', events: [event('stage-close', T0, { stage: 1, frozenStatus: 'pass' })] }).state, 'armed');
    assert.equal(deriveLatch({ status: 'readable', events: [event('initialize-required', T0), event('initialize', T0 + 1)] }).state, 'unarmed');
  });

  it('reads an unknown log as unknown', () => {
    assert.deepEqual(deriveLatch({ status: 'unknown', reason: 'initialize-required' }), { state: 'unknown', reason: 'initialize-required' });
  });

  it('refuses a clear through an older stop, with an open watch, with a fence set, or without a reason', () => {
    const s = start(1, T0);
    const stop1 = event('latch-set', T0 + 1);
    const stop2 = event('latch-set', T0 + 2);
    const latch = deriveLatch({ status: 'readable', events: [s, stop1, stop2] });
    const ok = { latch, throughId: stop2.id, openWatch: false, fenceSet: false, reason: 'checked' };
    assert.deepEqual(decideLatchClear(ok), { ok: true });
    assert.deepEqual(decideLatchClear({ ...ok, throughId: stop1.id }), { ok: false, refusal: 'newer-stop', newestStopId: stop2.id });
    assert.deepEqual(decideLatchClear({ ...ok, openWatch: true }), { ok: false, refusal: 'open-watch' });
    assert.deepEqual(decideLatchClear({ ...ok, fenceSet: true }), { ok: false, refusal: 'fence-set' });
    assert.deepEqual(decideLatchClear({ ...ok, reason: '  ' }), { ok: false, refusal: 'empty-reason' });
    assert.deepEqual(decideLatchClear({ ...ok, latch: deriveLatch({ status: 'readable', events: [s] }) }), { ok: false, refusal: 'not-latched' });
  });

  it('refuses a clear of an unknown latch as unknown, not as not latched', () => {
    const latch = deriveLatch({ status: 'unknown', reason: 'unreadable-row' });
    assert.deepEqual(decideLatchClear({ latch, throughId: 1, openWatch: false, fenceSet: false, reason: 'checked' }),
      { ok: false, refusal: 'latch-unknown', reason: 'unreadable-row' });
  });

  it('reports the first failing condition in the documented order', () => {
    const s = start(1, T0);
    const stop1 = event('latch-set', T0 + 1);
    const stop2 = event('latch-set', T0 + 2);
    const latch = deriveLatch({ status: 'readable', events: [s, stop1, stop2] });
    const armed = deriveLatch({ status: 'readable', events: [s] });
    const unknown = deriveLatch({ status: 'unknown', reason: 'tables-missing' });
    const all = { throughId: stop1.id, openWatch: true, fenceSet: true };
    assert.deepEqual(decideLatchClear({ ...all, latch: armed, reason: '' }), { ok: false, refusal: 'empty-reason' });
    assert.deepEqual(decideLatchClear({ ...all, latch: unknown, reason: 'r' }), { ok: false, refusal: 'latch-unknown', reason: 'tables-missing' });
    assert.deepEqual(decideLatchClear({ ...all, latch: armed, reason: 'r' }), { ok: false, refusal: 'not-latched' });
    assert.deepEqual(decideLatchClear({ ...all, latch, reason: 'r' }), { ok: false, refusal: 'newer-stop', newestStopId: stop2.id });
    assert.deepEqual(decideLatchClear({ ...all, throughId: stop2.id, latch, reason: 'r' }), { ok: false, refusal: 'open-watch' });
  });
});

describe('admission', () => {
  const flagOn = { flagEnabled: true };
  const log = (events: StageEventRow[]) => ({ status: 'readable' as const, events });

  it('refuses switches and refreshes while latched or unknown, and admits import, adoption and stash', () => {
    const s = start(2, T0);
    const latched = log([s, event('latch-set', T0 + 1)]);
    for (const action of [{ kind: 'switch', trigger: 'manual' }, { kind: 'switch', trigger: 'auto' }, { kind: 'refresh' }] as const) {
      assert.deepEqual(admitCodexAction({ ...flagOn, log: latched, action }), { admitted: false, refusal: 'codex-stop-latched' });
      assert.deepEqual(admitCodexAction({ ...flagOn, log: { status: 'unknown', reason: 'tables-missing' }, action }), { admitted: false, refusal: 'codex-stop-latched' });
    }
    for (const kind of ['import', 'adopt', 'stash'] as const) {
      assert.deepEqual(admitCodexAction({ ...flagOn, log: latched, action: { kind } }), { admitted: true });
    }
  });

  it('admits no switch while the flag is off', () => {
    assert.deepEqual(
      admitCodexAction({ flagEnabled: false, log: log([]), action: { kind: 'switch', trigger: 'manual' } }),
      { admitted: false, refusal: 'codex-switch-disabled' },
    );
    assert.deepEqual(admitCodexAction({ flagEnabled: false, log: log([]), action: { kind: 'refresh' } }), { admitted: true });
  });

  it('admits a non-manual switch only in an open Stage 2 run or after a passed Stage 2 close', () => {
    const auto = { kind: 'switch', trigger: 'auto' } as const;
    const manual = { kind: 'switch', trigger: 'manual' } as const;
    const refusal = { admitted: false, refusal: 'codex-auto-outside-stage-2' };
    assert.deepEqual(admitCodexAction({ ...flagOn, log: log([]), action: auto }), refusal);
    assert.deepEqual(admitCodexAction({ ...flagOn, log: log([]), action: manual }), { admitted: true });
    assert.deepEqual(admitCodexAction({ ...flagOn, log: log([start(1, T0)]), action: auto }), refusal);
    const s2 = start(2, T0 + DAY, 'pass');
    assert.deepEqual(admitCodexAction({ ...flagOn, log: log([start(1, T0), s2]), action: auto }), { admitted: true });
    const passed = event('stage-close', T0 + 9 * DAY, { stage: 2, frozenStatus: 'pass' });
    assert.deepEqual(admitCodexAction({ ...flagOn, log: log([start(1, T0), s2, passed]), action: auto }), { admitted: true });
    const failed = event('stage-close', T0 + 9 * DAY, { stage: 2, frozenStatus: 'not-yet' });
    assert.deepEqual(admitCodexAction({ ...flagOn, log: log([start(1, T0), s2, failed]), action: auto }), refusal);
    const stop = event('latch-set', T0 + 10 * DAY);
    const clear = event('latch-clear', T0 + 11 * DAY, { throughId: stop.id });
    assert.deepEqual(admitCodexAction({ ...flagOn, log: log([start(1, T0), s2, passed, stop, clear]), action: auto }), refusal);
  });
});

describe('stage evaluator', () => {
  it('gives Stage 1 not yet for six confirmed manual switches on one date (AE1)', () => {
    const switches = Array.from({ length: 6 }, (_, i) => sw(T0 + 60_000 * (i + 1)));
    const result = evaluateStages(input({ events: [start(1, T0)], switches, verdicts: switches.map((row) => confirmed(row)) }));
    assert.equal(result.stage1.status, 'not-yet');
    assert.equal(result.stage1.confirmed.length, 6);
    assert.deepEqual(result.stage1.days, [utcDate(T0)]);
  });

  it('passes Stage 1 with five confirmed manual switches over two dates and no stop', () => {
    const switches = [0, 1, 2, 3].map((i) => sw(T0 + 60_000 * (i + 1))).concat(sw(T0 + DAY));
    const result = evaluateStages(input({ events: [start(1, T0)], switches, verdicts: switches.map((row) => confirmed(row)) }));
    assert.equal(result.stage1.status, 'pass');
  });

  it('stops a run on a wiped re-login row (AE3)', () => {
    const relogins: StageReloginRow[] = [{ id: 99, ts: T0 + 1_000, kind: 'wiped' }];
    const result = evaluateStages(input({ events: [start(1, T0)], relogins }));
    assert.equal(result.stage1.status, 'stop');
    assert.deepEqual(result.stage1.stops.map(({ pointer }) => pointer), ['relogin_events:99']);
  });

  it('stops a run on a stop recorded before its first switch', () => {
    const recorded = event('latch-set', T0 + 1_000);
    const result = evaluateStages(input({ events: [start(1, T0), recorded] }));
    assert.equal(result.stage1.status, 'stop');
  });

  it('ignores evidence from before the latest stage start', () => {
    const relogins: StageReloginRow[] = [{ id: 98, ts: T0 - 1_000, kind: 'wiped' }];
    assert.equal(evaluateStages(input({ events: [start(1, T0)], relogins })).stage1.status, 'not-yet');
  });

  it('neither counts nor stops on a late verdict (AE7)', () => {
    const late = sw(T0 + 1_000);
    const result = evaluateStages(input({
      events: [start(1, T0)], switches: [late], verdicts: [{ switchId: late.id, verdict: 'late', recordedAt: T0 + 400_000 }],
    }));
    assert.equal(result.stage1.status, 'not-yet');
    assert.deepEqual(result.stage1.confirmed, []);
    assert.deepEqual(result.stage1.stops, []);
  });

  it('keeps Stage 1 passed when Stage 2 stops (AE8)', () => {
    const s1 = start(1, T0);
    const s2 = start(2, T0 + 3 * DAY, 'pass');
    const relogins: StageReloginRow[] = [{ id: 97, ts: T0 + 4 * DAY, kind: 'identity-replaced' }];
    const result = evaluateStages(input({ events: [s1, s2], relogins }));
    assert.equal(result.stage1.status, 'pass');
    assert.equal(result.stage2.status, 'stop');
  });

  it('reads a closed stage from its frozen result', () => {
    const s1 = start(1, T0);
    const close = event('stage-close', T0 + 3 * DAY, { stage: 1, frozenStatus: 'pass' });
    const relogins: StageReloginRow[] = [{ id: 96, ts: T0 + 4 * DAY, kind: 'wiped' }];
    assert.equal(evaluateStages(input({ events: [s1, close], relogins })).stage1.status, 'pass');
  });

  it('gives a restarted Stage 2 not yet five days after its first switch (AE4)', () => {
    const s1 = start(1, T0);
    const firstS2 = start(2, T0 + 3 * DAY, 'pass');
    const stop = event('latch-set', T0 + 7 * DAY);
    const clear = event('latch-clear', T0 + 13 * DAY, { throughId: stop.id });
    const restart = start(2, T0 + 13 * DAY + 1_000, 'pass');
    const switches = Array.from({ length: 12 }, (_, i) => sw(T0 + 14 * DAY + Math.floor(i / 2.4) * DAY, { trigger: 'auto' }));
    const lineage: StageLineageRow[] = [{ id: 1, ts: T0 + 15 * DAY, accountId: 'acct-b', by: 'qlb-auto', cause: 'post' }];
    const result = evaluateStages(input({
      events: [s1, firstS2, stop, clear, restart], switches, verdicts: switches.map((row) => confirmed(row)), lineage,
    }));
    assert.equal(result.stage2.status, 'not-yet');
    assert.equal(result.stage2.days.length, 5);
  });

  it('gives Stage 2 not yet without a qlb-auto refresh', () => {
    const switches = Array.from({ length: 10 }, (_, i) => sw(T0 + DAY + Math.floor(i * 0.7) * DAY, { trigger: 'auto' }));
    const events = [start(1, T0 - 5 * DAY), start(2, T0, 'pass')];
    const cliOnly: StageLineageRow[] = [{ id: 1, ts: T0 + 2 * DAY, accountId: 'acct-b', by: 'qlb-cli', cause: 'post' }];
    const result = evaluateStages(input({ events, switches, verdicts: switches.map((row) => confirmed(row)), lineage: cliOnly }));
    assert.equal(result.stage2.days.length, 7);
    assert.equal(result.stage2.confirmed.length, 10);
    assert.deepEqual(result.stage2.refreshes, []);
    assert.equal(result.stage2.status, 'not-yet');
  });

  it("credits an automatic switch's own pre-switch refresh to its run", () => {
    const switches = Array.from({ length: 10 }, (_, i) => sw(T0 + DAY + Math.floor(i * 0.7) * DAY, { trigger: 'auto' }));
    const events = [start(1, T0 - 5 * DAY), start(2, T0, 'pass')];
    const first = switches[0];
    const lineage: StageLineageRow[] = [
      { id: 5, ts: (first.committedAt ?? first.ts) - 2_000, accountId: first.toAccount, by: 'qlb-auto', cause: 'post' },
      { id: 6, ts: T0 + 2 * DAY, accountId: 'acct-b', by: 'qlb-auto', cause: 'stash-adopt' },
    ];
    const result = evaluateStages(input({ events, switches, verdicts: switches.map((row) => confirmed(row)), lineage }));
    assert.deepEqual(result.stage2.refreshes, [5]);
    assert.equal(result.stage2.status, 'pass');
  });

  it('counts only manual switches for Stage 1 and only automatic ones for Stage 2', () => {
    const switches = [sw(T0 + 1_000, { trigger: 'auto' }), sw(T0 + 2_000)];
    const result = evaluateStages(input({ events: [start(1, T0)], switches, verdicts: switches.map((row) => confirmed(row)) }));
    assert.deepEqual(result.stage1.confirmed, [switches[1].id]);
  });

  it('gives Stage 1 not yet one switch short of the bar', () => {
    const switches = [0, 1, 2].map((i) => sw(T0 + 60_000 * (i + 1))).concat(sw(T0 + DAY));
    const result = evaluateStages(input({ events: [start(1, T0)], switches, verdicts: switches.map((row) => confirmed(row)) }));
    assert.equal(result.stage1.status, 'not-yet');
  });

  it('replaces a Stage 2 run when Stage 1 restarts after it', () => {
    const result = evaluateStages(input({ events: [start(1, T0), start(2, T0 + DAY, 'pass'), start(1, T0 + 2 * DAY)] }));
    assert.equal(result.stage2.status, 'not-started');
    assert.equal(result.stage1.status, 'not-yet');
  });

  it('stops a run whose stop came before its close, whatever the close froze', () => {
    const s1 = start(1, T0);
    const close = event('stage-close', T0 + 3 * DAY, { stage: 1, frozenStatus: 'pass' });
    const relogins: StageReloginRow[] = [{ id: 95, ts: T0 + DAY, kind: 'wiped' }];
    assert.equal(evaluateStages(input({ events: [s1, close], relogins })).stage1.status, 'stop');
  });

  it('evaluates a close with no frozen result from the evidence', () => {
    const switches = [0, 1, 2, 3].map((i) => sw(T0 + 60_000 * (i + 1))).concat(sw(T0 + DAY));
    const close = event('stage-close', T0 + 3 * DAY, { stage: 1 });
    const result = evaluateStages(input({ events: [start(1, T0), close], switches, verdicts: switches.map((row) => confirmed(row)) }));
    assert.equal(result.stage1.status, 'pass');
    assert.equal(result.stage1.frozen, false);
  });

  it('keeps the evidence behind a frozen result', () => {
    const switches = [0, 1, 2, 3].map((i) => sw(T0 + 60_000 * (i + 1))).concat(sw(T0 + DAY));
    const close = event('stage-close', T0 + 3 * DAY, { stage: 1, frozenStatus: 'pass' });
    const after = sw(T0 + 4 * DAY);
    const all = [...switches, after];
    const result = evaluateStages(input({ events: [start(1, T0), close], switches: all, verdicts: all.map((row) => confirmed(row)) })).stage1;
    assert.equal(result.status, 'pass');
    assert.equal(result.frozen, true);
    assert.deepEqual(result.confirmed, switches.map(({ id }) => id));
    assert.deepEqual(result.days, [utcDate(T0), utcDate(T0 + DAY)]);
  });

  it('stops Stage 2 on a reverted verdict and counts no switch after the stop', () => {
    const before = sw(T0 + DAY, { trigger: 'auto' });
    const reverted = sw(T0 + 2 * DAY, { trigger: 'auto' });
    const after = sw(T0 + 3 * DAY, { trigger: 'auto' });
    const verdicts = [confirmed(before), { switchId: reverted.id, verdict: 'reverted', recordedAt: T0 + 2 * DAY + 1_000 }, confirmed(after)];
    const result = evaluateStages(input({ events: [start(1, T0 - 5 * DAY), start(2, T0, 'pass')], switches: [before, reverted, after], verdicts }));
    assert.equal(result.stage2.status, 'stop');
    assert.deepEqual(result.stage2.stops.map(({ pointer }) => pointer), [`codex_watch_verdicts:${reverted.id}`]);
    assert.deepEqual(result.stage2.confirmed, [before.id]);
  });

  it("credits a refresh before the window only as the first switch's own pre-switch refresh", () => {
    const first = sw(T0 + DAY, { trigger: 'auto', toAccount: 'acct-a' });
    const rest = Array.from({ length: 9 }, (_, i) => sw(T0 + 2 * DAY + Math.floor(i * 0.7) * DAY, { trigger: 'auto', toAccount: 'acct-b' }));
    const switches = [first, ...rest];
    const lineage: StageLineageRow[] = [{ id: 77, ts: T0 + 3_600_000, accountId: 'acct-b', by: 'qlb-auto', cause: 'post' }];
    const result = evaluateStages(input({
      events: [start(1, T0 - 5 * DAY), start(2, T0, 'pass')], switches, verdicts: switches.map((row) => confirmed(row)), lineage,
    }));
    assert.deepEqual(result.stage2.refreshes, []);
    assert.equal(result.stage2.status, 'not-yet');
  });

  it('reports a stage with no start marker as not started', () => {
    const result = evaluateStages(input({}));
    assert.equal(result.stage1.status, 'not-started');
    assert.equal(result.stage2.status, 'not-started');
  });
});
