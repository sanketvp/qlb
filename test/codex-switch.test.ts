import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  checkCodexSwitchPreconditions,
  preflightCodexLive,
  type CodexSwitchDeps,
  type CodexSwitchJournal,
  codexSwitchJournalOwnerLockPath,
  codexSwitchJournalPath,
  deleteCodexSwitchJournalIf,
  executingCodexAttempts,
  finishCodexSwitchAttempt,
  markCodexSwitchJournalUnresolved,
  probeCodexSwitchJournal,
  readCodexSwitchJournal,
  releaseCodexSwitchJournal,
  withCodexSwitchJournalOwner,
  writeCodexSwitchJournal,
} from '../src/codex-switch';
import { openStore } from '../src/store';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-switch-'));
  const stashDir = join(root, 'stash');
  mkdirSync(stashDir);
  const store = openStore(join(root, 'qlb.db'));
  const db = (store as unknown as { db: DatabaseSync }).db;
  const deps = (overrides: Partial<CodexSwitchDeps> = {}): CodexSwitchDeps => ({
    store,
    readLive: async () => ({ status: 'ok', doc: {} as never, sha256: 'sha256-file:fixture', inode: 1 }),
    cswapProcesses: () => [],
    now: () => 1_700_000_000_000,
    attempt: 'attempt-fixture',
    ...overrides,
  });
  return { root, stashDir, store, db, deps };
}

function insertSlot(db: DatabaseSync, accountId: string, options: { dead?: boolean; pendingAdopt?: boolean } = {}): void {
  const separator = accountId.indexOf(':');
  db.prepare(`INSERT INTO codex_slots (
    account_id, chatgpt_user_id, chatgpt_account_id, fingerprint, prev_fingerprint,
    dead, pending_adopt, added_at, source
  ) VALUES (?, ?, ?, 'fingerprint', NULL, ?, ?, 1, 'fixture')`).run(
    accountId,
    separator === -1 ? accountId : accountId.slice(0, separator),
    separator === -1 ? accountId : accountId.slice(separator + 1),
    options.dead ? 1 : 0,
    options.pendingAdopt ? 1 : 0,
  );
}

function switchRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return (db.prepare(`SELECT provider, from_account, to_account, trigger, outcome, detail, steps_json, published_at
    FROM switch_log ORDER BY id`).all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
}

