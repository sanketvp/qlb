import type { AccountSnapshot } from './types';
import {
  ALL_IN_CEILING,
  providerForModel,
  scoreAccount,
  type Strategy,
} from './scoring';
import { isFullyExhausted, pickAccount } from './strategies';
import type { Store } from './store';

export interface ResolveRequest {
  model: string;
  fallback?: string[];
  session?: string | null;
  harness?: string | null;
  effort?: string | null;
  snapshots: AccountSnapshot[];
  store?: Store;
  strategy?: Strategy;
}

export interface ResolveOk {
  ok: true;
  provider: AccountSnapshot['provider'];
  accountId: string;
  model: string;
  requestedModel: string;
  servedModel: string;
  reason: string;
  mode: 'headroom' | 'all-in' | 'fallback' | 'fallback-all-in' | 'pin' | 'spread' | 'round-robin' | 'failover';
  strategy: Strategy | 'pin';
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

export interface ResolvePinnedUnavailable {
  ok: false;
  error: 'PINNED_UNAVAILABLE';
  requestedModel: string;
  accountId: string;
  reason: string;
  decisionId?: number;
}

export type ResolveDecision = ResolveOk | ResolveExhausted | ResolvePinnedUnavailable;

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
    if (decision.error === 'PINNED_UNAVAILABLE') {
      return JSON.stringify({
        error: 'PINNED_UNAVAILABLE',
        accountId: decision.accountId,
        reason: decision.reason,
      });
    }
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
  if (decision.error === 'PINNED_UNAVAILABLE') {
    return store.recordDecision({
      session: req.session,
      harness: req.harness,
      requested_model: req.model,
      effort: req.effort,
      served_model: null,
      account_id: decision.accountId,
      mode: 'pin_unavailable',
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

function activeOverrideSets(store: Store | undefined): {
  reserved: Set<string>;
  drainFirst: Set<string>;
} {
  const reserved = new Set<string>();
  const drainFirst = new Set<string>();
  if (!store) return { reserved, drainFirst };
  for (const row of store.listActiveOverrides()) {
    if (row.kind === 'reserve') reserved.add(row.account_id);
    if (row.kind === 'drain-first') drainFirst.add(row.account_id);
  }
  return { reserved, drainFirst };
}

function resolvePinned(
  req: ResolveRequest,
  chain: string[],
): ResolveDecision | null {
  if (!req.session || !req.store) return null;
  const pin = req.store.getPinOverride(req.session);
  if (!pin) return null;

  const snap = req.snapshots.find((s) => s.accountId === pin.account_id);
  const unavailable = (reason: string): ResolvePinnedUnavailable => {
    const decision: ResolvePinnedUnavailable = {
      ok: false,
      error: 'PINNED_UNAVAILABLE',
      requestedModel: req.model,
      accountId: pin.account_id,
      reason,
    };
    decision.decisionId = record(req.store, req, decision);
    return decision;
  };

  if (!snap) {
    return unavailable(
      `pinned account unavailable: ${pin.account_id} not in candidate snapshots`,
    );
  }
  if (snap.error) {
    return unavailable(
      `pinned account unavailable: ${pin.account_id} is in an error state (${snap.error})`,
    );
  }

  for (let i = 0; i < chain.length; i++) {
    const candidateModel = chain[i];
    const provider = providerForModel(candidateModel);
    if (!provider || snap.provider !== provider) continue;
    if (isFullyExhausted(snap, candidateModel)) continue;
    const score = scoreAccount(snap, candidateModel, ALL_IN_CEILING);
    const substituted = i > 0;
    const reason = substituted
      ? `pin override session=${req.session} account=${snap.accountId} fallback ${candidateModel}`
      : `pin override session=${req.session} account=${snap.accountId}`;
    const decision: ResolveOk = {
      ok: true,
      provider,
      accountId: snap.accountId,
      model: req.model,
      requestedModel: req.model,
      servedModel: candidateModel,
      reason,
      mode: 'pin',
      strategy: 'pin',
      snapshot: snap,
      score,
      ceiling: ALL_IN_CEILING,
    };
    decision.decisionId = record(req.store, req, decision);
    return decision;
  }

  return unavailable(
    `pinned account unavailable: ${pin.account_id} has no remaining headroom for ${req.model}`,
  );
}

/**
 * Selection over already-fetched snapshots, then fallback walk.
 * Pin overrides (if any) are applied before any strategy.
 * Does not touch the network. Persists a decisions row when `store` is provided.
 */
export function resolveFromSnapshots(req: ResolveRequest): ResolveDecision {
  const fallback = req.fallback ?? [];
  const chain = [req.model, ...fallback];
  const strategy: Strategy = req.strategy ?? 'headroom';

  const pinned = resolvePinned(req, chain);
  if (pinned) return pinned;

  const { reserved, drainFirst } = activeOverrideSets(req.store);
  let lastCandidates: AccountSnapshot[] = [];

  for (let i = 0; i < chain.length; i++) {
    const candidateModel = chain[i];
    const provider = providerForModel(candidateModel);
    if (!provider) continue;
    const candidates = req.snapshots.filter(
      (s) => s.provider === provider && !reserved.has(s.accountId),
    );
    lastCandidates = candidates;
    const picked = pickAccount(strategy, {
      snapshots: candidates,
      model: candidateModel,
      session: req.session,
      store: req.store,
      drainFirstIds: drainFirst,
    });
    if (!picked) continue;

    const substituted = i > 0;
    const mode = substituted
      ? picked.mode === 'all-in'
        ? 'fallback-all-in'
        : 'fallback'
      : picked.strategy === 'headroom'
        ? picked.mode
        : picked.strategy;
    const reason = substituted
      ? `fallback ${candidateModel} ${picked.strategy} ${picked.mode} score ${picked.score} (ceiling ${picked.ceiling})`
      : picked.strategy === 'headroom'
        ? `${picked.mode} score ${picked.score} (ceiling ${picked.ceiling})`
        : `${picked.strategy} ${picked.mode} score ${picked.score} (ceiling ${picked.ceiling})`;

    const decision: ResolveOk = {
      ok: true,
      provider,
      accountId: picked.snapshot.accountId,
      model: req.model,
      requestedModel: req.model,
      servedModel: candidateModel,
      reason,
      mode,
      strategy: picked.strategy,
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
