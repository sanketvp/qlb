import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifySingleGrant,
  isSingleGrantAtRest,
  type HandbackMarker,
  type RollbackDecision,
  type SingleGrantOwnershipFacts,
} from '../src/single-grant-ownership';

const decision: RollbackDecision = {
  kind: 'keychain',
  generation: 7,
  fingerprint: 'fake-fingerprint',
  entryPresent: true,
  sourceDigest: 'fake-source-digest',
  kd0: 'fake-keychain-digest',
  decidedAt: 123,
  fencedGeneration: 8,
};

const handback: HandbackMarker = {
  phase: 'cleanup-pending',
  keychainDisposition: 'keep',
  piFingerprint: 'fake-pi-fingerprint',
  decision,
  fencedGeneration: 8,
  rolledBackAt: 456,
};

function facts(overrides: Partial<SingleGrantOwnershipFacts> = {}): SingleGrantOwnershipFacts {
  return {
    p7aOwned: false,
    state: null,
    handback: null,
    rollbackIntent: false,
    rollbackDecision: null,
    hasOwnerClaim: false,
    hasLegacySidecar: false,
    commitGeneration: null,
    hasStaging: false,
    ...overrides,
  };
}

describe('single-grant ownership classifier (T-CL)', () => {
  it('classifies every single-grant ownership fixture', () => {
    const cases: Array<{
      name: string;
      input: SingleGrantOwnershipFacts;
      rule: string;
      route: string;
    }> = [
      {
        name: 'C1: P7a and generic committed evidence are ambiguous and fail closed',
        input: facts({ p7aOwned: true, state: 'QLB_OWNED' }),
        rule: 'C1',
        route: 'dual-ownership',
      },
      {
        name: 'C2: P7a owns without generic evidence',
        input: facts({ p7aOwned: true }),
        rule: 'C2',
        route: 'owned-by-pi-migrate',
      },
      {
        name: 'C3: complete full-shape handback marker',
        input: facts({ handback }),
        rule: 'C3',
        route: 'handback-cleanup-pending',
      },
      {
        name: 'C4: full rollback decision routes an in-progress rollback',
        input: facts({ rollbackDecision: decision }),
        rule: 'C4',
        route: 'rollback-in-progress',
      },
      {
        name: 'C5: generic committed journal',
        input: facts({ state: 'QLB_OWNED' }),
        rule: 'C5',
        route: 'post-commit',
      },
      {
        name: 'C6: owner claim without own journal evidence',
        input: facts({ hasOwnerClaim: true }),
        rule: 'C6',
        route: 'owner-file-orphan',
      },
      {
        name: 'C7: validated staging is resumable',
        input: facts({ state: 'VALIDATED', hasStaging: true }),
        rule: 'C7',
        route: 'validated-staging',
      },
      {
        name: 'C8: mirrored migration is pre-commit',
        input: facts({ state: 'MIRRORED' }),
        rule: 'C8',
        route: 'pre-commit',
      },
      {
        name: 'C9: native state is at rest',
        input: facts({ state: 'NATIVE' }),
        rule: 'C9',
        route: 'at-rest',
      },
    ];

    for (const fixture of cases) {
      const result = classifySingleGrant(fixture.input);
      assert.equal(result.rule, fixture.rule, fixture.name);
      assert.equal(result.route, fixture.route, fixture.name);
    }
  });

  it('recognizes exactly the S0.6 at-rest states', () => {
    assert.equal(isSingleGrantAtRest(facts()), true, 'absent journal');
    assert.equal(isSingleGrantAtRest(facts({ state: 'NATIVE' })), true);
    assert.equal(isSingleGrantAtRest(facts({ state: 'VALIDATED' })), true);
    assert.equal(isSingleGrantAtRest(facts({ state: 'VALIDATED', hasOwnerClaim: true })), true, 'O is ignored');

    for (const [name, input] of [
      ['cleanup marker', facts({ handback })],
      ['rollback intent', facts({ rollbackIntent: true })],
      ['rollback decision', facts({ rollbackDecision: decision })],
      ['legacy sidecar', facts({ hasLegacySidecar: true })],
      ['custom owner file', facts({ hasCustomOwnerFile: true })],
      ['staging', facts({ hasStaging: true })],
      ['mirrored', facts({ state: 'MIRRORED' })],
      ['owned', facts({ state: 'QLB_OWNED' })],
    ] as const) {
      assert.equal(isSingleGrantAtRest(input), false, name);
    }
  });
});
