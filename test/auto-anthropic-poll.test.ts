import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { credential as claudeCredential } from './support/claude-fixtures';

import { anthropicTick, pollAnthropic } from '../src/auto/anthropic';
import { anthropicStoreSnapshots } from '../src/anthropic-usage-view';
import { claudePaths } from '../src/cc-paths';
import { credentialLineage, ProbeVerdictMemo, type LiveIdentity } from '../src/cc-resync';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import { MockKeychain } from '../src/keychain';
import { CANDIDATE_DEFAULT_INTERVAL_S, JITTER_FRAC, MIN_INTERVAL_S } from '../src/poll-policy';
import { openStore } from '../src/store';

const NOW = 1_700_000_000;
const credential = (tag: string, expiresAt = (NOW + 3600) * 1000) => claudeCredential(tag, { expiresAt });

async function fixture(activeThreshold?: number) {
  const home = mkdtempSync(join(tmpdir(), 'qlb-auto-anthropic-'));
  const env = { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home };
  const store = openStore(':memory:');
  const backend = new MockKeychain();
  let now = NOW;
  const slots = new ClaudeSlots({ backend, repository: new InMemoryClaudeSlotRepository(), stashDir: join(home, 'unclaimed'), now: () => now * 1000 });
  await slots.createSlot({ accountId: 'active', credential: credential('active'), email: 'active@example.test', orgUuid: 'active-org', slotNum: 1, threshold: activeThreshold, source: 'fixture' });
  await slots.createSlot({ accountId: 'inactive', credential: credential('inactive'), email: 'inactive@example.test', orgUuid: 'inactive-org', slotNum: 2, source: 'fixture' });
  store.setActiveLogin('anthropic', 'active', 'fixture', NOW);
  let gets = 0;
  const usageGets = new Map<string, number>();
  let posts = 0;
  let response: { status: number; body: string; retryAfterS?: number } = { status: 200, body: JSON.stringify({ five_hour: { utilization: 20 }, seven_day: { utilization: 10 } }) };
  const paths = claudePaths({ home, env });
  const deps = () => ({
    store, slots, now: () => now, rng: () => 0.5,
    fetchActiveDeps: {
      live: { backend, paths, account: 'fixture', home, env }, env, now: () => now * 1000,
      verdicts: new ProbeVerdictMemo(), by: 'qlb-auto' as const, postRefresh: async () => { posts += 1; return { status: 500, body: '' }; },
    },
    resyncDeps: {
      live: { backend, paths, account: 'fixture', home, env }, env, now: () => now * 1000,
      getProfile: async () => ({ status: 500, body: '' }), readLiveIdentity: (): LiveIdentity | null => null, by: 'qlb-auto' as const,
    },
    consumeDeps: {
      postRefresh: async () => { posts += 1; return { status: 200, body: JSON.stringify({ access_token: 'access-refreshed', refresh_token: 'refresh-refreshed', expires_in: 3600 }) }; },
    },
    getUsage: async (accessToken: string) => {
      gets += 1;
      usageGets.set(accessToken, (usageGets.get(accessToken) ?? 0) + 1);
      return response;
    },
  });
  return {
    store, slots, backend, paths, deps, calls: () => ({ gets, posts }), usageGets: (accessToken: string) => usageGets.get(accessToken) ?? 0,
    now: (value: number) => { now = value; },
    response: (value: typeof response) => { response = value; },
  };
}

