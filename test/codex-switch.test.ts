import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  checkCodexSwitchPreconditions,
  codexRecoveryFenceState,
  freshenCodexTarget,
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
  releaseCodexSwitchJournalHeld,
  withCodexSwitchJournalOwner,
  writeCodexSwitchJournal,
} from '../src/codex-switch';
import { ClaudeCodeLockTimeout } from '../src/cc-locks';
import { codexLockPaths } from '../src/codex-consume';
import { accessExpiry, codexFingerprint, type CodexAuthDocument } from '../src/codex-auth';
import type { CodexProcess } from '../src/codex-sessions';
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

function freshenJwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function freshenDocument(expiry: number, refresh = 'freshen-refresh-a'): CodexAuthDocument {
  return {
    tokens: {
      id_token: freshenJwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'target', chatgpt_account_id: 'account' } }),
      access_token: freshenJwt({ exp: Math.floor(expiry / 1_000) }),
      refresh_token: refresh,
      account_id: 'account',
    },
    last_refresh: '2023-10-01T00:00:00.000Z',
  };
}

function freshenHarness(expiryOffset: number) {
  const h = fixture();
  const now = 1_700_000_000_000;
  const target = 'target:account';
  const journalDir = join(h.root, 'journal');
  let current = freshenDocument(now + expiryOffset);
  // The managed-slot metadata C10 checks before spending a grant (repairDrift).
  insertSlot(h.db, target);
  h.db.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?').run(codexFingerprint(current), target);
  let posts = 0;
  let writes = 0;
  let onTransport: () => void = () => {};
  const slots = {
    readSlot: () => ({ document: current, fingerprint: codexFingerprint(current) }),
    writeSlot: (_accountId: string, next: CodexAuthDocument) => { writes += 1; current = next; },
    stashUnclaimed: () => 'unused',
  };
  const transport = async () => {
    onTransport();
    posts += 1;
    return {
      status: 200,
      body: JSON.stringify({
        refresh_token: `freshen-refresh-${posts + 1}`,
        access_token: freshenJwt({ exp: Math.floor((now + 20 * 60_000) / 1_000) }),
      }),
    };
  };
  const run = (overrides: Partial<CodexSwitchDeps> = {}) => freshenCodexTarget(h.deps({
    dbPath: h.store.dbPath, slots, list: async () => [], transport, journalDir, ...overrides,
  }), { target, now });
  return {
    ...h, now, target, journalDir, slots, run, posts: () => posts, writes: () => writes, current: () => current,
    onTransport: (handler: () => void) => { onTransport = handler; },
  };
}

