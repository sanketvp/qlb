import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ClaudeSlots, InMemoryClaudeSlotRepository, SqliteClaudeSlotRepository, type ClaudeSlotBackend } from '../src/cc-slots';
import { runClaudeRestoreUnclaimedCommand } from '../src/commands/claude-restore-unclaimed';
import { MockKeychain } from '../src/keychain';
import { listStashes, recordStash } from '../src/unclaimed-index';
import { openStore } from '../src/store';
import type { CommandContext } from '../src/registry';

function credential(tag: string, expiresAt = tag === 'issued' ? 2_000 : 1_000): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}`, expiresAt } });
}

function credentialWithRefresh(tag: string, refreshToken: string, expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}`, refreshToken, expiresAt } });
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

class StashFailingBackend implements ClaudeSlotBackend {
  readonly kind = 'test-memory' as const;
  readonly inner = new MockKeychain();
  failUnclaimedWrites = false;
  failUnclaimedDeletes = false;
  unclaimedGets = 0;

  async get(service: string, account: string): Promise<string> {
    if (service.includes(':unclaimed:')) this.unclaimedGets += 1;
    return this.inner.get(service, account);
  }
  async set(service: string, account: string, value: string): Promise<void> {
    if (this.failUnclaimedWrites && service.includes(':unclaimed:')) throw new Error('fixture keychain write failed');
    return this.inner.set(service, account, value);
  }
  async delete(service: string, account: string): Promise<void> {
    if (this.failUnclaimedDeletes && service.includes(':unclaimed:')) throw new Error('fixture keychain delete failed');
    return this.inner.delete(service, account);
  }
}

function fixture(options: {
  platform?: NodeJS.Platform;
  directorySync?: (path: string) => Promise<void>;
  warn?: (message: string) => void;
} = {}): { slots: ClaudeSlots; backend: StashFailingBackend; repository: InMemoryClaudeSlotRepository; stashDir: string } {
  const stashDir = join(mkdtempSync(join(tmpdir(), 'qlb-unclaimed-')), 'unclaimed');
  const backend = new StashFailingBackend();
  const repository = new InMemoryClaudeSlotRepository();
  return {
    slots: new ClaudeSlots({ backend, repository, stashDir, now: () => 1_000, ...options }),
    backend,
    repository,
    stashDir,
  };
}

function context(output: string[]): CommandContext {
  return {
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(`ERR:${line}`),
    env: { QLB_TEST_MODE: '1', QLB_HOME: '/fixture' },
    config: { dbPath: '/fixture/qlb.db' } as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); },
    home: '/fixture',
    registerSecret: () => {},
    deliverSecret: () => {},
    knownSecrets: () => [],
  };
}

