import assert from 'node:assert/strict';
import { existsSync, fsyncSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  attributeForPhase,
  checkCodexSwitchPreconditions,
  classifyPostPublish,
  codexWatchTick,
  runDueCodexWatches,
  type CodexWatch,
  resolveRecoveryVerdict,
  reconcileCodexRecovery,
  reconcileCodexRecoveryLocked,
  switchCodex,
  codexRecoveryFenceState,
  freshenCodexTarget,
  preflightCodexLive,
  publishCodexAuth,
  type CodexSwitchDeps,
  type CodexSwitchJournal,
  codexSwitchJournalOwnerLockPath,
  codexSwitchJournalPath,
  deleteCodexSwitchJournalIf,
  executingCodexAttempts,
  finishCodexSwitchAttempt,
  markCodexSwitchJournalUnresolved,
  observeLiveCodex,
  withCodexSwitchLocks,
  CodexLiveChanged,
  probeCodexSwitchJournal,
  readCodexSwitchJournal,
  releaseCodexSwitchJournal,
  releaseCodexSwitchJournalHeld,
  withCodexSwitchJournalOwner,
  writeCodexSwitchJournal,
} from '../src/codex-switch';
import { ClaudeCodeLockTimeout, CodexAuthLockCompromised, codexAuthLockDir, withCodexAuthLock } from '../src/cc-locks';
import { codexLockPaths, consumeCodexSlot, withCodexSwitchLock } from '../src/codex-consume';
import { accessExpiry, codexFingerprint, codexIdentity, readCodexAuthStable, readCodexAuthStableWithStat, writeCodexAuthAtomic, type CodexAuthDocument } from '../src/codex-auth';
import { CodexStashUnverifiable, importActiveCodexSlot } from '../src/codex-slots';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { holderSets, readCodexSwitchHistory, stillTheSameProcess, type CodexProcess } from '../src/codex-sessions';
import { consumeUnderCodexLocks, runCodexRefreshCommand } from '../src/commands/codex-refresh';
import { runCodexImportActiveCommand } from '../src/commands/codex-import-active';
import type { CommandContext } from '../src/registry';
import { assertAdmitted, beginCutover, type LifecycleOperation } from '../src/lifecycle';
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

