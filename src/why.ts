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

export interface WhyReport {
  model: string;
  accountId: string | null;
  strategy: Strategy | 'pin';
  score: number | null;
  mode?: string;
  error: 'EXHAUSTED' | 'PINNED_UNAVAILABLE' | null;
  reason: string | null;
  losers: WhyLoser[];
}

export interface WhyRequest {
  model: string;
  fallback?: string[];
  session?: string | null;
  strategy?: Strategy;
  snapshots: AccountSnapshot[];
  store?: Store;
}

const DEFAULT_WHY_MODEL = 'claude-sonnet-5';

/** Pick a model that matches the stored pool when the CLI omits `--model`. */
export function defaultWhyModel(snapshots: AccountSnapshot[]): string {
  switch (snapshots[0]?.provider) {
    case 'openai-codex':
      return 'gpt-5.4';
    case 'xai':
      return 'grok-3';
    case 'kimi-coding':
      return 'kimi-k2';
    case 'openrouter':
      return 'openrouter/auto';
    default:
      return DEFAULT_WHY_MODEL;
  }
}

function reservedIds(store: Store | undefined): Set<string> {
  const reserved = new Set<string>();
  if (!store) return reserved;
  for (const row of store.listActiveOverrides()) {
    if (row.kind === 'reserve') reserved.add(row.account_id);
  }
  return reserved;
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
    pinnedTo: string | null;
  },
): WhyLoser {
  if (ctx.pinnedTo && snap.accountId !== ctx.pinnedTo) {
    return {
      accountId: snap.accountId,
      reason: 'pinned',
      detail: `session pinned to ${ctx.pinnedTo}`,
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
  const score = scoreAccount(snap, ctx.model, ctx.ceiling);
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
 * Explain the account `resolveFromSnapshots` would pick from already-stored
 * snapshots. Read-only: does not persist a decision, advance rotation, or
 * probe the network.
 */
export function explainWhy(req: WhyRequest): WhyReport {
  const strategy: Strategy = req.strategy ?? 'headroom';
  const fallback = req.fallback ?? [];

  const decision: ResolveDecision = resolveFromSnapshots({
    model: req.model,
    fallback,
    session: req.session,
    strategy,
    snapshots: req.snapshots,
    store: req.store,
    persist: false,
  });

  const reserved = reservedIds(req.store);
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
        pinnedTo,
      }),
    );

  return {
    model: req.model,
    accountId: winnerId,
    strategy: reportStrategy,
    score: winnerScore,
    mode: decision.ok ? decision.mode : undefined,
    error,
    reason,
    losers,
  };
}

export function formatWhyHuman(report: WhyReport): string {
  const lines: string[] = [];
  if (report.error) lines.push(report.error);
  lines.push(`account:   ${report.accountId ?? '(none)'}`);
  lines.push(`strategy:  ${report.strategy}`);
  if (report.score != null) lines.push(`score:     ${report.score}`);
  lines.push(`model:     ${report.model}`);
  if (report.reason) lines.push(`reason:    ${report.reason}`);
  for (const loser of report.losers) {
    lines.push(`  ${loser.accountId}  ${loser.reason}  ${loser.detail}`);
  }
  return lines.join('\n');
}
