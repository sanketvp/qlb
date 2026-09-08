import { createHash } from 'node:crypto';
import type { AccountSnapshot, Adapter, BucketReading } from './types';

/** Spec §4.3.1 Rule S / §4.4. Far below any real (positive) headroom score. */
export const UNKNOWN_SCORE = 1;
export const STALE_DISCOUNT = 0.5;
export const WEEKLY_SCARCITY = 0.6;
export const FIVE_H_SCARCITY = 1.0;
export const DEFAULT_CEILING = 80;
export const ALL_IN_CEILING = 100;

/** A2-4 near-tie window (Rule-S score points). Used by the `spread` strategy. */
export const SPREAD_MARGIN = 10;

export const STRATEGIES = ['headroom', 'spread', 'round-robin', 'failover'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export function isStrategy(value: string | undefined): value is Strategy {
  return !!value && (STRATEGIES as readonly string[]).includes(value);
}

/** Deterministic, process-stable hash of a session id for `spread`. */
export function hashSession(session: string): number {
  return createHash('sha256').update(session).digest().readUInt32BE(0);
}

export type BucketClass = '5h' | 'weekly' | 'balance' | 'other';

/**
 * Phase 1 model → provider mapping (documented; refine later):
 *   claude-*                              → anthropic
 *   gpt-* or name contains sol/astra/luna/terra → openai-codex
 *   grok*                                 → xai
 *   k3 / kimi                             → kimi-coding
 *   OpenRouter-prefixed, z-ai/*, or glm   → openrouter
 */
export function providerForModel(modelId: string): Adapter['id'] | null {
  const m = modelId.toLowerCase();
  if (m.startsWith('openrouter/') || m.startsWith('z-ai/') || m.includes('glm')) {
    return 'openrouter';
  }
  if (m.startsWith('claude-') || m.startsWith('claude')) return 'anthropic';
  if (
    m.startsWith('gpt-') ||
    m.includes('sol') ||
    m.includes('astra') ||
    m.includes('luna') ||
    m.includes('terra')
  ) {
    return 'openai-codex';
  }
  if (m.includes('grok')) return 'xai';
  if (m.includes('k3') || m.includes('kimi')) return 'kimi-coding';
  return null;
}

/**
 * Relevant buckets for a (account, requested model) pair.
 * Codex pool buckets are omitted until pool_registry mapping exists (Phase 1).
 */
export function relevantBuckets(snapshot: AccountSnapshot, requestedModel: string): string[] {
  const m = requestedModel.toLowerCase();
  switch (snapshot.provider) {
    case 'anthropic': {
      const keys = ['5h', '7d'];
      if (m.includes('fable')) keys.push('7d:Fable');
      else if (m.includes('opus')) keys.push('7d:Opus');
      else if (m.includes('sonnet')) keys.push('7d:Sonnet');
      else if (m.includes('haiku')) keys.push('7d:Haiku');
      return keys;
    }
    case 'openai-codex':
      return ['secondary', 'primary'];
    case 'kimi-coding':
      return ['5h', 'weekly'];
    case 'xai':
      return ['tokens', 'requests'];
    case 'openrouter':
      return ['credits'];
    default:
      return Object.keys(snapshot.buckets);
  }
}

export function bucketClass(bucket: string, windowMin?: number): BucketClass {
  if (windowMin === 300) return '5h';
  if (windowMin === 10_080 || windowMin === 7 * 24 * 60) return 'weekly';
  if (bucket === 'credits') return 'balance';
  if (bucket === '5h' || bucket === 'secondary' || bucket.endsWith(':secondary')) return '5h';
  if (
    bucket === '7d' ||
    bucket.startsWith('7d:') ||
    bucket === 'primary' ||
    bucket === 'weekly' ||
    bucket.endsWith(':primary')
  ) {
    return 'weekly';
  }
  return 'other';
}

export function scarcityDiscount(klass: BucketClass): number {
  if (klass === '5h' || klass === 'balance') return FIVE_H_SCARCITY;
  if (klass === 'weekly') return WEEKLY_SCARCITY;
  return 0;
}

export function confidenceFactor(confidence: BucketReading['confidence']): number | null {
  if (confidence === 'authoritative') return 1.0;
  if (confidence === 'stale') return STALE_DISCOUNT;
  // advisory / unknown never enter min()
  return null;
}

/**
 * Rule S + corrected scarcity formula (§4.3.1, §4.4):
 *   score = min over scored buckets of (discount_b × headroom_b × f_b)
 *   headroom_b = ceiling − usedPct_b
 *   discount_b = 1.0 (5h-class) | 0.6 (weekly-class)
 *   f_b        = 1.0 (authoritative) | 0.5 (stale)
 * If no bucket is scored, return unknownScore (default 1).
 */
export function scoreAccount(
  snapshot: AccountSnapshot,
  requestedModel: string,
  ceiling: number,
): number {
  const keys = relevantBuckets(snapshot, requestedModel);
  const terms: number[] = [];
  for (const key of keys) {
    const bucket = snapshot.buckets[key];
    if (!bucket || bucket.usedPct == null) continue;
    const f = confidenceFactor(bucket.confidence);
    if (f == null) continue;
    const klass = bucketClass(key, bucket.windowMin);
    if (klass === 'other') continue;
    const discount = scarcityDiscount(klass);
    const headroom = ceiling - bucket.usedPct;
    terms.push(discount * headroom * f);
  }
  if (terms.length === 0) return UNKNOWN_SCORE;
  // Collapse IEEE dust (e.g. 0.6×62 → 37.199999999999996) so reason strings stay readable.
  return Math.round(Math.min(...terms) * 1e10) / 1e10;
}
