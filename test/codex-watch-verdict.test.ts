import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { readCodexAuthStableWithStat, codexFingerprint, type CodexAuthDocument } from '../src/codex-auth';
import type { CodexProcess, CodexRecoveryFence } from '../src/codex-sessions';
import { importActiveCodexSlot } from '../src/codex-slots';
import {
  CODEX_WATCH_OVERDUE_MS,
  codexWatchTick,
  runDueCodexWatches,
  switchCodex,
  type CodexSwitchDeps,
  type CodexWatch,
} from '../src/codex-switch';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { openStore, type Store } from '../src/store';

const NOW = 1_700_000_000_000;

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function login(user: string, refresh: string): CodexAuthDocument {
  return {
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_account_id: 'account' } }),
      access_token: jwt({ exp: Math.floor(1_700_100_000_000 / 1_000) }),
      refresh_token: refresh,
      account_id: 'account',
    },
    last_refresh: '2023-10-01T00:00:00.000Z',
  };
}

/** A store with slots A and B, A live, and deps for a real switch and its watch. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-watch-verdict-'));
  const store = openStore(join(root, 'qlb.db'));
  const db = (store as unknown as { db: DatabaseSync }).db;
  const keychain = new MockKeychain();
  const authPath = join(root, 'auth.json');
  const a = login('a', 'verdict-a');
  const b = login('b', 'verdict-b');
  importActiveCodexSlot(a, { store, keychain, now: () => NOW - 10 });
  importActiveCodexSlot(b, { store, keychain, now: () => NOW - 5 });
  store.setActiveLogin('openai-codex', 'a:account', 'import', NOW - 1);
  writeFileSync(authPath, JSON.stringify(a));
  const slots = {
    readSlot: (id: string) => {
      const doc = JSON.parse(keychain.getSync(qlbKeychainService('openai-codex', id), QLB_KEYCHAIN_ACCOUNT)) as CodexAuthDocument;
      return { document: doc, fingerprint: codexFingerprint(doc) };
    },
    writeSlot: (id: string, document: CodexAuthDocument) => {
      keychain.setSync(qlbKeychainService('openai-codex', id), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(document));
      db.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?').run(codexFingerprint(document), id);
    },
    stashUnclaimed: () => 'unused',
    ensureUnclaimedStash: async () => ({ stashId: 'unused', created: false }),
  };
  let tick = NOW;
  const deps = (overrides: Partial<CodexSwitchDeps> = {}): CodexSwitchDeps => ({
    store,
    authPath,
    dbPath: store.dbPath,
    journalDir: join(root, 'journal'),
    authLockOptions: { home: root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 },
    keychain,
    slots: slots as never,
    list: async () => [],
    transport: async () => { throw new Error('unexpected transport'); },
    readLive: () => readCodexAuthStableWithStat(authPath, { delayMs: 0 }),
    cswapProcesses: () => [],
    now: () => tick++,
    sleep: async () => undefined,
    journalOwner: { pid: process.pid, lstart: 'fixture-owner' },
    attempt: 'verdict-attempt',
    ...overrides,
  });
  return { root, store, db, keychain, authPath, a, b, slots, deps };
}

type Harness = ReturnType<typeof harness>;

function close(h: Harness): void {
  h.store.close();
  rmSync(h.root, { recursive: true, force: true });
}

/** Commit a real A→B switch, skipping its foreground checks, and return its durable watch. */
async function committedWatch(h: Harness, trigger = 'manual', list: () => Promise<CodexProcess[]> = async () => []): Promise<CodexWatch> {
  if (trigger !== 'manual') h.store.setConfig('codex.l13VerifiedAt', '1');
  const result = await switchCodex(h.deps({ list, sleep: async () => { throw new Error('skip foreground checks'); } }), { target: 'b:account', trigger });
  assert.equal(result.outcome, 'ok');
  const row = h.db.prepare(`SELECT w.switch_id, w.outgoing, w.target, w.until, s.trigger, json_extract(s.steps_json, '$.attempt') AS attempt,
    s.published_at, s.open_sessions_json FROM codex_watch w JOIN switch_log s ON s.id = w.switch_id`).get() as {
    switch_id: number; outgoing: string; target: string; until: number; trigger: string; attempt: string; published_at: number; open_sessions_json: string;
  };
  return { switchId: row.switch_id, outgoing: row.outgoing, target: row.target, trigger: row.trigger, attempt: row.attempt,
    publishedAt: row.published_at, until: row.until,
    openSessions: (JSON.parse(row.open_sessions_json) as CodexProcess[]).map(({ pid, lstart, host }) => ({ pid, lstart, host })) };
}

