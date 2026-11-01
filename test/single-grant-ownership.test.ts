import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifySingleGrant,
  genericHoldsSharedItem,
  isSingleGrantAtRest,
  resolveSingleGrantKeychain,
  sharedSingleGrantCoords,
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
    hasV2OwnerEntry: false,
    hasLegacySidecar: false,
    hasCustomOwnerFile: false,
    commitGeneration: null,
    hasStaging: false,
    ...overrides,
  };
}

const providers = ['xai', 'kimi-coding'] as const;

/** The S0.6 owner-file probes, all absent. */
const noProbes = { hasStaging: false, hasLegacySidecar: false, hasCustomOwnerFile: false };

function journalAccount(provider: (typeof providers)[number]): Record<string, unknown> {
  const id = provider === 'xai' ? 'xai-default' : 'kimi-default';
  const label = provider === 'xai' ? 'Grok (xAI)' : 'Kimi K3';
  return { id, provider, label, fingerprint: 'fake-fingerprint' };
}

for (const provider of providers) {
  it(`T-KC1 [${provider}] a journal account resolves to its recorded shared Keychain item, else to the legacy adapter item`, () => {
    const account = journalAccount(provider);
    assert.deepEqual(
      resolveSingleGrantKeychain(provider, {
        ...account,
        keychain: sharedSingleGrantCoords(provider),
      }),
      sharedSingleGrantCoords(provider),
    );
    assert.deepEqual(resolveSingleGrantKeychain(provider, account), {
      service: `qlb:${provider}:${account.id}`,
      account: account.label,
    });
    // As today's keychainCoords: an empty recorded label falls back to the id.
    assert.deepEqual(resolveSingleGrantKeychain(provider, { ...account, label: '' }), {
      service: `qlb:${provider}:${account.id}`,
      account: account.id,
    });
  });

  it(`T-KC2 [${provider}] a recorded Keychain coordinate other than the provider's shared item is refused`, () => {
    const account = journalAccount(provider);
    const otherProvider = provider === 'xai' ? 'kimi-coding' : 'xai';
    const legacy = {
      service: `qlb:${provider}:${account.id}`,
      account: account.label,
    };
    const invalid = [
      { ...account, keychain: legacy },
      { ...account, keychain: sharedSingleGrantCoords(otherProvider) },
      { ...account, keychain: { service: `qlb:${provider}:default`, account: 'xai-default' } },
      { ...account, keychain: { ...sharedSingleGrantCoords(provider), extra: true } },
      { ...account, keychain: { service: `qlb:${provider}:default` } },
      { ...account, keychain: 'qlb:invalid' },
      undefined,
      { ...account, provider: otherProvider },
      { ...account, id: 'mismatched-id' },
      // Today's journal readers refuse a legacy account without a string label.
      { id: account.id, provider: account.provider, fingerprint: account.fingerprint },
      { ...account, label: 42 },
    ];

    for (const value of invalid) {
      assert.throws(() => resolveSingleGrantKeychain(provider, value), /journal-keychain-invalid/);
    }
  });

  it(`T-KC3 [${provider}] the shared item is protected exactly while the generic journal is QLB_OWNED and records it`, () => {
    const account = journalAccount(provider);
    const detail = (value: unknown) => JSON.stringify({ accounts: [value] });
    const shared = { ...account, keychain: sharedSingleGrantCoords(provider) };

    for (const marker of [
      {},
      { intent: 'rollback' },
      { rollbackDecision: {} },
      { handback: { phase: 'cleanup-pending' } },
    ]) {
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state: 'QLB_OWNED',
        detailJson: JSON.stringify({ accounts: [shared], ...marker }),
      }), true);
    }
    assert.equal(genericHoldsSharedItem(provider, {
      ...noProbes,
      state: 'QLB_OWNED',
      detailJson: '{',
    }), true);
    assert.equal(genericHoldsSharedItem(provider, {
      ...noProbes,
      state: 'QLB_OWNED',
      detailJson: detail({ ...account, keychain: { service: 'invalid', account: 'invalid' } }),
    }), true);
    // A single-grant journal records exactly one account; anything else is
    // ambiguous evidence and fails closed (§1).
    for (const accounts of [[], [account, shared], [account, { bogus: true }]]) {
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state: 'QLB_OWNED',
        detailJson: JSON.stringify({ accounts }),
      }), true, `${accounts.length} accounts`);
    }

    assert.equal(genericHoldsSharedItem(provider, {
      ...noProbes,
      state: 'QLB_OWNED',
      detailJson: detail(account),
    }), false);
    assert.equal(genericHoldsSharedItem(provider, {
      ...noProbes,
      state: 'QLB_OWNED',
      detailJson: detail({ ...account, keychain: undefined }),
    }), false);

    for (const state of [null, 'NATIVE', 'VALIDATED']) {
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state,
        detailJson: detail(shared),
      }), false, `${state ?? 'no row'} shared`);
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state,
        detailJson: detail(account),
      }), false, `${state ?? 'no row'} legacy`);
    }
    // With no `migrations[pi-<p>]` row nothing names the shared item, so a
    // stray owner file never holds it (OQ-10).
    for (const probe of ['hasStaging', 'hasLegacySidecar', 'hasCustomOwnerFile'] as const) {
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state: null,
        detailJson: null,
        [probe]: true,
      }), false, `no row with ${probe}`);
    }

    for (const state of ['MIRRORED', 'RETIRED']) {
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state,
        detailJson: detail(account),
      }), false, `${state} without keychain`);
    }
  });

  it(`T-KC3b [${provider}] the shared item is also protected while the generic journal stages it or is retired`, () => {
    const account = journalAccount(provider);
    const shared = { ...account, keychain: sharedSingleGrantCoords(provider) };
    const detail = (value: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ accounts: [value], ...extra });

    for (const fixture of [
      { name: 'MIRRORED', state: 'MIRRORED', facts: {} },
      { name: 'VALIDATED with staging', state: 'VALIDATED', facts: { hasStaging: true } },
      { name: 'VALIDATED with commit generation', state: 'VALIDATED', facts: {}, detail: { commitGeneration: 1 } },
      { name: 'RETIRED', state: 'RETIRED', facts: {} },
      { name: 'legacy sidecar', state: 'VALIDATED', facts: { hasLegacySidecar: true } },
      { name: 'custom owner file', state: 'VALIDATED', facts: { hasCustomOwnerFile: true } },
    ]) {
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state: fixture.state,
        detailJson: detail(shared, fixture.detail),
        ...fixture.facts,
      }), true, fixture.name);
    }

    for (const fixture of [
      { name: 'NATIVE', state: 'NATIVE', facts: {} },
      { name: 'VALIDATED without staging', state: 'VALIDATED', facts: {} },
      // preCommitRollback writes NATIVE without clearing commitGeneration;
      // NATIVE is at rest (plan §OD-9, "NATIVE, or VALIDATED without St").
      {
        name: 'NATIVE after a pre-commit rollback',
        state: 'NATIVE',
        facts: {},
        detail: { commitGeneration: 3, rolledBackFrom: 'pre-commit' },
      },
    ]) {
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state: fixture.state,
        detailJson: detail(shared, fixture.detail),
        ...fixture.facts,
      }), false, fixture.name);
    }

    for (const fixture of [
      { name: 'MIRRORED', state: 'MIRRORED', facts: {} },
      { name: 'VALIDATED with staging', state: 'VALIDATED', facts: { hasStaging: true } },
      { name: 'VALIDATED with commit generation', state: 'VALIDATED', facts: {}, detail: { commitGeneration: 1 } },
      { name: 'RETIRED', state: 'RETIRED', facts: {} },
      { name: 'legacy sidecar', state: 'VALIDATED', facts: { hasLegacySidecar: true } },
      { name: 'custom owner file', state: 'VALIDATED', facts: { hasCustomOwnerFile: true } },
    ]) {
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state: fixture.state,
        detailJson: detail(account, fixture.detail),
        ...fixture.facts,
      }), false, `${fixture.name}: legacy journal`);
    }
  });

  it(`T-KC3c [${provider}] an unreadable retired generic journal protects the shared item`, () => {
    const account = journalAccount(provider);
    const shared = { ...account, keychain: sharedSingleGrantCoords(provider) };
    assert.equal(genericHoldsSharedItem(provider, {
      ...noProbes,
      state: 'RETIRED',
      detailJson: '{',
    }), true);

    // S0.6 (genericMigrationAtRest) calls an unreadable NATIVE/VALIDATED
    // journal not at rest, so it protects the shared item too.
    for (const state of ['NATIVE', 'VALIDATED']) {
      for (const detailJson of ['{', '[]', 'null']) {
        assert.equal(genericHoldsSharedItem(provider, {
          ...noProbes,
          state,
          detailJson,
        }), true, `${state} ${detailJson}`);
      }
    }

    // An ambiguous journal at a generic commit point is not at rest.
    for (const accounts of [[], [shared, account], [{ bogus: true }]]) {
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state: 'VALIDATED',
        detailJson: JSON.stringify({ accounts, commitGeneration: 1 }),
      }), true, `VALIDATED ${accounts.length} accounts with commit generation`);
    }

    // Ambiguous evidence in a state that is at rest is not held.
    for (const state of ['NATIVE', 'VALIDATED']) {
      assert.equal(genericHoldsSharedItem(provider, {
        ...noProbes,
        state,
        detailJson: JSON.stringify({ accounts: [] }),
      }), false, `${state} ambiguous at rest`);
    }
    assert.equal(genericHoldsSharedItem(provider, {
      ...noProbes,
      state: 'NATIVE',
      detailJson: JSON.stringify({ accounts: [], commitGeneration: 3, rolledBackFrom: 'pre-commit' }),
    }), false, 'NATIVE ambiguous after a pre-commit rollback');
  });

  it(`T-KC3d [${provider}] the S0.6 owner-file facts are required`, () => {
    // A compile-time check: the test build fails if the probes become optional.
    const omitsProbes = (): boolean =>
      // @ts-expect-error a caller that omits the owner-file probes must not compile
      genericHoldsSharedItem(provider, { state: 'NATIVE', detailJson: null });
    assert.equal(typeof omitsProbes, 'function');
  });
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
        name: 'C1: ambiguous validated commit evidence fails closed',
        input: facts({
          p7aOwned: true,
          state: 'VALIDATED',
          hasV2OwnerEntry: true,
          commitGeneration: 8,
          hasStaging: true,
        }),
        rule: 'C1',
        route: 'dual-ownership',
      },
      {
        name: 'C1: P7a ownership plus rollback intent fails closed',
        input: facts({ p7aOwned: true, rollbackIntent: true }),
        rule: 'C1',
        route: 'dual-ownership',
      },
      {
        name: 'C1: P7a ownership plus handback fails closed',
        input: facts({ p7aOwned: true, handback }),
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
        name: 'C4: rollback intent routes an in-progress rollback',
        input: facts({ rollbackIntent: true }),
        rule: 'C4',
        route: 'rollback-in-progress',
      },
      {
        name: 'C4: rollback is ahead of a committed journal',
        input: facts({ state: 'QLB_OWNED', rollbackDecision: decision }),
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
        name: 'C5: validated legacy sidecar proves this path committed',
        input: facts({
          state: 'VALIDATED',
          hasLegacySidecar: true,
          hasStaging: true,
        }),
        rule: 'C5',
        route: 'post-commit',
      },
      {
        name: 'C6: owner claim without own journal evidence',
        input: facts({ hasV2OwnerEntry: true }),
        rule: 'C6',
        route: 'owner-file-orphan',
      },
      {
        name: 'C6: custom owner file is an orphan claim during MIRRORED staging',
        input: facts({
          state: 'MIRRORED',
          hasCustomOwnerFile: true,
          hasStaging: true,
        }),
        rule: 'C6',
        route: 'owner-file-orphan',
      },
      {
        name: 'C6: custom owner file is an orphan claim from NATIVE',
        input: facts({ state: 'NATIVE', hasCustomOwnerFile: true }),
        rule: 'C6',
        route: 'owner-file-orphan',
      },
      {
        name: 'C3: handback cleanup is ahead of validated staging',
        input: facts({ state: 'VALIDATED', handback, hasStaging: true }),
        rule: 'C3',
        route: 'handback-cleanup-pending',
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
        name: 'C8: staging without a mirrored journal is pre-commit',
        input: facts({ state: 'NATIVE', hasStaging: true }),
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
    assert.equal(isSingleGrantAtRest(facts({ state: 'VALIDATED', hasV2OwnerEntry: true })), true, 'O is ignored');
    assert.equal(
      isSingleGrantAtRest(facts({ handback: undefined as unknown as HandbackMarker | null })),
      true,
      'absent handback is normalized',
    );
    assert.equal(
      classifySingleGrant(facts({ handback: undefined as unknown as HandbackMarker | null })).rule,
      'C9',
      'absent handback is normalized by the classifier',
    );
    assert.equal(
      isSingleGrantAtRest(facts({ rollbackDecision: undefined as unknown as RollbackDecision | null })),
      true,
      'absent rollback decision is normalized',
    );
    assert.equal(
      classifySingleGrant(facts({ rollbackDecision: undefined as unknown as RollbackDecision | null })).rule,
      'C9',
      'absent rollback decision is normalized by the classifier',
    );
    assert.equal(
      classifySingleGrant(facts({
        state: 'VALIDATED',
        hasV2OwnerEntry: true,
        commitGeneration: undefined as unknown as number | null,
      })).rule,
      'C6',
      'absent commit generation is normalized',
    );

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