describe('Codex switch preflight and preconditions', () => {
  it('refuses a missing, dead or pending-adopt target with one refused row', () => {
    const h = fixture();
    try {
      h.store.setActiveLogin('openai-codex', 'from:account', 'import');
      insertSlot(h.db, 'dead:account', { dead: true });
      insertSlot(h.db, 'pending:account', { pendingAdopt: true });

      const cases = [
        ['missing:account', 'target-missing'],
        ['dead:account', 'target-dead'],
        ['pending:account', 'target-pending-adopt'],
      ] as const;
      for (const [target, reason] of cases) {
        const result = checkCodexSwitchPreconditions(h.deps(), { target, trigger: 'manual' });
        assert.equal(result.kind, 'refused');
        if (result.kind === 'refused') assert.equal(result.reason, reason);
      }

      assert.deepEqual(switchRows(h.db), cases.map(([target, reason]) => ({
        provider: 'openai-codex', from_account: 'from:account', to_account: target,
        trigger: 'manual', outcome: 'refused', detail: reason,
        steps_json: JSON.stringify({ attempt: 'attempt-fixture', via: 'switch' }), published_at: null,
      })));
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('refuses when a C-swap process is alive or the process table cannot be read', () => {
    const h = fixture();
    try {
      insertSlot(h.db, 'target:account');
      const alive = checkCodexSwitchPreconditions(h.deps({ cswapProcesses: () => [{ pid: 1 }] }), {
        target: 'target:account', trigger: 'manual',
      });
      const unreadable = checkCodexSwitchPreconditions(h.deps({ cswapProcesses: () => { throw new Error('fixture'); } }), {
        target: 'target:account', trigger: 'manual',
      });
      assert.deepEqual([alive, unreadable].map((result) => result.kind === 'refused' ? result.reason : result.kind), [
        'cswap-process-alive', 'cswap-process-check-failed',
      ]);
      assert.deepEqual(switchRows(h.db).map((row) => row.detail), ['cswap-process-alive', 'cswap-process-check-failed']);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('a failed refusal write is not recorded as a process-table failure', () => {
    const h = fixture();
    try {
      insertSlot(h.db, 'target:account');
      const store = Object.create(h.store) as typeof h.store;
      let writes = 0;
      store.recordSwitch = (input) => {
        writes += 1;
        if (writes === 1) throw new Error('fixture store write failed');
        return h.store.recordSwitch(input);
      };
      assert.throws(
        () => checkCodexSwitchPreconditions(h.deps({ store, cswapProcesses: () => [{ pid: 1 }] }), {
          target: 'target:account', trigger: 'manual',
        }),
        /fixture store write failed/,
      );
      assert.equal(writes, 1, 'no second refusal row is attempted');
      assert.equal(switchRows(h.db).length, 0);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('an automatic trigger without codex.l13VerifiedAt is refused codex-l13-unverified', () => {
    const h = fixture();
    try {
      insertSlot(h.db, 'target:account');
      const result = checkCodexSwitchPreconditions(h.deps(), { target: 'target:account', trigger: 'proactive' });
      assert.deepEqual(result.kind === 'refused' ? result.reason : result.kind, 'codex-l13-unverified');
      assert.deepEqual(switchRows(h.db).map((row) => row.detail), ['codex-l13-unverified']);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('a manual trigger does not need the l13 receipt', () => {
    const h = fixture();
    try {
      insertSlot(h.db, 'target:account');
      assert.deepEqual(checkCodexSwitchPreconditions(h.deps(), { target: 'target:account', trigger: 'manual' }), { kind: 'go' });
      assert.equal(switchRows(h.db).length, 0);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('preflight writes nothing for a missing or unreadable file', async () => {
    const h = fixture();
    try {
      h.store.setConfig('fixture.config', 'unchanged');
      const configBefore = h.db.prepare('SELECT key, value FROM config ORDER BY key').all();
      const rowsBefore = switchRows(h.db);
      const stashBefore = readdirSync(h.stashDir);

      assert.deepEqual(await preflightCodexLive(h.deps({ readLive: async () => ({ status: 'missing' }) })), {
        kind: 'refused', reason: 'codex-logged-out', write: false,
      });
      assert.deepEqual(await preflightCodexLive(h.deps({ readLive: async () => ({ status: 'unreadable', code: 'EACCES' }) })), {
        kind: 'refused', reason: 'codex-auth-unreadable', write: false,
      });
      assert.deepEqual(switchRows(h.db), rowsBefore);
      assert.deepEqual(h.db.prepare('SELECT key, value FROM config ORDER BY key').all(), configBefore);
      assert.deepEqual(readdirSync(h.stashDir), stashBefore);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});

function journalFixture(root: string, overrides: Partial<CodexSwitchJournal> = {}): CodexSwitchJournal {
  return {
    v: 2, attemptId: 'attempt-1', from: 'from:account', to: 'to:account',
    target: { identity: { chatgpt_user_id: 'target', account_id: 'account' }, fingerprint: 'fp-target' },
    adoptingTarget: [], trigger: 'manual', decision: null,
    openSessions: [{ pid: 4101, lstart: 'Tue Oct 28 10:00:00 2026', host: 'codex' }],
    outgoing: { sha256: 'sha256-file:outgoing', inode: 42 }, publishedAt: 1_700_000_000_000,
    owner: { pid: 4101, lstart: 'Tue Oct 28 10:00:00 2026', state: 'active' },
    ...overrides,
  };
}

function journalHarness() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-journal-'));
  const journalDir = join(root, 'qlb', '.qlb', 'journal');
  const options = {
    journalDir, now: () => 1_700_000_000_000,
    sameProcess: async () => false,
    ownerLockTimeoutMs: 20, ownerLockRetryMinMs: 1, ownerLockRetryJitterMs: 0,
  };
  return { root, journalDir, options };
}

describe('Codex switch journal v2', () => {
  it('journal v2 round-trips at mode 0600 and contains no token value', () => {
    const h = journalHarness();
    try {
      let fsynced = '';
      writeCodexSwitchJournal(journalFixture(h.root), { ...h.options, fsyncDirectory: (path) => { fsynced = path; } });
      const path = codexSwitchJournalPath(h.options);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(fsynced, h.journalDir);
      assert.deepEqual(readCodexSwitchJournal(h.options), { state: 'ok', journal: journalFixture(h.root) });
      assert.doesNotMatch(readFileSync(path, 'utf8'), /fixture-token-value/);
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a truncated or v1 journal reads as malformed', () => {
    const h = journalHarness();
    try {
      mkdirSync(h.journalDir, { recursive: true });
      writeFileSync(codexSwitchJournalPath(h.options), '{"v":2');
      assert.deepEqual(readCodexSwitchJournal(h.options), { state: 'malformed' });
      writeFileSync(codexSwitchJournalPath(h.options), JSON.stringify({ ...journalFixture(h.root), v: 1 }));
      assert.deepEqual(readCodexSwitchJournal(h.options), { state: 'malformed' });
    } finally { rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a journal whose owner pid is alive with the same lstart and state active is in progress even after its lock went stale', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root), h.options);
      mkdirSync(codexSwitchJournalOwnerLockPath(h.options), { recursive: true });
      utimesSync(codexSwitchJournalOwnerLockPath(h.options), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
      const result = await probeCodexSwitchJournal({ ...h.options, sameProcess: async () => true });
      assert.equal(result.state, 'in-progress');
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a released journal owned by a live process is resumable', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root, { owner: { pid: 4101, lstart: 'Tue Oct 28 10:00:00 2026', state: 'released' } }), h.options);
      assert.equal((await probeCodexSwitchJournal({ ...h.options, sameProcess: async () => true })).state, 'orphaned');
      assert.equal(await releaseCodexSwitchJournal('attempt-1', h.options), true);
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a journal owned by this process whose attempt is no longer executing is resumable without a restart', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root, { owner: { pid: process.pid, lstart: 'fixture', state: 'active' } }), h.options);
      finishCodexSwitchAttempt('attempt-1');
      assert.equal((await probeCodexSwitchJournal({ ...h.options, sameProcess: async () => true })).state, 'orphaned');
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it(`a dead owner's fresh lock refuses with the retry time and the next attempt after five minutes recovers`, async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root), h.options);
      mkdirSync(codexSwitchJournalOwnerLockPath(h.options), { recursive: true });
      const fresh = await probeCodexSwitchJournal(h.options);
      assert.equal(fresh.state, 'owner-lock-not-yet-stale');
      if (fresh.state === 'owner-lock-not-yet-stale') assert.ok(fresh.retryAt > Date.now());
      utimesSync(codexSwitchJournalOwnerLockPath(h.options), new Date(Date.now() - 300_001), new Date(Date.now() - 300_001));
      assert.equal((await probeCodexSwitchJournal(h.options)).state, 'orphaned');
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it(`a dead owner's stale lock is reclaimed and reads orphaned`, async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root), h.options);
      mkdirSync(codexSwitchJournalOwnerLockPath(h.options), { recursive: true });
      utimesSync(codexSwitchJournalOwnerLockPath(h.options), new Date(Date.now() - 300_001), new Date(Date.now() - 300_001));
      assert.equal((await probeCodexSwitchJournal(h.options)).state, 'orphaned');
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('an unresolved mark unions involved accounts and never shrinks them', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root), h.options);
      await withCodexSwitchJournalOwner(h.options, (held) => {
        assert.equal(markCodexSwitchJournalUnresolved(held, 'attempt-1', 'slot-split', ['from:account', 'third:account'], h.options), true);
        assert.equal(markCodexSwitchJournalUnresolved(held, 'attempt-1', 'target-ancestor', ['to:account'], h.options), true);
      });
      const read = readCodexSwitchJournal(h.options);
      assert.deepEqual(read.state === 'ok' ? read.journal.unresolved?.involvedAccounts : undefined, ['from:account', 'third:account', 'to:account']);
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a conditional delete or mark with another attempt id leaves the file', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root), h.options);
      await withCodexSwitchJournalOwner(h.options, (held) => {
        assert.equal(markCodexSwitchJournalUnresolved(held, 'another-attempt', 'slot-split', ['third:account'], h.options), false);
        assert.equal(deleteCodexSwitchJournalIf(h.journalDir, 'another-attempt', held, h.options), false);
      });
      assert.equal(readCodexSwitchJournal(h.options).state, 'ok');
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });
});
