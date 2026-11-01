import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ClaudeConfigFileError } from '../src/cc-credentials';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import { MockKeychain } from '../src/keychain';
import { claudePaths } from '../src/cc-paths';
import {
  checkClaudeSwitchPreconditions,
  prepareClaudeSwitch,
  type ClaudeSwitchDeps,
} from '../src/cc-switch';

const NOW = 1_000_000;
const HOME = '/fixture/home';
const ENV = { QLB_TEST_MODE: '1', HOME };

function credential(tag: string, expiresAt = NOW + 60 * 60_000): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${tag}`, refreshToken: `fixture-refresh-${tag}`, expiresAt } });
}

type Fixture = {
  backend: MockKeychain;
  slots: ClaudeSlots;
  deps: ClaudeSwitchDeps;
  setActive: (accountId: string | null) => void;
  setBreaker: (value: string | null) => void;
  config: Record<string, unknown>;
  posts: () => number;
  warnings: string[];
};

async function fixture(): Promise<Fixture> {
  const backend = new MockKeychain();
  const repository = new InMemoryClaudeSlotRepository();
  const slots = new ClaudeSlots({ backend, repository, stashDir: '/fixture/unclaimed', now: () => NOW });
  const paths = claudePaths({ home: HOME, env: ENV });
  const a = credential('a');
  await slots.createSlot({ accountId: 'account-a', credential: a, email: 'a@example.test', orgUuid: 'org-a', source: 'cswap-import' });
  await slots.createSlot({ accountId: 'account-b', credential: credential('b'), email: 'b@example.test', orgUuid: 'org-b', source: 'cswap-import' });
  await slots.createSlot({ accountId: 'account-c', credential: credential('c'), email: 'c@example.test', orgUuid: 'org-c', source: 'cswap-import' });
  await backend.set(paths.keychainService, 'fixture-user', a);

  let active: string | null = 'account-a';
  let breaker: string | null = null;
  let postCount = 0;
  const warnings: string[] = [];
  const config: Record<string, unknown> = { oauthAccount: { accountUuid: 'account-a' } };
  const deps: ClaudeSwitchDeps = {
    store: {
      getActiveLogin: () => active === null ? { provider: 'anthropic', accountId: null, since: NOW, setBy: 'manual' } : { provider: 'anthropic', accountId: active, since: NOW, setBy: 'manual' },
      getConfig: (key) => key === 'auto.anthropic.suspendedUntil' ? breaker : null,
    },
    slots,
    live: { backend, paths, account: 'fixture-user' },
    readConfig: () => config,
    resolveProfile: async () => null,
    consume: {
      postRefresh: async () => {
        postCount += 1;
        return { status: 200, body: JSON.stringify({ access_token: 'fixture-issued', refresh_token: 'fixture-refresh-issued', expires_in: 3600 }) };
      },
      withConsumeLock: async (fn) => fn(),
      withSwitchLock: async (fn) => fn(),
      stashTimestamp: () => 'fixture-stash',
    },
    env: ENV,
    home: HOME,
    now: () => NOW,
    by: 'qlb-cli',
    warn: (message) => warnings.push(message),
  };
  return {
    backend, slots, deps, config, warnings,
    setActive: (accountId) => { active = accountId; },
    setBreaker: (value) => { breaker = value; },
    posts: () => postCount,
  };
}

const manual = { to: 'account-b', trigger: 'manual' as const };
const automatic = { to: 'account-b', trigger: 'automatic' as const };

function reason(result: Awaited<ReturnType<typeof checkClaudeSwitchPreconditions>> | Awaited<ReturnType<typeof prepareClaudeSwitch>>): string | undefined {
  return 'reason' in result ? result.reason : undefined;
}

describe('Claude switch Phase A (K5-4)', () => {
  it('X1 returns C-swap reasons before any switch lock or write', async () => {
    const live = await fixture();
    live.deps.cswapProcesses = () => [{ pid: 123 }];
    assert.equal(reason(await checkClaudeSwitchPreconditions(live.deps, manual)), 'cswap-process-alive');
    assert.equal(live.backend.listServices().length, 4);

    const unreadable = await fixture();
    unreadable.deps.cswapProcesses = () => { throw new Error('process table unreadable'); };
    assert.equal(reason(await checkClaudeSwitchPreconditions(unreadable.deps, manual)), 'cswap-process-check-failed');
    assert.equal(unreadable.backend.listServices().length, 4);
  });

  it('X2 refuses a busy freshen and a dead target without a POST', async () => {
    const busy = await fixture();
    busy.deps.consume.postRefresh = async () => { throw new Error('must not post'); };
    busy.deps.consume.withConsumeLock = async () => { throw new Error('busy'); };
    // The near-expiry target enters the consume gate; its non-success result is a refusal.
    await busy.slots.writeSlot('account-b', credential('b', NOW + 10 * 60_000), { cause: 'post' });
    assert.equal(reason(await prepareClaudeSwitch(busy.deps, manual)), 'freshen-busy');
    assert.equal(busy.posts(), 0);

    const dead = await fixture();
    const originalGetSlot = dead.slots.getSlot.bind(dead.slots);
    dead.slots.getSlot = (id) => id === 'account-b' ? { ...originalGetSlot(id)!, dead: true } : originalGetSlot(id);
    assert.equal(reason(await checkClaudeSwitchPreconditions(dead.deps, manual)), 'target-dead');
    assert.equal(dead.posts(), 0);

    const missing = await fixture();
    const missingGetSlot = missing.slots.getSlot.bind(missing.slots);
    missing.slots.getSlot = (id) => id === 'account-b' ? null : missingGetSlot(id);
    assert.equal(reason(await checkClaudeSwitchPreconditions(missing.deps, manual)), 'target-missing');

    const archived = await fixture();
    const archivedGetSlot = archived.slots.getSlot.bind(archived.slots);
    archived.slots.getSlot = (id) => id === 'account-b' ? { ...archivedGetSlot(id)!, archivedAt: NOW } : archivedGetSlot(id);
    assert.equal(reason(await checkClaudeSwitchPreconditions(archived.deps, manual)), 'target-archived');
  });

  it('X3 fails a config read without writing a Keychain item', async () => {
    const subject = await fixture();
    subject.deps.readConfig = () => { throw new ClaudeConfigFileError('/fixture/.claude.json', 'invalid JSON'); };
    assert.equal(reason(await prepareClaudeSwitch(subject.deps, manual)), 'claude:config-file');
    assert.equal(subject.backend.listServices().length, 4);
  });

  it('X3b returns live unreadable and target unreadable without a write', async () => {
    const live = await fixture();
    live.deps.live.backend = {
      kind: 'test-memory',
      get: async () => { throw new Error('read failed'); },
      set: (...args) => live.backend.set(...args),
      delete: (...args) => live.backend.delete(...args),
      setSync: (...args) => live.backend.setSync(...args),
      getSync: (...args) => live.backend.getSync(...args),
      deleteSync: (...args) => live.backend.deleteSync(...args),
    };
    assert.equal(reason(await prepareClaudeSwitch(live.deps, manual)), 'live-credential-unreadable');

    const target = await fixture();
    const originalRead = target.slots.readSlot.bind(target.slots);
    target.slots.readSlot = async (id, options) => id === 'account-b' ? Promise.reject(new Error('read failed')) : originalRead(id, options);
    assert.equal(reason(await prepareClaudeSwitch(target.deps, manual)), 'target-unreadable');
  });

  it('X3c refuses an unset or missing active login before Phase A', async () => {
    const unset = await fixture();
    unset.setActive(null);
    assert.equal(reason(await checkClaudeSwitchPreconditions(unset.deps, manual)), 'active-login-unset');

    const missing = await fixture();
    missing.setActive('missing');
    assert.equal(reason(await checkClaudeSwitchPreconditions(missing.deps, manual)), 'active-login-unset');
  });

  it('X3d blocks automatic triggers on future or malformed breakers but not manual', async () => {
    const future = await fixture();
    future.setBreaker(String(NOW + 1));
    assert.equal(reason(await checkClaudeSwitchPreconditions(future.deps, automatic)), 'breaker-open');
    assert.equal(reason(await checkClaudeSwitchPreconditions(future.deps, manual)), undefined);

    const malformed = await fixture();
    malformed.setBreaker('not-a-time');
    assert.equal(reason(await checkClaudeSwitchPreconditions(malformed.deps, automatic)), 'breaker-open');
  });

  it('freshens a near-expiry target through consume then its brief switch lock, both released', async () => {
    const subject = await fixture();
    const events: string[] = [];
    await subject.slots.writeSlot('account-b', credential('b', NOW + 10 * 60_000), { cause: 'post' });
    subject.deps.consume.withConsumeLock = async (fn) => { events.push('consume:start'); try { return await fn(); } finally { events.push('consume:end'); } };
    subject.deps.consume.withSwitchLock = async (fn) => { events.push('switch:start'); try { return await fn(); } finally { events.push('switch:end'); } };
    const result = await prepareClaudeSwitch(subject.deps, manual);
    assert.equal('active' in result, true);
    assert.equal(subject.posts(), 1);
    assert.deepEqual(events, ['consume:start', 'switch:start', 'switch:end', 'switch:start', 'switch:end', 'switch:start', 'switch:end', 'consume:end']);
  });

  it('does not freshen a target with more than ten minutes remaining', async () => {
    const subject = await fixture();
    await subject.slots.writeSlot('account-b', credential('b', NOW + 10 * 60_000 + 1), { cause: 'post' });
    const result = await prepareClaudeSwitch(subject.deps, manual);
    assert.equal('active' in result, true);
    assert.equal(subject.posts(), 0);
  });

  it('skips Phase-A freshening for republish', async () => {
    const subject = await fixture();
    await subject.slots.writeSlot('account-b', credential('b', NOW + 10 * 60_000), { cause: 'post' });
    const result = await prepareClaudeSwitch(subject.deps, { ...manual, republish: true });
    assert.equal('active' in result, true);
    assert.equal(subject.posts(), 0);
  });

  it('continues after a profile error with unresolved provenance', async () => {
    const subject = await fixture();
    const paths = claudePaths({ home: HOME, env: ENV });
    await subject.backend.set(paths.keychainService, 'fixture-user', credential('diverged'));
    subject.deps.resolveProfile = async () => { throw new Error('profile unavailable'); };
    const result = await prepareClaudeSwitch(subject.deps, manual);
    assert.equal('active' in result, true);
    if ('active' in result) assert.equal(result.prefetch.resolved, null);
  });

  it('omits a broken non-target slot with a warning and uses null for an unreadable outgoing slot', async () => {
    const skipped = await fixture();
    const originalRead = skipped.slots.readSlot.bind(skipped.slots);
    skipped.slots.readSlot = async (id, options) => id === 'account-c' ? Promise.reject(new Error('read failed')) : originalRead(id, options);
    const skippedResult = await prepareClaudeSwitch(skipped.deps, manual);
    assert.equal('active' in skippedResult, true);
    if ('active' in skippedResult) assert.deepEqual(skippedResult.slots.map((slot) => slot.accountId).sort(), ['account-a', 'account-b']);
    assert.equal(skipped.warnings.length, 1);

    const outgoing = await fixture();
    const outgoingRead = outgoing.slots.readSlot.bind(outgoing.slots);
    outgoing.slots.readSlot = async (id, options) => id === 'account-a' ? Promise.reject(new Error('read failed')) : outgoingRead(id, options);
    outgoing.deps.resolveProfile = async () => { throw new Error('profile unavailable'); };
    const outgoingResult = await prepareClaudeSwitch(outgoing.deps, manual);
    assert.equal('active' in outgoingResult, true);
    if ('active' in outgoingResult) {
      assert.equal(outgoingResult.slots.find((slot) => slot.accountId === 'account-a')?.credential, null);
      assert.equal(outgoingResult.prefetch.resolved, null);
    }
  });

  it('preconditions and Phase A do not add a Keychain item', async () => {
    const subject = await fixture();
    const before = subject.backend.listServices().sort();
    assert.equal(reason(await checkClaudeSwitchPreconditions(subject.deps, manual)), undefined);
    assert.equal('active' in await prepareClaudeSwitch(subject.deps, manual), true);
    assert.deepEqual(subject.backend.listServices().sort(), before);
  });
});
