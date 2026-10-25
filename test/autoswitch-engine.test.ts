// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — tests/test_autoswitch.py

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  bindingPct,
  decideAutoswitch,
  type AutoswitchAccount,
  type AutoswitchInput,
} from '../src/autoswitch';

const NOW = 1_700_000_000_000;

function account(
  accountId: string,
  usedPct: number | null,
  opts: Partial<AutoswitchAccount> = {},
): AutoswitchAccount {
  return {
    accountId,
    slotNum: Number(accountId),
    buckets: {
      '5h': { usedPct, resetAt: NOW + 60 * 60 * 1000 },
      '7d': { usedPct: usedPct === null ? null : 0, resetAt: NOW + 7 * 24 * 60 * 60 * 1000 },
    },
    ...opts,
  };
}

function input(overrides: Partial<AutoswitchInput> = {}): AutoswitchInput {
  return {
    accounts: [account('1', 95), account('2', 40), account('3', 20)],
    activeAccountId: '1',
    nowMs: NOW,
    ...overrides,
  };
}

function assertSwitch(
  result: ReturnType<typeof decideAutoswitch>,
  targetId: string,
  reason: string,
): void {
  assert.equal(result.kind, 'switch');
  if (result.kind !== 'switch') return;
  assert.equal(result.targetId, targetId);
  assert.equal(result.reason, reason);
}

