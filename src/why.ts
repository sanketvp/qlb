import type { ObservationSummary } from './candidates';
import {
  resolveFromSnapshots,
  providerForModel,
  type ResolveDecision,
} from './resolve';
import { ALL_IN_CEILING, scoreAccount, type Strategy } from './scoring';
import { isFullyExhausted } from './strategies';
import type { Store } from './store';
import type { AccountSnapshot } from './types';

export type WhyLoserReason = 'headroom' | 'pinned' | 'unavailable';

export interface WhyLoser {
  accountId: string;
  reason: WhyLoserReason;
  detail: string;
}

export type WhyModelSource = 'flag' | 'last routing decision' | 'default';

export interface WhyReport {
  model: string;
  modelSource: WhyModelSource;
  accountId: string | null;
  strategy: Strategy | 'pin';
  score: number | null;
  mode?: string;
  error: 'EXHAUSTED' | 'PINNED_UNAVAILABLE' | null;
  reason: string | null;
  losers: WhyLoser[];
  observations: ObservationSummary[];
  hint: string;
}

export interface WhyRequest {
  model: string;
  modelSource?: WhyModelSource;
  fallback?: string[];
  session?: string | null;
  strategy?: Strategy;
  snapshots: AccountSnapshot[];
  store?: Store;
  observations?: ObservationSummary[];
}

export const DEFAULT_WHY_MODEL = 'claude-sonnet-5';

export const WHY_REFRESH_HINT = 'run qlb refresh --allow-probe to update';

