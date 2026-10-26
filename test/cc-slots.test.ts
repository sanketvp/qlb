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
  type ClaudeSlotBackend,
} from '../src/cc-slots';
import { KeychainBackedOff, KeychainReadBackoff, MockKeychain } from '../src/keychain';
import { credentialFingerprint } from '../src/anthropic-oauth';
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
  failReads = false;

  async get(service: string, account: string): Promise<string> {
    this.gets += 1;
    if (this.failReads) throw new Error('fixture unavailable');
    return this.inner.get(service, account);
  }

  async set(service: string, account: string, value: string): Promise<void> {
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
});
