import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { refreshActiveCodexLogin, type CodexActiveDeps } from '../src/codex-active';
import { codexFingerprint, readCodexAuthStableWithStat, type CodexAuthDocument } from '../src/codex-auth';
import { consumeCodexSlot } from '../src/codex-consume';
import { CodexSlots, importActiveCodexSlot } from '../src/codex-slots';
import { readBuildStamp } from '../src/codex-stop';
import { CODEX_SWITCH_COMMAND_ENABLED, switchCodex, type CodexSwitchDeps } from '../src/codex-switch';
import { runCodexRefreshCommand } from '../src/commands/codex-refresh';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { openStore, type CodexStageEvent, type Store } from '../src/store';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const PROVIDER = 'openai-codex';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function login(user: string, refresh: string, expiresAt: number): CodexAuthDocument {
  return {
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_account_id: 'account' } }),
      access_token: jwt({ exp: Math.floor(expiresAt / 1_000), sub: `${refresh}-access` }),
      refresh_token: refresh,
      account_id: 'account',
    },
    last_refresh: '2026-10-30T12:00:00.000Z',
  };
}

function refreshed(refresh: string, expiresAt: number) {
  return { status: 200, body: JSON.stringify({ refresh_token: refresh, access_token: jwt({ exp: Math.floor(expiresAt / 1_000), sub: refresh }) }) };
}

function stageStart(store: Store, at = NOW - 10_000): void {
  store.appendCodexStageEvent({ kind: 'stage-start', now: at, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, stage: 1, detail: { allow: [] } });
}

function latchSet(store: Store, evidence: string, at = NOW - 5_000): number {
  const id = store.appendCodexStageEvent({ kind: 'latch-set', now: at, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, evidence,
    detail: { rule: 'forced-relogin' } });
  assert.ok(id !== null);
  return id;
}

/** A committed switch with a reverted verdict: stop evidence the sweep has not recorded yet. */
function revertedVerdict(store: Store, at = NOW - 2_000): number {
  store.recordSwitch({ ts: at - 10, provider: PROVIDER, fromAccount: 'a:account', toAccount: 'b:account', trigger: 'auto', outcome: 'ok', publishedAt: at - 10 });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const switchId = (db.prepare('SELECT MAX(id) AS id FROM switch_log').get() as { id: number }).id;
  assert.equal(store.insertCodexWatchVerdict({ switchId, verdict: 'reverted', now: at }), true);
  return switchId;
}

const latchSets = (store: Store): CodexStageEvent[] => store.readCodexStageLog().events.filter((event) => event.kind === 'latch-set');

