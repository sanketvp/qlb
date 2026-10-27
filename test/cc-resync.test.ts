// Ported from claude-swap v0.28.0 (MIT) tests/test_switcher.py:2039-3513,8098-8180
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ProbeVerdictMemo,
  adoptRotatedLive,
  chooseRefreshInput,
  credentialLineage,
  preLockAttribution,
  refreshActiveLogin,
  resolveCswapCheck,
  type RefreshActiveLoginDeps,
  type RefreshOutcome,
} from '../src/cc-resync';
import { InMemoryCredentialBackend } from '../src/cc-credentials';
import { claudePaths } from '../src/cc-paths';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import { openStore } from '../src/store';

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

interface RefreshFixture {
  slots: ClaudeSlots;
  backend: InMemoryCredentialBackend;
  store: ReturnType<typeof openStore>;
  liveOptions: { backend: InMemoryCredentialBackend; paths: ReturnType<typeof claudePaths>; account: string; home: string; env: NodeJS.ProcessEnv };
  deps: Omit<RefreshActiveLoginDeps, 'postRefresh'>;
  posts: () => number;
}

async function refreshFixture(): Promise<RefreshFixture> {
  const home = mkdtempSync(join(tmpdir(), 'qlb-cc-resync-'));
  const env = { QLB_TEST_MODE: '1', HOME: home };
  const backend = new InMemoryCredentialBackend();
  const paths = claudePaths({ home, env });
  const liveOptions = { backend, paths, account: 'fixture-user', home, env };
  const repository = new InMemoryClaudeSlotRepository();
  const slots = new ClaudeSlots({ backend, repository, stashDir: join(home, 'unclaimed'), now: () => NOW });
  const store = openStore(join(home, 'state.sqlite'));
  const initial = credential('slot');
  await slots.createSlot({ accountId: 'account-a', credential: initial, source: 'cswap-import' });
  await backend.set(paths.keychainService, 'fixture-user', initial);
  let postCount = 0;
  const deps: Omit<RefreshActiveLoginDeps, 'postRefresh'> = {
    slots, store, live: liveOptions, now: () => NOW, verdicts: new ProbeVerdictMemo(), env, by: 'qlb-cli',
    readLiveIdentity: () => ({ accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a' }),
    withConsumeLock: async (fn) => fn(),
    withSwitchLock: async (fn) => fn(),
  };
  return { slots, backend, store, liveOptions, deps, posts: () => postCount };
}

async function refresh(fixture: RefreshFixture, overrides: Partial<RefreshActiveLoginDeps> = {}, inputOverrides: Partial<Parameters<typeof refreshActiveLogin>[1]> = {}) {
  let postCount = fixture.posts();
  return refreshActiveLogin({
    ...fixture.deps,
    postRefresh: async () => ({
      status: 200,
      body: JSON.stringify({ access_token: `access-issued-${++postCount}`, refresh_token: `refresh-issued-${postCount}`, expires_in: 3600 }),
    }),
    ...overrides,
  }, {
    accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a', creds: credential('slot'), degraded: false,
    ...inputOverrides,
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

describe('Claude active refresh locked branch (K6-3)', () => {
  it('restore branch rewrites live from a non-expired slot with 0 POSTs and keeps the live shared fields', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    const oldLive = JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'old', expiresAt: NOW - 1 }, mcpOAuth: { machine: true } });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', oldLive);
    let posts = 0;
    const result = await refresh(fixture, { postRefresh: async () => { posts += 1; return { status: 500, body: '' }; } }, { creds: oldLive });
    assert.equal(result.outcome, 'restored');
    assert.equal(posts, 0);
    const written = JSON.parse(await fixture.backend.get(fixture.liveOptions.paths.keychainService, 'fixture-user'));
    assert.deepEqual(written.mcpOAuth, { machine: true });
  });

  it('holds consume, switch and both credential locks across the POST and config lock only around the live write', async () => {
    const fixture = await refreshFixture();
    const events: string[] = [];
    const result = await refresh(fixture, {
      cswapProcesses: () => { events.push('cswap-check'); return []; },
      withConsumeLock: async (fn) => { events.push('consume+'); try { return await fn(); } finally { events.push('consume-'); } },
      withSwitchLock: async (fn) => { events.push('switch+'); try { return await fn(); } finally { events.push('switch-'); } },
      withCredentialLocks: async (fn) => { events.push('credentials+'); try { return await fn({} as never); } finally { events.push('credentials-'); } },
      // This test only observes lock topology; publishing is deliberately
      // forced to fail after the issued successor has been written to its slot.
      withConfigLock: async (fn) => { events.push('config+'); try { return await fn(); } finally { events.push('config-'); } },
      postRefresh: async () => { events.push('POST'); return { status: 200, body: JSON.stringify({ access_token: 'access-issued', refresh_token: 'refresh-issued', expires_in: 3600 }) }; },
    });
    assert.equal(result.outcome, 'posted-live-unwritten');
    assert.deepEqual(events, ['cswap-check', 'consume+', 'switch+', 'credentials+', 'POST', 'config+', 'config-', 'credentials-', 'switch-', 'consume-']);
  });

  it('a waiting process re-reads the slot under the locks and restores a successor another process persisted, with 0 POSTs', async () => {
    const fixture = await refreshFixture();
    let posts = 0;
    const result = await refresh(fixture, {
      withConsumeLock: async (fn) => {
        // This models a peer that won the consume lock while this caller was
        // queued. The caller's pre-lock creds remain stale.
        await fixture.slots.writeSlot('account-a', credential('successor', NOW + 60 * 60_000), { cause: 'post', by: 'qlb-cli', evidence: 'post' });
        return fn();
      },
      postRefresh: async () => { posts += 1; return { status: 500, body: '' }; },
    });
    assert.equal(result.outcome, 'restored');
    assert.equal(posts, 0);
    assert.equal(fixture.slots.getSlot('account-a')!.dead, false);
  });

  it('a dead slot is refused before any lock and never POSTed, even when forced', async () => {
    const fixture = await refreshFixture();
    const fp = credentialLineage(credential('slot'))!;
    await fixture.slots.strikeDead('account-a', { reason: 'invalid_grant', struckFp: fp, ts: NOW });
    let locked = 0;
    const result = await refresh(fixture, {
      withConsumeLock: async () => { locked += 1; throw new Error('must not lock'); },
      postRefresh: async () => { throw new Error('must not post'); },
    });
    assert.deepEqual(result, { outcome: 'dead', reason: 'invalid_grant', struckFp: null });
    assert.equal(locked, 0);
  });

  it('invalid_grant whose POSTed lineage is no longer the slot’s strikes nothing', async () => {
    const fixture = await refreshFixture();
    const result = await refresh(fixture, {
      postRefresh: async () => {
        await fixture.slots.writeSlot('account-a', credential('racer'), { cause: 'post', by: 'qlb-cli', evidence: 'post' });
        return { status: 400, body: '{"error":"invalid_grant"}' };
      },
    });
    assert.deepEqual(result, { outcome: 'failed', reason: 'refresh-failed' });
    assert.equal(fixture.slots.getSlot('account-a')!.dead, false);
  });

  it('a consumed generation survives a live write failure', async () => {
    const fixture = await refreshFixture();
    const result = await refresh(fixture, { withConfigLock: async () => { throw new Error('fixture live failure'); } });
    assert.equal(result.outcome, 'posted-live-unwritten');
    assert.equal(credentialLineage((await fixture.slots.readSlot('account-a')).credential), credentialLineage((result as Extract<RefreshOutcome, { outcome: 'posted-live-unwritten' }>).working));
  });

  it('the default process check is skipped when only process.env carries QLB_TEST_MODE', () => {
    const previous = process.env.QLB_TEST_MODE;
    process.env.QLB_TEST_MODE = '1';
    let called = 0;
    try {
      assert.deepEqual(resolveCswapCheck(undefined, { QLB_PI_TOKEN_CALL: '1' }, () => { called += 1; return []; })(), []);
      assert.equal(called, 0);
    } finally {
      if (previous === undefined) delete process.env.QLB_TEST_MODE;
      else process.env.QLB_TEST_MODE = previous;
    }
  });

  it('the securestorage override refuses with store-unmirrored and takes no lock', async () => {
    const fixture = await refreshFixture();
    let locks = 0;
    const result = await refresh(fixture, { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture' }, withConsumeLock: async () => { locks += 1; throw new Error('must not lock'); } });
    assert.deepEqual(result, { outcome: 'refused', reason: 'store-unmirrored' });
    assert.equal(locks, 0);
  });

  it('identity check compares the organization too', async () => {
    const fixture = await refreshFixture();
    const result = await refresh(fixture, { readLiveIdentity: () => ({ accountId: 'account-a', email: 'a@example.test', orgUuid: 'other-org' }) });
    assert.deepEqual(result, { outcome: 'deferred', deferReason: 'identity-mismatch' });
  });
});
