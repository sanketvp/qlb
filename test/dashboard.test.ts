import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  accountHealth,
  activeAnthropicMarker,
  decorateStatusJson,
  enrichAccounts,
  formatDashboard,
  statusRowsForAccount,
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
  it('labels only fresh successful provider readings as provider authority', () => {
    const now = 2_000_000;
    const direct = (fetchedAt: number): BucketReading => ({
      usedPct: 40,
      source: 'provider-poll',
      confidence: 'authoritative',
      fetchedAt,
    });
    const current = statusRowsForAccount(snap({ accountId: 'current', buckets: { '5h': direct(now - 1) } }), now);
    const stale = statusRowsForAccount(snap({ accountId: 'stale', buckets: { '5h': direct(now - 300_001) } }), now);
    assert.match(current[0]!.detail, /provider authority/);
    assert.doesNotMatch(stale[0]!.detail, /provider authority/);
    for (const failed of [
      { accountId: 'cached-after-failure', probe: { outcome: 'cached-after-failure' as const } },
      { accountId: 'failed', failed: true },
      { accountId: 'error', error: 'provider unavailable' },
    ]) {
      const rows = statusRowsForAccount(snap({ ...failed, buckets: { '5h': direct(now - 1) } }), now);
      assert.doesNotMatch(rows[0]!.detail, /provider authority/, failed.accountId);
    }
  });

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
    assert.match(text, /5h\s+42% used\s+58% left\s+\(presentation-only\)\s+poll \(display-only\)/);
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

  it('uses Claude active_login during cutting-over and committed cutover even with NATIVE Pi ownership', () => {
    for (const claudeCutoverPhase of ['cutting-over', 'cutover', 'retired']) {
      let activeReads = 0;
      const accounts = enrichAccounts(
        [
          snap({ accountId: 'org-a', label: '● stale-cache-active' }),
          snap({ accountId: 'org-b', label: 'active-login' }),
        ],
        {
          ownershipForProvider: () => 'NATIVE',
          overrideForAccount: () => null,
          claudeCutoverPhase,
          activeAccountForProvider: () => {
            activeReads += 1;
            return { accountId: 'org-b' };
          },
        },
      );
      assert.equal(activeReads, 1, claudeCutoverPhase);
      assert.deepEqual(accounts.map((account) => account.label), ['stale-cache-active', '● active-login'], claudeCutoverPhase);
    }
  });

  it('keeps the stale cache label before cutover and after an abort', () => {
    for (const claudeCutoverPhase of ['pre-cutover', 'aborted']) {
      let activeReads = 0;
      const accounts = enrichAccounts(
        [snap({ accountId: 'org-a', label: '● cache-active' })],
        {
          ownershipForProvider: () => 'NATIVE',
          overrideForAccount: () => null,
          claudeCutoverPhase,
          activeAccountForProvider: () => {
            activeReads += 1;
            return { accountId: 'org-stale' };
          },
        },
      );
      assert.equal(activeReads, 0, claudeCutoverPhase);
      assert.equal(accounts[0].label, '● cache-active', claudeCutoverPhase);
    }
  });

  it('leaves non-Anthropic provider labels unchanged', () => {
    let activeReads = 0;
    const accounts = enrichAccounts(
      [snap({ accountId: 'codex-a', provider: 'openai-codex', label: '● cache-active' })],
      {
        ownershipForProvider: () => 'QLB_OWNED',
        overrideForAccount: () => null,
        claudeCutoverPhase: 'cutover',
        activeAccountForProvider: () => {
          activeReads += 1;
          return { accountId: 'codex-a' };
        },
      },
    );
    assert.equal(activeReads, 0);
    assert.equal(accounts[0].label, '● cache-active');
  });

  it('uses both org and email for shared-org Claude slots and reads active_login once', () => {
    let activeReads = 0;
    const snapshots = [
      snap({ accountId: 'shared-org', label: '● first@example.test' }),
      snap({ accountId: 'shared-org', label: 'second@example.test' }),
    ];
    const accounts = enrichAccounts(snapshots, {
      ownershipForProvider: () => 'NATIVE',
      overrideForAccount: () => null,
      claudeCutoverPhase: 'cutover',
      activeAccountForProvider: (_provider, providerAccounts) => {
        activeReads += 1;
        return activeAnthropicMarker({
          accountId: 'slot-second', orgUuid: 'shared-org', email: 'second@example.test', orgUuidSlotCount: 2,
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

  it('leaves cache labels unchanged when shared-org matching is ambiguous', () => {
    const accounts = enrichAccounts(
      [
        snap({ accountId: 'shared-org', label: '● duplicate@example.test' }),
        snap({ accountId: 'shared-org', label: 'duplicate@example.test' }),
      ],
      {
        ownershipForProvider: () => 'NATIVE',
        overrideForAccount: () => null,
        claudeCutoverPhase: 'cutover',
        activeAccountForProvider: (_provider, providerAccounts) => activeAnthropicMarker({
          accountId: 'slot-duplicate', orgUuid: 'shared-org', email: 'duplicate@example.test', orgUuidSlotCount: 2,
        }, providerAccounts),
      },
    );
    assert.deepEqual(accounts.map((account) => account.label), ['● duplicate@example.test', 'duplicate@example.test']);
  });

  it('does not fall back to an email match in another organization', () => {
    const accounts = enrichAccounts(
      [snap({ accountId: 'other-org', label: '● target@example.test' })],
      {
        ownershipForProvider: () => 'NATIVE',
        overrideForAccount: () => null,
        claudeCutoverPhase: 'cutover',
        activeAccountForProvider: (_provider, providerAccounts) => activeAnthropicMarker({
          accountId: 'slot-target', orgUuid: 'expected-org', email: 'target@example.test', orgUuidSlotCount: 2,
        }, providerAccounts),
      },
    );
    assert.equal(accounts[0].label, '● target@example.test');
  });
});
