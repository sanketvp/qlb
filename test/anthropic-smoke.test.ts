import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { credential as claudeCredential } from './support/claude-fixtures';
import { InMemoryCredentialBackend } from '../src/cc-credentials';
import { claudePaths } from '../src/cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { createAnthropicGate } from '../src/gate/anthropic';
import { beginCutover } from '../src/lifecycle';
import { formatAnthropicSmoke, projectAnthropicSmoke } from '../src/anthropic-receipt';
import { runPiGate } from '../src/pi-gate';
import { openStore } from '../src/store';
import { ownedSmokeResync, streamWithAuthRetry } from '../extensions/qlb-pi/auth-retry';

const NOW = 1_700_000_000_000;
const ACCOUNT = 'account-a';

async function gateFixture(blob: string) {
  const home = mkdtempSync(join(tmpdir(), 'qlb-r1b-smoke-'));
  const env = { QLB_TEST_MODE: '1', HOME: home, USER: 'fixture-user' };
  const backend = new InMemoryCredentialBackend();
  const paths = claudePaths({ home, env });
  const dbPath = join(home, 'qlb.db');
  const store = openStore(dbPath);
  beginCutover(store);
  store.setActiveLogin('anthropic', ACCOUNT, 'fixture', NOW);
  const slots = new ClaudeSlots({
    backend,
    repository: SqliteClaudeSlotRepository.open(dbPath),
    stashDir: join(home, 'unclaimed'),
    now: () => NOW,
  });
  await slots.createSlot({
    accountId: ACCOUNT, credential: blob, email: 'a@example.test', orgUuid: 'org-a', source: 'cswap-import',
  });
  await backend.set(paths.keychainService, 'fixture-user', blob);
  const posts: string[] = [];
  const gate = createAnthropicGate({
    store, slots, live: { backend, paths, account: 'fixture-user', home, env }, env, now: () => NOW,
    readLiveIdentity: () => ({ accountId: ACCOUNT, email: 'a@example.test', orgUuid: 'org-a' }),
    postRefresh: async () => { posts.push('post'); return { status: 200, body: '{}' }; },
    refresh: async () => { posts.push('refresh'); throw new Error('refresh-called'); },
  });
  return {
    dbPath, store, gate, posts, home,
    close: () => { store.close(); rmSync(home, { recursive: true, force: true }); },
  };
}

async function read(fixture: Awaited<ReturnType<typeof gateFixture>>, noRefresh: boolean, retryAfter401Fp?: string) {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const code = await runPiGate('anthropic', {
    dbPath: fixture.dbPath,
    env: fixture.gate ? { QLB_TEST_MODE: '1', QLB_PI_TOKEN_CALL: '1' } : {},
    deliver: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    guard: () => true,
    admitted: () => ({ ok: true }),
    prerequisites: () => undefined,
    provider: fixture.gate,
    cswapProcesses: () => [],
    ...(noRefresh ? { noRefresh: true } : {}),
    ...(retryAfter401Fp === undefined ? {} : { retryAfter401Fp }),
  });
  return { code, stderr, stdout };
}

