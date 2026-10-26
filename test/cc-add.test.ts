// Ported from claude-swap 0.28.0 (MIT) — TestAddAccount*, TestDuplicateAccountDetection, test_add_account_identity.py
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { addClaudeLogin, type ClaudeAddResult } from '../src/cc-add';
import { ClaudeSlots, InMemoryClaudeSlotRepository, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { runClaudeAddCommand } from '../src/commands/claude-add';
import { MockKeychain } from '../src/keychain';
import { beginCutover } from '../src/lifecycle';
import { openStore } from '../src/store';
import type { CommandContext } from '../src/registry';

function credential(tag: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}` } });
}

function config(accountId: string, email = `${accountId}@example.test`): Record<string, unknown> {
  return { oauthAccount: { accountUuid: accountId, emailAddress: email, organizationUuid: 'org-1' } };
}

function fixture() {
  const repository = new InMemoryClaudeSlotRepository();
  const backend = new MockKeychain();
  const slots = new ClaudeSlots({
    backend,
    repository,
    stashDir: join(mkdtempSync(join(tmpdir(), 'qlb-cc-add-')), 'unclaimed'),
    now: () => 1_000,
  });
  return { repository, backend, slots };
}

function context(dbPath: string, output: string[]): CommandContext {
  return {
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(`ERR:${line}`),
    env: { QLB_TEST_MODE: '1', QLB_HOME: '/fixture' },
    config: { dbPath } as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); },
    home: '/fixture',
    registerSecret: () => {},
    deliverSecret: () => {},
    knownSecrets: () => [],
  };
}

describe('qlb claude add (K11 / AC32)', () => {
  it('adds a new identity as a slot, account, lineage, and adopted active login', async () => {
    const { slots, repository } = fixture();
    const result = await addClaudeLogin({ credential: credential('new'), config: config('account-a'), slots });

    assert.deepEqual(result, { kind: 'added', accountId: 'account-a', slotNum: 1 });
    assert.equal(repository.getSlot('account-a')?.source, 'qlb-add');
    assert.equal(repository.getSlot('account-a')?.alias, null);
    assert.deepEqual(repository.transitions.map((row) => [row.cause, row.evidence]), [['add', 'identity']]);
    assert.deepEqual(repository.accounts, [{ id: 'account-a', provider: 'anthropic', label: 'account-a@example.test', status: 'active' }]);
    assert.deepEqual(repository.activeLogin, { provider: 'anthropic', accountId: 'account-a', setBy: 'adopt' });
  });

  it('commits the SQL slot, account, lineage, active login, and relogin effects together', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-add-sqlite-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    store.close();
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    const slots = new ClaudeSlots({ backend: new MockKeychain(), repository, stashDir: join(root, 'unclaimed'), now: () => 2_000 });
    await addClaudeLogin({ credential: credential('old'), config: config('account-a'), slots });
    await addClaudeLogin({ credential: credential('new'), config: config('account-a'), replace: 'account-a', slots });
    repository.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT count(*) AS count FROM accounts WHERE id = 'account-a'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT count(*) AS count FROM lineage_log WHERE account_id = 'account-a' AND cause IN ('add', 'replace')").get() as { count: number }).count, 2);
      assert.equal((db.prepare("SELECT account_id, set_by FROM active_login WHERE provider = 'anthropic'").get() as { account_id: string; set_by: string }).account_id, 'account-a');
      assert.equal((db.prepare("SELECT count(*) AS count FROM relogin_events WHERE kind = 'identity-replaced'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT dead, healed_at FROM claude_slots WHERE account_id = 'account-a'").get() as { dead: number; healed_at: number }).dead, 0);
    } finally { db.close(); }
  });

  it('refuses the same identity without --replace and leaves the stored credential alone', async () => {
    const { slots } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('old'), source: 'cswap-import' });

    await assert.rejects(addClaudeLogin({ credential: credential('new'), config: config('account-a'), slots }), /already exists/);
    assert.equal((await slots.readSlot('account-a')).credential, credential('old'));
  });

  it('replaces only the same identity, heals it, and always records identity-replaced', async () => {
    const { slots, repository } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('old'), slotNum: 1, source: 'cswap-import' });
    repository.markDead('account-a');

    const result = await addClaudeLogin({ credential: credential('new'), config: config('account-a'), replace: 'account-a', slots });
    assert.deepEqual(result, { kind: 'replaced', accountId: 'account-a', slotNum: 1 });
    assert.equal(repository.getSlot('account-a')?.dead, false);
    assert.equal(repository.getSlot('account-a')?.healedAt, 1_000);
    assert.deepEqual(repository.transitions.map((row) => row.cause), ['import', 'replace']);
    assert.deepEqual(repository.relogins, [{ provider: 'anthropic', accountId: 'account-a', kind: 'identity-replaced' }]);
  });

  it('refuses a cross-identity --replace without changing either slot', async () => {
    const { slots } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('a'), source: 'cswap-import' });
    await slots.createSlot({ accountId: 'account-b', credential: credential('b'), source: 'cswap-import' });

    await assert.rejects(addClaudeLogin({ credential: credential('new'), config: config('account-a'), replace: 'account-b', slots }), /different identity/);
    assert.equal((await slots.readSlot('account-a')).credential, credential('a'));
    assert.equal((await slots.readSlot('account-b')).credential, credential('b'));
  });

  it('refuses API keys and an absent accountUuid before it writes a slot', async () => {
    const { slots } = fixture();
    await assert.rejects(addClaudeLogin({ credential: 'sk-ant-api-key', config: config('account-a'), slots }), /API key/);
    await assert.rejects(addClaudeLogin({ credential: credential('new'), config: { oauthAccount: {} }, slots }), /accountUuid/);
    assert.deepEqual(slots.listSlots(), []);
  });

  it('is refused in pre-cutover and does not read the live credential', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-add-command-'));
    const dbPath = join(root, 'qlb.db');
    const output: string[] = [];
    let reads = 0;
    const code = await runClaudeAddCommand([], context(dbPath, output), {
      readLive: async () => { reads += 1; return { credential: credential('new'), config: config('account-a') }; },
      add: async () => { throw new Error('must not add'); },
    });
    assert.equal(code, 3);
    assert.equal(reads, 0);
    assert.match(output[0]!, /phase=pre-cutover/);
  });

  it('parses strict arguments and turns a cross-identity replacement into exit 3', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-add-command-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    beginCutover(store);
    store.close();
    const output: string[] = [];
    const rejected = new Error('replace target belongs to a different identity');
    const code = await runClaudeAddCommand(['--replace', 'account-b', '--alias', 'work'], context(dbPath, output), {
      readLive: async () => ({ credential: credential('new'), config: config('account-a') }),
      add: async (): Promise<ClaudeAddResult> => { throw rejected; },
    });
    assert.equal(code, 3);
    assert.match(output[0]!, /different identity/);
    assert.equal(await runClaudeAddCommand(['--alias'], context(dbPath, output), {
      readLive: async () => { throw new Error('must not read'); }, add: async () => { throw new Error('must not add'); },
    }), 2);
  });
});
