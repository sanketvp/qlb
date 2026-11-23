import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  admitCodexAction,
  decideLatchClear,
  deriveLatch,
  type CodexAction,
  type LatchView,
  type StageEventRow,
  type StageLog,
} from '../src/codex-stage';

/*
 * Replays the cases the Lean model in proofs/codex-stop-latch generates
 * (scripts/check-lean-model.sh codex-stop-latch) through the shipped latch,
 * admission and clear functions. A mismatch means the code and the proved
 * model disagree.
 */

type ModelEvent =
  | { kind: 'stage-start'; stage: 1 | 2 }
  | { kind: 'stage-close'; stage: 1 | 2; passed: boolean }
  | { kind: 'stop' }
  | { kind: 'clear'; throughId: number };
type ModelLatch = { state: 'unarmed' | 'armed' | 'unknown' } | { state: 'latched'; newestStopId: number };
type Refusal = string | null;
type TraceCase = {
  rule: 'trace';
  input: { events: ModelEvent[]; unknown: boolean };
  expected: { latch: ModelLatch; admission: Record<'manualOn' | 'autoOn' | 'refreshOn' | 'otherOn' | 'manualOff' | 'autoOff' | 'refreshOff' | 'otherOff', Refusal> };
};
type ClearCase = {
  rule: 'clear';
  input: { latch: ModelLatch; throughId: number; openWatch: boolean; fenceSet: boolean; reasonEmpty: boolean };
  expected: null | { refusal: string; newestStopId?: number };
};
type Case = TraceCase | ClearCase;

const cases = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/codex-stop-latch-model-cases.json'), 'utf8')) as Case[];

/** Event row ids are their 1-based positions, as the generator assigns them. */
function toRow(event: ModelEvent, index: number): StageEventRow {
  const base = { id: index + 1, recordedAt: index + 1, stage: null, throughId: null, frozenStatus: null };
  switch (event.kind) {
    case 'stage-start':
      return { ...base, kind: 'stage-start', stage: event.stage };
    case 'stage-close':
      return { ...base, kind: 'stage-close', stage: event.stage, frozenStatus: event.passed ? 'pass' : 'stop' };
    case 'stop':
      return { ...base, kind: 'latch-set' };
    case 'clear':
      return { ...base, kind: 'latch-clear', throughId: event.throughId };
  }
}

function latchView(view: LatchView): ModelLatch {
  return view.state === 'latched' ? { state: 'latched', newestStopId: view.newestStopId } : { state: view.state };
}

function toLatchView(latch: ModelLatch): LatchView {
  switch (latch.state) {
    case 'unknown':
      return { state: 'unknown', reason: 'unreadable-row' };
    case 'latched':
      return { state: 'latched', newestStopId: latch.newestStopId, stopIds: [latch.newestStopId] };
    case 'armed':
      return { state: 'armed' };
    default:
      return { state: 'unarmed' };
  }
}

function refusal(log: StageLog, flagEnabled: boolean, action: CodexAction): Refusal {
  const decision = admitCodexAction({ log, flagEnabled, action });
  return decision.admitted ? null : decision.refusal;
}

/** Import, adoption and stash are one action in the model; each must match it. */
function otherRefusal(log: StageLog, flagEnabled: boolean): Refusal {
  const results = (['import', 'adopt', 'stash'] as const).map((kind) => refusal(log, flagEnabled, { kind }));
  assert.equal(new Set(results).size, 1, `import, adopt and stash agree: ${JSON.stringify(results)}`);
  return results[0]!;
}

test('the committed fixture covers every trace rule and every clear refusal', () => {
  const traces = cases.filter((entry): entry is TraceCase => entry.rule === 'trace');
  const clears = cases.filter((entry): entry is ClearCase => entry.rule === 'clear');
  assert.equal(traces.length, 585, 'every trace of up to three events');
  assert.ok(traces.some((entry) => entry.input.unknown));
  assert.deepEqual(new Set(clears.map((entry) => entry.expected?.refusal ?? 'ok')),
    new Set(['ok', 'empty-reason', 'latch-unknown', 'not-latched', 'newer-stop', 'open-watch', 'fence-set']));
});

test('every Lean trace gives the same latch and admission in the shipped functions', () => {
  for (const entry of cases) {
    if (entry.rule !== 'trace') continue;
    const events = entry.input.events.map(toRow);
    const log: StageLog = entry.input.unknown ? { status: 'unknown', reason: 'unreadable-row' } : { status: 'readable', events };
    const label = JSON.stringify(entry.input);
    assert.deepEqual(latchView(deriveLatch(log)), entry.expected.latch, label);
    assert.deepEqual({
      manualOn: refusal(log, true, { kind: 'switch', trigger: 'manual' }),
      autoOn: refusal(log, true, { kind: 'switch', trigger: 'proactive' }),
      refreshOn: refusal(log, true, { kind: 'refresh' }),
      otherOn: otherRefusal(log, true),
      manualOff: refusal(log, false, { kind: 'switch', trigger: 'manual' }),
      autoOff: refusal(log, false, { kind: 'switch', trigger: 'proactive' }),
      refreshOff: refusal(log, false, { kind: 'refresh' }),
      otherOff: otherRefusal(log, false),
    }, entry.expected.admission, label);
  }
});

test('every Lean clear decision matches decideLatchClear', () => {
  for (const entry of cases) {
    if (entry.rule !== 'clear') continue;
    const decision = decideLatchClear({
      latch: toLatchView(entry.input.latch),
      throughId: entry.input.throughId,
      openWatch: entry.input.openWatch,
      fenceSet: entry.input.fenceSet,
      reason: entry.input.reasonEmpty ? '  ' : 'reviewed the stop',
    });
    const actual = decision.ok ? null
      : decision.refusal === 'newer-stop' ? { refusal: decision.refusal, newestStopId: decision.newestStopId }
        : { refusal: decision.refusal };
    assert.deepEqual(actual, entry.expected, JSON.stringify(entry.input));
  }
});