/** One durable runner pass at a fixed clock. */
function due(h: Harness, at: number, overrides: Partial<CodexSwitchDeps> = {}): Promise<void> {
  return runDueCodexWatches(h.deps({ now: () => at, ...overrides }), at);
}

function verdictOf(h: Harness, switchId: number): string | null {
  return h.store.listCodexWatchVerdicts().find((row) => row.switchId === switchId)?.verdict ?? null;
}

function watchCount(h: Harness): number {
  return (h.db.prepare('SELECT COUNT(*) AS count FROM codex_watch').get() as { count: number }).count;
}

function switchRowCount(h: Harness): number {
  return (h.db.prepare('SELECT COUNT(*) AS count FROM switch_log').get() as { count: number }).count;
}

/** Codex's own save: new bytes at a new inode. */
function codexWrites(h: Harness, doc: CodexAuthDocument): void {
  const temp = `${h.authPath}.codex-save`;
  writeFileSync(temp, JSON.stringify(doc));
  renameSync(temp, h.authPath);
}

function fenceFor(watch: CodexWatch): CodexRecoveryFence {
  return { v: 1, switchId: watch.switchId, attempt: watch.attempt, from: watch.outgoing, to: watch.target, publishedAt: watch.publishedAt,
    reason: 'slot-split', involvedAccounts: [watch.outgoing, watch.target], since: watch.publishedAt + 1 };
}

/**
 * Holds this switch's fence open: B's Keychain copy no longer matches its
 * recorded head, so recovery cannot resolve the fence (a slot split).
 */
function holdOwnFence(h: Harness, watch: CodexWatch): void {
  h.store.setRecoveryFence(fenceFor(watch));
  h.keychain.setSync(qlbKeychainService('openai-codex', 'b:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(login('b', 'split-b')));
}

/** A fence recovery cannot read, so it belongs to no known switch and stays set. */
function holdForeignFence(h: Harness): void {
  h.store.setConfig('codex.recoveryFence', '{');
}

const holderOfA: CodexProcess = { pid: 4401, lstart: 'Mon Nov 13 10:00:00 2023', host: 'codex' };

describe('Codex watch verdicts (U5): one verdict per watch ending', () => {
  it('quiet at until with the target live and no fence: confirmed', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      const rowsBefore = switchRowCount(h);
      await due(h, watch.until);
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'confirmed');
      assert.equal(switchRowCount(h), rowsBefore, 'no switch_log row for a quiet ending');
    } finally { close(h); }
  });

  it('quiet before until: no verdict, the row stays', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      await due(h, watch.until - 1_000);
      assert.equal(watchCount(h), 1);
      assert.equal(verdictOf(h, watch.switchId), null);
    } finally { close(h); }
  });

  it('a tick at until under this switch\'s fence reports fenced and keeps the row', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      holdOwnFence(h, watch);
      assert.deepEqual(await codexWatchTick(h.deps({ now: () => watch.until }), watch), { state: 'fenced' });
      await due(h, watch.until);
      assert.equal(watchCount(h), 1);
      assert.equal(verdictOf(h, watch.switchId), null);
    } finally { close(h); }
  });

  it('a tick at until under a different switch\'s fence keeps the row and records no confirmed verdict', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      holdForeignFence(h);
      await due(h, watch.until);
      assert.equal(watchCount(h), 1);
      assert.equal(verdictOf(h, watch.switchId), null);
    } finally { close(h); }
  });

  it('this switch\'s fence resolving ok: confirmed', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      const fence = fenceFor(watch);
      h.store.setRecoveryFence(fence);
      h.store.commitFenceResolution({ fence, effect: { outcome: 'quiet' }, attempt: watch.attempt, now: watch.until + 1 });
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'confirmed');
    } finally { close(h); }
  });

  it('this switch\'s fence still set at until, later resolving failed: unresolved, not confirmed', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      holdOwnFence(h, watch);
      await due(h, watch.until);
      assert.equal(watchCount(h), 1);
      const fence = fenceFor(watch);
      h.store.commitFenceResolution({ fence, effect: { outcome: 'failed', detail: 'wiped' }, attempt: watch.attempt, now: watch.until + 2 });
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'unresolved');
    } finally { close(h); }
  });

  it('a fence resolution for a switch with no watch writes no verdict', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      await due(h, watch.until);
      assert.equal(verdictOf(h, watch.switchId), 'confirmed');
      const fence = fenceFor(watch);
      h.store.setRecoveryFence(fence);
      h.store.commitFenceResolution({ fence, effect: { outcome: 'failed', detail: 'wiped' }, attempt: watch.attempt, now: watch.until + 5 });
      assert.equal(verdictOf(h, watch.switchId), 'confirmed');
    } finally { close(h); }
  });

  it('Codex writing back its own login: reverted', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h, 'auto', async () => [holderOfA]);
      codexWrites(h, login('a', 'a-prime'));
      assert.deepEqual(await codexWatchTick(h.deps({ now: () => watch.publishedAt + 30_000, list: async () => [holderOfA] }), watch),
        { state: 'reverted' });
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'reverted');
    } finally { close(h); }
  });

  it('an unreadable login file at until: inconclusive', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      await due(h, watch.until, { readLive: async () => ({ status: 'unreadable', code: 'EACCES' }) as never });
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'inconclusive');
    } finally { close(h); }
  });

  it('a logged-out login file: inconclusive', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      await due(h, watch.until - 1_000, { readLive: async () => ({ status: 'missing' }) });
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'inconclusive');
    } finally { close(h); }
  });

  it('a wiped live login: wiped', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      await due(h, watch.until - 1_000, { readLive: async () => ({ status: 'wiped', error: { ok: false, error: 'tokens-empty', status: 'wiped' } }) as never });
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'wiped');
    } finally { close(h); }
  });

  it('an unknown live identity: unknown-live-identity', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      h.store.commitCodexWatchStop({ watch, attempt: watch.attempt, now: watch.publishedAt + 30_000 });
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'unknown-live-identity');
    } finally { close(h); }
  });

  it('a later switch replacing the watch: superseded', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      h.store.recordSwitch({ ts: watch.publishedAt + 1, provider: 'openai-codex', fromAccount: 'b:account', toAccount: 'a:account', trigger: 'manual',
        outcome: 'ok', stepsJson: JSON.stringify({ attempt: 'later', via: 'switch' }), publishedAt: watch.publishedAt + 1 });
      await due(h, watch.until - 1_000);
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'superseded');
    } finally { close(h); }
  });

  it('a lifecycle that no longer admits the watch: not-admitted', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      await due(h, watch.until - 1_000, { admitted: () => ({ ok: false, reason: 'phase' }) });
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'not-admitted');
    } finally { close(h); }
  });
});

