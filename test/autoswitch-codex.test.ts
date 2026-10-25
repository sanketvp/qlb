// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — autoswitch.py

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideAutoswitch, type AutoswitchAccount } from '../src/autoswitch';
import { bucketClass } from '../src/scoring';

const NOW = 1_700_000_000_000;
function accounts(activeUsed: number | null): AutoswitchAccount[] {
  return [
    { accountId: '1', buckets: { primary: { usedPct: activeUsed } } },
    { accountId: '2', buckets: { primary: { usedPct: 20 } } },
  ];
}

describe('autoswitch Codex gate — S15 / AC28 engine inputs', () => {
  for (const [name, overrides] of [
    ['proactive', { accounts: accounts(95) }],
    ['consume-first', { accounts: accounts(20), requestedTrigger: 'consume-first' }],
    ['at-limit', { accounts: accounts(100) }],
    ['failover', { accounts: accounts(null), unhealthyTicks: 2 }],
    ['parked', { accounts: [
      { accountId: '1', buckets: { primary: { usedPct: 100 } } },
      { accountId: '2', buckets: { primary: { usedPct: 100, resetAt: NOW + 1000 } } },
    ] }],
  ] as const) {
    it(`refuses ${name} until the L13 receipt exists`, () => {
      assert.deepEqual(decideAutoswitch({
        nowMs: NOW,
        provider: 'openai-codex',
        activeAccountId: '1',
        ...overrides,
      }), { kind: 'stay', reason: 'codex-l13-unverified', unhealthyTicks: name === 'failover' ? 3 : 0 });
    });
  }

  it('classifies a header-only Codex usage pair like autoswitch', () => {
    // Spec §4.4.4 line 666: primary is 5h and secondary is weekly.
    assert.equal(bucketClass('primary'), '5h');
    assert.equal(bucketClass('secondary'), 'weekly');

    const secondaryReset = NOW + 60 * 60 * 1000;
    const result = decideAutoswitch({
      nowMs: NOW,
      provider: 'openai-codex',
      codexL13VerifiedAtMs: NOW - 1,
      activeAccountId: '1',
      settings: { threshold: 90, weeklyThreshold: 70 },
      accounts: [
        { accountId: '1', buckets: { primary: { usedPct: 91, resetAt: NOW + 3 * 60 * 60 * 1000 }, secondary: { usedPct: 90, resetAt: secondaryReset } } },
        { accountId: '2', buckets: { primary: { usedPct: 10 }, secondary: { usedPct: 10 } } },
      ],
    });
    assert.equal(result.kind, 'switch');
    if (result.kind === 'switch') assert.equal(result.leftRecoveryAtMs, secondaryReset);
  });

  it('uses Codex secondary as the consume-first weekly reset', () => {
    const result = decideAutoswitch({
      nowMs: NOW,
      provider: 'openai-codex',
      codexL13VerifiedAtMs: NOW - 1,
      activeAccountId: '1',
      settings: { strategy: 'consume-first' },
      accounts: [
        { accountId: '1', buckets: { primary: { usedPct: 20 }, secondary: { usedPct: 20, resetAt: NOW + 2 * 60 * 60 * 1000 } } },
        { accountId: '2', buckets: { primary: { usedPct: 10 }, secondary: { usedPct: 10, resetAt: NOW + 60 * 60 * 1000 } } },
      ],
    });
    assert.equal(result.kind, 'switch');
    if (result.kind === 'switch') {
      assert.equal(result.targetId, '2');
      assert.equal(result.reason, 'consume-first');
    }
  });

  it('allows automatic Codex switching after the L13 receipt', () => {
    const result = decideAutoswitch({
      nowMs: NOW,
      provider: 'openai-codex',
      codexL13VerifiedAtMs: NOW - 1,
      activeAccountId: '1',
      accounts: accounts(100),
    });
    assert.equal(result.kind, 'switch');
  });
});
