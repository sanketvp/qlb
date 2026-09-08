import type { AccountSnapshot } from './types';
import {
  ALL_IN_CEILING,
  DEFAULT_CEILING,
  SPREAD_MARGIN,
  hashSession,
  relevantBuckets,
  scoreAccount,
  type Strategy,
} from './scoring';
import { failoverConfigKey, roundRobinConfigKey } from './overrides';
import type { Store } from './store';

export type CeilingMode = 'headroom' | 'all-in';

export interface StrategyPick {
  snapshot: AccountSnapshot;
  score: number;
  mode: CeilingMode;
  ceiling: number;
  strategy: Strategy;
}

export interface StrategyContext {
  snapshots: AccountSnapshot[];
  model: string;
  session?: string | null;
  store?: Store;
  drainFirstIds?: Set<string>;
}

function notErrored(snapshot: AccountSnapshot): boolean {
  return !snapshot.error;
}

function byAccountId(a: AccountSnapshot, b: AccountSnapshot): number {
  return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
}

/** Existing headroom-then-all-in picker. First max-score wins (iteration order). */
function bestOf(
  snapshots: AccountSnapshot[],
  model: string,
  ceiling: number,
): { snapshot: AccountSnapshot; score: number } | null {
  let best: { snapshot: AccountSnapshot; score: number } | null = null;
  for (const snapshot of snapshots) {
    if (!notErrored(snapshot)) continue;
    const score = scoreAccount(snapshot, model, ceiling);
    if (score > 0 && (best === null || score > best.score)) {
      best = { snapshot, score };
    }
  }
  return best;
}

function pickHeadroomThenAllIn(
  snapshots: AccountSnapshot[],
  model: string,
): { snapshot: AccountSnapshot; score: number; mode: CeilingMode; ceiling: number } | null {
  const headroom = bestOf(snapshots, model, DEFAULT_CEILING);
  if (headroom) {
    return { ...headroom, mode: 'headroom', ceiling: DEFAULT_CEILING };
  }
  const allIn = bestOf(snapshots, model, ALL_IN_CEILING);
  if (allIn) {
    return { ...allIn, mode: 'all-in', ceiling: ALL_IN_CEILING };
  }
  return null;
}

function scoredPositive(
  snapshots: AccountSnapshot[],
  model: string,
  ceiling: number,
): Array<{ snapshot: AccountSnapshot; score: number }> {
  const out: Array<{ snapshot: AccountSnapshot; score: number }> = [];
  for (const snapshot of snapshots) {
    if (!notErrored(snapshot)) continue;
    const score = scoreAccount(snapshot, model, ceiling);
    if (score > 0) out.push({ snapshot, score });
  }
  return out;
}

function pickSpread(
  snapshots: AccountSnapshot[],
  model: string,
  session: string | null | undefined,
): StrategyPick | null {
  if (!session) {
    const fallback = pickHeadroomThenAllIn(snapshots, model);
    return fallback ? { ...fallback, strategy: 'headroom' } : null;
  }
  for (const [ceiling, mode] of [
    [DEFAULT_CEILING, 'headroom'],
    [ALL_IN_CEILING, 'all-in'],
  ] as const) {
    const scored = scoredPositive(snapshots, model, ceiling);
    if (scored.length === 0) continue;
    const best = Math.max(...scored.map((s) => s.score));
    const tied = scored
      .filter((s) => best - s.score <= SPREAD_MARGIN)
      .sort((a, b) => byAccountId(a.snapshot, b.snapshot));
    const idx = hashSession(session) % tied.length;
    const chosen = tied[idx];
    return {
      snapshot: chosen.snapshot,
      score: chosen.score,
      mode,
      ceiling,
      strategy: 'spread',
    };
  }
  return null;
}

/** Fully exhausted = every relevant scored bucket is at/over 100%, or the account errored. */
export function isFullyExhausted(snapshot: AccountSnapshot, model: string): boolean {
  if (snapshot.error) return true;
  return scoreAccount(snapshot, model, ALL_IN_CEILING) <= 0;
}

function eligibleForRotation(snapshot: AccountSnapshot, model: string): boolean {
  return !isFullyExhausted(snapshot, model);
}

