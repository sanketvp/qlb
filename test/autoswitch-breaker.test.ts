// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — autoswitch.py

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideAutoswitch, type AutoswitchAccount } from '../src/autoswitch';

const NOW = 1_700_000_000_000;
const accounts: AutoswitchAccount[] = [
  { accountId: '1', buckets: { '5h': { usedPct: 100 } } },
  { accountId: '2', buckets: { '5h': { usedPct: 20 } } },
];

describe('autoswitch breaker — S14 / AC27 engine inputs', () => {
  it('opens before a fourth automatic failover or at-limit switch and records one deadline', () => {
    const result = decideAutoswitch({
      nowMs: NOW,
      activeAccountId: '1',
      accounts,
      breakerRows: [
        { ts: NOW - 1, trigger: 'failover', outcome: 'ok' },
        { ts: NOW - 2, trigger: 'at-limit', outcome: 'ok' },
        { ts: NOW - 3, trigger: 'failover', outcome: 'ok' },
      ],
    });
    assert.deepEqual(result, {
      kind: 'stay', reason: 'breaker', unhealthyTicks: 0,
      suspendedUntilMs: NOW + 3_600_000,
    });
  });

  it('keeps an existing suspension deadline and excludes manual, failed, and injected rows', () => {
    const suspended = decideAutoswitch({
      nowMs: NOW,
      activeAccountId: '1',
      accounts,
      suspendedUntilMs: NOW + 1000,
    });
    assert.deepEqual(suspended, {
      kind: 'stay', reason: 'breaker', unhealthyTicks: 0,
      suspendedUntilMs: NOW + 1000,
    });

    const allowed = decideAutoswitch({
      nowMs: NOW,
      activeAccountId: '1',
      accounts,
      breakerRows: [
        { ts: NOW - 1, trigger: 'failover', outcome: 'ok', automatic: false },
        { ts: NOW - 2, trigger: 'failover', outcome: 'failed' },
        { ts: NOW - 3, trigger: 'failover', outcome: 'ok', injected: true },
      ],
    });
    assert.equal(allowed.kind, 'switch');
  });
});