describe('bounded owned smoke', () => {
  it('smoke success: one messages call, zero refresh POST', async () => {
    const calls: string[] = [];
    const previous = process.env.QLB_PI_OWNED_SMOKE;
    process.env.QLB_PI_OWNED_SMOKE = '1';
    try {
      const result = await streamWithAuthRetry({
        readAccess: () => 'token',
        startStream: () => {
          calls.push('messages');
          return (async function* success() {
            yield { type: 'done', message: { stopReason: 'stop' } };
          })();
        },
        resync: async () => ownedSmokeResync() ?? { resynced: true, reason: 'should-not-run' },
        onEvent: () => undefined,
        onResync: () => undefined,
      });
      assert.equal(result.retried, false);
      assert.deepEqual(calls, ['messages']);
      assert.deepEqual(ownedSmokeResync(), { resynced: false, reason: 'owned-smoke-no-retry' });
    } finally {
      if (previous === undefined) delete process.env.QLB_PI_OWNED_SMOKE;
      else process.env.QLB_PI_OWNED_SMOKE = previous;
    }
  });

  it('smoke first 401: no refresh, no retry', async () => {
    const calls: string[] = [];
    const previous = process.env.QLB_PI_OWNED_SMOKE;
    process.env.QLB_PI_OWNED_SMOKE = '1';
    try {
      await streamWithAuthRetry({
        readAccess: () => 'token',
        startStream: () => {
          calls.push('messages');
          return (async function* failed() {
            yield { type: 'error', error: { message: '401 authentication_error' } };
          })();
        },
        resync: async () => {
          calls.push('resync');
          return ownedSmokeResync() ?? { resynced: true, reason: 'refreshed' };
        },
        onEvent: () => undefined,
        onResync: () => undefined,
      });
      assert.deepEqual(calls, ['messages', 'resync']);
      assert.equal(calls.filter((call) => call === 'messages').length, 1);
    } finally {
      if (previous === undefined) delete process.env.QLB_PI_OWNED_SMOKE;
      else process.env.QLB_PI_OWNED_SMOKE = previous;
    }
  });

  it('smoke expired live token (inside 5-min buffer): smoke-token-expired, zero POST', async () => {
    const fixture = await gateFixture(claudeCredential('live', { expiresAt: NOW + 4 * 60 * 1000 }));
    try {
      const result = await read(fixture, true);
      assert.equal(result.code, 1);
      assert.deepEqual(result.stderr, ['smoke-token-expired']);
      assert.deepEqual(fixture.posts, []);
    } finally {
      fixture.close();
    }
  });

  it('smoke live token without expiresAt: smoke-token-expiry-unknown, zero POST', async () => {
    const fixture = await gateFixture(claudeCredential('live'));
    try {
      const result = await read(fixture, true);
      assert.equal(result.code, 1);
      assert.deepEqual(result.stderr, ['smoke-token-expiry-unknown']);
      assert.deepEqual(fixture.posts, []);
    } finally {
      fixture.close();
    }
  });

  it('smoke account change refuses', () => {
    const previous = process.env.QLB_PI_OWNED_SMOKE;
    process.env.QLB_PI_OWNED_SMOKE = '1';
    try {
      assert.deepEqual(ownedSmokeResync(), { resynced: false, reason: 'owned-smoke-no-retry' });
    } finally {
      if (previous === undefined) delete process.env.QLB_PI_OWNED_SMOKE;
      else process.env.QLB_PI_OWNED_SMOKE = previous;
    }
    assert.equal(ownedSmokeResync(), null);
  });

  it('non-smoke path unchanged', async () => {
    const fixture = await gateFixture(claudeCredential('live', { expiresAt: NOW + 2 * 60 * 60 * 1000 }));
    try {
      const result = await read(fixture, false);
      assert.equal(result.code, 0);
      assert.deepEqual(fixture.posts, []);
      assert.equal(fixture.store.getConfig('pi.anthropic.lastServedAccountId'), ACCOUNT);
    } finally {
      fixture.close();
    }
  });

  it('smoke receipt prints alias only', () => {
    const slotId = 'slot-secret-account';
    const receipt = projectAnthropicSmoke({
      state: 'QLB_OWNED',
      servedAccountId: slotId,
      journalDetail: {
        adoptionBinding: {
          version: 1,
          cycle: 'cycle-secret',
          initialActiveAlias: 'member-0002',
          members: [
            { alias: 'member-0001', slotAccountId: 'other-secret' },
            { alias: 'member-0002', slotAccountId: slotId },
          ],
        },
      },
    });
    const text = formatAnthropicSmoke(receipt, true);
    assert.deepEqual(JSON.parse(text), {
      schemaVersion: 1,
      phase: 'smoke',
      disposition: 'success',
      servedAlias: 'member-0002',
      matchesInitialActive: true,
      servedAfterCommit: true,
    });
    assert.equal(text.includes(slotId), false);
    assert.equal(text.includes('cycle-secret'), false);
    assert.equal(text.includes('other-secret'), false);
  });
});
