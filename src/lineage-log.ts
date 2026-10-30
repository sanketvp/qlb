// S46/S65 lineage provenance. This module is new; no claude-swap v0.28.0
// counterpart decides graph order or external-login evidence classification.

import type { Store } from './store';

/** Evidence allowed on an immutable lineage transition (S65). */
export type LineageEvidence =
  | 'post'
  | 'oracle'
  | 'lineage'
  | 'holder'
  | 'auth-time'
  | 'identity'
  | 'import'
  | 'undo';

export interface LineageTransition {
  ts?: number;
  provider: string;
  accountId: string;
  fromFp?: string | null;
  toFp: string;
  cause: string;
  by: string;
  evidence?: LineageEvidence | null;
}

export type ExternalLoginClassification = 'hard' | 'soft' | 'none';

/**
 * Caller-injected liveness at the observations on either side of a transition.
 * This module never scans processes: its caller owns the holder observation.
 */
export interface HolderObservation {
  aliveBefore: boolean;
  aliveAfter: boolean;
}

/** The facts observed around a lineage change (S65). */
export interface ExternalLoginInput {
  provider: string;
  successor: boolean;
  qlbPost?: boolean;
  /** Oracle established that the observed Claude credential is the managed account. */
  oracleOwnAccount?: boolean;
  /** L41 login-expiry evidence is only usable when the caller has verified it; default false/undefined means no hard Claude evidence. */
  l41Verified?: boolean;
  /** L40 auth_time evidence is only usable when the caller has verified it; default false/undefined means no hard Codex evidence. */
  l40Verified?: boolean;
  /** Injected process-holder facts from the observations surrounding the change. */
  holderObservation?: HolderObservation;
  loginExpiryMoved?: boolean;
  authTimeChanged?: boolean;
}

/**
 * S65 classification only. Persistence of a resulting relogin event belongs
 * to the relogin writer; this function deliberately never handles credentials.
 */
export function externalLoginCheck(input: ExternalLoginInput): ExternalLoginClassification {
  if (input.successor || input.qlbPost) return 'none';

  // S65: a holder at either surrounding observation attributes the transition.
  const holderAlive = input.holderObservation?.aliveBefore === true
    || input.holderObservation?.aliveAfter === true;
  if (holderAlive) return 'none';

  // L41 is hard only when the oracle says this is our Claude account, the
  // caller verified L41, and its login expiry advanced. claude-swap has no
  // external-login rule; its oauth.py:73-92 defines the login-expiry field
  // that A3d verifies.
  if (input.provider === 'anthropic'
    && input.oracleOwnAccount
    && input.l41Verified === true
    && input.loginExpiryMoved) return 'hard';
  if (input.provider === 'openai-codex' && input.l40Verified === true && input.authTimeChanged) return 'hard';

  return 'soft';
}

/** Append a transition through Store so its evidence is redacted before persistence. */
export function recordTransition(store: Store, transition: LineageTransition): number {
  return store.recordLineage(transition);
}

/**
 * Prove a strict successor relation from persisted S46 edges plus the current
 * slot's implicit :prev edge. Equality is not a successor; callers that admit
 * equality must test it explicitly (S40).
 */
export function isSuccessor(
  store: Pick<Store, 'listLineageTransitions' | 'getSlotLineage'>,
  provider: string,
  accountId: string,
  ancestor: string,
  descendant: string,
): boolean {
  if (!ancestor || !descendant || ancestor === descendant) return false;

  const edges = new Map<string, string[]>();
  const addEdge = (from: string | null, to: string | null): void => {
    if (!from || !to || from === to) return;
    const targets = edges.get(from);
    if (targets) targets.push(to);
    else edges.set(from, [to]);
  };
  for (const row of store.listLineageTransitions(provider, accountId)) {
    addEdge(row.from_fp, row.to_fp);
  }

  // S46 permits exactly one implicit edge: the current slot's :prev value.
  // It participates in traversal so persisted and current-slot edges compose.
  const slot = store.getSlotLineage(provider, accountId);
  addEdge(slot?.prev_fingerprint ?? null, slot?.fingerprint ?? null);

  const pending = [ancestor];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of edges.get(current) ?? []) {
      if (next === descendant) return true;
      if (!visited.has(next)) pending.push(next);
    }
  }
  return false;
}

/** Store-bound lineage service used by future slot, resync, and import slices. */
export class LineageLog {
  constructor(private readonly store: Store) {}

  recordTransition(transition: LineageTransition): number {
    return recordTransition(this.store, transition);
  }

  isSuccessor(provider: string, accountId: string, ancestor: string, descendant: string): boolean {
    return isSuccessor(this.store, provider, accountId, ancestor, descendant);
  }

  externalLoginCheck(input: Omit<ExternalLoginInput, 'successor'> & {
    accountId: string;
    previousFingerprint: string;
    observedFingerprint: string;
  }): ExternalLoginClassification {
    return externalLoginCheck({
      ...input,
      successor: input.previousFingerprint === input.observedFingerprint
        || this.isSuccessor(input.provider, input.accountId, input.previousFingerprint, input.observedFingerprint),
    });
  }
}
