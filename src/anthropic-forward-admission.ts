import type { AnthropicIdentityKind } from './anthropic-complete-set';
import { identityProofBuckets, type ProofBindingView } from './anthropic-rehearsal-proof';

/** Admit at this age. The next millisecond is `proof-stale`. */
export const PROOF_FRESH_MS = 300_000;

export type ForwardAdmissionMode = 'pre-owner' | 'post-owner-recovery' | 'receipt';

export type ForwardAdmissionDecision =
  | 'ADMIT_PRE_OWNER'
  | 'ADMIT_POST_OWNER_RECOVERY'
  | 'PUBLISHED'
  | 'source-witness-unavailable'
  | 'proof-unavailable'
  | 'proof-stale'
  | 'identity-mismatch'
  | 'adoption-mismatch';

export interface ForwardBindingEvidence {
  cycle: string;
  memberCount: number;
  aliases: readonly string[];
  identityKinds: readonly AnthropicIdentityKind[];
  commitmentDigest: string;
}

/**
 * Plain facts collected by a reader. This function does not read files, take
 * locks, or treat `poolV2PublicationStarted` as evidence: that field is not
 * part of the input.
 *
 * Freshness is required before the private post-owner marker exists, including
 * post-owner recovery. A matching marker is the commit receipt's success
 * condition and is not revoked by a later clock reading.
 */
export interface ForwardAdmissionEvidence {
  canonicalOwnerEntry: boolean;
  postOwnerCycle: string | null;
  binding: ForwardBindingEvidence | null;
  storedWitness: unknown;
  /** Null when the source pool could not be re-read into a witness digest. */
  recomputedWitnessDigest: string | null;
  recomputedCommitmentDigest: string | null;
  /** False when the source pool file is absent. A present but invalid pool is true. */
  sourcePresent: boolean;
  identityProof: unknown;
  identityMismatch: boolean;
  /** Pre-commit binding no longer matches the live slots or active login. */
  adoptionMismatch: boolean;
  /** Post-commit `adoption` marker cycle. Null when the marker is absent. */
  adoptionMarkerCycle: string | null;
  now: number;
}

const WITNESS_KEYS = ['version', 'algorithm', 'digest'];
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function witnessDigest(value: unknown): string | null {
  if (!isRecord(value) || !sameKeys(value, WITNESS_KEYS)) return null;
  if (value.version !== 1 || value.algorithm !== 'sha256') return null;
  if (typeof value.digest !== 'string' || !BASE64URL.test(value.digest)) return null;
  return value.digest;
}

function provedAt(proof: unknown): number | null {
  if (!isRecord(proof) || typeof proof.provedAt !== 'number' || !Number.isSafeInteger(proof.provedAt) || proof.provedAt < 0) {
    return null;
  }
  return proof.provedAt;
}

function bindingView(binding: ForwardBindingEvidence): ProofBindingView {
  return {
    cycle: binding.cycle,
    memberCount: binding.memberCount,
    aliases: binding.aliases,
    identityKinds: binding.identityKinds,
  };
}

export function assessAnthropicForwardAdmission(
  evidence: ForwardAdmissionEvidence,
  _mode: ForwardAdmissionMode,
): ForwardAdmissionDecision {
  const binding = evidence.binding;
  const stored = witnessDigest(evidence.storedWitness);
  if (binding === null || stored === null) return 'source-witness-unavailable';
  const marked = evidence.canonicalOwnerEntry && evidence.postOwnerCycle === binding.cycle;
  if (!evidence.sourcePresent) {
    if (!marked) return 'source-witness-unavailable';
    if (identityProofBuckets(evidence.identityProof, bindingView(binding)) === null) {
      return evidence.identityMismatch ? 'identity-mismatch' : 'proof-unavailable';
    }
    if (evidence.adoptionMarkerCycle !== binding.cycle) return 'adoption-mismatch';
    return 'PUBLISHED';
  }
  if (
    evidence.recomputedWitnessDigest !== stored
    || evidence.recomputedCommitmentDigest !== binding.commitmentDigest
  ) {
    return 'source-witness-unavailable';
  }
  if (identityProofBuckets(evidence.identityProof, bindingView(binding)) === null) {
    return evidence.identityMismatch ? 'identity-mismatch' : 'proof-unavailable';
  }
  if (marked) return evidence.adoptionMarkerCycle === binding.cycle ? 'PUBLISHED' : 'adoption-mismatch';
  const stamped = provedAt(evidence.identityProof);
  if (
    stamped === null
    || !Number.isSafeInteger(evidence.now)
    || evidence.now < 0
    || evidence.now - stamped < 0
    || evidence.now - stamped > PROOF_FRESH_MS
  ) {
    return 'proof-stale';
  }
  if (evidence.adoptionMismatch) return 'adoption-mismatch';
  if (_mode === 'receipt') return 'proof-unavailable';
  return evidence.canonicalOwnerEntry ? 'ADMIT_POST_OWNER_RECOVERY' : 'ADMIT_PRE_OWNER';
}

export function isForwardRefusal(decision: ForwardAdmissionDecision): boolean {
  return decision !== 'ADMIT_PRE_OWNER'
    && decision !== 'ADMIT_POST_OWNER_RECOVERY'
    && decision !== 'PUBLISHED';
}