describe('Codex watch verdicts (U5): overdue watches', () => {
  it('AE7: consumed more than 60 s past until, no fence, target still live: late, with no switch_log row', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      const rowsBefore = switchRowCount(h);
      await due(h, watch.until + CODEX_WATCH_OVERDUE_MS + 1);
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'late');
      assert.equal(switchRowCount(h), rowsBefore);
    } finally { close(h); }
  });

  it('consumed 90 s past until after Codex wrote back its own login: reverted', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h, 'auto', async () => [holderOfA]);
      codexWrites(h, login('a', 'a-prime-late'));
      await due(h, watch.until + 90_000, { list: async () => [holderOfA] });
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'reverted');
    } finally { close(h); }
  });

  it('overdue with an unreadable login file: inconclusive', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      await due(h, watch.until + 90_000, { readLive: async () => ({ status: 'unreadable', code: 'EACCES' }) as never });
      assert.equal(verdictOf(h, watch.switchId), 'inconclusive');
    } finally { close(h); }
  });

  it('overdue while this switch\'s fence is still set: unresolved', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      holdOwnFence(h, watch);
      await due(h, watch.until + 90_000);
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'unresolved');
    } finally { close(h); }
  });

  it('overdue while a different switch\'s fence is set: inconclusive, never confirmed or late', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      holdForeignFence(h);
      await due(h, watch.until + 90_000);
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'inconclusive');
    } finally { close(h); }
  });
});

describe('Codex watch verdicts (U5): one writer', () => {
  it('a second ending for the same switch leaves the first verdict', async () => {
    const h = harness();
    try {
      const watch = await committedWatch(h);
      h.store.endCodexWatch({ switchId: watch.switchId, verdict: 'confirmed', now: watch.until });
      h.store.endCodexWatch({ switchId: watch.switchId, verdict: 'reverted', now: watch.until + 1 });
      assert.equal(watchCount(h), 0);
      assert.equal(verdictOf(h, watch.switchId), 'confirmed');
    } finally { close(h); }
  });

  it('no bare watch delete remains outside the store\'s ending method', () => {
    const srcDir = join(__dirname, '..', '..', 'src');
    const sources = (readdirSync(srcDir, { recursive: true }) as string[])
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name, readFileSync(join(srcDir, name), 'utf8')] as const);
    const deletions = sources.flatMap(([name, text]) => (text.match(/DELETE FROM codex_watch\b(?!_)/g) ?? []).map(() => name));
    assert.deepEqual(deletions, ['store.ts'], 'one deletion site, inside the ending helper');
    assert.deepEqual(sources.filter(([, text]) => text.includes('deleteCodexWatch')).map(([name]) => name), []);
  });
});
