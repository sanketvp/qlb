// Ported from claude-swap v0.28.0 (MIT) tests/test_switcher.py:2039-3513,8098-8180
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ProbeVerdictMemo,
  adoptRotatedLive,
  chooseRefreshInput,
  credentialLineage,
  preLockAttribution,
  type RefreshOutcome,
} from '../src/cc-resync';

const NOW = 1_700_000_000_000;

function credential(tag: string, expiresAt = NOW - 1): string {
  return JSON.stringify({ claudeAiOauth: {
    accessToken: `access-${tag}`,
    refreshToken: `refresh-${tag}`,
    expiresAt,
  } });
}

function outcomeIsExhaustive(outcome: RefreshOutcome): string {
  switch (outcome.outcome) {
    case 'posted': return outcome.working;
    case 'restored': return outcome.working;
    case 'adopted': return outcome.working;
    case 'posted-live-unwritten': return outcome.working;
    case 'posted-slot-unwritten': return outcome.working;
    case 'stashed': return outcome.working;
    case 'unpersisted': return outcome.successorFailure;
    case 'failed': return outcome.reason;
    case 'dead': return outcome.reason;
    case 'deferred': return outcome.deferReason;
    case 'refused': return outcome.reason;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

function choice(input: Partial<Parameters<typeof chooseRefreshInput>[0]> = {}) {
  const backup = credential('backup', NOW + 60 * 60_000);
  return chooseRefreshInput({
    creds: credential('live'),
    live: credential('live'),
    backup,
    backupUsable: true,
    slotFp: credentialLineage(backup),
    attributed: false,
    forceRefresh: false,
    now: NOW,
    ...input,
  });
}

describe('Claude active refresh provenance decisions (K6-2)', () => {
  it('same-lineage live is the refresh input', () => {
    const live = credential('live');
    const result = choice({ live, creds: live, slotFp: credentialLineage(live) });
    assert.deepEqual(result, { kind: 'post', input: live, inputLineageIsSlot: true });
  });

  it('cleared live store refreshes from the backup', () => {
    const backup = credential('backup');
    assert.deepEqual(choice({ live: null, backup, slotFp: credentialLineage(backup) }), {
      kind: 'post', input: backup, inputLineageIsSlot: true,
    });
  });

  it('stranded live with a newer backup restores without a POST', () => {
    const live = credential('old', NOW + 60_000);
    const backup = credential('new', NOW + 60 * 60_000);
    assert.deepEqual(choice({ live, creds: live, backup, slotFp: credentialLineage(backup) }), {
      kind: 'restore',
    });
  });

  it('live newer and attributed by a durable successor edge is POSTed', () => {
    const live = credential('live', NOW + 60 * 60_000);
    const backup = credential('backup', NOW + 60_000);
    assert.deepEqual(choice({ live, creds: live, backup, slotFp: credentialLineage(backup), attributed: true }), {
      kind: 'post', input: live, inputLineageIsSlot: false,
    });
  });

  it('live newer and attributed by the in-process memo is POSTed', () => {
    const live = credential('live', NOW + 60 * 60_000);
    const backup = credential('backup', NOW + 60_000);
    const memo = new ProbeVerdictMemo();
    memo.set('account-a', 'a@example.test', credentialLineage(live)!, { match: true, source: 'post' });
    assert.deepEqual(choice({ live, creds: live, backup, slotFp: credentialLineage(backup), attributed: memo.matches('account-a', 'a@example.test', credentialLineage(live)!) }), {
      kind: 'post', input: live, inputLineageIsSlot: false,
    });
  });

  it('live newer and unattributed defers with a once-only warning', () => {
    const live = credential('live', NOW + 60 * 60_000);
    const backup = credential('backup', NOW + 60_000);
    const memo = new ProbeVerdictMemo();
    assert.deepEqual(choice({ live, creds: live, backup, slotFp: credentialLineage(backup) }), {
      kind: 'defer', reason: 'live-unattributed-newer',
    });
    assert.equal(memo.warnOnce('account-a', 'a@example.test', 'live-unattributed-newer'), true);
    assert.equal(memo.warnOnce('account-a', 'a@example.test', 'live-unattributed-newer'), false);
  });

  it('live moved mid-flight defers', () => {
    assert.deepEqual(choice({ live: credential('moved'), creds: credential('observed') }), {
      kind: 'defer', reason: 'live-moved',
    });
  });

  it('a wiped live credential is never adopted', () => {
    const wiped = JSON.stringify({ claudeAiOauth: {} });
    assert.deepEqual(adoptRotatedLive({
      creds: credential('observed'), live: wiped, slotFp: credentialLineage(credential('backup')),
      slotPrevFp: null, verdict: undefined, now: NOW,
    }), { kind: 'none' });
  });

  it('a known-foreign rotated live credential is foreign, never adopted', () => {
    const live = credential('foreign', NOW + 60 * 60_000);
    assert.deepEqual(adoptRotatedLive({
      creds: credential('observed'), live, slotFp: credentialLineage(credential('backup')),
      slotPrevFp: null, verdict: { match: false, source: 'oracle' }, now: NOW,
    }), { kind: 'foreign' });
  });

  it('an unverified rotated live credential is adopted for usage without a slot write', () => {
    const live = credential('rotated', NOW + 60 * 60_000);
    assert.deepEqual(adoptRotatedLive({
      creds: credential('observed'), live, slotFp: credentialLineage(credential('backup')),
      slotPrevFp: null, verdict: undefined, now: NOW,
    }), { kind: 'adopt', working: live, writeSlot: false });
  });

  it('forced recovery never takes the restore branch', () => {
    const live = credential('old', NOW + 60_000);
    const backup = credential('new', NOW + 60 * 60_000);
    assert.deepEqual(choice({ live, creds: live, backup, slotFp: credentialLineage(backup), forceRefresh: true }), {
      kind: 'post', input: backup, inputLineageIsSlot: true,
    });
  });

  it('pre-lock attribution recognizes slot and oracle-proven lineages', () => {
    const own = credential('own');
    const foreign = credential('foreign');
    assert.equal(preLockAttribution({ creds: own, slotFp: credentialLineage(own), slotPrevFp: null }), true);
    assert.equal(preLockAttribution({ creds: foreign, slotFp: credentialLineage(own), slotPrevFp: null, verdict: { match: true, source: 'oracle' } }), true);
  });

  it('the result union is exhaustive', () => {
    const result: RefreshOutcome = { outcome: 'posted-slot-unwritten', working: credential('working') };
    assert.equal(outcomeIsExhaustive(result), credential('working'));
  });
});