describe('autoswitch decision engine — upstream decision table', () => {
  it('stays below threshold', () => {
    const result = decideAutoswitch(input({ accounts: [account('1', 50), account('2', 10)] }));
    assert.deepEqual(result, { kind: 'stay', reason: 'below-threshold', unhealthyTicks: 0 });
  });

  it('selects the most headroom, then lowest slot', () => {
    assertSwitch(decideAutoswitch(input()), '3', 'proactive');
    assertSwitch(decideAutoswitch(input({ accounts: [account('1', 95), account('3', 30), account('2', 30)] })), '2', 'proactive');
  });

  it('enforces proactive hysteresis and a healthy landing', () => {
    const marginal = decideAutoswitch(input({
      accounts: [account('1', 95), account('2', 86), account('3', 88)],
    }));
    assert.deepEqual(marginal, { kind: 'stay', reason: 'no-qualifying-candidate', unhealthyTicks: 0 });

    const unhealthyLanding = decideAutoswitch(input({
      settings: { threshold: 80, hysteresisPct: 5 },
      accounts: [account('1', 90), account('2', 85)],
    }));
    assert.deepEqual(unhealthyLanding, { kind: 'stay', reason: 'no-qualifying-candidate', unhealthyTicks: 0 });
  });

  it('gates only proactive switches during cooldown', () => {
    const cooldown = decideAutoswitch(input({ lastSwitchAtMs: NOW - 10_000 }));
    assert.deepEqual(cooldown, { kind: 'stay', reason: 'cooldown', unhealthyTicks: 0 });

    assertSwitch(decideAutoswitch(input({
      lastSwitchAtMs: NOW - 10_000,
      accounts: [account('1', 100), account('2', 85), account('3', 97)],
    })), '2', 'at-limit');
  });

  it('provider-reported limits and hard limits bypass cooldown and hysteresis', () => {
    assertSwitch(decideAutoswitch(input({
      lastSwitchAtMs: NOW - 10_000,
      providerReportedLimit: true,
      accounts: [account('1', 80), account('2', 97), account('3', 98)],
    })), '2', 'at-limit');
  });

  it('keeps unknown-usage grace despite a provider hard-limit until usage is known (S38)', () => {
    const base = input({
      providerReportedLimit: true,
      accounts: [account('1', null), account('2', 80)],
    });
    assert.deepEqual(decideAutoswitch(base), { kind: 'stay', reason: 'unknown', unhealthyTicks: 1 });
    assertSwitch(decideAutoswitch({ ...base, unhealthyTicks: 2 }), '2', 'failover');
  });

  it('uses provider hard-limit only with known usage for exhausted parking', () => {
    const reset = NOW + 10 * 60 * 1000;
    const result = decideAutoswitch(input({
      providerReportedLimit: true,
      accounts: [account('1', 80), account('2', 100, {
        buckets: { '5h': { usedPct: 100, resetAt: reset } },
      })],
    }));
    assert.deepEqual(result, {
      kind: 'switch', targetId: '2', reason: 'parked', unhealthyTicks: 0, parkedUntilMs: reset,
      leftHeadroom: 20, leftRecoveryAtMs: NOW + 60 * 60 * 1000, leftTrigger: 'parked',
    });
  });

  it('applies unknown grace to a dead active because upstream has no immediate-dead escape', () => {
    const base = input({ accounts: [account('1', null, { dead: true }), account('2', 80)] });
    assert.deepEqual(decideAutoswitch(base), { kind: 'stay', reason: 'unknown', unhealthyTicks: 1 });
    assertSwitch(decideAutoswitch({ ...base, unhealthyTicks: 2 }), '2', 'failover');
  });

  it('holds an expired active credential idle for at most 30 minutes without counting it unhealthy', () => {
    const base = input({ activeCredentialExpired: true, unhealthyTicks: 2, accounts: [account('1', null), account('2', 20)] });
    assert.deepEqual(decideAutoswitch(base), { kind: 'stay', reason: 'active-idle', unhealthyTicks: 0, idleHoldSinceMs: NOW });
    assert.deepEqual(decideAutoswitch({ ...base, unhealthyTicks: 0, idleHoldSinceMs: NOW - 30 * 60 * 1000 }), { kind: 'stay', reason: 'unknown', unhealthyTicks: 1 });
  });

  it('treats an expired credential as unknown after the idle hold even with cached usage', () => {
    const base = input({ activeCredentialExpired: true, idleHoldSinceMs: NOW - 30 * 60 * 1000, accounts: [account('1', 20), account('2', 20)] });
    assert.deepEqual(decideAutoswitch(base), { kind: 'stay', reason: 'unknown', unhealthyTicks: 1 });
    assertSwitch(decideAutoswitch({ ...base, unhealthyTicks: 2 }), '2', 'failover');
  });

  it('counts unknown active usage, then fails over without cooldown', () => {
    const unknown = input({
      lastSwitchAtMs: NOW - 10_000,
      accounts: [account('1', null), account('2', 85), account('3', 100)],
    });
    assert.deepEqual(decideAutoswitch(unknown), { kind: 'stay', reason: 'unknown', unhealthyTicks: 1 });
    assert.deepEqual(decideAutoswitch({ ...unknown, unhealthyTicks: 1 }), { kind: 'stay', reason: 'unknown', unhealthyTicks: 2 });
    assertSwitch(decideAutoswitch({ ...unknown, unhealthyTicks: 2 }), '2', 'failover');
  });

  it('clamps settings exactly like settings._clamped', () => {
    assertSwitch(decideAutoswitch(input({
      settings: { threshold: 30, hysteresisPct: -2, cooldownSeconds: -1, unhealthyTicks: 2.9 },
      accounts: [account('1', 50), account('2', 20)],
    })), '2', 'proactive');
    assertSwitch(decideAutoswitch(input({
      settings: { unhealthyTicks: 2.9 },
      accounts: [account('1', null), account('2', 20)],
      unhealthyTicks: 1,
    })), '2', 'failover');
  });

  it('uses defaults when settings values are undefined or non-finite', () => {
    for (const settings of [{ threshold: undefined }, { threshold: Number.NaN }]) {
      assertSwitch(decideAutoswitch(input({
        settings: settings as Partial<AutoswitchInput['settings']>,
        accounts: [account('1', 95), account('2', 20)],
      })), '2', 'proactive');
    }
    for (const settings of [{ unhealthyTicks: undefined }, { unhealthyTicks: Number.POSITIVE_INFINITY }]) {
      assert.deepEqual(decideAutoswitch(input({
        settings: settings as Partial<AutoswitchInput['settings']>,
        accounts: [account('1', null), account('2', 20)],
      })), { kind: 'stay', reason: 'unknown', unhealthyTicks: 1 });
    }
  });

  it('uses added time when equally-ranked accounts have no slot number', () => {
    assertSwitch(decideAutoswitch(input({
      accounts: [
        account('1', 95),
        account('2', 20, { slotNum: undefined, addedAtMs: 200 }),
        account('3', 20, { slotNum: undefined, addedAtMs: 100 }),
      ],
    })), '3', 'proactive');
  });

  it('resets unhealthy counting when the active account becomes known', () => {
    const result = decideAutoswitch(input({
      unhealthyTicks: 2,
      accounts: [account('1', 50), account('2', 10)],
    }));
    assert.deepEqual(result, { kind: 'stay', reason: 'below-threshold', unhealthyTicks: 0 });
  });

  it('excludes dead accounts and unknown candidate usage', () => {
    const result = decideAutoswitch(input({
      accounts: [account('1', 100), account('2', 1, { dead: true }), account('3', null)],
    }));
    assert.deepEqual(result, { kind: 'stay', reason: 'no-comparison', unhealthyTicks: 0 });
  });
});