function recordFreshenHolder(h: ReturnType<typeof freshenHarness>, pid = 742): CodexProcess {
  h.store.recordSwitch({
    ts: 1, provider: 'openai-codex', fromAccount: 'old:account', toAccount: h.target,
    trigger: 'manual', outcome: 'failed',
  });
  return { pid, lstart: 'Fri Oct 24 12:00:00 2026', host: 'codex' };
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

describe('Codex recovery fence state — C6-12', () => {
  it('a journal and a config fence together fence the union and report the journal\'s reason', () => {
    const h = fixture();
    const journalDir = join(h.root, 'journal');
    try {
      writeCodexSwitchJournal(journalFixture(h.root, {
        unresolved: { reason: 'slot-split', involvedAccounts: ['from:account', 'journal-third:account'], since: 1 },
      }), { journalDir });
      h.store.setConfig('codex.recoveryFence', JSON.stringify({
        v: 1, switchId: 1, attempt: 'fence-attempt', from: 'fence-from:account', to: 'fence-to:account',
        publishedAt: 1, reason: 'target-ancestor', involvedAccounts: ['fence-third:account'], since: 1,
      }));
      const state = codexRecoveryFenceState(journalDir, h.store);
      assert.equal(state.state, 'fenced');
      if (state.state !== 'fenced') return;
      assert.equal(state.reason, 'slot-split');
      assert.equal(state.message, 'Codex switch recovery needs you (slot-split): log in to Codex with the account you want (codex login), then run qlb codex import-active. QLB finishes the recovery at its next check.');
      assert.deepEqual((state.accounts === '*' ? [] : [...state.accounts]).sort(), [
        'fence-from:account', 'fence-third:account', 'fence-to:account', 'from:account', 'journal-third:account', 'to:account',
      ]);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});

describe('Codex recovery fence state — C6-12 review r1', () => {
  it('a present recovery-fence row with a NULL value fences every account as malformed', () => {
    const h = fixture();
    try {
      h.db.prepare("INSERT INTO config (key, value) VALUES ('codex.recoveryFence', NULL)").run();
      const state = codexRecoveryFenceState(join(h.root, 'no-journal'), h.store);
      assert.equal(state.state, 'fenced');
      if (state.state !== 'fenced') return;
      assert.equal(state.accounts, '*');
      assert.equal(state.reason, 'switch-recovery-malformed');
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('an in-flight journal is refused switch-in-flight without the unresolved-fence login instruction', () => {
    const h = fixture();
    const journalDir = join(h.root, 'journal');
    try {
      writeCodexSwitchJournal(journalFixture(h.root), { journalDir });
      const state = codexRecoveryFenceState(journalDir, h.store);
      assert.equal(state.state, 'fenced');
      if (state.state !== 'fenced') return;
      assert.equal(state.reason, 'switch-in-flight');
      assert.doesNotMatch(state.message, /codex login|import-active/);
      assert.deepEqual((state.accounts === '*' ? [] : [...state.accounts]).sort(), ['from:account', 'to:account']);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});

describe('Codex target freshen — C6-12b', () => {
  it('a target with more than ten minutes left is not freshened (0 transport calls)', async () => {
    const h = freshenHarness(10 * 60_000 + 1_000);
    try {
      assert.deepEqual(await h.run(), { kind: 'go' });
      assert.equal(h.posts(), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a target whose recorded metadata disagrees with its slot is refused slot-split with no POST (C6-12b r1)', async () => {
    const h = freshenHarness(9 * 60_000);
    try {
      h.db.prepare("UPDATE codex_slots SET fingerprint = 'some-other-lineage' WHERE account_id = ?").run(h.target);
      assert.deepEqual(await h.run(), { kind: 'refused', reason: 'target-freshen-slot-split' });
      assert.equal(h.posts(), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a slot whose document is another account is refused without a POST (C6-12b r1)', async () => {
    const h = freshenHarness(9 * 60_000);
    try {
      const other = freshenDocument(h.now + 9 * 60_000);
      other.tokens = { ...other.tokens!, id_token: freshenJwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'someone-else', chatgpt_account_id: 'account' } }) };
      assert.deepEqual(await h.run({ slots: { ...h.slots, readSlot: () => ({ document: other, fingerprint: codexFingerprint(other) }) } }), { kind: 'refused', reason: 'target-freshen-slot-removed' });
      assert.equal(h.posts(), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a target another process refreshed while this freshen waited for the locks is not refreshed again (C6-12b r2)', async () => {
    const h = freshenHarness(9 * 60_000);
    try {
      const stale = h.current();
      const refreshed = freshenDocument(h.now + 20 * 60_000, 'freshen-refresh-other');
      let reads = 0;
      const readSlot = () => {
        reads += 1;
        const document = reads === 1 ? stale : refreshed;
        return { document, fingerprint: codexFingerprint(document) };
      };
      assert.deepEqual(await h.run({ slots: { ...h.slots, readSlot } }), { kind: 'go' });
      assert.equal(h.posts(), 0);
      assert.equal(h.writes(), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a target within ten minutes and no holder is refreshed once under consume then switch lock', async () => {
    const h = freshenHarness(9 * 60_000);
    try {
      const paths = codexLockPaths(h.store.dbPath, h.target);
      h.onTransport(() => {
        assert.equal(existsSync(paths.consume), true);
        assert.equal(existsSync(paths.switch), true);
      });
      assert.deepEqual(await h.run(), { kind: 'go' });
      assert.equal(h.posts(), 1);
      assert.equal(existsSync(paths.consume), false);
      assert.equal(existsSync(paths.switch), false);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a held target with more than five minutes left skips the freshen', async () => {
    const h = freshenHarness(6 * 60_000);
    try {
      const holder = recordFreshenHolder(h);
      assert.deepEqual(await h.run({ list: async () => [holder] }), { kind: 'go' });
      assert.equal(h.posts(), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a held target with five minutes or less is refused target-held-by-session naming the pids', async () => {
    const h = freshenHarness(5 * 60_000);
    try {
      const holder = recordFreshenHolder(h, 743);
      assert.deepEqual(await h.run({ list: async () => [holder] }), {
        kind: 'refused', reason: 'target-held-by-session', pids: [743],
      });
      assert.equal(h.posts(), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a target that became active while waiting returns go without a POST', async () => {
    const h = freshenHarness(9 * 60_000);
    try {
      assert.deepEqual(await h.run({ list: async () => {
        h.store.setActiveLogin('openai-codex', h.target, 'import');
        return [];
      } }), { kind: 'go' });
      assert.equal(h.posts(), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it(`a journal written (C6-10 writer) after this switch's recovery and before its freshen lock makes the freshen send zero POSTs and write nothing`, async () => {
    const h = freshenHarness(9 * 60_000);
    try {
      assert.deepEqual(await h.run({ list: async () => {
        writeCodexSwitchJournal(journalFixture(h.root, {
          from: 'from:account', to: h.target,
          target: { identity: { chatgpt_user_id: 'target', account_id: 'account' }, fingerprint: 'fp-target' },
        }), { journalDir: h.journalDir });
        return [];
      } }), { kind: 'refused', reason: 'switch-in-flight' });
      assert.equal(h.posts(), 0);
      assert.equal(h.writes(), 0);
      assert.deepEqual(switchRows(h.db), []);
    } finally { executingCodexAttempts.clear(); h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a fence naming the target as a third account refuses the freshen', async () => {
    const h = freshenHarness(9 * 60_000);
    try {
      h.store.setConfig('codex.recoveryFence', JSON.stringify({
        v: 1, switchId: 1, attempt: 'fence-attempt', from: 'from:account', to: 'to:account',
        publishedAt: h.now, reason: 'slot-split', involvedAccounts: [h.target], since: h.now,
      }));
      assert.deepEqual(await h.run(), { kind: 'refused', reason: 'slot-split' });
      assert.equal(h.posts(), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a crash after the freshen leaves B fresh and the rerun sends no second POST', async () => {
    const h = freshenHarness(9 * 60_000);
    try {
      assert.deepEqual(await h.run(), { kind: 'go' });
      assert.ok((accessExpiry(h.current()) ?? 0) > h.now + 10 * 60_000);
      assert.deepEqual(await h.run(), { kind: 'go' });
      assert.equal(h.posts(), 1);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });
});

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

  it('the journal writer persists only allowlisted fields, so extra caller properties never reach disk', () => {
    const h = journalHarness();
    try {
      const fixture = journalFixture(h.root);
      const leaky = { ...fixture, extraSecret: 'fixture-token-value',
        openSessions: [{ ...fixture.openSessions[0], access_token: 'fixture-token-value' } as CodexSwitchJournal['openSessions'][number]] } as CodexSwitchJournal;
      writeCodexSwitchJournal(leaky, h.options);
      assert.doesNotMatch(readFileSync(codexSwitchJournalPath(h.options), 'utf8'), /fixture-token-value/);
      assert.deepEqual(readCodexSwitchJournal(h.options), { state: 'ok', journal: fixture });
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a recovery mark does not re-register a finished attempt, so the same process can still resume it', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root, { owner: { pid: process.pid, lstart: 'fixture', state: 'active' } }), h.options);
      finishCodexSwitchAttempt('attempt-1');
      const probe = await probeCodexSwitchJournal({ ...h.options, sameProcess: async () => true },
        ({ held }) => markCodexSwitchJournalUnresolved(held, 'attempt-1', 'slot-split', ['from:account'], h.options));
      assert.equal(probe.state === 'orphaned' ? probe.result : undefined, true);
      assert.equal(executingCodexAttempts.has('attempt-1'), false);
      assert.equal((await probeCodexSwitchJournal({ ...h.options, sameProcess: async () => true })).state, 'orphaned');
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('an orphaned journal is handed over with the owner lock held, and release works under that lock', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root), h.options);
      const probe = await probeCodexSwitchJournal(h.options, ({ held }) => releaseCodexSwitchJournalHeld(held, 'attempt-1', h.options));
      assert.equal(probe.state === 'orphaned' ? probe.result : undefined, true);
      const read = readCodexSwitchJournal(h.options);
      assert.equal(read.state === 'ok' ? read.journal.owner.state : undefined, 'released');
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a live successor that replaced the journal while the probe waited for the owner lock is in progress, not orphaned', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root), h.options);
      const options = { ...h.options, ownerLockTimeoutMs: 5_000, sameProcess: async (owner: { pid: number }) => owner.pid === 4242 };
      let probe: ReturnType<typeof probeCodexSwitchJournal> | undefined;
      await withCodexSwitchJournalOwner(options, async () => {
        probe = probeCodexSwitchJournal(options, () => assert.fail('a live successor must not be handed over'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        writeCodexSwitchJournal(journalFixture(h.root, { attemptId: 'attempt-2', owner: { pid: 4242, lstart: 'successor', state: 'active' } }), options);
      });
      const result = await probe!;
      assert.equal(result.state, 'in-progress');
      assert.equal(result.state === 'in-progress' ? result.journal.attemptId : undefined, 'attempt-2');
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a lock timeout thrown inside onOrphaned propagates instead of reading as owner-lock-not-yet-stale', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root), h.options);
      await assert.rejects(probeCodexSwitchJournal(h.options, () => { throw new ClaudeCodeLockTimeout('other.lock'); }),
        (error: unknown) => error instanceof ClaudeCodeLockTimeout);
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a live successor holding the owner lock past the probe timeout is in progress', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root), h.options);
      const options = { ...h.options, ownerLockTimeoutMs: 5_000, sameProcess: async (owner: { pid: number }) => owner.pid === 4242 };
      const result = await withCodexSwitchJournalOwner(options, async () => {
        // The probe's first read sees the dead owner; the successor then writes and keeps the lock.
        const probe = probeCodexSwitchJournal({ ...options, ownerLockTimeoutMs: 20 });
        writeCodexSwitchJournal(journalFixture(h.root, { attemptId: 'attempt-2', owner: { pid: 4242, lstart: 'successor', state: 'active' } }), options);
        return probe;
      });
      assert.equal(result.state, 'in-progress');
      assert.equal(result.state === 'in-progress' ? result.journal.attemptId : undefined, 'attempt-2');
    } finally { executingCodexAttempts.clear(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('an owner lease lost during a journal operation is reported as a failure, not success', async () => {
    const h = journalHarness();
    try {
      writeCodexSwitchJournal(journalFixture(h.root), h.options);
      const lock = codexSwitchJournalOwnerLockPath(h.options);
      await assert.rejects(withCodexSwitchJournalOwner(h.options, () => {
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        return true;
      }));
      assert.ok(statSync(lock).isDirectory(), "the successor's lock is left in place");
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