describe('Claude unclaimed stash and restore (K2 / AC48)', () => {
  it('still rejects a colon in a NEW stash id', async () => {
    const { slots } = fixture();
    await assert.rejects(slots.stashUnclaimed('invalid:stash', credential('issued')), /invalid unclaimed timestamp/);
  });

  it('skips directory fsync on win32 and still stashes to the Keychain', async () => {
    const { slots } = fixture({
      platform: 'win32',
      directorySync: async () => { throw new Error('directory fsync must not run on Windows'); },
    });
    assert.deepEqual(await slots.stashUnclaimed('win32-stash', credential('issued')), { location: 'keychain' });
  });

  it('restores and sweeps a stash whose id contains colons from before the Windows-safe rule', async () => {
    const { slots, backend, stashDir } = fixture();
    const stashId = '2026-10-25T12:00:00Z';
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a', { fresh: true })).fingerprint;
    const entry = {
      provider: 'anthropic', accountId: 'account-a', stashId, consumedFp: current,
      location: 'file' as const, createdAt: 1_000,
    };
    mkdirSync(join(stashDir, 'index', 'anthropic'), { recursive: true, mode: 0o700 });
    writeFileSync(join(stashDir, 'index', 'anthropic', `${stashId}.json`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    mkdirSync(stashDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stashDir, `${stashId}.json`), JSON.stringify({ credential: credential('issued'), consumedFp: current, accountId: 'account-a' }), { mode: 0o600 });

    assert.deepEqual(await slots.sweepUnclaimed(), { swept: 1, retained: 0 });
    assert.deepEqual(await listStashes(stashDir, 'anthropic'), [{ ...entry, location: 'keychain' }]);
    await slots.restoreUnclaimed(stashId, 'account-a');
    assert.equal((await slots.readSlot('account-a', { fresh: true })).credential, credential('issued'));
    await assert.rejects(backend.get(`qlb:anthropic:unclaimed:${stashId}`, 'qlb'));
  });

  it('falls back to a private file, then sweeps it into Keychain', async () => {
    const { slots, backend, stashDir } = fixture();
    backend.failUnclaimedWrites = true;
    const stored = await slots.stashUnclaimed('2026-10-25T12-00-00Z', credential('issued'), 'sha256:consumed');
    assert.equal(stored.location, 'file');
    assert.equal(statSync(stashDir).mode & 0o777, 0o700);
    assert.equal(statSync(stored.path!).mode & 0o777, 0o600);

    backend.failUnclaimedWrites = false;
    assert.deepEqual(await slots.sweepUnclaimed(), { swept: 1, retained: 0 });
    const swept = JSON.parse(await backend.get('qlb:anthropic:unclaimed:2026-10-25T12-00-00Z', 'qlb')) as { consumedFp: string };
    assert.equal(swept.consumedFp, 'sha256:consumed');
  });

  it('falls back after a locked Keychain read and a failed write', async () => {
    const { slots, backend, stashDir } = fixture();
    const originalGet = backend.get.bind(backend);
    backend.get = async (service, account) => {
      if (service.includes(':unclaimed:')) {
        backend.unclaimedGets += 1;
        throw new Error('fixture keychain locked');
      }
      return originalGet(service, account);
    };
    backend.failUnclaimedWrites = true;

    const stored = await slots.stashUnclaimed('locked-stash', credential('issued'), 'sha256:consumed', 'account-a');
    assert.equal(stored.location, 'file');
    assert.ok(backend.unclaimedGets > 0);
    assert.equal(statSync(join(stashDir, 'locked-stash.json')).mode & 0o777, 0o600);
  });

  it('uses a file fallback when the index cannot be updated', async () => {
    const { slots, backend, stashDir } = fixture();
    mkdirSync(stashDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stashDir, 'index'), 'blocked');
    backend.failUnclaimedWrites = true;

    const stored = await slots.stashUnclaimed('index-failure', credential('issued'), 'sha256:consumed', 'account-a');
    assert.equal(stored.location, 'file');
    assert.equal(statSync(stored.path!).mode & 0o777, 0o600);
  });

  it('keeps the durable account id when a fresh instance sweeps a fallback file', async () => {
    const { slots, backend, stashDir } = fixture();
    backend.failUnclaimedWrites = true;
    await slots.stashUnclaimed('sweep-restart', credential('issued'), 'sha256:consumed', 'account-a');
    backend.failUnclaimedWrites = false;

    const sweeper = new ClaudeSlots({ backend, repository: new InMemoryClaudeSlotRepository(), stashDir, now: () => 2_000 });
    assert.deepEqual(await sweeper.sweepUnclaimed(), { swept: 1, retained: 0 });
    assert.deepEqual(await listStashes(stashDir, 'anthropic'), [{
      provider: 'anthropic', accountId: 'account-a', stashId: 'sweep-restart', consumedFp: 'sha256:consumed',
      location: 'keychain', createdAt: 1_000,
    }]);
  });

  it('refuses a reused stash id when a row-less fallback file already exists and the Keychain is healthy', async () => {
    const { slots, backend, stashDir } = fixture();
    mkdirSync(stashDir, { recursive: true, mode: 0o700 });
    const path = join(stashDir, 'row-less-id.json');
    const original = JSON.stringify({ credential: credential('original') });
    writeFileSync(path, original, { mode: 0o600 });

    await assert.rejects(slots.stashUnclaimed('row-less-id', credential('replacement')), /already exists/);
    assert.equal(readFileSync(path, 'utf8'), original);
    await assert.rejects(backend.get('qlb:anthropic:unclaimed:row-less-id', 'qlb'));
    assert.deepEqual(await listStashes(stashDir, 'anthropic'), []);
  });

  it('cleans its reservation when a row-less Keychain stash id already exists', async () => {
    const { slots, backend, stashDir } = fixture();
    await backend.set('qlb:anthropic:unclaimed:reused-id', 'qlb', JSON.stringify({ credential: credential('original') }));

    await assert.rejects(slots.stashUnclaimed('reused-id', credential('replacement'), 'sha256:replacement', 'account-a'), /already exists/);
    assert.deepEqual(await listStashes(stashDir, 'anthropic'), []);
  });

  it('reports already exists when reservation cleanup after a Keychain collision fails', async () => {
    const warnings: string[] = [];
    let syncs = 0;
    const { slots, backend } = fixture({
      directorySync: async () => {
        syncs += 1;
        if (syncs === 2) throw new Error('fixture index cleanup failed');
      },
      warn: (message) => warnings.push(message),
    });
    await backend.set('qlb:anthropic:unclaimed:cleanup-failure', 'qlb', JSON.stringify({ credential: credential('original') }));

    await assert.rejects(slots.stashUnclaimed('cleanup-failure', credential('replacement')), /already exists/);
    assert.deepEqual(warnings, ['unclaimed stash reservation cleanup failed for anthropic cleanup-failure']);
  });

  it('refuses to replace an existing fallback file for a reused stash id', async () => {
    const { slots, backend, stashDir } = fixture();
    mkdirSync(stashDir, { recursive: true, mode: 0o700 });
    const path = join(stashDir, 'reused-id.json');
    const original = JSON.stringify({ credential: credential('original') });
    writeFileSync(path, original, { mode: 0o600 });
    backend.failUnclaimedWrites = true;

    await assert.rejects(slots.stashUnclaimed('reused-id', credential('replacement')), /already exists/);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.deepEqual(readdirSync(stashDir).filter((name) => name.includes('.tmp.')), []);
  });

  it('finishes a sweep that copied to the Keychain but failed the index on the next sweep', async () => {
    let failDirectorySync = false;
    const { slots, backend, stashDir } = fixture({
      directorySync: async () => {
        if (failDirectorySync) throw new Error('fixture index sync failed');
      },
    });
    backend.failUnclaimedWrites = true;
    await slots.stashUnclaimed('retry-sweep', credential('issued'), 'sha256:consumed', 'account-a');
    backend.failUnclaimedWrites = false;
    failDirectorySync = true;

    assert.deepEqual(await slots.sweepUnclaimed(), { swept: 0, retained: 1 });
    assert.equal(readFileSync(join(stashDir, 'retry-sweep.json'), 'utf8').length > 0, true);
    assert.equal((await backend.get('qlb:anthropic:unclaimed:retry-sweep', 'qlb')).length > 0, true);

    failDirectorySync = false;
    assert.deepEqual(await slots.sweepUnclaimed(), { swept: 1, retained: 0 });
    assert.deepEqual(await listStashes(stashDir, 'anthropic'), [{
      provider: 'anthropic', accountId: 'account-a', stashId: 'retry-sweep', consumedFp: 'sha256:consumed',
      location: 'keychain', createdAt: 1_000,
    }]);
    assert.throws(() => statSync(join(stashDir, 'retry-sweep.json')));
  });

  it('leaves both copies when the Keychain holds a different credential for the same id', async () => {
    const warnings: string[] = [];
    const { slots, backend, stashDir } = fixture({ warn: (message) => warnings.push(message) });
    backend.failUnclaimedWrites = true;
    await slots.stashUnclaimed('different-copy', credential('file'), 'sha256:consumed', 'account-a');
    backend.failUnclaimedWrites = false;
    await backend.set('qlb:anthropic:unclaimed:different-copy', 'qlb', JSON.stringify({ credential: credential('keychain') }));

    assert.deepEqual(await slots.sweepUnclaimed(), { swept: 0, retained: 1 });
    assert.equal(readFileSync(join(stashDir, 'different-copy.json'), 'utf8').length > 0, true);
    assert.equal((await backend.get('qlb:anthropic:unclaimed:different-copy', 'qlb')).length > 0, true);
    assert.deepEqual(warnings, ['unclaimed fallback conflicts with Keychain entry for different-copy']);
  });

  it('discovers and adopts a legacy fallback file that has no index row', async () => {
    const { slots, stashDir } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a')).fingerprint;
    mkdirSync(stashDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stashDir, 'legacy-file.json'), JSON.stringify({ credential: credential('issued'), consumedFp: current }), { mode: 0o600 });

    assert.equal((await slots.adoptStashedSuccessor('account-a'))?.credential, credential('issued'));
  });

  it('a fresh instance adopts a prior Keychain stash', async () => {
    const { slots, backend, repository, stashDir } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a')).fingerprint;
    await slots.stashUnclaimed('fresh-keychain', credential('issued'), current, 'account-a');

    const fresh = new ClaudeSlots({ backend, repository, stashDir, now: () => 1_000 });
    assert.equal((await fresh.adoptStashedSuccessor('account-a'))?.credential, credential('issued'));
  });

  it('a malformed index row defers adoption with unclaimed credential unavailable', async () => {
    const { slots, backend, stashDir } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a')).fingerprint;
    await slots.stashUnclaimed('keychain-intact', credential('issued'), current, 'account-a');
    mkdirSync(join(stashDir, 'index', 'anthropic'), { recursive: true, mode: 0o700 });
    writeFileSync(join(stashDir, 'index', 'anthropic', 'other.json'), '{not json', { mode: 0o600 });

    await assert.rejects(slots.adoptStashedSuccessor('account-a'), /unclaimed credential unavailable/);
    assert.equal((await backend.get('qlb:anthropic:unclaimed:keychain-intact', 'qlb')).length > 0, true);
  });

  it("another account's corrupt fallback file does not defer this account", async () => {
    const { slots, stashDir } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('a'), source: 'cswap-import' });
    await slots.createSlot({ accountId: 'account-b', credential: credential('b'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a')).fingerprint;
    await recordStash(stashDir, {
      provider: 'anthropic', accountId: 'account-a', stashId: 'a-corrupt-file', consumedFp: current,
      location: 'file', createdAt: 1,
    });
    mkdirSync(stashDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stashDir, 'a-corrupt-file.json'), '{not json', { mode: 0o600 });

    assert.equal(await slots.adoptStashedSuccessor('account-b'), null);
  });

  it('defers an account whose own fallback body is corrupt', async () => {
    const { slots, stashDir } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('a'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a')).fingerprint;
    await recordStash(stashDir, {
      provider: 'anthropic', accountId: 'account-a', stashId: 'own-corrupt-file', consumedFp: current,
      location: 'file', createdAt: 1,
    });
    mkdirSync(stashDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stashDir, 'own-corrupt-file.json'), '{not json', { mode: 0o600 });

    await assert.rejects(slots.adoptStashedSuccessor('account-a'), /unclaimed credential unavailable/);
    assert.equal((await listStashes(stashDir, 'anthropic')).length, 1);
  });

  it('refuses to adopt a record whose accountId names another account', async () => {
    const { slots, backend } = fixture();
    const currentCredential = credentialWithRefresh('current', 'shared-refresh', 1_000);
    await slots.createSlot({ accountId: 'account-a', credential: currentCredential, source: 'cswap-import' });
    await slots.createSlot({ accountId: 'account-b', credential: currentCredential, source: 'cswap-import' });
    const current = (await slots.readSlot('account-a')).fingerprint;
    await slots.stashUnclaimed('foreign-account', credentialWithRefresh('issued', 'next-refresh', 2_000), current, 'account-a');

    assert.equal(await slots.adoptStashedSuccessor('account-b'), null);
    assert.notEqual(await backend.get('qlb:anthropic:unclaimed:foreign-account', 'qlb'), '');
    await assert.rejects(slots.restoreUnclaimed('foreign-account', 'account-b'), /belongs to a different account/);
  });

  it('clears both absent-row crash windows, records stash-lost, and continues', async () => {
    const warnings: string[] = [];
    const { slots, stashDir } = fixture({ warn: (message) => warnings.push(message) });
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a')).fingerprint;
    await recordStash(stashDir, { provider: 'anthropic', accountId: 'account-a', stashId: 'lost-keychain', consumedFp: current, location: 'keychain', createdAt: 1 });
    await recordStash(stashDir, { provider: 'anthropic', accountId: 'account-a', stashId: 'lost-file', consumedFp: current, location: 'file', createdAt: 2 });

    assert.equal(await slots.adoptStashedSuccessor('account-a'), null);
    assert.deepEqual(await listStashes(stashDir, 'anthropic'), []);
    assert.deepEqual(warnings, [
      'stash-lost lost-keychain credential-and-file-not-found',
      'stash-lost lost-file credential-and-file-not-found',
    ]);
  });

  it('a Linux-style operational keychain error with no fallback file defers and keeps the row', async () => {
    const { slots, backend, stashDir } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a')).fingerprint;
    await recordStash(stashDir, { provider: 'anthropic', accountId: 'account-a', stashId: 'linux-operational', consumedFp: current, location: 'keychain', createdAt: 1 });
    const originalGet = backend.get.bind(backend);
    backend.get = async (service, account) => {
      if (service.includes(':unclaimed:')) throw new Error('keychain get failed: exit 1');
      return originalGet(service, account);
    };

    await assert.rejects(slots.adoptStashedSuccessor('account-a'), /unclaimed credential unavailable/);
    assert.equal((await listStashes(stashDir, 'anthropic')).length, 1);
  });

  it('removes a matching stash that is not strictly newer than the installed primary', async () => {
    const warnings: string[] = [];
    const { slots, backend, stashDir } = fixture({ warn: (message) => warnings.push(message) });
    await slots.createSlot({ accountId: 'account-a', credential: credential('one', 2_000), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a')).fingerprint;
    await slots.stashUnclaimed('obsolete-stash', credential('issued', 2_000), current, 'account-a');

    assert.equal(await slots.adoptStashedSuccessor('account-a'), null);
    await assert.rejects(backend.get('qlb:anthropic:unclaimed:obsolete-stash', 'qlb'));
    assert.deepEqual(await listStashes(stashDir, 'anthropic'), []);
    assert.deepEqual(warnings, ['stash-obsolete obsolete-stash not-newer-than-primary']);
  });

  it('restores only when the stash consumed lineage matches the current slot', async () => {
    const { slots } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a', { fresh: true })).fingerprint;
    await slots.stashUnclaimed('2026-10-25T12-01-00Z', credential('issued'), current);

    await slots.restoreUnclaimed('2026-10-25T12-01-00Z', 'account-a');
    assert.equal((await slots.readSlot('account-a', { fresh: true })).credential, credential('issued'));
  });

  it('reports when a restored stash could not be deleted', async () => {
    const { slots, backend } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a', { fresh: true })).fingerprint;
    await slots.stashUnclaimed('2026-10-25T12-01-30Z', credential('issued'), current);
    backend.failUnclaimedDeletes = true;

    assert.deepEqual(await slots.restoreUnclaimed('2026-10-25T12-01-30Z', 'account-a'), { cleanupPending: true });
  });

  it('keeps the stash retryable when the outer SQLite commit fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-unclaimed-commit-'));
    const dbPath = join(root, 'qlb.db');
    const store = openStore(dbPath);
    store.close();
    const backend = new StashFailingBackend();
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed'), now: () => 1_000 });
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a', { fresh: true })).fingerprint;
    await slots.stashUnclaimed('2026-10-25T12-01-45Z', credential('issued'), current);
    failNextCommit(repository);

    await assert.rejects(slots.restoreUnclaimed('2026-10-25T12-01-45Z', 'account-a'), /fixture commit failed/);
    assert.notEqual(await backend.get('qlb:anthropic:unclaimed:2026-10-25T12-01-45Z', 'qlb'), '');
    assert.deepEqual(await slots.restoreUnclaimed('2026-10-25T12-01-45Z', 'account-a'), { cleanupPending: false });
    await assert.rejects(backend.get('qlb:anthropic:unclaimed:2026-10-25T12-01-45Z', 'qlb'));
    repository.close();
  });

  it('refuses a restore whose consumed lineage no longer matches', async () => {
    const { slots } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    await slots.stashUnclaimed('2026-10-25T12-02-00Z', credential('issued'), 'sha256:other');
    await assert.rejects(slots.restoreUnclaimed('2026-10-25T12-02-00Z', 'account-a'), /lineage mismatch/);
  });

  it('refuses a foreign safety stash without a consumed lineage', async () => {
    const { slots } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    await slots.stashUnclaimed('2026-10-25T12-02-30Z', credential('foreign'));
    await assert.rejects(slots.restoreUnclaimed('2026-10-25T12-02-30Z', 'account-a'), /lineage mismatch/);
    assert.equal((await slots.readSlot('account-a')).credential, credential('one'));
  });

  it('restore CLI accepts a legacy colon id with strict argument handling and no credential output', async () => {
    const output: string[] = [];
    const seen: Array<[string, string]> = [];
    const restore = async (timestamp: string, slot: string) => { seen.push([timestamp, slot]); };
    assert.equal(await runClaudeRestoreUnclaimedCommand(['2026-10-25T12-03-00Z', 'account-a'], context(output), { restore }), 0);
    assert.deepEqual(seen, [['2026-10-25T12-03-00Z', 'account-a']]);
    assert.deepEqual(output, ['restored unclaimed credential to account-a']);
    assert.equal(await runClaudeRestoreUnclaimedCommand([], context(output), { restore }), 2);
    assert.equal(await runClaudeRestoreUnclaimedCommand(['2026-10-25T12-03-00Z', 'a:prev'], context(output), { restore }), 2);
    assert.equal(await runClaudeRestoreUnclaimedCommand(['..', 'account-a'], context(output), { restore }), 2);
  });

  it('prints a warning when command-level stash cleanup is pending', async () => {
    const output: string[] = [];
    const restore = async () => ({ cleanupPending: true });
    assert.equal(await runClaudeRestoreUnclaimedCommand(['2026-10-25T12-04-00Z', 'account-a'], context(output), { restore }), 0);
    assert.deepEqual(output, [
      'restored unclaimed credential to account-a',
      'ERR:qlb claude restore-unclaimed: warning: stash cleanup pending',
    ]);
  });
});
