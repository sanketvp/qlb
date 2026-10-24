// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — autoswitch.py

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideAutoswitch, type AutoswitchAccount } from '../src/autoswitch';

const NOW = 1_700_000_000_000;

function legacy(decision: ReturnType<typeof decideAutoswitch>): unknown {
  if (decision.kind !== 'switch') return decision;
  const { leftHeadroom: _leftHeadroom, leftRecoveryAtMs: _leftRecoveryAtMs, leftTrigger: _leftTrigger, ...rest } = decision;
  return rest;
}

function exhausted(accountId: string, resetAt: number, dead = false): AutoswitchAccount {
  return {
    accountId, slotNum: Number(accountId), dead,
    buckets: {
      '5h': { usedPct: 100, resetAt },
      '7d': { usedPct: 100, resetAt: resetAt + 86_400_000 },
    },
  };
}

describe('autoswitch parked state — spec §4.3 AC9', () => {
  it('keeps all-exhausted fixtures ordered by their binding-window reset', () => {
    const firstUsable = NOW + 10 * 60 * 1000;
    const result = decideAutoswitch({
      nowMs: NOW, activeAccountId: '1',
      accounts: [exhausted('1', NOW + 30 * 60 * 1000), exhausted('2', firstUsable), exhausted('3', NOW + 20 * 60 * 1000, true)],
    });
    assert.deepEqual(legacy(result), { kind: 'switch', targetId: '2', reason: 'parked', unhealthyTicks: 0, parkedUntilMs: firstUsable });
  });

  it('reports parked rather than switching when the active account frees first', () => {
    const reset = NOW + 10 * 60 * 1000;
    const result = decideAutoswitch({ nowMs: NOW, activeAccountId: '1', accounts: [exhausted('1', reset), exhausted('2', NOW + 20 * 60 * 1000)] });
    assert.deepEqual(result, { kind: 'parked', accountId: '1', resetAtMs: reset, unhealthyTicks: 0, parkedUntilMs: reset });
  });

  it('does not repeat an already-recorded parked switch for the same reset', () => {
    const reset = NOW + 10 * 60 * 1000;
    const result = decideAutoswitch({ nowMs: NOW, activeAccountId: '1', parkedUntilMs: reset, accounts: [exhausted('1', NOW + 30 * 60 * 1000), exhausted('2', reset)] });
    assert.deepEqual(result, { kind: 'parked', accountId: '2', resetAtMs: reset, unhealthyTicks: 0, parkedUntilMs: reset });
  });

  it('stays when all exhausted accounts have unknown resets, regardless of active account', () => {
    const accounts: AutoswitchAccount[] = ['1', '2'].map((accountId) => ({ accountId, slotNum: Number(accountId), buckets: { '5h': { usedPct: 100 }, '7d': { usedPct: 100 } } }));
    for (const activeAccountId of ['1', '2']) {
      assert.deepEqual(decideAutoswitch({ nowMs: NOW, activeAccountId, accounts }), { kind: 'stay', reason: 'reset-unknown', unhealthyTicks: 0 });
    }
  });

  it('still parks on a known reset when another exhausted account reset is unknown', () => {
    const reset = NOW + 10 * 60 * 1000;
    const result = decideAutoswitch({
      nowMs: NOW, activeAccountId: '1',
      accounts: [
        { accountId: '1', slotNum: 1, buckets: { '5h': { usedPct: 100 } } },
        { accountId: '2', slotNum: 2, buckets: { '5h': { usedPct: 100, resetAt: reset } } },
      ],
    });
    assert.deepEqual(legacy(result), { kind: 'switch', targetId: '2', reason: 'parked', unhealthyTicks: 0, parkedUntilMs: reset });
  });

  it('ranks an exhausted account by its binding window rather than a lower window reset', () => {
    const bindingReset = NOW + 60 * 60 * 1000;
    const earlierNonBindingReset = NOW + 60 * 1000;
    const otherReset = NOW + 10 * 60 * 1000;
    const result = decideAutoswitch({
      nowMs: NOW, activeAccountId: '1',
      accounts: [
        { accountId: '1', slotNum: 1, buckets: { '5h': { usedPct: 100, resetAt: bindingReset }, '7d': { usedPct: 20, resetAt: earlierNonBindingReset } } },
        { accountId: '2', slotNum: 2, buckets: { '5h': { usedPct: 100, resetAt: otherReset } } },
      ],
    });
    assert.deepEqual(legacy(result), { kind: 'switch', targetId: '2', reason: 'parked', unhealthyTicks: 0, parkedUntilMs: otherReset });
  });

  it('uses added time when equally-ranked parked accounts have no slot number', () => {
    const reset = NOW + 10 * 60 * 1000;
    const result = decideAutoswitch({ nowMs: NOW, activeAccountId: '1', accounts: [exhausted('1', NOW + 30 * 60 * 1000), { ...exhausted('2', reset), slotNum: undefined, addedAtMs: 200 }, { ...exhausted('3', reset), slotNum: undefined, addedAtMs: 100 }] });
    assert.deepEqual(legacy(result), { kind: 'switch', targetId: '3', reason: 'parked', unhealthyTicks: 0, parkedUntilMs: reset });
  });

  it('uses the binding-window reset when exhausted windows are tied', () => {
    const result = decideAutoswitch({
      nowMs: NOW, activeAccountId: '1',
      accounts: [
        { accountId: '1', slotNum: 1, buckets: { '5h': { usedPct: 100, resetAt: NOW + 10 * 60 * 1000 }, '7d': { usedPct: 100, resetAt: NOW + 50 * 60 * 1000 } } },
        { accountId: '2', slotNum: 2, buckets: { '5h': { usedPct: 100, resetAt: NOW + 20 * 60 * 1000 }, '7d': { usedPct: 100, resetAt: NOW + 30 * 60 * 1000 } } },
      ],
    });
    assert.deepEqual(result, { kind: 'parked', accountId: '1', resetAtMs: NOW + 10 * 60 * 1000, unhealthyTicks: 0, parkedUntilMs: NOW + 10 * 60 * 1000 });
  });

  it('does not claim all-exhausted while a non-dead account is unknown', () => {
    const result = decideAutoswitch({ nowMs: NOW, activeAccountId: '1', accounts: [exhausted('1', NOW + 30 * 60 * 1000), { ...exhausted('2', NOW + 20 * 60 * 1000), buckets: { '5h': { usedPct: null } } }] });
    assert.deepEqual(result, { kind: 'stay', reason: 'no-comparison', unhealthyTicks: 0 });
  });

  it('clears parked state as soon as any account has room', () => {
    const result = decideAutoswitch({ nowMs: NOW, activeAccountId: '1', parkedUntilMs: NOW + 10 * 60 * 1000, accounts: [exhausted('1', NOW + 30 * 60 * 1000), { ...exhausted('2', NOW + 20 * 60 * 1000), buckets: { '5h': { usedPct: 80 } } }] });
    assert.deepEqual(legacy(result), { kind: 'switch', targetId: '2', reason: 'at-limit', unhealthyTicks: 0, parkedUntilMs: undefined });
  });
});