function skipActive(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.writeUsagePollPlans('anthropic', { active: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
}

describe('auto anthropic poll (G8)', () => {
  it('records an injected active 500 without reading credentials or usage', async () => {
    const f = await fixture();
    f.store.writeUsagePollPlans('anthropic', {
      active: { nextDueAt: NOW + 300, pollIntervalS: 300 },
      inactive: { nextDueAt: NOW + 300, pollIntervalS: 300 },
    });
    f.store.upsertSnapshot('active', '5h', { usedPct: 42, fetchedAt: NOW * 1000, source: 'poll', confidence: 'authoritative' });
    let readSlot = false;
    let getUsage = false;
    (f.slots as unknown as { readSlot: typeof f.slots.readSlot }).readSlot = async () => {
      readSlot = true;
      throw new Error('must not read a slot');
    };
    const deps = f.deps();
    deps.getUsage = async () => {
      getUsage = true;
      throw new Error('must not fetch usage');
    };

    const accounts = await pollAnthropic({ ...deps, injectUsage5xx: true });

    assert.equal(readSlot, false);
    assert.equal(getUsage, false);
    assert.equal(f.store.listUsagePolls('anthropic').active?.lastStatus, 'http-500');
    assert.equal(f.store.getAllSnapshots('active')['5h']?.usedPct, 42);
    assert.equal(accounts.find((account) => account.accountId === 'active')?.buckets['5h'], undefined);
  });

  it('keeps auto quota verdicts provider-authoritative', async () => {
    for (const reading of [
      { source: 'provider-poll' as const, confidence: 'authoritative' as const, fetchedAt: (NOW - 301) * 1000 },
      { source: 'poll' as const, confidence: 'authoritative' as const, fetchedAt: NOW * 1000 },
      { source: 'poll' as const, confidence: 'unknown' as const, fetchedAt: NOW * 1000 },
      { source: 'headers' as const, confidence: 'advisory' as const, fetchedAt: NOW * 1000 },
    ]) {
      const f = await fixture();
      for (const accountId of ['active', 'inactive']) {
        f.store.upsertSnapshot(accountId, '5h', {
          usedPct: 100, resetAt: (NOW + 60) * 1000, ...reading,
        });
      }
      const result = await anthropicTick({ store: f.store, slots: f.slots, now: () => NOW * 1000, dryRun: true });
      assert.deepEqual(result.decision, { kind: 'stay', reason: 'unknown', unhealthyTicks: 1 });
    }
  });

  it('switches at a fresh provider-reported limit', async () => {
    const f = await fixture();
    for (const [accountId, usedPct] of [['active', 100], ['inactive', 0]] as const) {
      f.store.upsertSnapshot(accountId, '5h', {
        usedPct, fetchedAt: NOW * 1000, source: 'provider-poll', confidence: 'authoritative',
      });
    }
    const result = await anthropicTick({ store: f.store, slots: f.slots, now: () => NOW * 1000, dryRun: true });
    assert.equal(result.decision.kind, 'switch');
    if (result.decision.kind === 'switch') assert.equal(result.decision.reason, 'at-limit');
  });

  it('parks a fresh provider-reported exhausted fleet', async () => {
    const f = await fixture();
    f.store.upsertSnapshot('active', '5h', {
      usedPct: 100, resetAt: (NOW + 120) * 1000, fetchedAt: NOW * 1000,
      source: 'provider-poll', confidence: 'authoritative',
    });
    f.store.upsertSnapshot('inactive', '5h', {
      usedPct: 100, resetAt: (NOW + 60) * 1000, fetchedAt: NOW * 1000,
      source: 'provider-poll', confidence: 'authoritative',
    });
    const result = await anthropicTick({ store: f.store, slots: f.slots, now: () => NOW * 1000, dryRun: true });
    assert.equal(result.decision.kind, 'switch');
    if (result.decision.kind === 'switch') assert.equal(result.decision.reason, 'parked');
  });

  it('does not park away from a provider reading after its reset', async () => {
    const f = await fixture();
    f.store.upsertSnapshot('active', '5h', {
      usedPct: 100, resetAt: (NOW - 1) * 1000, fetchedAt: (NOW - 250) * 1000,
      source: 'provider-poll', confidence: 'authoritative',
    });
    f.store.upsertSnapshot('inactive', '5h', {
      usedPct: 100, resetAt: (NOW + 3000) * 1000, fetchedAt: NOW * 1000,
      source: 'provider-poll', confidence: 'authoritative',
    });

    const result = await anthropicTick({ store: f.store, slots: f.slots, now: () => (NOW + 30) * 1000, dryRun: true });

    assert.deepEqual(result.decision, { kind: 'stay', reason: 'unknown', unhealthyTicks: 1 });
  });

  it('makes a failed provider poll unknown instead of reusing its prior quota', async () => {
    const f = await fixture();
    for (const accountId of ['active', 'inactive']) {
      f.store.upsertSnapshot(accountId, '5h', {
        usedPct: accountId === 'active' ? 100 : 0, fetchedAt: NOW * 1000,
        source: 'provider-poll', confidence: 'authoritative',
      });
    }
    f.store.recordUsagePollResult('anthropic', 'active', { attemptedAt: NOW, status: 'http-500' });
    for (let tick = 0; tick < 3; tick += 1) {
      const result = await anthropicTick({ store: f.store, slots: f.slots, now: () => (NOW + tick * 60) * 1000, dryRun: true });
      assert.deepEqual(result.decision, { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 });
    }
  });

  it('refreshes an unmeasured candidate when the active provider reading needs one', async () => {
    const f = await fixture(80);
    f.store.upsertSnapshot('active', '5h', {
      usedPct: 85, fetchedAt: NOW * 1000, source: 'provider-poll', confidence: 'authoritative',
    });
    f.store.writeUsagePollPlans('anthropic', {
      active: { nextDueAt: NOW + 10_000, pollIntervalS: 240 },
      inactive: { nextDueAt: NOW + 10_000, pollIntervalS: 600 },
    });

    const accounts = await pollAnthropic(f.deps());

    assert.equal(f.calls().gets, 1);
    assert.equal(accounts.find((account) => account.accountId === 'inactive')?.buckets['5h']?.usedPct, 20);
  });

  it('an expired inactive slot is refreshed through the consume gate once', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    skipActive(f);
    await pollAnthropic(f.deps());
    assert.deepEqual(f.calls(), { gets: 1, posts: 1 });
  });

  it('a poll failure counts as unknown and keeps the last reading within 180 s', async () => {
    const f = await fixture();
    skipActive(f);
    f.store.upsertSnapshot('inactive', '5h', { usedPct: 42, fetchedAt: NOW * 1000, source: 'poll', confidence: 'authoritative' });
    f.response({ status: 500, body: 'unavailable' });
    const accounts = await pollAnthropic(f.deps());
    assert.equal(f.store.getAllSnapshots('inactive')['5h']?.usedPct, 42);
    assert.equal(accounts.find((account) => account.accountId === 'inactive')?.buckets['5h'], undefined);
    assert.equal(f.store.listUsagePolls('anthropic').inactive?.lastStatus, 'http-500');
  });

  it('the active slot is never POSTed while it has more than 5 minutes left', async () => {
    const f = await fixture();
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
    await pollAnthropic(f.deps());
    assert.deepEqual(f.calls(), { gets: 1, posts: 0 });
  });

  it('a tick before next_due_at makes no HTTP call', async () => {
    const f = await fixture();
    f.store.writeUsagePollPlans('anthropic', {
      active: { nextDueAt: NOW + 1, pollIntervalS: 300 }, inactive: { nextDueAt: NOW + 1, pollIntervalS: 300 },
    });
    await pollAnthropic(f.deps());
    assert.deepEqual(f.calls(), { gets: 0, posts: 0 });
  });

  it('a recent 429 lengthens the next poll', async () => {
    const f = await fixture();
    skipActive(f);
    f.response({ status: 429, body: 'rate limited' });
    await pollAnthropic(f.deps());
    assert.ok((f.store.listUsagePolls('anthropic').inactive?.pollIntervalS ?? 0) > 300);
  });

  it('token-shaped text in a usage body never reaches usage_polls.last_status', async () => {
    const f = await fixture();
    skipActive(f);
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    f.response({ status: 200, body: `{not-json ${secret}}` });
    await pollAnthropic(f.deps());
    const status = f.store.listUsagePolls('anthropic').inactive?.lastStatus ?? '';
    assert.equal(status.includes(secret), false);
    assert.equal(status, 'usage-unreadable');
  });

  it('keeps the active provider reading measured across scheduled gaps', async () => {
    const f = await fixture();
    let observedUnknown = false;
    await f.slots.writeSlot('active', credential('active-long', (NOW + 7200) * 1000), { cause: 'fixture' });
    for (let tick = 0; tick < 60; tick += 1) {
      f.now(NOW + tick * 60);
      const accounts = await pollAnthropic(f.deps());
      observedUnknown ||= accounts.some((account) => account.buckets['5h'] === undefined);
      assert.notEqual(accounts.find((account) => account.accountId === 'active')?.buckets['5h'], undefined);
    }
    assert.equal(observedUnknown, true);
  });

  it('holds a stale scheduled active measurement instead of failing over', async () => {
    const f = await fixture();
    f.store.setConfig('autoswitch.unhealthyTicks', '1');
    f.store.recordUsagePollResult('anthropic', 'active', {
      attemptedAt: NOW - 360,
      status: 'ok',
      readings: { '5h': { usedPct: 20, fetchedAt: (NOW - 301) * 1000, source: 'provider-poll', confidence: 'authoritative' } },
    });
    f.store.writeUsagePollPlans('anthropic', { active: { nextDueAt: NOW + 60, pollIntervalS: 360 } });
    f.store.upsertSnapshot('inactive', '5h', { usedPct: 10, fetchedAt: NOW * 1000, source: 'provider-poll', confidence: 'authoritative' });

    const result = await anthropicTick({ store: f.store, slots: f.slots, now: () => NOW * 1000, dryRun: true });

    assert.deepEqual(result.decision, { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 });
  });

  it('holds an active measurement after its reset instead of failing over', async () => {
    const f = await fixture();
    f.store.setConfig('autoswitch.unhealthyTicks', '1');
    f.store.recordUsagePollResult('anthropic', 'active', {
      attemptedAt: NOW - 60,
      status: 'ok',
      readings: { '5h': { usedPct: 40, resetAt: (NOW - 1) * 1000, fetchedAt: NOW * 1000, source: 'provider-poll', confidence: 'authoritative' } },
    });
    f.store.writeUsagePollPlans('anthropic', { active: { nextDueAt: NOW + 60, pollIntervalS: 180 } });
    f.store.upsertSnapshot('inactive', '5h', { usedPct: 10, fetchedAt: NOW * 1000, source: 'provider-poll', confidence: 'authoritative' });

    const result = await anthropicTick({ store: f.store, slots: f.slots, now: () => NOW * 1000, dryRun: true });

    assert.deepEqual(result.decision, { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 });
  });

  it('two simulated hours with fresh tokens make 0 POSTs and poll only on schedule', async () => {
    const f = await fixture();
    const durationS = 120 * 60;
    for (const accountId of ['active', 'inactive']) {
      await f.slots.writeSlot(accountId, credential(`${accountId}-long`, (NOW + 10_800) * 1000), { cause: 'fixture' });
    }
    f.store.writeUsagePollPlans('anthropic', {
      active: { nextDueAt: NOW, pollIntervalS: 300 },
      inactive: { nextDueAt: NOW, pollIntervalS: 300 },
    });

    for (let tick = 0; tick < 120; tick += 1) {
      const now = NOW + tick * 60;
      f.now(now);
      const before = f.calls().gets;
      const dueOrOverdue = Object.values(f.store.listUsagePolls('anthropic'))
        .filter((plan) => plan.nextDueAt !== null && plan.nextDueAt <= now).length;
      await pollAnthropic(f.deps());
      assert.equal(f.calls().gets - before, dueOrOverdue, `tick ${tick} polled once on the first tick at or after next_due_at`);

      const snapshots = anthropicStoreSnapshots(f.slots.listSlots(), f.store, now).snapshots;
      assert.equal(snapshots.length, 2);
      for (const snapshot of snapshots) {
        assert.equal(Object.keys(snapshot.buckets).length, 2, `tick ${tick} has no unknown gap for ${snapshot.accountId}`);
        assert.ok(Object.values(snapshot.buckets).every((reading) => reading.confidence === 'authoritative' || reading.confidence === 'stale'));
      }
    }
    assert.equal(f.calls().posts, 0);
    assert.ok(f.usageGets('access-active-long') <= Math.ceil(durationS / (MIN_INTERVAL_S * (1 - JITTER_FRAC))) + 1);
    assert.ok(f.usageGets('access-inactive-long') <= Math.ceil(durationS / (CANDIDATE_DEFAULT_INTERVAL_S * (1 - JITTER_FRAC))) + 1);
  });

  it('strikes a dead inactive token and never posts it again', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    skipActive(f);
    const deps = f.deps();
    let deadPosts = 0;
    deps.consumeDeps.postRefresh = async () => { deadPosts += 1; return { status: 400, body: '{"error":"invalid_grant"}' }; };
    await pollAnthropic(deps);
    assert.equal(f.store.listUsagePolls('anthropic').inactive?.lastStatus, 'consume-dead');
    assert.equal(f.slots.getSlot('inactive')?.dead, true);
    await pollAnthropic(deps);
    assert.equal(deadPosts, 1);
  });

  it('a lineage-moved dead strike does not quarantine an inactive slot', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    skipActive(f);
    const deps = f.deps();
    deps.consumeDeps.postRefresh = async () => ({ status: 400, body: '{"error":"invalid_grant"}' });
    (f.slots as unknown as { strikeDead: () => Promise<'lineage-moved'> }).strikeDead = async () => 'lineage-moved';
    await pollAnthropic(deps);
    assert.equal(f.slots.getSlot('inactive')?.dead, false);
    assert.equal(f.store.listUsagePolls('anthropic').inactive?.lastStatus, 'consume-dead');
  });

  it('records an unpersisted inactive successor as a failed consume without using it', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    skipActive(f);
    (f.slots as unknown as { writeSlot: () => Promise<void> }).writeSlot = async () => { throw new Error('fixture write failure'); };
    (f.slots as unknown as { stashUnclaimed: () => Promise<void> }).stashUnclaimed = async () => { throw new Error('fixture stash failure'); };
    await pollAnthropic(f.deps());
    const row = f.store.listUsagePolls('anthropic').inactive;
    assert.equal(row?.lastStatus, 'consume-consume-gate-unpersisted');
    assert.ok((row?.backoffUntil ?? 0) >= NOW + 3600);
    const db = (f.store as unknown as { db: { prepare: (sql: string) => { get: () => { detail: string } | undefined } } }).db;
    assert.equal(db.prepare("SELECT detail FROM switch_log WHERE detail = 'freshen-consume-gate-unpersisted'").get()?.detail, 'freshen-consume-gate-unpersisted');
    f.now(NOW + 3599);
    await pollAnthropic(f.deps());
    assert.equal(f.calls().posts, 1);
  });

  it('drops unconfigured scoped windows from returned accounts', async () => {
    const f = await fixture();
    f.store.writeUsagePollPlans('anthropic', {
      active: { nextDueAt: NOW + 300, pollIntervalS: 300 }, inactive: { nextDueAt: NOW + 300, pollIntervalS: 300 },
    });
    f.store.upsertSnapshot('active', '5h', { usedPct: 20, fetchedAt: NOW * 1000, source: 'poll', confidence: 'authoritative' });
    f.store.upsertSnapshot('active', '7d:Fable', { usedPct: 100, fetchedAt: NOW * 1000, source: 'poll', confidence: 'authoritative' });
    const accounts = await pollAnthropic({ ...f.deps(), models: [] });
    assert.equal(accounts.find((account) => account.accountId === 'active')?.buckets['7d:Fable'], undefined);
  });

  it('rechecks active ownership before refreshing an inactive candidate', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    skipActive(f);
    const readSlot = f.slots.readSlot.bind(f.slots);
    let switched = false;
    (f.slots as unknown as { readSlot: typeof f.slots.readSlot }).readSlot = async (accountId, options) => {
      const read = await readSlot(accountId, options);
      if (accountId === 'inactive' && !switched) {
        switched = true;
        f.store.setActiveLogin('anthropic', 'inactive', 'fixture', NOW);
      }
      return read;
    };
    await pollAnthropic(f.deps());
    assert.deepEqual(f.calls(), { gets: 0, posts: 0 });
  });

  it('never refreshes an inactive slot that shares Claude Code live lineage', async () => {
    const f = await fixture();
    const expired = credential('shared', (NOW - 1) * 1000);
    await f.slots.writeSlot('inactive', expired, { cause: 'fixture' });
    await f.backend.set(f.paths.keychainService, 'fixture', expired);
    skipActive(f);
    await pollAnthropic(f.deps());
    assert.deepEqual(f.calls(), { gets: 0, posts: 0 });
  });

  it('uses the live credential for an active usage poll', async () => {
    const f = await fixture();
    await f.backend.set(f.paths.keychainService, 'fixture', credential('live'));
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
    let servedLive = false;
    const deps = f.deps();
    deps.getUsage = async (accessToken) => {
      servedLive = accessToken === 'access-live';
      return { status: 200, body: JSON.stringify({ five_hour: { utilization: 20 }, seven_day: { utilization: 10 } }) };
    };
    await pollAnthropic(deps);
    assert.equal(servedLive, true);
  });

  it('an unknown credential adopted during expired-live recovery with an inconclusive probe records live-unattributed', async () => {
    const f = await fixture();
    const expired = credential('active', (NOW - 1) * 1000);
    const foreign = credential('foreign');
    await f.slots.writeSlot('active', expired, { cause: 'fixture' });
    await f.backend.set(f.paths.keychainService, 'fixture', expired);
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
    const deps = f.deps();
    const lockedDeps = deps.fetchActiveDeps as typeof deps.fetchActiveDeps & {
      withConsumeLock?: <T>(fn: () => Promise<T>, options?: { timeoutMs?: number }) => Promise<T>;
      readLiveIdentity?: () => LiveIdentity | null;
    };
    lockedDeps.readLiveIdentity = () => ({ accountId: 'active', email: 'active@example.test', orgUuid: 'active-org' });
    lockedDeps.withConsumeLock = async (fn) => {
      await f.backend.set(f.paths.keychainService, 'fixture', foreign);
      return fn();
    };
    deps.resyncDeps.readLiveIdentity = () => ({ accountId: 'active', email: 'active@example.test', orgUuid: 'active-org' });
    deps.resyncDeps.getProfile = async () => ({ status: 500, body: '' });

    await pollAnthropic(deps);

    assert.equal(f.store.listUsagePolls('anthropic').active?.lastStatus, 'live-unattributed');
    assert.deepEqual(f.store.getAllSnapshots('active'), {});
  });

  it('records usage when expired unknown live credentials are restored from the active slot backup', async () => {
    const f = await fixture();
    await f.backend.set(f.paths.keychainService, 'fixture', credential('foreign', (NOW - 1) * 1000));
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
    const deps = f.deps();
    const fetchDeps = deps.fetchActiveDeps as typeof deps.fetchActiveDeps & {
      readLiveIdentity?: () => LiveIdentity | null;
    };
    fetchDeps.readLiveIdentity = () => ({ accountId: 'active', email: 'active@example.test', orgUuid: 'active-org' });

    await pollAnthropic(deps);

    assert.equal(f.store.listUsagePolls('anthropic').active?.lastStatus, 'ok');
    assert.equal(f.store.getAllSnapshots('active')['5h']?.usedPct, 20);
  });

  it('records usage when an expired active slot posts a successor from its backup', async () => {
    const f = await fixture();
    await f.slots.writeSlot('active', credential('active', (NOW - 1) * 1000), { cause: 'fixture' });
    await f.backend.set(f.paths.keychainService, 'fixture', credential('foreign', (NOW - 2) * 1000));
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
    const deps = f.deps();
    const fetchDeps = deps.fetchActiveDeps as typeof deps.fetchActiveDeps & {
      readLiveIdentity?: () => LiveIdentity | null;
    };
    fetchDeps.readLiveIdentity = () => ({ accountId: 'active', email: 'active@example.test', orgUuid: 'active-org' });
    deps.fetchActiveDeps.postRefresh = async () => ({
      status: 200,
      body: JSON.stringify({ access_token: 'access-successor', refresh_token: 'refresh-successor', expires_in: 3600 }),
    });

    await pollAnthropic(deps);

    assert.equal(f.store.listUsagePolls('anthropic').active?.lastStatus, 'ok');
    assert.equal(f.store.getAllSnapshots('active')['5h']?.usedPct, 20);
  });

  it('a foreign live credential with a profile 500 records live-unattributed and no usage under the active account', async () => {
    const f = await fixture();
    await f.backend.set(f.paths.keychainService, 'fixture', credential('foreign'));
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
    const deps = f.deps();
    deps.resyncDeps.readLiveIdentity = () => ({ accountId: 'active', email: 'active@example.test', orgUuid: 'active-org' });
    deps.resyncDeps.getProfile = async () => ({ status: 500, body: '' });

    await pollAnthropic(deps);

    assert.equal(f.store.listUsagePolls('anthropic').active?.lastStatus, 'live-unattributed');
    assert.deepEqual(f.store.getAllSnapshots('active'), {});
  });

  it('a foreign live credential with a mismatching profile records foreign-credential and 0 POSTs', async () => {
    const f = await fixture();
    await f.backend.set(f.paths.keychainService, 'fixture', credential('foreign'));
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
    const deps = f.deps();
    deps.resyncDeps.readLiveIdentity = () => ({ accountId: 'active', email: 'active@example.test', orgUuid: 'active-org' });
    deps.resyncDeps.getProfile = async () => ({ status: 200, body: JSON.stringify({ account: { uuid: 'other-account' } }) });

    await pollAnthropic(deps);

    assert.equal(f.store.listUsagePolls('anthropic').active?.lastStatus, 'foreign-credential');
    assert.equal(f.calls().posts, 0);
  });

  it('a same-account rotation attributed by the probe in the same pass records usage', async () => {
    const f = await fixture();
    const rotated = credential('active-rotated');
    await f.backend.set(f.paths.keychainService, 'fixture', rotated);
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
    const deps = f.deps();
    deps.resyncDeps.readLiveIdentity = () => ({ accountId: 'active', email: 'active@example.test', orgUuid: 'active-org' });
    deps.resyncDeps.getProfile = async () => ({ status: 200, body: JSON.stringify({ account: { uuid: 'active' }, organization: { uuid: 'active-org' } }) });

    await pollAnthropic(deps);

    assert.equal(f.store.listUsagePolls('anthropic').active?.lastStatus, 'ok');
    assert.equal(f.store.getAllSnapshots('active')['5h']?.usedPct, 20);
    assert.equal(f.slots.getSlot('active')?.fingerprint, credentialLineage(rotated));
  });

  it('a re-logged-in slot is polled again', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    skipActive(f);
    const deps = f.deps();
    deps.consumeDeps.postRefresh = async () => ({ status: 400, body: '{"error":"invalid_grant"}' });
    await pollAnthropic(deps);
    assert.equal(f.slots.getSlot('inactive')?.dead, true);
    await f.slots.writeSlot('inactive', credential('relogged'), { cause: 'fixture-relogin' });
    const dueAt = f.store.listUsagePolls('anthropic').inactive?.nextDueAt;
    assert.ok(dueAt !== undefined);
    f.now(dueAt!);
    await pollAnthropic(deps);
    assert.equal(f.store.listUsagePolls('anthropic').inactive?.lastStatus, 'ok');
  });

  it('a throttled active becomes unknown during its provider backoff', async () => {
    const f = await fixture();
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 10_000, pollIntervalS: 300 } });
    await pollAnthropic(f.deps());
    const dueAt = f.store.listUsagePolls('anthropic').active?.nextDueAt;
    assert.ok(dueAt !== undefined);
    f.now(dueAt!);
    f.response({ status: 429, body: 'rate limited', retryAfterS: 3600 });
    await pollAnthropic(f.deps());
    const blockUntil = f.store.listUsagePolls('anthropic').active?.backoffUntil;
    assert.ok(blockUntil !== undefined);
    f.now(blockUntil! - 1);
    const accounts = await pollAnthropic(f.deps());
    assert.equal(accounts.find((account) => account.accountId === 'active')?.buckets['5h'], undefined);
  });

  it('an active hard sentinel does not extend the last reading past 180 s', async () => {
    const f = await fixture();
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 10_000, pollIntervalS: 300 } });
    await pollAnthropic(f.deps());
    const dueAt = f.store.listUsagePolls('anthropic').active?.nextDueAt;
    assert.ok(dueAt !== undefined);
    await f.slots.writeSlot('active', credential('expired-active', (NOW - 1) * 1000), { cause: 'fixture' });
    f.now(dueAt!);
    await pollAnthropic(f.deps());
    f.now(dueAt! + 181);
    const accounts = await pollAnthropic(f.deps());
    assert.equal(accounts.find((account) => account.accountId === 'active')?.buckets['5h'], undefined);
  });

  it('keeps polling and repairs a same-account Claude Code rotation across many ticks', async () => {
    const f = await fixture();
    const rotated = credential('active-rotated', (NOW + 7_200) * 1000);
    await f.backend.set(f.paths.keychainService, 'fixture', rotated);
    f.store.writeUsagePollPlans('anthropic', { inactive: { nextDueAt: NOW + 10_000, pollIntervalS: 300 } });
    const deps = f.deps();
    deps.resyncDeps.readLiveIdentity = () => ({ accountId: 'active', email: 'active@example.test', orgUuid: 'active-org' });
    deps.resyncDeps.getProfile = async () => ({ status: 200, body: JSON.stringify({ account: { uuid: 'active' }, organization: { uuid: 'active-org' } }) });
    for (let tick = 0; tick < 45; tick += 1) {
      f.now(NOW + tick * 60);
      const accounts = await pollAnthropic(deps);
      assert.equal(f.store.getActiveLogin('anthropic')?.accountId, 'active');
      assert.equal(accounts.find((account) => account.accountId === 'active')?.buckets['5h']?.usedPct, 20);
    }
    assert.ok(f.calls().gets > 1);
    assert.equal(f.calls().posts, 0);
    assert.equal(f.slots.getSlot('active')?.fingerprint, credentialLineage(rotated));
  });

  it('discards an active reading when the active account changes during its poll', async () => {
    const f = await fixture();
    const deps = f.deps();
    let requests = 0;
    deps.getUsage = async () => {
      requests += 1;
      f.store.setActiveLogin('anthropic', 'inactive', 'fixture', NOW);
      return { status: 200, body: JSON.stringify({ five_hour: { utilization: 20 }, seven_day: { utilization: 10 } }) };
    };
    await pollAnthropic(deps);
    assert.equal(requests, 1);
    assert.deepEqual(f.store.listUsagePolls('anthropic'), {});
    assert.deepEqual(f.store.getAllSnapshots('active'), {});
    assert.deepEqual(f.store.getAllSnapshots('inactive'), {});
  });

  it('a spend-guard skip yields to the next inactive candidate', async () => {
    const f = await fixture();
    const shared = credential('shared', (NOW - 1) * 1000);
    await f.slots.writeSlot('inactive', shared, { cause: 'fixture' });
    await f.backend.set(f.paths.keychainService, 'fixture', shared);
    await f.slots.createSlot({ accountId: 'other', credential: credential('other'), email: 'other@example.test', orgUuid: 'other-org', slotNum: 3, source: 'fixture' });
    skipActive(f);
    await pollAnthropic(f.deps());
    f.now(NOW + 1);
    await pollAnthropic(f.deps());
    assert.equal(f.store.listUsagePolls('anthropic').other?.lastStatus, 'ok');
  });

  it('an unreadable live credential fails closed before inactive spend', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    skipActive(f);
    const deps = f.deps();
    deps.fetchActiveDeps.live.backend.get = async () => { throw new Error('fixture unreadable'); };
    await pollAnthropic(deps);
    assert.equal(f.calls().posts, 0);
  });

  it('does not spend an expired inactive slot when no active row exists', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    await f.backend.set(f.paths.keychainService, 'fixture', credential('rotated-live'));
    f.store.setActiveLogin('anthropic', null, 'fixture', NOW);
    f.store.writeUsagePollPlans('anthropic', { active: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
    await pollAnthropic(f.deps());
    assert.deepEqual(f.calls(), { gets: 0, posts: 0 });
  });

  it('records inactive invalid_client for the doctor check', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    skipActive(f);
    const deps = f.deps();
    deps.consumeDeps.postRefresh = async () => ({ status: 400, body: '{"error":"invalid_client"}' });
    await pollAnthropic(deps);
    assert.equal(f.store.listUsagePolls('anthropic').inactive?.lastStatus, 'invalid_client');
  });

  it('a 429 hold makes every auto quota bucket unknown', async () => {
    const f = await fixture();
    f.store.writeUsagePollPlans('anthropic', {
      active: { nextDueAt: NOW + 10_000, pollIntervalS: 10_000 }, inactive: { nextDueAt: NOW + 10_000, pollIntervalS: 10_000 },
    });
    for (const [label, resetAt] of [['5h', NOW + 86_400], ['7d', NOW + 172_800], ['7d:Fable', NOW - 1]] as const) {
      f.store.upsertSnapshot('active', label, { usedPct: 20, fetchedAt: (NOW - 301) * 1000, resetAt: resetAt * 1000, source: 'poll', confidence: 'authoritative' });
    }
    f.store.recordUsagePollResult('anthropic', 'active', { attemptedAt: NOW, status: 'http-429', http429: true });

    const active = (await pollAnthropic({ ...f.deps(), models: ['opus'] })).find((account) => account.accountId === 'active');
    assert.equal(active?.buckets['5h'], undefined);
    assert.equal(active?.buckets['7d'], undefined);
  });

  it('keeps failed-poll snapshots for status but not auto', async () => {
    const f = await fixture();
    f.store.writeUsagePollPlans('anthropic', {
      active: { nextDueAt: NOW + 10_000, pollIntervalS: 10_000 }, inactive: { nextDueAt: NOW + 10_000, pollIntervalS: 10_000 },
    });
    f.store.upsertSnapshot('active', '5h', { usedPct: 20, fetchedAt: NOW * 1000, resetAt: (NOW + 86_400) * 1000, source: 'poll', confidence: 'authoritative' });
    f.store.upsertSnapshot('active', '7d', { usedPct: 10, fetchedAt: NOW * 1000, resetAt: (NOW + 172_800) * 1000, source: 'poll', confidence: 'authoritative' });
    f.store.upsertSnapshot('active', '7d:Fable', { usedPct: 100, fetchedAt: (NOW - 301) * 1000, resetAt: (NOW - 1) * 1000, source: 'poll', confidence: 'authoritative' });
    f.store.recordUsagePollResult('anthropic', 'active', { attemptedAt: NOW, status: 'http-429', http429: true });

    const auto = (await pollAnthropic({ ...f.deps(), models: ['all'] })).find((account) => account.accountId === 'active');
    const status = anthropicStoreSnapshots(f.slots.listSlots(), f.store, NOW).snapshots.find((snapshot) => snapshot.accountId === 'active');
    assert.equal(auto?.buckets['5h'], undefined);
    assert.equal(auto?.buckets['7d'], undefined);
    assert.equal(auto?.buckets['7d:Fable'], undefined);
    assert.equal(status?.buckets['5h']?.usedPct, 20);
    assert.equal(status?.buckets['7d']?.usedPct, 10);
    assert.equal(status?.buckets['7d:Fable'], undefined);
  });

  it('a 5h reset during a 429 hold still drops the snapshot', async () => {
    const f = await fixture();
    f.store.writeUsagePollPlans('anthropic', {
      active: { nextDueAt: NOW + 10_000, pollIntervalS: 10_000 }, inactive: { nextDueAt: NOW + 10_000, pollIntervalS: 10_000 },
    });
    f.store.upsertSnapshot('active', '5h', { usedPct: 20, fetchedAt: (NOW - 301) * 1000, resetAt: NOW * 1000 - 1, source: 'poll', confidence: 'authoritative' });
    f.store.upsertSnapshot('active', '7d', { usedPct: 10, fetchedAt: (NOW - 301) * 1000, resetAt: (NOW + 86_400) * 1000, source: 'poll', confidence: 'authoritative' });
    f.store.recordUsagePollResult('anthropic', 'active', { attemptedAt: NOW - 301, status: 'http-429', http429: true });
    const accounts = await pollAnthropic(f.deps());
    assert.deepEqual(accounts.find((account) => account.accountId === 'active')?.buckets, {});
  });

  it('keeps last_429_at after a later successful poll', async () => {
    const f = await fixture();
    skipActive(f);
    f.response({ status: 429, body: 'rate limited' });
    await pollAnthropic(f.deps());
    const dueAt = f.store.listUsagePolls('anthropic').inactive?.nextDueAt;
    assert.ok(dueAt !== undefined);
    f.now(dueAt!);
    f.response({ status: 200, body: JSON.stringify({ five_hour: { utilization: 20 }, seven_day: { utilization: 10 } }) });
    await pollAnthropic(f.deps());
    assert.equal(f.store.listUsagePolls('anthropic').inactive?.last429At, NOW);
  });

  it('persists Retry-After as a due-candidate backoff', async () => {
    const f = await fixture();
    skipActive(f);
    f.response({ status: 429, body: 'rate limited', retryAfterS: 3000 });
    await pollAnthropic(f.deps());
    const row = f.store.listUsagePolls('anthropic').inactive;
    assert.ok((row?.backoffUntil ?? 0) >= NOW + 3000);
    f.now(NOW + 2999);
    f.store.writeUsagePollPlans('anthropic', { active: { nextDueAt: NOW + 3299, pollIntervalS: 300 } });
    await pollAnthropic(f.deps());
    assert.equal(f.calls().gets, 1);
  });
});
