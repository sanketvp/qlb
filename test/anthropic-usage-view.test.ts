import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { anthropicStoreSnapshots, projectAnthropicUsageReadings, RATE_LIMIT_TRUST_MAX_AGE_S, readAnthropicStoreSnapshots, readAnthropicUsagePollFreshness } from '../src/anthropic-usage-view';
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

function record(
  store: ReturnType<typeof openStore>,
  accountId: string,
  fetchedAtS: number,
  source: 'poll' | 'provider-poll' = 'poll',
): void {
  store.recordUsagePollResult('anthropic', accountId, {
    attemptedAt: fetchedAtS,
    status: 'ok',
    readings: {
      '5h': {
        usedPct: 12,
        fetchedAt: fetchedAtS * 1000,
        source,
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

  it('marks a provider reading older than five minutes stale', () => {
    const store = openStore(':memory:');
    try {
      record(store, 'stale', NOW_S - 301, 'provider-poll');
      const result = anthropicStoreSnapshots([slot('stale')], store, NOW_S);
      assert.equal(result.snapshots[0]?.buckets['5h']?.confidence, 'stale');
      assert.equal(result.snapshots[0]?.buckets['5h']?.fetchedAt, (NOW_S - 301) * 1000);
      assert.equal(result.snapshots[0]?.error, undefined);
    } finally {
      store.close();
    }
  });

  it('does not treat an aged provider reading as doctor-fresh', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'qlb-anthropic-freshness-')), 'qlb.db');
    const store = openStore(dbPath);
    try {
      record(store, 'stale', NOW_S - 301, 'provider-poll');
    } finally {
      store.close();
    }
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO claude_slots (account_id, slot_num, config_json, fingerprint, added_at)
        VALUES ('stale', 1, '{}', 'fp-stale', 1)`).run();
    } finally {
      db.close();
    }
    assert.deepEqual(readAnthropicUsagePollFreshness(dbPath, NOW_S), { hasPolls: true, fresh: false });
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

  it('keeps provider trust, sentinel, and 429 age ceilings', () => {
    const expired = projectAnthropicUsageReadings({
      '5h': { usedPct: 12, fetchedAt: (NOW_S - 3601) * 1000, source: 'provider-poll', confidence: 'authoritative' },
    }, {
      accountId: 'expired', lastFetchAt: NOW_S - 3601, lastAttemptAt: NOW_S,
      nextDueAt: null, pollIntervalS: null, lastStatus: 'ok', consecutiveFailures: 0,
      backoffUntil: null, last429At: null, heldUntil: null,
    }, NOW_S);
    const sentinel = projectAnthropicUsageReadings({
      '5h': { usedPct: 12, fetchedAt: (NOW_S - 301) * 1000, source: 'provider-poll', confidence: 'authoritative' },
    }, {
      accountId: 'sentinel', lastFetchAt: NOW_S - 301, lastAttemptAt: NOW_S,
      nextDueAt: null, pollIntervalS: null, lastStatus: 'token-expired', consecutiveFailures: 0,
      backoffUntil: null, last429At: null, heldUntil: null,
    }, NOW_S);
    const rateLimited = projectAnthropicUsageReadings({
      '5h': { usedPct: 12, fetchedAt: (NOW_S - RATE_LIMIT_TRUST_MAX_AGE_S - 1) * 1000, source: 'provider-poll', confidence: 'authoritative' },
    }, {
      accountId: 'rate-limited', lastFetchAt: NOW_S - RATE_LIMIT_TRUST_MAX_AGE_S - 1, lastAttemptAt: NOW_S,
      nextDueAt: null, pollIntervalS: null, lastStatus: 'http-429', consecutiveFailures: 0,
      backoffUntil: null, last429At: NOW_S, heldUntil: null,
    }, NOW_S);
    assert.deepEqual(expired, {});
    assert.deepEqual(sentinel, {});
    assert.deepEqual(rateLimited, {});
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

  it('marks every live slot unavailable when Anthropic has no poll rows', () => {
    const store = openStore(':memory:');
    try {
      const result = anthropicStoreSnapshots([slot('empty'), slot('also-empty')], store, NOW_S);
      assert.equal(result.hasPolls, false);
      assert.deepEqual(result.snapshots.map(({ accountId, error }) => ({ accountId, error })), [
        { accountId: 'empty', error: 'unavailable' },
        { accountId: 'also-empty', error: 'unavailable' },
      ]);
    } finally {
      store.close();
    }
  });

  it('returns an unavailable snapshot when every slot is archived', () => {
    const store = openStore(':memory:');
    try {
      record(store, 'archived', NOW_S);
      const result = anthropicStoreSnapshots([slot('archived', { archivedAt: 1 })], store, NOW_S);
      assert.equal(result.hasPolls, false);
      assert.deepEqual(result.snapshots.map(({ accountId, error }) => ({ accountId, error })), [
        { accountId: 'anthropic', error: 'unavailable' },
      ]);
    } finally {
      store.close();
    }
  });

  it('non-poll readings never set the 429 reset', () => {
    const buckets = projectAnthropicUsageReadings({
      '5h': { usedPct: 12, fetchedAt: (NOW_S - 301) * 1000, resetAt: (NOW_S + 1) * 1000, source: 'poll', confidence: 'authoritative' },
      headers: { usedPct: 12, fetchedAt: NOW_S * 1000, resetAt: NOW_S * 1000 - 1, source: 'headers', confidence: 'authoritative' },
    }, {
      accountId: 'active', lastFetchAt: NOW_S - 301, lastAttemptAt: NOW_S,
      nextDueAt: null, pollIntervalS: null, lastStatus: 'http-429', consecutiveFailures: 0,
      backoffUntil: null, last429At: NOW_S, heldUntil: null,
    }, NOW_S);
    assert.equal(buckets['5h']?.usedPct, 12);
  });

  it('withholds a reading whose own window reset, including the newest cohort', () => {
    const buckets = projectAnthropicUsageReadings({
      '5h': { usedPct: 20, fetchedAt: NOW_S * 1000, resetAt: (NOW_S + 86_400) * 1000, source: 'poll', confidence: 'authoritative' },
      '7d:Fable': { usedPct: 100, fetchedAt: NOW_S * 1000, resetAt: (NOW_S - 1) * 1000, source: 'poll', confidence: 'authoritative' },
      '7d:Sonnet': { usedPct: 50, fetchedAt: NOW_S * 1000, source: 'poll', confidence: 'authoritative' },
    }, {
      accountId: 'active', lastFetchAt: NOW_S, lastAttemptAt: NOW_S,
      nextDueAt: null, pollIntervalS: null, lastStatus: 'ok', consecutiveFailures: 0,
      backoffUntil: null, last429At: null, heldUntil: null,
    }, NOW_S);
    assert.equal(buckets['5h']?.usedPct, 20);
    assert.equal(buckets['7d:Fable'], undefined);
    assert.equal(buckets['7d:Sonnet']?.usedPct, 50);
  });

  it('excludes archived polls and C-swap import snapshots from persisted projections', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'qlb-anthropic-view-')), 'qlb.db');
    const store = openStore(dbPath);
    try {
      record(store, 'archived', NOW_S);
      record(store, 'imported', NOW_S);
    } finally {
      store.close();
    }
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO claude_slots (account_id, slot_num, config_json, fingerprint, added_at, archived_at)
        VALUES ('archived', 1, '{}', 'fp-a', 1, 1), ('imported', 2, '{}', 'fp-b', 1, NULL)`).run();
      db.prepare("UPDATE snapshots SET source = 'cswap-import' WHERE account_id = 'imported'").run();
    } finally {
      db.close();
    }

    const projected = readAnthropicStoreSnapshots(dbPath, NOW_S);
    const freshness = readAnthropicUsagePollFreshness(dbPath, NOW_S);
    assert.equal(projected?.hasPolls, true);
    assert.equal(projected?.snapshots[0]?.accountId, 'imported');
    assert.equal(projected?.snapshots[0]?.error, 'unavailable');
    assert.equal(freshness?.hasPolls, true);
    assert.equal(freshness?.fresh, false);
  });
});
