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
    const base = input({ activeCredentialExpired: true, accounts: [account('1', null), account('2', 20)] });
    assert.deepEqual(decideAutoswitch(base), { kind: 'stay', reason: 'active-idle', unhealthyTicks: 0, idleHoldSinceMs: NOW });
    assert.deepEqual(decideAutoswitch({ ...base, idleHoldSinceMs: NOW - 30 * 60 * 1000 }), { kind: 'stay', reason: 'unknown', unhealthyTicks: 1 });
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
