import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  planAfterFetch,
} from '../src/poll-policy';

const PYTHON = `${process.env.HOME}/.local/share/uv/tools/claude-swap/bin/python`;
const CSWAP_V028_SOURCE = '/private/tmp/claude-501/-Users-sanketpatel-GIT-Personal-sanketvp/3b005b8d-b97c-4bb5-a726-86eaa04c5eb9/scratchpad/cswap-upstream/repo/src';
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

function pythonPlans(cases: OracleCase[]): Array<[number, number]> {
  const program = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(CSWAP_V028_SOURCE)})`,
    'from claude_swap.poll_policy import plan_after_fetch',
    'rows = json.load(sys.stdin)',
    'out = []',
    'for row in rows:',
    '    out.append(plan_after_fetch(prev_interval_s=row["prevIntervalS"], prev_usage=row["prevUsage"], new_usage=row["newUsage"], is_active=row["isActive"], threshold=row["threshold"], weekly_threshold=row.get("weeklyThreshold"), models=tuple(row["models"]), recent_429=row["recent429"], now=row["now"], rng=lambda row=row: row["rng"]))',
    'print(json.dumps(out))',
  ].join('\n');
  return JSON.parse(execFileSync(PYTHON, ['-I', '-c', program], {
    encoding: 'utf8',
    input: JSON.stringify(cases),
  })) as Array<[number, number]>;
}

describe('claude-swap poll policy port', () => {
  it('matches the C-swap v0.28.0 golden grid', (t) => {
    if (!existsSync(CSWAP_V028_SOURCE)) {
      t.skip(`C-swap v0.28.0 source is unavailable at ${CSWAP_V028_SOURCE}`);
      return;
    }
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