function pickRoundRobin(
  snapshots: AccountSnapshot[],
  model: string,
  store: Store | undefined,
): StrategyPick | null {
  const eligible = snapshots.filter((s) => eligibleForRotation(s, model)).sort(byAccountId);
  if (eligible.length === 0) return null;
  const provider = eligible[0].provider;
  let idx = 0;
  if (store) {
    idx = store.nextRoundRobinIndex(roundRobinConfigKey(provider), eligible.length);
  }
  const snapshot = eligible[idx] ?? eligible[0];
  const score = scoreAccount(snapshot, model, DEFAULT_CEILING);
  const ceiling = score > 0 ? DEFAULT_CEILING : ALL_IN_CEILING;
  const mode: CeilingMode = score > 0 ? 'headroom' : 'all-in';
  return {
    snapshot,
    score: score > 0 ? score : scoreAccount(snapshot, model, ALL_IN_CEILING),
    mode,
    ceiling,
    strategy: 'round-robin',
  };
}

/**
 * Stick while every relevant bucket that has a usedPct is below 100.
 * Missing/unknown buckets do not force a switch.
 */
export function hasFailoverHeadroom(snapshot: AccountSnapshot, model: string): boolean {
  if (snapshot.error) return false;
  const keys = relevantBuckets(snapshot, model);
  for (const key of keys) {
    const bucket = snapshot.buckets[key];
    if (!bucket || bucket.usedPct == null) continue;
    if (bucket.usedPct >= 100) return false;
  }
  return true;
}

function pickFailover(
  snapshots: AccountSnapshot[],
  model: string,
  store: Store | undefined,
): StrategyPick | null {
  const eligible = snapshots.filter((s) => hasFailoverHeadroom(s, model)).sort(byAccountId);
  if (eligible.length === 0) return null;
  const provider = eligible[0].provider;
  const key = failoverConfigKey(provider);
  const currentId = store?.getConfig(key) ?? null;
  let snapshot = currentId
    ? eligible.find((s) => s.accountId === currentId) ?? null
    : null;
  if (!snapshot) {
    snapshot = eligible[0];
    store?.setConfig(key, snapshot.accountId);
  }
  const score = scoreAccount(snapshot, model, DEFAULT_CEILING);
  const ceiling = score > 0 ? DEFAULT_CEILING : ALL_IN_CEILING;
  const mode: CeilingMode = score > 0 ? 'headroom' : 'all-in';
  return {
    snapshot,
    score: score > 0 ? score : scoreAccount(snapshot, model, ALL_IN_CEILING),
    mode,
    ceiling,
    strategy: 'failover',
  };
}

function pickWithStrategy(strategy: Strategy, ctx: StrategyContext): StrategyPick | null {
  switch (strategy) {
    case 'headroom': {
      const picked = pickHeadroomThenAllIn(ctx.snapshots, ctx.model);
      return picked ? { ...picked, strategy: 'headroom' } : null;
    }
    case 'spread':
      return pickSpread(ctx.snapshots, ctx.model, ctx.session);
    case 'round-robin':
      return pickRoundRobin(ctx.snapshots, ctx.model, ctx.store);
    case 'failover':
      return pickFailover(ctx.snapshots, ctx.model, ctx.store);
  }
}

/**
 * Apply drain-first (try those accounts before the rest), then the named strategy.
 * Reserved accounts must already have been removed from `ctx.snapshots`.
 */
export function pickAccount(strategy: Strategy, ctx: StrategyContext): StrategyPick | null {
  const filtered = ctx.snapshots.filter(notErrored);
  const drainIds = ctx.drainFirstIds;
  if (drainIds && drainIds.size > 0) {
    const drain = filtered.filter((s) => drainIds.has(s.accountId));
    const rest = filtered.filter((s) => !drainIds.has(s.accountId));
    if (drain.length > 0) {
      const picked = pickWithStrategy(strategy, { ...ctx, snapshots: drain });
      if (picked) return picked;
    }
    return pickWithStrategy(strategy, { ...ctx, snapshots: rest });
  }
  return pickWithStrategy(strategy, { ...ctx, snapshots: filtered });
}