/** One managed Codex slot, near expiry, in a real store and Keychain. */
function managed() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-consume-latch-'));
  const store = openStore(join(root, 'qlb.db'));
  const keychain = new MockKeychain();
  const initial = login('a', 'consume-latch-a', NOW + 60_000);
  const plan = importActiveCodexSlot(initial, { store, keychain, now: () => NOW - 1 });
  const slots = new CodexSlots({ keychain, stashDir: join(root, 'unclaimed'), now: () => NOW });
  let posts = 0;
  const consume = (overrides: Partial<Parameters<typeof consumeCodexSlot>[0]> = {}) => consumeCodexSlot({
    accountId: plan.slotId, snapshot: initial, trigger: 'force', force: true, slots, store, holders: async () => [], now: () => NOW,
    transport: async () => { posts += 1; return refreshed('consume-latch-b', NOW + 3_600_000); },
    ...overrides,
  });
  return {
    root, store, keychain, initial, plan, slots, consume, posts: () => posts,
    slotDocument: () => slots.readSlot(plan.slotId, { fresh: true }).document,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe('Codex consume latch check (U8)', () => {
  it('a set latch returns stop-latched before the refresh request, and the slot is unchanged', async () => {
    const h = managed();
    try {
      stageStart(h.store);
      latchSet(h.store, 'relogin_events:9');
      const result = await h.consume();
      assert.equal(result.status, 'stop-latched');
      assert.equal(result.latchCheck, 'set');
      assert.equal(h.posts(), 0);
      assert.deepEqual(h.slotDocument(), h.initial);
    } finally { h.close(); }
  });

  it('runs the sweep first: an unrecorded reverted verdict is recorded as a stop and refuses the refresh', async () => {
    const h = managed();
    try {
      stageStart(h.store);
      const switchId = revertedVerdict(h.store);
      const result = await h.consume({ stopRules: { buildStamp: 'build-xyz', flagEnabled: true, lifecycleId: 7 } });
      assert.equal(result.status, 'stop-latched');
      assert.equal(h.posts(), 0);
      const [stop] = latchSets(h.store);
      assert.equal(stop?.evidence, `codex_watch_verdicts:${switchId}`);
      assert.equal(stop?.buildStamp, 'build-xyz');
      assert.equal(stop?.flagEnabled, true);
      assert.equal(stop?.lifecycleId, 7);
    } finally { h.close(); }
  });

  it('without caller stamps, the stop is stamped with the build stamp, the flag constant and the open lifecycle row', async () => {
    const h = managed();
    try {
      const db = (h.store as unknown as { db: DatabaseSync }).db;
      db.prepare('INSERT INTO lifecycle (state, began_at, cutover_at) VALUES (?, ?, ?)').run('cutover', NOW - 100_000, NOW - 90_000);
      const lifecycleId = (db.prepare('SELECT MAX(id) AS id FROM lifecycle').get() as { id: number }).id;
      stageStart(h.store);
      revertedVerdict(h.store);
      assert.equal((await h.consume()).status, 'stop-latched');
      const [stop] = latchSets(h.store);
      assert.equal(stop?.buildStamp, readBuildStamp());
      assert.equal(stop?.flagEnabled, CODEX_SWITCH_COMMAND_ENABLED);
      assert.equal(stop?.lifecycleId, lifecycleId);
    } finally { h.close(); }
  });

  it('an unknown latch (a restored database awaiting --initialize, or missing stage tables) also refuses', async () => {
    const restored = managed();
    try {
      const db = (restored.store as unknown as { db: DatabaseSync }).db;
      db.prepare("INSERT INTO codex_stage_events (kind, recorded_at, flag_enabled) VALUES ('initialize-required', ?, 0)").run(NOW - 1);
      assert.deepEqual(await restored.consume(), { status: 'stop-latched', latchCheck: 'unknown' });
      assert.equal(restored.posts(), 0);
    } finally { restored.close(); }
    const dropped = managed();
    try {
      (dropped.store as unknown as { db: DatabaseSync }).db.exec('DROP TABLE codex_stage_events');
      assert.deepEqual(await dropped.consume(), { status: 'stop-latched', latchCheck: 'unknown' });
      assert.equal(dropped.posts(), 0);
    } finally { dropped.close(); }
  });

  it('a failing sweep refuses rather than sending the request', async () => {
    const h = managed();
    try {
      stageStart(h.store);
      const db = (h.store as unknown as { db: DatabaseSync }).db;
      db.exec("CREATE TRIGGER reject_latch BEFORE INSERT ON codex_stage_events WHEN NEW.kind = 'latch-set' BEGIN SELECT RAISE(FAIL, 'fixture sweep failure'); END;");
      revertedVerdict(h.store);
      assert.deepEqual(await h.consume(), { status: 'stop-latched', latchCheck: 'check-failed' });
      assert.equal(h.posts(), 0);
    } finally { h.close(); }
  });

  it('a lifecycle read that fails stamps a null lifecycle and does not refuse on its own', async () => {
    const h = managed();
    try {
      (h.store as unknown as { db: DatabaseSync }).db.exec('ALTER TABLE lifecycle RENAME TO lifecycle_moved');
      assert.equal((await h.consume()).status, 'refreshed');
      stageStart(h.store);
      revertedVerdict(h.store);
      assert.equal((await h.consume({ snapshot: h.slotDocument() })).status, 'stop-latched');
      assert.equal(latchSets(h.store)[0]?.lifecycleId, null);
    } finally { h.close(); }
  });

  it('an unarmed or cleared latch lets the refresh through', async () => {
    const unarmed = managed();
    try {
      revertedVerdict(unarmed.store);
      assert.equal((await unarmed.consume()).status, 'refreshed');
      assert.equal(unarmed.posts(), 1);
      assert.deepEqual(latchSets(unarmed.store), []);
    } finally { unarmed.close(); }
    const cleared = managed();
    try {
      stageStart(cleared.store);
      const stop = latchSet(cleared.store, 'relogin_events:9');
      cleared.store.appendCodexStageEvent({ kind: 'latch-clear', now: NOW - 1_000, lifecycleId: 1, buildStamp: null, flagEnabled: true, throughId: stop, reason: 'checked' });
      assert.equal((await cleared.consume()).status, 'refreshed');
      assert.equal(cleared.posts(), 1);
    } finally { cleared.close(); }
  });

  it('a successor adoption while latched still completes, with no refresh request', async () => {
    const h = managed();
    try {
      stageStart(h.store);
      latchSet(h.store, 'relogin_events:9');
      const successor = login('a', 'consume-latch-successor', NOW + 3_600_000);
      await h.slots.stashUnclaimedDurably('adoption-stash', successor, codexFingerprint(h.initial), h.plan.slotId);
      const result = await h.consume({ trigger: 'scheduled', force: false });
      assert.equal(result.status, 'fresh');
      assert.equal(h.posts(), 0);
      assert.deepEqual(h.slotDocument(), successor);
    } finally { h.close(); }
  });

  it('with the store absent (pure tests), consume behaves as before and sends the request', async () => {
    let current = login('a', 'pure-a', NOW + 60_000);
    let posts = 0;
    const result = await consumeCodexSlot({
      accountId: 'a:account', snapshot: current, trigger: 'force', force: true, holders: async () => [], now: () => NOW,
      slots: {
        readSlot: () => ({ document: current, fingerprint: codexFingerprint(current) }),
        writeSlot: (_id: string, next: CodexAuthDocument) => { current = next; },
        stashUnclaimed: () => 'unused',
      },
      transport: async () => { posts += 1; return refreshed('pure-b', NOW + 3_600_000); },
    });
    assert.equal(result.status, 'refreshed');
    assert.equal(posts, 1);
  });

  it('every production consume call passes the store, so none skips the latch check', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
    });
    const calls: string[] = [];
    for (const file of files(join(process.cwd(), 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (let at = text.indexOf('consumeCodexSlot({'); at >= 0; at = text.indexOf('consumeCodexSlot({', at + 1)) {
        let depth = 0;
        let end = at + 'consumeCodexSlot('.length;
        for (; end < text.length; end += 1) {
          if (text[end] === '{') depth += 1;
          if (text[end] === '}' && --depth === 0) break;
        }
        const args = text.slice(at, end);
        calls.push(file);
        assert.match(args, /(^|[\s,{])store[,:\s]/, `${file} calls consumeCodexSlot without a store`);
      }
    }
    assert.equal(calls.length, 3, calls.join('\n'));
  });
});

/** The active login A, near expiry, with a real store, Keychain and auth.json. */
function active() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-active-latch-'));
  const journalDir = join(root, 'journal');
  mkdirSync(journalDir);
  const store = openStore(join(root, 'qlb.db'));
  const keychain = new MockKeychain();
  const authPath = join(root, 'auth.json');
  const a0 = login('a', 'active-latch-a0', NOW + 60_000);
  importActiveCodexSlot(a0, { store, keychain, now: () => NOW - 1 });
  store.setActiveLogin(PROVIDER, 'a:account', 'import', NOW);
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
  const autoLog: string[] = [];
  let posts = 0;
  const deps: CodexActiveDeps = {
    store, dbPath: store.dbPath, journalDir, authPath, keychain, slots: slots as never,
    readLive: () => readCodexAuthStableWithStat(authPath, { delayMs: 0 }),
    cswapProcesses: () => [], now: () => NOW, attempt: 'active-latch', list: async () => [],
    // Each successor is itself near expiry, so the next scheduled refresh is due again.
    transport: async () => { posts += 1; return refreshed(`active-latch-a${posts}`, NOW + 60_000); },
    withLocks: async (_accountId, fn) => fn(() => undefined),
    autoLog: (line) => { autoLog.push(line); },
  };
  return {
    store, deps, autoLog, posts: () => posts, live: () => readFileSync(authPath, 'utf8'),
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe('Codex active refresh while latched (U8)', () => {
  it('AE2: after a reverted verdict, the next scheduled refresh of the active token makes no request and is refused', async () => {
    const h = active();
    try {
      stageStart(h.store);
      revertedVerdict(h.store);
      const before = h.live();
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'scheduled' });
      assert.deepEqual(outcome, { status: 'refused', reason: 'codex-stop-latched' });
      assert.equal(h.posts(), 0);
      assert.equal(h.live(), before);
      assert.equal(latchSets(h.store).length, 1);
      assert.ok(h.autoLog.some((line) => line.startsWith('codex:stop-latched ')));
    } finally { h.close(); }
  });

  it('a check that fails to run refuses and writes codex:latch-check-failed, since no stop was recorded', async () => {
    const h = active();
    try {
      stageStart(h.store);
      (h.store as unknown as { db: DatabaseSync }).db.exec("CREATE TRIGGER reject_latch BEFORE INSERT ON codex_stage_events WHEN NEW.kind = 'latch-set' BEGIN SELECT RAISE(FAIL, 'fixture sweep failure'); END;");
      revertedVerdict(h.store);
      assert.deepEqual(await refreshActiveCodexLogin(h.deps, { trigger: 'scheduled' }), { status: 'refused', reason: 'codex-stop-latched' });
      assert.equal(h.posts(), 0);
      assert.ok(h.autoLog.some((line) => line.startsWith('codex:latch-check-failed provider=openai-codex account=a:account ')));
    } finally { h.close(); }
  });

  it('a stop committed during afterObserve, before consume runs, is caught by the consume check', async () => {
    const h = active();
    try {
      stageStart(h.store);
      h.deps.hooks = { afterObserve: () => { revertedVerdict(h.store, NOW - 1); } };
      const outcome = await refreshActiveCodexLogin(h.deps, { trigger: 'scheduled' });
      assert.deepEqual(outcome, { status: 'refused', reason: 'codex-stop-latched' });
      assert.equal(h.posts(), 0);
    } finally { h.close(); }
  });

  it('a stop committed during beforeSend lets that one request through, and the next refresh is refused (R21)', async () => {
    const h = active();
    try {
      stageStart(h.store);
      let committed = false;
      h.deps.hooks = { beforeSend: () => { if (!committed) { committed = true; revertedVerdict(h.store, NOW - 1); } } };
      assert.equal((await refreshActiveCodexLogin(h.deps, { trigger: 'scheduled' })).status, 'posted');
      assert.equal(h.posts(), 1);
      assert.deepEqual(await refreshActiveCodexLogin(h.deps, { trigger: 'scheduled' }), { status: 'refused', reason: 'codex-stop-latched' });
      assert.equal(h.posts(), 1);
    } finally { h.close(); }
  });
});