describe('autoswitch recovery and no-return policy — spec §4.3 / S45', () => {
  it('keeps the no-return bar until the left account recovers, settling the [1,2,1,2] flap in one move', () => {
    const first = decideAutoswitch(input({
      accounts: [
        account('1', 96, { buckets: { '5h': { usedPct: 96, resetAt: NOW + 500 * 60 * 60 * 1000 } } }),
        account('2', 92, { buckets: { '5h': { usedPct: 92, resetAt: NOW + 400 * 60 * 60 * 1000 } } }),
      ],
    }));
    assertSwitch(first, '2', 'proactive');
    if (first.kind !== 'switch') return;
    const secondInput = input({
      activeAccountId: '2',
      accounts: [
        account('1', 96, { buckets: { '5h': { usedPct: 96, resetAt: NOW + 500 * 60 * 60 * 1000 } } }),
        account('2', 98, { buckets: { '5h': { usedPct: 98, resetAt: NOW + 400 * 60 * 60 * 1000 } } }),
      ],
    });
    assertSwitch(decideAutoswitch(secondInput), '1', 'proactive');
    const held = decideAutoswitch({
      ...secondInput,
      lastSwitchFrom: '1', lastSwitchTo: '2', leftHeadroom: first.leftHeadroom,
      leftRecoveryAtMs: first.leftRecoveryAtMs, leftTrigger: first.leftTrigger,
    });
    assert.equal(held.kind, 'stay');
  });

  it('uses either active or candidate recovery horizon for all-above ranking', () => {
    assertSwitch(decideAutoswitch(input({
      accounts: [
        account('1', 96, { buckets: { '5h': { usedPct: 96, resetAt: NOW + 20 * 60 * 60 * 1000 } } }),
        account('2', 95, { buckets: { '5h': { usedPct: 95, resetAt: NOW + 2 * 60 * 60 * 1000 } } }),
      ],
    })), '2', 'proactive');
  });

  it('keeps the no-return bar when neither recovery timestamp is known', () => {
    const withoutReset = (id: string, usedPct: number): AutoswitchAccount => ({ accountId: id, slotNum: Number(id), buckets: { '5h': { usedPct } } });
    assert.deepEqual(decideAutoswitch(input({
      activeAccountId: '2',
      accounts: [withoutReset('1', 96), withoutReset('2', 98)],
      lastSwitchFrom: '1', lastSwitchTo: '2', leftHeadroom: 4, leftRecoveryAtMs: null, leftTrigger: 'proactive',
    })), { kind: 'stay', reason: 'no-qualifying-candidate', unhealthyTicks: 0 });
  });

  it('uses consume-first from settings and only moves to an earlier weekly reset', () => {
    const accounts = [
      account('1', 20, { buckets: { '5h': { usedPct: 20 }, '7d': { usedPct: 20, resetAt: NOW + 10 * 60 * 60 * 1000 } } }),
      account('2', 10, { buckets: { '5h': { usedPct: 10 }, '7d': { usedPct: 10, resetAt: NOW + 20 * 60 * 60 * 1000 } } }),
    ];
    assert.deepEqual(decideAutoswitch(input({ settings: { strategy: 'consume-first' }, accounts })), { kind: 'stay', reason: 'no-qualifying-candidate', unhealthyTicks: 0 });
  });

  it('consume-first chooses the soonest weekly reset over greater headroom', () => {
    assertSwitch(decideAutoswitch(input({
      settings: { strategy: 'consume-first' },
      accounts: [
        account('1', 95, { buckets: { '5h': { usedPct: 95 }, '7d': { usedPct: 20, resetAt: NOW + 20 * 60 * 60 * 1000 } } }),
        account('2', 50, { buckets: { '5h': { usedPct: 50 }, '7d': { usedPct: 40, resetAt: NOW + 2 * 60 * 60 * 1000 } } }),
        account('3', 10, { buckets: { '5h': { usedPct: 10 }, '7d': { usedPct: 10, resetAt: NOW + 30 * 60 * 60 * 1000 } } }),
      ],
    })), '2', 'proactive');
  });
});

