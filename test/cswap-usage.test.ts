import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadCswapUsageSnapshots } from '../src/cswap-usage';

function fixture(opts: {
  sequence?: number[];
  active?: number;
  seqAccounts?: Record<string, unknown>;
  usageAccounts?: Record<string, unknown>;
  nowMs?: number;
}): ReturnType<typeof loadCswapUsageSnapshots> {
  const root = mkdtempSync(join(tmpdir(), 'qlb-cswap-usage-'));
  mkdirSync(join(root, 'cache'), { recursive: true });
  const sequencePath = join(root, 'sequence.json');
  const usagePath = join(root, 'cache', 'usage.json');
  writeFileSync(sequencePath, JSON.stringify({
    sequence: opts.sequence ?? [1],
    activeAccountNumber: opts.active ?? 1,
    accounts: opts.seqAccounts ?? {
      '1': { email: 'one@example.com', organizationUuid: 'org-1' },
    },
  }));
  writeFileSync(usagePath, JSON.stringify({
    schemaVersion: 2,
    accounts: opts.usageAccounts ?? {},
  }));
  return loadCswapUsageSnapshots({
    sequencePath,
    usagePath,
    nowMs: opts.nowMs ?? Date.now(),
  });
}

function eligibleLastGood(fetchedAt: number, extra: Record<string, unknown> = {}) {
  return {
    email: 'one@example.com',
    organizationUuid: 'org-1',
    fetchedAt,
    authDeadStrikes: 0,
    lastGood: {
      five_hour: { pct: 12, resets_at: '2099-01-01T00:00:00Z' },
      seven_day: { pct: 34, resets_at: '2099-01-08T00:00:00Z' },
      scoped: [{ name: 'Fable', pct: 56, resets_at: '2099-01-08T00:00:00Z' }],
    },
    ...extra,
  };
}

describe('cswap cache-only usage projection', () => {
  it('maps fixture lastGood five_hour/seven_day/scoped → 5h/7d/7d:Fable', () => {
    const nowMs = 1_700_000_000_000;
    const snaps = fixture({
      nowMs,
      usageAccounts: { '1': eligibleLastGood(nowMs / 1000) },
    });
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]?.buckets['5h']?.usedPct, 12);
    assert.equal(snaps[0]?.buckets['7d']?.usedPct, 34);
    assert.equal(snaps[0]?.buckets['7d:Fable']?.usedPct, 56);
    assert.equal(snaps[0]?.error, undefined);
  });

  it('status-cache-eligible', () => {
    const nowMs = Date.now();
    const snaps = fixture({
      nowMs,
      usageAccounts: { '1': eligibleLastGood(nowMs / 1000) },
    });
    const authExpired = snaps.filter((s) =>
      (s.error ?? '').includes('auth expired or invalid — needs re-login'),
    );
    console.log(`AUTH_EXPIRED_ROWS=${authExpired.length}`);
    assert.equal(authExpired.length, 0);
    assert.equal(snaps[0]?.error, undefined);
  });

  it('cache-identity-reuse', () => {
    const nowMs = Date.now();
    const snaps = fixture({
      nowMs,
      seqAccounts: { '1': { email: 'one@example.com', organizationUuid: 'org-1' } },
      usageAccounts: {
        '1': {
          ...eligibleLastGood(nowMs / 1000),
          email: 'other@example.com',
          organizationUuid: 'org-other',
        },
      },
    });
    const eligible = snaps.filter((s) => !s.error && Object.keys(s.buckets).length > 0);
    assert.equal(eligible.length, 0);
  });

  it('cache-disabled', () => {
    const nowMs = Date.now();
    const snaps = fixture({
      nowMs,
      seqAccounts: {
        '1': { email: 'one@example.com', organizationUuid: 'org-1', disabled: true },
      },
      usageAccounts: { '1': eligibleLastGood(nowMs / 1000) },
    });
    const eligible = snaps.filter((s) => !s.error && Object.keys(s.buckets).length > 0);
    assert.equal(eligible.length, 0);
  });

  it('cache-ancient', () => {
    const nowMs = Date.now();
    const snaps = fixture({
      nowMs,
      usageAccounts: { '1': eligibleLastGood(nowMs / 1000 - 7200) },
    });
    const eligible = snaps.filter((s) => !s.error && Object.keys(s.buckets).length > 0);
    assert.equal(eligible.length, 0);
    assert.equal(snaps[0]?.error, 'unavailable');
  });

  it('cache-dead-strike', () => {
    const nowMs = Date.now();
    const snaps = fixture({
      nowMs,
      usageAccounts: { '1': { ...eligibleLastGood(nowMs / 1000), authDeadStrikes: 1 } },
    });
    assert.equal(snaps[0]?.error, 'token_dead');
    const eligible = snaps.filter((s) => !s.error && Object.keys(s.buckets).length > 0);
    assert.equal(eligible.length, 0);
  });
});
