// Ported from claude-swap 0.28.0 (MIT) — TestAddAccount*, TestDuplicateAccountDetection, test_add_account_identity.py
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { addClaudeLogin, type ClaudeAddResult } from '../src/cc-add';
import { ClaudeSlots, InMemoryClaudeSlotRepository, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { readClaudeLiveStateAtomically, runClaudeAddCommand } from '../src/commands/claude-add';
import { MockKeychain } from '../src/keychain';
import { beginCutover, transition } from '../src/lifecycle';
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
    beginCutover(store);
    store.close();
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    const backend = new MockKeychain();
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed'), now: () => 2_000 });
    await addClaudeLogin({ credential: credential('old'), config: config('account-a'), slots });
    await addClaudeLogin({ credential: credential('new'), config: config('account-a'), replace: 'account-a', slots });
    const predecessor = await backend.get('qlb:anthropic:account-a:prev', 'qlb');
    const unchanged = await addClaudeLogin({ credential: credential('new'), config: config('account-a'), replace: 'account-a', slots });
    assert.equal(unchanged.kind, 'already-current');
    assert.equal(await backend.get('qlb:anthropic:account-a:prev', 'qlb'), predecessor);
    repository.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT count(*) AS count FROM accounts WHERE id = 'account-a'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT count(*) AS count FROM lineage_log WHERE account_id = 'account-a' AND cause IN ('add', 'replace')").get() as { count: number }).count, 2);
      assert.equal((db.prepare("SELECT account_id, set_by FROM active_login WHERE provider = 'anthropic'").get() as { account_id: string; set_by: string }).account_id, 'account-a');
      assert.equal((db.prepare("SELECT count(*) AS count FROM relogin_events WHERE kind = 'identity-replaced'").get() as { count: number }).count, 2);
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

  it('refuses API keys, an absent accountUuid, and control characters before it writes a slot', async () => {
    const { slots } = fixture();
    await assert.rejects(addClaudeLogin({ credential: 'sk-ant-api-key', config: config('account-a'), slots }), /API key/);
    await assert.rejects(addClaudeLogin({ credential: credential('new'), config: { oauthAccount: {} }, slots }), /accountUuid/);
    await assert.rejects(addClaudeLogin({ credential: credential('new'), config: config('account-a\nforged'), slots }), /invalid accountUuid/);
    assert.deepEqual(slots.listSlots(), []);
  });

  it('stores only the oauthAccount block on both add and replace', async () => {
    const { slots } = fixture();
    const addedConfig: Record<string, unknown> = {
      ...config('account-a'),
      primaryApiKey: 'token-shaped-fixture-value',
      mcpServers: { fixture: { env: { TOKEN: 'another-token-shaped-fixture-value' } } },
    };
    const replacedConfig: Record<string, unknown> = {
      ...config('account-a'),
      customApiKeyResponses: ['token-shaped-fixture-value'],
    };

    await addClaudeLogin({ credential: credential('new'), config: addedConfig, slots });
    assert.deepEqual(JSON.parse(slots.listSlots()[0]!.configJson!), { oauthAccount: addedConfig.oauthAccount });
    await addClaudeLogin({ credential: credential('replaced'), config: replacedConfig, replace: 'account-a', slots });
    assert.deepEqual(JSON.parse(slots.listSlots()[0]!.configJson!), { oauthAccount: replacedConfig.oauthAccount });
  });

  it('makes an unchanged replace already current without a self-edge or predecessor write', async () => {
    const { slots, repository, backend } = fixture();
    await addClaudeLogin({ credential: credential('old'), config: config('account-a'), slots });
    await addClaudeLogin({ credential: credential('current'), config: config('account-a'), replace: 'account-a', slots });
    const before = repository.getSlot('account-a')!;
    const predecessor = await backend.get('qlb:anthropic:account-a:prev', 'qlb');
    const result = await addClaudeLogin({ credential: credential('current'), config: config('account-a'), replace: 'account-a', slots });

    assert.equal(result.kind, 'already-current');
    assert.equal(repository.getSlot('account-a')?.prevFingerprint, before.prevFingerprint);
    assert.equal(await backend.get('qlb:anthropic:account-a:prev', 'qlb'), predecessor);
    assert.equal(repository.transitions.length, 2);
    assert.notEqual(repository.transitions[1]!.fromFp, repository.transitions[1]!.toFp);
  });

  it('refuses add mode when an orphan slot Keychain item exists', async () => {
    const { slots, backend } = fixture();
    await backend.set('qlb:anthropic:account-a', 'qlb', credential('orphan'));
    await assert.rejects(addClaudeLogin({ credential: credential('new'), config: config('account-a'), slots }), /credential already exists/);
    assert.equal(await backend.get('qlb:anthropic:account-a', 'qlb'), credential('orphan'));
  });

  it('allows an archived identity to be added again and clears its archive', async () => {
    const { slots, repository, backend } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('old'), source: 'cswap-import' });
    // The in-memory repository returns copies, so install an archived fixture through its test map.
    const rows = (repository as unknown as { slots: Map<string, { archivedAt: number | null }> }).slots;
    rows.get('account-a')!.archivedAt = 1;
    await backend.delete('qlb:anthropic:account-a', 'qlb');
    await addClaudeLogin({ credential: credential('new'), config: config('account-a'), slots });
    assert.equal(repository.getSlot('account-a')?.archivedAt, null);

    rows.get('account-a')!.archivedAt = 2;
    await backend.delete('qlb:anthropic:account-a', 'qlb');
    await addClaudeLogin({ credential: credential('replacement'), config: config('account-a'), replace: 'account-a', slots });
    assert.equal(repository.getSlot('account-a')?.archivedAt, null);
  });

  it('refuses archived reactivation when its orphan credential still exists and clears a stale predecessor', async () => {
    const { slots, repository, backend } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('old'), source: 'cswap-import' });
    const rows = (repository as unknown as { slots: Map<string, { archivedAt: number | null }> }).slots;
    rows.get('account-a')!.archivedAt = 1;

    await assert.rejects(addClaudeLogin({ credential: credential('new'), config: config('account-a'), slots }), /credential already exists/);
    assert.equal(await backend.get('qlb:anthropic:account-a', 'qlb'), credential('old'));

    await backend.delete('qlb:anthropic:account-a', 'qlb');
    await backend.set('qlb:anthropic:account-a:prev', 'qlb', credential('stale'));
    await addClaudeLogin({ credential: credential('new'), config: config('account-a'), slots });
    await assert.rejects(backend.get('qlb:anthropic:account-a:prev', 'qlb'));
  });

  it('refuses an archived identity with a different --replace target at exit 3', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-add-archived-replace-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    beginCutover(store);
    store.close();
    const { slots, repository, backend } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('old'), source: 'cswap-import' });
    const rows = (repository as unknown as { slots: Map<string, { archivedAt: number | null }> }).slots;
    rows.get('account-a')!.archivedAt = 1;
    await backend.delete('qlb:anthropic:account-a', 'qlb');
    const output: string[] = [];

    const code = await runClaudeAddCommand(['--replace', 'account-b'], context(dbPath, output), {
      readLive: async () => ({ credential: credential('new'), config: config('account-a') }),
      add: async (input) => addClaudeLogin({ ...input, slots }),
    });

    assert.equal(code, 3);
    assert.match(output[0]!, /different identity/);
    assert.equal(repository.getSlot('account-a')?.archivedAt, 1);
    await assert.rejects(backend.get('qlb:anthropic:account-a', 'qlb'));
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

  it('locks the exact normal and legacy config file that it reads', async () => {
    for (const layout of ['normal', 'legacy'] as const) {
      const root = mkdtempSync(join(tmpdir(), `qlb-cc-add-${layout}-`));
      const configHome = join(root, '.claude');
      mkdirSync(configHome);
      const globalConfigPath = layout === 'normal' ? join(root, '.claude.json') : join(configHome, '.config.json');
      writeFileSync(globalConfigPath, '{}');
      if (layout === 'normal') writeFileSync(join(root, '.config.json'), 'unrelated');
      const expectedLock = `${globalConfigPath}.lock`;

      await readClaudeLiveStateAtomically({
        configHome, globalConfigPath,
        readCredential: async () => credential(layout),
        readConfig: () => {
          assert.equal(existsSync(expectedLock), true, `${layout} config lock is held`);
          return config(`account-${layout}`);
        },
      });
    }
  });

  it('reads the live credential and identity atomically, refusing a state change between reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-add-live-'));
    let liveCredential = credential('one');
    let liveConfig = config('account-a');
    let reads = 0;
    await assert.rejects(readClaudeLiveStateAtomically({
      configHome: join(root, '.claude'), globalConfigPath: join(root, '.claude.json'),
      readCredential: async () => liveCredential,
      readConfig: () => {
        reads += 1;
        if (reads === 1) {
          liveCredential = credential('two');
          liveConfig = config('account-b');
        }
        return liveConfig;
      },
    }), /live-state-inconsistent/);
  });

  it('re-checks admission in the write transaction after lifecycle changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-add-admission-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    beginCutover(store);
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    const backend = new MockKeychain();
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed') });
    const output: string[] = [];
    const code = await runClaudeAddCommand([], context(dbPath, output), {
      readLive: async () => {
        assert.equal(transition(store, 'cutover').ok, true);
        assert.equal(transition(store, 'undoing').ok, true);
        return { credential: credential('new'), config: config('account-a') };
      },
      add: async (input) => addClaudeLogin({ ...input, slots }),
    });
    assert.equal(code, 3);
    assert.match(output[0]!, /undo-in-progress/);
    assert.equal(repository.getSlot('account-a'), null);
    await assert.rejects(backend.get('qlb:anthropic:account-a', 'qlb'));
    repository.close();
    store.close();
  });

  it('qlb claude add names the account that already holds the login', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-add-duplicate-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    beginCutover(store);
    store.close();
    const { slots, repository } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('shared'), source: 'cswap-import' });
    const output: string[] = [];

    const code = await runClaudeAddCommand([], context(dbPath, output), {
      readLive: async () => ({ credential: credential('shared'), config: config('account-b') }),
      add: async (input) => addClaudeLogin({ ...input, slots }),
    });

    assert.equal(code, 3);
    assert.match(output[0]!, /already belongs to slot account-a/);
    assert.equal(repository.getSlot('account-b'), null);
  });

  it('replacing an account with its own login is not refused when a legacy store also holds that login elsewhere', async () => {
    const { slots, repository, backend } = fixture();
    await slots.createSlot({ accountId: 'account-b', credential: credential('shared'), source: 'cswap-import' });
    // A store written before K3-r can hold a second slot on the same lineage; seed it directly.
    repository.createSlot({ ...slots.getSlot('account-b')!, accountId: 'account-a', slotNum: null });
    await backend.set('qlb:anthropic:account-a', 'qlb', credential('shared'));

    const result = await addClaudeLogin({ credential: credential('shared'), config: config('account-b'), slots, replace: 'account-b' });
    assert.equal(result.accountId, 'account-b');
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
