import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decorateStatusJson,
  displayWindow,
  enrichAccounts,
  formatCapacity,
  formatDashboard,
  formatFlatTable,
  formatRelative,
  formatResetAtLocal,
  formatResetClause,
  leftPct,
  normalizeLeftPct,
  statusRowsForAccount,
  type StatusDisplayRow,
} from '../src/dashboard';
import type { AccountSnapshot, BucketReading } from '../src/types';

function reading(partial: Partial<BucketReading> & Pick<BucketReading, 'usedPct'>): BucketReading {
  return {
    source: 'poll',
    confidence: 'authoritative',
    fetchedAt: 1,
    ...partial,
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

function dashboard(accounts: AccountSnapshot[], now?: number): string {
  return formatDashboard(
    enrichAccounts(accounts, {
      ownershipForProvider: () => 'QLB_OWNED',
      overrideForAccount: () => null,
    }),
    now,
  );
}

describe('leftPct / formatCapacity', () => {
  it('treats null and undefined usedPct as unknown, never 100% left or NaN', () => {
    assert.equal(leftPct(null), null);
    assert.equal(leftPct(undefined), null);
    assert.equal(leftPct(Number.NaN), null);
    const cap = formatCapacity(null);
    assert.equal(cap.used, 'unknown');
    assert.equal(cap.left, 'unknown');
    assert.equal(cap.leftPct, null);
    assert.doesNotMatch(cap.left, /100%/);
    assert.doesNotMatch(cap.used, /NaN/);
    assert.doesNotMatch(cap.left, /NaN/);
  });

  it('clamps leftPct to 0–100 when usedPct is > 100 or < 0', () => {
    assert.equal(leftPct(150), 0);
    assert.equal(leftPct(-10), 100);
    assert.equal(leftPct(100), 0);
    assert.equal(leftPct(0), 100);
    assert.equal(formatCapacity(150).left, '0%');
    assert.equal(formatCapacity(-10).left, '100%');
  });

  it('computes remaining alongside used', () => {
    const cap = formatCapacity(4);
    assert.equal(cap.used, '4%');
    assert.equal(cap.left, '96%');
    assert.equal(cap.leftPct, 96);
  });
});

describe('window normalization', () => {
  it('maps kimi weekly to the 7d display row and keeps the raw JSON key', () => {
    assert.equal(displayWindow('weekly'), '7d');
    assert.equal(displayWindow('5h'), '5h');
    assert.equal(displayWindow('7d'), '7d');

    const account = snap({
      accountId: 'kimi-default',
      provider: 'kimi-coding',
      label: 'Kimi K3',
      buckets: {
        '5h': reading({ usedPct: null, resetAt: 2_000 }),
        weekly: reading({ usedPct: 57, resetAt: 3_000 }),
      },
    });
    const rows = statusRowsForAccount(account, 1_000);
    assert.equal(rows[0].window, '5h');
    assert.equal(rows[0].used, 'unknown');
    assert.equal(rows[0].left, 'unknown');
    assert.equal(rows[1].window, '7d');
    assert.equal(rows[1].rawKey, 'weekly');
    assert.equal(rows[1].used, '57%');
    assert.equal(rows[1].left, '43%');
    assert.equal(rows.filter((r) => r.window === 'weekly').length, 0);

    const json = decorateStatusJson([account], 1_000)[0];
    assert.ok('weekly' in json.buckets);
    assert.ok(!('7d' in json.buckets));
    const weekly = json.buckets.weekly as BucketReading & { window: string; leftPct: number };
    assert.equal(weekly.window, '7d');
    assert.equal(weekly.usedPct, 57);
    assert.equal(weekly.leftPct, 43);
  });
});

describe('missing buckets and resetAt', () => {
  it('prints 5h and 7d as not reported for an account with no buckets', () => {
    const account = snap({
      accountId: 'codex',
      provider: 'openai-codex',
      label: 'sanket.patel@gmail.com',
      buckets: {},
    });
    const rows = statusRowsForAccount(account);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].window, '5h');
    assert.equal(rows[1].window, '7d');
    assert.equal(rows[0].detail, 'not reported by openai-codex');
    assert.equal(rows[1].detail, 'not reported by openai-codex');
    assert.doesNotMatch(rows[0].detail, /(^| )-( |$)/);
    const text = dashboard([account]);
    assert.match(text, /5h\s+not reported by openai-codex/);
    assert.match(text, /7d\s+not reported by openai-codex/);
  });

  it('does not guess that a rolling zero-usage bucket with no resetAt has not started', () => {
    const clause = formatResetClause({
      provider: 'synthetic',
      window: '5h',
      usedPct: 0,
    });
    assert.equal(clause, 'reset: not reported by synthetic');
    assert.doesNotMatch(clause, /window not started/);
    assert.doesNotMatch(clause, /(^| )-( |$)/);

    const account = snap({
      accountId: 'account-4',
      provider: 'synthetic',
      label: 'zero-usage-no-reset',
      buckets: {
        '5h': reading({ usedPct: 0 }),
        '7d': reading({ usedPct: 99, resetAt: 50_000 }),
      },
    });
    const text = dashboard([account], 1_000);
    assert.match(text, /5h\s+0% used\s+100% left\s+authoritative\s+reset: not reported by synthetic/);
    assert.doesNotMatch(text, /window not started/);
  });

  it('says not reported by the provider when a non-window bucket has no resetAt', () => {
    const clause = formatResetClause({
      provider: 'xai',
      window: 'requests',
      usedPct: 0.1,
    });
    assert.equal(clause, 'reset: not reported by xai');

    const account = snap({
      accountId: 'xai-default',
      provider: 'xai',
      label: 'Grok (xAI)',
      buckets: {
        requests: reading({ usedPct: 0.1, confidence: 'advisory' }),
        tokens: reading({ usedPct: 0.7, confidence: 'advisory' }),
      },
    });
    const text = dashboard([account]);
    assert.match(text, /5h\s+not reported by xai/);
    assert.match(text, /7d\s+not reported by xai/);
    assert.match(text, /requests\s+0\.1% used\s+99\.9% left\s+advisory\s+reset: not reported by xai/);
    assert.doesNotMatch(text, /resets -/);
  });
});

