import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideAutoswitch, type AutoswitchAccount } from '../src/autoswitch';

const NOW = 1_700_000_000_000;

function exhausted(accountId: string, resetAt: number, dead = false): AutoswitchAccount {
  return {
    accountId,
    slotNum: Number(accountId),
    dead,
    buckets: {
      '5h': { usedPct: 100, resetAt },
      '7d': { usedPct: 100, resetAt: resetAt + 86_400_000 },
    },
  };
}

describe('autoswitch parked state — spec §4.3 AC9', () => {
  it('parks on the non-dead account with the soonest reset and requests its switch', () => {
    const soonest = NOW + 10 * 60 * 1000;
    const result = decideAutoswitch({
      nowMs: NOW,
      activeAccountId: '1',
      accounts: [
        exhausted('1', NOW + 30 * 60 * 1000),
        exhausted('2', soonest),
        exhausted('3', NOW + 20 * 60 * 1000, true),
      ],
    });
    assert.deepEqual(result, {
      kind: 'switch',
      targetId: '2',
      reason: 'parked',
      unhealthyTicks: 0,
      parkedUntilMs: soonest,
    });
  });

  it('reports parked rather than switching when the active account frees first', () => {
    const reset = NOW + 10 * 60 * 1000;
    const result = decideAutoswitch({
      nowMs: NOW,
      activeAccountId: '1',
      accounts: [exhausted('1', reset), exhausted('2', NOW + 20 * 60 * 1000)],
    });
    assert.deepEqual(result, {
      kind: 'parked',
      accountId: '1',
      resetAtMs: reset,
      unhealthyTicks: 0,
      parkedUntilMs: reset,
    });
  });

  it('does not repeat an already-recorded parked switch for the same reset', () => {
    const reset = NOW + 10 * 60 * 1000;
    const result = decideAutoswitch({
      nowMs: NOW,
      activeAccountId: '1',
      parkedUntilMs: reset,
      accounts: [exhausted('1', NOW + 30 * 60 * 1000), exhausted('2', reset)],
    });
    assert.deepEqual(result, {
      kind: 'parked',
      accountId: '2',
      resetAtMs: reset,
      unhealthyTicks: 0,
      parkedUntilMs: reset,
    });
  });

  it('does not claim all-exhausted while a non-dead account is unknown', () => {
    const result = decideAutoswitch({
      nowMs: NOW,
      activeAccountId: '1',
      accounts: [
        exhausted('1', NOW + 30 * 60 * 1000),
        { ...exhausted('2', NOW + 20 * 60 * 1000), buckets: { '5h': { usedPct: null } } },
      ],
    });
    assert.deepEqual(result, { kind: 'stay', reason: 'no-comparison', unhealthyTicks: 0 });
  });

  it('clears parked state as soon as any account has room', () => {
    const result = decideAutoswitch({
      nowMs: NOW,
      activeAccountId: '1',
      parkedUntilMs: NOW + 10 * 60 * 1000,
      accounts: [
        exhausted('1', NOW + 30 * 60 * 1000),
        { ...exhausted('2', NOW + 20 * 60 * 1000), buckets: { '5h': { usedPct: 80 } } },
      ],
    });
    assert.deepEqual(result, { kind: 'switch', targetId: '2', reason: 'at-limit', unhealthyTicks: 0 });
  });
});
