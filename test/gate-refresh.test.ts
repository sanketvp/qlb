// Ported from claude-swap v0.28.0 (MIT) tests/test_switcher.py:2039-3513
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import defaultAnthropicGate, { createAnthropicGate, type AnthropicGateDeps } from '../src/gate/anthropic';
import { InMemoryCredentialBackend } from '../src/cc-credentials';
import { claudePaths } from '../src/cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { credentialLineage, ProbeVerdictMemo, type RefreshOutcome } from '../src/cc-resync';
import { runPiGate } from '../src/pi-gate';
import { beginCutover } from '../src/lifecycle';
import { openStore } from '../src/store';

const NOW = 1_700_000_000_000;

function credential(tag: string, expiresAt = NOW - 1): string {
  return JSON.stringify({ claudeAiOauth: {
    accessToken: `access-${tag}`, refreshToken: `refresh-${tag}`, expiresAt,
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

async function run(f: Fixture, outcome?: RefreshOutcome, overrides: Partial<AnthropicGateDeps> = {}): Promise<{ code: number; stdout: string[]; stderr: string[]; trace: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const trace: string[] = [];
  const gate = createAnthropicGate({
    store: f.store, slots: f.slots, live: f.live, env: f.env, now: () => NOW,
    readLiveIdentity: f.identity, verdicts: new ProbeVerdictMemo(),
    ...overrides,
    ...(outcome ? { refresh: async () => outcome } : {}),
  });
  const code = await runPiGate('anthropic', {
    dbPath: f.dbPath, env: f.env, deliver: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined,
    provider: gate, cswapProcesses: () => [], sqlTrace: (line) => trace.push(line),
  });
  return { code, stdout, stderr, trace };
}

describe('Anthropic Pi gate refresh mapping (K6-7)', () => {
  it('serves the live active token above five minutes with 0 POSTs and source live', async () => {
    const f = await fixture();
    const result = await run(f);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout[0]!).source, 'live');
    assert.ok(result.trace.includes('BEGIN IMMEDIATE'));
    assert.equal(f.store.getConfig('pi.anthropic.lastServedBy'), 'qlb-pi');
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

  it('fails malformed live credentials closed', async () => {
    const f = await fixture();
    await f.backend.set(f.live.paths.keychainService, f.live.account, '{bad');
    const result = await run(f);
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout, []);
    assert.deepEqual(result.stderr, ['no-credentials']);
    f.store.close();
  });

  it('refuses an identity changed between reads', async () => {
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

  it('a live write failure after a 2xx fails closed with exit 1, token-expired, no stdout, and appends one auto.log line', async () => {
    const f = await fixture(NOW - 1);
    const lines: string[] = [];
    const result = await run(f, { outcome: 'posted-live-unwritten', working: credential('issued', NOW + 60 * 60_000) }, { autoLog: (line) => lines.push(line) });
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout, []);
    assert.deepEqual(result.stderr, ['token-expired']);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^claude:live-write-failed provider=anthropic account=account-a at=\d+$/);
    f.store.close();
  });

  it('a stashed successor fails closed with exit 1 and no stdout; the next gate call adopts the stash and serves it with 0 POSTs', async () => {
    const f = await fixture(NOW - 1);
    const result = await run(f, { outcome: 'stashed', working: credential('issued', NOW + 60 * 60_000) });
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout, []);
    f.store.close();
  });

  it('an unpersisted successor fails closed with exit 1 and no stdout', async () => {
    const f = await fixture(NOW - 1);
    const result = await run(f, { outcome: 'unpersisted', working: credential('issued', NOW + 60 * 60_000), successorFailure: 'fixture' });
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout, []);
    f.store.close();
  });

  it('a slot write failure with a good live write serves the new token as refreshed', async () => {
    const f = await fixture(NOW - 1);
    const result = await run(f, { outcome: 'posted-slot-unwritten', working: credential('issued', NOW + 60 * 60_000) });
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout[0]!).source, 'refreshed');
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
    const result = await run(f, { outcome: 'deferred', deferReason: 'locks-held' });
    assert.equal(result.code, 3);
    assert.deepEqual(result.stdout, []);
    f.store.close();
  });

  it('the module default export loads through loadGate(anthropic) and receives its context', async () => {
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
