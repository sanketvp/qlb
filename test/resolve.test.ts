import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountSnapshot, BucketReading, Confidence } from '../src/types';
import { openStore } from '../src/store';
import { snapshotsFromStore, resolveFromSnapshots } from '../src/resolve';

function reading(
  usedPct: number,
  confidence: Confidence = 'authoritative',
  resetAt?: number,
): BucketReading {
  const r: BucketReading = {
    usedPct,
    source: 'poll',
    confidence,
    fetchedAt: Date.now(),
  };
  if (resetAt != null) r.resetAt = resetAt;
  return r;
}

function seed(
  store: ReturnType<typeof openStore>,
  id: string,
  buckets: Record<string, BucketReading>,
  label = id,
): void {
  store.upsertAccount(id, 'anthropic', label);
  for (const [bucket, value] of Object.entries(buckets)) {
    store.upsertSnapshot(id, bucket, value);
  }
}

function codex(accountId: string): AccountSnapshot {
  return {
    accountId,
    provider: 'openai-codex',
    label: accountId,
    buckets: {},
  };
}

describe('qlb resolve — store-backed end-to-end', () => {
  it('normal resolve: picks the higher-scoring account (case 1 A vs B)', () => {
    const store = openStore(':memory:');
    seed(store, 'A', { '5h': reading(70), '7d': reading(20) }, 'account-A');
    seed(store, 'B', { '5h': reading(40), '7d': reading(65) }, 'account-B');

    const snapshots = snapshotsFromStore(store, 'anthropic');
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots,
      store,
      harness: 'dispatch',
    });

    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, 'A');
    assert.equal(decision.servedModel, 'claude-sonnet-5');
    assert.equal(decision.requestedModel, 'claude-sonnet-5');
    assert.equal(decision.mode, 'headroom');
    assert.equal(decision.score, 10);
    assert.ok(typeof decision.decisionId === 'number');
    store.close();
  });

  it('all-in fallback: ceiling 80 scores ≤ 0, ceiling 100 selects the account', () => {
    const store = openStore(':memory:');
    // used 90 → headroom at 80 = -10 (not selected); at 100 = 10
    seed(store, 'hot', {
      '5h': reading(90),
      '7d': reading(90),
    });

    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });

    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, 'hot');
    assert.equal(decision.mode, 'all-in');
    assert.equal(decision.ceiling, 100);
    assert.ok(decision.score > 0);
    store.close();
  });

  it('fallback chain walk: requested Fable exhausted, Opus fallback serves', () => {
    const store = openStore(':memory:');
    // Fable pool at 100% → score 0 even at ceiling 100. Opus pool has room.
    seed(store, 'one', {
      '5h': reading(50),
      '7d': reading(50),
      '7d:Fable': reading(100),
      '7d:Opus': reading(20),
    });

    const fable = resolveFromSnapshots({
      model: 'claude-fable-5',
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });
    assert.equal(fable.ok, false);
    if (fable.ok) return;
    assert.equal(fable.error, 'EXHAUSTED');

    const withFallback = resolveFromSnapshots({
      model: 'claude-fable-5',
      fallback: ['claude-opus-5'],
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });
    assert.equal(withFallback.ok, true);
    if (!withFallback.ok) return;
    assert.equal(withFallback.requestedModel, 'claude-fable-5');
    assert.equal(withFallback.servedModel, 'claude-opus-5');
    assert.notEqual(withFallback.servedModel, withFallback.requestedModel);
    assert.ok(withFallback.mode === 'fallback' || withFallback.mode === 'fallback-all-in');
    assert.ok(withFallback.reason.includes('claude-opus-5'));
    store.close();
  });

  it('EXHAUSTED: every scored bucket at 100%, reports earliest reset', () => {
    const store = openStore(':memory:');
    const resetA = Date.now() + 3 * 60 * 60 * 1000;
    const resetB = Date.now() + 60 * 60 * 1000; // earlier
    seed(store, 'A', {
      '5h': reading(100, 'authoritative', resetA),
      '7d': reading(100, 'authoritative', resetA),
    });
    seed(store, 'B', {
      '5h': reading(100, 'authoritative', resetB),
      '7d': reading(100, 'authoritative', resetB),
    });

    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      fallback: ['claude-opus-5'],
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });

    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.error, 'EXHAUSTED');
    assert.ok(decision.earliestReset);
    assert.equal(decision.earliestReset!.accountId, 'B');
    assert.equal(decision.earliestReset!.at, resetB);
    assert.ok(typeof decision.decisionId === 'number');
    store.close();
  });

  it('default persist still records strategy and provider', () => {
    const store = openStore(':memory:');
    seed(store, 'A', { '5h': reading(70), '7d': reading(20) }, 'account-A');
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });
    assert.equal(decision.ok, true);
    const row = store.listRoutingDecisions(1)[0];
    assert.ok(row);
    assert.equal(row.strategy, 'headroom');
    assert.equal(row.provider, 'anthropic');
    store.close();
  });

  it('exhausted row records provider and requested strategy', () => {
    const store = openStore(':memory:');
    seed(store, 'A', {
      '5h': reading(100),
      '7d': reading(100),
    });
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      strategy: 'spread',
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });
    assert.equal(decision.ok, false);
    const row = store.listRoutingDecisions(1)[0];
    assert.equal(row.mode, 'exhausted');
    assert.equal(row.strategy, 'spread');
    assert.equal(row.provider, 'anthropic');
    store.close();
  });

  it('pinned-unavailable row records pin and provider', () => {
    const store = openStore(':memory:');
    seed(store, 'A', { '5h': reading(10), '7d': reading(10) });
    store.upsertOverride({
      kind: 'pin',
      accountId: 'missing',
      session: 'pin-sess',
      until: Date.now() + 60_000,
    });
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      session: 'pin-sess',
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.error, 'PINNED_UNAVAILABLE');
    const row = store.listRoutingDecisions(1)[0];
    assert.equal(row.mode, 'pin_unavailable');
    assert.equal(row.strategy, 'pin');
    assert.equal(row.provider, 'anthropic');
    store.close();
  });
});