describe('autoswitch upstream recovery, all-above, and threshold classes — AC8', () => {
  const at = (hours: number) => NOW + hours * 60 * 60 * 1000;
  const atMinutes = (minutes: number) => NOW + minutes * 60 * 1000;

  // Ports of TestLandingGateIsPerCandidate and TestEveryAccountAboveThreshold.
  it('uses each candidate threshold for both landing and all-above census', () => {
    assertSwitch(decideAutoswitch(input({
      accounts: [
        account('1', 99),
        account('2', 88, { threshold: 85 }),
        account('3', 89, { threshold: 95 }),
      ],
    })), '3', 'proactive');

    // Both peers are over their own lines, so recovery ranking—not the
    // landing gate—selects the one whose binding window returns first.
    assertSwitch(decideAutoswitch(input({
      accounts: [
        account('1', 99, { buckets: { '5h': { usedPct: 99, resetAt: at(2) } } }),
        account('2', 88, { threshold: 85, buckets: { '5h': { usedPct: 88, resetAt: at(3) } } }),
        account('3', 89, { threshold: 85, buckets: { '5h': { usedPct: 89, resetAt: atMinutes(10) } } }),
      ],
    })), '3', 'proactive');
  });

  // Ports TestAntiFlapUsesTheBarredAccountsThreshold and
  // TestTheReleasePredicateOneStateShapePerTest's failover legs.
  it('releases a failover bar only when its candidate is healthy on its own line', () => {
    const state = { lastSwitchFrom: '1', lastSwitchTo: '2', leftHeadroom: null, leftRecoveryAtMs: null, leftTrigger: 'failover' as const };
    const held = decideAutoswitch(input({
      activeAccountId: '2',
      accounts: [account('1', 88, { threshold: 85 }), account('2', 98)],
      ...state,
    }));
    assert.deepEqual(held, { kind: 'stay', reason: 'no-qualifying-candidate', unhealthyTicks: 0 });
    assertSwitch(decideAutoswitch(input({
      activeAccountId: '2',
      accounts: [account('1', 88, { threshold: 95 }), account('2', 98)],
      ...state,
    })), '1', 'proactive');
  });

  // Ports TestRawHeadroomGuardsDoNotMove and the ordinary release predicate.
  it('uses raw headroom for no-return dominance and caps the departure baseline', () => {
    assertSwitch(decideAutoswitch(input({
      activeAccountId: '2',
      accounts: [account('1', 80, { threshold: 99 }), account('2', 95)],
      lastSwitchFrom: '1', lastSwitchTo: '2', leftHeadroom: 4, leftRecoveryAtMs: null, leftTrigger: 'proactive',
    })), '1', 'proactive');
    assertSwitch(decideAutoswitch(input({
      activeAccountId: '2', settings: { strategy: 'consume-first' },
      accounts: [
        account('1', 0, { buckets: { '5h': { usedPct: 0 }, '7d': { usedPct: 0, resetAt: at(1) } } }),
        account('2', 40, { buckets: { '5h': { usedPct: 40 }, '7d': { usedPct: 40, resetAt: at(2) } } }),
      ],
      lastSwitchFrom: '1', lastSwitchTo: '2', leftHeadroom: 98, leftRecoveryAtMs: null, leftTrigger: 'proactive',
    })), '1', 'consume-first');
  });

  // Ports TestRecoveryHorizon, TestHorizonAxisDoesNotFlap, and
  // TestAllSpentGoesToTheSoonestReset.
  it('uses recovery tiers, the spent fallback, and reset/headroom ordering', () => {
    assertSwitch(decideAutoswitch(input({
      accounts: [
        account('1', 99, { buckets: { '5h': { usedPct: 99, resetAt: at(300) } } }),
        account('2', 98.5, { buckets: { '5h': { usedPct: 98.5, resetAt: at(1) } } }),
        account('3', 91, { buckets: { '5h': { usedPct: 91, resetAt: at(400) } } }),
      ],
    })), '2', 'proactive');
    assertSwitch(decideAutoswitch(input({
      accounts: [
        account('1', 99.5, { buckets: { '5h': { usedPct: 99.5, resetAt: at(300) } } }),
        account('2', 99.5, { buckets: { '5h': { usedPct: 99.5, resetAt: at(10) } } }),
        account('3', 99, { buckets: { '5h': { usedPct: 99, resetAt: at(500) } } }),
      ],
    })), '2', 'proactive');
    assertSwitch(decideAutoswitch(input({
      accounts: [
        account('1', 99, { buckets: { '5h': { usedPct: 99, resetAt: at(20) } } }),
        account('2', 98, { buckets: { '5h': { usedPct: 98, resetAt: at(10) } } }),
        account('3', 96, { buckets: { '5h': { usedPct: 96, resetAt: at(20) } } }),
      ],
    })), '3', 'proactive');
  });

  // Ports TestTheReleasePredicateOneStateShapePerTest's pre-upgrade and
  // two-null-inference cases, plus _rank's unbarred retry.
  it('distinguishes absent snapshots and null leftTrigger', () => {
    const base = {
      activeAccountId: '2',
      accounts: [
        account('1', 96, { buckets: { '5h': { usedPct: 96, resetAt: at(300) } } }),
        account('2', 98, { buckets: { '5h': { usedPct: 98, resetAt: at(200) } } }),
      ],
      lastSwitchFrom: '1', lastSwitchTo: '2', leftHeadroom: null, leftRecoveryAtMs: null,
    };
    for (const leftTrigger of [undefined, null]) {
      assert.deepEqual(decideAutoswitch({ ...input(base), leftTrigger }), { kind: 'stay', reason: 'no-qualifying-candidate', unhealthyTicks: 0 });
    }
    assertSwitch(decideAutoswitch(input({
      activeAccountId: '2',
      accounts: [account('1', 0), account('2', 98)],
      lastSwitchFrom: '1', lastSwitchTo: '2',
    })), '1', 'proactive');
  });

  it('retries ranking without a recovered no-return bar when it was the only candidate', () => {
    assertSwitch(decideAutoswitch(input({
      activeAccountId: '2',
      accounts: [
        account('1', 96, { buckets: { '5h': { usedPct: 96, resetAt: at(1) } } }),
        account('2', 97, { buckets: { '5h': { usedPct: 97, resetAt: at(200) } } }),
      ],
      lastSwitchFrom: '1', lastSwitchTo: '2', leftHeadroom: 4,
      leftRecoveryAtMs: at(500), leftTrigger: 'proactive',
    })), '1', 'proactive');
  });

  it('keeps the headroom axis from moving for a one-point distant-reset edge', () => {
    assert.deepEqual(decideAutoswitch(input({
      accounts: [
        account('1', 95, { buckets: { '5h': { usedPct: 95, resetAt: at(109) } } }),
        account('2', 94, { buckets: { '5h': { usedPct: 94, resetAt: at(80) } } }),
      ],
    })), { kind: 'stay', reason: 'no-qualifying-candidate', unhealthyTicks: 0 });
  });

  it('does not include stale expired-active buckets in the exhausted proof', () => {
    const result = decideAutoswitch(input({
      activeCredentialExpired: true,
      idleHoldSinceMs: NOW - 30 * 60 * 1000,
      unhealthyTicks: 2,
      accounts: [
        account('1', 100, { buckets: { '5h': { usedPct: 100, resetAt: atMinutes(10) } } }),
        account('2', 100, { buckets: { '5h': { usedPct: 100, resetAt: atMinutes(20) } } }),
      ],
    }));
    assert.deepEqual(result, { kind: 'stay', reason: 'no-qualifying-candidate', unhealthyTicks: 3 });
  });

  // Regression for Infinity tuple components: Python tuple comparison falls
  // through equal infinities, then compares headroom and slot order.
  it('compares equal Infinity key components element-wise before slot order', () => {
    const noReset = (id: string, usedPct: number, slotNum = Number(id)): AutoswitchAccount => ({ accountId: id, slotNum, buckets: { '5h': { usedPct }, '7d': { usedPct: 0 } } });
    for (const accounts of [
      [noReset('1', 95), noReset('2', 50), noReset('3', 10)],
      [noReset('1', 95), noReset('3', 10), noReset('2', 50)],
    ]) assertSwitch(decideAutoswitch(input({ settings: { strategy: 'consume-first' }, accounts })), '3', 'proactive');

    assertSwitch(decideAutoswitch(input({
      accounts: [noReset('1', 97), noReset('3', 92, 3), noReset('2', 92, 2)],
    })), '2', 'proactive');
  });
});

