// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — tests/test_backup_read_pacing.py
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ClaudeSlots,
  InMemoryClaudeSlotRepository,
  SqliteClaudeSlotRepository,
  type ClaudeSlot,
  type ClaudeSlotBackend,
  type ClaudeSlotRepository,
  type LineageAppend,
} from '../src/cc-slots';
import { KeychainBackedOff, KeychainReadBackoff, MockKeychain } from '../src/keychain';
import { credentialFingerprint } from '../src/anthropic-oauth';
import { listReloginEvents } from '../src/relogin';
import { reloginDetailFingerprint } from '../src/relogin-fields';
import { beginCutover } from '../src/lifecycle';
import { openStore } from '../src/store';

function credential(tag: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}` } });
}

function failNextCommit(repository: SqliteClaudeSlotRepository): void {
  const db = (repository as unknown as { db: { exec(sql: string): void } }).db;
  const exec = db.exec.bind(db);
  let pending = true;
  db.exec = (sql: string): void => {
    if (pending && sql === 'COMMIT') {
      pending = false;
      throw new Error('fixture commit failed');
    }
    exec(sql);
  };
}

async function assertMissing(backend: ClaudeSlotBackend, service: string): Promise<void> {
  await assert.rejects(backend.get(service, 'qlb'));
}

class CountingBackend implements ClaudeSlotBackend {
  readonly kind = 'test-memory' as const;
  readonly inner = new MockKeychain();
  gets = 0;
  sets: Array<{ service: string; account: string }> = [];
  failReads = false;

  async get(service: string, account: string): Promise<string> {
    this.gets += 1;
    if (this.failReads) throw new Error('fixture unavailable');
    return this.inner.get(service, account);
  }

  async set(service: string, account: string, value: string): Promise<void> {
    this.sets.push({ service, account });
    return this.inner.set(service, account, value);
  }

  async delete(service: string, account: string): Promise<void> {
    return this.inner.delete(service, account);
  }
}

function fixture(now: () => number = () => 1_000): {
  slots: ClaudeSlots;
  backend: CountingBackend;
  repo: InMemoryClaudeSlotRepository;
} {
  const backend = new CountingBackend();
  const repo = new InMemoryClaudeSlotRepository();
  return {
    slots: new ClaudeSlots({
      backend,
      repository: repo,
      stashDir: join(mkdtempSync(join(tmpdir(), 'qlb-cc-slots-')), 'unclaimed'),
      now,
      readBackoff: new KeychainReadBackoff({ now }),
    }),
    backend,
    repo,
  };
}

describe('Claude slots (K2)', () => {
  it('persists a slot, preserves its predecessor, and appends the lineage transition', async () => {
    const { slots, backend, repo } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const first = await slots.readSlot('account-a', { fresh: true });
    await slots.writeSlot('account-a', credential('two'), { cause: 'post' });

    assert.equal(await backend.get('qlb:anthropic:account-a:prev', 'qlb'), credential('one'));
    assert.equal((await slots.readSlot('account-a', { fresh: true })).credential, credential('two'));
    assert.equal(repo.getSlot('account-a')?.prevFingerprint, first.fingerprint);
    assert.deepEqual(repo.transitions.map((row) => row.cause), ['import', 'post']);
    assert.equal(repo.generation, 2);
  });

  it('two account ids with the same refresh token → creation refused', async () => {
    const { slots, backend, repo } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('shared'), source: 'cswap-import' });

    await assert.rejects(
      slots.createSlot({ accountId: 'account-b', credential: credential('shared'), source: 'cswap-import' }),
      /account-a/,
    );

    assert.deepEqual(backend.sets, [{ service: 'qlb:anthropic:account-a', account: 'qlb' }]);
    assert.equal(repo.listSlots().length, 1);
  });

  it('add --replace onto another account\'s refresh-token lineage is refused', async () => {
    const { slots, backend, repo } = fixture();
    await slots.applyAdd({
      accountId: 'account-a', credential: credential('shared'), email: null, alias: null, orgUuid: null,
      configJson: '{}', replace: false,
    });
    await slots.applyAdd({
      accountId: 'account-b', credential: credential('other'), email: null, alias: null, orgUuid: null,
      configJson: '{}', replace: false,
    });

    await assert.rejects(
      slots.applyAdd({
        accountId: 'account-b', credential: credential('shared'), email: null, alias: null, orgUuid: null,
        configJson: '{}', replace: true,
      }),
      /account-a/,
    );

    assert.deepEqual(backend.sets.map(({ service, account }) => ({ service, account })), [
      { service: 'qlb:anthropic:account-a', account: 'qlb' },
      { service: 'qlb:anthropic:account-b', account: 'qlb' },
    ]);
    assert.equal(repo.getSlot('account-b')?.fingerprint, credentialFingerprint(credential('other')));
  });

  it('an archived slot\'s lineage does not block a new slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-slot-archived-lineage-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    store.close();
    const backend = new CountingBackend();
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });
    await slots.createSlot({ accountId: 'account-a', credential: credential('shared'), source: 'cswap-import' });
    const db = (repository as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): void } } }).db;
    db.prepare('UPDATE claude_slots SET archived_at = 1 WHERE account_id = ?').run('account-a');

    await slots.createSlot({ accountId: 'account-b', credential: credential('shared'), source: 'cswap-import' });

    assert.equal(repository.listSlots().length, 2);
    assert.equal(repository.getSlot('account-b')?.fingerprint, credentialFingerprint(credential('shared')));
    repository.close();
  });

  it('persists Claude slot CRUD in the v5 SQLite tables', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-slot-db-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    store.close();
    const backend = new CountingBackend();
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });

    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), slotNum: 2, source: 'cswap-import' });
    await slots.writeSlot('account-a', credential('two'), { cause: 'import', evidence: 'import' });
    repository.close();

    const reopened = SqliteClaudeSlotRepository.open(dbPath);
    assert.equal(reopened.getSlot('account-a')?.slotNum, 2);
    assert.equal(reopened.getSlot('account-a')?.prevFingerprint !== null, true);
    assert.equal(reopened.listSlots().length, 1);
    reopened.close();
  });

  it('persists a computed slot number when reactivating an archived SQLite row with NULL slot_num', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-slot-reactivate-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    beginCutover(store);
    store.close();
    const backend = new CountingBackend();
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });
    await slots.createSlot({ accountId: 'account-a', credential: credential('old'), source: 'cswap-import' });
    const db = (repository as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): void } } }).db;
    db.prepare('UPDATE claude_slots SET archived_at = 1 WHERE account_id = ?').run('account-a');
    await backend.delete('qlb:anthropic:account-a', 'qlb');

    const result = await slots.applyAdd({
      accountId: 'account-a', credential: credential('new'), email: null, alias: null, orgUuid: null,
      configJson: '{}', replace: false,
    });
    assert.equal(result.slotNum, 1);
    repository.close();

    const reopened = SqliteClaudeSlotRepository.open(dbPath);
    assert.equal(reopened.getSlot('account-a')?.slotNum, 1);
    reopened.close();
  });

  it('takes the shared switch lock around an add slot write', async () => {
    const backend = new CountingBackend();
    const repo = new InMemoryClaudeSlotRepository();
    let switchLockCalls = 0;
    const slots = new ClaudeSlots({
      backend, repository: repo, stashDir: join(mkdtempSync(join(tmpdir(), 'qlb-cc-slots-')), 'unclaimed'), now: () => 1_000,
      withSwitchLock: async (fn) => {
        switchLockCalls += 1;
        return fn();
      },
    });

    await slots.applyAdd({
      accountId: 'account-a', credential: credential('one'), email: null, alias: null, orgUuid: null,
      configJson: '{}', replace: false,
    });
    assert.equal(switchLockCalls, 1);
  });

  it('uses one Keychain read for cached displays within sixty seconds', async () => {
    let now = 1_000;
    const { slots, backend } = fixture(() => now);
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    backend.gets = 0;

    await slots.readSlot('account-a', { cached: true });
    await slots.readSlot('account-a', { cached: true });
    await slots.readSlot('account-a', { cached: true });
    assert.equal(backend.gets, 1);

    now += 60_001;
    await slots.readSlot('account-a');
    assert.equal(backend.gets, 2);
  });

  it('drops a cached display after its own write', async () => {
    const { slots, backend } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    backend.gets = 0;
    await slots.readSlot('account-a', { cached: true });
    await slots.writeSlot('account-a', credential('two'), { cause: 'post' });
    const afterWrite = backend.gets;
    await slots.readSlot('account-a', { cached: true });
    assert.equal(backend.gets, afterWrite + 1);
  });

  it('does not cache failed reads and fresh reads bypass the failure backoff', async () => {
    const { slots, backend } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    backend.failReads = true;
    await assert.rejects(slots.readSlot('account-a', { cached: true }), /fixture unavailable/);
    await assert.rejects(slots.readSlot('account-a', { cached: true }), KeychainBackedOff);

    backend.failReads = false;
    const fresh = await slots.readSlot('account-a', { fresh: true });
    assert.equal(fresh.credential, credential('one'));
    assert.equal(backend.gets, 3);
  });

  it('defaults to fresh reads and makes display caching explicit', async () => {
    const { slots, backend } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    backend.gets = 0;
    await slots.readSlot('account-a');
    await slots.readSlot('account-a');
    assert.equal(backend.gets, 2);
    await slots.readSlot('account-a', { cached: true });
    await slots.readSlot('account-a', { cached: true });
    assert.equal(backend.gets, 3);
  });

  it('does not arm the cached-read backoff for an absent credential', async () => {
    const { slots } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    assert.equal((await slots.readSlot('account-a', { cached: true })).credential, credential('one'));
  });

  it('preserves :prev on an idempotent lineage write', async () => {
    const { slots, backend, repo } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    await slots.writeSlot('account-a', credential('two'), { cause: 'post' });
    const previous = await backend.get('qlb:anthropic:account-a:prev', 'qlb');
    const before = repo.getSlot('account-a')!;
    await slots.writeSlot('account-a', credential('two'), { cause: 'post' });
    assert.equal(await backend.get('qlb:anthropic:account-a:prev', 'qlb'), previous);
    assert.equal(repo.getSlot('account-a')?.prevFingerprint, before.prevFingerprint);
    assert.equal(repo.transitions.length, 2);
  });

  it('persists a refresh blob when only access-token fields changed', async () => {
    const { slots, backend, repo } = fixture();
    const before = JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh-stable', accessToken: 'access-old', expiresAt: 1 } });
    const refreshed = JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh-stable', accessToken: 'access-new', expiresAt: 2 } });
    await slots.createSlot({ accountId: 'account-a', credential: before, source: 'cswap-import' });

    await slots.writeSlot('account-a', refreshed, { cause: 'post' });

    assert.equal((await slots.readSlot('account-a', { fresh: true })).credential, refreshed);
    assert.equal(await backend.get('qlb:anthropic:account-a:prev', 'qlb'), before);
    assert.equal(repo.generation, 2);
  });

  it('preserves the predecessor and DB lineage after retrying a crash-window drift', async () => {
    const { slots, backend, repo } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    await slots.writeSlot('account-a', credential('two'), { cause: 'post' });
    // Simulate a crash after Keychain writes but before their metadata commit.
    await backend.set('qlb:anthropic:account-a:prev', 'qlb', credential('two'));
    await backend.set('qlb:anthropic:account-a', 'qlb', credential('three'));

    await slots.writeSlot('account-a', credential('three'), { cause: 'post' });

    assert.equal(await backend.get('qlb:anthropic:account-a:prev', 'qlb'), credential('two'));
    assert.equal(repo.getSlot('account-a')?.prevFingerprint, credentialFingerprint(credential('two')));
    assert.deepEqual(repo.transitions.at(-1), {
      ts: 1_000, provider: 'anthropic', accountId: 'account-a',
      fromFp: credentialFingerprint(credential('two')), toFp: credentialFingerprint(credential('three')),
      cause: 'post', by: 'qlb-cli', evidence: 'lineage',
    });
  });

  it('compensates a create when the outer SQLite commit fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-slot-commit-create-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    store.close();
    const backend = new CountingBackend();
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });
    failNextCommit(repository);

    await assert.rejects(slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' }), /fixture commit failed/);
    await assertMissing(backend, 'qlb:anthropic:account-a');
    assert.equal(repository.getSlot('account-a'), null);
    repository.close();
  });

  it('compensates a write when the outer SQLite commit fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-slot-commit-write-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    store.close();
    const backend = new CountingBackend();
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    failNextCommit(repository);

    await assert.rejects(slots.writeSlot('account-a', credential('two'), { cause: 'post' }), /fixture commit failed/);
    assert.equal(await backend.get('qlb:anthropic:account-a', 'qlb'), credential('one'));
    await assertMissing(backend, 'qlb:anthropic:account-a:prev');
    assert.equal(repository.getSlot('account-a')?.fingerprint, credentialFingerprint(credential('one')));
    repository.close();
  });

  it('compensates a delete when the outer SQLite commit fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-slot-commit-delete-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    store.close();
    const backend = new CountingBackend();
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    await slots.writeSlot('account-a', credential('two'), { cause: 'post' });
    failNextCommit(repository);

    await assert.rejects(slots.deleteSlot('account-a'), /fixture commit failed/);
    assert.equal(await backend.get('qlb:anthropic:account-a', 'qlb'), credential('two'));
    assert.equal(await backend.get('qlb:anthropic:account-a:prev', 'qlb'), credential('one'));
    assert.equal(repository.getSlot('account-a')?.fingerprint, credentialFingerprint(credential('two')));
    repository.close();
  });

  it('serializes concurrent writers from two SQLite connections with their Keychain effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-slot-concurrent-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    store.close();
    const backend = new CountingBackend();
    const firstRepository = SqliteClaudeSlotRepository.open(dbPath);
    const secondRepository = SqliteClaudeSlotRepository.open(dbPath);
    const first = new ClaudeSlots({ backend, repository: firstRepository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });
    const second = new ClaudeSlots({ backend, repository: secondRepository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });
    await first.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });

    const writes = await Promise.allSettled([
      first.writeSlot('account-a', credential('two'), { cause: 'post' }),
      second.writeSlot('account-a', credential('three'), { cause: 'post' }),
    ]);

    assert.deepEqual(writes.map((result) => result.status), ['fulfilled', 'fulfilled']);
    const persisted = await first.readSlot('account-a', { fresh: true });
    assert.equal(firstRepository.getSlot('account-a')?.fingerprint, persisted.fingerprint);
    firstRepository.close();
    secondRepository.close();
  });

  it('does not let a losing concurrent SQLite create remove the winner credential', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-cc-slot-concurrent-create-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    store.close();
    const backend = new CountingBackend();
    const firstRepository = SqliteClaudeSlotRepository.open(dbPath);
    const secondRepository = SqliteClaudeSlotRepository.open(dbPath);
    const first = new ClaudeSlots({ backend, repository: firstRepository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });
    const second = new ClaudeSlots({ backend, repository: secondRepository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });

    const creates = await Promise.allSettled([
      first.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' }),
      second.createSlot({ accountId: 'account-a', credential: credential('two'), source: 'cswap-import' }),
    ]);

    assert.equal(creates.filter((result) => result.status === 'fulfilled').length, 1);
    const persisted = await first.readSlot('account-a', { fresh: true });
    assert.equal(firstRepository.getSlot('account-a')?.fingerprint, persisted.fingerprint);
    firstRepository.close();
    secondRepository.close();
  });

  it('rejects IDs that collide with reserved predecessor and stash namespaces', async () => {
    const { slots } = fixture();
    await assert.rejects(slots.createSlot({ accountId: 'a:prev', credential: credential('one'), source: 'cswap-import' }), /invalid slot id/);
    await assert.rejects(slots.createSlot({ accountId: 'unclaimed:x', credential: credential('one'), source: 'cswap-import' }), /invalid slot id/);
  });

  describe('K6-1 strike and heal semantics', () => {
    type RepositoryFixture = {
      repository: ClaudeSlotRepository;
      relogins(): Array<{ kind: string; detail?: string | null; evidence?: string | null }>;
      close(): void;
    };

    const repositories: Array<[string, () => RepositoryFixture]> = [
      ['in-memory', () => {
        const repository = new InMemoryClaudeSlotRepository();
        return {
          repository,
          relogins: () => repository.relogins.map(({ kind, detail, evidence }) => ({ kind, detail, evidence })),
          close: () => {},
        };
      }],
      ['SQLite', () => {
        const root = mkdtempSync(join(tmpdir(), 'qlb-cc-slot-strike-'));
        const dbPath = join(root, 'qlb.db');
        const store = openStore(dbPath);
        store.close();
        const repository = SqliteClaudeSlotRepository.open(dbPath);
        return {
          repository,
          relogins: () => listReloginEvents(dbPath).map(({ kind, detail, evidence }) => ({ kind, detail, evidence })),
          close: () => repository.close(),
        };
      }],
    ];

    function fingerprint(tag: string): string {
      const value = credentialFingerprint(credential(tag));
      assert.ok(value);
      return value;
    }

    function slot(accountId: string, fingerprint: string): ClaudeSlot {
      return {
        accountId, fingerprint, prevFingerprint: null, dead: false, addedAt: 1_000,
      };
    }

    function lineage(accountId: string, fromFp: string, toFp: string, ts = 2_000): LineageAppend {
      return { ts, provider: 'anthropic', accountId, fromFp, toFp, cause: 'post', by: 'qlb-gate', evidence: 'post' };
    }

    for (const [name, createRepository] of repositories) {
      it(`${name}: strikeDead writes dead=1 and exactly one dead row whose detail is the struck lineage fingerprint`, () => {
        const fixture = createRepository();
        const struckFp = fingerprint('struck');
        try {
          fixture.repository.createSlot(slot('account-a', struckFp));
          assert.equal(fixture.repository.strikeDead('account-a', {
            reason: 'invalid_grant', struckFp, ts: 1_500,
          }), 'struck');
          const stored = fixture.repository.getSlot('account-a');
          assert.equal(stored?.fingerprint, struckFp);
          assert.equal(stored?.dead, true);
          assert.equal(stored?.deadReason, 'invalid_grant');
          assert.equal(stored?.deadAt, 1_500);
          assert.deepEqual(fixture.relogins(), [{
            kind: 'dead', detail: reloginDetailFingerprint(struckFp), evidence: 'dead',
          }]);
        } finally { fixture.close(); }
      });

      it(`${name}: strikeDead on an already-dead slot writes nothing`, () => {
        const fixture = createRepository();
        const struckFp = fingerprint('struck');
        try {
          fixture.repository.createSlot(slot('account-a', struckFp));
          fixture.repository.strikeDead('account-a', { reason: 'invalid_grant', struckFp, ts: 1_500 });
          const before = fixture.repository.getSlot('account-a');
          const relogins = fixture.relogins();
          const generation = fixture.repository.currentGeneration();

          assert.equal(fixture.repository.strikeDead('account-a', {
            reason: 'no_refresh_token', struckFp, ts: 2_000,
          }), 'already-dead');
          assert.deepEqual(fixture.repository.getSlot('account-a'), before);
          assert.deepEqual(fixture.relogins(), relogins);
          assert.equal(fixture.repository.currentGeneration(), generation);
        } finally { fixture.close(); }
      });

      it(`${name}: strikeDead whose struck lineage is no longer the slot's writes nothing and returns lineage-moved`, () => {
        const fixture = createRepository();
        const struckFp = fingerprint('struck');
        const successorFp = fingerprint('successor');
        try {
          fixture.repository.createSlot(slot('account-a', struckFp));
          fixture.repository.updateCredentialWithLineage('account-a', struckFp, successorFp, struckFp,
            lineage('account-a', struckFp, successorFp));
          const before = fixture.repository.getSlot('account-a');
          const relogins = fixture.relogins();

          assert.equal(fixture.repository.strikeDead('account-a', {
            reason: 'invalid_grant', struckFp, ts: 3_000,
          }), 'lineage-moved');
          assert.deepEqual(fixture.repository.getSlot('account-a'), before);
          assert.deepEqual(fixture.relogins(), relogins);
        } finally { fixture.close(); }
      });

      it(`${name}: a same-lineage write to a dead slot leaves dead=1 and writes no row`, () => {
        const fixture = createRepository();
        const struckFp = fingerprint('struck');
        try {
          fixture.repository.createSlot(slot('account-a', struckFp));
          fixture.repository.strikeDead('account-a', { reason: 'invalid_grant', struckFp, ts: 1_500 });
          const relogins = fixture.relogins();
          fixture.repository.updateCredentialWithLineage('account-a', struckFp, struckFp, null, null);

          assert.equal(fixture.repository.getSlot('account-a')?.dead, true);
          assert.equal(fixture.repository.getSlot('account-a')?.deadReason, 'invalid_grant');
          assert.deepEqual(fixture.relogins(), relogins);
        } finally { fixture.close(); }
      });

      it(`${name}: a lineage-changing write to a dead slot heals and writes one healed row`, () => {
        const fixture = createRepository();
        const struckFp = fingerprint('struck');
        const successorFp = fingerprint('successor');
        try {
          fixture.repository.createSlot(slot('account-a', struckFp));
          fixture.repository.strikeDead('account-a', { reason: 'invalid_grant', struckFp, ts: 1_500 });
          fixture.repository.updateCredentialWithLineage('account-a', struckFp, successorFp, struckFp,
            lineage('account-a', struckFp, successorFp, 2_000));

          assert.equal(fixture.repository.getSlot('account-a')?.dead, false);
          assert.equal(fixture.repository.getSlot('account-a')?.deadReason, null);
          assert.equal(fixture.repository.getSlot('account-a')?.healedAt, 2_000);
          assert.deepEqual(fixture.relogins().map(({ kind, detail, evidence }) => ({ kind, detail, evidence })), [
            { kind: 'dead', detail: reloginDetailFingerprint(struckFp), evidence: 'dead' },
            { kind: 'healed', detail: reloginDetailFingerprint(successorFp), evidence: null },
          ]);
        } finally { fixture.close(); }
      });

      it(`${name}: a lineage-changing write to a live slot writes no relogin row`, () => {
        const fixture = createRepository();
        const firstFp = fingerprint('first');
        const successorFp = fingerprint('successor');
        try {
          fixture.repository.createSlot(slot('account-a', firstFp));
          fixture.repository.updateCredentialWithLineage('account-a', firstFp, successorFp, firstFp,
            lineage('account-a', firstFp, successorFp));
          assert.deepEqual(fixture.relogins(), []);
        } finally { fixture.close(); }
      });
    }

    it('the one-argument in-memory markDead fixture still writes no relogin row', () => {
      const repository = new InMemoryClaudeSlotRepository();
      const struckFp = fingerprint('fixture');
      repository.createSlot(slot('account-a', struckFp));
      repository.markDead('account-a');
      assert.equal(repository.getSlot('account-a')?.dead, true);
      assert.deepEqual(repository.relogins, []);
    });

    it('exposes getSlot and strikeDead through ClaudeSlots', async () => {
      const { slots, repo } = fixture();
      await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
      const current = slots.getSlot('account-a')!;
      assert.equal(await slots.strikeDead('account-a', {
        reason: 'invalid_grant', struckFp: current.fingerprint!, ts: 2_000,
      }), 'struck');
      assert.equal(slots.getSlot('account-a')?.dead, true);
    });

    it('a strike while another write transaction is open waits and commits on its own', async () => {
      const root = mkdtempSync(join(tmpdir(), 'qlb-cc-slot-strike-queue-'));
      const dbPath = join(root, 'qlb.db');
      const store = openStore(dbPath);
      store.close();
      const repository = SqliteClaudeSlotRepository.open(dbPath);
      const slots = new ClaudeSlots({ repository, stashDir: join(root, 'unclaimed') });
      const struckFp = fingerprint('queued');
      repository.createSlot(slot('account-a', struckFp));
      let releaseOuter!: () => void;
      const outerRelease = new Promise<void>((resolve) => { releaseOuter = resolve; });
      let started!: () => void;
      const outerStarted = new Promise<void>((resolve) => { started = resolve; });
      const outer = repository.withWriteTransaction(async () => {
        started();
        await outerRelease;
        throw new Error('fixture outer rollback');
      });
      await outerStarted;

      let settled = false;
      const strike = Promise.resolve().then(() => slots.strikeDead('account-a', {
        reason: 'invalid_grant', struckFp, ts: 1_500,
      }));
      void strike.then(() => { settled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);

      releaseOuter();
      await assert.rejects(outer, /fixture outer rollback/);
      assert.equal(await strike, 'struck');
      assert.equal(repository.getSlot('account-a')?.dead, true);
      assert.deepEqual(listReloginEvents(dbPath).map((row) => row.kind), ['dead']);
      repository.close();
    });

    it('strikeDead reports struck only after commit', async () => {
      const repository: ClaudeSlotRepository = new InMemoryClaudeSlotRepository();
      let releaseCommit!: () => void;
      const commit = new Promise<void>((resolve) => { releaseCommit = resolve; });
      let committed = false;
      repository.withWriteTransaction = async (fn) => {
        const result = await fn(() => {});
        await commit;
        committed = true;
        return result;
      };
      const slots = new ClaudeSlots({ repository, stashDir: join(mkdtempSync(join(tmpdir(), 'qlb-cc-slots-')), 'unclaimed') });
      const struckFp = fingerprint('commit');
      repository.createSlot(slot('account-a', struckFp));

      let settled = false;
      const strike = Promise.resolve().then(() => slots.strikeDead('account-a', {
        reason: 'invalid_grant', struckFp, ts: 1_500,
      }));
      void strike.then(() => { settled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(committed, false);

      releaseCommit();
      assert.equal(await strike, 'struck');
      assert.equal(committed, true);
    });
  });
});
