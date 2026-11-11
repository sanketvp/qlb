import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assessAnthropicForwardAdmission,
  PROOF_FRESH_MS,
  type ForwardAdmissionEvidence,
} from '../src/anthropic-forward-admission';

const CYCLE = 'cycle-1';
const DIGEST = 'abcd';
const PROVED_AT = 1_000;

function evidence(overrides: Partial<ForwardAdmissionEvidence> = {}): ForwardAdmissionEvidence {
  return {
    canonicalOwnerEntry: false,
    postOwnerCycle: null,
    binding: {
      cycle: CYCLE,
      memberCount: 1,
      aliases: ['member-0001'],
      identityKinds: ['accountUuid'],
      commitmentDigest: DIGEST,
    },
    storedWitness: { version: 1, algorithm: 'sha256', digest: DIGEST },
    recomputedWitnessDigest: DIGEST,
    recomputedCommitmentDigest: DIGEST,
    sourcePresent: true,
    identityProof: {
      version: 1,
      cycle: CYCLE,
      provedAt: PROVED_AT,
      memberCount: 1,
      aliases: ['member-0001'],
      members: [{
        alias: 'member-0001',
        identityKind: 'accountUuid',
        hasProviderUuid: true,
        buckets: { '5h': 1, '7d': 2 },
      }],
    },
    identityMismatch: false,
    now: PROVED_AT + PROOF_FRESH_MS,
    ...overrides,
  };
}

describe('assessAnthropicForwardAdmission', () => {
  it('admits a fresh pre-owner cycle at 300000 ms and refuses at 300001 ms', () => {
    assert.equal(
      assessAnthropicForwardAdmission(evidence(), 'pre-owner'),
      'ADMIT_PRE_OWNER',
    );
    assert.equal(
      assessAnthropicForwardAdmission(evidence({ now: PROVED_AT + PROOF_FRESH_MS + 1 }), 'pre-owner'),
      'proof-stale',
    );
  });

  it('does not treat a publication marker or a bare v2 owner as admission', () => {
    const unwitnessed = evidence({
      storedWitness: undefined,
      canonicalOwnerEntry: true,
      postOwnerCycle: CYCLE,
    });
    assert.equal(assessAnthropicForwardAdmission(unwitnessed, 'pre-owner'), 'source-witness-unavailable');
    assert.equal(assessAnthropicForwardAdmission(unwitnessed, 'post-owner-recovery'), 'source-witness-unavailable');
    assert.equal(assessAnthropicForwardAdmission(unwitnessed, 'receipt'), 'source-witness-unavailable');
    const markerOnly = evidence({ postOwnerCycle: CYCLE, canonicalOwnerEntry: false });
    assert.equal(assessAnthropicForwardAdmission(markerOnly, 'pre-owner'), 'ADMIT_PRE_OWNER');
    assert.notEqual(assessAnthropicForwardAdmission(markerOnly, 'receipt'), 'PUBLISHED');
  });

  it('admits post-owner recovery only when the witness, proof, and age still match', () => {
    const owner = evidence({ canonicalOwnerEntry: true });
    assert.equal(assessAnthropicForwardAdmission(owner, 'post-owner-recovery'), 'ADMIT_POST_OWNER_RECOVERY');
    assert.equal(
      assessAnthropicForwardAdmission(
        evidence({ canonicalOwnerEntry: true, now: PROVED_AT + PROOF_FRESH_MS + 1 }),
        'post-owner-recovery',
      ),
      'proof-stale',
    );
    assert.equal(
      assessAnthropicForwardAdmission(
        evidence({ canonicalOwnerEntry: true, recomputedWitnessDigest: 'other' }),
        'post-owner-recovery',
      ),
      'source-witness-unavailable',
    );
  });

  it('publishes a commit receipt only after the private marker matches the owner entry', () => {
    const marked = evidence({
      canonicalOwnerEntry: true,
      postOwnerCycle: CYCLE,
      now: PROVED_AT + PROOF_FRESH_MS + 1,
      sourcePresent: false,
      recomputedWitnessDigest: null,
      recomputedCommitmentDigest: null,
    });
    assert.equal(assessAnthropicForwardAdmission(marked, 'receipt'), 'PUBLISHED');
    assert.equal(
      assessAnthropicForwardAdmission(evidence({ canonicalOwnerEntry: true, postOwnerCycle: null }), 'receipt'),
      'proof-unavailable',
    );
  });

  it('refuses a Slice 2 proof that has no witness, and a witness that has no proof', () => {
    assert.equal(
      assessAnthropicForwardAdmission(evidence({ storedWitness: null }), 'pre-owner'),
      'source-witness-unavailable',
    );
    assert.equal(
      assessAnthropicForwardAdmission(evidence({ identityProof: null }), 'pre-owner'),
      'proof-unavailable',
    );
    assert.equal(
      assessAnthropicForwardAdmission(evidence({ identityProof: null, identityMismatch: true }), 'receipt'),
      'identity-mismatch',
    );
  });
});