describe('qlb resolve — Codex bare-id aliases', () => {
  it('a pin on a bare Codex id resolves to the slot whose account part matches', () => {
    const store = openStore(':memory:');
    try {
      const snapshot = codex('user:X');
      store.upsertAccount(snapshot.accountId, snapshot.provider, snapshot.label);
      store.upsertOverride({
        kind: 'pin',
        accountId: 'X',
        session: 'bare-pin',
        until: Date.now() + 60_000,
      });

      const decision = resolveFromSnapshots({
        model: 'gpt-5.4',
        session: 'bare-pin',
        snapshots: [snapshot],
        store,
      });

      assert.equal(decision.ok, true);
      if (!decision.ok) return;
      assert.equal(decision.accountId, 'user:X');
      assert.equal(store.getPinOverride('bare-pin')?.account_id, 'X');
    } finally {
      store.close();
    }
  });

  it('a bare Codex pin never aliases a slot QLB does not own', () => {
    const store = openStore(':memory:');
    try {
      store.upsertOverride({ kind: 'pin', accountId: 'X', session: 'unowned-pin', until: Date.now() + 60_000 });

      const decision = resolveFromSnapshots({
        model: 'gpt-5.4',
        session: 'unowned-pin',
        snapshots: [codex('user:X')],
        store,
      });

      assert.equal(decision.ok, false);
      if (decision.ok || decision.error !== 'PINNED_UNAVAILABLE') assert.fail('expected PINNED_UNAVAILABLE');
      assert.equal(decision.accountId, 'X');
    } finally {
      store.close();
    }
  });

  it('an aliased pin whose slot is unavailable reports and records the slot id', () => {
    const store = openStore(':memory:');
    try {
      const snapshot = { ...codex('user:X'), error: 'fixture-error' };
      store.upsertAccount(snapshot.accountId, snapshot.provider, snapshot.label);
      store.upsertOverride({ kind: 'pin', accountId: 'X', session: 'errored-pin', until: Date.now() + 60_000 });

      const decision = resolveFromSnapshots({
        model: 'gpt-5.4',
        session: 'errored-pin',
        snapshots: [snapshot],
        store,
      });

      assert.equal(decision.ok, false);
      if (decision.ok || decision.error !== 'PINNED_UNAVAILABLE') assert.fail('expected PINNED_UNAVAILABLE');
      assert.equal(decision.accountId, 'user:X');
      assert.match(decision.reason ?? '', /user:X is in an error state/);
      assert.equal(store.getPinOverride('errored-pin')?.account_id, 'X');
    } finally {
      store.close();
    }
  });

  it('a bare Codex pin matching two slots stays unavailable', () => {
    const store = openStore(':memory:');
    try {
      const snapshots = [codex('u1:X'), codex('u2:X')];
      for (const snapshot of snapshots) {
        store.upsertAccount(snapshot.accountId, snapshot.provider, snapshot.label);
      }
      store.upsertOverride({
        kind: 'pin',
        accountId: 'X',
        session: 'ambiguous-bare-pin',
        until: Date.now() + 60_000,
      });

      const decision = resolveFromSnapshots({
        model: 'gpt-5.4',
        session: 'ambiguous-bare-pin',
        snapshots,
        store,
      });

      assert.equal(decision.ok, false);
      if (decision.ok) return;
      assert.equal(decision.error, 'PINNED_UNAVAILABLE');
    } finally {
      store.close();
    }
  });

  it('an exact pin match beats an alias match', () => {
    const store = openStore(':memory:');
    try {
      const snapshots = [codex('X'), codex('user:X')];
      for (const snapshot of snapshots) {
        store.upsertAccount(snapshot.accountId, snapshot.provider, snapshot.label);
      }
      store.upsertOverride({
        kind: 'pin',
        accountId: 'X',
        session: 'exact-bare-pin',
        until: Date.now() + 60_000,
      });

      const decision = resolveFromSnapshots({
        model: 'gpt-5.4',
        session: 'exact-bare-pin',
        snapshots,
        store,
      });

      assert.equal(decision.ok, true);
      if (!decision.ok) return;
      assert.equal(decision.accountId, 'X');
    } finally {
      store.close();
    }
  });

  it('a bare id never aliases a non-Codex snapshot', () => {
    const store = openStore(':memory:');
    try {
      store.upsertOverride({
        kind: 'pin',
        accountId: 'X',
        session: 'non-codex-bare-pin',
        until: Date.now() + 60_000,
      });
      const decision = resolveFromSnapshots({
        model: 'gpt-5.4',
        session: 'non-codex-bare-pin',
        snapshots: [{
          accountId: 'user:X',
          provider: 'xai',
          label: 'user:X',
          buckets: {},
        }],
        store,
      });

      assert.equal(decision.ok, false);
      if (decision.ok) return;
      assert.equal(decision.error, 'PINNED_UNAVAILABLE');
    } finally {
      store.close();
    }
  });
});