describe('autoswitch binding golden grid', () => {
  const python = '/Users/sanketpatel/.local/share/uv/tools/claude-swap/bin/python';

  it('matches installed claude-swap binding_pct when available', (t) => {
    if (!existsSync(python)) {
      t.skip('installed claude-swap Python is unavailable');
      return;
    }
    const cases = [
      { five: 20, seven: 80 },
      { five: 95, seven: 10 },
      { five: null, seven: 50 },
      { five: null, seven: null },
    ];
    const script = [
      'import json, sys',
      'from claude_swap.poll_policy import binding_pct',
      'for c in json.load(sys.stdin):',
      '    u = {k: {"pct": v} for k, v in (("five_hour", c["five"]), ("seven_day", c["seven"])) if v is not None}',
      '    print(json.dumps(binding_pct(u)))',
    ].join('\n');
    const child = spawnSync(python, ['-I', '-c', script], {
      input: JSON.stringify(cases),
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const expected = child.stdout.trim().split('\n').map((line) => JSON.parse(line) as number | null);
    const actual = cases.map((c, index) => bindingPct(account(String(index + 1), c.five, {
      buckets: { '5h': { usedPct: c.five }, '7d': { usedPct: c.seven } },
    })));
    assert.deepEqual(actual, expected);
  });
});
