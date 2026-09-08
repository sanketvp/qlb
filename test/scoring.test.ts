import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountSnapshot, BucketReading, Confidence } from '../src/types';
import {
  DEFAULT_CEILING,
  UNKNOWN_SCORE,
  scoreAccount,
} from '../src/scoring';

function reading(
  usedPct: number,
  confidence: Confidence = 'authoritative',
): BucketReading {
  return {
    usedPct,
    source: 'poll',
    confidence,
    fetchedAt: Date.now(),
  };
}

function anthropic(
  id: string,
  buckets: Record<string, BucketReading>,
): AccountSnapshot {
  return {
    accountId: id,
    provider: 'anthropic',
    label: id,
    buckets,
  };
}

describe('scoring formula — spec §4.4 worked examples', () => {
  it('case 1: swapped headroom — thin weekly loses (A=10 beats B=9)', () => {
    const A = anthropic('A', {
      '5h': reading(70), // headroom 10
      '7d': reading(20), // headroom 60 → 0.6×60 = 36
    });
    const B = anthropic('B', {
      '5h': reading(40), // headroom 40
      '7d': reading(65), // headroom 15 → 0.6×15 = 9
    });
    const scoreA = scoreAccount(A, 'claude-sonnet-5', DEFAULT_CEILING);
    const scoreB = scoreAccount(B, 'claude-sonnet-5', DEFAULT_CEILING);
    assert.equal(scoreA, 10);
    assert.equal(scoreB, 9);
    assert.ok(scoreA > scoreB, 'A must win: B\'s weekly is thin');
  });

  it('case 2: equal raw margins — C=20 beats D=12', () => {
    const C = anthropic('C', {
      '5h': reading(60), // 20
      '7d': reading(30), // 0.6×50 = 30
    });
    const D = anthropic('D', {
      '5h': reading(30), // 50
      '7d': reading(60), // 0.6×20 = 12
    });
    assert.equal(scoreAccount(C, 'claude-sonnet-5', DEFAULT_CEILING), 20);
    assert.equal(scoreAccount(D, 'claude-sonnet-5', DEFAULT_CEILING), 12);
  });

  it('case 3: Fable pool request — F=15 beats E=3 (E\'s Fable pool nearly at ceiling)', () => {
    const E = anthropic('E', {
      '5h': reading(40), // 40
      '7d': reading(40), // 0.6×40 = 24
      '7d:Fable': reading(75), // 0.6×5 = 3
    });
    const F = anthropic('F', {
      '5h': reading(65), // 15
      '7d': reading(45), // 0.6×35 = 21
      '7d:Fable': reading(50), // 0.6×30 = 18
    });
    assert.equal(scoreAccount(E, 'claude-fable-5', DEFAULT_CEILING), 3);
    assert.equal(scoreAccount(F, 'claude-fable-5', DEFAULT_CEILING), 15);
  });
});

describe('Rule S — spec §4.3.1', () => {
  it('authoritative-only account scores on all relevant buckets (H = 20)', () => {
    const H = anthropic('H', {
      '5h': reading(60), // 20
      '7d': reading(30), // 0.6×50 = 30
      '7d:Fable': reading(45), // 0.6×35 = 21
    });
    assert.equal(scoreAccount(H, 'claude-fable-5', DEFAULT_CEILING), 20);
  });

  it('mixed authoritative + stale: stale weekly is scored at ×0.5 (G = 12)', () => {
    const G = anthropic('G', {
      '5h': reading(50, 'authoritative'), // 30
      '7d': reading(40, 'stale'), // 0.6×40×0.5 = 12
      // 7d:Fable unknown — omitted, must neither help nor hurt
    });
    assert.equal(scoreAccount(G, 'claude-fable-5', DEFAULT_CEILING), 12);
  });

  it('all-unknown / all-advisory account gets unknownScore', () => {
    const unknown = anthropic('I', {});
    assert.equal(scoreAccount(unknown, 'claude-fable-5', DEFAULT_CEILING), UNKNOWN_SCORE);

    const advisoryOnly = anthropic('I-adv', {
      '5h': reading(40, 'advisory'),
      '7d': reading(40, 'advisory'),
    });
    assert.equal(
      scoreAccount(advisoryOnly, 'claude-fable-5', DEFAULT_CEILING),
      UNKNOWN_SCORE,
    );

    const xai: AccountSnapshot = {
      accountId: 'xai-default',
      provider: 'xai',
      label: 'Grok',
      buckets: {
        tokens: reading(10, 'advisory'),
        requests: reading(5, 'advisory'),
      },
    };
    assert.equal(scoreAccount(xai, 'grok-4.6', DEFAULT_CEILING), UNKNOWN_SCORE);
  });

  it('unknown Fable bucket does not drag an otherwise-scored account to unknownScore', () => {
    const mixed = anthropic('mix', {
      '5h': reading(50), // 30
      '7d': reading(30), // 0.6×50 = 30
      // no 7d:Fable
    });
    assert.equal(scoreAccount(mixed, 'claude-fable-5', DEFAULT_CEILING), 30);
  });
});