describe('qlb codex refresh --force while latched (U8)', () => {
  it('makes no request, prints the refusal and exits non-zero', async () => {
    const h = managed();
    try {
      stageStart(h.store);
      latchSet(h.store, 'relogin_events:9');
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCodexRefreshCommand([h.plan.slotId, '--force'], {
        getConfig: () => null,
        consume: ({ accountId, force, allowHeld }) => h.consume({ accountId, force, allowHeld }),
        write: (line) => out.push(line),
        error: (line) => err.push(line),
      });
      assert.equal(code, 3);
      assert.equal(h.posts(), 0);
      assert.deepEqual(out, [`${h.plan.slotId}: stop-latched`]);
      assert.deepEqual(err, ['codex refresh refused: codex-stop-latched; see qlb codex stage report']);
    } finally { h.close(); }
  });

  it('says when the latch check itself failed, since no stop was recorded', async () => {
    const err: string[] = [];
    const code = await runCodexRefreshCommand(['a:account', '--force'], {
      getConfig: () => null,
      consume: async () => ({ status: 'stop-latched', latchCheck: 'check-failed' }),
      write: () => {},
      error: (line) => err.push(line),
    });
    assert.equal(code, 3);
    assert.deepEqual(err, ['codex refresh refused: codex-stop-latched (latch check failed; retry); see qlb codex stage report']);
  });
});

