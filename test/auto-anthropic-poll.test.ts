import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { pollAnthropic } from '../src/auto/anthropic';
import { claudePaths } from '../src/cc-paths';
import { ProbeVerdictMemo } from '../src/cc-resync';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import { MockKeychain } from '../src/keychain';
import { openStore } from '../src/store';

const NOW = 1_700_000_000;

function credential(tag: string, expiresAt = (NOW + 60 * 60) * 1000): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}`, expiresAt } });
}

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'qlb-auto-anthropic-'));
  const env = { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home };
  const store = openStore(':memory:');
  const backend = new MockKeychain();
  let now = NOW;
  const slots = new ClaudeSlots({ backend, repository: new InMemoryClaudeSlotRepository(), stashDir: join(home, 'unclaimed'), now: () => now * 1000 });
  await slots.createSlot({ accountId: 'active', credential: credential('active'), email: 'active@example.test', orgUuid: 'active-org', slotNum: 1, source: 'fixture' });
  await slots.createSlot({ accountId: 'inactive', credential: credential('inactive'), email: 'inactive@example.test', orgUuid: 'inactive-org', slotNum: 2, source: 'fixture' });
  store.setActiveLogin('anthropic', 'active', 'fixture', NOW);
  let gets = 0;
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
      getProfile: async () => ({ status: 500, body: '' }), by: 'qlb-auto' as const,
    },
    consumeDeps: {
      postRefresh: async () => { posts += 1; return { status: 200, body: JSON.stringify({ access_token: 'access-refreshed', refresh_token: 'refresh-refreshed', expires_in: 3600 }) }; },
    },
    getUsage: async (_accessToken: string) => { gets += 1; return response; },
  });
  return {
    store, slots, backend, paths, deps, calls: () => ({ gets, posts }),
    now: (value: number) => { now = value; },
    response: (value: typeof response) => { response = value; },
  };
}

function skipActive(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.writeUsagePollPlans('anthropic', { active: { nextDueAt: NOW + 300, pollIntervalS: 300 } });
}

describe('auto anthropic poll (G8)', () => {
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
    assert.equal(accounts.find((account) => account.accountId === 'inactive')?.buckets['5h']?.usedPct, 42);
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

  it('keeps scheduled readings known across steady 60-second ticks', async () => {
    const f = await fixture();
    for (let tick = 0; tick < 60; tick += 1) {
      f.now(NOW + tick * 60);
      const accounts = await pollAnthropic(f.deps());
      assert.ok(accounts.every((account) => account.buckets['5h']?.usedPct !== undefined));
    }
  });

  it('strikes a dead inactive token and never posts it again', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    skipActive(f);
    const deps = f.deps();
    let deadPosts = 0;
    deps.consumeDeps.postRefresh = async () => { deadPosts += 1; return { status: 400, body: '{"error":"invalid_grant"}' }; };
    await pollAnthropic(deps);
    assert.equal(f.store.listUsagePolls('anthropic').inactive?.lastStatus, 'token_dead');
    assert.equal(f.slots.getSlot('inactive')?.dead, true);
    await pollAnthropic(deps);
    assert.equal(deadPosts, 1);
  });

  it('records an unpersisted inactive successor as a failed consume without using it', async () => {
    const f = await fixture();
    await f.slots.writeSlot('inactive', credential('expired', (NOW - 1) * 1000), { cause: 'fixture' });
    skipActive(f);
    (f.slots as unknown as { writeSlot: () => Promise<void> }).writeSlot = async () => { throw new Error('fixture write failure'); };
    (f.slots as unknown as { stashUnclaimed: () => Promise<void> }).stashUnclaimed = async () => { throw new Error('fixture stash failure'); };
    await pollAnthropic(f.deps());
    assert.equal(f.store.listUsagePolls('anthropic').inactive?.lastStatus, 'consume-consume-gate-unpersisted');
    assert.deepEqual(f.calls(), { gets: 0, posts: 1 });
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