function reservedAndDrainFirst(store: Store | undefined): {
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

function pinnedAccountId(decision: ResolveDecision): string | null {
  if (decision.ok && decision.strategy === 'pin') return decision.accountId;
  if (!decision.ok && decision.error === 'PINNED_UNAVAILABLE') return decision.accountId;
  return null;
}

function describeLoser(
  snap: AccountSnapshot,
  ctx: {
    model: string;
    winnerScore: number | null;
    ceiling: number;
    reserved: Set<string>;
    drainFirst: Set<string>;
    pinnedTo: string | null;
    winnerId: string | null;
    strategy: Strategy | 'pin';
  },
): WhyLoser {
  if (ctx.pinnedTo && snap.accountId !== ctx.pinnedTo) {
    return {
      accountId: snap.accountId,
      reason: 'pinned',
      detail: `session pinned to ${ctx.pinnedTo}`,
    };
  }
  if (snap.error === 'observation: unavailable') {
    return {
      accountId: snap.accountId,
      reason: 'unavailable',
      detail: 'observation: unavailable',
    };
  }
  if (snap.error) {
    return {
      accountId: snap.accountId,
      reason: 'unavailable',
      detail: `error: ${snap.error}`,
    };
  }
  if (ctx.reserved.has(snap.accountId)) {
    return {
      accountId: snap.accountId,
      reason: 'unavailable',
      detail: 'reserved',
    };
  }
  const provider = providerForModel(ctx.model);
  if (provider && snap.provider !== provider) {
    return {
      accountId: snap.accountId,
      reason: 'unavailable',
      detail: `provider ${snap.provider} does not serve ${ctx.model}`,
    };
  }
  if (isFullyExhausted(snap, ctx.model)) {
    return {
      accountId: snap.accountId,
      reason: 'unavailable',
      detail: 'exhausted',
    };
  }
  if (ctx.winnerId && ctx.drainFirst.has(ctx.winnerId)) {
    return {
      accountId: snap.accountId,
      reason: 'headroom',
      detail: `drain-first prefers ${ctx.winnerId}`,
    };
  }
  const score = scoreAccount(snap, ctx.model, ctx.ceiling);
  if (
    ctx.strategy !== 'headroom' &&
    ctx.strategy !== 'pin' &&
    ctx.winnerScore != null &&
    score >= ctx.winnerScore
  ) {
    return {
      accountId: snap.accountId,
      reason: 'headroom',
      detail: `not selected by ${ctx.strategy}`,
    };
  }
  if (ctx.winnerScore != null && score < ctx.winnerScore) {
    return {
      accountId: snap.accountId,
      reason: 'headroom',
      detail: `score ${score} < ${ctx.winnerScore}`,
    };
  }
  return {
    accountId: snap.accountId,
    reason: 'headroom',
    detail: ctx.winnerScore != null ? `score ${score} (not selected)` : `score ${score}`,
  };
}

/**
 * Explain the account `resolveFromSnapshots` would pick from the latest
 * persisted observation (never probes). Read-only: does not persist a
 * decision, advance rotation, or touch the network.
 */
export function explainWhy(req: WhyRequest): WhyReport {
  const strategy: Strategy = req.strategy ?? 'headroom';
  const fallback = req.fallback ?? [];
  const modelSource: WhyModelSource = req.modelSource ?? 'flag';

  const decision: ResolveDecision = resolveFromSnapshots({
    model: req.model,
    fallback,
    session: req.session,
    strategy,
    snapshots: req.snapshots,
    store: req.store,
    persist: false,
  });

  const { reserved, drainFirst } = reservedAndDrainFirst(req.store);
  const pinnedTo = pinnedAccountId(decision);
  const winnerId = decision.ok
    ? decision.accountId
    : decision.error === 'PINNED_UNAVAILABLE'
      ? decision.accountId
      : null;
  const winnerScore = decision.ok ? decision.score : null;
  const ceiling = decision.ok ? decision.ceiling : ALL_IN_CEILING;
  const servedModel = decision.ok ? decision.servedModel : req.model;
  const reportStrategy = decision.ok ? decision.strategy : pinnedTo ? 'pin' : strategy;
  const error = decision.ok
    ? null
    : decision.error === 'PINNED_UNAVAILABLE'
      ? 'PINNED_UNAVAILABLE'
      : 'EXHAUSTED';
  const reason = decision.ok
    ? decision.reason
    : decision.error === 'PINNED_UNAVAILABLE'
      ? decision.reason
      : 'EXHAUSTED';

  const losers = req.snapshots
    .filter((s) => s.accountId !== winnerId)
    .map((s) =>
      describeLoser(s, {
        model: servedModel,
        winnerScore,
        ceiling,
        reserved,
        drainFirst,
        pinnedTo,
        winnerId,
        strategy: reportStrategy,
      }),
    );

  return {
    model: req.model,
    modelSource,
    accountId: winnerId,
    strategy: reportStrategy,
    score: winnerScore,
    mode: decision.ok ? decision.mode : undefined,
    error,
    reason,
    losers,
    observations: req.observations ?? [],
    hint: WHY_REFRESH_HINT,
  };
}

function failedObservationLine(obs: ObservationSummary): string {
  const ts = obs.at ?? '?';
  const gen = obs.generation ?? '?';
  const error = obs.error ?? 'unknown error';
  return `last observation FAILED at ${ts} (gen ${gen}): ${error}`;
}

function unavailableObservationLine(obs: ObservationSummary): string {
  const ts = obs.at ?? '?';
  const source = obs.source ?? '?';
  const gen = obs.generation ?? '?';
  return `${ts} via ${source} gen ${gen} (unavailable)`;
}

function formatObserved(observations: ObservationSummary[]): string[] {
  if (observations.length === 0) {
    return ['observed:  never probed — store snapshots only'];
  }
  if (observations.length === 1) {
    const obs = observations[0];
    if (obs.status === 'store-fallback' || (!obs.at && obs.status !== 'failed' && obs.status !== 'unavailable')) {
      return ['observed:  never probed — store snapshots only'];
    }
    if (obs.status === 'failed') {
      return [`observed:  ${failedObservationLine(obs)}`];
    }
    if (obs.status === 'unavailable') {
      return [`observed:  ${unavailableObservationLine(obs)}`];
    }
    const gen = obs.generation != null ? ` gen ${obs.generation}` : '';
    return [`observed:  ${obs.at} via ${obs.source ?? '?'}${gen}`];
  }
  const lines = ['observed:'];
  for (const obs of observations) {
    if (obs.status === 'failed') {
      lines.push(`  ${obs.provider}  ${failedObservationLine(obs)}`);
    } else if (obs.status === 'unavailable') {
      lines.push(`  ${obs.provider}  ${unavailableObservationLine(obs)}`);
    } else if (obs.status === 'store-fallback' || !obs.at) {
      lines.push(`  ${obs.provider}  never probed — store snapshots only`);
    } else {
      const gen = obs.generation != null ? ` gen ${obs.generation}` : '';
      lines.push(`  ${obs.provider}  ${obs.at} via ${obs.source ?? '?'}${gen}`);
    }
  }
  return lines;
}

export function formatWhyHuman(report: WhyReport): string {
  const lines: string[] = [];
  if (report.error) lines.push(report.error);
  lines.push(`account:   ${report.accountId ?? '(none)'}`);
  lines.push(`strategy:  ${report.strategy}`);
  if (report.score != null) lines.push(`score:     ${report.score}`);
  if (report.modelSource === 'last routing decision') {
    lines.push(`model:     ${report.model} (from last routing decision)`);
  } else if (report.modelSource === 'default') {
    lines.push(`model:     ${report.model} (default)`);
  } else {
    lines.push(`model:     ${report.model}`);
  }
  if (report.reason) lines.push(`reason:    ${report.reason}`);
  lines.push(...formatObserved(report.observations));
  lines.push(`hint:      ${report.hint}`);
  for (const loser of report.losers) {
    lines.push(`  ${loser.accountId}  ${loser.reason}  ${loser.detail}`);
  }
  return lines.join('\n');
}