/** Slots A (live) and B in a cutover store; B is near expiry, so a switch to it runs the pre-switch refresh. */
function switching() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-freshen-latch-'));
  const store = openStore(join(root, 'qlb.db'));
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare('INSERT INTO lifecycle (state, began_at, cutover_at) VALUES (?, ?, ?)').run('cutover', NOW - 10_000_000, NOW - 9_000_000);
  const keychain = new MockKeychain();
  const authPath = join(root, 'auth.json');
  const a = login('a', 'freshen-latch-a', NOW + 100_000_000);
  const b = login('b', 'freshen-latch-b', NOW + 60_000);
  importActiveCodexSlot(a, { store, keychain, now: () => NOW - 10 });
  importActiveCodexSlot(b, { store, keychain, now: () => NOW - 5 });
  store.setActiveLogin(PROVIDER, 'a:account', 'import', NOW - 1);
  writeFileSync(authPath, JSON.stringify(a));
  const slots = {
    readSlot: (id: string) => {
      const doc = JSON.parse(keychain.getSync(qlbKeychainService(PROVIDER, id), QLB_KEYCHAIN_ACCOUNT)) as CodexAuthDocument;
      return { document: doc, fingerprint: codexFingerprint(doc) };
    },
    writeSlot: (id: string, document: CodexAuthDocument) => {
      keychain.setSync(qlbKeychainService(PROVIDER, id), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(document));
      db.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?').run(codexFingerprint(document), id);
    },
    stashUnclaimed: () => 'unused',
    ensureUnclaimedStash: async () => ({ stashId: 'unused', created: false }),
  };
  let posts = 0;
  let tick = NOW;
  const deps = (overrides: Partial<CodexSwitchDeps> = {}): CodexSwitchDeps => ({
    store, authPath, dbPath: store.dbPath, journalDir: join(root, 'journal'),
    authLockOptions: { home: root, timeoutMs: 50, retryMinMs: 1, retryJitterMs: 1 },
    keychain, slots: slots as never, list: async () => [],
    transport: async () => { posts += 1; return refreshed('freshen-latch-b2', NOW + 3_600_000); },
    readLive: () => readCodexAuthStableWithStat(authPath, { delayMs: 0 }),
    cswapProcesses: () => [], now: () => tick++,
    sleep: async () => { throw new Error('skip foreground checks'); },
    journalOwner: { pid: process.pid, lstart: 'fixture-owner' },
    attempt: `freshen-latch-${tick}`,
    flagEnabled: true, buildStamp: 'build-switch', lifecycleId: () => 1,
    ...overrides,
  });
  return {
    store, db, deps, posts: () => posts, live: () => readFileSync(authPath, 'utf8'),
    switchRows: () => (db.prepare("SELECT COUNT(*) AS n FROM switch_log WHERE provider = 'openai-codex'").get() as { n: number }).n,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe('Codex pre-switch refresh while latched (U8)', () => {
  it('a stop committed after the switch\'s own latch check is caught by the pre-switch refresh: no request, nothing persisted or published', async () => {
    const h = switching();
    try {
      stageStart(h.store);
      const before = h.live();
      let relogin = 0;
      const result = await switchCodex(h.deps({ hooks: { beforeFreshenLock: () => {
        relogin = h.store.recordRelogin({ ts: NOW + 5, provider: PROVIDER, accountId: 'a:account', kind: 'wiped' });
      } } }), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'refused');
      assert.equal(result.reason, 'codex-stop-latched');
      const [stop] = latchSets(h.store);
      assert.equal(stop?.evidence, `relogin_events:${relogin}`);
      assert.equal(stop?.buildStamp, 'build-switch');
      assert.deepEqual(result.latch, { state: 'set', newestStopId: stop?.id, evidence: `relogin_events:${relogin}` });
      assert.equal(h.posts(), 0);
      assert.equal(h.switchRows(), 0);
      assert.equal(h.live(), before);
    } finally { h.close(); }
  });

  it('when the pre-switch refresh refuses but no stop can be named, the switch says the latch check failed, unpersisted', async () => {
    const h = switching();
    const otherRoot = mkdtempSync(join(tmpdir(), 'qlb-codex-freshen-latch-other-'));
    try {
      stageStart(h.store);
      // The refresh reads a different database than the switch, so it refuses on a latch the switch cannot see.
      h.db.exec(`VACUUM INTO '${join(otherRoot, 'qlb.db')}'`);
      const other = openStore(join(otherRoot, 'qlb.db'));
      (other as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO codex_stage_events (kind, recorded_at, flag_enabled) VALUES ('initialize-required', ?, 0)").run(NOW - 1);
      other.close();
      const result = await switchCodex(h.deps({ dbPath: join(otherRoot, 'qlb.db') }), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'refused');
      assert.equal(result.reason, 'codex-stop-latched');
      assert.deepEqual(result.latch, { state: 'unknown', reason: 'latch-check-failed' });
      assert.equal(h.posts(), 0);
      assert.equal(h.switchRows(), 0);
    } finally { h.close(); rmSync(otherRoot, { recursive: true, force: true }); }
  });

  it('an unlatched control sends the pre-switch refresh request', async () => {
    const h = switching();
    try {
      stageStart(h.store);
      // This fixture's slot store cannot persist the successor, so the switch stops at the freshen; the request is what matters.
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(h.posts(), 1);
      assert.notEqual(result.reason, 'codex-stop-latched');
      assert.deepEqual(latchSets(h.store), []);
    } finally { h.close(); }
  });
});
