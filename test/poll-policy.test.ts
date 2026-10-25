// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — test_usage_store.py TestDueCandidate.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  ACTIVE_MAX_INTERVAL_S,
  CANDIDATE_MAX_INTERVAL_S,
  EDGE_BACKOFF_S,
  EXHAUSTED_INTERVAL_S,
  JITTER_FRAC,
  MIN_INTERVAL_S,
  POST_429_MAX_INTERVAL_S,
  POST_429_MIN_INTERVAL_S,
  SERVE_TTL_S,
  URGENT_INTERVAL_S,
  bindingPct,
  dueCandidate,
  limitingResetTs,
  type DueCandidateSlot,
  parseResetTs,
  planAfterFetch,
  repairOverduePlans,
} from '../src/poll-policy';
import { openStore } from '../src/store';

const PYTHON = 'python3';
const CSWAP_V028_SOURCE = resolve(__dirname, '../../test/oracle/claude-swap-v0.28.0/src');
const NOW = 1_700_000_000;

type Usage = Record<string, unknown>;

type OracleCase = {
  prevIntervalS: number | null;
  prevUsage: Usage | null;
  newUsage: Usage | null;
  isActive: boolean;
  threshold: number;
  weeklyThreshold?: number | null;
  models: string[];
  recent429: boolean;
  now: number;
  rng: number;
};

function usage(pct: number, reset?: string): Usage {
  return {
    five_hour: { pct, ...(reset ? { resets_at: reset } : {}) },
    seven_day: { pct: 10 },
  };
}

function usage7(pct5: number, pct7: number): Usage {
  return { five_hour: { pct: pct5 }, seven_day: { pct: pct7 } };
}

function pythonProgram(program: string, input: unknown): unknown {
  const wrapper = [
    'import os, subprocess, sys',
    'if sys.version_info < (3, 12):',
    '    found = subprocess.run(["uv", "python", "find", "3.12"], capture_output=True, check=False, text=True).stdout.strip()',
    '    if not found: raise RuntimeError("vendored claude-swap v0.28.0 requires Python 3.12 or newer")',
    `    os.execv(found, [found, '-I', '-B', '-c', ${JSON.stringify(program)}])`,
    `exec(${JSON.stringify(program)})`,
  ].join('\n');
  return JSON.parse(execFileSync(PYTHON, ['-I', '-B', '-c', wrapper], {
    encoding: 'utf8',
    input: JSON.stringify(input),
  }));
}

function pythonPlans(cases: OracleCase[]): Array<[number, number]> {
  const oracleProgram = [
    'import json, pathlib, sys, tempfile',
    `source = ${JSON.stringify(CSWAP_V028_SOURCE)}`,
    'with tempfile.TemporaryDirectory() as temp:',
    '    metadata = pathlib.Path(temp) / "claude_swap-0.28.0.dist-info"',
    '    metadata.mkdir()',
    '    (metadata / "METADATA").write_text("Metadata-Version: 2.1\\nName: claude-swap\\nVersion: 0.28.0\\n")',
    '    sys.path[:0] = [source, temp]',
    '    from claude_swap.poll_policy import plan_after_fetch',
    '    rows = json.load(sys.stdin)',
    '    out = []',
    '    for row in rows:',
    '        out.append(plan_after_fetch(prev_interval_s=row["prevIntervalS"], prev_usage=row["prevUsage"], new_usage=row["newUsage"], is_active=row["isActive"], threshold=row["threshold"], weekly_threshold=row.get("weeklyThreshold"), models=tuple(row["models"]), recent_429=row["recent429"], now=row["now"], rng=lambda row=row: row["rng"]))',
    '    print(json.dumps(out))',
  ].join('\n');
  return pythonProgram(oracleProgram, cases) as Array<[number, number]>;
}

function pythonResetTimestamps(values: readonly string[]): Array<number | null> {
  const program = [
    'import json, sys',
    'from datetime import datetime',
    'out = []',
    'for value in json.load(sys.stdin):',
    '    try:',
    '        out.append(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())',
    '    except ValueError:',
    '        out.append(None)',
    'print(json.dumps(out))',
  ].join('\n');
  return pythonProgram(program, values) as Array<number | null>;
}

