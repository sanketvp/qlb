import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  type CodexActiveDeps,
} from '../src/codex-active';
import { codexAuthFileSha256, codexAuthFileText, codexFingerprint, readCodexAuthStableWithStat, type CodexAuthDocument } from '../src/codex-auth';
import { importActiveCodexSlot } from '../src/codex-slots';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { readCodexSwitchHistory, type CodexProcess } from '../src/codex-sessions';
import { openStore } from '../src/store';
import { codexAuthLockDir } from '../src/cc-locks';
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
  const slots = {
    readSlot: (accountId: string) => {
      const text = keychain.getSync(qlbKeychainService('openai-codex', accountId), QLB_KEYCHAIN_ACCOUNT);
      const slot = JSON.parse(text) as CodexAuthDocument;
      return { document: slot, fingerprint: codexFingerprint(slot) };
    },
    ensureUnclaimedStash: async () => ({ stashId: 'fixture-stash', created: true }),
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
        const started = performance.now();
        const result = await reconcileActiveCodexLive(h.deps);
        const elapsed = performance.now() - started;
        rmSync(lock, { recursive: true, force: true });
        assert.deepEqual(result, { status: 'deferred', reason: 'locks-held' });
        assert.ok(elapsed >= expectedMs - 20 && elapsed < expectedMs + 400,
          `lock timeout was ${Math.round(elapsed)}ms, expected ${expectedMs}ms`);
      };
      await assertContendedTimeout(locks.consume, 80);
      await assertContendedTimeout(locks.switch, 80);
      await assertContendedTimeout(locks.auth, 80);

      h.deps.lockTimeoutMs = undefined;
      await assertContendedTimeout(locks.auth, 40);
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
      let stashPath: string | undefined;
      h.deps.slots = { ...h.deps.slots, ensureUnclaimedStash: async (doc: CodexAuthDocument) => {
        stashPath = join(h.root, `stash-${codexFingerprint(doc)}`);
        return { stashId: 'fixture-stash', created: true };
      } } as never;
      writeFileSync(h.authPath, JSON.stringify(unknown));
      const refused = await reconcileActiveCodexLive(h.deps);
      assert.deepEqual(refused, { status: 'refused', reason: 'unknown-live-identity' });
      assertRedacted(refused);
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
        throwing.deps.slots = { ...throwing.deps.slots, readSlot: () => {
          throw new Error('fixture slot read failure');
        } } as never;
        await assert.rejects(reconcileActiveCodexLive(throwing.deps), (error: unknown) => {
          assertRedacted(error instanceof Error ? error.message : String(error));
          return true;
        });
      } finally { throwing.close(); }
    } finally { h.close(); }
  });
});
