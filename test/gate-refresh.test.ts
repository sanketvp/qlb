// Ported from claude-swap v0.28.0 (MIT) tests/test_switcher.py:2039-3513
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import defaultAnthropicGate, { createAnthropicGate, sendRefresh, type AnthropicGateDeps } from '../src/gate/anthropic';
import { InMemoryCredentialBackend } from '../src/cc-credentials';
import { ClaudeCodeLockTimeout } from '../src/cc-locks';
import { claudePaths } from '../src/cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { ANTHROPIC_OAUTH_TOKEN_URL, ANTHROPIC_USAGE_URL } from '../src/anthropic-oauth';
import { credentialLineage, ProbeVerdictMemo, type RefreshOutcome } from '../src/cc-resync';
import { qlbKeychainService } from '../src/keychain';
import { runPiGate, type PiGateDeps } from '../src/pi-gate';
import { beginCutover } from '../src/lifecycle';
import { openStore, openStoreConnection } from '../src/store';

const NOW = 1_700_000_000_000;

function credential(tag: string, expiresAt = NOW - 1): string {
  return JSON.stringify({ claudeAiOauth: {
    accessToken: `access-${tag}`, refreshToken: `refresh-${tag}`, expiresAt,
  } });
}

function credentialWithoutExpiry(tag: string): string {
  return JSON.stringify({ claudeAiOauth: {
    accessToken: `access-${tag}`, refreshToken: `refresh-${tag}`,
  } });
}

interface Fixture {
  dbPath: string;
  store: ReturnType<typeof openStore>;
  slots: ClaudeSlots;
  backend: InMemoryCredentialBackend;
  live: { backend: InMemoryCredentialBackend; paths: ReturnType<typeof claudePaths>; account: string; home: string; env: NodeJS.ProcessEnv };
  env: NodeJS.ProcessEnv;
  identity: () => { accountId: string; email: string; orgUuid: string } | null;
}

async function fixture(expiresAt = NOW + 10 * 60_000): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'qlb-gate-refresh-'));
  const env = { QLB_TEST_MODE: '1', HOME: home, USER: 'fixture-user' };
  const backend = new InMemoryCredentialBackend();
  const paths = claudePaths({ home, env });
  const live = { backend, paths, account: 'fixture-user', home, env };
  const dbPath = join(home, 'qlb.db');
  const store = openStore(dbPath);
  beginCutover(store);
  store.setActiveLogin('anthropic', 'account-a', 'fixture');
  const repository = SqliteClaudeSlotRepository.open(dbPath);
  const slots = new ClaudeSlots({ backend, repository, stashDir: join(home, 'unclaimed'), now: () => NOW });
  const initial = credential('slot', expiresAt);
  await slots.createSlot({ accountId: 'account-a', credential: initial, email: 'a@example.test', orgUuid: 'org-a', source: 'cswap-import' });
  await backend.set(paths.keychainService, 'fixture-user', initial);
  let current: { accountId: string; email: string; orgUuid: string } | null = { accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a' };
  return { dbPath, store, slots, backend, live, env, identity: () => current };
}

async function run(
  f: Fixture,
  outcome?: RefreshOutcome,
  overrides: Partial<AnthropicGateDeps> = {},
  gateOverrides: Partial<Pick<PiGateDeps, 'open' | 'evidenceGap'>> = {},
  events: string[] = [],
): Promise<{ code: number; stdout: string[]; stderr: string[]; trace: string[]; events: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const trace: string[] = [];
  const gate = createAnthropicGate({
    store: f.store, slots: f.slots, live: f.live, env: f.env, now: () => NOW,
    readLiveIdentity: f.identity, verdicts: new ProbeVerdictMemo(),
    postRefresh: async () => { throw new Error('unexpected network call'); },
    ...overrides,
    ...(outcome ? { refresh: async () => outcome } : {}),
  });
  const code = await runPiGate('anthropic', {
    dbPath: f.dbPath, env: f.env,
    deliver: (line) => { stdout.push(line); events.push('stdout'); }, stderr: (line) => stderr.push(line),
    guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined,
    provider: gate, cswapProcesses: () => [], sqlTrace: (line) => { trace.push(line); events.push(line); },
    ...gateOverrides,
  });
  return { code, stdout, stderr, trace, events };
}

function rotateLiveDuringLockedRead(f: Fixture, replacement: string): void {
  const originalGet = f.backend.get.bind(f.backend);
  let liveReads = 0;
  f.backend.get = async (service, account) => {
    if (service === f.live.paths.keychainService && account === f.live.account && ++liveReads === 2) return replacement;
    return originalGet(service, account);
  };
}

