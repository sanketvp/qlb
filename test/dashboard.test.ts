import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  accountHealth,
  enrichAccounts,
  formatDashboard,
} from '../src/dashboard';
import type { AccountSnapshot, BucketReading } from '../src/types';

function reading(usedPct: number | null): BucketReading {
  return {
    usedPct,
    source: 'poll',
    confidence: 'authoritative',
    fetchedAt: 1,
  };
}

function snap(partial: Partial<AccountSnapshot> & Pick<AccountSnapshot, 'accountId'>): AccountSnapshot {
  return {
    provider: 'anthropic',
    label: partial.accountId,
    buckets: {},
    ...partial,
  };
}

describe('dashboard health', () => {
  it('is ok when every bucket is under 80%', () => {
    const result = accountHealth(
      snap({ accountId: 'a', buckets: { '5h': reading(12), '7d': reading(79) } }),
    );
    assert.equal(result.health, 'ok');
    assert.equal(result.healthGlyph, '✓');
  });

  it('warns when any bucket is 80-99%', () => {
    const result = accountHealth(
      snap({ accountId: 'a', buckets: { '5h': reading(80), '7d': reading(10) } }),
    );
    assert.equal(result.health, 'warn');
    assert.equal(result.healthGlyph, '⚠');
  });

  it('fails when any bucket is at 100% or the account has an error', () => {
    assert.equal(
      accountHealth(snap({ accountId: 'a', buckets: { '5h': reading(100) } })).health,
      'fail',
    );
    assert.equal(
      accountHealth(snap({ accountId: 'a', buckets: {}, error: 'boom' })).healthGlyph,
      '✗',
    );
  });
});

describe('dashboard formatting', () => {
  it('groups by account with ownership, override=none, and bucket details', () => {
    const accounts = enrichAccounts(
      [
        snap({
          accountId: 'acct-1',
          label: 'Work',
          provider: 'anthropic',
          buckets: { '5h': reading(42) },
        }),
      ],
      {
        ownershipForProvider: () => 'NATIVE',
        overrideForAccount: () => null,
      },
    );
    assert.equal(accounts[0].ownership, 'NATIVE');
    assert.equal(accounts[0].override, null);
    assert.equal(accounts[0].accountId, 'acct-1');
    assert.equal(accounts[0].label, 'Work');
    assert.ok('5h' in accounts[0].buckets);

    const text = formatDashboard(accounts);
    assert.match(text, /^✓  Work  anthropic  NATIVE  override=none$/m);
    assert.match(text, /5h  42%  authoritative/);
  });

  it('shows an active override kind when the lookups return one', () => {
    const accounts = enrichAccounts(
      [snap({ accountId: 'acct-1', label: 'Work', buckets: { '5h': reading(1) } })],
      {
        ownershipForProvider: () => 'QLB_OWNED',
        overrideForAccount: () => ({ kind: 'pin', session: null, until: null }),
      },
    );
    assert.match(formatDashboard(accounts), /override=pin/);
  });
});
