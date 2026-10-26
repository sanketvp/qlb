import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { consumeCodexSlot } from '../src/codex-consume';
import { runCodexRefreshCommand } from '../src/commands/codex-refresh';
import { codexFingerprint, type CodexAuthDocument } from '../src/codex-auth';
import type { CodexProcess } from '../src/codex-sessions';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(refresh = 'refresh-a', access = 'access-a'): CodexAuthDocument {
  return {
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-a', chatgpt_account_id: 'account-a' } }),
      access_token: jwt({ exp: 2_000_000_000, sub: access }),
      refresh_token: refresh,
      account_id: 'account-a',
    },
    last_refresh: '2026-10-24T12:00:00.000Z',
  };
}

function slots(initial: CodexAuthDocument) {
  let current = initial;
  const writes: CodexAuthDocument[] = [];
  return {
    slots: {
      readSlot: () => ({ document: current, fingerprint: codexFingerprint(current) }),
      writeSlot: (_accountId: string, next: CodexAuthDocument) => { current = next; writes.push(next); },
      stashUnclaimed: () => 'fixture-stash',
    },
    writes,
    current: () => current,
  };
}

const holder: CodexProcess = { pid: 741, lstart: 'Fri Oct 24 12:00:00 2026', host: 'codex' };

describe('Codex consume gate — AC34', () => {
  it('does not POST when an S12 holder may renew the inactive slot', async () => {
    const fixture = slots(document());
    let posts = 0;

    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a',
      snapshot: fixture.current(),
      trigger: 'scheduled',
      slots: fixture.slots,
      holders: async () => [holder],
      transport: async () => { posts += 1; return { status: 200, body: '{}' }; },
      now: () => Date.parse('2026-10-24T12:01:00.000Z'),
    });

    assert.deepEqual(result, { status: 'held', holders: [741] });
    assert.equal(posts, 0);
    assert.equal(fixture.writes.length, 0);
  });

  it('serializes concurrent inactive consumers so one POST produces the winner', async () => {
    const fixture = slots(document());
    let posts = 0;
    let release!: () => void;
    const sent = new Promise<void>((resolve) => { release = resolve; });
    const input = () => consumeCodexSlot({
      accountId: 'user-a:account-a',
      snapshot: document(),
      trigger: 'scheduled',
      slots: fixture.slots,
      holders: async () => [],
      transport: async () => {
        posts += 1;
        await sent;
        return { status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: jwt({ exp: 2_000_000_000, sub: 'access-b' }) }) };
      },
      now: () => Date.parse('2026-10-24T12:01:00.000Z'),
    });

    const first = input();
    const second = input();
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      assert.equal(posts, 1);
    } finally {
      release();
    }
    assert.equal((await first).status, 'refreshed');
    assert.equal((await second).status, 'fresh');
    assert.equal(posts, 1);
  });

  it('uses forced refresh_reason, persists its successor first, and records post lineage', async () => {
    const fixture = slots(document());
    const events: string[] = [];
    let body = '';

    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a',
      snapshot: fixture.current(),
      trigger: 'force',
      force: true,
      slots: fixture.slots,
      holders: async () => [],
      transport: async (request) => {
        body = request.body ?? '';
        return { status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: 'access-b' }) };
      },
      record: (event) => events.push(event.kind),
      now: () => Date.parse('2026-10-24T12:01:00.000Z'),
    });

    assert.equal(result.status, 'refreshed');
    assert.equal(JSON.parse(body).refresh_reason, 'forced');
    assert.equal(fixture.writes.length, 1);
    assert.deepEqual(events, ['post']);
  });

  it('uses N8 to return a peer successor without POSTing it again', async () => {
    const fixture = slots(document('refresh-b', 'access-b'));
    let posts = 0;

    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a',
      snapshot: document('refresh-a', 'access-a'),
      trigger: 'scheduled',
      slots: fixture.slots,
      holders: async () => [],
      transport: async () => { posts += 1; return { status: 200, body: '{}' }; },
      now: () => Date.parse('2026-10-24T12:01:00.000Z'),
    });

    assert.equal(result.status, 'fresh');
    assert.equal(posts, 0);
  });

  it('returns a typed unpersisted-successor outcome when every post-POST persistence path fails', async () => {
    const fixture = slots(document());
    fixture.slots.writeSlot = () => { throw new Error('fixture keychain unavailable'); };
    (fixture.slots as unknown as { stashUnclaimed: () => never }).stashUnclaimed = () => { throw new Error('fixture stash unavailable'); };

    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a', snapshot: fixture.current(), trigger: 'force', force: true,
      slots: fixture.slots, holders: async () => [], now: () => 1,
      transport: async () => ({ status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: 'access-b' }) }),
    });

    assert.equal(result.status, 'successor-unpersisted');
    assert.equal(result.successorFailure?.kind, 'successor-unpersisted');
  });

  it('adopts a matching stashed successor before it can POST the spent predecessor', async () => {
    const fixture = slots(document());
    let posts = 0;
    (fixture.slots as typeof fixture.slots & { adoptStashedSuccessor: (accountId: string, restore: (next: CodexAuthDocument) => void) => Promise<boolean> }).adoptStashedSuccessor = async (_accountId: string, restore: (next: CodexAuthDocument) => void) => {
      restore(document('refresh-b', 'access-b'));
      return true;
    };

    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a', snapshot: fixture.current(), trigger: 'scheduled',
      slots: fixture.slots, holders: async () => [], now: () => 1,
      transport: async () => { posts += 1; return { status: 500, body: '{}' }; },
    });

    assert.equal(result.status, 'fresh');
    assert.equal(posts, 0);
  });

  it('treats a C9 reuse response as dead evidence even while a holder exists', async () => {
    const fixture = slots(document());
    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a', snapshot: fixture.current(), trigger: 'force', force: true, allowHeld: true,
      slots: fixture.slots, holders: async () => [holder], now: () => 1,
      transport: async () => ({ status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) }),
    });
    assert.equal(result.status, 'dead');
  });

  it('refuses a forced refresh of the active Codex slot', async () => {
    let called = 0;
    const errors: string[] = [];
    const code = await runCodexRefreshCommand(['user-a:account-a', '--force'], {
      getConfig: () => null,
      isActive: () => true,
      consume: async () => { called += 1; return { status: 'refreshed' }; },
      write: () => assert.fail('must not report success'),
      error: (line) => errors.push(line),
    });
    assert.equal(code, 3);
    assert.equal(called, 0);
    assert.match(errors[0] ?? '', /active-slot/);
  });

  it('allows --c9 only for an unverified recorded A JWT and only then bypasses holders', async () => {
    const fixture = slots(document());
    let posts = 0;
    const consume = async (input: { allowHeld: boolean }) => {
      posts += 1;
      assert.equal(input.allowHeld, true);
      return { status: 'refreshed' as const };
    };
    const output: string[] = [];

    const code = await runCodexRefreshCommand(['user-a:account-a', '--force', '--c9', '--json'], {
      getConfig: (key) => key === 'codex.l13.aJwtExp' ? '1700000000000' : null,
      consume,
      write: (line) => output.push(line),
      error: () => assert.fail('unexpected command error'),
    });
    assert.equal(code, 0);
    assert.equal(posts, 1);
    assert.deepEqual(JSON.parse(output[0]), { accountId: 'user-a:account-a', status: 'refreshed' });

    const rejected = await runCodexRefreshCommand(['user-a:account-a', '--force', '--c9'], {
      getConfig: () => null,
      consume,
      write: () => assert.fail('must not write success'),
      error: (line) => output.push(line),
    });
    assert.equal(rejected, 3);
    assert.equal(posts, 1);
    assert.match(output.at(-1) ?? '', /c9-unavailable/);
  });
});