describe('Anthropic Pi gate refresh mapping (K6-7)', () => {
  it('bounds the refresh POST by request timeout', async () => {
    const server = createServer(() => { /* deliberately never respond */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
      await assert.rejects(() => sendRefresh({
        url: `http://127.0.0.1:${address.port}/refresh`, method: 'POST', headers: {}, body: '', timeoutMs: 20,
      }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('serves the live active token above five minutes with 0 POSTs and source live', async () => {
    const f = await fixture();
    let posts = 0;
    const result = await run(f, undefined, { postRefresh: async () => { posts += 1; return { status: 500, body: '' }; } });
    assert.equal(posts, 0);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout[0]!).source, 'live');
    f.store.close();
  });

  it('every success writes the evidence row in a BEGIN IMMEDIATE after the credential is determined', async () => {
    const f = await fixture();
    const originalGet = f.backend.get.bind(f.backend);
    f.backend.get = async (service, account) => {
      const value = await originalGet(service, account);
      if (service === f.live.paths.keychainService && account === f.live.account) resultEvents.push('live-read');
      return value;
    };
    const resultEvents: string[] = [];
    const result = await run(f, undefined, {}, {}, resultEvents);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout[0]!).source, 'live');
    assert.ok(result.trace.includes('BEGIN IMMEDIATE'));
    assert.ok(resultEvents.indexOf('live-read') < resultEvents.indexOf('BEGIN IMMEDIATE'));
    assert.ok(resultEvents.indexOf('BEGIN IMMEDIATE') < resultEvents.indexOf('stdout'));
    assert.match(f.store.getConfig('pi.anthropic.lastServedFingerprint') ?? '', /^sha256:/);
    assert.match(f.store.getConfig('pi.anthropic.lastServedAt') ?? '', /^\d+$/);
    assert.equal(f.store.getConfig('pi.anthropic.lastServedBy'), 'qlb-pi');
    f.store.close();
  });

  it('an evidence write failing with SQLITE_BUSY still returns the credential and appends pi:evidence-gap', async () => {
    const f = await fixture();
    const holder = openStoreConnection(f.dbPath);
    holder.exec('BEGIN IMMEDIATE');
    try {
      const result = await run(f, undefined, {}, {
        open: (path) => {
          const db = openStoreConnection(path);
          db.exec('PRAGMA busy_timeout = 20');
          return db;
        },
      });
      assert.equal(result.code, 0);
      assert.equal(result.stdout.length, 1);
      assert.deepEqual(result.stderr, ['qlb gate anthropic: pi:evidence-gap']);
      assert.match(readFileSync(join(f.live.home, 'auto.log'), 'utf8'), /^pi:evidence-gap provider=anthropic at=\d+\n$/);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
      f.store.close();
    }
  });

  it('a rotated live credential under the locks is served with source adopted and 0 POSTs', async () => {
    const f = await fixture(NOW - 1);
    rotateLiveDuringLockedRead(f, credential('rotated', NOW + 60 * 60_000));
    let posts = 0;
    const result = await run(f, undefined, {
      postRefresh: async () => { posts += 1; return { status: 500, body: '' }; },
    });
    assert.equal(result.code, 0);
    assert.equal(posts, 0);
    assert.equal(JSON.parse(result.stdout[0]!).source, 'adopted');
    f.store.close();
  });

  it('at five minutes runs the adopt branch: exactly one POST, the new token is delivered and the slot and live store both hold it', async () => {
    const f = await fixture(NOW + 5 * 60_000);
    let posts = 0;
    const result = await run(f, undefined, {
      postRefresh: async () => ({
        status: 200,
        body: JSON.stringify({ access_token: `access-issued-${++posts}`, refresh_token: 'refresh-issued', expires_in: 3600 }),
      }),
    });
    assert.equal(posts, 1);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout[0]!).source, 'refreshed');
    const slot = await f.slots.readSlot('account-a', { fresh: true });
    const live = await f.backend.get(f.live.paths.keychainService, f.live.account);
    assert.equal(slot.credential, live);
    f.store.close();
  });

  it('a stranded live store is restored from the slot with 0 POSTs and source restored', async () => {
    const f = await fixture(NOW + 60 * 60_000);
    await f.backend.set(f.live.paths.keychainService, f.live.account, credential('stranded', NOW - 1));
    let posts = 0;
    const result = await run(f, undefined, { postRefresh: async () => { posts += 1; return { status: 500, body: '' }; } });
    assert.equal(posts, 0);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout[0]!).source, 'restored');
    f.store.close();
  });

  it('the gate never calls the usage endpoint', async () => {
    const requests: string[] = [];
    const postRefresh: NonNullable<AnthropicGateDeps['postRefresh']> = async (request) => {
      requests.push(request.url);
      return { status: 200, body: JSON.stringify({ access_token: 'access-issued', refresh_token: 'refresh-issued', expires_in: 3600 }) };
    };

    const served = await fixture();
    assert.equal((await run(served, undefined, { postRefresh })).code, 0);
    served.store.close();

    const adopted = await fixture(NOW - 1);
    rotateLiveDuringLockedRead(adopted, credential('rotated', NOW + 60 * 60_000));
    assert.equal((await run(adopted, undefined, { postRefresh })).code, 0);
    adopted.store.close();

    const restored = await fixture(NOW - 1);
    await restored.slots.writeSlot('account-a', credential('slot-successor', NOW + 60 * 60_000), { cause: 'post', by: 'qlb-gate', evidence: 'post' });
    assert.equal((await run(restored, undefined, { postRefresh })).code, 0);
    restored.store.close();

    const refreshed = await fixture(NOW - 1);
    assert.equal((await run(refreshed, undefined, { postRefresh })).code, 0);
    refreshed.store.close();

    assert.deepEqual(requests, [ANTHROPIC_OAUTH_TOKEN_URL]);
    assert.equal(requests.includes(ANTHROPIC_USAGE_URL), false);
  });

  it('routes a live credential with unknown expiry through refresh instead of serving it live', async () => {
    const f = await fixture();
    await f.backend.set(f.live.paths.keychainService, f.live.account, credentialWithoutExpiry('slot'));
    let posts = 0;
    const result = await run(f, undefined, {
      postRefresh: async () => ({
        status: 200,
        body: JSON.stringify({ access_token: `access-issued-${++posts}`, refresh_token: 'refresh-issued', expires_in: 3600 }),
      }),
    });
    assert.equal(posts, 1);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout[0]!).source, 'refreshed');
    f.store.close();
  });

  for (const expiresIn of [30, -5]) {
    it(`refuses a refreshed credential with expires_in ${expiresIn}`, async () => {
      const f = await fixture(NOW - 1);
      const result = await run(f, undefined, {
        postRefresh: async () => ({
          status: 200,
          body: JSON.stringify({ access_token: 'access-issued', refresh_token: 'refresh-issued', expires_in: expiresIn }),
        }),
      });
      assert.equal(result.code, 1);
      assert.deepEqual(result.stdout, []);
      assert.deepEqual(result.stderr, ['credential-expiry-unusable']);
      f.store.close();
    });
  }

  it('a malformed live blob fails closed with no-credentials', async () => {
    const f = await fixture();
    await f.backend.set(f.live.paths.keychainService, f.live.account, '{bad');
    const result = await run(f);
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout, []);
    assert.deepEqual(result.stderr, ['no-credentials']);
    f.store.close();
  });

  it('refuses when the active login changes while the refresh waits for locks', async () => {
    const f = await fixture(NOW - 1);
    const result = await run(f, undefined, {
      refresh: async () => {
        f.store.setActiveLogin('anthropic', 'account-b', 'fixture');
        return { outcome: 'posted', working: credential('issued', NOW + 60 * 60_000) };
      },
    });
    assert.equal(result.code, 3);
    assert.deepEqual(result.stdout, []);
    assert.deepEqual(result.stderr, ['active-login-stale']);
    f.store.close();
  });

  it('an identity change between the live read and the re-read refuses with exit 3', async () => {
    const f = await fixture();
    let reads = 0;
    const gate = createAnthropicGate({
      store: f.store, slots: f.slots, live: f.live, env: f.env, now: () => NOW, verdicts: new ProbeVerdictMemo(),
      readLiveIdentity: () => ++reads === 1
        ? { accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a' }
        : { accountId: 'other', email: 'a@example.test', orgUuid: 'org-a' },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runPiGate('anthropic', { dbPath: f.dbPath, env: f.env, deliver: (line) => stdout.push(line), stderr: (line) => stderr.push(line), guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined, provider: gate, cswapProcesses: () => [] });
    assert.equal(code, 3);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, ['identity-mismatch']);
    f.store.close();
  });

  it('a live write failure after a 2xx fails closed with exit 1, token-expired, no stdout, and appends one auto.log line; the next gate call restores live from the slot with 0 POSTs and serves source restored', async () => {
    const f = await fixture(NOW - 1);
    const originalSet = f.backend.set.bind(f.backend);
    let failLiveWrite = true;
    f.backend.set = async (service, account, value) => {
      if (failLiveWrite && service === f.live.paths.keychainService && account === f.live.account) throw new Error('fixture live write failed');
      return originalSet(service, account, value);
    };
    let posts = 0;
    const postRefresh: NonNullable<AnthropicGateDeps['postRefresh']> = async () => ({
      status: 200,
      body: JSON.stringify({ access_token: `access-issued-${++posts}`, refresh_token: 'refresh-issued', expires_in: 3600 }),
    });
    const failed = await run(f, undefined, { postRefresh });
    assert.equal(failed.code, 1);
    assert.deepEqual(failed.stdout, []);
    assert.deepEqual(failed.stderr, ['token-expired']);
    assert.equal(posts, 1);
    const lines = readFileSync(join(f.live.home, 'auto.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^claude:live-write-failed provider=anthropic account=account-a at=\d+$/);

    failLiveWrite = false;
    const restored = await run(f, undefined, { postRefresh: async () => { throw new Error('must not post'); } });
    assert.equal(restored.code, 0);
    assert.equal(JSON.parse(restored.stdout[0]!).source, 'restored');
    assert.equal(posts, 1);
    f.store.close();
  });

  it('a stashed successor fails closed with exit 1 and no stdout; the next gate call adopts the stash and serves it with 0 POSTs', async () => {
    const f = await fixture(NOW - 1);
    const originalSet = f.backend.set.bind(f.backend);
    const slotService = qlbKeychainService('anthropic', 'account-a');
    let failPersistence = true;
    f.backend.set = async (service, account, value) => {
      if (failPersistence && (service === slotService || (service === f.live.paths.keychainService && account === f.live.account))) {
        throw new Error('fixture persistence write failed');
      }
      return originalSet(service, account, value);
    };
    let posts = 0;
    const failed = await run(f, undefined, {
      postRefresh: async () => ({
        status: 200,
        body: JSON.stringify({ access_token: `access-issued-${++posts}`, refresh_token: 'refresh-issued', expires_in: 3600 }),
      }),
    });
    assert.equal(failed.code, 1);
    assert.deepEqual(failed.stdout, []);
    assert.equal(posts, 1);

    failPersistence = false;
    const adopted = await run(f, undefined, { postRefresh: async () => { throw new Error('must not post'); } });
    assert.equal(adopted.code, 0);
    assert.equal(JSON.parse(adopted.stdout[0]!).source, 'restored');
    assert.equal(posts, 1);
    f.store.close();
  });

  it('an unpersisted successor fails closed with exit 1 and no stdout', async () => {
    const f = await fixture(NOW - 1);
    const originalSet = f.backend.set.bind(f.backend);
    f.backend.set = async () => { throw new Error('fixture keychain write failed'); };
    const originalStash = f.slots.stashUnclaimed.bind(f.slots);
    f.slots.stashUnclaimed = async () => { throw new Error('fixture stash write failed'); };
    const lines: string[] = [];
    const result = await run(f, undefined, {
      postRefresh: async () => ({ status: 200, body: JSON.stringify({ access_token: 'access-issued', refresh_token: 'refresh-issued', expires_in: 3600 }) }),
      autoLog: (line) => lines.push(line),
    });
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^claude:unpersisted-token provider=anthropic account=account-a at=\d+$/);
    f.backend.set = originalSet;
    f.slots.stashUnclaimed = originalStash;
    f.store.close();
  });

  it('a slot write failure with a good live write serves the new token as refreshed', async () => {
    const f = await fixture(NOW - 1);
    let posts = 0;
    f.slots.writeSlot = async () => { throw new Error('slot write failed'); };
    const result = await run(f, undefined, {
      postRefresh: async () => {
        posts += 1;
        return { status: 200, body: JSON.stringify({ access_token: 'access-issued', refresh_token: 'refresh-issued', expires_in: 3600 }) };
      },
    });
    assert.equal(posts, 1);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout[0]!).source, 'refreshed');
    assert.match(String(await f.backend.get(f.live.paths.keychainService, 'fixture-user')), /access-issued/);
    f.store.close();
  });

  it('a dead slot with a still-valid live token is served; the same slot at five minutes refuses relogin-needed with 0 POSTs', async () => {
    const valid = await fixture();
    await valid.slots.strikeDead('account-a', { reason: 'invalid_grant', struckFp: credentialLineage(credential('slot', NOW + 10 * 60_000))!, ts: NOW });
    const result = await run(valid);
    assert.equal(result.code, 0);
    valid.store.close();
    const expired = await fixture(NOW - 1);
    await expired.slots.strikeDead('account-a', { reason: 'invalid_grant', struckFp: credentialLineage(credential('slot', NOW - 1))!, ts: NOW });
    const dead = await run(expired);
    assert.equal(dead.code, 1);
    assert.deepEqual(dead.stdout, []);
    assert.deepEqual(dead.stderr, ['relogin-needed']);
    expired.store.close();
  });

  it('lock contention refuses locks-held with exit 3 and 0 POSTs', async () => {
    const f = await fixture(NOW - 1);
    let posts = 0;
    const result = await run(f, undefined, {
      postRefresh: async () => { posts += 1; return { status: 500, body: '' }; },
      withCredentialLocks: async () => { throw new ClaudeCodeLockTimeout(join(f.live.home, '.claude')); },
    });
    assert.equal(posts, 0);
    assert.equal(result.code, 3);
    assert.deepEqual(result.stdout, []);
    f.store.close();
  });

  it("the module's default export loads through loadGate('anthropic') and receives its context", async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-gate-default-'));
    const dbPath = join(home, 'qlb.db');
    const store = openStore(dbPath);
    beginCutover(store);
    store.close();
    const stderr: string[] = [];
    const code = await runPiGate('anthropic', {
      dbPath, env: { QLB_TEST_MODE: '1', HOME: home }, deliver: () => undefined, stderr: (line) => stderr.push(line),
      guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined,
      loadGate: () => ({ default: defaultAnthropicGate }), cswapProcesses: () => [],
    });
    assert.equal(code, 1);
    assert.deepEqual(stderr, ['active-login-unset']);
  });

  it('every RefreshOutcome variant maps to exactly one gate result', async () => {
    const working = credential('working', NOW + 60 * 60_000);
    const cases: Array<{ outcome: RefreshOutcome; code: number; source?: string; error?: string }> = [
      { outcome: { outcome: 'posted', working }, code: 0, source: 'refreshed' },
      { outcome: { outcome: 'posted-slot-unwritten', working }, code: 0, source: 'refreshed' },
      { outcome: { outcome: 'restored', working }, code: 0, source: 'restored' },
      { outcome: { outcome: 'adopted', working }, code: 0, source: 'adopted' },
      { outcome: { outcome: 'posted-live-unwritten', working }, code: 1, error: 'token-expired' },
      { outcome: { outcome: 'stashed', working }, code: 1, error: 'token-expired' },
      { outcome: { outcome: 'unpersisted', working, successorFailure: 'fixture' }, code: 1, error: 'token-expired' },
      { outcome: { outcome: 'failed', reason: 'refresh-failed' }, code: 1, error: 'refresh-failed' },
      { outcome: { outcome: 'failed', reason: 'invalid_client' }, code: 1, error: 'invalid-client' },
      { outcome: { outcome: 'failed', reason: 'foreign-credential' }, code: 1, error: 'foreign-credential' },
      { outcome: { outcome: 'dead', reason: 'invalid_grant', struckFp: null }, code: 1, error: 'relogin-needed' },
      { outcome: { outcome: 'deferred', deferReason: 'locks-held' }, code: 3, error: 'locks-held' },
      { outcome: { outcome: 'deferred', deferReason: 'identity-mismatch' }, code: 3, error: 'identity-mismatch' },
      { outcome: { outcome: 'deferred', deferReason: 'unexpected' }, code: 1, error: 'refresh-deferred-unexpected' },
      { outcome: { outcome: 'refused', reason: 'store-unmirrored' }, code: 1, error: 'store-unmirrored' },
      { outcome: { outcome: 'refused', reason: 'cswap-process-alive' }, code: 3, error: 'cswap-process-alive' },
      { outcome: { outcome: 'refused', reason: 'cswap-process-check-failed' }, code: 3, error: 'cswap-process-check-failed' },
    ];
    for (const entry of cases) {
      const f = await fixture(NOW - 1);
      const result = await run(f, entry.outcome);
      assert.equal(result.code, entry.code, entry.outcome.outcome);
      if (entry.source) assert.equal(JSON.parse(result.stdout[0]!).source, entry.source);
      else {
        assert.deepEqual(result.stdout, [], entry.outcome.outcome);
        assert.deepEqual(result.stderr, [entry.error], entry.outcome.outcome);
      }
      f.store.close();
    }
  });
});
