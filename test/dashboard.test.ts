import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  accountHealth,
  activeAnthropicMarker,
  decorateStatusJson,
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
    assert.match(text, /5h\s+42% used\s+58% left\s+authoritative/);
    assert.match(text, /7d\s+not reported by anthropic/);
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

  it('preserves the cache dot before the QLB Claude cutover with no active login', () => {
    let activeReads = 0;
    const accounts = enrichAccounts(
      [snap({ accountId: 'org-a', label: '● cache-active' })],
      {
        ownershipForProvider: () => 'NATIVE',
        overrideForAccount: () => null,
        activeAccountForProvider: () => {
          activeReads += 1;
          return undefined;
        },
      },
    );
    assert.equal(activeReads, 0);
    assert.equal(accounts[0].label, '● cache-active');
  });

  it('preserves the cache dot when C-swap owns Claude despite a stale active login', () => {
    let activeReads = 0;
    const accounts = enrichAccounts(
      [snap({ accountId: 'org-a', label: '● cache-active' })],
      {
        ownershipForProvider: () => 'NATIVE',
        overrideForAccount: () => null,
        activeAccountForProvider: () => {
          activeReads += 1;
          return 'org-stale';
        },
      },
    );
    assert.equal(activeReads, 0);
    assert.equal(accounts[0].label, '● cache-active');
  });

  it('uses a unique cache email for shared-org Claude slots and reads the active login once', () => {
    let activeReads = 0;
    const snapshots = [
      snap({ accountId: 'shared-org', label: '● first@example.test' }),
      snap({ accountId: 'shared-org', label: 'second@example.test' }),
    ];
    const accounts = enrichAccounts(snapshots, {
      ownershipForProvider: () => 'QLB_OWNED',
      overrideForAccount: () => null,
      activeAccountForProvider: (_provider, providerAccounts) => {
        activeReads += 1;
        return activeAnthropicMarker({
          orgUuid: 'shared-org', email: 'second@example.test', orgUuidSlotCount: 2,
        }, providerAccounts);
      },
    });
    assert.equal(activeReads, 1);
    assert.deepEqual(accounts.map((account) => account.label), ['first@example.test', '● second@example.test']);
    assert.deepEqual(decorateStatusJson(accounts).map((account) => account.label), [
      'first@example.test',
      '● second@example.test',
    ]);
  });

  it('leaves the cache label unchanged when no one-to-one active Claude cache match exists', () => {
    const accounts = enrichAccounts(
      [snap({ accountId: 'org-a', label: '● cache-active' })],
      {
        ownershipForProvider: () => 'QLB_OWNED',
        overrideForAccount: () => null,
        activeAccountForProvider: (_provider, providerAccounts) => activeAnthropicMarker({
          orgUuid: 'missing-org', email: 'missing@example.test', orgUuidSlotCount: 1,
        }, providerAccounts),
      },
    );
    assert.equal(accounts[0].label, '● cache-active');
  });
});
