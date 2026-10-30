import type { CodexAuthStableWithStatResult } from './codex-auth';
import type { CswapProcess } from './cswap-processes';
import type { Store } from './store';

const PROVIDER = 'openai-codex';

export type CodexSwitchPreflightResult =
  | { kind: 'go' }
  | { kind: 'refused'; reason: 'codex-logged-out' | 'codex-auth-unreadable'; write: false };

export type CodexSwitchPreconditionReason =
  | 'cswap-process-alive'
  | 'cswap-process-check-failed'
  | 'target-missing'
  | 'target-dead'
  | 'target-pending-adopt'
  | 'codex-l13-unverified';

export type CodexSwitchPreconditionsResult =
  | { kind: 'go' }
  | { kind: 'refused'; reason: CodexSwitchPreconditionReason };

/** All external effects are injected; the production caller binds readLive to auth.json. */
export interface CodexSwitchDeps {
  store: Pick<Store, 'getCodexActiveLogin' | 'getCodexSlot' | 'getConfig' | 'recordSwitch'>;
  readLive: () => Promise<CodexAuthStableWithStatResult>;
  cswapProcesses: () => CswapProcess[];
  now: () => number;
  attempt: string;
}

/**
 * Q3's read-only gate. Missing or unreadable live state is deliberately not
 * recorded: no switch request has reached a write-eligible phase yet.
 */
export async function preflightCodexLive(deps: Pick<CodexSwitchDeps, 'readLive'>): Promise<CodexSwitchPreflightResult> {
  const live = await deps.readLive();
  if (live.status === 'missing') return { kind: 'refused', reason: 'codex-logged-out', write: false };
  if (live.status === 'unreadable') return { kind: 'refused', reason: 'codex-auth-unreadable', write: false };
  return { kind: 'go' };
}

/** Write the sole phase-U refusal row, preserving its attempt provenance. */
export function recordCodexSwitchRefusal(
  deps: Pick<CodexSwitchDeps, 'store' | 'now' | 'attempt'>,
  input: { from: string | null; target: string; trigger: string; reason: CodexSwitchPreconditionReason },
): number {
  return deps.store.recordSwitch({
    ts: deps.now(),
    provider: PROVIDER,
    fromAccount: input.from,
    toAccount: input.target,
    trigger: input.trigger,
    outcome: 'refused',
    detail: input.reason,
    stepsJson: JSON.stringify({ attempt: deps.attempt, via: 'switch' }),
    publishedAt: null,
  });
}

/**
 * Phase-U switch eligibility. Admission belongs to the caller, so this only
 * applies S24, target state, and the S15 receipt in their mandated order.
 */
export function checkCodexSwitchPreconditions(
  deps: CodexSwitchDeps,
  input: { target: string; trigger: string },
): CodexSwitchPreconditionsResult {
  const refuse = (reason: CodexSwitchPreconditionReason): CodexSwitchPreconditionsResult => {
    recordCodexSwitchRefusal(deps, {
      from: deps.store.getCodexActiveLogin(), target: input.target, trigger: input.trigger, reason,
    });
    return { kind: 'refused', reason };
  };

  let cswapAlive: boolean;
  try {
    cswapAlive = deps.cswapProcesses().length > 0;
  } catch {
    // S24 treats CswapProcessCheckError and every other inspection failure alike.
    return refuse('cswap-process-check-failed');
  }
  if (cswapAlive) return refuse('cswap-process-alive');

  const target = deps.store.getCodexSlot(input.target);
  if (target === null) return refuse('target-missing');
  if (target.dead) return refuse('target-dead');
  if (target.pendingAdopt) return refuse('target-pending-adopt');
  if (input.trigger !== 'manual' && deps.store.getConfig('codex.l13VerifiedAt') === null) {
    return refuse('codex-l13-unverified');
  }
  return { kind: 'go' };
}
