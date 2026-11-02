import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CodexProcessCheckFailed,
  accessFingerprint,
  activeCodexRenewers,
  classifyActiveCodexExpiry,
  holdersFor,
  listOrFail,
  reconcileActiveCodexLive,
  refreshActiveCodexLogin,
  type CodexActiveDeps,
} from '../src/codex-active';
import { codexAuthFileSha256, codexAuthFileText, codexFingerprint, codexIdentity, readCodexAuthStableWithStat, type CodexAuthDocument } from '../src/codex-auth';
import { CodexSlots, CodexStashUnverifiable, importActiveCodexSlot } from '../src/codex-slots';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { readCodexSwitchHistory, type CodexProcess } from '../src/codex-sessions';
import { openStore } from '../src/store';
import { ClaudeCodeLockTimeout, codexAuthLockDir } from '../src/cc-locks';
import { codexLockPaths } from '../src/codex-consume';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const A = 'user-a:account-a';
const B = 'user-b:account-b';
const C = 'user-c:account-c';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(expiresAt: number | null, access = 'fixture-access-a'): CodexAuthDocument {
  return {
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-a', chatgpt_account_id: 'account-a' } }),
      access_token: expiresAt === null ? 'not-a-jwt' : jwt({ exp: Math.floor(expiresAt / 1_000), sub: access }),
      refresh_token: 'fixture-refresh-a',
      account_id: 'account-a',
    },
    last_refresh: '2026-10-30T12:00:00.000Z',
  };
}

function process(pid: number, offsetMs: number): CodexProcess {
  return {
    pid,
    lstart: new Date(NOW + offsetMs).toUTCString().replace('GMT', '').trim(),
    host: 'codex',
  };
}