describe('claude-swap poll policy port', () => {
  it('matches the C-swap v0.28.0 golden grid', () => {
    assert.equal(existsSync(CSWAP_V028_SOURCE), true, `missing vendored oracle at ${CSWAP_V028_SOURCE}`);
    const cases: OracleCase[] = [
      { prevIntervalS: null, prevUsage: null, newUsage: usage(20), isActive: true, threshold: 80, models: [], recent429: false, now: NOW, rng: 0.25 },
      { prevIntervalS: 180, prevUsage: usage(10), newUsage: usage(12), isActive: true, threshold: 80, models: [], recent429: false, now: NOW, rng: 0.5 },
      { prevIntervalS: 180, prevUsage: usage(10), newUsage: usage(10.999), isActive: true, threshold: 80, models: [], recent429: false, now: NOW, rng: 0.5 },
      { prevIntervalS: 300, prevUsage: usage(60), newUsage: usage(70), isActive: true, threshold: 80, models: [], recent429: false, now: NOW, rng: 0.75 },
      { prevIntervalS: 60, prevUsage: usage(70), newUsage: usage(70), isActive: true, threshold: 80, models: [], recent429: false, now: NOW, rng: 0.5 },
      { prevIntervalS: 300, prevUsage: usage(20), newUsage: usage(20), isActive: false, threshold: 80, models: [], recent429: false, now: NOW, rng: 0.25 },
      { prevIntervalS: 600, prevUsage: usage(20), newUsage: usage(30), isActive: false, threshold: 80, models: [], recent429: false, now: NOW, rng: 0.5 },
      { prevIntervalS: 180, prevUsage: usage(70), newUsage: usage(80), isActive: true, threshold: 80, models: [], recent429: true, now: NOW, rng: 0.5 },
      { prevIntervalS: 600, prevUsage: usage(70), newUsage: usage(80), isActive: true, threshold: 80, models: [], recent429: true, now: NOW, rng: 0.5 },
      { prevIntervalS: 1_800, prevUsage: usage(70), newUsage: usage(80), isActive: false, threshold: 80, models: [], recent429: true, now: NOW, rng: 0.5 },
      { prevIntervalS: 300, prevUsage: usage(99), newUsage: usage(100, '2023-11-14T22:20:30Z'), isActive: true, threshold: 80, models: [], recent429: false, now: NOW, rng: 0.5 },
      { prevIntervalS: 300, prevUsage: usage(20, '2023-11-14T22:14:00Z'), newUsage: usage(20, '2023-11-14T22:14:00Z'), isActive: false, threshold: 80, models: [], recent429: false, now: NOW, rng: 0.5 },
      { prevIntervalS: 300, prevUsage: { five_hour: { pct: 20 }, seven_day: { pct: 10 }, scoped: [{ name: 'Opus', pct: 50 }] }, newUsage: { five_hour: { pct: 20 }, seven_day: { pct: 10 }, scoped: [{ name: 'Opus', pct: 80 }] }, isActive: true, threshold: 90, models: ['opus'], recent429: false, now: NOW, rng: 0.5 },
      { prevIntervalS: 180, prevUsage: usage7(80, 94), newUsage: usage7(84, 94), isActive: true, threshold: 85, weeklyThreshold: 97, models: [], recent429: false, now: NOW, rng: 0.5 },
      { prevIntervalS: 600, prevUsage: usage7(20, 90.5), newUsage: usage7(20, 96.9), isActive: false, threshold: 85, weeklyThreshold: 97, models: [], recent429: false, now: NOW, rng: 0.5 },
    ];
    const expected = pythonPlans(cases);
    const actual = cases.map((row) => planAfterFetch({ ...row, rng: () => row.rng }));
    assert.deepEqual(actual, expected);
  });

  it('matches Python fromisoformat reset timestamps, including year-boundary ISO weeks', () => {
    const cases = [
      '2023-11-14T22:13:20.000123+00:00',
      '2026-W53-5',
      '2027-W01-1',
      '2026-W53-5T00:00:00Z',
      '2027-W01-1T00:00:00Z',
      '2023-11-14T22:1320+00:00',
      '2023-11-14T2213:20+00:00',
      '2023-11-14T22:13:20+00:60',
      '2023-11-14T22:13:20+0060',
      '2023-11-14T22:13:20.Z',
      '2023-11-14T22:13:20.+00:00',
      '2023-11-14T22:13:20 +00:00',
      '2023-11-14T22:13:20+00:0000',
      '2023-11-14T22:13:20.',
      '14 November 2023 22:13:20 UTC',
      '2023-02-29T22:13:20+00:00',
    ];
    const expected = pythonResetTimestamps(cases);
    for (const [index, value] of cases.entries()) {
      assert.equal(parseResetTs(value), expected[index], value);
    }
    assert.equal(limitingResetTs({
      five_hour: { pct: 100, resets_at: '2023-11-14T22:13:20.000123+00:00' },
      seven_day: { pct: 100, resets_at: '2023-11-14T22:13:20.000456+00:00' },
    }), NOW + 0.000456);
  });

  it('matches every committed poll-policy golden plan', () => {
    const golden = JSON.parse(readFileSync(resolve(__dirname, '../../test/oracle/goldens/poll_policy.json'), 'utf8')) as {
      plans: Record<string, { next_poll_at: number; interval_s: number }>;
    };
    const cases: Record<string, OracleCase> = {
      unknown_active: { prevIntervalS: null, prevUsage: null, newUsage: null, isActive: true, threshold: 90, models: [], recent429: false, now: 1000, rng: 0.5 },
      unknown_candidate: { prevIntervalS: null, prevUsage: null, newUsage: null, isActive: false, threshold: 90, models: [], recent429: false, now: 1000, rng: 0.5 },
      stable_active: { prevIntervalS: 180, prevUsage: usage(40), newUsage: usage(40), isActive: true, threshold: 90, models: [], recent429: false, now: 1000, rng: 0.5 },
      stable_candidate: { prevIntervalS: 300, prevUsage: usage(40), newUsage: usage(40), isActive: false, threshold: 90, models: [], recent429: false, now: 1000, rng: 0.5 },
      moving_active: { prevIntervalS: 300, prevUsage: usage(40), newUsage: usage(50), isActive: true, threshold: 90, models: [], recent429: false, now: 1000, rng: 0.5 },
      urgent_active: { prevIntervalS: 300, prevUsage: usage(70), newUsage: usage(80), isActive: true, threshold: 90, models: [], recent429: false, now: 1000, rng: 0.5 },
      recent_429: { prevIntervalS: 600, prevUsage: usage(40), newUsage: usage(50), isActive: true, threshold: 90, models: [], recent429: true, now: 1000, rng: 0.5 },
      exhausted_reset_cap: { prevIntervalS: 180, prevUsage: usage(99), newUsage: usage(100, '1970-01-01T00:18:00+00:00'), isActive: false, threshold: 90, models: [], recent429: false, now: 1000, rng: 0.5 },
      scoped_model_binds: { prevIntervalS: 300, prevUsage: { five_hour: { pct: 30 }, seven_day: { pct: 10 }, scoped: [{ name: 'Fable', pct: 60 }] }, newUsage: { five_hour: { pct: 30 }, seven_day: { pct: 10 }, scoped: [{ name: 'Fable', pct: 80 }] }, isActive: true, threshold: 90, models: ['Fable'], recent429: false, now: 1000, rng: 0 },
      weekly_threshold_urgent: { prevIntervalS: 300, prevUsage: usage7(20, 55), newUsage: usage7(25, 65), isActive: true, threshold: 90, weeklyThreshold: 60, models: [], recent429: false, now: 1000, rng: 0.5 },
      weekly_threshold_defers: { prevIntervalS: 300, prevUsage: usage7(10, 75), newUsage: usage7(15, 80), isActive: true, threshold: 50, weeklyThreshold: 99, models: [], recent429: false, now: 1000, rng: 0.5 },
    };
    assert.deepEqual(Object.keys(cases).sort(), Object.keys(golden.plans).sort());
    for (const [name, row] of Object.entries(cases)) {
      const expected = golden.plans[name];
      assert.deepEqual(planAfterFetch({ ...row, rng: () => row.rng }), [expected.next_poll_at, expected.interval_s], name);
    }
  });

  it('uses the exact 180-second floor boundary', () => {
    const prev = usage(10);
    assert.deepEqual(planAfterFetch({
      prevIntervalS: 180,
      prevUsage: prev,
      newUsage: usage(10),
      isActive: true,
      threshold: 80,
      models: [],
      recent429: false,
      now: NOW,
      rng: () => 0.5,
    }), [NOW + 270, 270]);
    assert.deepEqual(planAfterFetch({
      prevIntervalS: 179.999,
      prevUsage: prev,
      newUsage: usage(10),
      isActive: true,
      threshold: 80,
      models: [],
      recent429: false,
      now: NOW,
      rng: () => 0.5,
    }), [NOW + 269.9985, 269.9985]);
  });

  it('uses per-window, rising-only urgency under each window line', () => {
    const active = (
      prevUsage: Usage,
      newUsage: Usage,
      overrides: Partial<Pick<OracleCase, 'threshold' | 'weeklyThreshold' | 'models'>> = {},
    ) => planAfterFetch({
      prevIntervalS: MIN_INTERVAL_S,
      prevUsage,
      newUsage,
      isActive: true,
      threshold: overrides.threshold ?? 90,
      weeklyThreshold: overrides.weeklyThreshold,
      models: overrides.models ?? [],
      recent429: false,
      now: NOW,
      rng: () => 0.5,
    })[1];

    assert.equal(active(usage(78), usage(82)), URGENT_INTERVAL_S);
    assert.equal(active(usage7(76, 85), usage7(78, 85.2)), URGENT_INTERVAL_S);
    assert.equal(active(usage7(80, 94), usage7(84, 94), { threshold: 85, weeklyThreshold: 97 }), URGENT_INTERVAL_S);
    assert.equal(active(usage7(20, 90.5), usage7(20, 96.9), { threshold: 85, weeklyThreshold: 97 }), URGENT_INTERVAL_S);
    assert.equal(active(usage7(60, 94), usage7(62, 94), { threshold: 85, weeklyThreshold: 97 }), 270);
    assert.equal(active(usage(90), usage(80)), MIN_INTERVAL_S);
    assert.equal(active(usage7(90, 80), usage7(60, 80)), MIN_INTERVAL_S);
    assert.equal(active(usage7(84, 95.9), usage7(84.1, 95.9), { threshold: 85, weeklyThreshold: 97 }), 270);

    const withoutWeekly = { five_hour: { pct: 10 } };
    assert.equal(active(withoutWeekly, usage7(10, 85)), MIN_INTERVAL_S);

    const scoped = (fable: number): Usage => ({
      five_hour: { pct: 10 },
      seven_day: { pct: 10 },
      scoped: [{ name: 'Fable', pct: fable }],
    });
    assert.equal(active(scoped(80), scoped(83), { threshold: 85, weeklyThreshold: 97, models: ['Fable'] }), URGENT_INTERVAL_S);
    assert.equal(active(scoped(80), scoped(83), { threshold: 85, weeklyThreshold: 97 }), 270);

    const candidate = planAfterFetch({
      prevIntervalS: 300,
      prevUsage: usage7(80, 94),
      newUsage: usage7(84, 94),
      isActive: false,
      threshold: 85,
      weeklyThreshold: 97,
      models: [],
      recent429: false,
      now: NOW,
      rng: () => 0.5,
    });
    assert.equal(candidate[1], 450);

    const weeklyCandidate = planAfterFetch({
      prevIntervalS: 600,
      prevUsage: usage7(20, 90.5),
      newUsage: usage7(20, 96.9),
      isActive: false,
      threshold: 85,
      weeklyThreshold: 97,
      models: [],
      recent429: false,
      now: NOW,
      rng: () => 0.5,
    });
    assert.equal(weeklyCandidate[1], 300);
  });

  it('exports the C-swap cadence constants unchanged', () => {
    assert.deepEqual({
      SERVE_TTL_S, MIN_INTERVAL_S, URGENT_INTERVAL_S, ACTIVE_MAX_INTERVAL_S,
      CANDIDATE_MAX_INTERVAL_S, EDGE_BACKOFF_S, POST_429_MIN_INTERVAL_S,
      POST_429_MAX_INTERVAL_S, EXHAUSTED_INTERVAL_S, JITTER_FRAC,
    }, {
      SERVE_TTL_S: 180, MIN_INTERVAL_S: 180, URGENT_INTERVAL_S: 60,
      ACTIVE_MAX_INTERVAL_S: 300, CANDIDATE_MAX_INTERVAL_S: 600,
      EDGE_BACKOFF_S: 300, POST_429_MIN_INTERVAL_S: 360,
      POST_429_MAX_INTERVAL_S: 1800, EXHAUSTED_INTERVAL_S: 600, JITTER_FRAC: 0.1,
    });
    assert.equal(bindingPct({ five_hour: { pct: 80 }, seven_day: { pct: 20 } }), 80);
  });
});