describe('qlb resolve — Codex account ownership', () => {
  const codexSnapshot: AccountSnapshot = {
    accountId: 'fixture-user:fixture-account',
    provider: 'openai-codex',
    label: 'fixture-user:fixture-account',
    buckets: {},
  };

  it('resolve skips a Codex slot-id snapshot that has no accounts row', () => {
    const store = openStore(':memory:');
    try {
      const decision = resolveFromSnapshots({
        model: 'gpt-5.4',
        snapshots: [codexSnapshot],
        store,
      });

      assert.equal(decision.ok, false);
      if (decision.ok) return;
      assert.equal(decision.error, 'EXHAUSTED');
      assert.equal(store.listRoutingDecisions(1)[0]?.account_id, null);
    } finally {
      store.close();
    }
  });

  it('resolve still picks an imported Codex slot', () => {
    const store = openStore(':memory:');
    try {
      store.upsertAccount(codexSnapshot.accountId, 'openai-codex', codexSnapshot.label);
      const decision = resolveFromSnapshots({
        model: 'gpt-5.4',
        snapshots: [codexSnapshot],
        store,
      });

      assert.equal(decision.ok, true);
      if (!decision.ok) return;
      assert.equal(decision.accountId, codexSnapshot.accountId);
    } finally {
      store.close();
    }
  });

  it('resolve skips a Codex snapshot whose id has only another provider\'s accounts row', () => {
    const store = openStore(':memory:');
    try {
      store.upsertAccount(codexSnapshot.accountId, 'xai', codexSnapshot.label);
      const decision = resolveFromSnapshots({
        model: 'gpt-5.4',
        snapshots: [codexSnapshot],
        store,
      });

      assert.equal(decision.ok && decision.accountId === codexSnapshot.accountId, false);
    } finally {
      store.close();
    }
  });

  it('resolve without a store does not filter Codex snapshots', () => {
    const decision = resolveFromSnapshots({
      model: 'gpt-5.4',
      snapshots: [codexSnapshot],
    });

    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, codexSnapshot.accountId);
  });

  it('non-Codex snapshots without an accounts row are unchanged', () => {
    const store = openStore(':memory:');
    try {
      const xaiSnapshot: AccountSnapshot = {
        accountId: 'xai-default',
        provider: 'xai',
        label: 'Grok (xAI)',
        buckets: {},
      };
      const decision = resolveFromSnapshots({
        model: 'grok-4.6',
        snapshots: [xaiSnapshot],
        store,
      });

      assert.equal(decision.ok, true);
      if (!decision.ok) return;
      assert.equal(decision.accountId, xaiSnapshot.accountId);
    } finally {
      store.close();
    }
  });
});