describe('reset times', () => {
  it('renders relative past resets as ago, plus absolute local time', () => {
    const now = new Date(2026, 8, 16, 12, 0, 0).getTime();
    const past = new Date(2026, 8, 16, 9, 0, 0).getTime();
    assert.equal(formatRelative(past, now), '3h ago');
    assert.equal(formatResetAtLocal(past, now), 'today 09:00');
    const clause = formatResetClause({
      provider: 'anthropic',
      window: '5h',
      usedPct: 10,
      resetAt: past,
      now,
    });
    assert.equal(clause, 'resets 3h ago (today 09:00)');
  });

  it('renders today and weekday absolute local times for future resets', () => {
    const now = new Date(2026, 8, 16, 12, 0, 0).getTime(); // Wed
    const laterToday = new Date(2026, 8, 16, 22, 0, 0).getTime();
    const thursday = new Date(2026, 8, 17, 9, 0, 0).getTime();
    assert.equal(formatResetAtLocal(laterToday, now), 'today 22:00');
    assert.equal(formatResetAtLocal(thursday, now), 'tomorrow 09:00');
    assert.match(
      formatResetClause({
        provider: 'anthropic',
        window: '5h',
        usedPct: 4,
        resetAt: laterToday,
        now,
      }),
      /resets in 10h \(today 22:00\)/,
    );
  });
});

