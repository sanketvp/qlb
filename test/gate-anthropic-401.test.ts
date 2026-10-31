import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { InMemoryCredentialBackend } from '../src/cc-credentials';
import { claudePaths } from '../src/cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { ProbeVerdictMemo, type RefreshOutcome } from '../src/cc-resync';
import {
  claimForced401,
  createAnthropicGate,
  releaseForced401,
  startedPost,
  type AnthropicGateDeps,
} from '../src/gate/anthropic';
import { beginCutover } from '../src/lifecycle';
import { runPiGate } from '../src/pi-gate';
import { openStore } from '../src/store';

const NOW = 1_700_000_000_000;

function credentialWithTokens(accessToken: string, refreshToken: string, expiresAt = NOW + 60 * 60_000): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt } });
}

function credential(tag: string, expiresAt = NOW + 60 * 60_000): string {
  return credentialWithTokens(`access-${tag}`, `refresh-${tag}`, expiresAt);
}

function accessFingerprint(token: string): string {
  return `sha256-at:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

interface Fixture {
  dbPath: string;
  store: ReturnType<typeof openStore>;
  slots: ClaudeSlots;
  backend: InMemoryCredentialBackend;
  live: { backend: InMemoryCredentialBackend; paths: ReturnType<typeof claudePaths>; account: string; home: string; env: NodeJS.ProcessEnv };
  env: NodeJS.ProcessEnv;
}

async function fixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'qlb-gate-401-'));
  const env = { QLB_TEST_MODE: '1', HOME: home, USER: 'fixture-user' };
  const backend = new InMemoryCredentialBackend();
  const paths = claudePaths({ home, env });
  const live = { backend, paths, account: 'fixture-user', home, env };
  const dbPath = join(home, 'qlb.db');
  const store = openStore(dbPath);
  beginCutover(store);
  store.setActiveLogin('anthropic', 'account-a', 'fixture');
  const slots = new ClaudeSlots({
    backend,
    repository: SqliteClaudeSlotRepository.open(dbPath),
    stashDir: join(home, 'unclaimed'),
    now: () => NOW,
  });
  const initial = credential('slot');
  await slots.createSlot({ accountId: 'account-a', credential: initial, email: 'a@example.test', orgUuid: 'org-a', source: 'cswap-import' });
  await backend.set(paths.keychainService, 'fixture-user', initial);
  return { dbPath, store, slots, backend, live, env };
}

async function run(
  f: Fixture,
  retryAfter401Fp: string,
  refresh: NonNullable<AnthropicGateDeps['refresh']>,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const gate = createAnthropicGate({
    store: f.store, slots: f.slots, live: f.live, env: f.env, now: () => NOW,
    readLiveIdentity: () => ({ accountId: 'account-a', email: 'a@example.test', orgUuid: 'org-a' }),
    verdicts: new ProbeVerdictMemo(), refresh,
  });
  const code = await runPiGate('anthropic', {
    dbPath: f.dbPath, env: f.env, deliver: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined,
    provider: gate, cswapProcesses: () => [],
    retryAfter401Fp,
  });
  return { code, stdout, stderr };
}

const posted = (working: string): RefreshOutcome => ({ outcome: 'posted', working });

describe('Anthropic gate 401 recovery (K6b)', () => {
  it('an unchanged access fingerprint forces exactly one POST', async () => {
    const f = await fixture();
    let posts = 0;
    const result = await run(f, accessFingerprint('access-slot'), async () => {
      posts += 1;
      return posted(credential('rotated'));
    });
    assert.equal(result.code, 0);
    assert.equal(posts, 1);
    f.store.close();
  });

  it('two concurrent claims on the same fingerprint produce one POST', async () => {
    const f = await fixture();
    let posts = 0;
    const refresh: NonNullable<AnthropicGateDeps['refresh']> = async () => {
      posts += 1;
      return posted(credential('rotated'));
    };
    const fp = accessFingerprint('access-slot');
    const [first, second] = await Promise.all([run(f, fp, refresh), run(f, fp, refresh)]);
    assert.equal(posts, 1);
    assert.equal(first.code + second.code, 0);
    f.store.close();
  });

  it('a second claim inside the interval serves with 0 POSTs', async () => {
    const f = await fixture();
    let posts = 0;
    const refresh: NonNullable<AnthropicGateDeps['refresh']> = async () => {
      posts += 1;
      return posted(credential('rotated'));
    };
    await f.backend.set(f.live.paths.keychainService, f.live.account, credentialWithTokens('access-first', 'refresh-slot'));
    assert.equal((await run(f, accessFingerprint('access-first'), refresh)).code, 0);
    await f.backend.set(f.live.paths.keychainService, f.live.account, credentialWithTokens('access-second', 'refresh-slot'));
    assert.equal((await run(f, accessFingerprint('access-second'), refresh)).code, 0);
    assert.equal(posts, 1);
    f.store.close();
  });

  it('a changed fingerprint serves the rotated token with 0 POSTs', async () => {
    const f = await fixture();
    let posts = 0;
    const result = await run(f, accessFingerprint('different-access'), async () => {
      posts += 1;
      return posted(credential('rotated'));
    });
    assert.equal(result.code, 0);
    assert.equal(posts, 0);
    assert.equal(JSON.parse(result.stdout[0]!).token, 'access-slot');
    f.store.close();
  });

  it('a served token whose lineage is not the slot\'s is never forced', async () => {
    const f = await fixture();
    await f.slots.writeSlot('account-a', credential('slot-successor'), { cause: 'post', by: 'qlb-gate', evidence: 'post' });
    let posts = 0;
    const result = await run(f, accessFingerprint('access-slot'), async () => {
      posts += 1;
      return posted(credential('rotated'));
    });
    assert.equal(result.code, 0);
    assert.equal(posts, 0);
    f.store.close();
  });

  it('a dead slot is never forced', async () => {
    const f = await fixture();
    const row = f.slots.getSlot('account-a');
    assert.ok(row?.fingerprint);
    await f.slots.strikeDead('account-a', { reason: 'invalid_grant', struckFp: row.fingerprint, ts: NOW });
    let posts = 0;
    const result = await run(f, accessFingerprint('access-slot'), async () => {
      posts += 1;
      return posted(credential('rotated'));
    });
    assert.equal(result.code, 0);
    assert.equal(posts, 0);
    f.store.close();
  });

  it('a claim winner that starts no POST releases the claim and the next caller forces exactly one POST', async () => {
    const f = await fixture();
    const fp = accessFingerprint('access-slot');
    let calls = 0;
    const refresh: NonNullable<AnthropicGateDeps['refresh']> = async () => {
      calls += 1;
      return calls === 1
        ? { outcome: 'deferred', deferReason: 'locks-held' }
        : posted(credential('rotated'));
    };
    assert.equal((await run(f, fp, refresh)).code, 3);
    assert.equal(f.store.getConfig('pi.anthropic.forced401'), null);
    assert.equal((await run(f, fp, refresh)).code, 0);
    assert.equal(calls, 2);
    f.store.close();
  });

  it('a winner whose refresh throws releases the claim', async () => {
    const f = await fixture();
    const fp = accessFingerprint('access-slot');
    const result = await run(f, fp, async () => { throw new Error('fixture refresh failure'); });
    assert.equal(result.code, 1);
    assert.equal(f.store.getConfig('pi.anthropic.forced401'), null);
    f.store.close();
  });

  it('a spent grant followed by an active-login-stale refusal keeps the claim', async () => {
    const f = await fixture();
    const fp = accessFingerprint('access-slot');
    let posts = 0;
    const result = await run(f, fp, async () => {
      posts += 1;
      // A concurrent `qlb switch` lands as soon as the refresh drops its locks.
      f.store.setActiveLogin('anthropic', 'account-b', 'fixture');
      return posted(credential('rotated'));
    });
    assert.equal(result.code, 3);
    assert.equal(posts, 1);
    const row = JSON.parse(f.store.getConfig('pi.anthropic.forced401') ?? 'null') as { fp?: unknown; at?: unknown } | null;
    assert.equal(row?.fp, fp);
    assert.equal(row?.at, NOW);
    f.store.close();
  });

  it('a malformed forced401 row is replaced by the next claim', async () => {
    const f = await fixture();
    const fp = accessFingerprint('access-slot');
    for (const malformed of ['not-json', JSON.stringify({ fp, at: 'later', claimId: 'x' }), JSON.stringify({ at: NOW - 1_000_000 })]) {
      f.store.setConfig('pi.anthropic.forced401', malformed);
      const claim = claimForced401(f.store, 'account-a', fp, NOW);
      assert.ok(claim, malformed);
      assert.equal(claim.previous, malformed);
      const row = JSON.parse(f.store.getConfig('pi.anthropic.forced401') ?? 'null') as { fp?: unknown; at?: unknown; claimId?: unknown };
      assert.deepEqual(row, { fp, at: NOW, claimId: claim.claimId });
    }
    f.store.close();
  });

  it('a release never overwrites a newer claim', async () => {
    const f = await fixture();
    const claim = claimForced401(f.store, 'account-a', accessFingerprint('access-slot'), NOW);
    assert.ok(claim);
    const newer = JSON.stringify({ fp: accessFingerprint('newer'), at: NOW + 1, claimId: 'newer-claim' });
    f.store.setConfig('pi.anthropic.forced401', newer);
    releaseForced401(f.store, claim.claimId, claim.previous);
    assert.equal(f.store.getConfig('pi.anthropic.forced401'), newer);
    f.store.close();
  });

  it('startedPost is exhaustive over every RefreshOutcome variant', () => {
    const working = credential('working');
    const cases: Array<{ outcome: RefreshOutcome; expected: boolean }> = [
      { outcome: { outcome: 'posted', working }, expected: true },
      { outcome: { outcome: 'restored', working }, expected: false },
      { outcome: { outcome: 'adopted', working }, expected: false },
      { outcome: { outcome: 'posted-live-unwritten', working }, expected: true },
      { outcome: { outcome: 'posted-slot-unwritten', working }, expected: true },
      { outcome: { outcome: 'stashed', working }, expected: true },
      { outcome: { outcome: 'unpersisted', working, successorFailure: 'fixture' }, expected: true },
      { outcome: { outcome: 'failed', reason: 'refresh-failed' }, expected: true },
      { outcome: { outcome: 'failed', reason: 'invalid_client' }, expected: true },
      { outcome: { outcome: 'failed', reason: 'foreign-credential' }, expected: false },
      { outcome: { outcome: 'dead', reason: 'invalid_grant', struckFp: 'sha256:fixture' }, expected: true },
      { outcome: { outcome: 'dead', reason: 'no_refresh_token', struckFp: null }, expected: false },
      { outcome: { outcome: 'deferred', deferReason: 'locks-held' }, expected: false },
      { outcome: { outcome: 'refused', reason: 'store-unmirrored' }, expected: false },
    ];
    for (const entry of cases) assert.equal(startedPost(entry.outcome), entry.expected, entry.outcome.outcome);
  });
});
