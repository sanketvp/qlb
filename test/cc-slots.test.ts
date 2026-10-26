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
import { openStore } from '../src/store';

function credential(tag: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}` } });
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
    assert.deepEqual(repo.transitions.map((row) => row.cause), ['post']);
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

  it('uses one Keychain read for cached displays within sixty seconds', async () => {
    let now = 1_000;
    const { slots, backend } = fixture(() => now);
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    backend.gets = 0;

    await slots.readSlot('account-a');
    await slots.readSlot('account-a');
    await slots.readSlot('account-a');
    assert.equal(backend.gets, 1);

    now += 60_001;
    await slots.readSlot('account-a');
    assert.equal(backend.gets, 2);
  });

  it('drops a cached display after its own write', async () => {
    const { slots, backend } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    backend.gets = 0;
    await slots.readSlot('account-a');
    await slots.writeSlot('account-a', credential('two'), { cause: 'post' });
    const afterWrite = backend.gets;
    await slots.readSlot('account-a');
    assert.equal(backend.gets, afterWrite + 1);
  });

  it('does not cache failed reads and fresh reads bypass the failure backoff', async () => {
    const { slots, backend } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    backend.failReads = true;
    await assert.rejects(slots.readSlot('account-a'), /fixture unavailable/);
    await assert.rejects(slots.readSlot('account-a'), KeychainBackedOff);

    backend.failReads = false;
    const fresh = await slots.readSlot('account-a', { fresh: true });
    assert.equal(fresh.credential, credential('one'));
    assert.equal(backend.gets, 2);
  });
});
