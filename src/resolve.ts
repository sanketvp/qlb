import type { AccountSnapshot } from './types';
import {
  ALL_IN_CEILING,
  DEFAULT_CEILING,
  providerForModel,
  scoreAccount,
} from './scoring';
import type { Store } from './store';

export interface ResolveRequest {
  model: string;
  fallback?: string[];
  session?: string | null;
  harness?: string | null;
  effort?: string | null;
  snapshots: AccountSnapshot[];
  store?: Store;
}

export interface ResolveOk {
  ok: true;
  provider: AccountSnapshot['provider'];
  accountId: string;
  model: string;
  requestedModel: string;
  servedModel: string;
  reason: string;
  mode: 'headroom' | 'all-in' | 'fallback' | 'fallback-all-in';
  snapshot: AccountSnapshot;
  score: number;
  ceiling: number;
  decisionId?: number;
}

export interface EarliestReset {
  accountId: string;
  at: number;
  limitType: string;
}

export interface ResolveExhausted {
  ok: false;
  error: 'EXHAUSTED';
  requestedModel: string;
  earliestReset: EarliestReset | null;
  candidates: AccountSnapshot[];
  decisionId?: number;
}

export type ResolveDecision = ResolveOk | ResolveExhausted;

function eligible(snapshot: AccountSnapshot): boolean {
  if (snapshot.error) return false;
  return true;
}

function bestOf(
  snapshots: AccountSnapshot[],
  model: string,
  ceiling: number,
): { snapshot: AccountSnapshot; score: number } | null {
  let best: { snapshot: AccountSnapshot; score: number } | null = null;
  for (const snapshot of snapshots) {
    if (!eligible(snapshot)) continue;
    const score = scoreAccount(snapshot, model, ceiling);
    if (score > 0 && (best === null || score > best.score)) {
      best = { snapshot, score };
    }
  }
  return best;
}

function pickCandidate(
  snapshots: AccountSnapshot[],
  model: string,
): { snapshot: AccountSnapshot; score: number; mode: 'headroom' | 'all-in'; ceiling: number } | null {
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

export function findEarliestReset(snapshots: AccountSnapshot[]): EarliestReset | null {
  let best: EarliestReset | null = null;
  for (const snap of snapshots) {
    for (const [limitType, reading] of Object.entries(snap.buckets)) {
      if (reading.resetAt == null || !Number.isFinite(reading.resetAt)) continue;
      if (best === null || reading.resetAt < best.at) {
        best = { accountId: snap.accountId, at: reading.resetAt, limitType };
      }
    }
  }
  return best;
}

export function snapshotsFromStore(store: Store, provider?: string): AccountSnapshot[] {
  const accounts = store.listAccounts(provider);
  return accounts.map((row) => ({
    accountId: row.id,
    provider: row.provider as AccountSnapshot['provider'],
    label: row.label,
    buckets: store.getAllSnapshots(row.id),
  }));
}

function snapshotJson(decision: ResolveDecision): string {
  const now = Date.now();
  if (!decision.ok) {
    return JSON.stringify({
      error: 'EXHAUSTED',
      earliestReset: decision.earliestReset,
      candidates: decision.candidates.map((s) => ({
        accountId: s.accountId,
        provider: s.provider,
        buckets: Object.fromEntries(
          Object.entries(s.buckets).map(([k, v]) => [
            k,
            {
              usedPct: v.usedPct,
              confidence: v.confidence,
              source: v.source,
              fetchedAt: v.fetchedAt,
              ageMs: v.fetchedAt ? now - v.fetchedAt : null,
              resetAt: v.resetAt,
            },
          ]),
        ),
      })),
    });
  }
  return JSON.stringify({
    accountId: decision.accountId,
    provider: decision.provider,
    label: decision.snapshot.label,
    score: decision.score,
    ceiling: decision.ceiling,
    buckets: Object.fromEntries(
      Object.entries(decision.snapshot.buckets).map(([k, v]) => [
        k,
        {
          usedPct: v.usedPct,
          confidence: v.confidence,
          source: v.source,
          fetchedAt: v.fetchedAt,
          ageMs: v.fetchedAt ? now - v.fetchedAt : null,
          resetAt: v.resetAt,
        },
      ]),
    ),
  });
}

function record(store: Store | undefined, req: ResolveRequest, decision: ResolveDecision): number | undefined {
  if (!store) return undefined;
  if (decision.ok) {
    return store.recordDecision({
      session: req.session,
      harness: req.harness,
      requested_model: req.model,
      effort: req.effort,
      served_model: decision.servedModel,
      account_id: decision.accountId,
      mode: decision.mode,
      reason: decision.reason,
      snapshot_json: snapshotJson(decision),
    });
  }
  return store.recordDecision({
    session: req.session,
    harness: req.harness,
    requested_model: req.model,
    effort: req.effort,
    served_model: null,
    account_id: null,
    mode: 'exhausted',
    reason: 'EXHAUSTED',
    snapshot_json: snapshotJson(decision),
  });
}

/**
 * Headroom-then-all-in selection over already-fetched snapshots, then fallback walk.
 * Does not touch the network. Persists a decisions row when `store` is provided.
 */
export function resolveFromSnapshots(req: ResolveRequest): ResolveDecision {
  const fallback = req.fallback ?? [];
  const chain = [req.model, ...fallback];
  let lastCandidates: AccountSnapshot[] = [];

  for (let i = 0; i < chain.length; i++) {
    const candidateModel = chain[i];
    const provider = providerForModel(candidateModel);
    if (!provider) continue;
    const candidates = req.snapshots.filter((s) => s.provider === provider);
    lastCandidates = candidates;
    const picked = pickCandidate(candidates, candidateModel);
    if (!picked) continue;

    const substituted = i > 0;
    const mode = substituted
      ? picked.mode === 'all-in'
        ? 'fallback-all-in'
        : 'fallback'
      : picked.mode;
    const reason = substituted
      ? `fallback ${candidateModel} ${picked.mode} score ${picked.score} (ceiling ${picked.ceiling})`
      : `${picked.mode} score ${picked.score} (ceiling ${picked.ceiling})`;

    const decision: ResolveOk = {
      ok: true,
      provider,
      accountId: picked.snapshot.accountId,
      model: req.model,
      requestedModel: req.model,
      servedModel: candidateModel,
      reason,
      mode,
      snapshot: picked.snapshot,
      score: picked.score,
      ceiling: picked.ceiling,
    };
    decision.decisionId = record(req.store, req, decision);
    return decision;
  }

  const exhausted: ResolveExhausted = {
    ok: false,
    error: 'EXHAUSTED',
    requestedModel: req.model,
    earliestReset: findEarliestReset(req.snapshots.length ? req.snapshots : lastCandidates),
    candidates: req.snapshots,
  };
  exhausted.decisionId = record(req.store, req, exhausted);
  return exhausted;
}

export { providerForModel };