function harness(list: () => Promise<CodexProcess[]>) {
  const root = mkdtempSync('/tmp/qlb-codex-active-');
  const journalDir = join(root, 'journal');
  mkdirSync(journalDir);
  const store = openStore(join(root, 'qlb.db'));
  const deps = { dbPath: store.dbPath, journalDir, list };
  return {
    store,
    deps,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function activeHarness() {
  const root = mkdtempSync('/tmp/qlb-codex-active-live-');
  const journalDir = join(root, 'journal');
  mkdirSync(journalDir);
  const store = openStore(join(root, 'qlb.db'));
  const keychain = new MockKeychain();
  const authPath = join(root, 'auth.json');
  const a0 = document(NOW + 60_000, 'fixture-access-a0');
  importActiveCodexSlot(a0, { store, keychain, now: () => NOW - 1 });
  store.setActiveLogin('openai-codex', A, 'import', NOW);
  writeFileSync(authPath, JSON.stringify(a0));
  const codexSlots = new CodexSlots({ keychain, stashDir: join(root, 'unclaimed'), now: () => NOW });
  const slots = {
    readSlot: codexSlots.readSlot.bind(codexSlots),
    writeSlot: codexSlots.writeSlot.bind(codexSlots),
    ensureUnclaimedStash: codexSlots.ensureUnclaimedStash.bind(codexSlots),
    stashUnclaimed: codexSlots.stashUnclaimed.bind(codexSlots),
    stashUnclaimedDurably: codexSlots.stashUnclaimedDurably.bind(codexSlots),
    stashSuccessorEmergency: codexSlots.stashSuccessorEmergency.bind(codexSlots),
    findStashedSuccessor: codexSlots.findStashedSuccessor.bind(codexSlots),
    removeStashedSuccessor: codexSlots.removeStashedSuccessor.bind(codexSlots),
  };
  const deps: CodexActiveDeps = {
    store, dbPath: store.dbPath, journalDir, authPath, keychain, slots: slots as never,
    readLive: () => readCodexAuthStableWithStat(authPath, { delayMs: 0 }),
    cswapProcesses: () => [], now: () => NOW, attempt: 'active-fixture', list: async () => [],
    transport: async () => { throw new Error('unexpected transport'); },
    withLocks: async (_accountId, fn) => fn(() => undefined),
  };
  return {
    root, store, keychain, authPath, a0, deps,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function observe(h: ReturnType<typeof harness>, identity: string, at: number): void {
  h.store.recordCodexObservation({ identity, lineageFp: `sha256:${identity}`, by: 'qlb-active', now: at });
}

function switchRow(h: ReturnType<typeof harness>, from: string, to: string, at: number): void {
  h.store.recordSwitch({
    provider: 'openai-codex', fromAccount: from, toAccount: to, trigger: 'manual', outcome: 'ok', ts: at, publishedAt: at,
  });
}

describe('codex active refresh helpers', () => {
  it('classifyActiveCodexExpiry: 6 min ⇒ usable, 3 min ⇒ near-expiry, −1 s ⇒ expired, no exp ⇒ unknown', () => {
    assert.deepEqual(classifyActiveCodexExpiry(document(NOW + 6 * 60_000), NOW), {
      state: 'usable', expiresAt: NOW + 6 * 60_000, leftMs: 6 * 60_000,
    });
    assert.deepEqual(classifyActiveCodexExpiry(document(NOW + 3 * 60_000), NOW), {
      state: 'near-expiry', expiresAt: NOW + 3 * 60_000, leftMs: 3 * 60_000,
    });
    assert.deepEqual(classifyActiveCodexExpiry(document(NOW - 1_000), NOW), {
      state: 'expired', expiresAt: NOW - 1_000, leftMs: -1_000,
    });
    assert.deepEqual(classifyActiveCodexExpiry(document(null), NOW), {
      state: 'unknown', expiresAt: null, leftMs: null,
    });
  });

  it('no switch rows and no observations + a running codex ⇒ every process is a renewer', async () => {
    const processes = [process(101, -30_000), process(102, 30_000)];
    const h = harness(async () => processes);
    try {
      assert.deepEqual(await activeCodexRenewers(h.deps, A), processes);
    } finally { h.close(); }
  });

  it('only a not-published failed row ⇒ every process is a renewer', async () => {
    const processes = [process(111, -30_000), process(112, 30_000)];
    const h = harness(async () => processes);
    try {
      h.store.recordSwitch({
        provider: 'openai-codex', fromAccount: A, toAccount: B, trigger: 'manual', outcome: 'failed',
        detail: 'not-published', ts: NOW, publishedAt: null,
      });
      assert.deepEqual(await activeCodexRenewers(h.deps, A), processes);
    } finally { h.close(); }
  });

  it('only a refused row with no source account ⇒ every process is a renewer', async () => {
    const processes = [process(121, -30_000), process(122, 30_000)];
    const h = harness(async () => processes);
    try {
      h.store.recordSwitch({
        provider: 'openai-codex', fromAccount: null, toAccount: B, trigger: 'manual', outcome: 'refused', ts: NOW,
      });
      assert.deepEqual(await activeCodexRenewers(h.deps, A), processes);
    } finally { h.close(); }
  });

  it('only a null-identity observation ⇒ every process is a renewer', async () => {
    const processes = [process(131, -30_000), process(132, 30_000)];
    const h = harness(async () => processes);
    try {
      h.store.recordCodexObservation({ identity: null, lineageFp: null, by: 'qlb-active', now: NOW });
      assert.deepEqual(await activeCodexRenewers(h.deps, A), processes);
    } finally { h.close(); }
  });

  it('history naming a different account uses renewers instead of the fallback', async () => {
    const processes = [process(141, -30_000), process(142, 30_000)];
    const h = harness(async () => processes);
    try {
      observe(h, B, NOW);
      assert.deepEqual(await activeCodexRenewers(h.deps, A), []);
    } finally { h.close(); }
  });

  it('one observation and no switch rows ⇒ processes started before it renew the observed identity', async () => {
    const before = process(201, -20_000);
    const after = process(202, 20_000);
    const h = harness(async () => [before, after]);
    try {
      observe(h, A, NOW);
      assert.deepEqual((await activeCodexRenewers(h.deps, A)).map(({ pid }) => pid), [201, 202]);
    } finally { h.close(); }
  });

  it('observations of B then A and no switch rows ⇒ a process started between them renews A only once A is observed', async () => {
    const between = process(301, 5_000);
    const h = harness(async () => [between]);
    try {
      observe(h, B, NOW);
      assert.deepEqual(await activeCodexRenewers(h.deps, A), []);
      observe(h, A, NOW + 10_000);
      assert.deepEqual((await activeCodexRenewers(h.deps, A)).map(({ pid }) => pid), [301]);
    } finally { h.close(); }
  });

  it('activeCodexRenewers returns exactly the processes of the active identity’s eras (A→B→A→C fixture)', async () => {
    const processes = [process(401, -5_000), process(402, 5_000), process(403, 15_000), process(404, 25_000)];
    const h = harness(async () => processes);
    try {
      switchRow(h, A, B, NOW);
      switchRow(h, B, A, NOW + 10_000);
      switchRow(h, A, C, NOW + 20_000);
      assert.deepEqual((await activeCodexRenewers(h.deps, A)).map(({ pid }) => pid), [401, 403]);
    } finally { h.close(); }
  });

  it('a process started within ±1 s of a published_at renews both sides', async () => {
    const atBoundary = process(501, 0);
    const h = harness(async () => [atBoundary]);
    try {
      switchRow(h, A, B, NOW);
      assert.deepEqual((await activeCodexRenewers(h.deps, A)).map(({ pid }) => pid), [501]);
      assert.deepEqual((await activeCodexRenewers(h.deps, B)).map(({ pid }) => pid), [501]);
    } finally { h.close(); }
  });

  it('a holder of the old identity only counts as no renewer', async () => {
    const old = process(601, -5_000);
    const h = harness(async () => [old]);
    try {
      switchRow(h, A, B, NOW);
      assert.deepEqual(await activeCodexRenewers(h.deps, B), []);
    } finally { h.close(); }
  });

  it('a list() throw surfaces as CodexProcessCheckFailed from activeCodexRenewers, from holdersFor and from listOrFail', async () => {
    const failure = new Error('fixture process listing unavailable');
    const h = harness(async () => { throw failure; });
    try {
      await assert.rejects(activeCodexRenewers(h.deps, A), CodexProcessCheckFailed);
      await assert.rejects(holdersFor(h.deps, A)(document(NOW + 60_000)), CodexProcessCheckFailed);
      await assert.rejects(listOrFail(h.deps.list)(), CodexProcessCheckFailed);
    } finally { h.close(); }
  });

  it('accessFingerprint changes when only the access token changes and is value-free', () => {
    const first = accessFingerprint(document(NOW + 60_000, 'fixture-access-one'));
    const second = accessFingerprint(document(NOW + 60_000, 'fixture-access-two'));
    assert.match(first, /^sha256-at:[a-f0-9]{64}$/);
    assert.notEqual(first, second);
    assert.equal(first.includes('fixture-access-one'), false);
    assert.equal(second.includes('fixture-access-two'), false);
  });

  it('active-login-unset and a missing slot are refused before any read', async () => {
    const unset = activeHarness();
    const missing = activeHarness();
    try {
      unset.store.setActiveLogin('openai-codex', null, 'import', NOW);
      unset.deps.readLive = async () => { throw new Error('must not read'); };
      assert.deepEqual(await reconcileActiveCodexLive(unset.deps), { status: 'refused', reason: 'active-login-unset' });

      missing.store.setActiveLogin('openai-codex', 'missing:slot', 'import', NOW);
      missing.deps.readLive = async () => { throw new Error('must not read'); };
      assert.deepEqual(await reconcileActiveCodexLive(missing.deps), { status: 'refused', reason: 'active-slot-missing' });
    } finally { unset.close(); missing.close(); }
  });

  it('reconcile mode with an equal lineage is noop and reads the file once', async () => {
    const h = activeHarness();
    try {
      let reads = 0;
      const readLive = h.deps.readLive;
      h.deps.readLive = async () => { reads += 1; return readLive(); };
      const result = await reconcileActiveCodexLive(h.deps);
      assert.equal(result.status, 'noop');
      assert.equal(reads, 1);
    } finally { h.close(); }
  });

  it('slot newer than live ⇒ publish without POST (republished)', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'republished', document: a1 });
      const live = await readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      assert.equal(live.status, 'ok');
      if (live.status === 'ok') assert.equal(codexFingerprint(live.doc), codexFingerprint(a1));
    } finally { h.close(); }
  });

  it('a renewer at step 1 still reconciles under the locks and returns held with its pids and the live document, 0 POSTs', async () => {
    const h = activeHarness();
    try {
      h.deps.list = async () => [process(701, -30_000)];
      const result = await reconcileActiveCodexLive(h.deps);
      assert.deepEqual(result, { status: 'held', pids: [701], document: h.a0, action: 'noop' });
    } finally { h.close(); }
  });

  it('drift to a known slot stops with 0 POSTs and moves active_login', async () => {
    const h = activeHarness();
    try {
      const b0 = { ...document(NOW + 60_000, 'fixture-access-b0'), tokens: {
        ...document(NOW + 60_000, 'fixture-access-b0').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-b', chatgpt_account_id: 'account-b' } }),
        account_id: 'account-b',
      } };
      importActiveCodexSlot(b0, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      h.store.setActiveLogin('openai-codex', A, 'import', NOW + 2);
      writeFileSync(h.authPath, JSON.stringify(b0));
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'drift', accountId: B });
      assert.equal(h.store.getCodexActiveLogin(), B);
    } finally { h.close(); }
  });

  it('an unknown document after a settled republish is stashed, clears ownership, and is refused', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      const c0 = { ...document(NOW + 60_000, 'fixture-access-c0'), tokens: {
        ...document(NOW + 60_000, 'fixture-access-c0').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-c', chatgpt_account_id: 'account-c' } }),
        account_id: 'account-c',
      } };
      let stashed: CodexAuthDocument | undefined;
      h.deps.slots = { ...h.deps.slots, ensureUnclaimedStash: async (doc: CodexAuthDocument) => {
        stashed = doc;
        return { stashId: 'fixture-stash', created: true };
      } } as never;
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      let reads = 0;
      const readLive = h.deps.readLive;
      h.deps.readLive = async () => {
        reads += 1;
        if (reads === 3) return { status: 'ok' as const, doc: c0, sha256: 'sha256:newer-file', inode: 999 };
        return readLive();
      };
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'refused', reason: 'unknown-live-identity' });
      assert.deepEqual(stashed, c0);
      assert.equal(h.store.getCodexActiveLogin(), null);
    } finally { h.close(); }
  });

  it('a fenced active account returns fenced with the fence message under the switch lock', async () => {
    const h = activeHarness();
    try {
      h.store.setConfig('codex.recoveryFence', JSON.stringify({
        v: 1, switchId: 1, attempt: 'fixture-fence', from: B, to: C, publishedAt: NOW,
        reason: 'target-changed', involvedAccounts: [B, C], since: NOW,
      }));
      const result = await reconcileActiveCodexLive(h.deps);
      assert.equal(result.status, 'fenced');
      if (result.status !== 'fenced') return;
      assert.equal(result.reason, 'target-changed');
      assert.match(result.message, /target-changed/);
      assert.deepEqual([...result.accounts], [B, C]);
    } finally { h.close(); }
  });

  it('slot newer than live with a renewer ⇒ held{action: republish-slot}, file republished, 0 POSTs', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      h.deps.list = async () => [process(702, -30_000)];
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), {
        status: 'held', pids: [702], document: a1, action: 'republish-slot',
      });
      const live = await readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      assert.equal(live.status, 'ok');
      if (live.status === 'ok') assert.equal(codexFingerprint(live.doc), codexFingerprint(a1));
    } finally { h.close(); }
  });

  it('a drift whose slot was republished stops with drift{republish} and 0 POSTs, never consuming A', async () => {
    const h = activeHarness();
    try {
      const b0 = { ...document(NOW + 60_000, 'fixture-access-b0'), tokens: {
        ...document(NOW + 60_000, 'fixture-access-b0').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-b', chatgpt_account_id: 'account-b' } }),
        account_id: 'account-b', refresh_token: 'fixture-refresh-b0',
      } };
      const b1 = { ...b0, tokens: { ...b0.tokens, refresh_token: 'fixture-refresh-b1' } };
      importActiveCodexSlot(b0, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      importActiveCodexSlot(b1, { store: h.store, keychain: h.keychain, now: () => NOW + 2 });
      h.store.setActiveLogin('openai-codex', A, 'import', NOW + 3);
      writeFileSync(h.authPath, JSON.stringify(b0));
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'drift', accountId: B, republish: 'ok' });
    } finally { h.close(); }
  });

  it('an unknown document after a drift-republish is stashed and cannot report the old drift', async () => {
    const h = activeHarness();
    try {
      const b0 = { ...document(NOW + 60_000, 'fixture-access-b0'), tokens: {
        ...document(NOW + 60_000, 'fixture-access-b0').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-b', chatgpt_account_id: 'account-b' } }),
        account_id: 'account-b', refresh_token: 'fixture-refresh-b0',
      } };
      const b1 = { ...b0, tokens: { ...b0.tokens, refresh_token: 'fixture-refresh-b1' } };
      const c0 = { ...document(NOW + 60_000, 'fixture-access-c0'), tokens: {
        ...document(NOW + 60_000, 'fixture-access-c0').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-c', chatgpt_account_id: 'account-c' } }),
        account_id: 'account-c', refresh_token: 'fixture-refresh-c0',
      } };
      let stashed: CodexAuthDocument | undefined;
      h.deps.slots = { ...h.deps.slots, ensureUnclaimedStash: async (doc: CodexAuthDocument) => {
        stashed = doc;
        return { stashId: 'fixture-stash', created: true };
      } } as never;
      importActiveCodexSlot(b0, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      importActiveCodexSlot(b1, { store: h.store, keychain: h.keychain, now: () => NOW + 2 });
      h.store.setActiveLogin('openai-codex', A, 'import', NOW + 3);
      writeFileSync(h.authPath, JSON.stringify(b0));
      let reads = 0;
      const readLive = h.deps.readLive;
      h.deps.readLive = async () => {
        reads += 1;
        return reads === 3
          ? { status: 'ok' as const, doc: c0, sha256: codexAuthFileSha256(codexAuthFileText(c0)), inode: 99 }
          : readLive();
      };
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'refused', reason: 'unknown-live-identity' });
      assert.deepEqual(stashed, c0);
      assert.equal(h.store.getCodexActiveLogin(), null);
    } finally { h.close(); }
  });

  it('a restarted observe that lands on another slot stops with drift and 0 POSTs', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      const b0 = { ...document(NOW + 60_000, 'fixture-access-b0'), tokens: {
        ...document(NOW + 60_000, 'fixture-access-b0').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-b', chatgpt_account_id: 'account-b' } }), account_id: 'account-b',
      } };
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      importActiveCodexSlot(b0, { store: h.store, keychain: h.keychain, now: () => NOW + 2 });
      h.store.setActiveLogin('openai-codex', A, 'import', NOW + 3);
      let reads = 0;
      const readLive = h.deps.readLive;
      h.deps.readLive = async () => {
        reads += 1;
        return reads === 2 || reads === 3 ? { status: 'ok' as const, doc: b0, sha256: codexAuthFileSha256(codexAuthFileText(b0)), inode: 99 } : readLive();
      };
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'drift', accountId: B });
      assert.equal(reads, 3);
    } finally { h.close(); }
  });

  it('an unknown live identity is stashed and refused', async () => {
    const h = activeHarness();
    try {
      const c0 = { ...document(NOW + 60_000, 'fixture-access-c0'), tokens: {
        ...document(NOW + 60_000, 'fixture-access-c0').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-c', chatgpt_account_id: 'account-c' } }), account_id: 'account-c',
      } };
      let stashed = false;
      h.deps.slots = { ...h.deps.slots, ensureUnclaimedStash: async () => { stashed = true; return { stashId: 'fixture-stash', created: true }; } } as never;
      writeFileSync(h.authPath, JSON.stringify(c0));
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'refused', reason: 'unknown-live-identity' });
      assert.equal(stashed, true);
      assert.equal(h.store.getCodexActiveLogin(), null);
    } finally { h.close(); }
  });

  it('a wiped file is refused with an observation by qlb-active', async () => {
    const h = activeHarness();
    try {
      writeFileSync(h.authPath, JSON.stringify({ tokens: {} }));
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'refused', reason: 'wiped' });
      const history = readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir });
      assert.deepEqual(history.observations.at(-1), { identity: null, lineageFp: null, by: 'qlb-active', ts: NOW });
    } finally { h.close(); }
  });

  it('an unstable file defers codex-writing', async () => {
    const h = activeHarness();
    try {
      h.deps.readLive = async () => ({ status: 'unstable' });
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'deferred', reason: 'codex-writing' });
    } finally { h.close(); }
  });

  it('a file change during the republish re-read restarts the observe; six changes defer codex-writing', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      const changed = { ...document(NOW + 60_000, 'fixture-access-changed'), tokens: {
        ...document(NOW + 60_000, 'fixture-access-changed').tokens, refresh_token: 'fixture-refresh-changed',
      } };
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      let reads = 0;
      h.deps.readLive = async () => {
        reads += 1;
        const doc = reads % 2 === 0 ? changed : h.a0;
        return { status: 'ok', doc, sha256: codexAuthFileSha256(codexAuthFileText(doc)), inode: reads };
      };
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'deferred', reason: 'codex-writing' });
      assert.equal(reads, 12);
    } finally { h.close(); }
  });

  it('lock order is consume → switch → auth (lock spy) and lockTimeoutMs reaches all three', async () => {
    const h = activeHarness();
    try {
      delete (h.deps as Partial<CodexActiveDeps>).withLocks;
      h.deps.lockTimeoutMs = 80;
      h.deps.authLockOptions = { home: h.root, timeoutMs: 40, retryMinMs: 1, retryJitterMs: 0 };
      const locks = { ...codexLockPaths(h.store.dbPath, A), auth: codexAuthLockDir(h.deps.authLockOptions) };
      const acquired: string[] = [];
      const fsSpy = require('node:fs/promises') as { mkdir: (...args: any[]) => Promise<unknown> };
      const mkdir = fsSpy.mkdir;
      fsSpy.mkdir = async (...args) => {
        const result = await mkdir(...args);
        if (args[0] === locks.consume) acquired.push('consume');
        if (args[0] === locks.switch) acquired.push('switch');
        if (args[0] === locks.auth) acquired.push('auth');
        return result;
      };
      try {
        assert.equal((await reconcileActiveCodexLive(h.deps)).status, 'noop');
      } finally {
        fsSpy.mkdir = mkdir;
      }
      assert.deepEqual(acquired, ['consume', 'switch', 'auth']);

      const assertContendedTimeout = async (lock: string, expectedMs: number) => {
        mkdirSync(lock, { recursive: true });
        const originalMkdir = fsSpy.mkdir;
        const originalNow = performance.now;
        let attempts = 0;
        let clock = 0;
        fsSpy.mkdir = async (...args) => {
          if (args[0] === lock) {
            attempts += 1;
            // A correct timeout gets one retry (expectedMs - 1, then expectedMs + 1).
            // A smaller timeout fails on the first attempt; an omitted timeout reaches
            // the third clock value, which is beyond the 10 s default.
            clock = [expectedMs - 1, expectedMs + 1, 10_001][Math.min(attempts - 1, 2)];
          }
          return originalMkdir(...args);
        };
        performance.now = () => clock;
        try {
          assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'deferred', reason: 'locks-held' });
        } finally {
          performance.now = originalNow;
          fsSpy.mkdir = originalMkdir;
          rmSync(lock, { recursive: true, force: true });
        }
        assert.equal(attempts, 2, `${lock} did not receive timeoutMs=${expectedMs}`);
      };
      await assertContendedTimeout(locks.consume, 80);
      await assertContendedTimeout(locks.switch, 80);
      await assertContendedTimeout(locks.auth, 80);
      h.deps.lockTimeoutMs = undefined;
      await assertContendedTimeout(locks.auth, 40);
    } finally { h.close(); }
  });

  it('a process-list failure while attributing a settled external document is refused', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      const rewrite = { ...a1, last_refresh: '2026-10-31T12:00:00.000Z' };
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      let reads = 0;
      const readLive = h.deps.readLive;
      h.deps.readLive = async () => ++reads === 3
        ? { status: 'ok' as const, doc: rewrite, sha256: codexAuthFileSha256(codexAuthFileText(rewrite)), inode: 999 }
        : readLive();
      let lists = 0;
      h.deps.list = async () => {
        if (++lists === 5) throw new Error('fixture process listing unavailable');
        return [];
      };
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'refused', reason: 'codex-process-check-failed' });
      assert.equal(lists, 5);
    } finally { h.close(); }
  });

  it('an unverifiable stash after a settled external document is refused without clearing ownership', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      const c0 = { ...document(NOW + 60_000, 'fixture-access-c0'), tokens: {
        ...document(NOW + 60_000, 'fixture-access-c0').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-c', chatgpt_account_id: 'account-c' } }), account_id: 'account-c',
      } };
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      h.deps.slots = { ...h.deps.slots, ensureUnclaimedStash: async () => { throw new CodexStashUnverifiable(); } } as never;
      let reads = 0;
      const readLive = h.deps.readLive;
      h.deps.readLive = async () => ++reads === 3
        ? { status: 'ok' as const, doc: c0, sha256: codexAuthFileSha256(codexAuthFileText(c0)), inode: 999 }
        : readLive();
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'refused', reason: 'stash-unverifiable' });
      assert.equal(h.store.getCodexActiveLogin(), A);
    } finally { h.close(); }
  });

  it('a same-account rewrite retaining refresh_token but changing other auth bytes is external and records its post-publish observation', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      const rewrite = { ...a1, last_refresh: '2026-10-31T12:00:00.000Z' };
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      let reads = 0;
      const readLive = h.deps.readLive;
      h.deps.readLive = async () => {
        reads += 1;
        return reads === 3
          ? { status: 'ok' as const, doc: rewrite, sha256: codexAuthFileSha256(codexAuthFileText(rewrite)), inode: 999 }
          : readLive();
      };
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), {
        status: 'posted-live-external', document: a1, action: 'noop', cause: 'republish',
      });
      const history = readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir });
      assert.equal(history.observations.at(-1)?.lineageFp, codexFingerprint(rewrite));
      assert.equal(history.observations.at(-1)?.by, 'qlb-active');
    } finally { h.close(); }
  });

  it('a holder-backed Codex rotation after republish is not recorded as an external login', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      const a2 = { ...document(NOW + 120_000, 'fixture-access-a2'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a2').tokens, refresh_token: 'fixture-refresh-a2',
      } };
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      h.deps.list = async () => [process(703, -30_000)];
      let reads = 0;
      const readLive = h.deps.readLive;
      h.deps.readLive = async () => {
        reads += 1;
        return reads === 3
          ? { status: 'ok' as const, doc: a2, sha256: codexAuthFileSha256(codexAuthFileText(a2)), inode: 999 }
          : readLive();
      };
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), {
        status: 'posted-live-external', document: a1, action: 'adopt', cause: 'republish',
      });
      const db = new DatabaseSync(h.store.dbPath);
      try {
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM relogin_events WHERE kind = 'external-login'").get() as { count: number }).count, 0);
      } finally { db.close(); }
    } finally { h.close(); }
  });

  it('a wiped post-publish read records a qlb-active observation and an observation write failure is transient', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      let reads = 0;
      const readLive = h.deps.readLive;
      h.deps.readLive = async () => ++reads === 3
        ? { status: 'wiped' as const, error: { ok: false as const, error: 'tokens-empty' as const, status: 'wiped' as const } }
        : readLive();
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), {
        status: 'posted-live-unverified', document: a1, read: 'wiped', cause: 'republish',
      });
      assert.equal(readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.at(-1)?.identity, null);
    } finally { h.close(); }
  });

  it('an observation write failure during the observe read is transient', async () => {
    const h = activeHarness();
    try {
      h.store.recordCodexObservation = () => { throw new Error('fixture observation write failure'); };
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'transient', reason: 'observation-write-failed' });
    } finally { h.close(); }
  });

  it('an observation write failure after a settled republish is transient', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW + 120_000, 'fixture-access-a1'), tokens: {
        ...document(NOW + 120_000, 'fixture-access-a1').tokens, refresh_token: 'fixture-refresh-a1',
      } };
      importActiveCodexSlot(a1, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      const record = h.store.recordCodexObservation.bind(h.store);
      let writes = 0;
      h.store.recordCodexObservation = (input) => {
        writes += 1;
        if (writes === 2) throw new Error('fixture observation write failure');
        return record(input);
      };
      assert.deepEqual(await reconcileActiveCodexLive(h.deps), { status: 'transient', reason: 'observation-write-failed' });
    } finally { h.close(); }
  });

  it('non-observation errors from observeLiveCodex propagate', async () => {
    const h = activeHarness();
    try {
      h.deps.slots = { ...h.deps.slots, readSlot: () => { throw new Error('fixture slot read failure'); } } as never;
      await assert.rejects(reconcileActiveCodexLive(h.deps), /fixture slot read failure/);
    } finally { h.close(); }
  });

  it('expired, no renewer ⇒ one POST, slot written before the file (write-order spy), file published by rename and verified by identity', async () => {
    const h = activeHarness();
    try {
      const order: string[] = [];
      const writeSlot = (h.deps.slots as any).writeSlot;
      (h.deps.slots as any).writeSlot = (...args: any[]) => { order.push('slot'); return writeSlot(...args); };
      h.deps.transport = async () => ({ status: 200, body: JSON.stringify({
        refresh_token: 'fixture-refresh-successor', access_token: document(NOW + 600_000, 'fixture-access-successor').tokens.access_token,
      }) });
      h.deps.hooks = { afterRename: () => { order.push('rename'); } };
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.equal(outcome.status, 'posted');
      assert.deepEqual(order, ['slot', 'rename']);
      const live = await readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      assert.equal(live.status, 'ok');
      if (live.status === 'ok') assert.equal(codexFingerprint(live.doc), codexFingerprint((h.deps.slots as any).readSlot(A).document));
    } finally { h.close(); }
  });

  it('afterPost failure after a 2xx preserves the refreshed successor and logs the hook failure', async () => {
    const h = activeHarness();
    try {
      const logs: string[] = [];
      h.deps.autoLog = (line) => logs.push(line);
      h.deps.hooks = { afterPost: () => { throw new Error('fixture afterPost failure'); } };
      h.deps.transport = async () => ({ status: 200, body: JSON.stringify({
        refresh_token: 'fixture-refresh-after-post-failure', access_token: document(NOW + 600_000, 'fixture-access-after-post-failure').tokens.access_token,
      }) });
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.equal(outcome.status, 'posted');
      if (outcome.status === 'posted') {
        assert.equal(codexFingerprint((h.deps.slots as any).readSlot(A).document), codexFingerprint(outcome.document));
      }
      assert.ok(logs.includes(`codex:after-post-hook-failed provider=openai-codex at=${NOW}`));
    } finally { h.close(); }
  });

  it('a posted outcome records a qlb-active observation of the successor', async () => {
    const h = activeHarness();
    try {
      h.deps.transport = async () => ({ status: 200, body: JSON.stringify({
        refresh_token: 'fixture-refresh-observed', access_token: document(NOW + 600_000, 'fixture-access-observed').tokens.access_token,
      }) });
      assert.equal((await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' })).status, 'posted');
      const observation = readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.at(-1);
      assert.equal(observation?.by, 'qlb-active');
      assert.equal(observation?.lineageFp, codexFingerprint((h.deps.slots as any).readSlot(A).document));
    } finally { h.close(); }
  });

  it('expired live a1 unknown to the graph ⇒ adopt then exactly one POST', async () => {
    const h = activeHarness();
    try {
      const a1 = { ...document(NOW - 1_000, 'fixture-access-adopt'), tokens: { ...document(NOW - 1_000, 'fixture-access-adopt').tokens, refresh_token: 'fixture-refresh-adopt' } };
      writeFileSync(h.authPath, JSON.stringify(a1));
      let posts = 0;
      h.deps.transport = async () => { posts += 1; return { status: 200, body: JSON.stringify({
        refresh_token: 'fixture-refresh-adopted-successor', access_token: document(NOW + 600_000, 'fixture-access-adopted-successor').tokens.access_token,
      }) }; };
      assert.equal((await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' })).status, 'posted');
      assert.equal(posts, 1);
    } finally { h.close(); }
  });

  it('a superseded consume is reported and publishes nothing', async () => {
    const h = activeHarness();
    try {
      let posts = 0;
      h.deps.transport = async () => {
        posts += 1;
        const db = new DatabaseSync(h.store.dbPath);
        try { db.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?').run('sha256:fixture-racer', A); } finally { db.close(); }
        return { status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) };
      };
      const before = readFileSync(h.authPath, 'utf8');
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.equal(outcome.status, 'superseded');
      assert.equal(posts, 1);
      assert.equal(readFileSync(h.authPath, 'utf8'), before);
    } finally { h.close(); }
  });

  it('the POST carries refresh_reason proactive_expiry and never forced', async () => {
    const h = activeHarness();
    try {
      let body = '';
      h.deps.transport = async (request) => { body = request.body ?? '';  return { status: 500, body: '{}' }; };
      assert.equal((await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' })).status, 'transient');
      assert.match(body, /"refresh_reason":"proactive_expiry"/);
      assert.doesNotMatch(body, /forced/);
    } finally { h.close(); }
  });

  it('the signal window is entered before transport is invoked and exited after the post-publish verify (spy order afterObserve < enter < beforeSend < transport < beforeVerify < exit), is never entered when no POST happens, and is exited on a transport throw', async () => {
    const h = activeHarness();
    try {
      const order: string[] = [];
      h.deps.signalWindow = { enter: () => order.push('enter'), exit: () => order.push('exit') };
      h.deps.hooks = { afterObserve: () => { order.push('afterObserve'); }, beforeSend: () => { order.push('beforeSend'); }, beforeVerify: () => { order.push('beforeVerify'); } };
      h.deps.transport = async () => { order.push('transport'); return { status: 200, body: JSON.stringify({ refresh_token: 'fixture-refresh-window', access_token: document(NOW + 600_000, 'fixture-access-window').tokens.access_token }) }; };
      assert.equal((await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' })).status, 'posted');
      assert.deepEqual(order, ['afterObserve', 'enter', 'beforeSend', 'transport', 'beforeVerify', 'exit']);
      const failing = activeHarness();
      try {
        const failureOrder: string[] = [];
        failing.deps.signalWindow = { enter: () => { failureOrder.push('enter'); }, exit: () => { failureOrder.push('exit'); } };
        failing.deps.hooks = { afterObserve: () => { failureOrder.push('afterObserve'); }, beforeSend: () => { failureOrder.push('beforeSend'); } };
        failing.deps.transport = async () => { failureOrder.push('transport'); throw new Error('fixture transport failure'); };
        assert.equal((await refreshActiveCodexLogin(failing.deps, { trigger: 'proactive-expiry' })).status, 'transient');
        assert.deepEqual(failureOrder, ['afterObserve', 'enter', 'beforeSend', 'transport', 'exit']);
      } finally { failing.close(); }
      order.length = 0;
      assert.equal((await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' })).status, 'noop');
      assert.equal(order.includes('enter'), false);
    } finally { h.close(); }
  });

  it('refresh_token_reused with a holder adopts the live lineage, dead=0, pending_adopt=0, no relogin row, codex:codex-won adopted=1', async () => {
    const h = activeHarness();
    try {
      const successor = { ...document(NOW + 600_000, 'fixture-codex-won'), tokens: { ...document(NOW + 600_000, 'fixture-codex-won').tokens, refresh_token: 'fixture-refresh-codex-won' } };
      h.store.recordCodexObservation({ identity: B, lineageFp: 'sha256:b', by: 'qlb-active', now: NOW - 60_000 });
      h.deps.list = async () => [];
      h.deps.transport = async () => { h.deps.list = async () => [process(900, 1_000)]; writeFileSync(h.authPath, JSON.stringify(successor)); return { status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) }; };
      const logs: string[] = [];
      h.deps.autoLog = (line) => logs.push(line);
      const result = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.deepEqual(result, { status: 'codex-won', adopted: true, pids: [900], document: successor });
      assert.equal(h.store.getCodexSlot(A)?.dead, false);
      assert.equal(h.store.getCodexSlot(A)?.pendingAdopt, false);
      const db = new DatabaseSync(h.store.dbPath);
      try {
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM relogin_events WHERE provider = 'openai-codex'").get() as { count: number }).count, 0);
        const lineage = db.prepare("SELECT cause, evidence FROM lineage_log WHERE provider = 'openai-codex' ORDER BY id DESC LIMIT 1").get() as { cause: string; evidence: string };
        assert.equal(lineage.cause, 'adopt');
        assert.equal(lineage.evidence, 'holder');
      } finally { db.close(); }
      assert.ok(logs.some((line) => line.startsWith('codex:codex-won provider=openai-codex account=user-a:account-a adopted=1 pids=900')));
    } finally { h.close(); }
  });

  it('codex-won without a saved successor leaves pending_adopt=1 for the watch and never renames', async () => {
    const h = activeHarness();
    try {
      h.store.recordCodexObservation({ identity: B, lineageFp: 'sha256:b', by: 'qlb-active', now: NOW - 60_000 });
      // The locked observe may set this during its ordinary B3 pass; the
      // post-reuse noop must leave it as-is.
      h.store.setActiveLogin('openai-codex', A, 'adopt', NOW - 1);
      h.deps.list = async () => [];
      h.deps.transport = async () => { h.deps.list = async () => [process(901, 1_000)]; return { status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) }; };
      const before = readFileSync(h.authPath, 'utf8');
      const db = new DatabaseSync(h.store.dbPath);
      try {
        const setBy = (db.prepare("SELECT set_by FROM active_login WHERE provider = 'openai-codex'").get() as { set_by: string }).set_by;
        const logs: string[] = [];
        h.deps.autoLog = (line) => logs.push(line);
        assert.deepEqual(await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' }), {
          status: 'codex-won', adopted: false, pids: [901], document: h.a0,
        });
        assert.equal(h.store.getCodexSlot(A)?.dead, false);
        assert.equal(h.store.getCodexSlot(A)?.pendingAdopt, true);
        assert.equal((db.prepare("SELECT set_by FROM active_login WHERE provider = 'openai-codex'").get() as { set_by: string }).set_by, setBy);
        assert.ok(logs.some((line) => line.startsWith('codex:codex-won provider=openai-codex account=user-a:account-a adopted=0 pids=901')));
      } finally { db.close(); }
      assert.equal(readFileSync(h.authPath, 'utf8'), before);
    } finally { h.close(); }
  });

  it('a codex-won re-read of an older lineage from another known slot returns the active document', async () => {
    const h = activeHarness();
    try {
      const b0 = { ...document(NOW + 600_000, 'fixture-access-codex-won-b0'), tokens: {
        ...document(NOW + 600_000, 'fixture-access-codex-won-b0').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-b', chatgpt_account_id: 'account-b' } }),
        account_id: 'account-b', refresh_token: 'fixture-refresh-codex-won-b0',
      } };
      const b1 = { ...b0, tokens: {
        ...b0.tokens, access_token: document(NOW + 600_000, 'fixture-access-codex-won-b1').tokens.access_token,
        refresh_token: 'fixture-refresh-codex-won-b1',
      } };
      importActiveCodexSlot(b0, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      (h.deps.slots as any).writeSlot(B, b1, b0);
      const db = new DatabaseSync(h.store.dbPath);
      try {
        db.prepare('UPDATE codex_slots SET fingerprint = ?, prev_fingerprint = ? WHERE account_id = ?')
          .run(codexFingerprint(b1), codexFingerprint(b0), B);
      } finally { db.close(); }
      h.store.setActiveLogin('openai-codex', A, 'import', NOW + 2);
      h.store.recordCodexObservation({ identity: B, lineageFp: codexFingerprint(b0), by: 'qlb-active', now: NOW - 60_000 });
      h.deps.list = async () => [];
      h.deps.transport = async () => {
        h.deps.list = async () => [process(902, 1_000)];
        writeFileSync(h.authPath, JSON.stringify(b0));
        return { status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) };
      };
      assert.deepEqual(await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' }), {
        status: 'codex-won', adopted: false, pids: [902], document: h.a0,
      });
    } finally { h.close(); }
  });

  it('a codex-won re-read showing another known slot is drift', async () => {
    const h = activeHarness();
    try {
      const b0 = { ...document(NOW + 600_000, 'fixture-access-codex-won-b'), tokens: {
        ...document(NOW + 600_000, 'fixture-access-codex-won-b').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-b', chatgpt_account_id: 'account-b' } }),
        account_id: 'account-b', refresh_token: 'fixture-refresh-codex-won-b',
      } };
      assert.equal(codexIdentity(b0), B);
      importActiveCodexSlot(b0, { store: h.store, keychain: h.keychain, now: () => NOW + 1 });
      h.store.setActiveLogin('openai-codex', A, 'import', NOW + 2);
      h.store.recordCodexObservation({ identity: B, lineageFp: codexFingerprint(b0), by: 'qlb-active', now: NOW - 60_000 });
      let posts = 0;
      h.deps.list = async () => [];
      h.deps.transport = async () => {
        posts += 1;
        h.deps.list = async () => [process(902, 1_000)];
        writeFileSync(h.authPath, JSON.stringify(b0));
        return { status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) };
      };
      assert.deepEqual(await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' }), { status: 'drift', accountId: B });
      assert.equal(posts, 1);
      assert.equal(h.store.getCodexActiveLogin(), B);
      assert.equal(codexFingerprint((await readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }) as any).doc), codexFingerprint(b0));
      assert.equal(readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.at(-1)?.by, 'qlb-active');
    } finally { h.close(); }
  });

  it('a codex-won re-read with an unclaimed identity is refused and clears ownership', async () => {
    const h = activeHarness();
    try {
      const unknown = { ...document(NOW + 600_000, 'fixture-access-codex-won-unknown'), tokens: {
        ...document(NOW + 600_000, 'fixture-access-codex-won-unknown').tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-c', chatgpt_account_id: 'account-c' } }),
        account_id: 'account-c', refresh_token: 'fixture-refresh-codex-won-unknown',
      } };
      h.store.recordCodexObservation({ identity: B, lineageFp: 'sha256:b', by: 'qlb-active', now: NOW - 60_000 });
      h.deps.list = async () => [];
      h.deps.transport = async () => {
        h.deps.list = async () => [process(903, 1_000)];
        writeFileSync(h.authPath, JSON.stringify(unknown));
        return { status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) };
      };
      assert.deepEqual(await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' }), { status: 'refused', reason: 'unknown-live-identity' });
      assert.equal(h.store.getCodexActiveLogin(), null);
    } finally { h.close(); }
  });

  it('a codex-won wiped re-read is refused', async () => {
    const h = activeHarness();
    try {
      const readLive = h.deps.readLive;
      let reads = 0;
      h.deps.readLive = async () => ++reads === 2
        ? { status: 'wiped' as const, error: { ok: false as const, error: 'tokens-empty' as const, status: 'wiped' as const } }
        : readLive();
      h.store.recordCodexObservation({ identity: B, lineageFp: 'sha256:b', by: 'qlb-active', now: NOW - 60_000 });
      h.deps.list = async () => [];
      h.deps.transport = async () => {
        h.deps.list = async () => [process(904, 1_000)];
        return { status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) };
      };
      assert.deepEqual(await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' }), { status: 'refused', reason: 'wiped' });
    } finally { h.close(); }
  });

  it('a codex-won slot split is refused', async () => {
    const h = activeHarness();
    try {
      const successor = { ...document(NOW + 600_000, 'fixture-access-codex-won-split'), tokens: { ...document(NOW + 600_000, 'fixture-access-codex-won-split').tokens, refresh_token: 'fixture-refresh-codex-won-split' } };
      h.store.recordCodexObservation({ identity: B, lineageFp: 'sha256:b', by: 'qlb-active', now: NOW - 60_000 });
      h.deps.list = async () => [];
      h.deps.transport = async () => {
        h.deps.list = async () => [process(905, 1_000)];
        const slots = h.deps.slots;
        h.deps.slots = { ...slots, readSlot: () => ({ document: successor, fingerprint: codexFingerprint(successor) }) } as never;
        writeFileSync(h.authPath, JSON.stringify(successor));
        return { status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) };
      };
      assert.deepEqual(await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' }), { status: 'refused', reason: 'slot-split' });
    } finally { h.close(); }
  });

  it('a post-publish observation write failure is transient rather than a rejected promise', async () => {
    const h = activeHarness();
    try {
      const record = h.store.recordCodexObservation.bind(h.store);
      let writes = 0;
      h.store.recordCodexObservation = (input) => {
        writes += 1;
        if (writes === 2) throw new Error('fixture post observation write failure');
        return record(input);
      };
      h.deps.transport = async () => ({ status: 200, body: JSON.stringify({
        refresh_token: 'fixture-refresh-observation-failure', access_token: document(NOW + 600_000, 'fixture-access-observation-failure').tokens.access_token,
      }) });
      assert.deepEqual(await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' }), { status: 'transient', reason: 'observation-write-failed' });
    } finally { h.close(); }
  });

  it('refresh_token_reused without a holder marks dead with a relogin row', async () => {
    const h = activeHarness();
    try {
      h.deps.transport = async () => ({ status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) });
      assert.equal((await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' })).status, 'dead');
      assert.equal(h.store.getCodexSlot(A)?.dead, true);
      const db = new DatabaseSync(h.store.dbPath);
      try {
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM relogin_events WHERE provider = 'openai-codex' AND kind = 'dead'").get() as { count: number }).count, 1);
      } finally { db.close(); }
    } finally { h.close(); }
  });

  it('a fresh consume republishes the slot document without a POST', async () => {
    const h = activeHarness();
    try {
      const fresh = document(NOW + 600_000, 'fixture-access-fresh-consume');
      let posts = 0;
      h.deps.hooks = { afterObserve: () => (h.deps.slots as any).writeSlot(A, fresh, h.a0) };
      h.deps.transport = async () => { posts += 1; throw new Error('transport must not run'); };
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.deepEqual(outcome, { status: 'republished', document: fresh });
      assert.equal(posts, 0);
      assert.equal(codexFingerprint((h.deps.slots as any).readSlot(A).document), codexFingerprint(fresh));
      const live = await readCodexAuthStableWithStat(h.authPath, { delayMs: 0 });
      assert.equal(live.status, 'ok');
      if (live.status === 'ok') assert.equal(codexFingerprint(live.doc), codexFingerprint(fresh));
      assert.equal(readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.at(-1)?.by, 'qlb-active');
    } finally { h.close(); }
  });

  it('a write landing before the rename is never overwritten (beforeRename barrier, posted-live-external)', async () => {
    const h = activeHarness();
    try {
      const external = { ...document(NOW + 600_000, 'fixture-access-before-rename'), tokens: {
        ...document(NOW + 600_000, 'fixture-access-before-rename').tokens, refresh_token: 'fixture-refresh-before-rename',
      } };
      let posts = 0;
      h.deps.transport = async () => { posts += 1; return { status: 200, body: JSON.stringify({
        refresh_token: 'fixture-refresh-issued-before-rename', access_token: document(NOW + 600_000, 'fixture-access-issued-before-rename').tokens.access_token,
      }) }; };
      h.deps.hooks = { beforeRename: () => writeFileSync(h.authPath, JSON.stringify(external)) };
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.equal(outcome.status, 'posted-live-external');
      if (outcome.status === 'posted-live-external') assert.equal(outcome.cause, 'post');
      assert.equal(posts, 1);
      assert.equal(readFileSync(h.authPath, 'utf8'), JSON.stringify(external));
      assert.equal(codexFingerprint((h.deps.slots as any).readSlot(A).document), codexFingerprint(external));
      assert.equal(readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.at(-1)?.by, 'qlb-active');
    } finally { h.close(); }
  });

  it('a fresh republish re-reads before the rename and stops on a changed file', async () => {
    const h = activeHarness();
    try {
      const fresh = document(NOW + 600_000, 'fixture-access-fresh-race');
      const external = { ...document(NOW + 600_000, 'fixture-access-fresh-external'), tokens: {
        ...document(NOW + 600_000, 'fixture-access-fresh-external').tokens, refresh_token: 'fixture-refresh-fresh-external',
      } };
      let posts = 0;
      h.deps.hooks = {
        afterObserve: () => (h.deps.slots as any).writeSlot(A, fresh, h.a0),
        beforeRename: () => writeFileSync(h.authPath, JSON.stringify(external)),
      };
      h.deps.transport = async () => { posts += 1; throw new Error('fresh must not POST'); };
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.equal(outcome.status, 'posted-live-external');
      if (outcome.status === 'posted-live-external') assert.equal(outcome.cause, 'republish');
      assert.equal(posts, 0);
      assert.equal(readFileSync(h.authPath, 'utf8'), JSON.stringify(external));
      assert.equal(codexFingerprint((h.deps.slots as any).readSlot(A).document), codexFingerprint(external));
      assert.equal(readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.at(-1)?.by, 'qlb-active');
    } finally { h.close(); }
  });

  it('a rename failure after 2xx keeps the successor in the slot, logs codex:live-write-failed, and the next pass republishes it', async () => {
    const h = activeHarness();
    try {
      const successor = document(NOW + 600_000, 'fixture-access-rename-retry');
      const logs: string[] = [];
      const originalPath = h.deps.authPath;
      const blockedPath = join(h.root, 'blocked-auth.json');
      mkdirSync(blockedPath);
      let posts = 0;
      h.deps.autoLog = (line) => logs.push(line);
      h.deps.authPath = blockedPath;
      h.deps.transport = async () => { posts += 1; return { status: 200, body: JSON.stringify({
        refresh_token: successor.tokens.refresh_token, access_token: successor.tokens.access_token,
      }) }; };
      const failed = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.equal(failed.status, 'posted-live-unwritten');
      if (failed.status === 'posted-live-unwritten') assert.equal(failed.cause, 'post');
      assert.equal(posts, 1);
      assert.equal(codexFingerprint((h.deps.slots as any).readSlot(A).document), codexFingerprint(successor));
      assert.ok(logs.some((line) => line.startsWith('codex:live-write-failed provider=openai-codex account=user-a:account-a cause=post')));
      h.deps.authPath = originalPath;
      const restored = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.equal(restored.status, 'republished');
      assert.equal(posts, 1);
      assert.equal(codexFingerprint((await readCodexAuthStableWithStat(originalPath, { delayMs: 0 }) as any).doc), codexFingerprint(successor));
      assert.equal(readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.at(-1)?.by, 'qlb-active');
    } finally { h.close(); }
  });

  it('an external write after the rename is never overwritten (posted-live-external)', async () => {
    const h = activeHarness();
    try {
      const external = { ...document(NOW + 600_000, 'fixture-access-after-rename'), tokens: {
        ...document(NOW + 600_000, 'fixture-access-after-rename').tokens, refresh_token: 'fixture-refresh-after-rename',
      } };
      let posts = 0;
      h.deps.transport = async () => { posts += 1; return { status: 200, body: JSON.stringify({
        refresh_token: 'fixture-refresh-issued-after-rename', access_token: document(NOW + 600_000, 'fixture-access-issued-after-rename').tokens.access_token,
      }) }; };
      h.deps.hooks = { afterRename: () => writeFileSync(h.authPath, JSON.stringify(external)) };
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.equal(outcome.status, 'posted-live-external');
      if (outcome.status === 'posted-live-external') assert.equal(outcome.cause, 'post');
      assert.equal(posts, 1);
      assert.equal(readFileSync(h.authPath, 'utf8'), JSON.stringify(external));
      assert.equal(codexFingerprint((h.deps.slots as any).readSlot(A).document), codexFingerprint(external));
      assert.equal(readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.at(-1)?.by, 'qlb-active');
    } finally { h.close(); }
  });

  it('an unstable or wiped file after the rename returns posted-live-unverified without throwing', async () => {
    for (const read of ['unstable', 'wiped'] as const) {
      const h = activeHarness();
      try {
        const successor = document(NOW + 600_000, `fixture-access-${read}-verify`);
        let posts = 0;
        const realRead = h.deps.readLive;
        let reads = 0;
        h.deps.readLive = async () => {
          reads += 1;
          if (reads === 3) return read === 'unstable'
            ? { status: 'unstable' as const }
            : { status: 'wiped' as const, error: { ok: false as const, error: 'tokens-empty' as const, status: 'wiped' as const } };
          return realRead();
        };
        h.deps.transport = async () => { posts += 1; return { status: 200, body: JSON.stringify({
          refresh_token: successor.tokens.refresh_token, access_token: successor.tokens.access_token,
        }) }; };
        const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
        assert.equal(outcome.status, 'posted-live-unverified');
        if (outcome.status === 'posted-live-unverified') {
          assert.equal(outcome.read, read);
          assert.equal(outcome.cause, 'post');
        }
        assert.equal(posts, 1);
        assert.equal(codexFingerprint((h.deps.slots as any).readSlot(A).document), codexFingerprint(successor));
        const observation = readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.at(-1);
        assert.equal(observation?.by, 'qlb-active');
        if (read === 'wiped') assert.equal(observation?.identity, null);
      } finally { h.close(); }
    }
  });

  it('lock contention defers locks-held with 0 POSTs', async () => {
    const h = activeHarness();
    try {
      let posts = 0;
      h.deps.transport = async () => { posts += 1; throw new Error('must not POST'); };
      h.deps.withLocks = async () => { throw new ClaudeCodeLockTimeout(join(h.root, 'fixture-lock')); };
      assert.deepEqual(await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' }), { status: 'deferred', reason: 'locks-held' });
      assert.equal(posts, 0);
      assert.equal(readFileSync(h.authPath, 'utf8'), JSON.stringify(h.a0));
      assert.equal(codexFingerprint((h.deps.slots as any).readSlot(A).document), codexFingerprint(h.a0));
      assert.equal(readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.length, 0);
    } finally { h.close(); }
  });

  it('a lock compromise after the POST surfaces the stash', async () => {
    const h = activeHarness();
    try {
      const successor = document(NOW + 600_000, 'fixture-access-lock-lost');
      let posts = 0;
      h.deps.withLocks = undefined;
      h.deps.authLockOptions = { home: h.root, touchIntervalMs: 60_000 };
      h.deps.transport = async () => {
        posts += 1;
        // Exercise the production consume → switch → auth wrappers: losing
        // the held auth lock after the 2xx makes them rethrow on finalization.
        rmSync(codexAuthLockDir({ home: h.root }), { recursive: true, force: true });
        return { status: 200, body: JSON.stringify({ refresh_token: successor.tokens.refresh_token, access_token: successor.tokens.access_token }) };
      };
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.equal(outcome.status, 'stashed');
      assert.equal(posts, 1);
      assert.notEqual(outcome.status === 'stashed' ? outcome.stashId : undefined, undefined);
      assert.equal(readFileSync(h.authPath, 'utf8'), JSON.stringify(h.a0));
      assert.equal(codexFingerprint((h.deps.slots as any).readSlot(A).document), codexFingerprint(h.a0));
      assert.equal(readCodexSwitchHistory(h.store.dbPath, { journalDir: h.deps.journalDir }).observations.at(-1)?.by, 'qlb-active');
    } finally { h.close(); }
  });

  it('no token value reaches autoLog, a thrown error or an outcome’s reason', async () => {
    const h = activeHarness();
    try {
      const raw = {
        access: 'raw-access-token-refresh-redaction', refresh: 'raw-refresh-token-refresh-redaction', id: h.a0.tokens.id_token,
      };
      const input = { ...h.a0, tokens: { ...h.a0.tokens, access_token: raw.access, refresh_token: raw.refresh, id_token: raw.id } };
      const logs: string[] = [];
      h.deps.autoLog = (line) => logs.push(line);
      writeFileSync(h.authPath, JSON.stringify(input));
      h.deps.authPath = join(h.root, 'blocked-redaction-auth.json');
      mkdirSync(h.deps.authPath);
      h.deps.transport = async () => ({ status: 200, body: JSON.stringify({ refresh_token: raw.refresh, access_token: raw.access }) });
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.equal(outcome.status, 'posted-live-unwritten');
      const render = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
      for (const secret of Object.values(raw)) {
        assert.equal(render({ status: outcome.status, ...('reason' in outcome ? { reason: outcome.reason } : {}) }).includes(secret), false);
        assert.equal(logs.join('\n').includes(secret), false);
      }
      await assert.rejects(listOrFail(async () => { throw new Error(raw.access); })(), (error: unknown) => {
        assert.ok(error instanceof CodexProcessCheckFailed);
        for (const secret of Object.values(raw)) assert.equal(error.message.includes(secret), false);
        return true;
      });
      assert.equal(codexFingerprint((h.deps.slots as any).readSlot(A).document).includes(raw.refresh), false);

      const thrown = activeHarness();
      try {
        writeFileSync(thrown.authPath, JSON.stringify(input));
        thrown.deps.list = async () => { throw new Error(raw.refresh); };
        const refused = await refreshActiveCodexLogin(thrown.deps, { trigger: 'proactive-expiry' });
        assert.deepEqual(refused, { status: 'refused', reason: 'codex-process-check-failed' });
        for (const secret of Object.values(raw)) assert.equal(render(refused).includes(secret), false);
      } finally { thrown.close(); }

      const unknown = { ...input, tokens: {
        ...input.tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-c', chatgpt_account_id: 'account-c' } }),
        account_id: 'account-c',
      } };
      const stashDir = join(h.root, 'redaction-stash');
      const stashKeychain = {
        getSync: h.keychain.getSync.bind(h.keychain),
        setSync: (service: string, account: string, value: string) => {
          if (service.includes(':unclaimed:')) throw new Error('fixture forces a file-backed stash');
          h.keychain.setSync(service, account, value);
        },
        deleteSync: h.keychain.deleteSync.bind(h.keychain),
      };
      const stashSlots = new CodexSlots({ keychain: stashKeychain, stashDir });
      const ensureUnclaimedStash = stashSlots.ensureUnclaimedStash.bind(stashSlots);
      let stashPath: string | undefined;
      stashSlots.ensureUnclaimedStash = async (doc, now) => {
        const result = await ensureUnclaimedStash(doc, now);
        stashPath = join(stashDir, `${result.stashId}.json`);
        return result;
      };
      h.deps.slots = stashSlots as never;
      writeFileSync(h.authPath, JSON.stringify(unknown));
      const stashed = await refreshActiveCodexLogin(h.deps, { trigger: 'proactive-expiry' });
      assert.deepEqual(stashed, { status: 'refused', reason: 'unknown-live-identity' });
      assert.ok(stashPath);
      assert.equal(existsSync(stashPath), true);
      for (const secret of [...Object.values(raw), unknown.tokens.id_token]) {
        assert.equal(render(stashed).includes(secret), false);
        assert.equal(stashPath.includes(secret), false);
      }
    } finally { h.close(); }
  });

  it('no token value reaches an outcome’s reason, the fence message pass-through, a stash path or a thrown error', async () => {
    const h = activeHarness();
    try {
      const tokenValues = [h.a0.tokens.access_token, h.a0.tokens.refresh_token, h.a0.tokens.id_token];
      const assertRedacted = (value: unknown) => {
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        for (const token of tokenValues) assert.equal(rendered.includes(token), false);
      };

      const unknown = { ...h.a0, tokens: {
        ...h.a0.tokens,
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-c', chatgpt_account_id: 'account-c' } }),
        account_id: 'account-c',
      } };
      tokenValues.push(unknown.tokens.id_token);
      const stashDir = join(h.root, 'stash');
      const stashKeychain = {
        getSync: h.keychain.getSync.bind(h.keychain),
        setSync: (service: string, account: string, value: string) => {
          if (service.includes(':unclaimed:')) throw new Error('fixture forces a file-backed stash');
          h.keychain.setSync(service, account, value);
        },
        deleteSync: h.keychain.deleteSync.bind(h.keychain),
      };
      const slots = new CodexSlots({ keychain: stashKeychain, stashDir });
      const ensureUnclaimedStash = slots.ensureUnclaimedStash.bind(slots);
      let stashPath: string | undefined;
      slots.ensureUnclaimedStash = async (doc, now) => {
        const result = await ensureUnclaimedStash(doc, now);
        stashPath = join(stashDir, `${result.stashId}.json`);
        return result;
      };
      h.deps.slots = slots as never;
      writeFileSync(h.authPath, JSON.stringify(unknown));
      const refused = await reconcileActiveCodexLive(h.deps);
      assert.deepEqual(refused, { status: 'refused', reason: 'unknown-live-identity' });
      assertRedacted(refused);
      assert.ok(stashPath);
      assert.equal(existsSync(stashPath), true);
      assertRedacted(stashPath);

      h.store.setActiveLogin('openai-codex', A, 'import', NOW);
      h.store.setConfig('codex.recoveryFence', JSON.stringify({
        v: 1, switchId: 1, attempt: 'fixture-fence', from: B, to: C, publishedAt: NOW,
        reason: 'target-changed', involvedAccounts: [B, C], since: NOW,
      }));
      const fenced = await reconcileActiveCodexLive(h.deps);
      assert.equal(fenced.status, 'fenced');
      assertRedacted(fenced);

      const transient = activeHarness();
      try {
        transient.store.recordCodexObservation = () => { throw new Error('fixture observation write failure'); };
        const outcome = await reconcileActiveCodexLive(transient.deps);
        assert.deepEqual(outcome, { status: 'transient', reason: 'observation-write-failed' });
        assertRedacted(outcome);
      } finally { transient.close(); }

      const throwing = activeHarness();
      try {
        await assert.rejects(listOrFail(async () => {
          throw new Error(throwing.a0.tokens.access_token);
        })(), (error: unknown) => {
          assert.ok(error instanceof CodexProcessCheckFailed);
          assertRedacted(error.message);
          return true;
        });
      } finally { throwing.close(); }
    } finally { h.close(); }
  });
});