describe('exhausted rendering', () => {
  it('marks 0% left as EXHAUSTED on the bucket line and account header', () => {
    const now = new Date(2026, 8, 16, 12, 0, 0).getTime();
    const resetAt = new Date(2026, 8, 17, 9, 0, 0).getTime();
    const account = snap({
      accountId: 'account-1',
      label: 'sanket@modustech.com',
      buckets: {
        '5h': reading({ usedPct: 4, resetAt }),
        '7d': reading({ usedPct: 100, resetAt }),
        '7d:Fable': reading({ usedPct: 100, resetAt }),
      },
    });
    const text = dashboard([account], now);
    assert.match(text, /✗  sanket@modustech.com  anthropic  QLB_OWNED  override=none  EXHAUSTED \(7d, 7d:Fable\)/);
    assert.match(text, /7d\s+100% used\s+0% left\s+EXHAUSTED\s+authoritative/);
    assert.match(text, /7d:Fable\s+100% used\s+0% left\s+EXHAUSTED\s+authoritative/);
    assert.match(text, /5h\s+4% used\s+96% left\s+authoritative/);
    assert.equal(accountHealthGlyph(account), '✗');
  });
});

function accountHealthGlyph(account: AccountSnapshot): string {
  return enrichAccounts([account], {
    ownershipForProvider: () => 'QLB_OWNED',
    overrideForAccount: () => null,
  })[0].healthGlyph;
}

describe('json decoration is additive', () => {
  it('keeps existing bucket fields and adds leftPct / window / reset fields', () => {
    const now = 1_000;
    const account = snap({
      accountId: 'a',
      buckets: {
        '5h': reading({ usedPct: 4, resetAt: 5_000, source: 'poll', confidence: 'authoritative', fetchedAt: 1 }),
      },
    });
    const decorated = decorateStatusJson([account], now)[0].buckets['5h'] as BucketReading & {
      leftPct: number;
      window: string;
      resetInMs: number;
      resetAtLocal: string;
    };
    assert.equal(decorated.usedPct, 4);
    assert.equal(decorated.source, 'poll');
    assert.equal(decorated.confidence, 'authoritative');
    assert.equal(decorated.fetchedAt, 1);
    assert.equal(decorated.resetAt, 5_000);
    assert.equal(decorated.leftPct, 96);
    assert.equal(decorated.window, '5h');
    assert.equal(decorated.resetInMs, 4_000);
    assert.equal(typeof decorated.resetAtLocal, 'string');
  });

  it('sets leftPct null and resetInMs null when those inputs are missing', () => {
    const account = snap({
      accountId: 'a',
      buckets: { '5h': reading({ usedPct: null }) },
    });
    const decorated = decorateStatusJson([account], 1)[0].buckets['5h'] as BucketReading & {
      leftPct: number | null;
      resetInMs: number | null;
      resetAtLocal: string | null;
    };
    assert.equal(decorated.usedPct, null);
    assert.equal(decorated.leftPct, null);
    assert.equal(decorated.resetInMs, null);
    assert.equal(decorated.resetAtLocal, null);
  });

  it('rounds added leftPct to 1 decimal and leaves usedPct byte-identical', () => {
    const noisyUsed = 98.70861418600001;
    const account = snap({
      accountId: 'a',
      buckets: { credits: reading({ usedPct: noisyUsed }) },
    });
    const decorated = decorateStatusJson([account], 1)[0].buckets.credits as BucketReading & {
      leftPct: number;
    };
    assert.equal(decorated.usedPct, noisyUsed);
    assert.equal(decorated.leftPct, 1.3);
    assert.equal(JSON.stringify(decorated.leftPct), '1.3');
    assert.doesNotMatch(JSON.stringify(decorated.leftPct), /000000/);
  });
});

