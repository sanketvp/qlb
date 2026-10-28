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
  fetchActiveUsage,
  mapRefreshOutcome,
  preLockAttribution,
  refreshActiveLogin,
  resyncHook,
  resyncRotatedBackup,
  resolveCswapCheck,
  type FetchActiveUsageDeps,
  type RefreshActiveLoginDeps,
  type RefreshOutcome,
} from '../src/cc-resync';
import { InMemoryCredentialBackend } from '../src/cc-credentials';
import { claudePaths } from '../src/cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { openStore } from '../src/store';
import { listReloginEvents } from '../src/relogin';

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
  const store = openStore(join(home, 'state.sqlite'));
  const repository = SqliteClaudeSlotRepository.open(store.dbPath);
  const slots = new ClaudeSlots({ backend, repository, stashDir: join(home, 'unclaimed'), now: () => NOW });
  const initial = credential('slot');
  await slots.createSlot({ accountId: 'account-a', credential: initial, email: 'a@example.test', orgUuid: 'org-a', source: 'cswap-import' });
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
    assert.deepEqual(result, { kind: 'post', input: live, inputLineageIsSlot: true, source: 'live' });
  });

  it('cleared live store refreshes from the backup', () => {
    const backup = credential('backup');
    assert.deepEqual(choice({ live: null, backup, slotFp: credentialLineage(backup) }), {
      kind: 'post', input: backup, inputLineageIsSlot: true, source: 'slot',
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
      kind: 'post', input: live, inputLineageIsSlot: false, source: 'live',
    });
  });

  it('live newer and attributed by the in-process memo is POSTed', () => {
    const live = credential('live', NOW + 60 * 60_000);
    const backup = credential('backup', NOW + 60_000);
    const memo = new ProbeVerdictMemo();
    memo.set('account-a', 'a@example.test', credentialLineage(live)!, 'org-a', { match: true, source: 'post' });
    assert.deepEqual(choice({ live, creds: live, backup, slotFp: credentialLineage(backup), attributed: memo.matches('account-a', 'a@example.test', credentialLineage(live)!, 'org-a') }), {
      kind: 'post', input: live, inputLineageIsSlot: false, source: 'live',
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
      kind: 'post', input: backup, inputLineageIsSlot: true, source: 'slot',
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

describe('Claude active usage fetch (K6-4)', () => {
  function usageBody(): string {
    return JSON.stringify({ five_hour: { utilization: 12, resets_at: '2024-01-01T01:00:00Z' } });
  }

  async function fetch(
    fixture: RefreshFixture,
    getUsage: (accessToken: string) => Promise<{ status: number; body: string; retryAfterS?: number }>,
    overrides: Partial<Omit<FetchActiveUsageDeps, 'getUsage'>> = {},
    inputOverrides: Partial<Parameters<typeof fetchActiveUsage>[1]> = {},
  ) {
    return fetchActiveUsage({
      ...fixture.deps,
      postRefresh: async () => ({
        status: 200,
        body: JSON.stringify({ access_token: 'access-issued', refresh_token: 'refresh-issued', expires_in: 3600 }),
      }),
      getUsage,
      ...overrides,
    }, {
      accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a', creds: credential('slot'), degraded: false,
      ...inputOverrides,
    });
  }

  it('a struck active login is quarantined: no usage GET, no POST, sentinel relogin-needed, even with a valid access token', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', fresh);
    await fixture.slots.strikeDead('account-a', { reason: 'invalid_grant', struckFp: credentialLineage(fresh)!, ts: NOW });
    let gets = 0;
    let posts = 0;
    const result = await fetch(fixture, async () => { gets += 1; return { status: 200, body: usageBody() }; }, {
      postRefresh: async () => { posts += 1; return { status: 500, body: '' }; },
    }, { creds: fresh });
    assert.deepEqual(result, { sentinel: 'relogin-needed' });
    assert.equal(gets, 0);
    assert.equal(posts, 0);
  });

  it('a 401 with an unchanged access token forces exactly one POST', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', fresh);
    let posts = 0;
    const tokens: string[] = [];
    const result = await fetch(fixture, async (token) => {
      tokens.push(token);
      return tokens.length === 1 ? { status: 401, body: '' } : { status: 200, body: usageBody() };
    }, { postRefresh: async () => {
      posts += 1;
      return { status: 200, body: JSON.stringify({ access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 3600 }) };
    } }, { creds: fresh });
    assert.equal(posts, 1);
    assert.deepEqual(tokens, ['access-slot', 'access-rotated']);
    assert.ok(result.usage);
  });

  it('a 401 with unchanged access but changed shared fields forces exactly one POST', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: 'access-slot', refreshToken: 'refresh-slot', expiresAt: NOW + 60 * 60_000 },
      mcpOAuth: { machine: true },
    });
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', live);
    let posts = 0;
    let postedRefreshToken: string | null = null;
    const tokens: string[] = [];
    const result = await fetch(fixture, async (token) => {
      tokens.push(token);
      return tokens.length === 1 ? { status: 401, body: '' } : { status: 200, body: usageBody() };
    }, { postRefresh: async (request) => {
      posts += 1;
      postedRefreshToken = (JSON.parse(request.body ?? '{}') as { refresh_token?: string }).refresh_token ?? null;
      return { status: 200, body: JSON.stringify({ access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 3600 }) };
    } }, { creds: fresh });
    assert.equal(posts, 1);
    assert.equal(postedRefreshToken, 'refresh-slot');
    assert.deepEqual(tokens, ['access-slot', 'access-rotated']);
    assert.ok(result.usage);
  });

  it('a 401 with unchanged access but a rotated refresh token returns the 401 without a POST or dead slot', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    const live = credential('refresh-rotated', NOW + 60 * 60_000).replace('access-refresh-rotated', 'access-slot');
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', live);
    let posts = 0;
    const result = await fetch(fixture, async () => ({ status: 401, body: '' }), {
      postRefresh: async () => {
        posts += 1;
        return { status: 200, body: JSON.stringify({ access_token: 'access-rotated', refresh_token: 'refresh-successor', expires_in: 3600 }) };
      },
    }, { creds: fresh });
    assert.deepEqual(result, { error: 'http-401' });
    assert.equal(posts, 0);
    assert.equal(fixture.slots.getSlot('account-a')!.dead, false);
  });

  it('a rotated refresh lineage cannot strike the slot after an invalid_grant', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    const live = credential('refresh-rotated', NOW + 60 * 60_000).replace('access-refresh-rotated', 'access-slot');
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', live);
    let posts = 0;
    const result = await fetch(fixture, async () => ({ status: 401, body: '' }), {
      postRefresh: async () => {
        posts += 1;
        return { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) };
      },
    }, { creds: fresh });
    assert.deepEqual(result, { error: 'http-401' });
    assert.equal(posts, 0);
    assert.equal(fixture.slots.getSlot('account-a')!.dead, false);
  });

  it('a 401 with a changed access token POSTs nothing and surfaces the 401 record', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', fresh);
    let posts = 0;
    const result = await fetch(fixture, async () => {
      await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', credential('moved', NOW + 60 * 60_000));
      return { status: 401, body: '', retryAfterS: 7 };
    }, { postRefresh: async () => { posts += 1; return { status: 500, body: '' }; } }, { creds: fresh });
    assert.deepEqual(result, { error: 'http-401', retryAfterS: 7 });
    assert.equal(posts, 0);
  });

  it('a non-expired token fetches usage without refreshing and outside every lock', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', fresh);
    let locks = 0;
    const result = await fetch(fixture, async (token) => {
      assert.equal(token, 'access-slot');
      return { status: 200, body: usageBody() };
    }, { withConsumeLock: async () => { locks += 1; throw new Error('must not lock'); } }, { creds: fresh });
    assert.ok(result.usage);
    assert.equal(locks, 0);
  });

  it('a live write failure after a 2xx yields token-expired and no usage GET', async () => {
    const fixture = await refreshFixture();
    let gets = 0;
    let posts = 0;
    const result = await fetch(fixture, async () => { gets += 1; return { status: 200, body: usageBody() }; }, {
      postRefresh: async () => {
        posts += 1;
        return { status: 200, body: JSON.stringify({ access_token: 'access-issued', refresh_token: 'refresh-issued', expires_in: 3600 }) };
      },
      withConfigLock: async () => { throw new Error('fixture live failure'); },
    });
    assert.deepEqual(result, { sentinel: 'token-expired' });
    assert.equal(posts, 1);
    assert.equal(gets, 0);
  });

  it('a degraded read plus a server 401 defers with the 401 record', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', fresh);
    const result = await fetch(fixture, async () => ({ status: 401, body: '', retryAfterS: 4 }), {}, { creds: fresh, degraded: true });
    assert.deepEqual(result, { error: 'http-401', retryAfterS: 4 });
  });

  it('no token returns no-credentials', async () => {
    const fixture = await refreshFixture();
    const noToken = JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh-only', expiresAt: NOW + 60 * 60_000 } });
    const result = await fetch(fixture, async () => { throw new Error('must not fetch'); }, {}, { creds: noToken });
    assert.deepEqual(result, { sentinel: 'no-credentials' });
  });

  it('a known-foreign served lineage returns foreign-credential and records no usage', async () => {
    const fixture = await refreshFixture();
    const foreign = credential('foreign', NOW + 60 * 60_000);
    fixture.deps.verdicts.set('account-a', 'a@example.test', credentialLineage(foreign)!, 'org-a', { match: false, source: 'oracle' });
    let hooks = 0;
    const result = await fetch(fixture, async () => ({ status: 200, body: usageBody() }), {
      afterAcceptedUsage: async () => { hooks += 1; },
    }, { creds: foreign });
    assert.deepEqual(result, { sentinel: 'foreign-credential' });
    assert.equal(hooks, 0);
  });

  it('a resync hook that discovers a foreign served lineage blocks usage in the same pass', async () => {
    const fixture = await refreshFixture();
    const served = credential('served', NOW + 60 * 60_000);
    const result = await fetch(fixture, async () => ({ status: 200, body: usageBody() }), {
      afterAcceptedUsage: async ({ creds }) => {
        fixture.deps.verdicts.set('account-a', 'a@example.test', credentialLineage(creds)!, 'org-a', { match: false, source: 'oracle' });
      },
    }, { creds: served });
    assert.deepEqual(result, { sentinel: 'foreign-credential' });
  });

  it('a known-foreign forced lineage is never POSTed', async () => {
    const fixture = await refreshFixture();
    const foreign = credential('foreign', NOW + 60 * 60_000);
    await fixture.slots.writeSlot('account-a', foreign, { cause: 'adopt', by: 'qlb-cli', evidence: 'oracle' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', foreign);
    fixture.deps.verdicts.set('account-a', 'a@example.test', credentialLineage(foreign)!, 'org-a', { match: false, source: 'oracle' });
    let posts = 0;
    const result = await fetch(fixture, async () => ({ status: 401, body: '' }), {
      postRefresh: async () => {
        posts += 1;
        return { status: 200, body: JSON.stringify({ access_token: 'access-issued', refresh_token: 'refresh-issued', expires_in: 3600 }) };
      },
    }, { creds: foreign });
    assert.deepEqual(result, { sentinel: 'foreign-credential' });
    assert.equal(posts, 0);
  });

  it('an unusable same-access live snapshot still reaches the locked reread', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    const live = JSON.stringify({ claudeAiOauth: { accessToken: 'access-slot', expiresAt: NOW + 60 * 60_000 } });
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', live);
    let locks = 0;
    let posts = 0;
    const result = await fetch(fixture, async () => ({ status: 401, body: '' }), {
      withConsumeLock: async (fn) => { locks += 1; return fn(); },
      postRefresh: async () => { posts += 1; return { status: 500, body: '' }; },
    }, { creds: fresh });
    assert.deepEqual(result, { error: 'http-401' });
    assert.equal(locks, 1);
    assert.equal(posts, 0);
  });

  it('a same-lineage access rotation during the lock wait is adopted, not POSTed', async () => {
    const fixture = await refreshFixture();
    const fresh = credential('slot', NOW + 60 * 60_000);
    const rotated = JSON.stringify({ claudeAiOauth: { accessToken: 'access-new', refreshToken: 'refresh-slot', expiresAt: NOW + 60 * 60_000 } });
    await fixture.slots.writeSlot('account-a', fresh, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', fresh);
    const used: string[] = [];
    let posts = 0;
    const result = await fetch(fixture, async (token) => {
      used.push(token);
      return token === 'access-new' ? { status: 200, body: usageBody() } : { status: 401, body: '' };
    }, {
      withConsumeLock: async (fn) => {
        await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', rotated);
        return fn();
      },
      postRefresh: async () => { posts += 1; return { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) }; },
    }, { creds: fresh });
    assert.ok('usage' in result);
    assert.equal(posts, 0);
    assert.deepEqual(used, ['access-slot', 'access-new']);
    assert.equal(fixture.slots.getSlot('account-a')!.dead, false);
  });

  it('a forced 401 on an unattributed access-only credential POSTs nothing', async () => {
    const fixture = await refreshFixture();
    const accessOnly = JSON.stringify({ claudeAiOauth: { accessToken: 'access-x', expiresAt: NOW + 60 * 60_000 } });
    await fixture.slots.writeSlot('account-a', credential('slot', NOW + 60 * 60_000), { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', accessOnly);
    let posts = 0;
    const result = await fetch(fixture, async () => ({ status: 401, body: '' }), {
      postRefresh: async () => { posts += 1; return { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) }; },
    }, { creds: accessOnly });
    assert.deepEqual(result, { error: 'http-401' });
    assert.equal(posts, 0);
    assert.equal(fixture.slots.getSlot('account-a')!.dead, false);
    assert.equal(await fixture.backend.get(fixture.liveOptions.paths.keychainService, 'fixture-user'), accessOnly);
  });

  it('the relogin sentinel surfaces in the same pass as the invalid_grant', async () => {
    const fixture = await refreshFixture();
    const result = await fetch(fixture, async () => { throw new Error('must not fetch'); }, {
      postRefresh: async () => ({ status: 400, body: JSON.stringify({ error: 'invalid_grant' }) }),
    });
    assert.deepEqual(result, { sentinel: 'relogin-needed', error: 'invalid_grant' });
  });

  it('a server-rejected token with no recovery path surfaces the 401, not token-expired', async () => {
    const fixture = await refreshFixture();
    const foreign = credential('foreign', NOW + 60 * 60_000);
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', foreign);
    const result = await fetch(fixture, async () => ({ status: 401, body: '' }), {}, { creds: foreign });
    assert.deepEqual(result, { error: 'http-401' });
  });

  it('the rotated token is used for the usage fetch after the refresh', async () => {
    const fixture = await refreshFixture();
    const used: string[] = [];
    await fetch(fixture, async (token) => { used.push(token); return { status: 200, body: usageBody() }; }, {
      postRefresh: async () => ({ status: 200, body: JSON.stringify({ access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 3600 }) }),
    });
    assert.deepEqual(used, ['access-rotated']);
  });

  it('a stashed or unpersisted successor yields token-expired and no usage GET', async () => {
    for (const [stashFails, expected] of [
      [false, { sentinel: 'token-expired' }],
      [true, { sentinel: 'token-expired', unpersisted: true }],
    ] as const) {
      const fixture = await refreshFixture();
      const slots = fixture.slots as unknown as {
        writeSlot: typeof fixture.slots.writeSlot;
        stashUnclaimed: typeof fixture.slots.stashUnclaimed;
      };
      slots.writeSlot = async () => { throw new Error('fixture slot failure'); };
      if (stashFails) slots.stashUnclaimed = async () => { throw new Error('fixture stash failure'); };
      let gets = 0;
      let posts = 0;
      const result = await fetch(fixture, async () => { gets += 1; return { status: 200, body: usageBody() }; }, {
        postRefresh: async () => {
          posts += 1;
          return { status: 200, body: JSON.stringify({ access_token: 'access-issued', refresh_token: 'refresh-issued', expires_in: 3600 }) };
        },
        withConfigLock: async () => { throw new Error('fixture live failure'); },
      });
      assert.deepEqual(result, expected);
      assert.equal(posts, 1);
      assert.equal(gets, 0);
    }
  });

  it('an expired active credential is no longer statically gated', async () => {
    const fixture = await refreshFixture();
    let posts = 0;
    const result = await fetch(fixture, async () => ({ status: 200, body: usageBody() }), {
      postRefresh: async () => {
        posts += 1;
        return { status: 200, body: JSON.stringify({ access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 3600 }) };
      },
    });
    assert.equal(posts, 1);
    assert.ok(result.usage);
  });

  it('a strike bound to the slot is not lifted by a differing live fingerprint', async () => {
    const fixture = await refreshFixture();
    const struck = credential('slot', NOW + 60 * 60_000);
    await fixture.slots.writeSlot('account-a', struck, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.slots.strikeDead('account-a', { reason: 'invalid_grant', struckFp: credentialLineage(struck)!, ts: NOW });
    const result = await fetch(fixture, async () => { throw new Error('must not fetch'); }, {}, { creds: credential('different', NOW + 60 * 60_000) });
    assert.deepEqual(result, { sentinel: 'relogin-needed' });
    assert.equal(fixture.slots.getSlot('account-a')!.dead, true);
  });

  it('a slot write failure with a good live write still fetches usage with the new token and resyncs the slot', async () => {
    const fixture = await refreshFixture();
    const originalWrite = fixture.slots.writeSlot.bind(fixture.slots);
    let writes = 0;
    (fixture.slots as unknown as { writeSlot: typeof fixture.slots.writeSlot }).writeSlot = async (...args) => {
      writes += 1;
      if (writes === 1) throw new Error('fixture slot failure');
      return originalWrite(...args);
    };
    const result = await fetch(fixture, async (token) => {
      assert.equal(token, 'access-rotated');
      return { status: 200, body: usageBody() };
    }, {
      postRefresh: async () => ({ status: 200, body: JSON.stringify({ access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 3600 }) }),
      afterAcceptedUsage: async ({ creds }) => originalWrite('account-a', creds, { cause: 'resync', by: 'qlb-cli', evidence: 'lineage' }),
    });
    assert.ok(result.usage);
    assert.equal(credentialLineage((await fixture.slots.readSlot('account-a')).credential), credentialLineage(credential('rotated', NOW + 60 * 60_000)));
  });

  it('a healed strike unblocks fetching', async () => {
    const fixture = await refreshFixture();
    const current = credential('slot', NOW + 60 * 60_000);
    await fixture.slots.writeSlot('account-a', current, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await fixture.slots.strikeDead('account-a', { reason: 'invalid_grant', struckFp: credentialLineage(current)!, ts: NOW });
    const healed = credential('healed', NOW + 60 * 60_000);
    await fixture.slots.writeSlot('account-a', healed, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    let gets = 0;
    const result = await fetch(fixture, async () => { gets += 1; return { status: 200, body: usageBody() }; }, {}, { creds: healed });
    assert.ok(result.usage);
    assert.equal(gets, 1);
  });

  it('every RefreshOutcome variant maps to exactly one record shape', () => {
    const working = credential('working');
    const cases: Array<[RefreshOutcome, unknown]> = [
      [{ outcome: 'posted', working }, { working }],
      [{ outcome: 'posted-slot-unwritten', working }, { working }],
      [{ outcome: 'restored', working }, { working }],
      [{ outcome: 'adopted', working }, { working }],
      [{ outcome: 'posted-live-unwritten', working }, { sentinel: 'token-expired' }],
      [{ outcome: 'stashed', working }, { sentinel: 'token-expired' }],
      [{ outcome: 'unpersisted', working, successorFailure: 'unable to persist refresh successor' }, { sentinel: 'token-expired', unpersisted: true }],
      [{ outcome: 'failed', reason: 'refresh-failed' }, { error: 'refresh-failed' }],
      [{ outcome: 'failed', reason: 'invalid_client' }, { error: 'invalid_client' }],
      [{ outcome: 'failed', reason: 'foreign-credential' }, { sentinel: 'foreign-credential' }],
      [{ outcome: 'dead', reason: 'invalid_grant', struckFp: null }, { sentinel: 'relogin-needed', error: 'invalid_grant' }],
      [{ outcome: 'dead', reason: 'no_refresh_token', struckFp: null }, { sentinel: 'relogin-needed', error: 'no_refresh_token' }],
      [{ outcome: 'deferred', deferReason: 'degraded-read' }, { sentinel: 'keychain-unavailable' }],
      [{ outcome: 'deferred', deferReason: 'degraded-read', forceRecord: { error: 'http-401' } }, { error: 'http-401' }],
      [{ outcome: 'deferred', deferReason: 'locks-held' }, { sentinel: 'token-expired' }],
      [{ outcome: 'deferred', deferReason: 'unexpected', forceRecord: { error: 'http-401' } }, { error: 'http-401' }],
      [{ outcome: 'refused', reason: 'store-unmirrored' }, { error: 'store-unmirrored' }],
    ];
    for (const [outcome, expected] of cases) assert.deepEqual(mapRefreshOutcome(outcome), expected);
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

  it('strikes an unmoved live-sourced invalid_grant by lineage when live bytes differ from the slot', async () => {
    const fixture = await refreshFixture();
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: 'access-live', refreshToken: 'refresh-slot', expiresAt: NOW - 1 },
      mcpOAuth: { machine: true },
    });
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', live);
    const result = await refresh(fixture, {
      postRefresh: async () => ({ status: 400, body: '{"error":"invalid_grant"}' }),
    });
    assert.deepEqual(result, { outcome: 'dead', reason: 'invalid_grant', struckFp: credentialLineage(live) });
    assert.equal(fixture.slots.getSlot('account-a')!.dead, true);
  });

  it('does not strike when a live-sourced lineage moves after the POST', async () => {
    const fixture = await refreshFixture();
    const result = await refresh(fixture, {
      postRefresh: async () => {
        await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', credential('racer'));
        return { status: 400, body: '{"error":"invalid_grant"}' };
      },
    });
    assert.deepEqual(result, { outcome: 'failed', reason: 'refresh-failed' });
    assert.equal(fixture.slots.getSlot('account-a')!.dead, false);
  });

  it('keeps a slot-sourced invalid_grant demotion bound to the slot lineage', async () => {
    const fixture = await refreshFixture();
    const observed = credential('observed');
    await fixture.backend.set(fixture.liveOptions.paths.keychainService, 'fixture-user', observed);
    const result = await refresh(fixture, {
      postRefresh: async () => {
        await fixture.slots.writeSlot('account-a', credential('racer'), { cause: 'post', by: 'qlb-cli', evidence: 'post' });
        return { status: 400, body: '{"error":"invalid_grant"}' };
      },
    }, { creds: observed });
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
    const result = await refresh(fixture, { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture' }, live: { ...fixture.liveOptions, env: undefined }, withConsumeLock: async () => { locks += 1; throw new Error('must not lock'); } });
    assert.deepEqual(result, { outcome: 'refused', reason: 'store-unmirrored' });
    assert.equal(locks, 0);
  });

  it('the live credential environment securestorage override refuses before taking a lock', async () => {
    const fixture = await refreshFixture();
    let locks = 0;
    const result = await refresh(fixture, {
      live: { ...fixture.liveOptions, env: { ...fixture.liveOptions.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture' } },
      withConsumeLock: async () => { locks += 1; throw new Error('must not lock'); },
    });
    assert.deepEqual(result, { outcome: 'refused', reason: 'store-unmirrored' });
    assert.equal(locks, 0);
  });

  it('identity check compares the organization too', async () => {
    const fixture = await refreshFixture();
    const result = await refresh(fixture, { readLiveIdentity: () => ({ accountId: 'account-a', email: 'a@example.test', orgUuid: 'other-org' }) });
    assert.deepEqual(result, { outcome: 'deferred', deferReason: 'identity-mismatch' });
  });
});

describe('Claude rotated backup resync (K6-5)', () => {
  async function fixture() {
    const value = await refreshFixture();
    const run = async (served: string, overrides: Record<string, unknown> = {}, holderObservation?: { aliveBefore: boolean; aliveAfter: boolean }, slotOverride?: { fingerprint: string }) => resyncRotatedBackup({
      slots: value.slots, store: value.store, live: value.liveOptions, env: value.liveOptions.env,
      verdicts: new ProbeVerdictMemo(), now: () => NOW,
      readLiveIdentity: () => ({ accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a' }),
      getProfile: async () => ({ status: 200, body: JSON.stringify({ account: { uuid: 'account-a', email: 'a@example.test' }, organization: { uuid: 'org-a' } }) }),
      withSwitchLock: async <T>(fn: () => Promise<T>) => fn(),
      withCredentialLocks: async <T>(fn: (held: never) => Promise<T>) => fn({} as never),
      ...overrides,
    }, { accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a', creds: served,
      slot: slotOverride ?? await value.slots.readSlot('account-a', { fresh: true }), holderObservation });
    return { ...value, run };
  }

  it('a fresh fetch resyncs the slot after an external rotation attributed by the oracle', async () => {
    const f = await fixture(); const served = credential('external', NOW + 60 * 60_000);
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    await f.run(served);
    assert.equal((await f.slots.readSlot('account-a')).fingerprint, credentialLineage(served));
    assert.deepEqual({ ...f.store.listLineageTransitions('anthropic', 'account-a').at(-1) }, { from_fp: credentialLineage(credential('slot')), to_fp: credentialLineage(served) });
    const row = (f.store as unknown as { db: { prepare(sql: string): { get(...args: unknown[]): unknown } } }).db
      .prepare("SELECT cause, by, evidence FROM lineage_log WHERE provider = 'anthropic' AND account_id = ? ORDER BY id DESC")
      .get('account-a');
    assert.deepEqual({ ...(row as object) }, { cause: 'resync', by: 'tool', evidence: 'oracle' });
  });

  it('same lineage skips the resync', async () => {
    const f = await fixture(); let profiles = 0;
    await f.run(credential('slot'), { getProfile: async () => { profiles += 1; return { status: 500, body: '' }; } });
    assert.equal(profiles, 0);
  });

  it('a durable post edge skips the probe and resyncs without network', async () => {
    const f = await fixture(); const served = credential('post-successor', NOW + 60 * 60_000);
    f.store.recordLineage({ provider: 'anthropic', accountId: 'account-a', fromFp: credentialLineage(credential('slot')), toFp: credentialLineage(served)!,  cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    let profiles = 0; await f.run(served, { getProfile: async () => { profiles += 1; throw new Error('must not probe'); } });
    assert.equal(profiles, 0); assert.equal((await f.slots.readSlot('account-a')).fingerprint, credentialLineage(served));
  });

  it('a foreign probe mismatch skips the resync, warns once and caches the verdict', async () => {
    const f = await fixture(); const served = credential('foreign', NOW + 60 * 60_000); const verdicts = new ProbeVerdictMemo(); const warnings: string[] = [];
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    const deps = { verdicts, warn: (line: string) => warnings.push(line), getProfile: async () => ({ status: 200, body: JSON.stringify({ account: { uuid: 'other' } }) }) };
    await f.run(served, deps); await f.run(served, deps);
    assert.equal(verdicts.get('account-a', 'a@example.test', credentialLineage(served)!, 'org-a')?.match, false); assert.equal(warnings.length, 1);
  });

  it('a profile without a uuid is unverifiable and never cached', async () => {
    const f = await fixture(); const served = credential('partial', NOW + 60 * 60_000); const verdicts = new ProbeVerdictMemo();
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    await f.run(served, { verdicts, getProfile: async () => ({ status: 200, body: JSON.stringify({ account: { email: 'a@example.test' } }) }) });
    assert.equal(verdicts.get('account-a', 'a@example.test', credentialLineage(served)!, 'org-a'), undefined);
  });

  it('a normal Claude Code rotation with no holder observation records 0 relogin rows', async () => {
    const f = await fixture(); const served = credential('normal', NOW + 60 * 60_000);
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served); await f.run(served);
    assert.equal(listReloginEvents(f.store.dbPath).length, 0);
  });

  it('a login-expiry jump with L41 verified and a holder alive records one hard row', async () => {
    const f = await fixture(); const previous = JSON.stringify({ claudeAiOauth: { accessToken: 'access-before', refreshToken: 'refresh-before', expiresAt: NOW - 1, refreshTokenExpiresAt: NOW + 1_000_000 } }); const served = JSON.stringify({ claudeAiOauth: { accessToken: 'access-hard', refreshToken: 'refresh-hard', expiresAt: NOW + 60 * 60_000, refreshTokenExpiresAt: NOW + 2_000_000 } });
    await f.slots.writeSlot('account-a', previous, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served); await f.run(served, { l41Verified: true }, { aliveBefore: true, aliveAfter: false });
    assert.deepEqual(listReloginEvents(f.store.dbPath).map(({ kind, evidence }) => ({ kind, evidence })), [{ kind: 'external-login', evidence: 'login-expiry-jump' }]);
  });

  it('a non-successor rotation observed with no holder at either point records one soft row', async () => {
    const f = await fixture(); const served = credential('soft', NOW + 60 * 60_000);
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served); await f.run(served, {}, { aliveBefore: false, aliveAfter: false });
    assert.deepEqual(listReloginEvents(f.store.dbPath).map((row) => row.evidence), ['unattributed-rotation']);
  });

  it('a probe failure skips the resync and retries next pass', async () => {
    const f = await fixture(); const served = credential('retry', NOW + 60 * 60_000); let probes = 0;
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    const deps = { getProfile: async () => { probes += 1; if (probes === 1) throw new Error('fixture'); return { status: 200, body: JSON.stringify({ account: { uuid: 'account-a' } }) }; } };
    await f.run(served, deps); await f.run(served, deps);
    assert.equal(probes, 2); assert.equal((await f.slots.readSlot('account-a')).fingerprint, credentialLineage(served));
  });

  it('the lineage key binds the stored email and organization too', async () => {
    const f = await fixture(); const served = credential('identity-bound', NOW + 60 * 60_000); const verdicts = new ProbeVerdictMemo();
    verdicts.set('account-a', 'other@example.test', credentialLineage(served)!, 'org-a', { match: false, source: 'oracle' });
    verdicts.set('account-a', 'a@example.test', credentialLineage(served)!, 'other-org', { match: false, source: 'oracle' });
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served); await f.run(served, { verdicts });
    assert.equal((await f.slots.readSlot('account-a')).fingerprint, credentialLineage(served));
  });

  it('a verdict does not survive a slot identity change', async () => {
    const f = await fixture(); const served = credential('identity-change', NOW + 60 * 60_000);
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    await f.run(served, { readLiveIdentity: () => ({ accountId: 'account-a', email: 'other@example.test', orgUuid: 'org-a' }) });
    assert.equal((await f.slots.readSlot('account-a')).fingerprint, credentialLineage(credential('slot')));
  });

  it('a K6-3 post memo with a missing post edge records 0 relogin rows', async () => {
    const f = await fixture(); const served = credential('post-memo', NOW + 60 * 60_000); const verdicts = new ProbeVerdictMemo();
    verdicts.set('account-a', 'a@example.test', credentialLineage(served)!, 'org-a', { match: true, source: 'post' });
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    await f.run(served, { verdicts }, { aliveBefore: false, aliveAfter: false });
    assert.equal(listReloginEvents(f.store.dbPath).length, 0);
  });

  it('never resyncs over a posted-live-unwritten successor', async () => {
    const f = await fixture(); const served = credential('served-predecessor', NOW + 60 * 60_000); const successor = credential('issued-successor', NOW + 2 * 60 * 60_000);
    await f.slots.writeSlot('account-a', served, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await f.slots.writeSlot('account-a', successor, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    const verdicts = new ProbeVerdictMemo();
    verdicts.set('account-a', 'a@example.test', credentialLineage(served)!, 'org-a', { match: true, source: 'oracle' });
    await f.run(served, { verdicts }, { aliveBefore: false, aliveAfter: false });
    assert.equal((await f.slots.readSlot('account-a')).fingerprint, credentialLineage(successor));
    assert.equal(f.store.listLineageTransitions('anthropic', 'account-a').some((edge) => edge.from_fp === credentialLineage(successor) && edge.to_fp === credentialLineage(served)), false);
    assert.equal(listReloginEvents(f.store.dbPath).length, 0);
  });

  it('never rolls the slot back when it moves to a successor while resync waits for locks', async () => {
    const f = await fixture(); const served = credential('race-served', NOW + 60 * 60_000); const successor = credential('race-successor', NOW + 2 * 60 * 60_000);
    await f.slots.writeSlot('account-a', served, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    const verdicts = new ProbeVerdictMemo();
    verdicts.set('account-a', 'a@example.test', credentialLineage(served)!, 'org-a', { match: true, source: 'oracle' });
    await f.run(served, {
      verdicts,
      withSwitchLock: async <T>(fn: () => Promise<T>) => {
        await f.slots.writeSlot('account-a', successor, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
        return fn();
      },
    }, undefined, { fingerprint: credentialLineage(credential('slot'))! });
    assert.equal((await f.slots.readSlot('account-a')).fingerprint, credentialLineage(successor));
    assert.equal(f.store.listLineageTransitions('anthropic', 'account-a').some((edge) => edge.from_fp === credentialLineage(successor) && edge.to_fp === credentialLineage(served)), false);
  });

  it('the same hard case after a restart records no second row', async () => {
    const f = await fixture(); const previous = JSON.stringify({ claudeAiOauth: { accessToken: 'access-before', refreshToken: 'refresh-before', expiresAt: NOW - 1, refreshTokenExpiresAt: NOW + 1_000_000 } }); const served = JSON.stringify({ claudeAiOauth: { accessToken: 'access-hard-restart', refreshToken: 'refresh-hard-restart', expiresAt: NOW + 60 * 60_000, refreshTokenExpiresAt: NOW + 2_000_000 } });
    await f.slots.writeSlot('account-a', previous, { cause: 'post', by: 'qlb-cli', evidence: 'post' });
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    const originalWrite = f.slots.writeSlot.bind(f.slots);
    f.slots.writeSlot = async () => { throw new Error('fixture resync write failed'); };
    try {
      await f.run(served, { l41Verified: true }, { aliveBefore: false, aliveAfter: false });
      await f.run(served, { l41Verified: true, verdicts: new ProbeVerdictMemo() }, { aliveBefore: false, aliveAfter: false });
    } finally {
      f.slots.writeSlot = originalWrite;
    }
    assert.equal(listReloginEvents(f.store.dbPath).filter((row) => row.kind === 'external-login').length, 1);
  });

  it('the hook shares its memo with fetchActiveUsage and blocks a foreign rotation in the same pass', async () => {
    const f = await fixture(); const foreign = credential('hook-foreign', NOW + 60 * 60_000);
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', foreign);
    const hook = resyncHook({
      slots: f.slots, store: f.store, live: f.liveOptions, env: f.liveOptions.env, verdicts: f.deps.verdicts, now: () => NOW,
      readLiveIdentity: () => ({ accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a' }),
      getProfile: async () => ({ status: 200, body: JSON.stringify({ account: { uuid: 'other-account' } }) }),
      withSwitchLock: async <T>(fn: () => Promise<T>) => fn(),
      withCredentialLocks: async <T>(fn: (held: never) => Promise<T>) => fn({} as never),
    });
    const result = await fetchActiveUsage({
      ...f.deps,
      postRefresh: async () => ({ status: 500, body: '' }),
      getUsage: async () => ({ status: 200, body: JSON.stringify({ five_hour: { utilization: 12 } }) }),
      afterAcceptedUsage: hook,
    }, { accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a', creds: foreign, degraded: false });
    assert.deepEqual(result, { sentinel: 'foreign-credential' });
  });

  it('a degraded read never feeds the resync write', async () => {
    const f = await fixture(); const served = credential('degraded-resync', NOW + 60 * 60_000); let profiles = 0;
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    const hook = resyncHook({
      slots: f.slots, store: f.store, live: f.liveOptions, env: f.liveOptions.env, verdicts: f.deps.verdicts, now: () => NOW,
      readLiveIdentity: () => ({ accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a' }),
      getProfile: async () => { profiles += 1; return { status: 200, body: JSON.stringify({ account: { uuid: 'account-a' } }) }; },
      withSwitchLock: async <T>(fn: () => Promise<T>) => fn(),
      withCredentialLocks: async <T>(fn: (held: never) => Promise<T>) => fn({} as never),
    });
    await fetchActiveUsage({
      ...f.deps,
      postRefresh: async () => ({ status: 500, body: '' }),
      getUsage: async () => ({ status: 200, body: JSON.stringify({ five_hour: { utilization: 12 } }) }),
      afterAcceptedUsage: hook,
    }, { accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a', creds: served, degraded: true });
    assert.equal(profiles, 0);
    assert.equal((await f.slots.readSlot('account-a')).fingerprint, credentialLineage(credential('slot')));
  });

  it('a non-successor rotation with a holder alive records none', async () => {
    const f = await fixture(); const served = credential('holder', NOW + 60 * 60_000);
    await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served); await f.run(served, {}, { aliveBefore: true, aliveAfter: false });
    assert.equal(listReloginEvents(f.store.dbPath).length, 0);
  });

  it('L41 unverified writes no hard row', async () => {
    const f = await fixture(); const previous = JSON.stringify({ claudeAiOauth: { accessToken: 'access-before', refreshToken: 'refresh-before', expiresAt: NOW - 1, refreshTokenExpiresAt: NOW + 1_000_000 } }); const served = JSON.stringify({ claudeAiOauth: { accessToken: 'access-l41', refreshToken: 'refresh-l41', expiresAt: NOW + 60 * 60_000, refreshTokenExpiresAt: NOW + 2_000_000 } });
    await f.slots.writeSlot('account-a', previous, { cause: 'post', by: 'qlb-cli', evidence: 'post' }); await f.backend.set(f.liveOptions.paths.keychainService, 'fixture-user', served);
    await f.run(served, { l41Verified: false }, { aliveBefore: true, aliveAfter: false });
    assert.equal(listReloginEvents(f.store.dbPath).length, 0);
  });
});
