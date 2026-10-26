// Ported from claude-swap v0.28.0 (MIT) tests/test_switcher.py:9826-10386.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { consumeClaudeSlot, type ConsumeGateDeps } from '../src/cc-consume';
import { ClaudeSlots, InMemoryClaudeSlotRepository, type ClaudeSlotBackend } from '../src/cc-slots';
import { MockKeychain } from '../src/keychain';

const NOW = 1_000_000;

function credential(tag: string, expiresAt = NOW - 1): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}`, expiresAt } });
}

function fixture(): { slots: ClaudeSlots; backend: MockKeychain; deps: ConsumeGateDeps; posts: () => number } {
  const backend = new MockKeychain();
  const slots = new ClaudeSlots({
    backend,
    repository: new InMemoryClaudeSlotRepository(),
    stashDir: join(mkdtempSync(join(tmpdir(), 'qlb-cc-consume-')), 'unclaimed'),
    now: () => NOW,
  });
  let count = 0;
  const deps: ConsumeGateDeps = {
    slots,
    now: () => NOW,
    withConsumeLock: async (fn) => fn(),
    withSwitchLock: async (fn) => fn(),
    postRefresh: async () => {
      count += 1;
      return { status: 200, body: JSON.stringify({ access_token: `access-issued-${count}`, refresh_token: `refresh-issued-${count}`, expires_in: 3600 }) };
    },
  };
  return { slots, backend, deps, posts: () => count };
}

describe('Claude consume gate (K3 / AC6)', () => {
  it('N8 returns a changed, fresh re-read without a POST', async () => {
    const { slots, deps, posts } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('before'), source: 'cswap-import' });
    const snapshot = (await slots.readSlot('account-a')).credential;
    await slots.writeSlot('account-a', credential('racer', NOW + 600_000), { cause: 'post' });

    const result = await consumeClaudeSlot(deps, { accountId: 'account-a', snapshot });
    assert.equal(result.kind, 'current');
    assert.equal(posts(), 0);
  });

  it('N8 POSTs a changed but expired re-read', async () => {
    const { slots, deps, posts } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('before'), source: 'cswap-import' });
    const snapshot = (await slots.readSlot('account-a')).credential;
    await slots.writeSlot('account-a', credential('racer'), { cause: 'post' });

    const result = await consumeClaudeSlot(deps, { accountId: 'account-a', snapshot });
    assert.equal(result.kind, 'refreshed');
    assert.equal(posts(), 1);
  });

  it('N8 POSTs an unchanged access-token 401 retry', async () => {
    const { slots, deps, posts } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('before'), source: 'cswap-import' });
    const snapshot = (await slots.readSlot('account-a')).credential;

    const result = await consumeClaudeSlot(deps, { accountId: 'account-a', snapshot });
    assert.equal(result.kind, 'refreshed');
    assert.equal(posts(), 1);
  });

  it('serializes concurrent consumers so one refresh token is POSTed once', async () => {
    const { slots, deps, posts } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('before'), source: 'cswap-import' });
    let tail = Promise.resolve();
    deps.withConsumeLock = async (fn) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await fn(); } finally { release(); }
    };

    const [first, second] = await Promise.all([
      consumeClaudeSlot(deps, { accountId: 'account-a', snapshot: credential('before') }),
      consumeClaudeSlot(deps, { accountId: 'account-a', snapshot: credential('before') }),
    ]);
    assert.equal(first.kind, 'refreshed');
    assert.equal(second.kind, 'current');
    assert.equal(posts(), 1);
  });

  it('returns the racer credential after a post-POST CAS conflict', async () => {
    const { slots, deps } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('before'), source: 'cswap-import' });
    let postCount = 0;
    deps.postRefresh = async () => {
      postCount += 1;
      await slots.writeSlot('account-a', credential('racer', NOW + 600_000), { cause: 'post' });
      return { status: 200, body: JSON.stringify({ access_token: 'access-issued', refresh_token: 'refresh-issued', expires_in: 3600 }) };
    };

    const result = await consumeClaudeSlot(deps, { accountId: 'account-a', snapshot: credential('before') });
    assert.equal(result.kind, 'current');
    assert.equal(result.credential, credential('racer', NOW + 600_000));
    assert.equal(postCount, 1);
  });

  it('returns busy without posting when the consume lock is unavailable', async () => {
    const { slots, deps, posts } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('before'), source: 'cswap-import' });
    deps.withConsumeLock = async () => { throw new Error('consume lock unavailable'); };

    assert.equal((await consumeClaudeSlot(deps, { accountId: 'account-a', snapshot: credential('before') })).kind, 'busy');
    assert.equal(posts(), 0);
  });

  it('stashes a successor after a persist failure and adopts it without a second POST', async () => {
    class FailingSlotBackend implements ClaudeSlotBackend {
      readonly inner = new MockKeychain();
      failSlotWrite = false;
      async get(service: string, account: string): Promise<string> { return this.inner.get(service, account); }
      async set(service: string, account: string, value: string): Promise<void> {
        if (this.failSlotWrite && service === 'qlb:anthropic:account-a') throw new Error('fixture persist failure');
        return this.inner.set(service, account, value);
      }
      async delete(service: string, account: string): Promise<void> { return this.inner.delete(service, account); }
    }
    const backend = new FailingSlotBackend();
    const slots = new ClaudeSlots({ backend, repository: new InMemoryClaudeSlotRepository(), stashDir: join(mkdtempSync(join(tmpdir(), 'qlb-cc-consume-')), 'unclaimed'), now: () => NOW });
    await slots.createSlot({ accountId: 'account-a', credential: credential('before'), source: 'cswap-import' });
    let posts = 0;
    const deps: ConsumeGateDeps = {
      slots, now: () => NOW, withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn(),
      postRefresh: async () => ({ status: 200, body: JSON.stringify({ access_token: `access-issued-${++posts}`, refresh_token: 'refresh-issued', expires_in: 3600 }) }),
      stashTimestamp: () => 'fixture-stash',
    };
    backend.failSlotWrite = true;
    assert.equal((await consumeClaudeSlot(deps, { accountId: 'account-a', snapshot: credential('before') })).kind, 'transient');
    backend.failSlotWrite = false;

    assert.equal((await consumeClaudeSlot(deps, { accountId: 'account-a', snapshot: credential('before') })).kind, 'current');
    assert.equal(posts, 1);
  });

  it('reports invalid_client as systemic without treating the slot as dead', async () => {
    const { slots, deps, posts } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('before'), source: 'cswap-import' });
    deps.postRefresh = async () => ({ status: 400, body: '{"error":"invalid_client"}' });
    const result = await consumeClaudeSlot(deps, { accountId: 'account-a', snapshot: credential('before') });
    assert.equal(result.kind, 'systemic');
    assert.equal(posts(), 0);
    assert.equal(slots.listSlots()[0]?.dead, false);
  });
});
