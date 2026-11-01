import assert from 'node:assert/strict';
import { mkdtempSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ClaudeSlotBackend } from '../src/cc-slots';
import {
  ClaudeSwitchJournalPresent,
  claudeSwitchJournalDir,
  claudeSwitchJournalOwnerLockPath,
  claudeSwitchJournalPath,
  createClaudeSwitchJournal,
  deleteClaudeSwitchJournal,
  deleteStagedRollback,
  parseClaudeSwitchJournal,
  probeClaudeSwitchJournalOwner,
  readClaudeSwitchJournal,
  readStagedRollback,
  stagedRollbackService,
  updateClaudeSwitchJournal,
  withClaudeSwitchJournalOwner,
  writeStagedRollback,
  type ClaudeSwitchJournal,
  type ClaudeSwitchJournalOptions,
} from '../src/cc-switch-journal';

const fixtureAccess = 'fixture-access-token-that-must-not-reach-journal';
const fixtureRefresh = 'fixture-refresh-token-that-must-not-reach-journal';

class MemoryBackend implements ClaudeSlotBackend {
  readonly values = new Map<string, string>();
  readonly calls: Array<{ op: string; service: string; account: string }> = [];
  private key(service: string, account: string): string { return `${service}\0${account}`; }
  async get(service: string, account: string): Promise<string> {
    this.calls.push({ op: 'get', service, account });
    const found = this.values.get(this.key(service, account));
    if (found === undefined) throw new Error(`keychain get failed for service=${service} account=${account}: item not found`);
    return found;
  }
  async set(service: string, account: string, value: string): Promise<void> {
    this.calls.push({ op: 'set', service, account }); this.values.set(this.key(service, account), value);
  }
  async delete(service: string, account: string): Promise<void> {
    this.calls.push({ op: 'delete', service, account });
    if (!this.values.delete(this.key(service, account))) throw new Error(`keychain delete failed for service=${service} account=${account}: item not found`);
  }
}

type Harness = { root: string; options: ClaudeSwitchJournalOptions; journal: ClaudeSwitchJournal };
function journalFixture(root: string, patch: Partial<ClaudeSwitchJournal> = {}): ClaudeSwitchJournal {
  return {
    v: 1, provider: 'anthropic', attemptId: 'attempt-1', from: 'from-account', to: 'to-account',
    trigger: 'manual', by: 'qlb-cli', republish: false, injected: false, detail: null,
    decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null }, outgoingKind: 'own-bytes', bindingJson: null,
    step: 6, stagedBlobService: stagedRollbackService('fixture-ts'), stagedAccount: 'qlb', stagedWritten: false,
    keychainService: 'Claude Code-credentials-fixture', configPath: join(root, 'claude.json'), configText: null,
    configWrittenHash: null, fromOauthAccount: null, credentialsWrittenHash: null,
    credentialsWriteStarted: false, credentialsWritten: false, configWriteStarted: false, configWritten: false,
    closed: null, startedAt: 123, owner: { pid: 1234, lstart: 'fixture-start' }, ...patch,
  };
}
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'qlb-cc-switch-journal-'));
  const journal = journalFixture(root);
  return { root, options: { journalDir: join(root, 'journal'), configPath: journal.configPath, keychainService: journal.keychainService }, journal };
}
function cleanup(h: Harness): void { rmSync(h.root, { recursive: true, force: true }); }

function rawJournal(h: Harness): string { return readFileSync(claudeSwitchJournalPath(h.options), 'utf8'); }