function observedDocument(user: string, refresh: string): CodexAuthDocument {
  const document = freshenDocument(1_700_100_000_000, refresh);
  return {
    ...document,
    tokens: {
      ...document.tokens,
      id_token: freshenJwt({ 'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_account_id: 'account' } }),
    },
  };
}

function observeHarness() {
  const h = fixture();
  const keychain = new MockKeychain();
  const authPath = join(h.root, 'auth.json');
  const a0 = observedDocument('a', 'a0');
  const plan = importActiveCodexSlot(a0, { store: h.store, keychain, now: () => 1 });
  writeFileSync(authPath, JSON.stringify(a0));
  // Idempotent by fingerprint, like CodexSlots.ensureUnclaimedStash.
  const stashed = new Set<string>();
  let stashError: Error | undefined;
  const slots = {
    readSlot: (accountId: string) => {
      const document = JSON.parse(keychain.getSync(qlbKeychainService('openai-codex', accountId), QLB_KEYCHAIN_ACCOUNT)) as CodexAuthDocument;
      return { document, fingerprint: codexFingerprint(document) };
    },
    ensureUnclaimedStash: async (document: CodexAuthDocument) => {
      if (stashError) throw stashError;
      const fingerprint = codexFingerprint(document);
      const created = !stashed.has(fingerprint);
      stashed.add(fingerprint);
      return { stashId: `fixture-stash-${fingerprint}`, created };
    },
  };
  const run = (overrides: Partial<CodexSwitchDeps> = {}, assertHeld: () => void = () => undefined) => observeLiveCodex(h.deps({
    dbPath: h.store.dbPath,
    authPath,
    keychain,
    slots: slots as never,
    list: async () => [],
    readLive: () => readCodexAuthStableWithStat(authPath, { delayMs: 0 }),
    ...overrides,
  }), assertHeld);
  return {
    ...h, keychain, authPath, a0, plan, slots, run,
    stashes: () => stashed.size,
    stashError: (error: Error | undefined) => { stashError = error; },
  };
}

function scalarCount(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count;
}

function switchRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return (db.prepare(`SELECT provider, from_account, to_account, trigger, outcome, detail, steps_json, published_at
    FROM switch_log ORDER BY id`).all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
}

function switchHarness() {
  const h = fixture();
  const keychain = new MockKeychain();
  const authPath = join(h.root, 'auth.json');
  const now = 1_700_000_000_000;
  const a = observedDocument('a', 'switch-a');
  const b = observedDocument('b', 'switch-b');
  importActiveCodexSlot(a, { store: h.store, keychain, now: () => now - 10 });
  importActiveCodexSlot(b, { store: h.store, keychain, now: () => now - 5 });
  h.store.setActiveLogin('openai-codex', 'a:account', 'import', now - 1);
  writeFileSync(authPath, JSON.stringify(a));
  const slots = {
    readSlot: (id: string) => {
      const text = keychain.getSync(qlbKeychainService('openai-codex', id), QLB_KEYCHAIN_ACCOUNT);
      // As CodexSlots.readService: an unparseable stored document is reported as malformed.
      let doc: CodexAuthDocument;
      try { doc = JSON.parse(text) as CodexAuthDocument; } catch { throw new Error('stored Codex document is malformed'); }
      return { document: doc, fingerprint: codexFingerprint(doc) };
    },
    writeSlot: (id: string, document: CodexAuthDocument) => {
      keychain.setSync(qlbKeychainService('openai-codex', id), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(document));
      h.db.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?').run(codexFingerprint(document), id);
    },
    stashUnclaimed: () => 'unused',
    ensureUnclaimedStash: async () => ({ stashId: 'unused', created: false }),
  };
  let tick = now;
  const runWith = (overrides: Partial<CodexSwitchDeps> = {}, input = { target: 'b:account', trigger: 'manual' }) => switchCodex(h.deps({ authPath, dbPath: h.store.dbPath, journalDir: join(h.root, 'journal'),
    authLockOptions: { home: h.root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 }, keychain, slots: slots as never,
    list: async () => [], transport: async () => { throw new Error('unexpected transport'); }, readLive: () => readCodexAuthStableWithStat(authPath, { delayMs: 0 }), now: () => tick++,
    sleep: async () => undefined, journalOwner: { pid: process.pid, lstart: 'fixture-owner' }, attempt: 'switch-attempt', ...overrides }), input);
  const recover = (overrides: Partial<CodexSwitchDeps> = {}) => reconcileCodexRecovery(h.deps({ authPath, dbPath: h.store.dbPath, journalDir: join(h.root, 'journal'),
    authLockOptions: { home: h.root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 }, keychain, slots: slots as never,
    list: async () => [], transport: async () => { throw new Error('unexpected transport'); }, readLive: () => readCodexAuthStableWithStat(authPath, { delayMs: 0 }), now: () => tick++,
    journalOwner: { pid: process.pid, lstart: 'fixture-owner' }, attempt: 'recovery-attempt', ...overrides }));
  const recoverLocked = (assertHeld: () => void, overrides: Partial<CodexSwitchDeps> = {}) => reconcileCodexRecoveryLocked(h.deps({ authPath,
    dbPath: h.store.dbPath, journalDir: join(h.root, 'journal'), keychain, slots: slots as never, list: async () => [],
    readLive: () => readCodexAuthStableWithStat(authPath, { delayMs: 0 }), now: () => tick++, attempt: 'recovery-attempt', ...overrides }), assertHeld);
  return { ...h, authPath, a, b, keychain, slots, run: () => runWith(), runWith, recover, recoverLocked };
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

describe('Codex publish wrapper and post-publish classifier — C6-14', () => {
  function document(refresh: string): CodexAuthDocument {
    return freshenDocument(1_700_000_000_000 + 60 * 60_000, refresh);
  }

  function journal(root: string, target: CodexAuthDocument, overrides: Partial<CodexSwitchJournal> = {}): CodexSwitchJournal {
    return journalFixture(root, {
      target: { identity: { chatgpt_user_id: 'target', account_id: 'account' }, fingerprint: codexFingerprint(target) },
      ...overrides,
    });
  }

  it('the published target bytes classify ok', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-publish-'));
    try {
      const path = join(root, 'auth.json');
      const target = document('target-refresh');
      const result = await publishCodexAuth(path, target);
      assert.equal(result.stage, 'published');
      const observed = await readCodexAuthStableWithStat(path, { delayMs: 0 });
      assert.equal(classifyPostPublish({ journal: journal(root, target), publish: result, observed,
        targetSlotFp: codexFingerprint(target) }), 'ok');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a thrown rename classifies not-landed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-publish-'));
    const mutableFs = require('node:fs') as { renameSync: typeof renameSync };
    const originalRename = mutableFs.renameSync;
    try {
      const path = join(root, 'auth.json');
      const target = document('target-refresh');
      mutableFs.renameSync = () => { throw Object.assign(new Error('fixture rename failure'), { code: 'ENOSPC' }); };
      const result = await publishCodexAuth(path, target);
      assert.equal(result.stage, 'rename-threw');
      const observed = { status: 'ok', doc: target, sha256: 'sha256-file:target', inode: 101 } as const;
      assert.equal(classifyPostPublish({ journal: journal(root, target), publish: result, observed,
        targetSlotFp: codexFingerprint(target) }), 'not-landed');
    } finally {
      mutableFs.renameSync = originalRename;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('unchanged inode and bytes classify not-landed in recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-publish-'));
    try {
      const target = document('target-refresh');
      const unchanged = { status: 'ok', doc: target, sha256: 'sha256-file:outgoing', inode: 42 } as const;
      assert.equal(classifyPostPublish({ journal: journal(root, target), observed: unchanged,
        targetSlotFp: codexFingerprint(target) }), 'not-landed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a parent-directory fsync error after the rename is verified, never classified not-landed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-publish-'));
    const mutableFs = require('node:fs') as { fsyncSync: typeof fsyncSync };
    const originalFsync = mutableFs.fsyncSync;
    let fsyncs = 0;
    try {
      const path = join(root, 'auth.json');
      const target = document('target-refresh');
      mutableFs.fsyncSync = ((fd: number) => {
        fsyncs += 1;
        if (fsyncs === 2) throw Object.assign(new Error('fixture directory fsync failure'), { code: 'EIO' });
        return originalFsync(fd);
      }) as typeof fsyncSync;
      const result = await publishCodexAuth(path, target);
      assert.equal(result.stage, 'published');
      assert.ok(result.dirFsyncError instanceof Error);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), target, 'rename landed before the directory sync failed');
      const observed = await readCodexAuthStableWithStat(path, { delayMs: 0 });
      assert.equal(classifyPostPublish({ journal: journal(root, target), publish: result, observed,
        targetSlotFp: codexFingerprint(target) }), 'ok');
    } finally {
      mutableFs.fsyncSync = originalFsync;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a publish through a symlinked auth.json fsyncs the directory the rename landed in (C6-14 r1)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-publish-'));
    const mutableFs = require('node:fs') as { openSync: typeof import('node:fs').openSync };
    const originalOpen = mutableFs.openSync;
    const opened: string[] = [];
    try {
      const realDir = join(root, 'real');
      const linkDir = join(root, 'codex');
      mkdirSync(realDir);
      mkdirSync(linkDir);
      writeFileSync(join(realDir, 'auth.json'), '{}\n');
      const path = join(linkDir, 'auth.json');
      symlinkSync(join(realDir, 'auth.json'), path);
      const target = document('target-refresh');
      mutableFs.openSync = ((file: Parameters<typeof originalOpen>[0], ...rest: unknown[]) => {
        opened.push(String(file));
        return (originalOpen as (...args: unknown[]) => number)(file, ...rest);
      }) as typeof originalOpen;
      const result = await publishCodexAuth(path, target);
      mutableFs.openSync = originalOpen;
      assert.equal(result.stage, 'published');
      assert.equal(result.stage === 'published' ? result.dirFsyncError : 'n/a', undefined);
      assert.ok(lstatSync(path).isSymbolicLink(), 'the symlink is written through, not replaced');
      assert.deepEqual(JSON.parse(readFileSync(join(realDir, 'auth.json'), 'utf8')), target);
      assert.ok(opened.includes(realpathSync(realDir)), `the rename's directory is fsynced (opened: ${opened.join(', ')})`);
    } finally {
      mutableFs.openSync = originalOpen;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('slot B replaced after the swap with the live file still on the published bytes classifies target-changed', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-publish-'));
    try {
      const target = document('target-refresh');
      const observed = { status: 'ok', doc: target, sha256: 'sha256-file:target', inode: 101 } as const;
      assert.equal(classifyPostPublish({ journal: journal(root, target), observed,
        targetSlotFp: 'sha256:replacement' }), 'target-changed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('slot B and the live file both moved to B′ by an import after the swap classify target-changed, not ok', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-publish-'));
    try {
      const target = document('target-refresh');
      const imported = { ...target, last_refresh: '2023-10-02T00:00:00.000Z' };
      const observed = { status: 'ok', doc: imported, sha256: 'sha256-file:imported', inode: 101 } as const;
      assert.equal(classifyPostPublish({ journal: journal(root, target), observed,
        targetSlotFp: 'sha256:imported-slot' }), 'target-changed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("slot B moved by QLB's own recorded post-publish adopt is not target-changed", () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-publish-'));
    try {
      const target = document('target-refresh');
      const adopted = document('adopted-refresh');
      const observed = { status: 'ok', doc: adopted, sha256: 'sha256-file:adopted', inode: 101 } as const;
      assert.deepEqual(classifyPostPublish({ journal: journal(root, target, { adoptingTarget: [codexFingerprint(adopted)] }), observed,
        targetSlotFp: codexFingerprint(adopted) }), { status: 'external', doc: adopted });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the outgoing inode with different bytes is external', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-publish-'));
    try {
      const target = document('target-refresh');
      const external = document('external-refresh');
      const observed = { status: 'ok', doc: external, sha256: 'sha256-file:external', inode: 42 } as const;
      assert.deepEqual(classifyPostPublish({ journal: journal(root, target), observed,
        targetSlotFp: codexFingerprint(target) }), { status: 'external', doc: external });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('unreadable passes through', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-publish-'));
    try {
      const target = document('target-refresh');
      const observed = { status: 'unreadable', code: 'EACCES' } as const;
      assert.equal(classifyPostPublish({ journal: journal(root, target), observed,
        targetSlotFp: codexFingerprint(target) }), observed);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('phase-aware attribution and §3.1 recovery resolution — C6-15', () => {
  function targetDocument(refresh = 'target-refresh'): CodexAuthDocument {
    return freshenDocument(1_700_000_000_000 + 60 * 60_000, refresh);
  }
  /** A document whose S29 identity is `<user>:account`. */
  function identityDocument(user: string, refresh: string): CodexAuthDocument {
    const doc = targetDocument(refresh);
    return { ...doc, tokens: { ...doc.tokens, id_token: freshenJwt({ 'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_account_id: 'account' } }) } };
  }
  function context(target: CodexAuthDocument, phase: 'post' | 'recovery' | 'watch' = 'post', overrides: Record<string, unknown> = {}) {
    const journal = journalFixture('unused', {
      to: 'target:account',
      target: { identity: { chatgpt_user_id: 'target', account_id: 'account' }, fingerprint: codexFingerprint(target) },
    });
    const slotHeads = new Map<string, string | null>([
      ['from:account', codexFingerprint(identityDocument('from', 'from-head'))],
      ['target:account', codexFingerprint(target)],
    ]);
    return { phase, journal, targetSlotFingerprint: codexFingerprint(target), slotHeads, live: target, ...overrides } as const;
  }

  it('§3.1 not-landed is resolvable in post-publish and recovery', () => {
    const target = targetDocument();
    for (const phase of ['post', 'recovery'] as const) {
      assert.deepEqual(resolveRecoveryVerdict('not-landed', undefined, context(target, phase)), {
        class: 'resolvable', effect: { outcome: 'failed', detail: 'not-published' },
      });
    }
  });

  it('§3.1 ok requires both the live and current slot B fingerprints in post, recovery and watch', () => {
    const target = targetDocument();
    for (const phase of ['post', 'recovery', 'watch'] as const) {
      const verdict = resolveRecoveryVerdict('ok', { action: 'noop', accountId: 'target:account' }, context(target, phase));
      assert.equal(verdict.class, 'resolvable');
      if (verdict.class === 'resolvable') assert.equal(verdict.effect.outcome, phase === 'watch' ? 'quiet' : 'ok');
    }
  });

  it("a classified ok whose slot B moved by QLB's own adopt is not the §3.1 ok row", () => {
    const target = targetDocument();
    const moved = targetDocument('target-rotation');
    const verdict = resolveRecoveryVerdict('ok', { action: 'republish-forbidden', slotId: 'target:account' }, context(target, 'recovery', {
      targetSlotFingerprint: codexFingerprint(moved), live: target,
      journal: journalFixture('unused', {
        to: 'target:account',
        target: { identity: { chatgpt_user_id: 'target', account_id: 'account' }, fingerprint: codexFingerprint(target) },
        adoptingTarget: [codexFingerprint(moved)],
      }),
    }));
    assert.deepEqual(verdict, {
      class: 'unresolved', reason: 'target-ancestor', involvedAccounts: ['from:account', 'target:account'],
    });
  });

  it('target-changed after an import becomes resolvable only as failed(target-changed) once live equals the current slot head', () => {
    const target = targetDocument();
    const imported = targetDocument('imported-target');
    const slotHeads = new Map([['from:account', codexFingerprint(identityDocument('from', 'from-head'))], ['target:account', codexFingerprint(imported)]]);
    const unresolved = resolveRecoveryVerdict('target-changed', { action: 'adopt', accountId: 'target:account' }, context(target, 'recovery', {
      targetSlotFingerprint: codexFingerprint(imported), slotHeads, live: target,
    }));
    assert.equal(unresolved.class, 'unresolved');
    const resolved = resolveRecoveryVerdict('target-changed', { action: 'noop', accountId: 'target:account' }, context(target, 'recovery', {
      targetSlotFingerprint: codexFingerprint(imported), slotHeads, live: imported,
    }));
    assert.deepEqual(resolved, { class: 'resolvable', effect: { outcome: 'failed', detail: 'target-changed' } });
  });

  it('target-changed resolves as failed(target-changed) once live equals the outgoing slot\'s current head', () => {
    const target = targetDocument();
    const imported = targetDocument('imported-target');
    const fromHead = identityDocument('from', 'from-head');
    const verdict = resolveRecoveryVerdict('target-changed', undefined, context(target, 'recovery', {
      targetSlotFingerprint: codexFingerprint(imported),
      slotHeads: new Map([['from:account', codexFingerprint(fromHead)], ['target:account', codexFingerprint(imported)]]),
      live: fromHead,
    }));
    assert.deepEqual(verdict, { class: 'resolvable', effect: { outcome: 'failed', detail: 'target-changed' } });
  });

  it('an unresolved target-changed with live on a third managed slot C involves {from, to, C} without attribution', () => {
    const target = targetDocument();
    const imported = targetDocument('imported-target');
    const thirdLive = identityDocument('third', 'third-older');
    const verdict = resolveRecoveryVerdict('target-changed', undefined, context(target, 'recovery', {
      targetSlotFingerprint: codexFingerprint(imported),
      slotHeads: new Map([
        ['from:account', codexFingerprint(identityDocument('from', 'from-head'))],
        ['target:account', codexFingerprint(imported)],
        ['third:account', codexFingerprint(identityDocument('third', 'third-head'))],
      ]),
      live: thirdLive,
    }));
    assert.deepEqual(verdict, {
      class: 'unresolved', reason: 'target-changed', involvedAccounts: ['from:account', 'target:account', 'third:account'],
    });
  });

  it('a slot-split attribution keeps target-changed unresolved even when live equals the split slot\'s DB fingerprint', () => {
    const target = targetDocument();
    const imported = targetDocument('imported-target');
    const verdict = resolveRecoveryVerdict('target-changed', { action: 'slot-split', accountId: 'target:account' }, context(target, 'recovery', {
      targetSlotFingerprint: codexFingerprint(imported),
      // A split slot has no established head.
      slotHeads: new Map([['from:account', codexFingerprint(identityDocument('from', 'from-head'))], ['target:account', null]]),
      live: imported,
    }));
    assert.deepEqual(verdict, { class: 'unresolved', reason: 'slot-split', involvedAccounts: ['from:account', 'target:account'] });
  });

  it('§3.1 settled-on-target is ok in post/recovery and quiet-adopted in watch', () => {
    const target = targetDocument();
    const rotation = targetDocument('target-rotation');
    const external = { status: 'external', doc: rotation } as const;
    for (const phase of ['post', 'recovery'] as const) {
      assert.deepEqual(resolveRecoveryVerdict(external, { action: 'adopt', accountId: 'target:account' }, context(target, phase, { live: rotation })),
        { class: 'resolvable', effect: { outcome: 'ok', adopted: true } });
    }
    assert.deepEqual(resolveRecoveryVerdict(external, { action: 'adopt', accountId: 'target:account' }, context(target, 'watch', { live: rotation })),
      { class: 'resolvable', effect: { outcome: 'quiet', adopted: true } });
  });

  it('§3.1 settled-on-from-or-third-slot resolves to a revert in every phase', () => {
    const target = targetDocument();
    const third = targetDocument('third-rotation');
    for (const phase of ['post', 'recovery', 'watch'] as const) {
      assert.deepEqual(resolveRecoveryVerdict({ status: 'external', doc: third }, { action: 'drift', accountId: 'third:account', disposition: 'noop' },
        context(target, phase, { live: third })), { class: 'resolvable', effect: { outcome: 'reverted-by-codex', accountId: 'third:account' } });
    }
  });

  it('republish-slot onto the outgoing slot after the rename resolves to reverted-by-codex', () => {
    const target = targetDocument();
    for (const phase of ['post', 'recovery', 'watch'] as const) {
      assert.deepEqual(resolveRecoveryVerdict({ status: 'external', doc: target }, { action: 'republish-forbidden', slotId: 'from:account' }, context(target, phase)),
        { class: 'resolvable', effect: { outcome: 'reverted-by-codex', accountId: 'from:account' } });
    }
  });

  it('republish-slot onto the target is unresolved target-ancestor', () => {
    const target = targetDocument();
    for (const phase of ['post', 'recovery', 'watch'] as const) {
      const verdict = resolveRecoveryVerdict({ status: 'external', doc: target }, { action: 'republish-forbidden', slotId: 'target:account' }, context(target, phase));
      assert.equal(verdict.class, 'unresolved');
      if (verdict.class === 'unresolved') assert.equal(verdict.reason, 'target-ancestor');
    }
  });

  it('slot-split direct or as drift disposition is unresolved', () => {
    const target = targetDocument();
    for (const attribution of [
      { action: 'slot-split', accountId: 'third:account' },
      { action: 'drift', accountId: 'third:account', disposition: 'slot-split' },
    ] as const) {
      for (const phase of ['post', 'recovery', 'watch'] as const) {
        const verdict = resolveRecoveryVerdict({ status: 'external', doc: target }, attribution, context(target, phase));
        assert.equal(verdict.class, 'unresolved');
        if (verdict.class === 'unresolved') assert.equal(verdict.reason, 'slot-split');
      }
    }
  });

  it('an unresolved slot-split onto a third slot C involves {from, to, C}', () => {
    const target = targetDocument();
    assert.deepEqual(resolveRecoveryVerdict({ status: 'external', doc: target }, { action: 'slot-split', accountId: 'third:account' }, context(target)), {
      class: 'unresolved', reason: 'slot-split', involvedAccounts: ['from:account', 'target:account', 'third:account'],
    });
  });

  it('§3.1 unknown identity, stash-unverifiable and wiped have their table effects in every phase', () => {
    const target = targetDocument();
    for (const phase of ['post', 'recovery', 'watch'] as const) {
      assert.equal(resolveRecoveryVerdict({ status: 'external', doc: target }, { action: 'unclaimed' }, context(target, phase)).class, 'resolvable');
      const stash = resolveRecoveryVerdict({ status: 'external', doc: target }, { action: 'stash-unverifiable' }, context(target, phase));
      assert.deepEqual(stash, { class: 'unresolved', reason: 'stash-unverifiable', involvedAccounts: '*' });
      assert.equal(resolveRecoveryVerdict({ status: 'wiped', error: { ok: false, error: 'tokens-empty', status: 'wiped' } }, undefined, context(target, phase)).class, 'resolvable');
    }
  });

  it('§3.1 missing is unresolved after publish/recovery and stopped in watch', () => {
    const target = targetDocument();
    for (const phase of ['post', 'recovery'] as const) {
      assert.deepEqual(resolveRecoveryVerdict({ status: 'missing' }, undefined, context(target, phase, { live: undefined })),
        { class: 'unresolved', reason: 'logged-out', involvedAccounts: '*' });
    }
    assert.deepEqual(resolveRecoveryVerdict({ status: 'missing' }, undefined, context(target, 'watch', { live: undefined })),
      { class: 'resolvable', effect: { outcome: 'stopped', reason: 'logged-out' } });
  });

  it('§3.1 unstable and unreadable are pending in every phase', () => {
    const target = targetDocument();
    for (const phase of ['post', 'recovery', 'watch'] as const) {
      assert.deepEqual(resolveRecoveryVerdict({ status: 'unstable' }, undefined, context(target, phase)), { class: 'pending', status: 'unstable' });
      assert.deepEqual(resolveRecoveryVerdict({ status: 'unreadable', code: 'EIO' }, undefined, context(target, phase)), { class: 'pending', status: 'unreadable' });
    }
  });

  it('an unresolved verdict with no establishable identity involves every account', () => {
    const target = targetDocument();
    const malformed = { tokens: {} } as CodexAuthDocument;
    assert.deepEqual(resolveRecoveryVerdict({ status: 'external', doc: malformed }, { action: 'slot-split', accountId: 'third:account' },
      context(target, 'recovery', { live: malformed })), { class: 'unresolved', reason: 'slot-split', involvedAccounts: '*' });
  });

  it('a forbidden republish writes nothing to auth.json, Keychain or SQLite', async () => {
    const h = fixture();
    const keychain = new MockKeychain();
    const oldLive = targetDocument('live-a0');
    const newerSlot = targetDocument('slot-a1');
    const authPath = join(h.root, 'auth.json');
    try {
      const plan = importActiveCodexSlot(oldLive, { store: h.store, keychain, now: () => 1 });
      importActiveCodexSlot(newerSlot, { store: h.store, keychain, now: () => 2 });
      writeFileSync(authPath, JSON.stringify(oldLive));
      const service = qlbKeychainService('openai-codex', plan.slotId);
      const keychainBefore = codexFingerprint(JSON.parse(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT)) as CodexAuthDocument);
      const slotBefore = h.store.getCodexSlot(plan.slotId)?.fingerprint;
      const rowsBefore = h.db.prepare('SELECT COUNT(*) AS count FROM lineage_log').get() as { count: number };
      const result = await attributeForPhase({ assertHeld: () => undefined }, 'post', {
        store: h.store, keychain, slot: { accountId: plan.slotId, document: newerSlot }, live: oldLive,
        republish: () => writeFileSync(authPath, JSON.stringify(newerSlot)),
      });
      assert.deepEqual(result, { action: 'republish-forbidden', slotId: plan.slotId });
      assert.equal(codexFingerprint(JSON.parse(readFileSync(authPath, 'utf8')) as CodexAuthDocument), codexFingerprint(oldLive));
      assert.equal(codexFingerprint(JSON.parse(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT)) as CodexAuthDocument), keychainBefore);
      assert.equal(h.store.getCodexSlot(plan.slotId)?.fingerprint, slotBefore);
      assert.deepEqual(h.db.prepare('SELECT COUNT(*) AS count FROM lineage_log').get(), rowsBefore);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a forbidden republish whose stored document lacks identity claims is attributed to the selected slot, not to from', async () => {
    const h = fixture();
    const keychain = new MockKeychain();
    const oldLive = targetDocument('live-b0');
    const newerSlot = targetDocument('slot-b1');
    try {
      const plan = importActiveCodexSlot(oldLive, { store: h.store, keychain, now: () => 1 });
      importActiveCodexSlot(newerSlot, { store: h.store, keychain, now: () => 2 });
      // Same lineage bytes (fingerprint), but no identity claims to re-derive the slot from.
      const claimless = { ...newerSlot, tokens: { ...newerSlot.tokens, id_token: freshenJwt({}) } };
      const result = await attributeForPhase({ assertHeld: () => undefined }, 'recovery', {
        store: h.store, keychain, slot: { accountId: plan.slotId, document: claimless }, live: oldLive,
      });
      assert.deepEqual(result, { action: 'republish-forbidden', slotId: plan.slotId });
      assert.deepEqual(resolveRecoveryVerdict({ status: 'external', doc: oldLive }, result, context(newerSlot, 'recovery', { live: oldLive })), {
        class: 'unresolved', reason: 'target-ancestor', involvedAccounts: ['from:account', 'target:account'],
      });
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a forbidden republish with no establishable slot is unresolved and involves every account', () => {
    const target = targetDocument();
    for (const phase of ['post', 'recovery', 'watch'] as const) {
      assert.deepEqual(resolveRecoveryVerdict({ status: 'external', doc: target }, { action: 'republish-forbidden', slotId: null }, context(target, phase)),
        { class: 'unresolved', reason: 'target-ancestor', involvedAccounts: '*' });
    }
  });

  it('an external slot-split onto C without an explicit live document involves {from, to, C}', () => {
    const target = targetDocument();
    const third = identityDocument('third', 'third-live');
    assert.deepEqual(resolveRecoveryVerdict({ status: 'external', doc: third }, { action: 'slot-split', accountId: 'third:account' },
      context(target, 'recovery', { live: undefined })), {
      class: 'unresolved', reason: 'slot-split', involvedAccounts: ['from:account', 'target:account', 'third:account'],
    });
  });

  it('watch on an unclaimed identity stops with activeAccountId null', () => {
    const target = targetDocument();
    assert.deepEqual(resolveRecoveryVerdict({ status: 'external', doc: target }, { action: 'unclaimed' }, context(target, 'watch')), {
      class: 'resolvable', effect: { outcome: 'stopped', reason: 'unknown-live-identity', activeAccountId: null },
    });
  });

  it('attribution receives assertHeld in every phase', async () => {
    const h = fixture();
    const keychain = new MockKeychain();
    const document = targetDocument();
    try {
      const plan = importActiveCodexSlot(document, { store: h.store, keychain, now: () => 1 });
      for (const phase of ['pre', 'post', 'recovery', 'watch'] as const) {
        let assertions = 0;
        const result = await attributeForPhase({ assertHeld: () => { assertions += 1; } }, phase, {
          store: h.store, keychain, slot: { accountId: plan.slotId, document }, live: document,
        });
        assert.equal(result.action, 'noop');
        assert.ok(assertions > 0, `${phase} forwards assertHeld into attribution`);
      }
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });
});

describe('Codex locked observe step — C6-16', () => {
  it('truncated auth.json five times refuses codex-writing and leaves the file hash unchanged', async () => {
    const h = observeHarness();
    try {
      writeFileSync(h.authPath, '{"tokens":');
      const before = readFileSync(h.authPath, 'utf8');
      let reads = 0;
      const result = await h.run({ readLive: () => readCodexAuthStableWithStat(h.authPath, {
        attempts: 5, delayMs: 0,
        openRead: () => {
          reads += 1;
          return { text: readFileSync(h.authPath, 'utf8'), ino: statSync(h.authPath).ino };
        },
      }) });
      assert.deepEqual(result, { outcome: 'refused', reason: 'codex-writing' });
      assert.equal(reads, 10);
      assert.equal(readFileSync(h.authPath, 'utf8'), before);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('same identity and lineage settles noop and appends no observation', async () => {
    const h = observeHarness();
    try {
      h.store.recordCodexObservation({ identity: h.plan.slotId, lineageFp: codexFingerprint(h.a0), by: 'qlb-switch', now: 0 });
      const result = await h.run();
      assert.equal(result.outcome, 'settled');
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations'), 1);
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM lineage_log WHERE cause = 'adopt'"), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('first observation with an empty graph adopts a1 with one adopt lineage row (B3)', async () => {
    const h = observeHarness();
    const a1 = observedDocument('a', 'a1');
    try {
      writeFileSync(h.authPath, JSON.stringify(a1));
      const result = await h.run();
      assert.equal(result.outcome, 'settled');
      assert.equal(h.store.getCodexSlot(h.plan.slotId)?.fingerprint, codexFingerprint(a1));
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM lineage_log WHERE cause = 'adopt' AND by = 'tool'"), 1);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('slot newer than live republishes the slot and restarts', async () => {
    const h = observeHarness();
    const a1 = observedDocument('a', 'a1');
    try {
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => 2 });
      await assert.rejects(h.run(), CodexLiveChanged);
      assert.equal(codexFingerprint(JSON.parse(readFileSync(h.authPath, 'utf8')) as CodexAuthDocument), codexFingerprint(a1));
      assert.equal((await h.run()).outcome, 'settled');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a Codex write before the step-2 republish is not overwritten', async () => {
    const h = observeHarness();
    const a1 = observedDocument('a', 'a1');
    const codexWrite = observedDocument('a', 'codex-write');
    try {
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => 2 });
      let calls = 0;
      await assert.rejects(h.run({ readLive: async () => {
        calls += 1;
        if (calls === 2) writeFileSync(h.authPath, JSON.stringify(codexWrite));
        return readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      } }), CodexLiveChanged);
      assert.equal(codexFingerprint(JSON.parse(readFileSync(h.authPath, 'utf8')) as CodexAuthDocument), codexFingerprint(codexWrite));
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a republish whose rename throws refuses republish-failed and leaves active unchanged', async () => {
    const h = observeHarness();
    const a1 = observedDocument('a', 'a1');
    const mutableFs = require('node:fs') as { renameSync: typeof renameSync };
    const originalRename = mutableFs.renameSync;
    try {
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => 2 });
      const activeBefore = h.store.getCodexActiveLogin();
      mutableFs.renameSync = () => { throw new Error('fixture rename failure'); };
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'republish-failed' });
      assert.equal(h.store.getCodexActiveLogin(), activeBefore);
    } finally {
      mutableFs.renameSync = originalRename;
      h.store.close(); rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('a crash after the step-2 republish leaves the file on the slot and the rerun records noop attribution', async () => {
    const h = observeHarness();
    const a1 = observedDocument('a', 'a1');
    const originalMark = h.store.markCodexSlotImportedActive.bind(h.store);
    try {
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => 2 });
      let crash = true;
      h.store.markCodexSlotImportedActive = ((...args: Parameters<typeof h.store.markCodexSlotImportedActive>) => {
        if (crash) { crash = false; throw new Error('fixture crash'); }
        return originalMark(...args);
      }) as typeof h.store.markCodexSlotImportedActive;
      await assert.rejects(h.run(), /fixture crash/);
      assert.equal(codexFingerprint(JSON.parse(readFileSync(h.authPath, 'utf8')) as CodexAuthDocument), codexFingerprint(a1));
      assert.equal((await h.run()).outcome, 'settled');
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM lineage_log WHERE cause = 'adopt'"), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('another known slot settles as outgoing with set_by adopt', async () => {
    const h = observeHarness();
    const b0 = observedDocument('b', 'b0');
    try {
      const b = importActiveCodexSlot(b0, { store: h.store, keychain: h.keychain, now: () => 2 });
      h.store.setActiveLogin('openai-codex', h.plan.slotId, 'import');
      writeFileSync(h.authPath, JSON.stringify(b0));
      assert.equal((await h.run()).outcome, 'settled');
      assert.equal(h.store.getCodexActiveLogin(), b.slotId);
      assert.equal((h.db.prepare("SELECT set_by FROM active_login WHERE provider = 'openai-codex'").get() as { set_by: string }).set_by, 'adopt');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('an unknown identity is stashed once, clears active_login and refuses unknown-live-identity', async () => {
    const h = observeHarness();
    const unknown = observedDocument('unknown', 'unknown-0');
    try {
      writeFileSync(h.authPath, JSON.stringify(unknown));
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'unknown-live-identity' });
      assert.equal(h.stashes(), 1);
      assert.equal(h.store.getCodexActiveLogin(), null);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a stash that is unverifiable leaves active_login unchanged', async () => {
    const h = observeHarness();
    try {
      writeFileSync(h.authPath, JSON.stringify(observedDocument('unknown', 'unknown-0')));
      const active = h.store.getCodexActiveLogin();
      h.stashError(new CodexStashUnverifiable());
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'stash-unverifiable' });
      assert.equal(h.store.getCodexActiveLogin(), active);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a wiped file writes one wiped event per transition', async () => {
    const h = observeHarness();
    const wiped = { status: 'wiped', error: { ok: false, error: 'tokens-empty', status: 'wiped' } } as const;
    try {
      assert.deepEqual(await h.run({ readLive: async () => wiped }), { outcome: 'refused', reason: 'wiped' });
      assert.deepEqual(await h.run({ readLive: async () => wiped }), { outcome: 'refused', reason: 'wiped' });
      await h.run();
      assert.deepEqual(await h.run({ readLive: async () => wiped }), { outcome: 'refused', reason: 'wiped' });
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM relogin_events WHERE kind = 'wiped'"), 2);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a lost auth lock aborts before any write', async () => {
    const h = observeHarness();
    const a1 = observedDocument('a', 'a1');
    try {
      writeFileSync(h.authPath, JSON.stringify(a1));
      const before = scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations');
      await assert.rejects(h.run({}, () => { throw new Error('auth lock lost'); }), /auth lock lost/);
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations'), before);
      assert.equal(h.store.getCodexSlot(h.plan.slotId)?.fingerprint, codexFingerprint(h.a0));

      const republish = observeHarness();
      try {
        importActiveCodexSlot(a1, { store: republish.store, keychain: republish.keychain, now: () => 2 });
        let assertions = 0;
        await assert.rejects(republish.run({}, () => {
          assertions += 1;
          if (assertions === 3) throw new Error('auth lock lost');
        }), /auth lock lost/);
        assert.equal(codexFingerprint(JSON.parse(readFileSync(republish.authPath, 'utf8')) as CodexAuthDocument), codexFingerprint(republish.a0));
      } finally { republish.store.close(); rmSync(republish.root, { recursive: true, force: true }); }
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a crash inside the step-2 adopt is repaired by the next switch with exactly one adopt lineage row', async () => {
    const h = observeHarness();
    const a1 = observedDocument('a', 'a1');
    try {
      writeFileSync(h.authPath, JSON.stringify(a1));
      await assert.rejects(h.run({ observationBeforeSaveCommit: () => { throw new Error('fixture crash'); } }), /fixture crash/);
      assert.equal((await h.run()).outcome, 'settled');
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM lineage_log WHERE cause = 'adopt' AND by = 'tool'"), 1);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a DB/Keychain split on the active slot refuses slot-split', async () => {
    const h = observeHarness();
    const a1 = observedDocument('a', 'a1');
    const a2 = observedDocument('a', 'a2');
    const service = qlbKeychainService('openai-codex', h.plan.slotId);
    try {
      // A hard kill after the Keychain write and before the SQLite commit: the
      // DB row still names a0, the Keychain holds a1, and no :prev records a0.
      h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(a1));
      writeFileSync(h.authPath, JSON.stringify(a2));
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'slot-split' });
      assert.equal(h.store.getCodexSlot(h.plan.slotId)?.fingerprint, codexFingerprint(h.a0));
      assert.equal(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), JSON.stringify(a1));
      assert.equal(codexFingerprint(JSON.parse(readFileSync(h.authPath, 'utf8')) as CodexAuthDocument), codexFingerprint(a2));
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a drift republish of another known slot restarts instead of settling on the replaced bytes', async () => {
    const h = observeHarness();
    const b0 = observedDocument('b', 'b0');
    const b1 = observedDocument('b', 'b1');
    try {
      importActiveCodexSlot(b0, { store: h.store, keychain: h.keychain, now: () => 2 });
      importActiveCodexSlot(b1, { store: h.store, keychain: h.keychain, now: () => 3 });
      h.store.setActiveLogin('openai-codex', h.plan.slotId, 'import');
      writeFileSync(h.authPath, JSON.stringify(b0));
      await assert.rejects(h.run(), CodexLiveChanged);
      assert.equal(codexFingerprint(JSON.parse(readFileSync(h.authPath, 'utf8')) as CodexAuthDocument), codexFingerprint(b1));
      const rerun = await h.run();
      assert.equal(rerun.outcome, 'settled');
      assert.equal(rerun.outcome === 'settled' && codexFingerprint(rerun.outgoing.document), codexFingerprint(b1));
      assert.equal(rerun.outcome === 'settled' && rerun.outgoing.inode, statSync(h.authPath).ino);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a repeated observe of the same unknown login with active_login NULL refuses unknown-live-identity and stashes once', async () => {
    const h = observeHarness();
    try {
      writeFileSync(h.authPath, JSON.stringify(observedDocument('unknown', 'unknown-0')));
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'unknown-live-identity' });
      assert.equal(h.store.getCodexActiveLogin(), null);
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'unknown-live-identity' });
      assert.equal(h.stashes(), 1);
      assert.equal(h.store.getCodexActiveLogin(), null);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('an unparseable live identity with active_login NULL refuses unknown-live-identity', async () => {
    const h = observeHarness();
    const anonymous = { ...h.a0, tokens: { ...h.a0.tokens, id_token: freshenJwt({}), account_id: '' } };
    try {
      h.store.setActiveLogin('openai-codex', null, 'adopt');
      writeFileSync(h.authPath, JSON.stringify(anonymous));
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'unknown-live-identity' });
      assert.equal(h.stashes(), 1);
      assert.equal(h.store.getCodexActiveLogin(), null);
      assert.equal(h.store.getCodexSlot(h.plan.slotId)?.fingerprint, codexFingerprint(h.a0));
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a lock lost during the step-2 re-read aborts before the republish', async () => {
    const h = observeHarness();
    const a1 = observedDocument('a', 'a1');
    try {
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => 2 });
      let reads = 0;
      let lost = false;
      await assert.rejects(h.run({ readLive: async () => {
        reads += 1;
        // The lock is taken over while the stable re-read is waiting.
        if (reads === 2) lost = true;
        return readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      } }, () => { if (lost) throw new Error('auth lock lost'); }), /auth lock lost/);
      assert.equal(reads, 2);
      assert.equal(codexFingerprint(JSON.parse(readFileSync(h.authPath, 'utf8')) as CodexAuthDocument), codexFingerprint(h.a0));
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a lost lock before the unknown-login stash writes no stash', async () => {
    const h = observeHarness();
    try {
      writeFileSync(h.authPath, JSON.stringify(observedDocument('unknown', 'unknown-0')));
      const active = h.store.getCodexActiveLogin();
      let assertions = 0;
      // The first assertion guards the observation row; the next is the stash's.
      await assert.rejects(h.run({}, () => {
        assertions += 1;
        if (assertions === 2) throw new Error('auth lock lost');
      }), /auth lock lost/);
      assert.equal(h.stashes(), 0);
      assert.equal(h.store.getCodexActiveLogin(), active);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('keeps switch and auth locks held through the observe callback', async () => {
    const h = observeHarness();
    try {
      const result = await withCodexSwitchLocks({ dbPath: h.store.dbPath, authLockOptions: { home: h.root } }, (assertHeld) => h.run({}, assertHeld));
      assert.equal(result.outcome, 'settled');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });
});

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

describe('switchCodex landed and not-landed — C6-18', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const journalState = (root: string) => readCodexSwitchJournal({ journalDir: join(root, 'journal') });
  const ownerState = (root: string) => { const read = journalState(root); return read.state === 'ok' ? read.journal.owner.state : read.state; };
  const liveIdentity = (path: string) => codexIdentity(JSON.parse(readFileSync(path, 'utf8')) as CodexAuthDocument);
  /**
   * Pauses the switch's first `list()`: with B fresh, the freshen lists nothing, so this is step 1 under switch → auth,
   * before any phase-L write. Records which locks were held at the pause.
   */
  const pauseUnderLocks = (root: string, dbPath: string) => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const state = { paused: false, locksHeld: false, release: () => release() };
    const list = async (): Promise<CodexProcess[]> => {
      if (!state.paused) {
        state.paused = true;
        state.locksHeld = existsSync(codexLockPaths(dbPath, '').switch) && existsSync(codexAuthLockDir({ home: root }));
        await gate;
      }
      return [];
    };
    const untilPaused = async () => {
      const deadline = Date.now() + 5_000;
      while (!state.paused) {
        assert.ok(Date.now() < deadline, 'the switch reached step 1');
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    return { state, list, untilPaused };
  };

  it('stable live A publishes B, verifies it and commits ok with published_at = journaled time < committed_at', async () => {
    const h = switchHarness();
    try {
      let journaledAt: number | undefined;
      const result = await h.runWith({ hooks: { afterRename: () => {
        const read = journalState(h.root); if (read.state === 'ok') journaledAt = read.journal.publishedAt;
      } } });
      assert.equal(result.outcome, 'ok');
      const row = h.db.prepare(`SELECT outcome, published_at, committed_at FROM switch_log WHERE provider = 'openai-codex' ORDER BY id DESC`).get() as { outcome: string; published_at: number; committed_at: number };
      assert.equal(row.outcome, 'ok');
      assert.equal(typeof journaledAt, 'number');
      assert.equal(row.published_at, journaledAt);
      assert.ok(row.published_at < row.committed_at);
      assert.equal(liveIdentity(h.authPath), 'b:account');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('the journal is on disk at the moment of the rename (publish spy)', async () => {
    const h = switchHarness(); const mutableFs = require('node:fs') as { renameSync: typeof renameSync }; const original = mutableFs.renameSync;
    try {
      const atRename: Array<{ state: string; attemptId?: string }> = [];
      mutableFs.renameSync = ((from: Parameters<typeof original>[0], to: Parameters<typeof original>[1]) => {
        if (String(to) === h.authPath) {
          const read = journalState(h.root);
          atRename.push(read.state === 'ok' ? { state: read.state, attemptId: read.journal.attemptId } : { state: read.state });
        }
        return original(from, to);
      }) as typeof original;
      const result = await h.run();
      assert.equal(result.outcome, 'ok');
      assert.deepEqual(atRename, [{ state: 'ok', attemptId: 'switch-attempt' }]);
    } finally { mutableFs.renameSync = original; h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('no code path writes the staged outgoing bytes after the rename (publish spy sees exactly one write)', async () => {
    const h = switchHarness(); const mutableFs = require('node:fs') as { renameSync: typeof renameSync }; const original = mutableFs.renameSync;
    try {
      const atRename: Array<{ state: string; attemptId?: string }> = [];
      const aPrime = observedDocument('a', 'switch-a-prime');
      mutableFs.renameSync = ((from: Parameters<typeof original>[0], to: Parameters<typeof original>[1]) => {
        if (String(to) === h.authPath) {
          const read = journalState(h.root);
          atRename.push(read.state === 'ok' ? { state: read.state, attemptId: read.journal.attemptId } : { state: read.state });
        }
        return original(from, to);
      }) as typeof original;
      const result = await h.runWith({ hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(aPrime)); } } });
      assert.equal(result.outcome, 'reverted-by-codex');
      assert.deepEqual(atRename, [{ state: 'ok', attemptId: 'switch-attempt' }]);
      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')), aPrime);
    } finally { mutableFs.renameSync = original; h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a missing or unreadable auth.json at the start of a full switch leaves the database, Keychain, journal and watch rows byte-identical and sends zero transport calls, even with a due watch row and a failing precondition', async () => {
    const dumpDb = (db: DatabaseSync) => JSON.stringify((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
    const dumpKeychain = (keychain: MockKeychain) => JSON.stringify([...(keychain as unknown as { items: Map<string, string> }).items].sort());
    for (const live of [{ status: 'missing' }, { status: 'unreadable', code: 'EACCES' }] as const) {
      const h = switchHarness();
      try {
        h.db.prepare('INSERT INTO codex_watch (switch_id, provider, outgoing, target, next_at, until) VALUES (?, ?, ?, ?, ?, ?)')
          .run(77, 'openai-codex', 'a:account', 'b:account', 1_700_000_000_000 - 60_000, 1_700_000_000_000 + 240_000);
        const journalPath = join(h.root, 'journal', 'switch-openai-codex.json');
        const before = { db: dumpDb(h.db), keychain: dumpKeychain(h.keychain), journal: existsSync(journalPath), auth: readFileSync(h.authPath, 'utf8') };
        assert.match(before.db, /"codex_watch",\[\{"switch_id":77/);
        let posts = 0;
        const result = await h.runWith({ readLive: async () => live, cswapProcesses: () => [{ pid: 1 }], transport: async () => { posts += 1; throw new Error('unexpected'); } });
        assert.equal(result.outcome, 'refused');
        assert.equal(dumpDb(h.db), before.db);
        assert.equal(dumpKeychain(h.keychain), before.keychain);
        assert.equal(existsSync(journalPath), before.journal);
        assert.equal(readFileSync(h.authPath, 'utf8'), before.auth);
        assert.equal(posts, 0);
      } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
    }
  });

  it('open_sessions_json lists each codex pid with its holder set', async () => {
    const h = switchHarness();
    try {
      // An earlier C→A switch: sessions started before it hold C, sessions started after it hold A.
      const earlier = 1_699_990_000_000; // Tue Nov 14 19:26:40 2023 UTC
      h.store.recordSwitch({ ts: earlier, provider: 'openai-codex', fromAccount: 'c:account', toAccount: 'a:account', trigger: 'manual',
        outcome: 'ok', stepsJson: JSON.stringify({ attempt: 'earlier', via: 'switch' }), publishedAt: earlier, committedAt: earlier });
      const beforeEarlier = { pid: 9901, lstart: 'Tue Nov 14 18:00:00 2023', host: 'codex' };
      const afterEarlier = { pid: 9902, lstart: 'Tue Nov 14 21:00:00 2023', host: 'codex' };
      assert.equal((await h.runWith({ list: async () => [beforeEarlier, afterEarlier] })).outcome, 'ok');
      const sessions = JSON.parse((h.db.prepare('SELECT open_sessions_json FROM switch_log ORDER BY id DESC').get() as { open_sessions_json: string }).open_sessions_json) as Array<CodexProcess & { holderSet: string[] }>;
      assert.deepEqual(sessions, [{ ...beforeEarlier, holderSet: ['c:account'] }, { ...afterEarlier, holderSet: ['a:account'] }]);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a Codex write between the first read and the pre-rename read restarts at step 2 and never loses the new bytes', async () => {
    const h = switchHarness();
    const a1 = observedDocument('a', 'switch-a1');
    try {
      let reads = 0; let freshens = 0;
      const result = await h.runWith({ hooks: { beforeFreshenLock: () => { freshens += 1; } }, readLive: async () => {
        reads += 1;
        if (reads === 3) writeFileSync(h.authPath, JSON.stringify(a1));
        return readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      } });
      assert.equal(result.outcome, 'ok');
      // Preflight, step 1, the changed CAS read, step 1 again, the CAS read, the verify,
      // then the C6-22 foreground checks: the restart stays under the held locks.
      assert.equal(reads, 9);
      assert.equal(freshens, 1, 'a CAS restart does not release the locks or re-run the freshen');
      assert.equal(liveIdentity(h.authPath), 'b:account');
      assert.equal(h.store.getCodexSlot('a:account')?.fingerprint, codexFingerprint(a1));
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('six consecutive changes refuse codex-writing with no publish', async () => {
    const h = switchHarness();
    try {
      // Slot A moves on to a2, so the live `a` is a known ancestor: each step-1 read of it republishes a2 and restarts.
      importActiveCodexSlot(observedDocument('a', 'switch-a2'), { store: h.store, keychain: h.keychain, now: () => 1_700_000_000_000 - 2 });
      let reads = 0; let freshens = 0;
      const result = await h.runWith({ hooks: { beforeFreshenLock: () => { freshens += 1; } }, readLive: async () => {
        reads += 1;
        // Reads 2-7: three republish restarts (step-1 read of `a`, then the republish re-read).
        if (reads === 4 || reads === 6) writeFileSync(h.authPath, JSON.stringify(h.a));
        // Reads 8-13: three CAS restarts (step-1 read, then a changed pre-rename read).
        if (reads === 9 || reads === 11 || reads === 13) writeFileSync(h.authPath, JSON.stringify(observedDocument('a', `race-${reads}`)));
        return readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      } });
      assert.deepEqual(result, { outcome: 'refused', reason: 'codex-writing' });
      assert.equal(reads, 13, 'one budget: the initial observation plus five restarts, whichever kind of change');
      assert.equal(freshens, 1);
      assert.equal(existsSync(join(h.root, 'journal', 'switch-openai-codex.json')), false);
      assert.notEqual(liveIdentity(h.authPath), 'b:account');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a rename that throws is failed not-published with the file unchanged and no codex_watch row', async () => {
    const h = switchHarness(); const mutableFs = require('node:fs') as { renameSync: typeof renameSync }; const original = mutableFs.renameSync;
    try {
      const before = readFileSync(h.authPath, 'utf8');
      mutableFs.renameSync = ((from: Parameters<typeof original>[0], to: Parameters<typeof original>[1]) => {
        if (String(to) === h.authPath) throw new Error('fixture rename');
        return original(from, to);
      }) as typeof original;
      const result = await h.run();
      assert.equal(result.outcome, 'failed');
      assert.equal(readFileSync(h.authPath, 'utf8'), before);
      // I11: the canonical Q1 marker, so holder sets open no era for B.
      const row = h.db.prepare('SELECT outcome, detail, published_at FROM switch_log ORDER BY id DESC').get() as Record<string, unknown>;
      assert.deepEqual({ ...row }, { outcome: 'failed', detail: 'not-published', published_at: null });
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_watch'), 0);
      assert.equal(journalState(h.root).state, 'absent');
    } finally { mutableFs.renameSync = original; h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a commit failure after the rename keeps the journal and exits 1 with the file holding B', async () => {
    const h = switchHarness();
    try {
      h.db.exec("CREATE TEMP TRIGGER fail_switch BEFORE INSERT ON switch_log BEGIN SELECT RAISE(ABORT, 'commit failure'); END");
      assert.deepEqual(await h.run(), { outcome: 'failed', reason: 'commit-failed', attemptId: 'switch-attempt' });
      assert.equal(liveIdentity(h.authPath), 'b:account');
      assert.equal(ownerState(h.root), 'released');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a journal delete that fails after the commit returns the committed outcome, never commit-failed', async () => {
    const h = switchHarness();
    try {
      const journalPath = codexSwitchJournalPath({ journalDir: join(h.root, 'journal') });
      const result = await h.runWith({ journalOptions: { fsyncDirectory: () => {
        if (!existsSync(journalPath)) throw Object.assign(new Error('fixture EIO'), { code: 'EIO' });
      } } });
      assert.equal(result.outcome, 'ok'); assert.equal(result.reason, undefined); assert.equal(result.watch?.state, 'pending');
      assert.equal(scalarCount(h.db, `SELECT COUNT(*) AS count FROM switch_log WHERE outcome = 'ok'`), 1);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('A′ written between the rename and the verify read ⇒ reverted-by-codex, slot A holds A′, active_login A (adopt), file holds A′, dead 0, no relogin row, slot B unchanged', async () => {
    const h = switchHarness();
    try {
      const aPrime = observedDocument('a', 'switch-a-prime');
      const holder = { pid: 4411, lstart: 'Tue Oct 28 10:00:00 2026', host: 'codex' };
      const beforeB = h.slots.readSlot('b:account').document;
      const result = await h.runWith({ list: async () => [holder], hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(aPrime)); } } });
      assert.equal(result.outcome, 'reverted-by-codex');
      assert.deepEqual(h.slots.readSlot('a:account').document, aPrime);
      assert.deepEqual(h.slots.readSlot('b:account').document, beforeB);
      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')), aPrime);
      assert.equal(h.store.getCodexActiveLogin(), 'a:account');
      assert.equal(scalarCount(h.db, `SELECT COUNT(*) AS count FROM codex_slots WHERE account_id = 'a:account' AND dead = 1`), 0);
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM relogin_events'), 0);
      assert.equal((h.db.prepare('SELECT outcome FROM switch_log ORDER BY id DESC').get() as { outcome: string }).outcome, 'reverted-by-codex');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a rotated B written there ⇒ ok and slot B holds the rotation', async () => {
    const h = switchHarness();
    try {
      const bPrime = observedDocument('b', 'switch-b-prime');
      const result = await h.runWith({ hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(bPrime)); } } });
      assert.equal(result.outcome, 'ok');
      assert.deepEqual(h.slots.readSlot('b:account').document, bPrime);
      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')), bPrime);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a third known identity there ⇒ reverted-by-codex with active_login on that slot', async () => {
    const h = switchHarness();
    try {
      const c = observedDocument('c', 'switch-c');
      importActiveCodexSlot(c, { store: h.store, keychain: h.keychain, now: () => 1 });
      const result = await h.runWith({ hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(c)); } } });
      assert.equal(result.outcome, 'reverted-by-codex');
      assert.equal(h.store.getCodexActiveLogin(), 'c:account');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a known ancestor of the outgoing slot after the rename records reverted-by-codex without writing auth.json', async () => {
    const h = switchHarness(); const mutableFs = require('node:fs') as { renameSync: typeof renameSync }; const original = mutableFs.renameSync;
    try {
      const aPrime = observedDocument('a', 'switch-a-prime');
      importActiveCodexSlot(aPrime, { store: h.store, keychain: h.keychain, now: () => 1 });
      let writes = 0;
      mutableFs.renameSync = ((from: Parameters<typeof original>[0], to: Parameters<typeof original>[1]) => {
        if (String(to) === h.authPath) writes += 1;
        return original(from, to);
      }) as typeof original;
      const result = await h.runWith({ hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(h.a)); } } });
      assert.equal(result.outcome, 'reverted-by-codex');
      assert.equal(writes, 2, 'the step-2 republish and target publish are the only writes');
      assert.deepEqual(JSON.parse(readFileSync(h.authPath, 'utf8')), h.a);
    } finally { mutableFs.renameSync = original; h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a known ancestor of the target after the rename keeps the journal', async () => {
    const h = switchHarness();
    try {
      const bPrime = observedDocument('b', 'switch-b-prime');
      importActiveCodexSlot(bPrime, { store: h.store, keychain: h.keychain, now: () => 1 });
      const result = await h.runWith({ hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(h.b)); } } });
      assert.equal(result.outcome, 'failed'); assert.equal(result.reason, 'target-ancestor');
      assert.equal(ownerState(h.root), 'released');
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM switch_log'), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a split third slot C after the rename keeps the journal with involved {A, B, C}, and codex refresh of C is refused while it stands', async () => {
    const h = switchHarness();
    try {
      const c = observedDocument('c', 'switch-c'); const cSplit = observedDocument('c', 'switch-c-split'); const cExternal = observedDocument('c', 'switch-c-external');
      importActiveCodexSlot(c, { store: h.store, keychain: h.keychain, now: () => 1 });
      h.keychain.setSync(qlbKeychainService('openai-codex', 'c:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(cSplit));
      const result = await h.runWith({ hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(cExternal)); } } });
      assert.equal(result.outcome, 'failed'); assert.equal(result.reason, 'slot-split');
      const state = codexRecoveryFenceState(join(h.root, 'journal'), h.store);
      assert.equal(state.state, 'fenced');
      if (state.state !== 'fenced') return;
      assert.deepEqual([...state.accounts as Set<string>].sort(), ['a:account', 'b:account', 'c:account']);
      let posts = 0;
      const refresh = await consumeCodexSlot({ accountId: 'c:account', snapshot: h.slots.readSlot('c:account').document,
        trigger: 'force', force: true, slots: h.slots as never, holders: async () => [], inFlightSlots: state.accounts,
        transport: async () => { posts += 1; return { status: 200, body: '{}' }; } });
      assert.equal(refresh.status, 'switch-in-flight'); assert.equal(posts, 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('an unknown identity there ⇒ failed unknown-live-identity, active_login NULL, one stash', async () => {
    const h = switchHarness();
    try {
      const unknown = observedDocument('unknown', 'switch-unknown'); let stashes = 0;
      h.slots.ensureUnclaimedStash = async () => { stashes += 1; return { stashId: 'unknown', created: true }; };
      const result = await h.runWith({ hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(unknown)); } } });
      assert.equal(result.outcome, 'failed');
      assert.equal((h.db.prepare('SELECT detail FROM switch_log ORDER BY id DESC').get() as { detail: string }).detail, 'unknown-live-identity');
      assert.equal(h.store.getCodexActiveLogin(), null); assert.equal(stashes, 1);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('an unstable, missing or unreadable verify keeps the journal, commits no row and exits 1', async () => {
    for (const status of ['unstable', 'missing', 'unreadable'] as const) {
      const h = switchHarness(); let verify = false;
      try {
        const result = await h.runWith({ hooks: { afterRename: () => { verify = true; } }, readLive: async () => verify
          ? status === 'unreadable' ? { status, code: 'EIO' } : { status }
          : readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }) });
        assert.deepEqual(result, { outcome: 'failed', reason: `verify-${status}`, attemptId: 'switch-attempt' });
        assert.equal(ownerState(h.root), 'released'); assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM switch_log'), 0);
      } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
    }
  });

  const newestObservation = (db: DatabaseSync) => ({ ...db.prepare(`SELECT identity, lineage_fp FROM codex_live_observations
    ORDER BY ts DESC, id DESC LIMIT 1`).get() as Record<string, unknown> });

  it('a thrown rename with an unstable, missing or unreadable verify still records failed not-published and deletes the journal', async () => {
    // `foreign` is a stable verify read of another identity: the not-landed observation stays A with the outgoing fingerprint.
    for (const status of ['unstable', 'missing', 'unreadable', 'foreign'] as const) {
      const h = switchHarness(); const mutableFs = require('node:fs') as { renameSync: typeof renameSync }; const original = mutableFs.renameSync;
      let verify = false;
      try {
        const before = readFileSync(h.authPath, 'utf8');
        const foreign = observedDocument('c', 'switch-c-foreign');
        mutableFs.renameSync = ((from: Parameters<typeof original>[0], to: Parameters<typeof original>[1]) => {
          if (String(to) === h.authPath) throw new Error('fixture rename');
          return original(from, to);
        }) as typeof original;
        const result = await h.runWith({ hooks: { beforeVerify: () => { verify = true; } }, readLive: async () => !verify
          ? readCodexAuthStableWithStat(h.authPath, { delayMs: 0 })
          : status === 'foreign' ? { status: 'ok', doc: foreign, sha256: 'sha256-file:foreign', inode: 99 }
            : status === 'unreadable' ? { status, code: 'EIO' } : { status } });
        assert.equal(result.outcome, 'failed', status); assert.equal(result.reason, undefined, status);
        assert.equal(readFileSync(h.authPath, 'utf8'), before);
        const row = h.db.prepare('SELECT outcome, detail, published_at FROM switch_log ORDER BY id DESC').get() as Record<string, unknown>;
        assert.deepEqual({ ...row }, { outcome: 'failed', detail: 'not-published', published_at: null }, status);
        assert.equal(journalState(h.root).state, 'absent', status);
        assert.deepEqual(newestObservation(h.db), { identity: 'a:account', lineage_fp: codexFingerprint(h.a) }, status);
      } finally { mutableFs.renameSync = original; h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
    }
  });

  it('a wiped verify after the rename records no live observation of the outgoing account and records the wiped event', async () => {
    const h = switchHarness(); let verify = false;
    try {
      const wiped = { status: 'wiped', error: { ok: false, error: 'tokens-empty', status: 'wiped' } } as const;
      const observationsOfA = () => scalarCount(h.db, "SELECT COUNT(*) AS count FROM codex_live_observations WHERE identity = 'a:account'");
      const result = await h.runWith({ hooks: { afterRename: () => { verify = true; } }, readLive: async () => verify
        ? wiped : readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }) });
      assert.equal(result.outcome, 'failed');
      assert.equal((h.db.prepare('SELECT detail FROM switch_log ORDER BY id DESC').get() as { detail: string }).detail, 'wiped');
      assert.deepEqual(newestObservation(h.db), { identity: null, lineage_fp: null });
      assert.equal(observationsOfA(), 1, 'only the pre-switch observation names A');
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM relogin_events WHERE kind = 'wiped'"), 1);
      assert.equal(journalState(h.root).state, 'absent');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a wiped verify after the rename records no active login', async () => {
    const h = switchHarness(); let verify = false;
    try {
      const wiped = { status: 'wiped', error: { ok: false, error: 'tokens-empty', status: 'wiped' } } as const;
      const result = await h.runWith({ hooks: { afterRename: () => { verify = true; } }, readLive: async () => verify
        ? wiped : readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }) });
      assert.equal(result.outcome, 'failed');
      assert.equal(h.store.getCodexActiveLogin(), null);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('an unresolved target-ancestor journal does not let a later import of those bytes resolve as ok', async () => {
    const h = switchHarness();
    try {
      const bPrime = observedDocument('b', 'switch-b-prime');
      importActiveCodexSlot(bPrime, { store: h.store, keychain: h.keychain, now: () => 1 });
      const result = await h.runWith({ hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(h.b)); } } });
      assert.equal(result.reason, 'target-ancestor');
      const read = journalState(h.root);
      assert.equal(read.state, 'ok');
      if (read.state !== 'ok') return;
      assert.equal(read.journal.adoptingTarget.includes(codexFingerprint(h.b)), false);
      // The user imports the ancestor bytes into slot B without logging in again.
      h.slots.writeSlot('b:account', h.b);
      const observed = await readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      const classified = classifyPostPublish({ journal: read.journal, observed, targetSlotFp: codexFingerprint(h.b) });
      assert.equal(classified, 'target-changed');
      const verdict = resolveRecoveryVerdict(classified, { action: 'noop', accountId: 'b:account' }, {
        phase: 'recovery', journal: read.journal, targetSlotFingerprint: codexFingerprint(h.b),
        slotHeads: new Map([['a:account', codexFingerprint(h.a)], ['b:account', codexFingerprint(h.b)]]), live: h.b });
      assert.notDeepEqual(verdict, { class: 'resolvable', effect: { outcome: 'ok', adopted: false } });
      assert.deepEqual(verdict, { class: 'resolvable', effect: { outcome: 'failed', detail: 'target-changed' } });
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a journal mark that returns false fails the attempt closed with the journal kept', async () => {
    // Replacing the journal's attempt id makes the conditional mark return false.
    const tamper = (root: string) => {
      const path = codexSwitchJournalPath({ journalDir: join(root, 'journal') });
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), attemptId: 'tampered' }));
    };
    for (const mark of ['adopting-target', 'unresolved'] as const) {
      const h = switchHarness();
      try {
        const beforeB = h.slots.readSlot('b:account');
        const live = mark === 'adopting-target' ? observedDocument('b', 'switch-b-prime') : observedDocument('c', 'switch-c-external');
        if (mark === 'unresolved') {
          importActiveCodexSlot(observedDocument('c', 'switch-c'), { store: h.store, keychain: h.keychain, now: () => 1 });
          h.keychain.setSync(qlbKeychainService('openai-codex', 'c:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(observedDocument('c', 'switch-c-split')));
        }
        await assert.rejects(h.runWith({ hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(live)); tamper(h.root); } } }), mark);
        const read = journalState(h.root);
        assert.equal(read.state, 'ok', mark);
        if (read.state !== 'ok') return;
        assert.equal(read.journal.attemptId, 'tampered', mark);
        assert.deepEqual(read.journal.adoptingTarget, [], mark); assert.equal(read.journal.unresolved, undefined, mark);
        assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM switch_log'), 0, mark);
        assert.deepEqual(h.slots.readSlot('b:account'), beforeB, mark);
        assert.equal(h.store.getCodexSlot('b:account')?.fingerprint, beforeB.fingerprint, mark);
      } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
    }
  });

  it('a journal written without an injected owner records this process\'s ps start so stillTheSameProcess recognises it', async () => {
    const h = switchHarness();
    try {
      let owner: CodexSwitchJournal['owner'] | undefined;
      const result = await h.runWith({ journalOwner: undefined, hooks: { afterRename: () => {
        const read = journalState(h.root); if (read.state === 'ok') owner = read.journal.owner;
      } } });
      assert.equal(result.outcome, 'ok');
      assert.equal(owner?.pid, process.pid);
      assert.equal(await stillTheSameProcess(owner!), true);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a lost lock after the rename keeps the journal and does not commit', async () => {
    const h = switchHarness();
    try {
      const authLock = codexAuthLockDir({ home: h.root });
      const result = await h.runWith({ hooks: { afterRename: () => { rmSync(authLock, { recursive: true, force: true }); mkdirSync(authLock, { recursive: true }); } } });
      assert.deepEqual(result, { outcome: 'failed', reason: 'lock-lost-after-publish', attemptId: 'switch-attempt' });
      assert.equal(ownerState(h.root), 'released');
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM switch_log'), 0);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a compromise reported after the commit returns the committed outcome with lockLostAfterCommit', async () => {
    const h = switchHarness();
    try {
      const commit = h.store.commitCodexSwitch.bind(h.store); const authLock = codexAuthLockDir({ home: h.root });
      h.store.commitCodexSwitch = ((input: Parameters<typeof h.store.commitCodexSwitch>[0]) => {
        const id = commit(input); rmSync(authLock, { recursive: true, force: true }); mkdirSync(authLock, { recursive: true }); return id;
      }) as typeof h.store.commitCodexSwitch;
      const result = await h.run();
      assert.equal(result.outcome, 'ok'); assert.equal(result.lockLostAfterCommit, true);
      // The committed attempt's kept journal is released; C6-20 recovery would delete it (X7), as this test does.
      assert.equal(ownerState(h.root), 'released');
      rmSync(join(h.root, 'journal'), { recursive: true, force: true }); rmSync(authLock, { recursive: true, force: true });
      // The same rule for a committed noop (I3): the live file already holds B.
      const noop = await h.runWith({ attempt: 'switch-attempt-noop' });
      assert.equal(noop.outcome, 'noop'); assert.equal(noop.lockLostAfterCommit, true); assert.equal(typeof noop.switchId, 'number');
      assert.deepEqual((h.db.prepare('SELECT outcome FROM switch_log ORDER BY id').all() as Array<{ outcome: string }>).map((row) => row.outcome), ['ok', 'noop']);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('lock wait timeout refuses switch-busy', async () => {
    const h = switchHarness();
    try {
      const lock = codexLockPaths(h.store.dbPath, '').switch; mkdirSync(lock, { recursive: true });
      const result = await h.run();
      assert.deepEqual(result, { outcome: 'refused', reason: 'switch-busy' });
      assert.equal(liveIdentity(h.authPath), 'a:account');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a target whose Keychain bytes differ from its recorded fingerprint is refused target-slot-split', async () => {
    const h = switchHarness();
    try {
      h.keychain.setSync(qlbKeychainService('openai-codex', 'b:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(observedDocument('b', 'split-b')));
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'target-slot-split' });
      assert.equal(liveIdentity(h.authPath), 'a:account');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a target refreshed by codex refresh while the switch waited publishes the new successor', async () => {
    const h = switchHarness(); const fresh = observedDocument('b', 'fresh-b');
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let held = false;
    try {
      // codex refresh holds the switch lock (consume → switch) while the switch queues behind it.
      const refreshing = withCodexSwitchLock(h.store.dbPath, async () => { held = true; await gate; });
      while (!held) await new Promise((resolve) => setImmediate(resolve));
      let targetReads = 0;
      const switching = h.runWith({ slots: { ...h.slots, readSlot: (id: string) => {
        if (id === 'b:account') targetReads += 1;
        return h.slots.readSlot(id);
      } } as never });
      while (targetReads === 0) await new Promise((resolve) => setImmediate(resolve));
      await sleep(400);
      assert.equal(targetReads, 1, 'the freshen read B and the switch is waiting for its lock');
      h.keychain.setSync(qlbKeychainService('openai-codex', 'b:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(fresh));
      h.db.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?').run(codexFingerprint(fresh), 'b:account');
      release(); await refreshing;
      assert.equal((await switching).outcome, 'ok');
      assert.equal(codexFingerprint(JSON.parse(readFileSync(h.authPath, 'utf8')) as CodexAuthDocument), codexFingerprint(fresh));
    } finally { release(); h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a target with under five minutes left at publish is freshened again in lock order', async () => {
    const h = switchHarness();
    const withExpiry = (document: CodexAuthDocument, expiry: number) => ({ ...document, tokens: { ...document.tokens, access_token: freshenJwt({ exp: Math.floor(expiry / 1_000) }) } });
    const soon = withExpiry(h.b, 1_700_000_000_000 + 6 * 60_000);
    const near = withExpiry(h.b, 1_700_000_000_000 + 4 * 60_000);
    const locks = { ...codexLockPaths(h.store.dbPath, 'b:account'), auth: codexAuthLockDir({ home: h.root }) };
    const held = () => ({ consume: existsSync(locks.consume), switch: existsSync(locks.switch), auth: existsSync(locks.auth) });
    try {
      h.keychain.setSync(qlbKeychainService('openai-codex', 'b:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(soon));
      h.db.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?').run(codexFingerprint(soon), 'b:account');
      let scheduledMutation = false; let posts = 0; const events: Array<[string, ReturnType<typeof held>]> = [];
      const result = await h.runWith({ hooks: { beforeFreshenLock: () => { events.push(['freshen', held()]); } }, slots: { ...h.slots, writeSlot: (id: string, document: CodexAuthDocument) => {
        h.keychain.setSync(qlbKeychainService('openai-codex', id), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(document));
        if (!scheduledMutation) {
          scheduledMutation = true;
          queueMicrotask(() => {
            h.keychain.setSync(qlbKeychainService('openai-codex', id), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(near));
            h.db.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?').run(codexFingerprint(near), id);
          });
        }
      } } as never, transport: async () => {
        posts += 1; events.push(['post', held()]);
        return { status: 200, body: JSON.stringify({ refresh_token: `post-${posts}`, access_token: freshenJwt({ exp: 1_700_003_600 }) }) };
      } });
      assert.equal(result.outcome, 'ok'); assert.equal(posts, 2);
      // I4: each freshen starts with switch and auth released, and POSTs under consume → switch, never with auth held.
      const free = { consume: false, switch: false, auth: false }; const posting = { consume: true, switch: true, auth: false };
      assert.deepEqual(events, [['freshen', free], ['post', posting], ['freshen', free], ['post', posting]]);
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a stale active_login naming the target still publishes when live is another slot', async () => {
    const h = switchHarness();
    try {
      h.store.setActiveLogin('openai-codex', 'b:account', 'import');
      assert.equal((await h.run()).outcome, 'ok');
      assert.equal(h.store.getCodexActiveLogin(), 'b:account');
      assert.equal(liveIdentity(h.authPath), 'b:account');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('codex import-active started during the switch waits on the auth lock and then sees B active', async () => {
    const h = switchHarness(); const pause = pauseUnderLocks(h.root, h.store.dbPath); const output: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => output.push(line), stderr: (line) => output.push(`stderr:${line}`),
      env: { QLB_TEST_MODE: '1', QLB_HOME: h.root, HOME: h.root, CODEX_HOME: h.root },
      config: { dbPath: h.store.dbPath, piAuthJsonPath: join(h.root, 'pi-auth.json') } as CommandContext['config'],
      loadConfig: () => { throw new Error('not used'); }, home: h.root,
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    const control = mkdtempSync(join(tmpdir(), 'qlb-codex-switch-control-'));
    try {
      beginCutover(h.store, 1);
      const switching = h.runWith({ list: pause.list });
      await pause.untilPaused();
      assert.equal(liveIdentity(h.authPath), 'a:account', 'paused before the rename');
      let importLocked = false; let committedWhenLocked = -1;
      const importing = runCodexImportActiveCommand(['--json'], ctx, {
        readAuth: readCodexAuthStable, writeAuth: writeCodexAuthAtomic, keychain: h.keychain,
        withAuthLock: (options, fn) => withCodexAuthLock({ ...options, retryMinMs: 1, retryJitterMs: 0 }, (held) => {
          importLocked = true; committedWhenLocked = scalarCount(h.db, `SELECT COUNT(*) AS count FROM switch_log WHERE outcome = 'ok'`);
          return fn(held);
        }),
      });
      // An uncontended auth lock is taken well within this window, so a still-blocked import is waiting on the switch.
      await withCodexAuthLock({ home: control, retryMinMs: 1, retryJitterMs: 0 }, () => undefined);
      await sleep(200);
      assert.equal(importLocked, false, 'import-active waits while the switch holds the auth lock');
      pause.state.release();
      assert.equal((await switching).outcome, 'ok');
      assert.equal(await importing, 0, output.join('\n'));
      assert.equal(committedWhenLocked, 1, 'import-active ran after the switch committed');
      assert.equal((JSON.parse(output.at(-1)!) as { slotId: string }).slotId, 'b:account');
      assert.equal(h.store.getCodexActiveLogin(), 'b:account');
    } finally { pause.state.release(); h.store.close(); rmSync(h.root, { recursive: true, force: true }); rmSync(control, { recursive: true, force: true }); }
  });

  it('a queued second switch to the same target records noop', async () => {
    const h = switchHarness(); const pause = pauseUnderLocks(h.root, h.store.dbPath);
    try {
      const first = h.runWith({ list: pause.list });
      await pause.untilPaused();
      let secondReads = 0;
      const second = h.runWith({ attempt: 'switch-attempt-2', readLive: async () => { secondReads += 1; return readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }); } });
      await sleep(600);
      // Its preflight read saw A; it is now queued on the switch lock, so the noop must be decided live under phase L (I9).
      assert.equal(secondReads, 1);
      pause.state.release();
      assert.equal((await first).outcome, 'ok');
      assert.equal((await second).outcome, 'noop');
      const outcomes = h.db.prepare('SELECT outcome FROM switch_log ORDER BY id').all() as Array<{ outcome: string }>;
      assert.deepEqual(outcomes.map((row) => row.outcome), ['ok', 'noop']);
    } finally { pause.state.release(); h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a switch whose auth lock was taken over aborts before the rename and publishes nothing', async () => {
    const h = switchHarness();
    try {
      const authLock = codexAuthLockDir({ home: h.root });
      const result = await h.runWith({ journalOptions: { fsyncDirectory: () => { rmSync(authLock, { recursive: true, force: true }); mkdirSync(authLock, { recursive: true }); } } });
      assert.deepEqual(result, { outcome: 'refused', reason: 'lock-lost' });
      assert.equal(liveIdentity(h.authPath), 'a:account');
      assert.equal(ownerState(h.root), 'released');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a stalled switch resumes after takeover and publishes nothing', async () => {
    const h = switchHarness(); const pause = pauseUnderLocks(h.root, h.store.dbPath); const authLock = codexAuthLockDir({ home: h.root });
    let releaseTakeover!: () => void; const takeoverGate = new Promise<void>((resolve) => { releaseTakeover = resolve; });
    try {
      const observations = scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations');
      const switching = h.runWith({ list: pause.list });
      await pause.untilPaused();
      assert.equal(pause.state.locksHeld, true, 'stalled holding switch and auth');
      // The stall outlives the lock's staleness, and another owner takes the lock over through the staleness path.
      const stale = new Date(Date.now() - 300_001); utimesSync(authLock, stale, stale);
      let tookOver = false;
      const takeover = withCodexAuthLock({ home: h.root, timeoutMs: 2_000, retryMinMs: 1, retryJitterMs: 0 }, async () => { tookOver = true; await takeoverGate; });
      while (!tookOver) await new Promise((resolve) => setImmediate(resolve));
      pause.state.release();
      assert.deepEqual(await switching, { outcome: 'refused', reason: 'lock-lost' });
      assert.equal(liveIdentity(h.authPath), 'a:account');
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM switch_log'), 0);
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations'), observations);
      assert.equal(journalState(h.root).state, 'absent');
      assert.equal(existsSync(authLock), true, 'the new owner still holds the auth lock');
      releaseTakeover(); await takeover;
    } finally { pause.state.release(); releaseTakeover(); h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });

  it('a switch whose owner died holding every lock is taken over after staleness and the next switch completes', async () => {
    const h = switchHarness();
    try {
      const locks = [codexLockPaths(h.store.dbPath, '').switch, codexAuthLockDir({ home: h.root }), codexSwitchJournalOwnerLockPath({ journalDir: join(h.root, 'journal') })];
      const age = (lock: string, ms: number) => { mkdirSync(lock, { recursive: true }); const at = new Date(Date.now() - ms); utimesSync(lock, at, at); };
      // A lock younger than five minutes still blocks.
      age(locks[0], 300_001); age(locks[1], 290_000); age(locks[2], 300_001);
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'switch-busy' });
      assert.equal(liveIdentity(h.authPath), 'a:account');
      for (const lock of locks) age(lock, 300_001);
      assert.equal((await h.runWith({ attempt: 'switch-attempt-2' })).outcome, 'ok');
      assert.equal(liveIdentity(h.authPath), 'b:account');
    } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
  });
});

function recoveryJournal(h: ReturnType<typeof switchHarness>, attemptId = 'recovery-journal'): CodexSwitchJournal {
  const bytes = readFileSync(h.authPath);
  return { v: 2, attemptId, from: 'a:account', to: 'b:account', target: { identity: { chatgpt_user_id: 'b', account_id: 'account' }, fingerprint: codexFingerprint(h.b) }, adoptingTarget: [], trigger: 'manual', decision: null, openSessions: [], outgoing: { sha256: `sha256-file:${createHash('sha256').update(bytes).digest('hex')}`, inode: statSync(h.authPath).ino }, publishedAt: 1_700_000_000_100, owner: { pid: process.pid, lstart: 'fixture-owner', state: 'released' } };
}

type SwitchHarness = ReturnType<typeof switchHarness>;
const recoveryMessage = (reason: string) => `Codex switch recovery needs you (${reason}): log in to Codex with the account you want (codex login), then run qlb codex import-active. QLB finishes the recovery at its next check.`;
/** Codex's own save: new bytes at a new inode. */
const codexWrites = (h: SwitchHarness, doc: CodexAuthDocument) => {
  const temp = `${h.authPath}.codex-save`;
  writeFileSync(temp, JSON.stringify(doc));
  renameSync(temp, h.authPath);
};
/** `qlb codex refresh <id> --force` with the production fence read under the locks (C6-12), a fake slot and a counting transport. */
const refresh = async (h: SwitchHarness, accountId: string) => {
  let posts = 0; let writes = 0; const errors: string[] = [];
  const document = h.slots.readSlot(accountId).document;
  const code = await runCodexRefreshCommand([accountId, '--force'], {
    getConfig: h.store.getConfig.bind(h.store),
    consume: async () => consumeUnderCodexLocks(h.store.dbPath, accountId, async (assertHeld) => {
      const fence = codexRecoveryFenceState(join(h.root, 'journal'), h.store);
      const result = await consumeCodexSlot({
        accountId, snapshot: document, trigger: 'force', force: true, assertHeld, holders: async () => [],
        slots: { readSlot: () => ({ document, fingerprint: codexFingerprint(document) }), writeSlot: () => { writes += 1; }, stashUnclaimed: () => 'unused' },
        inFlightSlots: fence.state === 'fenced' ? fence.accounts : undefined,
        transport: async () => { posts += 1; return { status: 500, body: '{}' }; },
      });
      return result.status === 'switch-in-flight' && fence.state === 'fenced' ? { ...result, message: fence.message } : result;
    }),
    write: () => {}, error: (line) => { errors.push(line); },
  });
  return { code, posts, writes, errors };
};

describe('reconcileCodexRecovery — C6-20', () => {
  type Harness = ReturnType<typeof switchHarness>;
  const journalDir = (h: Harness) => join(h.root, 'journal');
  const install = (h: Harness, j = recoveryJournal(h)) => { writeCodexSwitchJournal(j, { journalDir: journalDir(h) }); return j; };
  const close = (h: Harness) => { h.store.close(); rmSync(h.root, { recursive: true, force: true }); };
  const onDisk = (h: Harness) => readCodexSwitchJournal({ journalDir: journalDir(h) });
  const lastRow = (h: Harness) => ({ ...(h.db.prepare(`SELECT from_account, to_account, trigger, outcome, detail, published_at, steps_json
    FROM switch_log ORDER BY id DESC LIMIT 1`).get() as object) });
  const activeLogin = (h: Harness) => ({ ...(h.db.prepare("SELECT account_id, set_by FROM active_login WHERE provider = 'openai-codex'").get() as object) });
  const liveFp = (h: Harness) => codexFingerprint(JSON.parse(readFileSync(h.authPath, 'utf8')) as CodexAuthDocument);
  const slotFps = (h: Harness, id: string) => ({ db: h.store.getCodexSlot(id)?.fingerprint, keychain: h.slots.readSlot(id).fingerprint });
  const fenced = (result: { state: string; accounts?: Set<string> | '*' }) =>
    ({ ...result, accounts: result.accounts === '*' ? '*' : [...(result.accounts ?? [])].sort() });
  const unresolvedJournal = (h: Harness) => {
    const read = onDisk(h);
    return read.state === 'ok'
      ? { attempt: read.journal.attemptId, reason: read.journal.unresolved?.reason, accounts: read.journal.unresolved?.involvedAccounts }
      : read;
  };
  const refused = (reason: string) => ({ code: 3, posts: 0, writes: 0, errors: [recoveryMessage(reason)] });
  const viaJournal = (j: CodexSwitchJournal, outcome: string, detail: string | null, publishedAt: number | null = j.publishedAt) => ({
    from_account: j.from, to_account: j.to, trigger: j.trigger, outcome, detail, published_at: publishedAt,
    steps_json: JSON.stringify({ attempt: j.attemptId, via: 'journal' }),
  });

  it('kill before the rename ⇒ recovery records failed not-published and holderSets open no era for B', async () => {
    const h = switchHarness();
    const holdersOfB = () => {
      const history = readCodexSwitchHistory(h.store.dbPath, { journalDir: journalDir(h) });
      return holderSets(history.rows, history.observations).filter((set) => set.identities.includes('b:account'));
    };
    try {
      const j = install(h);
      // While the journal stands, B is a possible holder (I12).
      assert.notEqual(holdersOfB().length, 0);
      assert.deepEqual(await h.recover(), { state: 'clear' });
      assert.equal(switchRows(h.db).length, 1);
      assert.deepEqual(lastRow(h), viaJournal(j, 'failed', 'not-published', null));
      assert.deepEqual(holdersOfB(), []);
      assert.equal(onDisk(h).state, 'absent');
      assert.equal(liveFp(h), codexFingerprint(h.a));
      assert.equal((activeLogin(h) as { account_id: string }).account_id, 'a:account');
    } finally { close(h); }
  });

  it('kill after the rename ⇒ recovery commits ok with the journaled published_at and attempt', async () => {
    const h = switchHarness();
    try {
      const j = recoveryJournal(h);
      writeFileSync(h.authPath, JSON.stringify(h.b));
      install(h, j);
      assert.deepEqual(await h.recover(), { state: 'clear' });
      assert.equal(switchRows(h.db).length, 1);
      assert.deepEqual(lastRow(h), viaJournal(j, 'ok', null));
      assert.deepEqual(activeLogin(h), { account_id: 'b:account', set_by: 'journal' });
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM codex_watch WHERE outgoing = 'a:account' AND target = 'b:account'"), 1);
      assert.equal(onDisk(h).state, 'absent');
      assert.equal(liveFp(h), codexFingerprint(h.b));
    } finally { close(h); }
  });

  it('kill after the rename then A′ ⇒ recovery records reverted-by-codex and the file holds A′', async () => {
    const h = switchHarness();
    try {
      const aPrime = observedDocument('a', 'recovery-a');
      const j = install(h);
      writeFileSync(h.authPath, JSON.stringify(aPrime));
      assert.deepEqual(await h.recover(), { state: 'clear' });
      assert.deepEqual(lastRow(h), viaJournal(j, 'reverted-by-codex', null));
      assert.equal(readFileSync(h.authPath, 'utf8'), JSON.stringify(aPrime));
      assert.deepEqual(slotFps(h, 'a:account'), { db: codexFingerprint(aPrime), keychain: codexFingerprint(aPrime) });
      assert.deepEqual(slotFps(h, 'b:account'), { db: codexFingerprint(h.b), keychain: codexFingerprint(h.b) });
      assert.equal((activeLogin(h) as { account_id: string }).account_id, 'a:account');
      assert.equal(onDisk(h).state, 'absent');
    } finally { close(h); }
  });

  it('kill after commit ⇒ recovery deletes the journal and adds no row', async () => {
    const h = switchHarness();
    try {
      const j = install(h);
      h.store.commitCodexSwitch({ now: 2, accountId: j.to, setBy: 'journal', fromAccount: j.from, toAccount: j.to, trigger: j.trigger,
        outcome: 'ok', attempt: j.attemptId, via: 'journal', openSessionsJson: '[]', publishedAt: j.publishedAt, committedAt: 2,
        outgoing: j.from, target: j.to, observation: { identity: j.to, lineageFp: j.target.fingerprint },
        decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null } });
      const rows = switchRows(h.db);
      const active = activeLogin(h);
      const observations = scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations');
      // The attempt row exists, so recovery only deletes: it does not read auth.json again.
      const result = await h.recover({ readLive: async () => { throw new Error('a committed attempt is not re-verified'); } });
      assert.deepEqual(result, { state: 'clear' });
      assert.equal(onDisk(h).state, 'absent');
      assert.deepEqual(switchRows(h.db), rows);
      assert.deepEqual(activeLogin(h), active);
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations'), observations);
    } finally { close(h); }
  });

  it('a crash inside the post-publish adopt is finished by recovery with one adopt row and is not target-changed', async () => {
    const service = qlbKeychainService('openai-codex', 'b:account');
    // The post-publish adopt marks adoptingTarget, writes the Keychain, then commits SQLite (C6-19).
    for (const crash of ['after the Keychain write', 'after the SQLite commit'] as const) {
      const h = switchHarness();
      try {
        const bPrime = observedDocument('b', 'b-rotated');
        const j = recoveryJournal(h);
        j.adoptingTarget = [codexFingerprint(bPrime)];
        // Codex rotated the published B to B′ before the verify read.
        writeFileSync(h.authPath, JSON.stringify(bPrime));
        if (crash === 'after the Keychain write') {
          h.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(h.b));
          h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(bPrime));
        } else {
          await attributeForPhase({ assertHeld: () => undefined }, 'post', { store: h.store, keychain: h.keychain,
            slot: { accountId: 'b:account', document: h.b, fingerprint: codexFingerprint(h.b) }, activeSlotId: 'a:account',
            activeSetBy: 'adopt', live: bPrime, holderObservation: { aliveBefore: true, aliveAfter: false }, now: () => 3 });
          // Slot B no longer equals the journaled target: only adoptingTarget keeps it from target-changed.
          assert.equal(classifyPostPublish({ journal: { ...j, adoptingTarget: [] },
            observed: await readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }),
            targetSlotFp: h.store.getCodexSlot('b:account')!.fingerprint! }), 'target-changed');
        }
        install(h, j);
        assert.deepEqual(await h.recover(), { state: 'clear' }, crash);
        assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM lineage_log WHERE cause = 'adopt' AND account_id = 'b:account'"), 1, crash);
        assert.deepEqual(lastRow(h), viaJournal(j, 'ok', null), crash);
        assert.deepEqual(slotFps(h, 'b:account'), { db: codexFingerprint(bPrime), keychain: codexFingerprint(bPrime) }, crash);
        assert.equal((activeLogin(h) as { account_id: string }).account_id, 'b:account', crash);
        assert.equal(onDisk(h).state, 'absent', crash);
      } finally { close(h); }
    }
  });

  it('a recorded holder that exits before recovery still counts as aliveBefore and writes no soft relogin row', async () => {
    const holder: CodexProcess = { pid: 44, lstart: 'Tue Oct 28 10:00:00 2026', host: 'codex' };
    const recover = async (openSessions: CodexProcess[]) => {
      const h = switchHarness();
      try {
        const j = recoveryJournal(h);
        j.openSessions = openSessions;
        install(h, j);
        writeFileSync(h.authPath, JSON.stringify(observedDocument('a', 'holder')));
        // The holder has exited: no Codex process is listed at recovery.
        assert.deepEqual(await h.recover({ list: async () => [] }), { state: 'clear' });
        assert.equal((lastRow(h) as { outcome: string }).outcome, 'reverted-by-codex');
        const row = h.db.prepare('SELECT open_sessions_json FROM switch_log ORDER BY id DESC LIMIT 1').get() as { open_sessions_json: string };
        return {
          openSessions: (JSON.parse(row.open_sessions_json) as Array<{ pid: number; holderSet: string[] }>).map(({ pid, holderSet }) => ({ pid, holderSet })),
          evidence: (h.db.prepare("SELECT evidence FROM lineage_log WHERE cause = 'adopt' AND account_id = 'a:account'").get() as { evidence: string }).evidence,
          relogins: (h.db.prepare("SELECT kind, detail FROM relogin_events WHERE provider = 'openai-codex'").all() as object[]).map((r) => ({ ...r })),
        };
      } finally { close(h); }
    };
    const recorded = await recover([holder]);
    // The committed row carries the journal's snapshot, and its holder of A is aliveBefore.
    assert.deepEqual(recorded.openSessions, [{ pid: 44, holderSet: ['a:account', 'b:account'] }]);
    assert.equal(recorded.evidence, 'holder');
    assert.deepEqual(recorded.relogins, []);
    // Control: without the recorded holder the same recovery writes the soft row.
    const unrecorded = await recover([]);
    assert.equal(unrecorded.evidence, 'identity');
    assert.deepEqual(unrecorded.relogins, [{ kind: 'external-login', detail: 'unattributed-rotation' }]);
  });

  it('a target replaced after a crashed publish is not reconciled as ok and the journal is kept', async () => {
    const h = switchHarness();
    try {
      const bReplacement = observedDocument('b', 'b-new');
      const j = recoveryJournal(h);
      writeFileSync(h.authPath, JSON.stringify(h.b));
      install(h, j);
      importActiveCodexSlot(bReplacement, { store: h.store, keychain: h.keychain, now: () => 2 });
      const active = activeLogin(h);
      // X5d: slot B changed after the swap, so the published bytes are no longer the target.
      assert.equal(classifyPostPublish({ journal: j, observed: await readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }),
        targetSlotFp: h.store.getCodexSlot('b:account')!.fingerprint! }), 'target-changed');
      // The live bytes are B's recorded predecessor, so the fail-closed known-ancestor row names the fence (C6-15).
      assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'target-ancestor', message: recoveryMessage('target-ancestor'),
        accounts: ['a:account', 'b:account'] });
      assert.deepEqual(switchRows(h.db), []);
      assert.deepEqual(unresolvedJournal(h), { attempt: j.attemptId, reason: 'target-ancestor', accounts: ['a:account', 'b:account'] });
      assert.deepEqual(slotFps(h, 'b:account'), { db: codexFingerprint(bReplacement), keychain: codexFingerprint(bReplacement) });
      assert.equal(liveFp(h), codexFingerprint(h.b));
      assert.deepEqual(activeLogin(h), active);
    } finally { close(h); }
  });

  it('known-ancestor bytes of the target at recovery keep the journal and refuse with the message', async () => {
    const h = switchHarness();
    try {
      const bHead = observedDocument('b', 'b-head');
      importActiveCodexSlot(bHead, { store: h.store, keychain: h.keychain, now: () => 2 });
      h.store.setActiveLogin('openai-codex', 'a:account', 'import', 3);
      const j = recoveryJournal(h);
      j.target = { ...j.target, fingerprint: codexFingerprint(bHead) };
      install(h, j);
      // After the rename Codex wrote B's older lineage over the published head.
      codexWrites(h, h.b);
      const expected = { state: 'fenced', reason: 'target-ancestor', message: recoveryMessage('target-ancestor'), accounts: ['a:account', 'b:account'] };
      assert.deepEqual(fenced(await h.recover()), expected);
      assert.deepEqual(unresolvedJournal(h), { attempt: j.attemptId, reason: 'target-ancestor', accounts: ['a:account', 'b:account'] });
      // Republish is forbidden after the rename: auth.json and slot B are untouched.
      assert.equal(readFileSync(h.authPath, 'utf8'), JSON.stringify(h.b));
      assert.deepEqual(slotFps(h, 'b:account'), { db: codexFingerprint(bHead), keychain: codexFingerprint(bHead) });
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'target-ancestor', message: recoveryMessage('target-ancestor') });
      assert.deepEqual(await refresh(h, 'b:account'), refused('target-ancestor'));
      assert.deepEqual(switchRows(h.db), []);
      assert.deepEqual(unresolvedJournal(h), { attempt: j.attemptId, reason: 'target-ancestor', accounts: ['a:account', 'b:account'] });
    } finally { close(h); }
  });

  it('a split slot at recovery keeps the journal, refuses the next switch and refreshes of every involved account, and clears after import makes it resolvable', async () => {
    const h = switchHarness();
    try {
      const j = install(h);
      // A killed adopt left slot B's Keychain on other bytes than its SQLite row, with no :prev.
      h.keychain.setSync(qlbKeychainService('openai-codex', 'b:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(observedDocument('b', 'b-killed')));
      writeFileSync(h.authPath, JSON.stringify(observedDocument('b', 'b-rotated')));
      assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'slot-split', message: recoveryMessage('slot-split'),
        accounts: ['a:account', 'b:account'] });
      assert.deepEqual(unresolvedJournal(h), { attempt: j.attemptId, reason: 'slot-split', accounts: ['a:account', 'b:account'] });
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'slot-split', message: recoveryMessage('slot-split') });
      for (const accountId of ['a:account', 'b:account']) {
        assert.deepEqual(await refresh(h, accountId), refused('slot-split'), accountId);
      }
      assert.deepEqual(switchRows(h.db), []);
      // The user logs in to B (codex login), then runs qlb codex import-active.
      const bLogin = observedDocument('b', 'b-login');
      codexWrites(h, bLogin);
      importActiveCodexSlot(bLogin, { store: h.store, keychain: h.keychain, now: () => 4 });
      assert.deepEqual(await h.recover(), { state: 'clear' });
      // Slot B moved, so the resolution is target-changed with the publish time, never ok.
      assert.deepEqual(lastRow(h), viaJournal(j, 'failed', 'target-changed'));
      // C6-Q2: the login actually in the file is active.
      assert.deepEqual(activeLogin(h), { account_id: 'b:account', set_by: 'adopt' });
      assert.equal(onDisk(h).state, 'absent');
      assert.deepEqual(codexRecoveryFenceState(journalDir(h), h.store), { state: 'none' });
    } finally { close(h); }
  });

  it('a split third slot C at orphan recovery fences C and clears after import of C', async () => {
    const h = switchHarness();
    try {
      importActiveCodexSlot(observedDocument('c', 'c0'), { store: h.store, keychain: h.keychain, now: () => 2 });
      h.store.setActiveLogin('openai-codex', 'a:account', 'import', 3);
      // An orphaned journal (released, not executing) whose recovery finds slot C split and Codex on C′.
      const j = install(h);
      h.keychain.setSync(qlbKeychainService('openai-codex', 'c:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(observedDocument('c', 'c-killed')));
      writeFileSync(h.authPath, JSON.stringify(observedDocument('c', 'c-live')));
      assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'slot-split', message: recoveryMessage('slot-split'),
        accounts: ['a:account', 'b:account', 'c:account'] });
      assert.deepEqual(unresolvedJournal(h), { attempt: j.attemptId, reason: 'slot-split', accounts: ['a:account', 'b:account', 'c:account'] });
      assert.deepEqual(await refresh(h, 'c:account'), refused('slot-split'));
      assert.deepEqual(switchRows(h.db), []);
      // The user logs in to C and imports it.
      const cLogin = observedDocument('c', 'c-login');
      codexWrites(h, cLogin);
      importActiveCodexSlot(cLogin, { store: h.store, keychain: h.keychain, now: () => 4 });
      assert.deepEqual(await h.recover(), { state: 'clear' });
      assert.deepEqual(lastRow(h), viaJournal(j, 'reverted-by-codex', null));
      assert.equal((activeLogin(h) as { account_id: string }).account_id, 'c:account');
      assert.equal(onDisk(h).state, 'absent');
      assert.deepEqual(codexRecoveryFenceState(journalDir(h), h.store), { state: 'none' });

      // The same fence held as config (a watch verdict, C6-21): a narrower unresolved verdict keeps C.
      const switchId = (h.db.prepare('SELECT MAX(id) AS id FROM switch_log').get() as { id: number }).id;
      h.db.prepare("INSERT INTO codex_watch (switch_id, provider, outgoing, target, next_at, until) VALUES (?, 'openai-codex', 'a:account', 'b:account', 1, 2)").run(switchId);
      importActiveCodexSlot(observedDocument('b', 'b-head'), { store: h.store, keychain: h.keychain, now: () => 5 });
      h.store.setActiveLogin('openai-codex', 'a:account', 'import', 6);
      const fence = { v: 1 as const, switchId, attempt: 'watch-fence', from: 'a:account', to: 'b:account', publishedAt: 1_700_000_000_500,
        reason: 'slot-split', involvedAccounts: ['a:account', 'b:account', 'c:account'], since: 7 };
      h.store.setRecoveryFence(fence);
      codexWrites(h, h.b);
      assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'target-ancestor', message: recoveryMessage('target-ancestor'),
        accounts: ['a:account', 'b:account', 'c:account'] });
      assert.deepEqual(JSON.parse(h.store.getConfig('codex.recoveryFence')!), { ...fence, reason: 'target-ancestor' });
      assert.deepEqual(await refresh(h, 'c:account'), refused('target-ancestor'));
      const cLogin2 = observedDocument('c', 'c-login-2');
      codexWrites(h, cLogin2);
      importActiveCodexSlot(cLogin2, { store: h.store, keychain: h.keychain, now: () => 8 });
      assert.deepEqual(await h.recover(), { state: 'clear' });
      assert.deepEqual(lastRow(h), { from_account: 'a:account', to_account: 'b:account', trigger: 'manual', outcome: 'reverted-by-codex',
        detail: null, published_at: fence.publishedAt, steps_json: JSON.stringify({ attempt: fence.attempt, via: 'fence' }) });
      assert.deepEqual(activeLogin(h), { account_id: 'c:account', set_by: 'adopt' });
      assert.equal(h.store.hasConfig('codex.recoveryFence'), false);
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_watch'), 0);
      assert.deepEqual(codexRecoveryFenceState(journalDir(h), h.store), { state: 'none' });
    } finally { close(h); }
  });

  it('an unresolved attempt returned by a still-running fake C8 owner is cleared by that same process\'s next reconcileCodexRecovery after user repair, without a restart', async () => {
    const h = switchHarness();
    try {
      importActiveCodexSlot(observedDocument('b', 'b-head'), { store: h.store, keychain: h.keychain, now: () => 2 });
      h.store.setActiveLogin('openai-codex', 'a:account', 'import', 3);
      // The long-lived owner is still running: its pid and lstart match.
      const stillRunning = { journalOptions: { sameProcess: async () => true } };
      // Codex writes B's older lineage right after the rename: target-ancestor, unresolved.
      const returned = await h.runWith({ ...stillRunning, hooks: { afterRename: () => { codexWrites(h, h.b); } } });
      assert.deepEqual(returned, { outcome: 'failed', reason: 'target-ancestor', message: recoveryMessage('target-ancestor'), attemptId: 'switch-attempt' });
      const kept = onDisk(h);
      assert.ok(kept.state === 'ok');
      assert.deepEqual({ attempt: kept.journal.attemptId, owner: kept.journal.owner, reason: kept.journal.unresolved?.reason },
        { attempt: 'switch-attempt', owner: { pid: process.pid, lstart: 'fixture-owner', state: 'released' }, reason: 'target-ancestor' });
      // Before the repair the same process sees the unresolved fence, not journal-in-progress.
      const before = await h.recover(stillRunning);
      assert.equal(before.state === 'fenced' && before.reason, 'target-ancestor');
      assert.equal(onDisk(h).state, 'ok');
      // The user logs in to B and imports it; the same process checks again.
      const bLogin = observedDocument('b', 'b-login');
      codexWrites(h, bLogin);
      importActiveCodexSlot(bLogin, { store: h.store, keychain: h.keychain, now: () => 4 });
      assert.deepEqual(await h.recover(stillRunning), { state: 'clear' });
      assert.deepEqual(lastRow(h), viaJournal(kept.journal, 'failed', 'target-changed'));
      // C6-Q2: the login actually in the file is active.
      assert.deepEqual(activeLogin(h), { account_id: 'b:account', set_by: 'adopt' });
      assert.equal(onDisk(h).state, 'absent');
      assert.deepEqual(codexRecoveryFenceState(journalDir(h), h.store), { state: 'none' });
    } finally { close(h); }
  });

  it('a narrower unresolved re-check of a journal returns the first fenced accounts', async () => {
    const h = switchHarness();
    try {
      importActiveCodexSlot(observedDocument('c', 'c0'), { store: h.store, keychain: h.keychain, now: () => 2 });
      const bHead = observedDocument('b', 'b-head');
      importActiveCodexSlot(bHead, { store: h.store, keychain: h.keychain, now: () => 3 });
      h.store.setActiveLogin('openai-codex', 'a:account', 'import', 4);
      const j = recoveryJournal(h);
      j.target = { ...j.target, fingerprint: codexFingerprint(bHead) };
      install(h, j);
      // First check: slot C is split and Codex is on C′ ⇒ slot-split {A, B, C}.
      h.keychain.setSync(qlbKeychainService('openai-codex', 'c:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(observedDocument('c', 'c-killed')));
      writeFileSync(h.authPath, JSON.stringify(observedDocument('c', 'c-live')));
      assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'slot-split', message: recoveryMessage('slot-split'),
        accounts: ['a:account', 'b:account', 'c:account'] });
      // Second check: Codex wrote B's older lineage ⇒ target-ancestor, whose own set is only {A, B}.
      codexWrites(h, h.b);
      assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'target-ancestor', message: recoveryMessage('target-ancestor'),
        accounts: ['a:account', 'b:account', 'c:account'] });
      assert.deepEqual(unresolvedJournal(h), { attempt: j.attemptId, reason: 'target-ancestor', accounts: ['a:account', 'b:account', 'c:account'] });
      assert.deepEqual(await refresh(h, 'c:account'), refused('target-ancestor'));
      assert.deepEqual(switchRows(h.db), []);
    } finally { close(h); }
  });

  it('a pending re-check of a journal keeps the earlier unresolved accounts', async () => {
    const h = switchHarness();
    try {
      importActiveCodexSlot(observedDocument('c', 'c0'), { store: h.store, keychain: h.keychain, now: () => 2 });
      h.store.setActiveLogin('openai-codex', 'a:account', 'import', 3);
      const j = install(h);
      // First check: slot C is split and Codex is on C′ ⇒ slot-split {A, B, C}.
      h.keychain.setSync(qlbKeychainService('openai-codex', 'c:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(observedDocument('c', 'c-killed')));
      writeFileSync(h.authPath, JSON.stringify(observedDocument('c', 'c-live')));
      assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'slot-split', message: recoveryMessage('slot-split'),
        accounts: ['a:account', 'b:account', 'c:account'] });
      // Second check: the verify read is unreadable ⇒ pending, which keeps the fence.
      const pending = await h.recover({ readLive: async () => ({ status: 'unreadable', code: 'EACCES' }) });
      assert.deepEqual(fenced(pending), { state: 'fenced', reason: 'journal-verify-unreadable', message: recoveryMessage('journal-verify-unreadable'),
        accounts: ['a:account', 'b:account', 'c:account'] });
      assert.deepEqual(unresolvedJournal(h), { attempt: j.attemptId, reason: 'slot-split', accounts: ['a:account', 'b:account', 'c:account'] });
      assert.deepEqual(await refresh(h, 'c:account'), refused('slot-split'));
      assert.deepEqual(switchRows(h.db), []);
    } finally { close(h); }
  });

  it('a wiped auth.json at recovery records failed wiped and no active login', async () => {
    const h = switchHarness();
    try {
      const j = install(h);
      const wiped = { status: 'wiped', error: { ok: false, error: 'tokens-empty', status: 'wiped' } } as const;
      assert.deepEqual(await h.recover({ readLive: async () => wiped }), { state: 'clear' });
      assert.deepEqual(lastRow(h), viaJournal(j, 'failed', 'wiped'));
      assert.equal((activeLogin(h) as { account_id: string | null }).account_id, null);
      assert.equal(onDisk(h).state, 'absent');
    } finally { close(h); }
  });

  it('known-ancestor bytes of the outgoing slot at recovery commit reverted-by-codex and delete the journal', async () => {
    const h = switchHarness();
    try {
      const aHead = observedDocument('a', 'a-head');
      importActiveCodexSlot(aHead, { store: h.store, keychain: h.keychain, now: () => 2 });
      const j = install(h);
      // After the rename Codex wrote A's older lineage back: A's original bytes at a new inode.
      codexWrites(h, h.a);
      assert.deepEqual(await h.recover(), { state: 'clear' });
      assert.deepEqual(lastRow(h), viaJournal(j, 'reverted-by-codex', null));
      assert.equal((activeLogin(h) as { account_id: string }).account_id, 'a:account');
      // No file write: auth.json keeps A's older bytes and slot A keeps its newer head.
      assert.equal(readFileSync(h.authPath, 'utf8'), JSON.stringify(h.a));
      assert.deepEqual(slotFps(h, 'a:account'), { db: codexFingerprint(aHead), keychain: codexFingerprint(aHead) });
      assert.equal(onDisk(h).state, 'absent');
    } finally { close(h); }
  });

  it('two concurrent recoverers commit one row', async () => {
    const h = switchHarness();
    try {
      const j = install(h);
      writeFileSync(h.authPath, JSON.stringify(h.b));
      assert.deepEqual(await Promise.all([h.recover(), h.recover()]), [{ state: 'clear' }, { state: 'clear' }]);
      assert.deepEqual(switchRows(h.db).map(({ outcome, steps_json }) => ({ outcome, steps_json })),
        [{ outcome: 'ok', steps_json: JSON.stringify({ attempt: j.attemptId, via: 'journal' }) }]);
      assert.equal(onDisk(h).state, 'absent');
    } finally { close(h); }
  });

  it('a journal replaced after the probe is not deleted', async () => {
    const h = switchHarness();
    try {
      const j = install(h);
      writeFileSync(h.authPath, JSON.stringify(h.b));
      const successor = recoveryJournal(h, 'successor');
      const result = await h.recover({ crashAt: (at) => {
        if (at === 'recovery-after-commit') writeCodexSwitchJournal(successor, { journalDir: journalDir(h) });
      } });
      finishCodexSwitchAttempt(successor.attemptId);
      assert.deepEqual(result, { state: 'clear' });
      assert.deepEqual(switchRows(h.db).map(({ outcome, steps_json }) => ({ outcome, steps_json })),
        [{ outcome: 'ok', steps_json: JSON.stringify({ attempt: j.attemptId, via: 'journal' }) }]);
      assert.deepEqual(onDisk(h), { state: 'ok', journal: successor });
    } finally { close(h); }
  });

  it('a malformed journal is left and the switch is refused', async () => {
    const h = switchHarness();
    try {
      mkdirSync(journalDir(h), { recursive: true });
      const path = codexSwitchJournalPath({ journalDir: journalDir(h) });
      writeFileSync(path, '{');
      assert.deepEqual(await h.recover(), { state: 'fenced', reason: 'switch-recovery-malformed',
        message: recoveryMessage('switch-recovery-malformed'), accounts: '*' });
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'switch-recovery-malformed', message: recoveryMessage('switch-recovery-malformed') });
      assert.equal(readFileSync(path, 'utf8'), '{');
      assert.deepEqual(switchRows(h.db), []);
      assert.equal(liveFp(h), codexFingerprint(h.a));
    } finally { close(h); }
  });

  // ---- C6-20 review r1 ----
  /** A config fence (as a watch verdict would write it, C6-21) on its own committed A→B switch row. */
  const configFence = (h: Harness, reason = 'slot-split', involvedAccounts: string[] | '*' = ['a:account', 'b:account'], openSessions: CodexProcess[] = []) => {
    const switchId = h.store.recordSwitch({ ts: 1_700_000_000_400, provider: 'openai-codex', fromAccount: 'a:account', toAccount: 'b:account',
      trigger: 'manual', outcome: 'ok', detail: null, stepsJson: JSON.stringify({ attempt: 'watched-switch', via: 'switch' }),
      openSessionsJson: JSON.stringify(openSessions), publishedAt: 1_700_000_000_500, committedAt: 1_700_000_000_600 });
    const fence = { v: 1 as const, switchId, attempt: 'watch-fence', from: 'a:account', to: 'b:account', publishedAt: 1_700_000_000_500,
      reason, involvedAccounts, since: 7 };
    h.store.setRecoveryFence(fence);
    return fence;
  };
  const viaFence = (fence: { attempt: string; publishedAt: number }, outcome: string, detail: string | null) => ({ from_account: 'a:account',
    to_account: 'b:account', trigger: 'manual', outcome, detail, published_at: fence.publishedAt,
    steps_json: JSON.stringify({ attempt: fence.attempt, via: 'fence' }) });
  const inFlightMessage = (reason: string) => `codex refresh refused: ${reason} (a Codex switch involving this account has not finished)`;

  it('a target-changed journal whose auth.json is wiped or missing is fenced, not thrown (C6-20 r1)', async () => {
    const reads = {
      wiped: { status: 'wiped', error: { ok: false, error: 'tokens-empty', status: 'wiped' } },
      missing: { status: 'missing' },
    } as const;
    for (const [name, read] of Object.entries(reads)) {
      const h = switchHarness();
      try {
        const j = recoveryJournal(h);
        writeFileSync(h.authPath, JSON.stringify(h.b));
        install(h, j);
        // X5d: an import replaced slot B after the crashed publish.
        importActiveCodexSlot(observedDocument('b', 'b-new'), { store: h.store, keychain: h.keychain, now: () => 2 });
        const active = activeLogin(h);
        // §3.1 target-changed "whatever the live file holds"; no live identity ⇒ every account.
        assert.deepEqual(fenced(await h.recover({ readLive: async () => read })), { state: 'fenced', reason: 'target-changed',
          message: recoveryMessage('target-changed'), accounts: '*' }, name);
        assert.deepEqual(unresolvedJournal(h), { attempt: j.attemptId, reason: 'target-changed', accounts: '*' }, name);
        assert.deepEqual(switchRows(h.db), [], name);
        assert.deepEqual(activeLogin(h), active, name);
      } finally { close(h); }
    }
  });

  it('a classified ok whose slot B moved by a recorded adoption is attributed and fences target-ancestor, not thrown (C6-20 r1)', async () => {
    const h = switchHarness();
    try {
      const bPrime = observedDocument('b', 'b-rotated');
      const j = recoveryJournal(h);
      j.adoptingTarget = [codexFingerprint(bPrime)];
      // The post-publish adopt moved slot B to B′ (C6-19) ...
      await attributeForPhase({ assertHeld: () => undefined }, 'post', { store: h.store, keychain: h.keychain,
        slot: { accountId: 'b:account', document: h.b, fingerprint: codexFingerprint(h.b) }, activeSlotId: 'a:account',
        activeSetBy: 'adopt', live: bPrime, holderObservation: { aliveBefore: true, aliveAfter: false }, now: () => 3 });
      // ... and the file is back on B's published, older bytes.
      writeFileSync(h.authPath, JSON.stringify(h.b));
      install(h, j);
      assert.equal(classifyPostPublish({ journal: j, observed: await readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }),
        targetSlotFp: h.store.getCodexSlot('b:account')!.fingerprint! }), 'ok');
      assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'target-ancestor', message: recoveryMessage('target-ancestor'),
        accounts: ['a:account', 'b:account'] });
      assert.deepEqual(unresolvedJournal(h), { attempt: j.attemptId, reason: 'target-ancestor', accounts: ['a:account', 'b:account'] });
      assert.equal(readFileSync(h.authPath, 'utf8'), JSON.stringify(h.b));
      assert.deepEqual(switchRows(h.db), []);
    } finally { close(h); }
  });

  it('a reverted-by-codex resolved by journal recovery records active_login with set_by adopt (§3.1, C6-20 r1)', async () => {
    const h = switchHarness();
    try {
      const j = install(h);
      writeFileSync(h.authPath, JSON.stringify(observedDocument('a', 'recovery-a')));
      assert.deepEqual(await h.recover(), { state: 'clear' });
      assert.deepEqual(lastRow(h), viaJournal(j, 'reverted-by-codex', null));
      assert.deepEqual(activeLogin(h), { account_id: 'a:account', set_by: 'adopt' });
    } finally { close(h); }
  });

  it('an in-flight journal or a not-yet-stale owner lock refuses the switch with the in-flight text, not the log-in text (C6-20 r1)', async () => {
    const h = switchHarness();
    try {
      const j = recoveryJournal(h);
      j.owner = { pid: 4101, lstart: 'Tue Oct 28 10:00:00 2026', state: 'active' };
      install(h, j);
      // A live, active owner: the switch is still running.
      assert.deepEqual(await h.runWith({ journalOptions: { sameProcess: async () => true } }),
        { outcome: 'refused', reason: 'journal-in-progress', message: inFlightMessage('journal-in-progress') });
      // A dead owner whose owner lock is still fresh: it goes stale on its own.
      mkdirSync(codexSwitchJournalOwnerLockPath({ journalDir: journalDir(h) }), { recursive: true });
      assert.deepEqual(await h.runWith({ journalOptions: { sameProcess: async () => false, ownerLockTimeoutMs: 20 } }),
        { outcome: 'refused', reason: 'journal-owner-lock-not-yet-stale', message: inFlightMessage('journal-owner-lock-not-yet-stale') });
      assert.deepEqual(switchRows(h.db), []);
    } finally { executingCodexAttempts.clear(); close(h); }
  });

  it('an orphaned journal resolved in the same check as a config fence goes on to the fence (C6-20 r1)', async () => {
    const h = switchHarness();
    try {
      const j = install(h);
      writeFileSync(h.authPath, JSON.stringify(h.b));
      const fence = configFence(h);
      assert.deepEqual(await h.recover(), { state: 'clear' });
      // Both were resolved by the one call: the journal as ok, then the fence (live = B's head ⇒ ok).
      assert.deepEqual(switchRows(h.db).slice(-2).map(({ outcome, steps_json }) => ({ outcome, steps_json })), [
        { outcome: 'ok', steps_json: JSON.stringify({ attempt: j.attemptId, via: 'journal' }) },
        { outcome: 'ok', steps_json: JSON.stringify({ attempt: fence.attempt, via: 'fence' }) }]);
      assert.equal(onDisk(h).state, 'absent');
      assert.equal(h.store.hasConfig('codex.recoveryFence'), false);
    } finally { close(h); }
  });

  it('a pending re-check of a config fence returns the fence\'s from and to with its involved accounts (C6-20 r1)', async () => {
    const h = switchHarness();
    try {
      configFence(h, 'slot-split', ['c:account']);
      const pending = await h.recover({ readLive: async () => ({ status: 'unreadable', code: 'EACCES' }) });
      assert.deepEqual(fenced(pending).accounts, ['a:account', 'b:account', 'c:account']);
      assert.deepEqual(fenced(pending).accounts, fenced(codexRecoveryFenceState(journalDir(h), h.store)).accounts);
    } finally { close(h); }
  });

  it('a config-fence re-check that lost the switch lock writes neither a resolution nor a fence (C6-20 r1)', async () => {
    for (const name of ['resolution', 'unresolved'] as const) {
      const h = switchHarness();
      try {
        writeFileSync(h.authPath, JSON.stringify(h.b));
        configFence(h);
        // resolution: live = B's head ⇒ commitFenceResolution; unresolved: missing ⇒ logged-out ⇒ setRecoveryFence.
        if (name === 'unresolved') rmSync(h.authPath);
        const before = { fence: h.store.getConfig('codex.recoveryFence'), rows: switchRows(h.db), active: activeLogin(h) };
        let lost = false;
        const readLive = async () => { const read = await readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }); lost = true; return read; };
        await assert.rejects(h.recoverLocked(() => { if (lost) throw new Error('switch lock compromised'); }, { readLive }), /switch lock compromised/, name);
        assert.deepEqual({ fence: h.store.getConfig('codex.recoveryFence'), rows: switchRows(h.db), active: activeLogin(h) }, before, name);
      } finally { close(h); }
    }
  });

  it('a config-fence re-check counts a holder recorded on the fence\'s switch row as aliveBefore (C6-20 r1)', async () => {
    const holder: CodexProcess = { pid: 44, lstart: 'Tue Oct 28 10:00:00 2026', host: 'codex' };
    const recover = async (openSessions: CodexProcess[]) => {
      const h = switchHarness();
      try {
        configFence(h, 'slot-split', ['a:account', 'b:account'], openSessions);
        writeFileSync(h.authPath, JSON.stringify(observedDocument('a', 'holder')));
        // The holder has exited: no Codex process is listed at the re-check.
        assert.deepEqual(await h.recover({ list: async () => [] }), { state: 'clear' });
        assert.equal((lastRow(h) as { outcome: string }).outcome, 'reverted-by-codex');
        return {
          evidence: (h.db.prepare("SELECT evidence FROM lineage_log WHERE cause = 'adopt' AND account_id = 'a:account'").get() as { evidence: string }).evidence,
          relogins: (h.db.prepare("SELECT kind, detail FROM relogin_events WHERE provider = 'openai-codex'").all() as object[]).map((r) => ({ ...r })),
        };
      } finally { close(h); }
    };
    const recorded = await recover([holder]);
    assert.equal(recorded.evidence, 'holder');
    assert.deepEqual(recorded.relogins, []);
    // Control: without the recorded holder the same re-check writes the soft row.
    const unrecorded = await recover([]);
    assert.equal(unrecorded.evidence, 'identity');
    assert.deepEqual(unrecorded.relogins, [{ kind: 'external-login', detail: 'unattributed-rotation' }]);
  });

  it('a target-changed config fence resolves as failed(target-changed) with the live slot active (C6-Q2, C6-20 r1)', async () => {
    const h = switchHarness();
    try {
      writeFileSync(h.authPath, JSON.stringify(h.b));
      const fence = configFence(h, 'target-changed');
      assert.deepEqual(await h.recover(), { state: 'clear' });
      assert.deepEqual(lastRow(h), viaFence(fence, 'failed', 'target-changed'));
      assert.deepEqual(activeLogin(h), { account_id: 'b:account', set_by: 'adopt' });
      assert.equal(h.store.hasConfig('codex.recoveryFence'), false);
    } finally { close(h); }
  });

  it('a target-changed fence re-checked as slot-split keeps target-changed and later resolves as failed(target-changed), never ok', async () => {
    const h = switchHarness();
    try {
      const fence = configFence(h, 'target-changed');
      // A killed adopt left slot B's Keychain on other bytes than its SQLite row; Codex is on a rotated B.
      h.keychain.setSync(qlbKeychainService('openai-codex', 'b:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(observedDocument('b', 'b-killed')));
      codexWrites(h, observedDocument('b', 'b-rotated'));
      // The returned reason is the stored one, so this call and later fence reads agree (C6-20 r2).
      assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'target-changed', message: recoveryMessage('target-changed'),
        accounts: ['a:account', 'b:account'] });
      assert.equal(codexRecoveryFenceState(journalDir(h), h.store).state === 'fenced'
        && (codexRecoveryFenceState(journalDir(h), h.store) as { reason: string }).reason, 'target-changed');
      // The fence is still target-changed (§3.1: never ok); only its account set is unioned.
      assert.deepEqual(JSON.parse(h.store.getConfig('codex.recoveryFence')!), { ...fence, reason: 'target-changed' });
      // The user logs in to B and imports it: live now equals B's current head.
      const bLogin = observedDocument('b', 'b-login');
      codexWrites(h, bLogin);
      importActiveCodexSlot(bLogin, { store: h.store, keychain: h.keychain, now: () => 4 });
      assert.deepEqual(await h.recover(), { state: 'clear' });
      assert.deepEqual(lastRow(h), viaFence(fence, 'failed', 'target-changed'));
      assert.deepEqual(activeLogin(h), { account_id: 'b:account', set_by: 'adopt' });
      assert.equal(h.store.hasConfig('codex.recoveryFence'), false);
    } finally { close(h); }
  });

  // ---- C6-20 review r2 ----
  const breakSlot = (h: Harness, id: string) => h.keychain.setSync(qlbKeychainService('openai-codex', id), QLB_KEYCHAIN_ACCOUNT, '{');

  it('a target-changed journal whose auth.json is unstable or unreadable stays pending and writes nothing (§3.1, C6-20 r2)', async () => {
    const reads = { unstable: { status: 'unstable' }, unreadable: { status: 'unreadable', code: 'EACCES' } } as const;
    for (const [name, read] of Object.entries(reads)) {
      const h = switchHarness();
      try {
        const j = recoveryJournal(h);
        writeFileSync(h.authPath, JSON.stringify(h.b));
        install(h, j);
        importActiveCodexSlot(observedDocument('b', 'b-new'), { store: h.store, keychain: h.keychain, now: () => 2 });
        const before = { journal: onDisk(h), rows: switchRows(h.db), active: activeLogin(h) };
        assert.deepEqual(fenced(await h.recover({ readLive: async () => read })), { state: 'fenced', reason: `journal-verify-${name}`,
          message: recoveryMessage(`journal-verify-${name}`), accounts: ['a:account', 'b:account'] }, name);
        assert.deepEqual({ journal: onDisk(h), rows: switchRows(h.db), active: activeLogin(h) }, before, name);
      } finally { close(h); }
    }
  });

  it('a target-changed fence whose auth.json is unstable or unreadable stays pending and writes nothing (§3.1, C6-20 r2)', async () => {
    const reads = { unstable: { status: 'unstable' }, unreadable: { status: 'unreadable', code: 'EACCES' } } as const;
    for (const [name, read] of Object.entries(reads)) {
      const h = switchHarness();
      try {
        configFence(h, 'target-changed');
        const before = { fence: h.store.getConfig('codex.recoveryFence'), rows: switchRows(h.db), active: activeLogin(h) };
        assert.deepEqual(fenced(await h.recover({ readLive: async () => read })), { state: 'fenced', reason: `journal-verify-${name}`,
          message: recoveryMessage(`journal-verify-${name}`), accounts: ['a:account', 'b:account'] }, name);
        assert.deepEqual({ fence: h.store.getConfig('codex.recoveryFence'), rows: switchRows(h.db), active: activeLogin(h) }, before, name);
      } finally { close(h); }
    }
  });

  it('an unreadable target slot during a target-changed re-check keeps the fence and does not throw', async () => {
    // A slot-split fence (external live, attribution needed) and a target-changed fence (live on no head).
    for (const reason of ['target-changed', 'slot-split']) {
      const h = switchHarness();
      try {
        const fence = configFence(h, reason);
        breakSlot(h, 'b:account');
        codexWrites(h, observedDocument('b', 'b-other'));
        assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason, message: recoveryMessage(reason),
          accounts: ['a:account', 'b:account'] }, reason);
        assert.deepEqual(JSON.parse(h.store.getConfig('codex.recoveryFence')!), fence, reason);
        assert.deepEqual(switchRows(h.db).filter(({ steps_json }) => String(steps_json).includes('"fence"')), [], reason);
      } finally { close(h); }
    }
  });

  it('an unreadable target slot does not stop a target-changed fence or journal resolving on another slot head (C6-20 r2)', async () => {
    {
      const h = switchHarness();
      try {
        const fence = configFence(h, 'target-changed');
        breakSlot(h, 'b:account');
        codexWrites(h, h.a);
        assert.deepEqual(await h.recover(), { state: 'clear' });
        assert.deepEqual(lastRow(h), viaFence(fence, 'failed', 'target-changed'));
        assert.deepEqual(activeLogin(h), { account_id: 'a:account', set_by: 'adopt' });
        assert.equal(h.store.hasConfig('codex.recoveryFence'), false);
      } finally { close(h); }
    }
    {
      const h = switchHarness();
      try {
        const j = recoveryJournal(h);
        install(h, j);
        importActiveCodexSlot(observedDocument('b', 'b-new'), { store: h.store, keychain: h.keychain, now: () => 2 });
        h.store.setActiveLogin('openai-codex', 'a:account', 'import', 3);
        breakSlot(h, 'b:account');
        codexWrites(h, h.a);
        assert.deepEqual(await h.recover(), { state: 'clear' });
        assert.deepEqual(lastRow(h), viaJournal(j, 'failed', 'target-changed'));
        assert.deepEqual(activeLogin(h), { account_id: 'a:account', set_by: 'adopt' });
        assert.equal(onDisk(h).state, 'absent');
      } finally { close(h); }
    }
  });

  // ---- C6-20 review r3 ----
  it('an unreadable target slot does not clear recovery on another slot whose Keychain copy is missing or different', async () => {
    const serviceA = qlbKeychainService('openai-codex', 'a:account');
    const damage = {
      missing: (h: Harness) => h.keychain.deleteSync(serviceA, QLB_KEYCHAIN_ACCOUNT),
      corrupt: (h: Harness) => h.keychain.setSync(serviceA, QLB_KEYCHAIN_ACCOUNT, '{'),
      different: (h: Harness) => h.keychain.setSync(serviceA, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(observedDocument('a', 'a-other'))),
    };
    for (const [name, damageA] of Object.entries(damage)) {
      // Fence: live equals A's SQLite head, but A's Keychain copy does not back it.
      {
        const h = switchHarness();
        try {
          const fence = configFence(h, 'target-changed');
          breakSlot(h, 'b:account');
          codexWrites(h, h.a);
          damageA(h);
          const active = activeLogin(h);
          assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'target-changed', message: recoveryMessage('target-changed'),
            accounts: ['a:account', 'b:account'] }, `fence ${name}`);
          assert.deepEqual(JSON.parse(h.store.getConfig('codex.recoveryFence')!), fence, `fence ${name}`);
          assert.deepEqual(activeLogin(h), active, `fence ${name}`);
          assert.deepEqual(switchRows(h.db).filter(({ steps_json }) => String(steps_json).includes('"fence"')), [], `fence ${name}`);
        } finally { close(h); }
      }
      // Journal: the same, on an orphaned target-changed journal.
      {
        const h = switchHarness();
        try {
          const j = install(h);
          importActiveCodexSlot(observedDocument('b', 'b-new'), { store: h.store, keychain: h.keychain, now: () => 2 });
          h.store.setActiveLogin('openai-codex', 'a:account', 'import', 3);
          breakSlot(h, 'b:account');
          codexWrites(h, h.a);
          damageA(h);
          const active = activeLogin(h);
          assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'target-changed', message: recoveryMessage('target-changed'),
            accounts: ['a:account', 'b:account'] }, `journal ${name}`);
          assert.deepEqual(unresolvedJournal(h), { attempt: j.attemptId, reason: 'target-changed', accounts: ['a:account', 'b:account'] }, `journal ${name}`);
          assert.deepEqual(activeLogin(h), active, `journal ${name}`);
          assert.deepEqual(switchRows(h.db), [], `journal ${name}`);
        } finally { close(h); }
      }
    }
  });

  it('a fence kept because slot B is unreadable still fences the live identity\'s managed slot (§3.1, C6-20 r3)', async () => {
    const h = switchHarness();
    try {
      importActiveCodexSlot(observedDocument('c', 'c0'), { store: h.store, keychain: h.keychain, now: () => 2 });
      h.store.setActiveLogin('openai-codex', 'a:account', 'import', 3);
      const fence = configFence(h, 'slot-split');
      breakSlot(h, 'b:account');
      codexWrites(h, observedDocument('c', 'c-live'));
      assert.deepEqual(fenced(await h.recover()), { state: 'fenced', reason: 'slot-split', message: recoveryMessage('slot-split'),
        accounts: ['a:account', 'b:account', 'c:account'] });
      assert.deepEqual(JSON.parse(h.store.getConfig('codex.recoveryFence')!), { ...fence, involvedAccounts: ['a:account', 'b:account', 'c:account'] });
      assert.deepEqual(await refresh(h, 'c:account'), refused('slot-split'));
      assert.deepEqual(switchRows(h.db).filter(({ steps_json }) => String(steps_json).includes('"fence"')), []);
    } finally { close(h); }
  });
});

describe('Codex watch tick — C6-21', () => {
  type Harness = ReturnType<typeof switchHarness>;
  const close = (h: Harness) => { h.store.close(); rmSync(h.root, { recursive: true, force: true }); };
  const holderOfA: CodexProcess = { pid: 4401, lstart: 'Mon Nov 13 10:00:00 2023', host: 'codex' };
  /** Commit a real A→B switch and return its watch as C6-22's join will supply it. */
  const committedWatch = async (h: Harness, trigger = 'manual', list: () => Promise<CodexProcess[]> = async () => []): Promise<CodexWatch> => {
    // An automatic switch needs the S15 receipt.
    if (trigger !== 'manual') h.store.setConfig('codex.l13VerifiedAt', '1');
    assert.equal((await h.runWith({ list }, { target: 'b:account', trigger })).outcome, 'ok');
    const row = h.db.prepare(`SELECT w.switch_id, w.outgoing, w.target, w.until, s.trigger, json_extract(s.steps_json, '$.attempt') AS attempt,
      s.published_at, s.open_sessions_json FROM codex_watch w JOIN switch_log s ON s.id = w.switch_id`).get() as {
      switch_id: number; outgoing: string; target: string; until: number; trigger: string; attempt: string; published_at: number; open_sessions_json: string;
    };
    return { switchId: row.switch_id, outgoing: row.outgoing, target: row.target, trigger: row.trigger, attempt: row.attempt,
      publishedAt: row.published_at, until: row.until,
      openSessions: (JSON.parse(row.open_sessions_json) as CodexProcess[]).map(({ pid, lstart, host }) => ({ pid, lstart, host })) };
  };
  /** One tick at `publishedAt + offsetMs`. */
  const tick = (h: Harness, watch: CodexWatch, offsetMs: number, overrides: Partial<CodexSwitchDeps> = {}) => codexWatchTick(h.deps({
    authPath: h.authPath, dbPath: h.store.dbPath, journalDir: join(h.root, 'journal'),
    authLockOptions: { home: h.root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 }, keychain: h.keychain, slots: h.slots as never,
    list: async () => [], readLive: () => readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }), now: () => watch.publishedAt + offsetMs,
    attempt: 'watch-tick', journalOwner: { pid: process.pid, lstart: 'fixture-owner' }, ...overrides }), watch);
  const rows = (h: Harness) => switchRows(h.db);
  const lastRow = (h: Harness) => rows(h).at(-1);
  const watchRows = (h: Harness) => scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_watch');
  const activeLogin = (h: Harness) => ({ ...(h.db.prepare("SELECT account_id, set_by FROM active_login WHERE provider = 'openai-codex'").get() as object) });
  const slotFps = (h: Harness, id: string) => ({ db: h.store.getCodexSlot(id)?.fingerprint, keychain: h.slots.readSlot(id).fingerprint });
  const fence = (h: Harness) => { const raw = h.store.getConfig('codex.recoveryFence'); return raw === null ? null : JSON.parse(raw) as Record<string, unknown>; };
  const viaWatch = (watch: CodexWatch, outcome: string, detail: string | null, publishedAt: number | null, via = 'watch') => ({
    provider: 'openai-codex', from_account: watch.outgoing, to_account: watch.target, trigger: watch.trigger, outcome, detail,
    steps_json: JSON.stringify({ attempt: watch.attempt, via }), published_at: publishedAt,
  });
  const splitSlot = (h: Harness, id: string, refresh: string) => {
    const [user] = id.split(':');
    h.keychain.setSync(qlbKeychainService('openai-codex', id), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(observedDocument(user!, refresh)));
  };

  it('A′ at +30 s ⇒ reverted-by-codex row with the switch\'s trigger, slot A holds A′, active A, no dead mark, no relogin row', async () => {
    const h = switchHarness();
    try {
      // An auto switch with one Codex session that held A before the publish (aliveBefore from the switch row).
      const watch = await committedWatch(h, 'auto', async () => [holderOfA]);
      assert.equal(watch.trigger, 'auto');
      const aPrime = observedDocument('a', 'a-prime');
      codexWrites(h, aPrime);
      assert.deepEqual(await tick(h, watch, 30_000, { list: async () => [holderOfA] }), { state: 'reverted' });
      assert.equal(rows(h).length, 2);
      assert.deepEqual(lastRow(h), viaWatch(watch, 'reverted-by-codex', null, null));
      assert.deepEqual(slotFps(h, 'a:account'), { db: codexFingerprint(aPrime), keychain: codexFingerprint(aPrime) });
      assert.deepEqual(slotFps(h, 'b:account'), { db: codexFingerprint(h.b), keychain: codexFingerprint(h.b) });
      assert.equal(readFileSync(h.authPath, 'utf8'), JSON.stringify(aPrime));
      assert.deepEqual(activeLogin(h), { account_id: 'a:account', set_by: 'adopt' });
      assert.equal(scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_slots WHERE dead != 0'), 0);
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM relogin_events WHERE provider = 'openai-codex'"), 0);
      assert.equal(watchRows(h), 0);
    } finally { close(h); }
  });

  it('a manual B→A committed during an A→B watch ⇒ the watcher stops without logging reverted-by-codex', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      const back = await h.runWith({ attempt: 'switch-back' }, { target: 'a:account', trigger: 'manual' });
      assert.equal(back.outcome, 'ok');
      // auth.json now holds A, which the A→B watch alone would read as a reversion.
      assert.equal(codexIdentity(JSON.parse(readFileSync(h.authPath, 'utf8')) as CodexAuthDocument), 'a:account');
      const before = rows(h);
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'stopped', reason: 'superseded' });
      assert.deepEqual(rows(h), before);
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM switch_log WHERE outcome = 'reverted-by-codex'"), 0);
      assert.deepEqual(activeLogin(h), { account_id: 'a:account', set_by: 'manual' });
    } finally { close(h); }
  });

  it('a later switch whose orphaned journal the tick\'s own recovery commits supersedes the watch without logging reverted-by-codex', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      // A B→A attempt was killed after its rename: auth.json holds A and only its journal records it.
      const later = recoveryJournal(h, 'later-attempt');
      writeFileSync(h.authPath, JSON.stringify(h.a));
      writeCodexSwitchJournal({ ...later, from: 'b:account', to: 'a:account',
        target: { identity: { chatgpt_user_id: 'a', account_id: 'account' }, fingerprint: codexFingerprint(h.a) }, publishedAt: watch.publishedAt + 10_000 },
      { journalDir: join(h.root, 'journal') });
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'stopped', reason: 'superseded' });
      assert.equal((lastRow(h) as { outcome: string }).outcome, 'ok');
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM switch_log WHERE outcome = 'reverted-by-codex'"), 0);
    } finally { close(h); }
  });

  it('a refused or noop row during the watch does not stop it', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      assert.equal((await h.runWith({ attempt: 'refused-attempt', cswapProcesses: () => [{ pid: 1 }] })).outcome, 'refused');
      assert.equal((await h.runWith({ attempt: 'noop-attempt' })).outcome, 'noop');
      const before = rows(h);
      assert.deepEqual(before.slice(1).map((row) => [row.outcome, row.published_at]), [['refused', null], ['noop', null]]);
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'quiet' });
      assert.deepEqual(rows(h), before);
      assert.equal(scalarCount(h.db, `SELECT COUNT(*) AS count FROM codex_watch WHERE switch_id = ${watch.switchId}`), 1);
    } finally { close(h); }
  });

  it('a missing or corrupt slot-B Keychain item when live equals B\'s recorded head fences {A, B}, writes no row and keeps the watch (C6-21b)', async () => {
    const service = qlbKeychainService('openai-codex', 'b:account');
    const damage = {
      missing: (h: Harness) => h.keychain.deleteSync(service, QLB_KEYCHAIN_ACCOUNT),
      corrupt: (h: Harness) => h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, '{not json'),
    };
    for (const [label, apply] of Object.entries(damage)) {
      const h = switchHarness();
      try {
        const watch = await committedWatch(h);
        const before = { rows: rows(h), active: activeLogin(h) };
        apply(h);
        assert.deepEqual(await tick(h, watch, 30_000), { state: 'unresolved', reason: 'slot-split' }, label);
        assert.deepEqual(fence(h), { v: 1, switchId: watch.switchId, attempt: watch.attempt, from: 'a:account', to: 'b:account',
          publishedAt: watch.publishedAt, reason: 'slot-split', involvedAccounts: ['a:account', 'b:account'], since: watch.publishedAt + 30_000 }, label);
        assert.deepEqual({ rows: rows(h), active: activeLogin(h) }, before, label);
        assert.equal(watchRows(h), 1, `${label}: the watch is kept`);
        h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(h.b));
        assert.deepEqual(await refresh(h, 'b:account'), { code: 3, posts: 0, writes: 0, errors: [recoveryMessage('slot-split')] }, label);
      } finally { close(h); }
    }
  });

  it('a valid but non-head slot-B Keychain document fences {A, B}, writes no row and keeps the watch (C6-21b r1)', async () => {
    const service = qlbKeychainService('openai-codex', 'b:account');
    const mismatches = {
      'another B version': observedDocument('b', 'b-other-version'),
      'another account': observedDocument('c', 'c-other-account'),
    };
    for (const [label, document] of Object.entries(mismatches)) {
      const h = switchHarness();
      try {
        const watch = await committedWatch(h);
        const before = { rows: rows(h), active: activeLogin(h) };
        h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(document));
        assert.deepEqual(await tick(h, watch, 30_000), { state: 'unresolved', reason: 'slot-split' }, label);
        assert.deepEqual(fence(h), { v: 1, switchId: watch.switchId, attempt: watch.attempt, from: 'a:account', to: 'b:account',
          publishedAt: watch.publishedAt, reason: 'slot-split', involvedAccounts: ['a:account', 'b:account'], since: watch.publishedAt + 30_000 }, label);
        assert.deepEqual({ rows: rows(h), active: activeLogin(h) }, before, label);
        assert.equal(watchRows(h), 1, `${label}: the watch is kept`);
      } finally { close(h); }
    }
  });

  it('a slot-B split fence remains until B\'s Keychain copy matches its recorded head (C6-21b r2)', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      splitSlot(h, 'b:account', 'b-killed');
      assert.deepEqual(await tick(h, watch, 1_000), { state: 'unresolved', reason: 'slot-split' });
      const beforeRetry = rows(h);
      assert.deepEqual(await tick(h, watch, 5_000), { state: 'quiet' });
      assert.deepEqual(fence(h), { v: 1, switchId: watch.switchId, attempt: watch.attempt, from: 'a:account', to: 'b:account',
        publishedAt: watch.publishedAt, reason: 'slot-split', involvedAccounts: ['a:account', 'b:account'], since: watch.publishedAt + 1_000 });
      assert.deepEqual(rows(h), beforeRetry, 'the unresolved fence writes no effect row');
      assert.equal(watchRows(h), 1, 'the watch remains while B is split');
      h.keychain.setSync(qlbKeychainService('openai-codex', 'b:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(h.b));
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'quiet' });
      assert.deepEqual(lastRow(h), viaWatch(watch, 'ok', null, watch.publishedAt, 'fence'));
      assert.equal(fence(h), null);
      assert.equal(watchRows(h), 0);
    } finally { close(h); }
  });

  it('an external reversion with a split B fences instead of logging reverted-by-codex (C6-21b r3a)', async () => {
    const splitB = {
      'a non-head B': () => observedDocument('b', 'b-non-head'),
      'a wrong-identity B': () => {
        const document = observedDocument('b', 'b-wrong-identity');
        return { ...document, tokens: { ...document.tokens!, id_token: freshenJwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'c', chatgpt_account_id: 'account' } }) } };
      },
    };
    for (const [label, makeDocument] of Object.entries(splitB)) {
      const h = switchHarness();
      try {
        const watch = await committedWatch(h);
        h.keychain.setSync(qlbKeychainService('openai-codex', 'b:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(makeDocument()));
        codexWrites(h, h.a);
        assert.deepEqual(await tick(h, watch, 30_000), { state: 'unresolved', reason: 'slot-split' }, label);
        assert.equal((fence(h) as { reason: string }).reason, 'slot-split', label);
        assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM switch_log WHERE outcome IN ('ok', 'reverted-by-codex')"), 1, label);
        assert.equal(watchRows(h), 1, `${label}: the watch is kept`);
      } finally { close(h); }
    }
  });

  it('an existing slot-split fence remains while an external reversion leaves B split (C6-21b r3a)', async () => {
    const service = qlbKeychainService('openai-codex', 'b:account');
    const damage = {
      'a non-head B': (h: Harness) => splitSlot(h, 'b:account', 'b-non-head'),
      'a missing B': (h: Harness) => h.keychain.deleteSync(service, QLB_KEYCHAIN_ACCOUNT),
      'a corrupt B': (h: Harness) => h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, '{not json'),
    };
    for (const [label, apply] of Object.entries(damage)) {
      const h = switchHarness();
      try {
        const watch = await committedWatch(h);
        apply(h);
        assert.deepEqual(await tick(h, watch, 1_000), { state: 'unresolved', reason: 'slot-split' }, `${label}: creates the fence`);
        const before = rows(h);
        codexWrites(h, h.a);
        assert.deepEqual(await tick(h, watch, 5_000), { state: 'quiet' }, label);
        assert.equal((fence(h) as { reason: string }).reason, 'slot-split', label);
        assert.deepEqual(rows(h), before, `${label}: no fence-resolution row`);
        assert.equal(watchRows(h), 1, `${label}: the watch is kept`);
      } finally { close(h); }
    }
  });

  it('an external adopt-crash state repairs B instead of fencing it (C6-21b r2)', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      const bPrime = observedDocument('b', 'b-adopt-crash');
      const service = qlbKeychainService('openai-codex', 'b:account');
      // An adopt crashed after preserving B's predecessor and replacing its Keychain bytes, before its SQLite commit.
      h.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(h.b));
      h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(bPrime));
      codexWrites(h, bPrime);
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'quiet' });
      assert.deepEqual(slotFps(h, 'b:account'), { db: codexFingerprint(bPrime), keychain: codexFingerprint(bPrime) });
      assert.equal(fence(h), null);
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM lineage_log WHERE cause = 'adopt' AND account_id = 'b:account'"), 1);
    } finally { close(h); }
  });

  it('a same-refresh slot-B document with another identity fences the watch (C6-21b r2)', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      const otherIdentity = { ...h.b, tokens: { ...h.b.tokens!, id_token: freshenJwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'c', chatgpt_account_id: 'account' } }) } };
      h.keychain.setSync(qlbKeychainService('openai-codex', 'b:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(otherIdentity));
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'unresolved', reason: 'slot-split' });
      assert.equal((fence(h) as { reason: string }).reason, 'slot-split');
      assert.equal(watchRows(h), 1);
    } finally { close(h); }
  });

  it('a quiet B continues with no row', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      const watchRow = () => ({ ...(h.db.prepare('SELECT * FROM codex_watch WHERE switch_id = ?').get(watch.switchId) as object) });
      const before = { rows: rows(h), watch: watchRow(), active: activeLogin(h) };
      for (const offset of [1_000, 5_000, 30_000]) assert.deepEqual(await tick(h, watch, offset), { state: 'quiet' }, String(offset));
      assert.deepEqual({ rows: rows(h), watch: watchRow(), active: activeLogin(h) }, before);
      assert.equal(fence(h), null);
    } finally { close(h); }
  });

  it('a rotated B is adopted into slot B with no switch row', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      const before = rows(h);
      const bPrime = observedDocument('b', 'b-rotated');
      codexWrites(h, bPrime);
      assert.deepEqual(await tick(h, watch, 5_000), { state: 'quiet' });
      assert.deepEqual(slotFps(h, 'b:account'), { db: codexFingerprint(bPrime), keychain: codexFingerprint(bPrime) });
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM lineage_log WHERE cause = 'adopt' AND account_id = 'b:account'"), 1);
      assert.deepEqual(rows(h), before);
      assert.equal((activeLogin(h) as { account_id: string }).account_id, 'b:account');
      assert.equal(watchRows(h), 1);
      // The adopted head is now settled on target.
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'quiet' });
      assert.deepEqual(rows(h), before);
    } finally { close(h); }
  });

  it('an unresolved tick at +5 s writes the fence and a resolvable state at +30 s clears it through the tick\'s own locked recovery, writing exactly one effect row', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      // A killed adopt left slot B's Keychain on other bytes than its SQLite row; Codex then rotated B.
      splitSlot(h, 'b:account', 'b-killed');
      codexWrites(h, observedDocument('b', 'b-rotated'));
      assert.deepEqual(await tick(h, watch, 5_000), { state: 'unresolved', reason: 'slot-split' });
      assert.deepEqual(fence(h), { v: 1, switchId: watch.switchId, attempt: watch.attempt, from: 'a:account', to: 'b:account',
        publishedAt: watch.publishedAt, reason: 'slot-split', involvedAccounts: ['a:account', 'b:account'], since: watch.publishedAt + 5_000 });
      assert.equal(watchRows(h), 1, 'the row is kept');
      assert.equal(rows(h).length, 1);
      // The fence refuses the next switch, writing no row.
      assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'slot-split', message: recoveryMessage('slot-split') });
      assert.equal(rows(h).length, 1);

      // The user logs in to B and imports it.
      const bLogin = observedDocument('b', 'b-login');
      codexWrites(h, bLogin);
      importActiveCodexSlot(bLogin, { store: h.store, keychain: h.keychain, now: () => watch.publishedAt + 20_000 });
      const switchLock = codexLockPaths(h.store.dbPath, '').switch;
      const reads: boolean[] = [];
      const result = await tick(h, watch, 30_000, { readLive: async () => {
        reads.push(existsSync(switchLock));
        return readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      } });
      assert.deepEqual(result, { state: 'quiet' });
      // One locked read, by the tick's recovery; the tick does not read or attribute again.
      assert.deepEqual(reads, [true]);
      assert.equal(rows(h).length, 2, 'the switch and one effect row');
      assert.deepEqual(lastRow(h), viaWatch(watch, 'ok', null, watch.publishedAt, 'fence'));
      assert.equal(fence(h), null);
      assert.equal(watchRows(h), 0);
      assert.deepEqual(codexRecoveryFenceState(join(h.root, 'journal'), h.store), { state: 'none' });
    } finally { close(h); }
  });

  it('a split third slot C in the watch fences C and codex refresh of C is refused', async () => {
    const h = switchHarness();
    try {
      importActiveCodexSlot(observedDocument('c', 'c0'), { store: h.store, keychain: h.keychain, now: () => 2 });
      h.store.setActiveLogin('openai-codex', 'a:account', 'import', 3);
      const watch = await committedWatch(h);
      splitSlot(h, 'c:account', 'c-killed');
      codexWrites(h, observedDocument('c', 'c-live'));
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'unresolved', reason: 'slot-split' });
      assert.deepEqual((fence(h) as { involvedAccounts: string[] }).involvedAccounts, ['a:account', 'b:account', 'c:account']);
      assert.equal(rows(h).length, 1);
      assert.deepEqual(await refresh(h, 'c:account'), { code: 3, posts: 0, writes: 0, errors: [recoveryMessage('slot-split')] });
    } finally { close(h); }
  });

  it('a tick takes the switch lock once (no re-entry)', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      // A later attempt killed before its rename: the tick's recovery reads and commits it (not published),
      // then the tick reads again — both under the one switch lock it took.
      const later = recoveryJournal(h, 'later-not-landed');
      writeCodexSwitchJournal({ ...later, from: 'b:account', to: 'a:account',
        target: { identity: { chatgpt_user_id: 'a', account_id: 'account' }, fingerprint: codexFingerprint(h.a) } }, { journalDir: join(h.root, 'journal') });
      const switchLock = codexLockPaths(h.store.dbPath, '').switch;
      const owners: string[][] = [];
      const started = Date.now();
      const result = await tick(h, watch, 30_000, { readLive: async () => {
        owners.push(readdirSync(switchLock).filter((entry) => entry.startsWith('.qlb-owner-')));
        return readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      } });
      // A second acquisition would wait out the 10 s switch-lock timeout.
      assert.ok(Date.now() - started < 5_000);
      assert.deepEqual(result, { state: 'quiet' });
      assert.equal((lastRow(h) as { detail: string }).detail, 'not-published');
      assert.equal(owners.length, 2, 'recovery read + tick read');
      assert.equal(owners[0]!.length, 1);
      assert.deepEqual(owners[1], owners[0], 'one owner token: one acquisition');
      assert.equal(existsSync(switchLock), false, 'released after the tick');
    } finally { close(h); }
  });

  it('a missing auth.json during the watch stops it with logged-out and writes no row', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      const before = { rows: rows(h), active: activeLogin(h), observations: scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations') };
      rmSync(h.authPath);
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'stopped', reason: 'logged-out' });
      assert.deepEqual({ rows: rows(h), active: activeLogin(h), observations: scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations') }, before);
      assert.equal(watchRows(h), 0, 'row deleted');
      assert.equal(fence(h), null, 'no fence');
    } finally { close(h); }
  });

  it('a crash between the watch adopt and the revert commit is finished by the next tick', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h, 'manual', async () => [holderOfA]);
      const aPrime = observedDocument('a', 'a-crash');
      codexWrites(h, aPrime);
      const crashAt = (checkpoint: string) => { if (checkpoint === 'watch-before-revert-commit') throw new Error('fixture crash'); };
      await assert.rejects(tick(h, watch, 5_000, { crashAt }), /fixture crash/);
      // The adopt landed; the revert row and the watch delete did not.
      assert.deepEqual(slotFps(h, 'a:account'), { db: codexFingerprint(aPrime), keychain: codexFingerprint(aPrime) });
      assert.equal(rows(h).length, 1);
      assert.equal(watchRows(h), 1);
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'reverted' });
      assert.equal(rows(h).length, 2);
      assert.deepEqual(lastRow(h), viaWatch(watch, 'reverted-by-codex', null, null));
      assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM lineage_log WHERE cause = 'adopt' AND account_id = 'a:account'"), 1);
      assert.deepEqual(activeLogin(h), { account_id: 'a:account', set_by: 'adopt' });
      assert.equal(watchRows(h), 0);
    } finally { close(h); }
  });

  it('an overdue watch (now ≥ until + 60 s) is deleted without reading, attributing or writing a row, even under a fence', async () => {
    for (const fenced of [false, true]) {
      const h = switchHarness();
      try {
        const watch = await committedWatch(h);
        if (fenced) {
          splitSlot(h, 'b:account', 'b-killed');
          codexWrites(h, observedDocument('b', 'b-rotated'));
          assert.deepEqual(await tick(h, watch, 5_000), { state: 'unresolved', reason: 'slot-split' });
        }
        const storedFence = fence(h);
        const aPrime = observedDocument('a', 'a-late');
        codexWrites(h, aPrime);
        const before = { rows: rows(h), a: slotFps(h, 'a:account'), active: activeLogin(h),
          observations: scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations') };
        let reads = 0;
        const readLive = () => { reads += 1; return readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }); };
        const overdue = watch.until - watch.publishedAt + 60_000;
        assert.deepEqual(await tick(h, watch, overdue, { readLive }), { state: 'stopped', reason: 'overdue' }, String(fenced));
        assert.equal(reads, 0);
        assert.deepEqual({ rows: rows(h), a: slotFps(h, 'a:account'), active: activeLogin(h),
          observations: scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations') }, before);
        assert.equal(watchRows(h), 0);
        assert.deepEqual(fence(h), storedFence, 'a fence is cleared only by recovery');
      } finally { close(h); }
    }
    // Control: one millisecond earlier the tick still attributes the reversion.
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      codexWrites(h, observedDocument('a', 'a-late'));
      assert.deepEqual(await tick(h, watch, watch.until - watch.publishedAt + 59_999), { state: 'reverted' });
    } finally { close(h); }
  });

  it('an unknown live identity during the watch stashes it and commits failed unknown-live-identity, active_login NULL and the watch delete in one transaction', async () => {
    const unknownLogins = {
      'an unmanaged identity': observedDocument('z', 'z-live'),
      'no identity claims': (() => { const doc = freshenDocument(1_700_100_000_000, 'no-identity'); return { ...doc, tokens: { ...doc.tokens, id_token: freshenJwt({}) } }; })(),
    };
    for (const [label, unknown] of Object.entries(unknownLogins)) {
      const h = switchHarness();
      try {
        const watch = await committedWatch(h);
        const stashes: string[] = [];
        const slots = { ...h.slots, ensureUnclaimedStash: async (doc: CodexAuthDocument) => {
          stashes.push(codexFingerprint(doc)); return { stashId: 'fixture-stash', created: stashes.length === 1 };
        } };
        codexWrites(h, unknown);
        // The watch delete fails inside the transaction: nothing of the stop may remain.
        h.db.exec("CREATE TRIGGER fail_watch_delete BEFORE DELETE ON codex_watch BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END");
        await assert.rejects(tick(h, watch, 5_000, { slots: slots as never }), /fixture delete failure/, label);
        assert.equal(rows(h).length, 1, label);
        assert.deepEqual(activeLogin(h), { account_id: 'b:account', set_by: 'manual' }, label);
        assert.equal(watchRows(h), 1, label);
        h.db.exec('DROP TRIGGER fail_watch_delete');
        assert.deepEqual(await tick(h, watch, 30_000, { slots: slots as never }), { state: 'stopped', reason: 'unknown-live-identity' }, label);
        assert.deepEqual(rows(h).slice(1), [viaWatch(watch, 'failed', 'unknown-live-identity', null)], label);
        assert.deepEqual(activeLogin(h), { account_id: null, set_by: 'adopt' }, label);
        assert.equal(watchRows(h), 0, label);
        assert.deepEqual(stashes, [codexFingerprint(unknown), codexFingerprint(unknown)], `${label}: one body, ensured idempotently`);
      } finally { close(h); }
    }
  });

  it('a watch that lost its lock before the unknown-identity stash writes no stash', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      let stashes = 0;
      const slots = { ...h.slots, ensureUnclaimedStash: async () => { stashes += 1; return { stashId: 'fixture-stash', created: true }; } };
      codexWrites(h, observedDocument('z', 'z-live'));
      const switchLock = codexLockPaths(h.store.dbPath, '').switch;
      // Another holder takes the switch lock over while the tick lists Codex sessions.
      const list = async () => {
        for (const entry of readdirSync(switchLock)) if (entry.startsWith('.qlb-owner-')) rmSync(join(switchLock, entry));
        return [];
      };
      await assert.rejects(tick(h, watch, 5_000, { slots: slots as never, list }));
      assert.equal(stashes, 0);
      assert.equal(rows(h).length, 1);
      assert.equal(watchRows(h), 1);
    } finally { close(h); }
  });

  it('a tick after its own fence resolved ok reports quiet, not superseded, whoever resolved it', async () => {
    for (const resolver of ['the +5 s tick', 'another caller\'s recovery'] as const) {
      const h = switchHarness();
      try {
        const watch = await committedWatch(h);
        splitSlot(h, 'b:account', 'b-killed');
        codexWrites(h, observedDocument('b', 'b-rotated'));
        assert.deepEqual(await tick(h, watch, 1_000), { state: 'unresolved', reason: 'slot-split' }, resolver);
        const bLogin = observedDocument('b', 'b-login');
        codexWrites(h, bLogin);
        importActiveCodexSlot(bLogin, { store: h.store, keychain: h.keychain, now: () => watch.publishedAt + 2_000 });
        if (resolver === 'the +5 s tick') assert.deepEqual(await tick(h, watch, 5_000), { state: 'quiet' }, resolver);
        else assert.deepEqual(await h.recover(), { state: 'clear' }, resolver);
        const after = rows(h);
        assert.deepEqual(after.at(-1), viaWatch(watch, 'ok', null, watch.publishedAt, 'fence'), resolver);
        assert.deepEqual(await tick(h, watch, 30_000), { state: 'quiet' }, resolver);
        assert.deepEqual(rows(h), after, resolver);
        // A later publication still supersedes the watch.
        assert.equal((await h.runWith({ attempt: 'switch-back' }, { target: 'a:account', trigger: 'manual' })).outcome, 'ok', resolver);
        assert.deepEqual(await tick(h, watch, 60_000), { state: 'stopped', reason: 'superseded' }, resolver);
      } finally { close(h); }
    }
  });

  it('a later publishing row whose steps_json is not JSON supersedes the watch instead of failing the tick', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      h.store.recordSwitch({ ts: watch.publishedAt + 1, provider: 'openai-codex', fromAccount: 'b:account', toAccount: 'a:account', trigger: 'manual',
        outcome: 'ok', stepsJson: 'not json', publishedAt: watch.publishedAt + 1 });
      assert.equal((h.db.prepare('SELECT steps_json FROM switch_log ORDER BY id DESC LIMIT 1').get() as { steps_json: string }).steps_json, 'not json');
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'stopped', reason: 'superseded' });
    } finally { close(h); }
  });

  it('a later publishing row whose steps_json is JSON but not an object supersedes the watch instead of failing the tick (C6-21 r2)', async () => {
    for (const stepsJson of ['null', '1', '"text"', '[]']) {
      const h = switchHarness();
      try {
        const watch = await committedWatch(h);
        h.store.recordSwitch({ ts: watch.publishedAt + 1, provider: 'openai-codex', fromAccount: 'b:account', toAccount: 'a:account', trigger: 'manual',
          outcome: 'ok', stepsJson, publishedAt: watch.publishedAt + 1 });
        assert.deepEqual(await tick(h, watch, 30_000), { state: 'stopped', reason: 'superseded' }, stepsJson);
      } finally { close(h); }
    }
  });

  it('a tick whose slot B is unreadable also fences the live identity\'s managed slot, and every account when the live login has no identity (§3.1, C6-21 r2)', async () => {
    const noIdentity = (() => { const doc = freshenDocument(1_700_100_000_000, 'no-identity'); return { ...doc, tokens: { ...doc.tokens, id_token: freshenJwt({}) } }; })();
    const cases: Array<[string, CodexAuthDocument, string[] | '*']> = [
      ['a managed third slot C', observedDocument('c', 'c-live'), ['a:account', 'b:account', 'c:account']],
      ['an unmanaged identity', observedDocument('z', 'z-live'), ['a:account', 'b:account']],
      ['no identity claims', noIdentity, '*'],
    ];
    for (const [label, live, involved] of cases) {
      const h = switchHarness();
      try {
        importActiveCodexSlot(observedDocument('c', 'c0'), { store: h.store, keychain: h.keychain, now: () => 2 });
        h.store.setActiveLogin('openai-codex', 'a:account', 'import', 3);
        const watch = await committedWatch(h);
        codexWrites(h, live);
        h.keychain.deleteSync(qlbKeychainService('openai-codex', 'b:account'), QLB_KEYCHAIN_ACCOUNT);
        assert.deepEqual(await tick(h, watch, 30_000), { state: 'unresolved', reason: 'slot-split' }, label);
        assert.deepEqual((fence(h) as { involvedAccounts: unknown }).involvedAccounts, involved, label);
        assert.equal(rows(h).length, 1, label);
        assert.equal(watchRows(h), 1, label);
        if (involved === '*' || involved.includes('c:account')) {
          assert.deepEqual(await refresh(h, 'c:account'), { code: 3, posts: 0, writes: 0, errors: [recoveryMessage('slot-split')] }, label);
        }
      } finally { close(h); }
    }
  });

  it('a Keychain error other than a missing or corrupt slot-B item propagates out of the tick with no fence, no row and the watch kept (C6-21 r2)', async () => {
    const failures: Record<string, () => Error> = {
      timeout: () => Object.assign(new Error('security find-generic-password timed out after 10s'), { code: 'ETIMEDOUT' }),
      'access denied': () => new Error('keychain get failed: User interaction is not allowed.'),
    };
    for (const [label, failure] of Object.entries(failures)) {
      const h = switchHarness();
      try {
        const watch = await committedWatch(h);
        codexWrites(h, observedDocument('a', 'a-prime'));
        const slots = { ...h.slots, readSlot: (id: string) => { if (id === 'b:account') throw failure(); return h.slots.readSlot(id); } };
        const before = { rows: rows(h), active: activeLogin(h) };
        await assert.rejects(tick(h, watch, 30_000, { slots: slots as never }), (error: Error) => error.message === failure().message, label);
        assert.equal(fence(h), null, label);
        assert.deepEqual({ rows: rows(h), active: activeLogin(h) }, before, label);
        assert.equal(watchRows(h), 1, label);
      } finally { close(h); }
    }
  });

  it('two queued ticks that loaded the same watch over an unknown live identity commit one failed row and one stash write (C6-21 r2)', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h);
      let stashes = 0;
      const slots = { ...h.slots, ensureUnclaimedStash: async () => { stashes += 1; return { stashId: 'fixture-stash', created: stashes === 1 }; } };
      codexWrites(h, observedDocument('z', 'z-live'));
      // Both callers hold the watch as loaded before either took the lock; the second runs once the first releases it.
      assert.deepEqual(await tick(h, watch, 5_000, { slots: slots as never }), { state: 'stopped', reason: 'unknown-live-identity' });
      assert.deepEqual(await tick(h, watch, 5_001, { slots: slots as never }), { state: 'stopped', reason: 'superseded' });
      assert.deepEqual(rows(h).slice(1), [viaWatch(watch, 'failed', 'unknown-live-identity', null)]);
      assert.equal(stashes, 1);
      assert.equal(watchRows(h), 0);
    } finally { close(h); }
  });

  it('a watch revert row leaves findCodexSwitchByAttempt on the switch\'s ok commit', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h, 'manual', async () => [holderOfA]);
      codexWrites(h, observedDocument('a', 'a-prime'));
      assert.deepEqual(await tick(h, watch, 30_000), { state: 'reverted' });
      const found = h.store.findCodexSwitchByAttempt(watch.attempt);
      assert.deepEqual([found?.id, found?.outcome], [watch.switchId, 'ok']);
    } finally { close(h); }
  });

  it('switchCodex passes its trigger to admission', async () => {
    const h = switchHarness();
    try {
      const seen: Array<string | undefined> = [];
      assert.equal((await h.runWith({ admitted: (trigger?: string) => { seen.push(trigger); return { ok: true }; } })).outcome, 'ok');
      assert.deepEqual(seen, ['manual', 'manual', 'manual', 'manual']);
    } finally { close(h); }
  });

  it('a missing or corrupt slot-B Keychain item during a tick fences slot-split with {A, B}, writes no row and keeps the watch (C6-21-R1)', async () => {
    const service = qlbKeychainService('openai-codex', 'b:account');
    const damage = {
      missing: (h: Harness) => h.keychain.deleteSync(service, QLB_KEYCHAIN_ACCOUNT),
      corrupt: (h: Harness) => h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, '{not json'),
    };
    for (const [label, apply] of Object.entries(damage)) {
      const h = switchHarness();
      try {
        const watch = await committedWatch(h);
        const aPrime = observedDocument('a', 'a-prime');
        codexWrites(h, aPrime);
        apply(h);
        const before = { rows: rows(h), a: h.store.getCodexSlot('a:account')?.fingerprint, active: activeLogin(h) };
        assert.deepEqual(await tick(h, watch, 30_000), { state: 'unresolved', reason: 'slot-split' }, label);
        assert.deepEqual(fence(h), { v: 1, switchId: watch.switchId, attempt: watch.attempt, from: 'a:account', to: 'b:account',
          publishedAt: watch.publishedAt, reason: 'slot-split', involvedAccounts: ['a:account', 'b:account'], since: watch.publishedAt + 30_000 }, label);
        assert.deepEqual({ rows: rows(h), a: h.store.getCodexSlot('a:account')?.fingerprint, active: activeLogin(h) }, before, label);
        assert.equal(watchRows(h), 1, `${label}: the watch is kept`);
        for (const accountId of ['a:account', 'b:account']) {
          if (accountId === 'b:account') h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(h.b)); // refresh reads the slot first
          assert.deepEqual(await refresh(h, accountId), { code: 3, posts: 0, writes: 0, errors: [recoveryMessage('slot-split')] }, `${label}: ${accountId}`);
        }
      } finally { close(h); }
    }
  });

  describe('watch schedule and runDueCodexWatches — C6-22', () => {
    it('a switch ticks at +1 s, +5 s and +30 s and returns', async () => {
      const h = switchHarness();
      try {
        let clock = 1_700_000_000_000;
        const waits: number[] = [];
        const admissions: Array<string | undefined> = [];
        const result = await h.runWith({
          now: () => clock,
          sleep: async (ms) => { waits.push(ms); clock += ms; },
          admitted: (trigger) => { admissions.push(trigger); return { ok: true }; },
        });
        assert.equal(result.outcome, 'ok');
        assert.deepEqual(waits, [1_000, 4_000, 25_000]);
        assert.deepEqual(admissions, ['manual', 'manual', 'manual', 'manual'], 'initial admission plus all three ticks');
        assert.deepEqual(result.watch, { state: 'pending', until: 1_700_000_300_000 });
      } finally { close(h); }
    });

    it('a revert at the +5 s tick makes the switch result reverted-by-codex', async () => {
      const h = switchHarness();
      try {
        let clock = 1_700_000_000_000;
        const result = await h.runWith({ now: () => clock, sleep: async (ms) => {
          clock += ms;
          if (clock === 1_700_000_005_000) codexWrites(h, observedDocument('a', 'a-at-five'));
        } });
        assert.equal(result.outcome, 'reverted-by-codex');
        assert.equal(scalarCount(h.db, "SELECT COUNT(*) AS count FROM switch_log WHERE outcome = 'reverted-by-codex'"), 1);
      } finally { close(h); }
    });

    it('a missing auth.json at a foreground tick reports logged-out', async () => {
      const h = switchHarness();
      try {
        let clock = 1_700_000_000_000;
        const result = await h.runWith({ now: () => clock, sleep: async (ms) => {
          clock += ms; if (clock === 1_700_000_001_000) rmSync(h.authPath);
        } });
        assert.equal(result.outcome, 'ok');
        assert.deepEqual(result.watch, { state: 'stopped', reason: 'logged-out' });
        assert.equal(rows(h).length, 1, 'logged-out writes no watch result row');
        assert.equal(watchRows(h), 0, 'the terminal foreground stop consumes the durable row');
      } finally { close(h); }
    });

    it('runDueCodexWatches ticks at +2 min and +5 min and deletes the row', async () => {
      const h = switchHarness();
      try {
        const result = await h.runWith({ sleep: async () => undefined });
        assert.equal(result.outcome, 'ok');
        const due = h.db.prepare('SELECT next_at, until FROM codex_watch').get() as { next_at: number; until: number };
        const admissions: Array<string | undefined> = [];
        const admitted = (trigger?: string) => { admissions.push(trigger); return { ok: true }; };
        await runDueCodexWatches(h.deps({ authPath: h.authPath, dbPath: h.store.dbPath, journalDir: join(h.root, 'journal'), keychain: h.keychain,
          slots: h.slots as never, list: async () => [], readLive: () => readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }),
          authLockOptions: { home: h.root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 }, now: () => due.next_at, admitted }), due.next_at);
        assert.equal((h.db.prepare('SELECT next_at FROM codex_watch').get() as { next_at: number }).next_at, due.until);
        await runDueCodexWatches(h.deps({ authPath: h.authPath, dbPath: h.store.dbPath, journalDir: join(h.root, 'journal'), keychain: h.keychain,
          slots: h.slots as never, list: async () => [], readLive: () => readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }),
          authLockOptions: { home: h.root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 }, now: () => due.until, admitted }), due.until);
        assert.deepEqual(admissions, ['manual', 'manual'], 'both +2 and +5 minute ticks ran');
        assert.equal(watchRows(h), 0);
      } finally { close(h); }
    });

    it('a foreground stopped watch consumes not-admitted and superseded rows so the due consumer cannot resume either one', async () => {
      for (const terminal of ['not-admitted', 'superseded'] as const) {
        const h = switchHarness();
        try {
          let clock = 1_700_000_000_000;
          let checks = 0;
          const result = await h.runWith({
            now: () => clock,
            admitted: () => ({ ok: terminal !== 'not-admitted' || ++checks === 1, reason: 'not-admitted' }),
            sleep: async (ms) => {
              clock += ms;
              if (terminal === 'superseded' && clock === 1_700_000_001_000) {
                h.store.recordSwitch({ ts: clock, provider: 'openai-codex', fromAccount: 'b:account', toAccount: 'a:account', trigger: 'manual',
                  outcome: 'ok', stepsJson: JSON.stringify({ attempt: 'later', via: 'switch' }), publishedAt: clock });
              }
            },
          });
          assert.deepEqual(result.watch, { state: 'stopped', reason: terminal });
          assert.equal(watchRows(h), 0, `${terminal}: foreground consumed the terminal watch`);
          const before = switchRows(h.db);
          await runDueCodexWatches(h.deps({ now: () => 1_700_000_120_000 }), 1_700_000_120_000);
          assert.deepEqual(switchRows(h.db), before, `${terminal}: later due pass did nothing`);
        } finally { close(h); }
      }
    });

    it('a foreground tick error returns the committed outcome and leaves its durable watch for C8', async () => {
      const h = switchHarness();
      try {
        let verifying = false;
        let readsAfterVerify = 0;
        const result = await h.runWith({
          hooks: { beforeVerify: () => { verifying = true; } },
          readLive: async () => {
            if (verifying && ++readsAfterVerify === 2) throw new Error('fixture foreground tick error');
            return readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
          },
        });
        assert.equal(result.outcome, 'ok');
        assert.equal(watchRows(h), 1);
      } finally { close(h); }
    });

    it('a foreground lock compromise re-reads a committed revert, but keeps a quiet watch pending', async () => {
      const h = switchHarness();
      try {
        let clock = 1_700_000_000_000;
        const store = Object.create(h.store) as typeof h.store;
        store.commitCodexWatchRevert = (input) => {
          const id = h.store.commitCodexWatchRevert(input);
          throw new CodexAuthLockCompromised();
          return id;
        };
        const reverted = await h.runWith({ store, now: () => clock, sleep: async (ms) => {
          clock += ms;
          if (clock === 1_700_000_001_000) codexWrites(h, observedDocument('a', 'a-before-compromise'));
        } });
        assert.equal(reverted.outcome, 'reverted-by-codex');
        assert.deepEqual(reverted.watch, { state: 'stopped', reason: 'reverted-by-codex' });
        assert.equal(reverted.lockLostAfterCommit, true);
        assert.equal(watchRows(h), 0);

        const quiet = switchHarness();
        try {
          let quietClock = 1_700_000_000_000;
          let foreground = false;
          const quietStore = Object.create(quiet.store) as typeof quiet.store;
          quietStore.recordCodexObservation = (input) => {
            const observation = quiet.store.recordCodexObservation(input);
            if (foreground) throw new CodexAuthLockCompromised();
            return observation;
          };
          const result = await quiet.runWith({ store: quietStore, now: () => quietClock, sleep: async (ms) => {
            foreground = true; quietClock += ms;
          } });
          assert.equal(result.outcome, 'ok');
          assert.equal(result.watch?.state, 'pending');
          assert.equal(result.lockLostAfterCommit, true);
          assert.equal(watchRows(quiet), 1);
        } finally { close(quiet); }
      } finally { close(h); }
    });

    it('runDueCodexWatches uses the live in-tick clock after lock acquisition', async () => {
      const h = switchHarness();
      try {
        const result = await h.runWith({ sleep: async () => undefined });
        assert.equal(result.outcome, 'ok');
        const row = h.db.prepare('SELECT until FROM codex_watch').get() as { until: number };
        let clock = row.until + 59_999;
        codexWrites(h, observedDocument('a', 'overdue-during-lock-wait'));
        const before = switchRows(h.db);
        await runDueCodexWatches(h.deps({
          authPath: h.authPath, dbPath: h.store.dbPath, journalDir: join(h.root, 'journal'), keychain: h.keychain,
          slots: h.slots as never, list: async () => [], readLive: () => readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }),
          authLockOptions: { home: h.root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 }, now: () => clock,
          hooks: { afterWatchLock: () => { clock += 1; } },
        }), clock);
        assert.deepEqual(switchRows(h.db), before, 'the overdue tick writes no retroactive revert');
        assert.equal(watchRows(h), 0);
      } finally { close(h); }
    });

    it('a lock timeout at +1 s still runs the +5 s and +30 s foreground ticks', async () => {
      const h = switchHarness();
      try {
        let clock = 1_700_000_000_000;
        let releaseLock!: () => void;
        let lockReady!: () => void;
        const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
        const lockIsReady = new Promise<void>((resolve) => { lockReady = resolve; });
        let lockOwner: Promise<unknown> | undefined;
        const admissions: Array<string | undefined> = [];
        const result = await h.runWith({
          now: () => clock,
          authLockOptions: { home: h.root, timeoutMs: 5, retryMinMs: 1, retryJitterMs: 1 },
          admitted: (trigger) => { admissions.push(trigger); return { ok: true }; },
          sleep: async (ms) => {
            clock += ms;
            if (clock === 1_700_000_001_000) {
              lockOwner = withCodexAuthLock({ home: h.root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 }, async () => {
                lockReady(); await lockHeld;
              });
              await lockIsReady;
            }
            if (clock === 1_700_000_005_000) { releaseLock(); await lockOwner; }
          },
        });
        assert.equal(result.outcome, 'ok');
        assert.deepEqual(admissions, ['manual', 'manual', 'manual', 'manual']);
      } finally { close(h); }
    });

    it('runDueCodexWatches reads the clock again before each tick and drops a row that became overdue', async () => {
      const h = switchHarness();
      try {
        const result = await h.runWith({ sleep: async () => undefined });
        assert.equal(result.outcome, 'ok');
        const row = h.db.prepare('SELECT until FROM codex_watch').get() as { until: number };
        const started = row.until + 59_999;
        codexWrites(h, observedDocument('a', 'late-after-lock-wait'));
        const before = switchRows(h.db);
        await runDueCodexWatches(h.deps({
          authPath: h.authPath, dbPath: h.store.dbPath, journalDir: join(h.root, 'journal'), keychain: h.keychain,
          slots: h.slots as never, list: async () => [], readLive: () => readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }),
          authLockOptions: { home: h.root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 }, now: () => row.until + 60_000,
        }), started);
        assert.deepEqual(switchRows(h.db), before, 'overdue consumption writes no retroactive verdict');
        assert.equal(watchRows(h), 0);
      } finally { close(h); }
    });

    it('a crash during the in-process window leaves the row and runDueCodexWatches consumes it', async () => {
      const h = switchHarness();
      try {
        let clock = 1_700_000_000_000;
        const interrupted = await h.runWith({ now: () => clock, sleep: async (ms) => { clock += ms; throw new Error('fixture crash'); } });
        assert.equal(interrupted.outcome, 'ok', 'an in-process foreground error keeps the committed outcome');
        assert.equal(watchRows(h), 1);
        await runDueCodexWatches(h.deps({ authPath: h.authPath, dbPath: h.store.dbPath, journalDir: join(h.root, 'journal'), keychain: h.keychain,
          slots: h.slots as never, list: async () => [], readLive: () => readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }),
          authLockOptions: { home: h.root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 }, now: () => 1_700_000_120_000 }), 1_700_000_120_000);
        assert.equal(watchRows(h), 1);
        assert.equal((h.db.prepare('SELECT next_at FROM codex_watch').get() as { next_at: number }).next_at, 1_700_000_300_000);
      } finally { close(h); }
    });

    it('a watch row first consumed after its until is deleted without attributing', async () => {
      const h = switchHarness();
      try {
        const result = await h.runWith({ sleep: async () => undefined });
        assert.equal(result.outcome, 'ok');
        const row = h.db.prepare('SELECT until FROM codex_watch').get() as { until: number };
        const before = { rows: switchRows(h.db), observations: scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations') };
        await runDueCodexWatches(h.deps({ now: () => row.until + 60_000 }), row.until + 60_000);
        assert.deepEqual({ rows: switchRows(h.db), observations: scalarCount(h.db, 'SELECT COUNT(*) AS count FROM codex_live_observations') }, before);
        assert.equal(watchRows(h), 0);
      } finally { close(h); }
    });

    it('a codex_watch row of a superseded switch is deleted without a write', async () => {
      const h = switchHarness();
      try {
        const result = await h.runWith({ sleep: async () => undefined });
        assert.equal(result.outcome, 'ok');
        const row = h.db.prepare('SELECT published_at FROM switch_log ORDER BY id DESC LIMIT 1').get() as { published_at: number };
        const due = (h.db.prepare('SELECT next_at FROM codex_watch').get() as { next_at: number }).next_at;
        h.store.recordSwitch({ ts: row.published_at + 1, provider: 'openai-codex', fromAccount: 'b:account', toAccount: 'a:account', trigger: 'manual',
          outcome: 'ok', stepsJson: JSON.stringify({ attempt: 'later', via: 'switch' }), publishedAt: row.published_at + 1 });
        const before = switchRows(h.db);
        await runDueCodexWatches(h.deps({ authPath: h.authPath, dbPath: h.store.dbPath, journalDir: join(h.root, 'journal'), keychain: h.keychain,
          slots: h.slots as never, list: async () => [], readLive: () => readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }),
          authLockOptions: { home: h.root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 }, now: () => due }), due);
        assert.deepEqual(switchRows(h.db), before);
        assert.equal(watchRows(h), 0);
      } finally { close(h); }
    });

    it('a Codex save landing just before the rename is adopted as reverted-by-codex when the session saves again during the watch', async () => {
      const h = switchHarness();
      try {
        let clock = 1_700_000_000_000;
        let preRenameSave = false;
        const savedBeforeRename = observedDocument('a', 'a-session-save-before-rename');
        const savedDuringWatch = observedDocument('a', 'a-session-save-during-watch');
        const result = await h.runWith({
          now: () => clock,
          hooks: { beforeRename: () => { preRenameSave = true; codexWrites(h, savedBeforeRename); } },
          sleep: async (ms) => {
            clock += ms;
            if (clock === 1_700_000_001_000) codexWrites(h, savedDuringWatch);
          },
        });
        assert.equal(preRenameSave, true, 'a Codex save landed after CAS and before QLB renamed B');
        assert.equal(result.outcome, 'reverted-by-codex');
        assert.deepEqual(slotFps(h, 'a:account'), { db: codexFingerprint(savedDuringWatch), keychain: codexFingerprint(savedDuringWatch) });
        assert.deepEqual(activeLogin(h), { account_id: 'a:account', set_by: 'adopt' });
      } finally { close(h); }
    });
  });

  it('a tick outside an admitting lifecycle state stops', async () => {
    const h = switchHarness();
    try {
      const watch = await committedWatch(h, 'auto');
      // cutting-over admits switch:manual but not switch:auto (§4.15).
      beginCutover(h.store, 1);
      const seen: Array<string | undefined> = [];
      const admitted = (trigger?: string) => {
        seen.push(trigger);
        const result = assertAdmitted(h.store, `switch:${trigger}` as LifecycleOperation);
        return { ok: result.ok, reason: result.code };
      };
      let reads = 0;
      const readLive = () => { reads += 1; return readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }); };
      const before = { rows: rows(h), watches: watchRows(h) };
      assert.deepEqual(await tick(h, watch, 30_000, { admitted, readLive }), { state: 'stopped', reason: 'not-admitted' });
      assert.deepEqual(seen, ['auto']);
      assert.equal(reads, 0, 'stopped before any lock or read');
      assert.deepEqual({ rows: rows(h), watches: watchRows(h) }, before);
      // The same state admits a manual switch's watch.
      assert.deepEqual(await tick(h, { ...watch, trigger: 'manual' }, 30_000, { admitted, readLive }), { state: 'quiet' });
      assert.deepEqual(seen, ['auto', 'manual']);
    } finally { close(h); }
  });
});
