import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { anthropicStoreSnapshots } from '../src/anthropic-usage-view';
import type { ClaudeSlot } from '../src/cc-slots';
import { openStore } from '../src/store';

const NOW_S = 1_700_000_000;

function slot(accountId: string, extra: Partial<ClaudeSlot> = {}): ClaudeSlot {
  return {
    accountId,
    email: `${accountId}@example.com`,
    fingerprint: null,
    prevFingerprint: null,
    addedAt: 1,
    dead: false,
    archivedAt: null,
    ...extra,
  };
}

function record(store: ReturnType<typeof openStore>, accountId: string, fetchedAtS: number): void {
  store.recordUsagePollResult('anthropic', accountId, {
    attemptedAt: fetchedAtS,
    status: 'ok',
    readings: {
      '5h': {
        usedPct: 12,
        fetchedAt: fetchedAtS * 1000,
        source: 'poll',
        confidence: 'authoritative',
      },
    },
  });
}

describe('QLB-owned Anthropic store projection', () => {
  it('projects a fresh poll as authoritative', () => {
    const store = openStore(':memory:');
    try {
      record(store, 'fresh', NOW_S);
      const result = anthropicStoreSnapshots([slot('fresh')], store, NOW_S);
      assert.equal(result.hasPolls, true);
      assert.equal(result.snapshots[0]?.label, 'fresh@example.com');
      assert.equal(result.snapshots[0]?.buckets['5h']?.usedPct, 12);
      assert.equal(result.snapshots[0]?.buckets['5h']?.confidence, 'authoritative');
    } finally {
      store.close();
    }
  });

  it('retains a backoff-protected poll as stale', () => {
    const store = openStore(':memory:');
    try {
      record(store, 'stale', NOW_S - 600);
      store.recordUsagePollResult('anthropic', 'stale', { attemptedAt: NOW_S, status: 'usage-fetch-failed' });
      const result = anthropicStoreSnapshots([slot('stale')], store, NOW_S);
      assert.equal(result.snapshots[0]?.buckets['5h']?.confidence, 'stale');
      assert.equal(result.snapshots[0]?.error, undefined);
    } finally {
      store.close();
    }
  });

  it('does not serve a poll older than the trust maximum', () => {
    const store = openStore(':memory:');
    try {
      record(store, 'old', NOW_S - 3601);
      store.recordUsagePollResult('anthropic', 'old', { attemptedAt: NOW_S, status: 'usage-fetch-failed' });
      const result = anthropicStoreSnapshots([slot('old')], store, NOW_S);
      assert.equal(result.snapshots[0]?.error, 'unavailable');
      assert.deepEqual(result.snapshots[0]?.buckets, {});
    } finally {
      store.close();
    }
  });

  it('marks a live dead slot as token_dead and excludes archived slots', () => {
    const store = openStore(':memory:');
    try {
      record(store, 'dead', NOW_S);
      record(store, 'archived', NOW_S);
      const result = anthropicStoreSnapshots([
        slot('dead', { dead: true }),
        slot('archived', { archivedAt: 1 }),
      ], store, NOW_S);
      assert.equal(result.snapshots.length, 1);
      assert.equal(result.snapshots[0]?.accountId, 'dead');
      assert.equal(result.snapshots[0]?.error, 'token_dead');
    } finally {
      store.close();
    }
  });

  it('reports no store projection when Anthropic has no poll rows', () => {
    const store = openStore(':memory:');
    try {
      const result = anthropicStoreSnapshots([slot('empty')], store, NOW_S);
      assert.equal(result.hasPolls, false);
      assert.deepEqual(result.snapshots, []);
    } finally {
      store.close();
    }
  });
});