describe('Claude switch journal (K5-2)', () => {
  it('a journal round-trips at mode 0600 in a 0700 directory and contains no byte of the fixture credential (access or refresh token)', () => {
    const h = harness();
    try {
      createClaudeSwitchJournal(h.journal, h.options);
      assert.equal(statSync(claudeSwitchJournalPath(h.options)).mode & 0o777, 0o600);
      assert.equal(statSync(claudeSwitchJournalDir(h.options)).mode & 0o777, 0o700);
      assert.deepEqual(readClaudeSwitchJournal(h.options), { state: 'ok', journal: h.journal });
      assert.doesNotMatch(rawJournal(h), new RegExp(`${fixtureAccess}|${fixtureRefresh}`));
    } finally { cleanup(h); }
  });

  it('the commit inputs (decision, outgoingKind, bindingJson, injected, by, republish, detail) round-trip and an update cannot change them', async () => {
    const h = harness();
    try {
      const journal = journalFixture(h.root, { decision: { leftHeadroom: 9, leftRecoveryAt: 10, leftTrigger: 'proactive' }, outgoingKind: null, bindingJson: '{"window":"7d"}', injected: true, by: 'qlb-auto', republish: true, detail: 'republish' });
      createClaudeSwitchJournal(journal, h.options);
      assert.deepEqual(readClaudeSwitchJournal(h.options), { state: 'ok', journal });
      await withClaudeSwitchJournalOwner(h.options, (held) => {
        assert.throws(() => updateClaudeSwitchJournal(held, { detail: 'changed' } as never, h.options));
      });
    } finally { cleanup(h); }
  });

  it('configText and configWrittenHash round-trip byte-exact, including a fixture primaryApiKey (it is a restore target, not redacted)', async () => {
    const h = harness();
    try {
      createClaudeSwitchJournal(h.journal, h.options);
      const configText = '{\n  "primaryApiKey": "fixture-primary-api-key",\n  "oauthAccount": {}\n}\n';
      await withClaudeSwitchJournalOwner(h.options, (held) => updateClaudeSwitchJournal(held, { configText, configWrittenHash: 'config-sha' }, h.options));
      const read = readClaudeSwitchJournal(h.options);
      assert.equal(read.state, 'ok');
      assert.equal(read.state === 'ok' ? read.journal.configText : undefined, configText);
      assert.equal(read.state === 'ok' ? read.journal.configWrittenHash : undefined, 'config-sha');
    } finally { cleanup(h); }
  });

  it('fromOauthAccount is null at create, is set only in an update that also sets configText, and round-trips as an object or null', async () => {
    const h = harness();
    try {
      createClaudeSwitchJournal(h.journal, h.options);
      assert.equal((readClaudeSwitchJournal(h.options) as { journal: ClaudeSwitchJournal }).journal.fromOauthAccount, null);
      await withClaudeSwitchJournalOwner(h.options, (held) => {
        assert.throws(() => updateClaudeSwitchJournal(held, { fromOauthAccount: { accountUuid: 'from-account' } } as never, h.options));
        assert.throws(() => updateClaudeSwitchJournal(held, { configText: null, fromOauthAccount: { accountUuid: 'from-account' } }, h.options));
        updateClaudeSwitchJournal(held, { configText: '{}\n', fromOauthAccount: { accountUuid: 'from-account' } }, h.options);
      });
      assert.deepEqual((readClaudeSwitchJournal(h.options) as { journal: ClaudeSwitchJournal }).journal.fromOauthAccount, { accountUuid: 'from-account' });
    } finally { cleanup(h); }
  });

  it('credentialsWrittenHash and closed round-trip; closed accepts only rolled-back or stage-failed; a set marker (closed or committed) cannot be cleared by a later update', async () => {
    const h = harness();
    try {
      createClaudeSwitchJournal(h.journal, h.options);
      await withClaudeSwitchJournalOwner(h.options, (held) => {
        updateClaudeSwitchJournal(held, { credentialsWrittenHash: 'credential-sha', closed: 'rolled-back' }, h.options);
        assert.throws(() => updateClaudeSwitchJournal(held, { closed: null }, h.options));
        assert.throws(() => updateClaudeSwitchJournal(held, { closed: 'not-valid' } as never, h.options));
      });
      const read = readClaudeSwitchJournal(h.options);
      assert.equal(read.state === 'ok' ? read.journal.credentialsWrittenHash : undefined, 'credential-sha');
      assert.equal(read.state === 'ok' ? read.journal.closed : undefined, 'rolled-back');
    } finally { cleanup(h); }
  });

  it('create persists only allowlisted fields (an extra property never reaches disk)', () => {
    const h = harness();
    try {
      createClaudeSwitchJournal({ ...h.journal, extra: fixtureAccess } as ClaudeSwitchJournal, h.options);
      assert.doesNotMatch(rawJournal(h), /fixture-access-token-that-must-not-reach-journal/);
    } finally { cleanup(h); }
  });

  it('create refuses when a journal already exists (ClaudeSwitchJournalPresent) and leaves it byte-identical', () => {
    const h = harness();
    try {
      createClaudeSwitchJournal(h.journal, h.options); const before = rawJournal(h);
      assert.throws(() => createClaudeSwitchJournal(h.journal, h.options), ClaudeSwitchJournalPresent);
      assert.equal(rawJournal(h), before);
    } finally { cleanup(h); }
  });

  it('create refuses a journal created between preparation and exclusive publication, preserving the first bytes', () => {
    const h = harness();
    try {
      let firstBytes = '';
      const raceOptions = {
        ...h.options,
        beforeCreatePublish: () => {
          createClaudeSwitchJournal(h.journal, h.options);
          firstBytes = rawJournal(h);
        },
      };
      assert.throws(() => createClaudeSwitchJournal(journalFixture(h.root, { attemptId: 'attempt-2' }), raceOptions), ClaudeSwitchJournalPresent);
      assert.equal(rawJournal(h), firstBytes);
    } finally { cleanup(h); }
  });

  it('a journal path that is a symlink is not followed (create and update fail, the link target is untouched)', async () => {
    const h = harness();
    try {
      mkdirSync(claudeSwitchJournalDir(h.options), { recursive: true });
      const target = join(h.root, 'target'); writeFileSync(target, 'unchanged');
      symlinkSync(target, claudeSwitchJournalPath(h.options));
      assert.throws(() => createClaudeSwitchJournal(h.journal, h.options));
      await withClaudeSwitchJournalOwner(h.options, (held) => assert.throws(() => updateClaudeSwitchJournal(held, { stagedWritten: true }, h.options)));
      assert.equal(readFileSync(target, 'utf8'), 'unchanged');
      assert.ok(lstatSync(claudeSwitchJournalPath(h.options)).isSymbolicLink());
    } finally { cleanup(h); }
  });

  it('a journal directory that is a symlink is not followed and its target is untouched', () => {
    const h = harness();
    try {
      const target = join(h.root, 'journal-target'); mkdirSync(target);
      symlinkSync(target, claudeSwitchJournalDir(h.options));
      assert.throws(() => createClaudeSwitchJournal(h.journal, h.options));
      assert.equal(lstatSync(claudeSwitchJournalDir(h.options)).isSymbolicLink(), true);
      assert.throws(() => lstatSync(join(target, 'switch-anthropic.json')), { code: 'ENOENT' });
    } finally { cleanup(h); }
  });

  it('an update changes only the allowed fields under the owner lock and rejects a changed attemptId', async () => {
    const h = harness();
    try {
      createClaudeSwitchJournal(h.journal, h.options);
      await withClaudeSwitchJournalOwner(h.options, (held) => {
        updateClaudeSwitchJournal(held, { step: 7, stagedWritten: true, credentialsWriteStarted: true }, h.options);
        assert.throws(() => updateClaudeSwitchJournal(held, { attemptId: 'attempt-2' } as never, h.options));
      });
      const read = readClaudeSwitchJournal(h.options);
      assert.equal(read.state === 'ok' ? read.journal.step : undefined, 7);
      assert.equal(read.state === 'ok' ? read.journal.stagedWritten : undefined, true);
    } finally { cleanup(h); }
  });

  it('a truncated or v0 journal reads as malformed', () => {
    const h = harness();
    try {
      mkdirSync(claudeSwitchJournalDir(h.options), { recursive: true });
      writeFileSync(claudeSwitchJournalPath(h.options), '{"v":1');
      assert.deepEqual(readClaudeSwitchJournal(h.options), { state: 'malformed' });
      writeFileSync(claudeSwitchJournalPath(h.options), JSON.stringify({ ...h.journal, v: 0 }));
      assert.deepEqual(readClaudeSwitchJournal(h.options), { state: 'malformed' });
    } finally { cleanup(h); }
  });

  it('a journal naming another configPath, keychainService, a non staged-rollback service or a stagedAccount other than qlb reads as malformed', () => {
    const h = harness();
    try {
      for (const journal of [
        { ...h.journal, configPath: 'other' }, { ...h.journal, keychainService: 'other' },
        { ...h.journal, stagedBlobService: 'qlb:anthropic:other:fixture' }, { ...h.journal, stagedAccount: 'other' },
      ]) assert.equal(parseClaudeSwitchJournal(journal, h.options), null);
    } finally { cleanup(h); }
  });

  it('the owner lock is proper-lockfile with 300 s staleness and a held assertion that throws after a takeover', async () => {
    const h = harness();
    try {
      let compromised = false;
      await assert.rejects(withClaudeSwitchJournalOwner({ ...h.options, onOwnerLockCompromised: () => { compromised = true; } }, (held) => {
        const path = claudeSwitchJournalOwnerLockPath(h.options); rmSync(path, { recursive: true, force: true }); mkdirSync(path);
        assert.throws(() => held.assertHeld());
      }));
      assert.equal(compromised, true);
    } finally { cleanup(h); }
  });

  it('probeClaudeSwitchJournalOwner reports held while the lock is held, free after release, and free for a lock older than 300 s, without taking or removing it', async () => {
    const h = harness();
    try {
      await withClaudeSwitchJournalOwner(h.options, async () => assert.equal(probeClaudeSwitchJournalOwner(h.options), 'held'));
      assert.equal(probeClaudeSwitchJournalOwner(h.options), 'free');
      const lock = claudeSwitchJournalOwnerLockPath(h.options); mkdirSync(lock, { recursive: true });
      utimesSync(lock, new Date(Date.now() - 300_001), new Date(Date.now() - 300_001));
      assert.equal(probeClaudeSwitchJournalOwner(h.options), 'free');
      assert.ok(lstatSync(lock).isDirectory());
    } finally { cleanup(h); }
  });

  it('delete removes the file and is idempotent', async () => {
    const h = harness();
    try {
      createClaudeSwitchJournal(h.journal, h.options);
      await withClaudeSwitchJournalOwner(h.options, (held) => { deleteClaudeSwitchJournal(held, h.options); deleteClaudeSwitchJournal(held, h.options); });
      assert.deepEqual(readClaudeSwitchJournal(h.options), { state: 'absent' });
    } finally { cleanup(h); }
  });

  it('delete fsyncs the journal parent directory best-effort after unlink', async () => {
    const h = harness();
    try {
      createClaudeSwitchJournal(h.journal, h.options);
      let fsyncCalls = 0;
      await withClaudeSwitchJournalOwner(h.options, (held) => {
        assert.doesNotThrow(() => deleteClaudeSwitchJournal(held, {
          ...h.options,
          fsyncDirectory: (path) => {
            fsyncCalls += 1;
            assert.equal(path, claudeSwitchJournalDir(h.options));
            throw new Error('fsync unavailable');
          },
        }));
      });
      assert.equal(fsyncCalls, 1);
      assert.deepEqual(readClaudeSwitchJournal(h.options), { state: 'absent' });
    } finally { cleanup(h); }
  });

  it('staged helpers write, read and delete under account qlb and read null when absent', async () => {
    const backend = new MemoryBackend(); const service = stagedRollbackService('stamp');
    assert.equal(await readStagedRollback(backend, service), null);
    await writeStagedRollback(backend, service, `${fixtureAccess}.${fixtureRefresh}`);
    assert.equal(await readStagedRollback(backend, service), `${fixtureAccess}.${fixtureRefresh}`);
    await deleteStagedRollback(backend, service); await deleteStagedRollback(backend, service);
    assert.equal(await readStagedRollback(backend, service), null);
    assert.ok(backend.calls.every((call) => call.account === 'qlb'));
  });
});
