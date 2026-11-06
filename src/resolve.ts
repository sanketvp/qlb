import type { AccountSnapshot } from './types';
import {
  ALL_IN_CEILING,
  providerForModel,
  relevantBuckets,
  scoreAccount,
  type Strategy,
} from './scoring';
import { findUniqueCodexAlias, isFullyExhausted, pickAccount } from './strategies';
import { routingAuthority } from './routing-authority';
import { ROUTING_DECISION_MODES, type Store } from './store';

export { ROUTING_DECISION_MODES };

export interface ResolveRequest {
  model: string;
  fallback?: string[];
  session?: string | null;
  harness?: string | null;
  effort?: string | null;
  snapshots: AccountSnapshot[];
  store?: Store;
  strategy?: Strategy;
  /** When false, skip decision persistence and strategy cursor writes. Default true. */
  persist?: boolean;
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

export interface ResolveUnavailable {
  ok: false;
  error: 'UNAVAILABLE';
  requestedModel: string;
  reason: string;
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

export type ResolveDecision = ResolveOk | ResolveExhausted | ResolveUnavailable | ResolvePinnedUnavailable;

export const PROVIDER_REFRESH_REQUIRED = 'fresh provider quota reading required; run qlb refresh --allow-probe';

function unavailableReason(model: string): string {
  switch (providerForModel(model)) {
    case 'xai':
      return 'xAI quota readings are advisory and unavailable for routing';
    case 'anthropic':
      return 'fresh Anthropic provider quota reading required; cached or imported readings are display-only until direct usage polling is available';
    case 'openai-codex':
      return 'fresh Codex provider quota reading required; wait for its auto poll or a quota-bearing proxy response';
    default:
      return PROVIDER_REFRESH_REQUIRED;
  }
}

export function findEarliestReset(snapshots: AccountSnapshot[], model?: string): EarliestReset | null {
  let best: EarliestReset | null = null;
  for (const snap of snapshots) {
    const buckets = model === undefined ? Object.entries(snap.buckets) : relevantBuckets(snap, model)
      .flatMap((limitType) => {
        const reading = snap.buckets[limitType];
        return reading === undefined ? [] : [[limitType, reading] as const];
      });
    for (const [limitType, reading] of buckets) {
      if (reading.resetAt == null || !Number.isFinite(reading.resetAt)) continue;
      if (best === null || reading.resetAt < best.at) {
        best = { accountId: snap.accountId, at: reading.resetAt, limitType };
      }
    }
  }
  return best;
}

function findEarliestResetForModels(candidates: Array<{ snapshot: AccountSnapshot; model: string }>): EarliestReset | null {
  let best: EarliestReset | null = null;
  for (const candidate of candidates) {
    const reset = findEarliestReset([candidate.snapshot], candidate.model);
    if (reset !== null && (best === null || reset.at < best.at)) best = reset;
  }
  return best;
}

export function snapshotsFromStore(store: Store, provider?: string): AccountSnapshot[] {
  const accounts = store.listAccounts(provider).filter((row) =>
    (row.status === 'active' || row.status === 'validated')
    && (row.provider !== 'anthropic' || store.isAnthropicSlotLive(row.id) !== false));
  return accounts.map((row) => ({
    accountId: row.id,
    provider: row.provider as AccountSnapshot['provider'],
    label: row.label,
    buckets: store.getAllSnapshots(row.id),
  }));
}

function serializeSnapshots(snapshots: AccountSnapshot[], now: number): Array<Record<string, unknown>> {
  return snapshots.map((snapshot) => ({
    accountId: snapshot.accountId,
    provider: snapshot.provider,
    buckets: Object.fromEntries(Object.entries(snapshot.buckets).map(([bucket, reading]) => [bucket, {
      usedPct: reading.usedPct,
      confidence: reading.confidence,
      source: reading.source,
      fetchedAt: reading.fetchedAt,
      ageMs: reading.fetchedAt ? now - reading.fetchedAt : null,
      resetAt: reading.resetAt,
    }])),
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
    if (decision.error === 'UNAVAILABLE') {
      return JSON.stringify({
        error: 'UNAVAILABLE',
        reason: decision.reason,
        candidates: serializeSnapshots(decision.candidates, now),
      });
    }
    return JSON.stringify({
      error: 'EXHAUSTED',
      earliestReset: decision.earliestReset,
      candidates: serializeSnapshots(decision.candidates, now),
    });
  }
  return JSON.stringify({
    accountId: decision.accountId,
    provider: decision.provider,
    label: decision.snapshot.label,
    score: decision.score,
    ceiling: decision.ceiling,
    buckets: serializeSnapshots([decision.snapshot], now)[0]!.buckets,
  });
}

function record(store: Store | undefined, req: ResolveRequest, decision: ResolveDecision): number | undefined {
  if (!store || req.persist === false) return undefined;
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
      strategy: decision.strategy,
      provider: decision.provider,
    });
  }
  if (decision.error === 'PINNED_UNAVAILABLE') {
    const snap = req.snapshots.find((s) => s.accountId === decision.accountId);
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
      strategy: 'pin',
      provider: snap?.provider ?? providerForModel(req.model),
    });
  }
  return store.recordDecision({
    session: req.session,
    harness: req.harness,
    requested_model: req.model,
    effort: req.effort,
    served_model: null,
    account_id: null,
    mode: decision.error === 'UNAVAILABLE' ? 'unavailable' : 'exhausted',
    reason: decision.error === 'UNAVAILABLE' ? decision.reason : 'EXHAUSTED',
    snapshot_json: snapshotJson(decision),
    strategy: req.strategy ?? 'headroom',
    provider: providerForModel(req.model),
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

  const store = req.store;
  // A bare-id alias only reaches Codex slots QLB owns (the C3c-RV2 rule).
  const snap = req.snapshots.find((s) => s.accountId === pin.account_id)
    ?? findUniqueCodexAlias(
      pin.account_id,
      req.snapshots.filter((s) => store.getAccount(s.accountId)?.provider === 'openai-codex'),
    );
  const pinnedId = snap?.accountId ?? pin.account_id;
  const unavailable = (reason: string): ResolvePinnedUnavailable => {
    const decision: ResolvePinnedUnavailable = {
      ok: false,
      error: 'PINNED_UNAVAILABLE',
      requestedModel: req.model,
      accountId: pinnedId,
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
      `pinned account unavailable: ${pinnedId} is in an error state (${snap.error})`,
    );
  }

  for (let i = 0; i < chain.length; i++) {
    const candidateModel = chain[i];
    const provider = providerForModel(candidateModel);
    if (!provider || snap.provider !== provider) continue;
    const authority = routingAuthority(snap, candidateModel);
    if (!authority.eligible) {
      return unavailable(`pinned account unavailable: ${pinnedId} ${unavailableReason(candidateModel)} (${authority.reason})`);
    }
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
    `pinned account unavailable: ${pinnedId} has no remaining headroom for ${req.model}`,
  );
}

/**
 * Selection over already-fetched snapshots, then fallback walk.
 * Pin overrides (if any) are applied before any strategy.
 * Does not touch the network. Persists a decisions row when `store` is provided
 * unless `persist` is false (dry-run / `qlb why`).
 */
export function resolveFromSnapshots(req: ResolveRequest): ResolveDecision {
  const fallback = req.fallback ?? [];
  const chain = [req.model, ...fallback];
  const strategy: Strategy = req.strategy ?? 'headroom';

  const pinned = resolvePinned(req, chain);
  if (pinned) return pinned;

  const { reserved, drainFirst } = activeOverrideSets(req.store);
  let authorityCandidates: Array<{ snapshot: AccountSnapshot; model: string }> = [];
  let blockingPool: { provider: string; model: string } | null = null;

  for (let i = 0; i < chain.length; i++) {
    const candidateModel = chain[i];
    const provider = providerForModel(candidateModel);
    if (!provider) continue;
    const candidates = req.snapshots.filter(
      (s) =>
        s.provider === provider &&
        !reserved.has(s.accountId) &&
        (req.store == null ||
          s.provider !== 'openai-codex' ||
          req.store.getAccount(s.accountId)?.provider === 'openai-codex'),
    );
    const eligible = candidates.filter((snapshot) => routingAuthority(snapshot, candidateModel).eligible);
    if (blockingPool === null && eligible.length !== candidates.length) {
      blockingPool = { provider, model: candidateModel };
    }
    authorityCandidates = authorityCandidates.concat(eligible.map((snapshot) => ({ snapshot, model: candidateModel })));
    const picked = pickAccount(strategy, {
      snapshots: eligible,
      model: candidateModel,
      session: req.session,
      store: req.store,
      drainFirstIds: drainFirst,
      aliasSnapshots: candidates,
      persist: req.persist,
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

  if (authorityCandidates.length === 0 || blockingPool !== null) {
    const unavailable: ResolveUnavailable = {
      ok: false,
      error: 'UNAVAILABLE',
      requestedModel: req.model,
      reason: blockingPool === null
        ? unavailableReason(req.model)
        : `${unavailableReason(blockingPool.model)} (${blockingPool.provider} ${blockingPool.model} pool requires a fresh provider reading)`,
      candidates: req.snapshots,
    };
    unavailable.decisionId = record(req.store, req, unavailable);
    return unavailable;
  }

  const exhausted: ResolveExhausted = {
    ok: false,
    error: 'EXHAUSTED',
    requestedModel: req.model,
    earliestReset: findEarliestResetForModels(authorityCandidates),
    candidates: req.snapshots,
  };
  exhausted.decisionId = record(req.store, req, exhausted);
  return exhausted;
}

export { providerForModel };