describe('claude-swap due-candidate port', () => {
  const now = 1_000_000;

  it('matches the v0.28.0 TestDueCandidate golden grid', () => {
    // Direct transcription of usage_store.py v0.28.0 TestDueCandidate cases
    // that concern the pure fields exposed by this TypeScript port.
    const grid: Array<{
      candidates: string[];
      entries: Record<string, DueCandidateSlot>;
      now?: number;
      expected: string | null;
    }> = [
      { candidates: ['2', '3'], entries: { '3': { lastFetchAt: now - 60 } }, expected: '2' },
      {
        candidates: ['2', '3'],
        entries: { '2': { lastFetchAt: now - 999 }, '3': {} },
        expected: '3',
      },
      {
        candidates: ['2', '3'],
        entries: { '2': { lastFetchAt: now - 60 }, '3': { lastFetchAt: now - 300 } },
        expected: '3',
      },
      { candidates: ['2'], entries: { '2': { backoffUntil: now + 10 } }, expected: null },
      {
        candidates: ['2'],
        entries: { '2': { backoffUntil: now + 10 } },
        now: now + 11,
        expected: '2',
      },
      {
        candidates: ['2', '3'],
        entries: {
          '2': { lastFetchAt: now - 300, nextDueAt: now + 60 },
          '3': { lastFetchAt: now - 60 },
        },
        expected: '3',
      },
      {
        candidates: ['2', '3'],
        entries: {
          '2': { lastFetchAt: now - 400, lastAttemptAt: now - 400 },
          '3': { lastAttemptAt: now - 60 },
        },
        expected: '2',
      },
      {
        candidates: ['2', '3'],
        entries: {
          '2': { lastFetchAt: now - 30, lastAttemptAt: now - 30 },
          '3': { lastAttemptAt: now - 60 },
        },
        expected: '3',
      },
      {
        candidates: ['2', '3'],
        entries: {
          '2': { lastFetchAt: now - 30, lastAttemptAt: now - 900 },
          '3': { lastFetchAt: now - 600, lastAttemptAt: now - 600 },
        },
        expected: '3',
      },
      { candidates: [], entries: {}, expected: null },
    ];

    for (const row of grid) {
      assert.equal(dueCandidate(row.candidates, row.entries, row.now ?? now), row.expected);
    }
  });

  it('repairs an obsolete reset-parked plan that oversleeps its interval', () => {
    const entries: Record<string, DueCandidateSlot> = {
      parked: {
        lastFetchAt: now - 1_000,
        nextDueAt: now + 86_400,
        pollIntervalS: 600,
      },
      recent: { lastFetchAt: now - 10 },
    };
    assert.equal(dueCandidate(['parked', 'recent'], entries, now), 'parked');
  });

  it('yields a held row to an unheld row and quarantines dead tokens', () => {
    // QLB §4.6 / AC46: a held Codex slot must not consume the one alternate
    // poll, and a known-dead refresh token remains quarantined after backoff.
    const entries: Record<string, DueCandidateSlot> = {
      held: { lastFetchAt: now - 900, heldUntil: now + 1 },
      dead: { lastFetchAt: now - 800, lastStatus: 'token_dead' },
      available: { lastFetchAt: now - 60 },
    };
    assert.equal(dueCandidate(['held', 'dead', 'available'], entries, now), 'available');
  });

  it('limits an overdue cohort to one alternate poll', () => {
    // The one-alternate policy repairs the selected stale plan through its
    // normal post-fetch plan; it must not nominate all six at once.
    const entries = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`slot-${index}`, {
        lastFetchAt: now - 1_200 - index,
        nextDueAt: now - 601 - index,
        pollIntervalS: 600,
      }]),
    ) as Record<string, DueCandidateSlot>;
    assert.equal(dueCandidate(Object.keys(entries), entries, now), 'slot-5');
  });

  it('repairs an overdue cohort into one poll now and five persisted jittered plans', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-overdue-repair-')), 'qlb.db');
    const provider = 'anthropic';
    const entries = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`slot-${index}`, {
        lastFetchAt: now - 1_200 - index,
        nextDueAt: now - 601 - index,
        pollIntervalS: 600,
      }]),
    ) as Record<string, DueCandidateSlot>;
    const store = openStore(path);
    try {
      store.writeUsagePollPlans(provider, Object.fromEntries(Object.entries(entries).map(([accountId, entry]) => [accountId, {
        nextDueAt: entry.nextDueAt!,
        pollIntervalS: entry.pollIntervalS!,
      }])));
      const randomValues = [0, 0.25, 0.5, 0.75, 1];
      let randomIndex = 0;
      const chosen = repairOverduePlans({
        provider,
        candidates: Object.keys(entries),
        entries,
        now,
        rng: () => randomValues[randomIndex++]!,
        writer: store,
      });
      assert.equal(chosen, 'slot-5');
      assert.equal(randomIndex, 5);
    } finally {
      store.close();
    }

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = (db.prepare(`SELECT account_id, next_due_at, poll_interval_s
        FROM usage_polls WHERE provider = ? ORDER BY account_id`).all(provider) as Array<{
          account_id: string; next_due_at: number; poll_interval_s: number;
        }>).map((row) => ({ ...row }));
      assert.deepEqual(rows, [
        { account_id: 'slot-0', next_due_at: now + 540, poll_interval_s: 600 },
        { account_id: 'slot-1', next_due_at: now + 570, poll_interval_s: 600 },
        { account_id: 'slot-2', next_due_at: now + 600, poll_interval_s: 600 },
        { account_id: 'slot-3', next_due_at: now + 630, poll_interval_s: 600 },
        { account_id: 'slot-4', next_due_at: now + 660, poll_interval_s: 600 },
        { account_id: 'slot-5', next_due_at: now - 606, poll_interval_s: 600 },
      ]);
      const repairedEntries = Object.fromEntries(rows.map((row) => [row.account_id, {
        ...entries[row.account_id]!,
        nextDueAt: row.next_due_at,
        pollIntervalS: row.poll_interval_s,
      }]));
      assert.equal(dueCandidate(Object.keys(repairedEntries), repairedEntries, now), 'slot-5');
    } finally {
      db.close();
    }
  });

  it('leaves a never-planned overdue row unchanged while repairing saved plans', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-overdue-null-interval-')), 'qlb.db');
    const provider = 'anthropic';
    const entries: Record<string, DueCandidateSlot> = {
      selected: { lastFetchAt: now - 1_300, nextDueAt: now - 601, pollIntervalS: 600 },
      saved: { lastFetchAt: now - 1_200, nextDueAt: now - 601, pollIntervalS: 600 },
      neverPlanned: { lastFetchAt: now - 1_100, nextDueAt: now - 601, pollIntervalS: null },
    };
    const store = openStore(path);
    try {
      store.writeUsagePollPlans(provider, {
        selected: { nextDueAt: now - 601, pollIntervalS: 600 },
        saved: { nextDueAt: now - 601, pollIntervalS: 600 },
      });
      const db = new DatabaseSync(path);
      try {
        db.prepare('INSERT INTO usage_polls (provider, account_id, next_due_at, poll_interval_s) VALUES (?, ?, ?, NULL)')
          .run(provider, 'neverPlanned', now - 601);
      } finally { db.close(); }
      assert.equal(repairOverduePlans({ provider, candidates: Object.keys(entries), entries, now, rng: () => 0.5, writer: store }), 'selected');
    } finally { store.close(); }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual((db.prepare('SELECT account_id, next_due_at, poll_interval_s FROM usage_polls WHERE provider = ? ORDER BY account_id').all(provider) as Array<Record<string, unknown>>).map((row) => ({ ...row })), [
        { account_id: 'neverPlanned', next_due_at: now - 601, poll_interval_s: null },
        { account_id: 'saved', next_due_at: now + 600, poll_interval_s: 600 },
        { account_id: 'selected', next_due_at: now - 601, poll_interval_s: 600 },
      ]);
    } finally { db.close(); }
  });

  it('does not overwrite a concurrent fetch plan while repairing other overdue rows', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-overdue-cas-plan-')), 'qlb.db');
    const provider = 'anthropic';
    const entries: Record<string, DueCandidateSlot> = {
      selected: { lastFetchAt: now - 1_300, nextDueAt: now - 601, pollIntervalS: 600 },
      stale: { lastFetchAt: now - 1_200, nextDueAt: now - 601, pollIntervalS: 600 },
      other: { lastFetchAt: now - 1_100, nextDueAt: now - 601, pollIntervalS: 600 },
    };
    const store = openStore(path);
    try {
      assert.equal(store.writeUsagePollPlans(provider, Object.fromEntries(Object.entries(entries).map(([accountId, entry]) => [accountId, {
        nextDueAt: entry.nextDueAt!, pollIntervalS: entry.pollIntervalS!,
      }]))), 3);
      assert.equal(store.writeUsagePollPlans(provider, { stale: { nextDueAt: now + 900, pollIntervalS: 900 } }), 1);
      assert.equal(repairOverduePlans({ provider, candidates: Object.keys(entries), entries, now, rng: () => 0.5, writer: store }), 'selected');
    } finally { store.close(); }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual((db.prepare('SELECT account_id, next_due_at, poll_interval_s FROM usage_polls WHERE provider = ? ORDER BY account_id').all(provider) as Array<Record<string, unknown>>).map((row) => ({ ...row })), [
        { account_id: 'other', next_due_at: now + 600, poll_interval_s: 600 },
        { account_id: 'selected', next_due_at: now - 601, poll_interval_s: 600 },
        { account_id: 'stale', next_due_at: now + 900, poll_interval_s: 900 },
      ]);
    } finally { db.close(); }
  });

  it('does not repair a row placed on hold after its snapshot', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-overdue-cas-hold-')), 'qlb.db');
    const provider = 'anthropic';
    const entries: Record<string, DueCandidateSlot> = {
      selected: { lastFetchAt: now - 1_300, nextDueAt: now - 601, pollIntervalS: 600 },
      held: { lastFetchAt: now - 1_200, nextDueAt: now - 601, pollIntervalS: 600 },
    };
    const store = openStore(path);
    try {
      store.writeUsagePollPlans(provider, Object.fromEntries(Object.entries(entries).map(([accountId, entry]) => [accountId, { nextDueAt: entry.nextDueAt!, pollIntervalS: entry.pollIntervalS! }])));
      const db = new DatabaseSync(path);
      try { db.prepare('UPDATE usage_polls SET held_until = ? WHERE provider = ? AND account_id = ?').run(now + 1, provider, 'held'); } finally { db.close(); }
      assert.equal(repairOverduePlans({ provider, candidates: Object.keys(entries), entries, now, rng: () => 0.5, writer: store }), 'selected');
    } finally { store.close(); }
    const db = new DatabaseSync(path, { readOnly: true });
    try { assert.equal((db.prepare('SELECT next_due_at FROM usage_polls WHERE account_id = ?').get('held') as { next_due_at: number }).next_due_at, now - 601); } finally { db.close(); }
  });

  it('does not repair rows backed off or marked token-dead after their snapshot', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-overdue-cas-excluded-')), 'qlb.db');
    const provider = 'anthropic';
    const entries: Record<string, DueCandidateSlot> = {
      selected: { lastFetchAt: now - 1_400, nextDueAt: now - 601, pollIntervalS: 600 },
      backedOff: { lastFetchAt: now - 1_300, nextDueAt: now - 601, pollIntervalS: 600 },
      dead: { lastFetchAt: now - 1_200, nextDueAt: now - 601, pollIntervalS: 600 },
    };
    const store = openStore(path);
    try {
      store.writeUsagePollPlans(provider, Object.fromEntries(Object.entries(entries).map(([accountId, entry]) => [accountId, { nextDueAt: entry.nextDueAt!, pollIntervalS: entry.pollIntervalS! }])));
      const db = new DatabaseSync(path);
      try {
        db.prepare('UPDATE usage_polls SET backoff_until = ? WHERE provider = ? AND account_id = ?').run(now + 1, provider, 'backedOff');
        db.prepare("UPDATE usage_polls SET last_status = 'token_dead' WHERE provider = ? AND account_id = ?").run(provider, 'dead');
      } finally { db.close(); }
      assert.equal(repairOverduePlans({ provider, candidates: Object.keys(entries), entries, now, rng: () => 0.5, writer: store }), 'selected');
    } finally { store.close(); }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual((db.prepare("SELECT account_id, next_due_at FROM usage_polls WHERE account_id IN ('backedOff', 'dead') ORDER BY account_id").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })), [
        { account_id: 'backedOff', next_due_at: now - 601 },
        { account_id: 'dead', next_due_at: now - 601 },
      ]);
    } finally { db.close(); }
  });

  it('does not repair held or dead overdue plans', () => {
    const plans: Array<{ accountId: string; nextDueAt: number; pollIntervalS: number }> = [];
    const entries: Record<string, DueCandidateSlot> = {
      held: { lastFetchAt: now - 1_500, nextDueAt: now - 601, pollIntervalS: 600, heldUntil: now + 1 },
      dead: { lastFetchAt: now - 1_400, nextDueAt: now - 601, pollIntervalS: 600, deadToken: true },
      selected: { lastFetchAt: now - 1_300, nextDueAt: now - 601, pollIntervalS: 600 },
      repaired: { lastFetchAt: now - 1_200, nextDueAt: now - 601, pollIntervalS: 600 },
    };
    const chosen = repairOverduePlans({
      provider: 'anthropic',
      candidates: Object.keys(entries),
      entries,
      now,
      rng: () => 0.5,
      writer: { writeUsagePollPlans: (_provider, rows) => plans.push(...Object.entries(rows).map(([accountId, plan]) => ({ accountId, ...plan }))) },
    });
    assert.equal(chosen, 'selected');
    assert.deepEqual(plans, [{
      accountId: 'repaired',
      nextDueAt: now + 600,
      pollIntervalS: 600,
      expectedNextDueAt: now - 601,
      expectedPollIntervalS: 600,
    }]);
  });

  it('matches the C-swap plan-after-fetch oracle for repaired jitter', () => {
    const entries: Record<string, DueCandidateSlot> = {
      selected: { lastFetchAt: now - 1_300, nextDueAt: now - 601, pollIntervalS: 600 },
      low: { lastFetchAt: now - 1_200, nextDueAt: now - 601, pollIntervalS: 600 },
      middle: { lastFetchAt: now - 1_100, nextDueAt: now - 601, pollIntervalS: 600 },
      high: { lastFetchAt: now - 1_000, nextDueAt: now - 601, pollIntervalS: 600 },
    };
    const randomValues = [0, 0.5, 1];
    let randomIndex = 0;
    let actual: Record<string, { nextDueAt: number; pollIntervalS: number }> = {};
    repairOverduePlans({
      provider: 'anthropic',
      candidates: Object.keys(entries),
      entries,
      now,
      rng: () => randomValues[randomIndex++]!,
      writer: { writeUsagePollPlans: (_provider, plans) => { actual = plans; return 0; } },
    });
    const expected = pythonPlans(randomValues.map((rng) => ({
      prevIntervalS: 600,
      prevUsage: usage(20),
      newUsage: usage(20),
      isActive: false,
      threshold: 80,
      models: [],
      recent429: false,
      now,
      rng,
    })));
    assert.deepEqual(actual, {
      low: { nextDueAt: expected[0]![0], pollIntervalS: expected[0]![1], expectedNextDueAt: now - 601, expectedPollIntervalS: 600 },
      middle: { nextDueAt: expected[1]![0], pollIntervalS: expected[1]![1], expectedNextDueAt: now - 601, expectedPollIntervalS: 600 },
      high: { nextDueAt: expected[2]![0], pollIntervalS: expected[2]![1], expectedNextDueAt: now - 601, expectedPollIntervalS: 600 },
    });
  });

  it('does not let a repeatedly failing slot starve another due slot', () => {
    // The failed slot has no new measurement but was attempted on the latest
    // tick. C-swap keys on max(fetchedAt, lastAttemptAt), so the older healthy
    // slot must be nominated next.
    const entries: Record<string, DueCandidateSlot> = {
      failed: { lastFetchAt: now - 1_000, lastAttemptAt: now - 5 },
      other: { lastFetchAt: now - 100, lastAttemptAt: now - 100 },
    };
    assert.equal(dueCandidate(['failed', 'other'], entries, now), 'other');

    // Once the other slot was polled, the previously failing slot gets its
    // turn again rather than being suppressed permanently.
    entries.other.lastAttemptAt = now;
    assert.equal(dueCandidate(['failed', 'other'], entries, now), 'failed');
  });
});