describe('displayed remaining and LOW/EXHAUSTED markers share one value', () => {
  function rowForLeft(remaining: number): StatusDisplayRow {
    const account = snap({
      accountId: 'a',
      buckets: { '5h': reading({ usedPct: 100 - remaining, resetAt: 2_000 }) },
    });
    return statusRowsForAccount(account, 1_000)[0];
  }

  function assertAgree(
    remaining: number,
    expectedLeft: string,
    expectedMarker: '' | 'LOW' | 'EXHAUSTED',
  ): void {
    const row = rowForLeft(remaining);
    const printedLeft = expectedMarker ? `${expectedLeft} ${expectedMarker}` : expectedLeft;
    assert.equal(row.left, printedLeft, `left string for remaining=${remaining}`);
    assert.equal(row.marker, expectedMarker, `marker for remaining=${remaining}`);
    assert.equal(row.exhausted, expectedMarker === 'EXHAUSTED');
    assert.equal(row.low, expectedMarker === 'LOW');
    assert.equal(normalizeLeftPct(remaining), expectedMarker === 'EXHAUSTED' ? 0 : Number.parseFloat(expectedLeft));
    if (expectedLeft === '0%') assert.equal(expectedMarker, 'EXHAUSTED');
    if (expectedLeft === '5%') assert.equal(expectedMarker, 'LOW');
    if (row.exhausted) {
      assert.match(row.detail, /(^|\s)0% left\s+EXHAUSTED/);
    } else {
      assert.doesNotMatch(row.left, /^0%/);
      assert.doesNotMatch(row.detail, /(^|\s)0% left/);
    }
    if (row.low) assert.match(row.detail, /LOW/);
    else assert.doesNotMatch(row.detail, /\bLOW\b/);
  }

  it('prints 0% left as EXHAUSTED and never shows 0% without that marker', () => {
    assertAgree(0, '0%', 'EXHAUSTED');
  });

  it('does not round a positive remainder down to 0% (0.04 → 0.1% LOW)', () => {
    assertAgree(0.04, '0.1%', 'LOW');
  });

  it('keeps 0.1% left as LOW', () => {
    assertAgree(0.1, '0.1%', 'LOW');
  });

  it('prints 5% left as LOW', () => {
    assertAgree(5, '5%', 'LOW');
  });

  it('does not display a value above LOW as exactly 5% (5.04 → 5.1%, not LOW)', () => {
    assertAgree(5.04, '5.1%', '');
  });

  it('prints 100% left with no marker', () => {
    assertAgree(100, '100%', '');
  });
});

describe('flat table is the original raw bucket table', () => {
  it('keeps raw weekly, original 6 columns, and no synthetic rows', () => {
    const now = 1_000;
    const text = formatFlatTable(
      [
        snap({
          accountId: 'kimi-default',
          provider: 'kimi-coding',
          label: 'Kimi K3',
          buckets: {
            '5h': reading({ usedPct: 10 }),
            weekly: reading({ usedPct: 57 }),
          },
        }),
        snap({
          accountId: 'codex',
          provider: 'openai-codex',
          label: 'codex',
          buckets: {},
        }),
        snap({
          accountId: 'broken',
          provider: 'openai-codex',
          label: 'broken',
          buckets: {},
          error: 'no credentials',
        }),
      ],
      now,
    );
    const lines = text.split('\n');
    const headerCols = lines[0].split(' | ').map((c) => c.trim());
    assert.deepEqual(headerCols, ['provider', 'account', 'bucket', 'used', 'confidence', 'resets']);
    assert.equal(headerCols.length, 6);
    assert.doesNotMatch(lines[0], /left/);
    assert.equal(
      text,
      [
        'provider     | account | bucket | used | confidence    | resets               ',
        'kimi-coding  | Kimi K3 | 5h     | 10%  | authoritative | resets -             ',
        'kimi-coding  | Kimi K3 | weekly | 57%  | authoritative | resets -             ',
        'openai-codex | broken  | -      | -    | error         | resets no credentials',
      ].join('\n'),
    );
    assert.match(text, /weekly/);
    assert.doesNotMatch(text, /\| 7d /);
    assert.doesNotMatch(text, /codex \| 5h/);
    assert.doesNotMatch(text, /not reported/);
  });
});
