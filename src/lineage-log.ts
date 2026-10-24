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

  // L41 is hard only when the oracle says this is our Claude account and its
  // login expiry advanced. claude-swap has no external-login rule; its
  // oauth.py:73-92 defines the login-expiry field that A3d verifies.
  if (input.provider === 'anthropic' && input.oracleOwnAccount && input.loginExpiryMoved) return 'hard';
  if (input.provider === 'openai-codex' && input.authTimeChanged) return 'hard';

  // S65: a holder at either surrounding observation attributes the transition.
  // In its absence, an oracle-owned Claude rotation is also attributable.
  const holderAlive = input.holderObservation?.aliveBefore === true
    || input.holderObservation?.aliveAfter === true;
  if (input.oracleOwnAccount || holderAlive) return 'none';
  return 'soft';
}

/** Append a transition through Store so its evidence is redacted before persistence. */
export function recordTransition(store: Store, transition: LineageTransition): number {
  return store.recordLineage(transition);
}

/**
 * Prove a strict successor relation from persisted S46 edges. Equality is not
 * a successor; callers that admit equality must test it explicitly (S40).
 */
export function isSuccessor(
  store: Store,
  provider: string,
  accountId: string,
  ancestor: string,
  descendant: string,
): boolean {
  if (!ancestor || !descendant || ancestor === descendant) return false;

  // S46 permits exactly one implicit edge: the current slot's :prev value.
  const slot = store.getSlotLineage(provider, accountId);
  if (slot?.fingerprint === descendant && slot.prev_fingerprint === ancestor) return true;

  const edges = new Map<string, string[]>();
  for (const row of store.listLineageTransitions(provider, accountId)) {
    if (!row.from_fp || row.from_fp === row.to_fp) continue;
    const targets = edges.get(row.from_fp);
    if (targets) targets.push(row.to_fp);
    else edges.set(row.from_fp, [row.to_fp]);
  }

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
