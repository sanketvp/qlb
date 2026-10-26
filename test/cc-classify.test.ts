// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) —
// tests/test_switcher.py::{TestProvenanceGuard,TestSelfSwitchProvenance,TestUuidConflictClassification,TestDegradedReadProvenance}
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyOutgoingCredential,
  decideSelfSwitchAction,
  mayConsumeCredential,
  prefetchLiveIdentity,
  type ClassifyClaudeSlot,
  type PrefetchedLiveIdentity,
} from '../src/cc-classify';

function credential(tag: string, refresh = tag): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}`, refreshToken: `refresh-${refresh}` } });
}

const accountA: ClassifyClaudeSlot = {
  accountId: 'uuid-a', email: 'a@example.test', orgUuid: 'org-a', credential: credential('a'),
};
const accountB: ClassifyClaudeSlot = {
  accountId: 'uuid-b', email: 'b@example.test', orgUuid: 'org-b', credential: credential('b'),
};

function prefetch(liveCredential: string | null, resolved: PrefetchedLiveIdentity['resolved']): PrefetchedLiveIdentity {
  return { liveCredential, resolved };
}

function classify(
  liveCredential: string,
  provenance: PrefetchedLiveIdentity,
  options: { slots?: readonly ClassifyClaudeSlot[]; probeVerdict?: boolean } = {},
) {
  return classifyOutgoingCredential({
    outgoing: accountA,
    slots: options.slots ?? [accountA, accountB],
    liveCredential,
    provenance,
    probeVerdict: options.probeVerdict,
  });
}

describe('Claude outgoing credential classification (K4 / AC5)', () => {
  it('classifies own bytes', () => {
    assert.deepEqual(classify(accountA.credential!, prefetch(accountA.credential, null)), { kind: 'own-bytes', foreignSlotId: null });
  });

  it('classifies an access-token-only rotation as own family', () => {
    const live = credential('a-rotated-access', 'a');
    assert.deepEqual(classify(live, prefetch(live, null)), { kind: 'own-family', foreignSlotId: null });
  });

  it('classifies an oracle-resolved rotation of the outgoing account', () => {
    const live = credential('a-rotated');
    assert.deepEqual(classify(live, prefetch(live, { uuid: 'uuid-a', email: null, organizationUuid: null })), { kind: 'own-rotated', foreignSlotId: null });
  });

  it('classifies a uuid-positive different managed slot as foreign', () => {
    const live = credential('b-rotated');
    assert.deepEqual(classify(live, prefetch(live, { uuid: 'uuid-b', email: 'b@example.test', organizationUuid: 'org-b' })), { kind: 'foreign', foreignSlotId: 'uuid-b' });
  });

  it('classifies an already-backed-up foreign lineage as foreign synced', () => {
    assert.deepEqual(classify(accountB.credential!, prefetch(accountB.credential, { uuid: 'uuid-b', email: 'b@example.test', organizationUuid: 'org-b' })), { kind: 'foreign-synced', foreignSlotId: 'uuid-b' });
  });

  it('classifies a structurally complete unmanaged identity as alien', () => {
    const live = credential('other');
    assert.deepEqual(classify(live, prefetch(live, { uuid: 'uuid-other', email: 'other@example.test', organizationUuid: 'org-other' })), { kind: 'alien', foreignSlotId: null });
  });

  it('classifies a previously condemned lineage as known foreign when the prefetch is unresolved', () => {
    const live = credential('known-foreign');
    assert.deepEqual(classify(live, prefetch(live, null), { probeVerdict: false }), { kind: 'known-foreign', foreignSlotId: null });
  });

  it('classifies a token-wiped OAuth wrapper before the fail-open path', () => {
    const live = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 1_000 } });
    assert.deepEqual(classify(live, prefetch(live, null)), { kind: 'wiped', foreignSlotId: null });
  });

  it('classifies an unresolved mismatch as the fail-open backup path', () => {
    const live = credential('unresolved');
    assert.deepEqual(classify(live, prefetch(live, null)), { kind: 'unresolved', foreignSlotId: null });
  });

  it('discards a Phase-A profile answer when the live bytes changed before Phase B', () => {
    const phaseALive = credential('phase-a');
    const phaseBLive = credential('phase-b');
    assert.deepEqual(
      classify(phaseBLive, prefetch(phaseALive, { uuid: 'uuid-b', email: 'b@example.test', organizationUuid: 'org-b' })),
      { kind: 'unresolved', foreignSlotId: null },
    );
  });

  it('treats a blank profile email as a partial identity', () => {
    const live = credential('blank-email');
    assert.deepEqual(
      classify(live, prefetch(live, { uuid: 'uuid-nobody', email: '', organizationUuid: 'org-nobody' })),
      { kind: 'unresolved', foreignSlotId: null },
    );
  });

  it('refuses an empty live credential', () => {
    assert.throws(
      () => classify('', prefetch('', null)),
      { name: 'TypeError', message: 'live credential must be non-empty' },
    );
  });

  it('treats an email/org match with a conflicting uuid as alien rather than its slot', () => {
    const live = credential('recycled-email');
    assert.deepEqual(classify(live, prefetch(live, { uuid: 'uuid-recycled', email: 'a@example.test', organizationUuid: 'org-a' })), { kind: 'alien', foreignSlotId: null });
  });

  it('prefetches only a divergent live OAuth access token through the injected resolver', async () => {
    const live = credential('prefetched');
    assert.deepEqual(await prefetchLiveIdentity({
      outgoing: accountA,
      readLive: async () => live,
      resolveProfile: async () => ({ uuid: 'uuid-a', email: 'a@example.test', organizationUuid: 'org-a' }),
    }), prefetch(live, { uuid: 'uuid-a', email: 'a@example.test', organizationUuid: 'org-a' }));
  });

  it('keeps a diverged self-switch a no-op when the identity is unresolved', () => {
    const live = credential('diverged');
    assert.equal(decideSelfSwitchAction({ outgoing: accountA, liveCredential: live, provenance: prefetch(live, null) }), 'noop-diverged');
  });

  it('keeps a self-switch a no-op when Phase-B bytes differ from the resolved Phase-A bytes', () => {
    const phaseALive = credential('self-phase-a');
    const phaseBLive = credential('self-phase-b');
    assert.equal(
      decideSelfSwitchAction({
        outgoing: accountA,
        liveCredential: phaseBLive,
        provenance: prefetch(phaseALive, { uuid: 'uuid-a', email: 'a@example.test', organizationUuid: 'org-a' }),
      }),
      'noop-diverged',
    );
  });

  it('never permits a degraded read to spend a refresh token', () => {
    assert.equal(mayConsumeCredential({ degraded: true }), false);
  });
});
