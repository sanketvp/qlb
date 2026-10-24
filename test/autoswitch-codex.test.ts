// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — autoswitch.py

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideAutoswitch, type AutoswitchAccount } from '../src/autoswitch';

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
