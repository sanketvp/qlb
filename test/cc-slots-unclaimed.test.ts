import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ClaudeSlots, InMemoryClaudeSlotRepository, type ClaudeSlotBackend } from '../src/cc-slots';
import { runClaudeRestoreUnclaimedCommand } from '../src/commands/claude-restore-unclaimed';
import { MockKeychain } from '../src/keychain';
import type { CommandContext } from '../src/registry';

function credential(tag: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}` } });
}

class StashFailingBackend implements ClaudeSlotBackend {
  readonly kind = 'test-memory' as const;
  readonly inner = new MockKeychain();
  failUnclaimedWrites = false;
  failUnclaimedDeletes = false;

  async get(service: string, account: string): Promise<string> { return this.inner.get(service, account); }
  async set(service: string, account: string, value: string): Promise<void> {
    if (this.failUnclaimedWrites && service.includes(':unclaimed:')) throw new Error('fixture keychain write failed');
    return this.inner.set(service, account, value);
  }
  async delete(service: string, account: string): Promise<void> {
    if (this.failUnclaimedDeletes && service.includes(':unclaimed:')) throw new Error('fixture keychain delete failed');
    return this.inner.delete(service, account);
  }
}

function fixture(): { slots: ClaudeSlots; backend: StashFailingBackend; stashDir: string } {
  const stashDir = join(mkdtempSync(join(tmpdir(), 'qlb-unclaimed-')), 'unclaimed');
  const backend = new StashFailingBackend();
  return {
    slots: new ClaudeSlots({ backend, repository: new InMemoryClaudeSlotRepository(), stashDir, now: () => 1_000 }),
    backend,
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
  it('falls back to a private file, then sweeps it into Keychain', async () => {
    const { slots, backend, stashDir } = fixture();
    backend.failUnclaimedWrites = true;
    const stored = await slots.stashUnclaimed('2026-10-25T12:00:00Z', credential('issued'), 'sha256:consumed');
    assert.equal(stored.location, 'file');
    assert.equal(statSync(stashDir).mode & 0o777, 0o700);
    assert.equal(statSync(stored.path!).mode & 0o777, 0o600);

    backend.failUnclaimedWrites = false;
    assert.deepEqual(await slots.sweepUnclaimed(), { swept: 1, retained: 0 });
    const swept = JSON.parse(await backend.get('qlb:anthropic:unclaimed:2026-10-25T12:00:00Z', 'qlb')) as { consumedFp: string };
    assert.equal(swept.consumedFp, 'sha256:consumed');
  });

  it('restores only when the stash consumed lineage matches the current slot', async () => {
    const { slots } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a', { fresh: true })).fingerprint;
    await slots.stashUnclaimed('2026-10-25T12:01:00Z', credential('issued'), current);

    await slots.restoreUnclaimed('2026-10-25T12:01:00Z', 'account-a');
    assert.equal((await slots.readSlot('account-a', { fresh: true })).credential, credential('issued'));
  });

  it('reports when a restored stash could not be deleted', async () => {
    const { slots, backend } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    const current = (await slots.readSlot('account-a', { fresh: true })).fingerprint;
    await slots.stashUnclaimed('2026-10-25T12:01:30Z', credential('issued'), current);
    backend.failUnclaimedDeletes = true;

    assert.deepEqual(await slots.restoreUnclaimed('2026-10-25T12:01:30Z', 'account-a'), { cleanupPending: true });
  });

  it('refuses a restore whose consumed lineage no longer matches', async () => {
    const { slots } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    await slots.stashUnclaimed('2026-10-25T12:02:00Z', credential('issued'), 'sha256:other');
    await assert.rejects(slots.restoreUnclaimed('2026-10-25T12:02:00Z', 'account-a'), /lineage mismatch/);
  });

  it('refuses a foreign safety stash without a consumed lineage', async () => {
    const { slots } = fixture();
    await slots.createSlot({ accountId: 'account-a', credential: credential('one'), source: 'cswap-import' });
    await slots.stashUnclaimed('2026-10-25T12:02:30Z', credential('foreign'));
    await assert.rejects(slots.restoreUnclaimed('2026-10-25T12:02:30Z', 'account-a'), /lineage mismatch/);
    assert.equal((await slots.readSlot('account-a')).credential, credential('one'));
  });

  it('registers a restoring command with strict argument handling and no credential output', async () => {
    const output: string[] = [];
    const seen: Array<[string, string]> = [];
    const restore = async (timestamp: string, slot: string) => { seen.push([timestamp, slot]); };
    assert.equal(await runClaudeRestoreUnclaimedCommand(['2026-10-25T12:03:00Z', 'account-a'], context(output), { restore }), 0);
    assert.deepEqual(seen, [['2026-10-25T12:03:00Z', 'account-a']]);
    assert.deepEqual(output, ['restored unclaimed credential to account-a']);
    assert.equal(await runClaudeRestoreUnclaimedCommand([], context(output), { restore }), 2);
    assert.equal(await runClaudeRestoreUnclaimedCommand(['2026-10-25T12:03:00Z', 'a:prev'], context(output), { restore }), 2);
  });

  it('prints a warning when command-level stash cleanup is pending', async () => {
    const output: string[] = [];
    const restore = async () => ({ cleanupPending: true });
    assert.equal(await runClaudeRestoreUnclaimedCommand(['2026-10-25T12:04:00Z', 'account-a'], context(output), { restore }), 0);
    assert.deepEqual(output, [
      'restored unclaimed credential to account-a',
      'ERR:qlb claude restore-unclaimed: warning: stash cleanup pending',
    ]);
  });
});
