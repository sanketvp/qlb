import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { ClaudeCodeLockTimeout, withCodexAuthLock } from '../src/cc-locks';
import { readCodexAuthStableWithStat, codexFingerprint, type CodexAuthDocument } from '../src/codex-auth';
import { withCodexSwitchLock } from '../src/codex-consume';
import type { CodexRecoveryFence } from '../src/codex-sessions';
import { importActiveCodexSlot } from '../src/codex-slots';
import { admitCodexAction, evaluateStages } from '../src/codex-stage';
import { readBuildStamp, readCodexLatch, readCodexStageInputFrom, toStageLog } from '../src/codex-stop';
import { switchCodex, writeCodexSwitchJournal, type CodexSwitchDeps, type CodexWatch } from '../src/codex-switch';
import command, { codexLatchClear, createCodexLatchCommand, type CodexLatchDeps, type CodexLatchRequest } from '../src/commands/codex-latch';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { PHASE_RULES } from '../src/lifecycle';
import type { CommandContext } from '../src/registry';
import { openStore, openStoreConnection, type CodexStageEvent } from '../src/store';

const NOW = 1_700_000_000_000;
const PROVIDER = 'openai-codex';

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

/** A cutover store with slots A and B, A live, a Stage 1 start, and deps for a real switch, its watch and recovery. */
function harness(phase = 'cutover') {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-latch-'));
  const store = openStore(join(root, 'qlb.db'));
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare('INSERT INTO lifecycle (state, began_at, cutover_at) VALUES (?, ?, ?)').run(phase, NOW - 10_000_000, NOW - 9_000_000);
  const keychain = new MockKeychain();
  const authPath = join(root, 'auth.json');
  const a = login('a', 'latch-a');
  const b = login('b', 'latch-b');
  importActiveCodexSlot(a, { store, keychain, now: () => NOW - 10 });
  importActiveCodexSlot(b, { store, keychain, now: () => NOW - 5 });
  store.setActiveLogin(PROVIDER, 'a:account', 'import', NOW - 1);
  writeFileSync(authPath, JSON.stringify(a));
  store.appendCodexStageEvent({ kind: 'stage-start', now: NOW - 1_000, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, stage: 1, detail: { allow: [] } });
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
    attempt: 'latch-attempt',
    // Switch tests run with the go-live flag on; the latch tests cover it off (KTD17).
    flagEnabled: true,
    ...overrides,
  });
  return { root, store, db, keychain, authPath, deps };
}

type Harness = ReturnType<typeof harness>;

function close(h: Harness): void {
  h.store.close();
  rmSync(h.root, { recursive: true, force: true });
}

function latchDeps(h: Harness, at: number, overrides: Partial<CodexLatchDeps> = {}): CodexLatchDeps {
  return {
    store: h.store,
    switchDeps: h.deps({ now: () => at }),
    buildStamp: 'build-abc',
    flagEnabled: true,
    autoLog: () => undefined,
    ...overrides,
  };
}

function clear(h: Harness, at: number, request: CodexLatchRequest, overrides: Partial<CodexLatchDeps> = {}) {
  return codexLatchClear(latchDeps(h, at, overrides), request);
}

function events(h: Harness): CodexStageEvent[] {
  return h.store.readCodexStageLog().events;
}

const kinds = (h: Harness, kind: string): CodexStageEvent[] => events(h).filter((event) => event.kind === kind);

function wiped(h: Harness, ts: number): number {
  return h.store.recordRelogin({ ts, provider: PROVIDER, accountId: 'a:account', kind: 'wiped' });
}

/** Records one stop through the clear's own sweep and returns its latch-set id. */
async function latched(h: Harness, at = NOW + 1_000): Promise<number> {
  wiped(h, at - 500);
  const probe = await clear(h, at, { kind: 'probe' });
  assert.ok(probe.ok && probe.kind === 'probe' && probe.newestStopId !== null, JSON.stringify(probe));
  return probe.newestStopId;
}

/** Commit a real A→B switch, skipping its foreground checks, and return its durable watch. */
async function committedWatch(h: Harness): Promise<CodexWatch> {
  const result = await switchCodex(h.deps({ sleep: async () => { throw new Error('skip foreground checks'); } }), { target: 'b:account', trigger: 'manual' });
  assert.equal(result.outcome, 'ok');
  const row = h.db.prepare(`SELECT w.switch_id, w.outgoing, w.target, w.until, s.trigger, json_extract(s.steps_json, '$.attempt') AS attempt,
    s.published_at FROM codex_watch w JOIN switch_log s ON s.id = w.switch_id`).get() as {
    switch_id: number; outgoing: string; target: string; until: number; trigger: string; attempt: string; published_at: number;
  };
  return { switchId: row.switch_id, outgoing: row.outgoing, target: row.target, trigger: row.trigger, attempt: row.attempt,
    publishedAt: row.published_at, until: row.until, openSessions: [] };
}

function fenceFor(watch: CodexWatch): CodexRecoveryFence {
  return { v: 1, switchId: watch.switchId, attempt: watch.attempt, from: watch.outgoing, to: watch.target, publishedAt: watch.publishedAt,
    reason: 'slot-split', involvedAccounts: [watch.outgoing, watch.target], since: watch.publishedAt + 1 };
}

/** Ends a committed switch's watch and sets its fence: no open watch, as after a stop with qlb-auto stopped. */
function fenceWithoutWatch(h: Harness, watch: CodexWatch): CodexWatch {
  h.store.endCodexWatch({ switchId: watch.switchId, verdict: 'superseded', now: watch.publishedAt + 1 });
  h.store.setRecoveryFence(fenceFor(watch));
  return watch;
}

function admitted(h: Harness, action: Parameters<typeof admitCodexAction>[0]['action']): boolean {
  return admitCodexAction({ log: toStageLog(h.store.readCodexStageLog()), flagEnabled: true, action }).admitted;
}

/** Runs `call` while `hold` keeps a lock, then runs `during` (still holding it) after the call is waiting on it. */
async function underHeldLock<T>(hold: (fn: () => Promise<void>) => Promise<void>, call: () => Promise<T>, during: () => void): Promise<T> {
  let pending: Promise<T> | undefined;
  await hold(async () => {
    pending = call();
    await new Promise((resolve) => setTimeout(resolve, 150));
    during();
  });
  assert.ok(pending);
  return pending;
}

const watchNextAt = (h: Harness): number => (h.db.prepare('SELECT next_at FROM codex_watch').get() as { next_at: number }).next_at;

describe('qlb codex latch clear', () => {
  it('a clear through the newest stop with a reason unlatches, and a switch is admitted again', async () => {
    const h = harness();
    try {
      const stop = await latched(h);
      assert.equal(admitted(h, { kind: 'switch', trigger: 'manual' }), false);
      const result = await clear(h, NOW + 2_000, { kind: 'clear', throughId: stop, reason: 'reviewed the wiped login' });
      assert.ok(result.ok && result.kind === 'clear', JSON.stringify(result));
      const [row] = kinds(h, 'latch-clear');
      assert.deepEqual([row.throughId, row.reason, row.recordedAt, row.buildStamp, row.lifecycleId], [stop, 'reviewed the wiped login', NOW + 2_000, 'build-abc', 1]);
      assert.deepEqual(readCodexLatch(h.store), { state: 'clear' });
      assert.equal(admitted(h, { kind: 'switch', trigger: 'manual' }), true);
      assert.equal(admitted(h, { kind: 'refresh' }), true);
    } finally { close(h); }
  });

  it('a clear through an older id is refused and names the newer stop', async () => {
    const h = harness();
    try {
      const older = await latched(h, NOW + 1_000);
      const newer = await latched(h, NOW + 3_000);
      assert.deepEqual(await clear(h, NOW + 4_000, { kind: 'clear', throughId: older, reason: 'ok' }),
        { ok: false, reason: 'newer-stop', detail: String(newer) });
      assert.equal(kinds(h, 'latch-clear').length, 0);
    } finally { close(h); }
  });

  it('a stop the sweep had not yet recorded is recorded by the clear\'s own sweep, and the clear is refused', async () => {
    const h = harness();
    try {
      const stop = await latched(h);
      wiped(h, NOW + 1_500);
      const result = await clear(h, NOW + 2_000, { kind: 'clear', throughId: stop, reason: 'ok' });
      assert.equal(!result.ok && result.reason, 'newer-stop');
      assert.equal(kinds(h, 'latch-set').length, 2);
      assert.equal(kinds(h, 'latch-clear').length, 0);
    } finally { close(h); }
  });

  it('an empty or multi-line reason is refused', async () => {
    const h = harness();
    try {
      const stop = await latched(h);
      assert.deepEqual(await clear(h, NOW + 2_000, { kind: 'clear', throughId: stop, reason: '  ' }), { ok: false, reason: 'empty-reason' });
      assert.deepEqual(await clear(h, NOW + 2_000, { kind: 'clear', throughId: stop, reason: 'one\ntwo' }), { ok: false, reason: 'multi-line-reason' });
    } finally { close(h); }
  });

  it('a clear with nothing latched is refused', async () => {
    const h = harness();
    try {
      assert.deepEqual(await clear(h, NOW + 2_000, { kind: 'clear', throughId: 1, reason: 'ok' }), { ok: false, reason: 'not-latched' });
    } finally { close(h); }
  });

  it('a clear with an open watch is refused and names its until; between the 120-second tick and until it only advances the watch', async () => {
    const h = harness();
    try {
      // A latched qlb refuses every switch (U7), so the switch commits before the stop.
      const watch = await committedWatch(h);
      const stop = await latched(h);
      const until = new Date(watch.until).toISOString();
      const request: CodexLatchRequest = { kind: 'clear', throughId: stop, reason: 'ok' };
      assert.deepEqual(await clear(h, watch.publishedAt + 10_000, request), { ok: false, reason: 'open-watch', detail: until });
      assert.deepEqual(await clear(h, watch.publishedAt + 150_000, request), { ok: false, reason: 'open-watch', detail: until });
      assert.equal(watchNextAt(h), watch.until, 'the 120-second tick moved the watch on to until');
      assert.equal(h.store.listCodexWatchVerdicts().length, 0);
      assert.equal(kinds(h, 'latch-clear').length, 0);
    } finally { close(h); }
  });

  it('a clear after until consumes the watch through the runner, records its verdict, and succeeds when no new stop results', async () => {
    const h = harness();
    try {
      // A latched qlb refuses every switch (U7), so the switch commits before the stop.
      const watch = await committedWatch(h);
      const stop = await latched(h);
      const result = await clear(h, watch.until, { kind: 'clear', throughId: stop, reason: 'ok' });
      assert.ok(result.ok && result.kind === 'clear', JSON.stringify(result));
      assert.deepEqual(h.store.listCodexWatchVerdicts().map((row) => [row.switchId, row.verdict]), [[watch.switchId, 'confirmed']]);
      assert.deepEqual(readCodexLatch(h.store), { state: 'clear' });
    } finally { close(h); }
  });

  it('an orphaned journal the clear\'s reconciliation commits opens a watch: the clear is refused until it, and succeeds after it', async () => {
    const h = harness();
    try {
      const stop = await latched(h);
      // An A→B attempt was killed after its rename: auth.json holds B and only its journal records it.
      const outgoing = readFileSync(h.authPath);
      const publishedAt = NOW + 5_000;
      writeFileSync(h.authPath, JSON.stringify(login('b', 'latch-b')));
      writeCodexSwitchJournal({
        v: 2, attemptId: 'orphan-attempt', from: 'a:account', to: 'b:account',
        target: { identity: { chatgpt_user_id: 'b', account_id: 'account' }, fingerprint: codexFingerprint(login('b', 'latch-b')) },
        adoptingTarget: [], trigger: 'manual', decision: null, openSessions: [],
        outgoing: { sha256: `sha256-file:${createHash('sha256').update(outgoing).digest('hex')}`, inode: statSync(h.authPath).ino },
        publishedAt, owner: { pid: process.pid, lstart: 'fixture-owner', state: 'released' },
      }, { journalDir: join(h.root, 'journal') });
      const request: CodexLatchRequest = { kind: 'clear', throughId: stop, reason: 'ok' };
      // Recovery commits the switch when the clear runs; its watch ends 300 seconds later.
      const recoveredAt = publishedAt + 10_000;
      const until = new Date(recoveredAt + 300_000).toISOString();
      assert.deepEqual(await clear(h, recoveredAt, request), { ok: false, reason: 'open-watch', detail: until });
      assert.deepEqual(await clear(h, recoveredAt + 150_000, request), { ok: false, reason: 'open-watch', detail: until });
      assert.equal(kinds(h, 'latch-clear').length, 0);
      const done = await clear(h, recoveredAt + 300_000, request);
      assert.ok(done.ok && done.kind === 'clear', JSON.stringify(done));
    } finally { close(h); }
  });

  it('latch set, fence set, no open watch: the clear\'s reconciliation resolves the fence and the clear succeeds', async () => {
    const h = harness();
    try {
      // A latched qlb refuses every switch (U7), so the switch commits before the stop.
      const committed = await committedWatch(h);
      const stop = await latched(h);
      const watch = fenceWithoutWatch(h, committed);
      const result = await clear(h, watch.until + 1_000, { kind: 'clear', throughId: stop, reason: 'ok' });
      assert.ok(result.ok && result.kind === 'clear', JSON.stringify(result));
      assert.equal(h.store.getConfig('codex.recoveryFence'), null);
    } finally { close(h); }
  });

  it('a fence that resolves failed records a new stop; a clear through that newer stop then succeeds', async () => {
    const h = harness();
    try {
      // A latched qlb refuses every switch (U7), so the switch commits before the stop.
      const committed = await committedWatch(h);
      const stop = await latched(h);
      const watch = fenceWithoutWatch(h, committed);
      const fence = fenceFor(watch);
      const at = watch.until + 1_000;
      // Recovery finds the live login wiped and resolves the fence failed, as reconciliation commits it.
      const reconcile = async (deps: CodexSwitchDeps): Promise<void> => {
        if (deps.store.getConfig('codex.recoveryFence') === null) return;
        deps.store.commitFenceResolution({ fence, effect: { outcome: 'failed', detail: 'wiped' }, attempt: watch.attempt, now: at - 10 });
      };
      const first = await clear(h, at, { kind: 'clear', throughId: stop, reason: 'ok' }, { reconcile });
      assert.ok(!first.ok && first.reason === 'newer-stop', JSON.stringify(first));
      const newer = Number(first.detail);
      assert.ok(newer > stop);
      assert.equal(h.store.getConfig('codex.recoveryFence'), null);
      const second = await clear(h, at + 1, { kind: 'clear', throughId: newer, reason: 'reviewed the failed recovery' }, { reconcile });
      assert.ok(second.ok, JSON.stringify(second));
    } finally { close(h); }
  });

  it('a fence that reconciliation cannot resolve still refuses the clear and names the fence', async () => {
    const h = harness();
    try {
      // A latched qlb refuses every switch (U7), so the switch commits before the stop.
      const committed = await committedWatch(h);
      const stop = await latched(h);
      fenceWithoutWatch(h, committed);
      // B's Keychain copy no longer matches its recorded head: a slot split recovery cannot settle.
      h.keychain.setSync(qlbKeychainService(PROVIDER, 'b:account'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(login('b', 'split-b')));
      assert.deepEqual(await clear(h, NOW + 900_000, { kind: 'clear', throughId: stop, reason: 'ok' }),
        { ok: false, reason: 'fence-set', detail: 'slot-split' });
      assert.notEqual(h.store.getConfig('codex.recoveryFence'), null);
    } finally { close(h); }
  });

  it('runs reconciliation, then the watch runner, then the sweep', async () => {
    const h = harness();
    try {
      const calls: string[] = [];
      await clear(h, NOW + 2_000, { kind: 'probe' }, {
        reconcile: async () => { calls.push('reconcile'); },
        runDueWatches: async () => { calls.push('watches'); },
        autoLog: () => { calls.push('sweep'); },
      });
      wiped(h, NOW + 2_500);
      await clear(h, NOW + 3_000, { kind: 'probe' }, {
        reconcile: async () => { calls.push('reconcile'); },
        runDueWatches: async () => { calls.push('watches'); },
        autoLog: () => { calls.push('sweep'); },
      });
      assert.deepEqual(calls, ['reconcile', 'watches', 'reconcile', 'watches', 'sweep']);
    } finally { close(h); }
  });

  it('a watch the clear\'s runner ends reverted records a new stop, and the clear is refused naming it', async () => {
    const h = harness();
    try {
      // A latched qlb refuses every switch (U7), so the switch commits before the stop.
      const watch = await committedWatch(h);
      const stop = await latched(h);
      // Codex wrote its own login back over B: new bytes at a new inode.
      writeFileSync(`${h.authPath}.codex-save`, JSON.stringify(login('a', 'a-prime')));
      renameSync(`${h.authPath}.codex-save`, h.authPath);
      const result = await clear(h, watch.publishedAt + 150_000, { kind: 'clear', throughId: stop, reason: 'ok' });
      assert.ok(!result.ok && result.reason === 'newer-stop' && Number(result.detail) > stop, JSON.stringify(result));
      assert.deepEqual(h.store.listCodexWatchVerdicts().map((row) => row.verdict), ['reverted']);
      // The runner's own sweep records the stop, stamped like the clear's rows.
      const newer = events(h).find((event) => event.id === Number(result.ok ? 0 : result.detail));
      assert.deepEqual([newer?.buildStamp, newer?.flagEnabled], ['build-abc', true]);
    } finally { close(h); }
  });

  it('takes the Codex locks before reading its timestamp, so the clear row follows a switch that held them', async () => {
    const h = harness();
    try {
      const stop = await latched(h);
      let clock = NOW + 2_000;
      const result = await underHeldLock((fn) => withCodexSwitchLock(h.store.dbPath, fn),
        () => clear(h, 0, { kind: 'clear', throughId: stop, reason: 'ok' }, { switchDeps: h.deps({ now: () => clock }) }),
        () => { clock = NOW + 9_000; });
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(kinds(h, 'latch-clear')[0].recordedAt, NOW + 9_000);
    } finally { close(h); }
  });

  it('checks admission again under the locks', async () => {
    const h = harness();
    try {
      const stop = await latched(h);
      const result = await clear(h, NOW + 2_000, { kind: 'clear', throughId: stop, reason: 'ok' }, {
        reconcile: async () => { h.db.prepare("UPDATE lifecycle SET state = 'undoing'").run(); },
      });
      assert.deepEqual(result, { ok: false, reason: 'undo-in-progress' });
      assert.equal(kinds(h, 'latch-clear').length, 0);
    } finally { close(h); }
  });

  it('throws a lock timeout rather than deciding when another Codex writer holds the auth lock', async () => {
    const h = harness();
    try {
      const stop = await latched(h);
      // The rejection is caught as it happens, while the lock is still held.
      const settled = await underHeldLock((fn) => withCodexAuthLock({ home: h.root }, fn),
        () => clear(h, NOW + 2_000, { kind: 'clear', throughId: stop, reason: 'ok' }).then(() => null, (error: unknown) => error), () => undefined);
      assert.ok(settled instanceof ClaudeCodeLockTimeout, String(settled));
      assert.equal(kinds(h, 'latch-clear').length, 0);
    } finally { close(h); }
  });

  it('the probe form appends no clear row and reports the newest stop and what blocks a clear', async () => {
    const h = harness();
    try {
      // A latched qlb refuses every switch (U7), so the switch commits before the stop.
      const watch = await committedWatch(h);
      const stop = await latched(h);
      const result = await clear(h, watch.publishedAt + 10_000, { kind: 'probe' });
      assert.deepEqual(result, {
        ok: true, kind: 'probe', latch: 'latched', newestStopId: stop, blockers: [`open-watch:${new Date(watch.until).toISOString()}`],
      });
      assert.equal(kinds(h, 'latch-clear').length, 0);
    } finally { close(h); }
  });

  it('after a clear no stage run is active: the stopped run stays stopped and automatic switching stays out of scope', async () => {
    const h = harness();
    try {
      h.store.appendCodexStageEvent({ kind: 'stage-start', now: NOW - 500, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, stage: 2, detail: { allow: [], frozenStatus: 'pass' } });
      assert.equal(admitted(h, { kind: 'switch', trigger: 'auto' }), true);
      const stop = await latched(h);
      assert.ok((await clear(h, NOW + 2_000, { kind: 'clear', throughId: stop, reason: 'ok' })).ok);
      const db = openStoreConnection(h.store.dbPath, true);
      try {
        const input = readCodexStageInputFrom(db);
        assert.ok(input);
        assert.equal(evaluateStages(input).stage2.status, 'stop');
      } finally { db.close(); }
      assert.equal(admitted(h, { kind: 'switch', trigger: 'auto' }), false);
    } finally { close(h); }
  });

  it('is refused outside the phases that admit a Codex switch, before reconciliation or the watch runner runs', async () => {
    const h = harness('undoing');
    try {
      const calls: string[] = [];
      assert.deepEqual(await clear(h, NOW + 2_000, { kind: 'probe' }, {
        reconcile: async () => { calls.push('reconcile'); },
        runDueWatches: async () => { calls.push('watches'); },
      }), { ok: false, reason: 'undo-in-progress' });
      assert.deepEqual(calls, []);
    } finally { close(h); }
  });
});

describe('qlb codex latch clear --initialize', () => {
  it('on a restored database a switch and a qlb refresh are refused until the initialize succeeds', async () => {
    const h = harness();
    try {
      h.db.prepare("INSERT INTO codex_stage_events (kind, recorded_at) VALUES ('initialize-required', ?)").run(NOW);
      assert.equal(admitted(h, { kind: 'switch', trigger: 'manual' }), false);
      assert.equal(admitted(h, { kind: 'refresh' }), false);
      assert.deepEqual(await clear(h, NOW + 1_000, { kind: 'initialize', reason: '' }), { ok: false, reason: 'empty-reason' });
      const result = await clear(h, NOW + 2_000, { kind: 'initialize', reason: 'restored from backup' });
      assert.ok(result.ok && result.kind === 'initialize', JSON.stringify(result));
      assert.equal(kinds(h, 'initialize').length, 1);
      assert.equal(admitted(h, { kind: 'switch', trigger: 'manual' }), true);
      assert.equal(admitted(h, { kind: 'refresh' }), true);
    } finally { close(h); }
  });

  it('runs neither reconciliation nor the watch runner, and a probe first reports the required initialize', async () => {
    const h = harness();
    try {
      h.db.prepare("INSERT INTO codex_stage_events (kind, recorded_at) VALUES ('initialize-required', ?)").run(NOW);
      assert.deepEqual(await clear(h, NOW + 1_000, { kind: 'probe' }),
        { ok: true, kind: 'probe', latch: 'unknown', newestStopId: null, blockers: ['latch-unknown:initialize-required'] });
      const calls: string[] = [];
      const result = await clear(h, NOW + 2_000, { kind: 'initialize', reason: 'restored' }, {
        reconcile: async () => { calls.push('reconcile'); },
        runDueWatches: async () => { calls.push('watches'); },
      });
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(calls, []);
    } finally { close(h); }
  });

  it('on an unreadable stage log is refused as latch-unknown, not as not-required', async () => {
    const h = harness();
    try {
      h.db.prepare("INSERT INTO codex_stage_events (kind, recorded_at) VALUES ('latch-clear', ?)").run(NOW);
      assert.deepEqual(await clear(h, NOW + 1_000, { kind: 'initialize', reason: 'restored' }),
        { ok: false, reason: 'latch-unknown', detail: 'unreadable-row' });
      assert.equal(kinds(h, 'initialize').length, 0);
    } finally { close(h); }
  });

  it('is refused when the database needs no initialize, and a plain clear names the initialize when it does', async () => {
    const h = harness();
    try {
      assert.deepEqual(await clear(h, NOW + 1_000, { kind: 'initialize', reason: 'why not' }), { ok: false, reason: 'not-required' });
      h.db.prepare("INSERT INTO codex_stage_events (kind, recorded_at) VALUES ('initialize-required', ?)").run(NOW);
      assert.deepEqual(await clear(h, NOW + 2_000, { kind: 'clear', throughId: 1, reason: 'ok' }),
        { ok: false, reason: 'latch-unknown', detail: 'initialize-required' });
    } finally { close(h); }
  });
});

describe('qlb codex latch command', () => {
  function ctx(): { ctx: CommandContext; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out, err,
      ctx: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line), env: {}, config: { dbPath: ':unused:' }, knownSecrets: () => [] } as unknown as CommandContext,
    };
  }

  it('is registered as `codex latch`', () => {
    assert.equal(command.name, 'codex latch');
  });

  it('rejects bad arguments with exit 2', async () => {
    const cmd = createCodexLatchCommand({ makeDeps: () => { throw new Error('must not open the store'); } });
    for (const args of [
      [], ['clear', '--through'], ['clear', '--through', 'x', '--reason', 'r'], ['clear', '--through', '3'],
      ['clear', '--reason', 'r'], ['clear', '--initialize'], ['clear', '--initialize', '--through', '3', '--reason', 'r'], ['wipe'],
    ]) {
      const c = ctx();
      assert.equal(await cmd.execute?.(args, c.ctx), 2, args.join(' '));
    }
  });

  it('prints the outcome and maps refusals to exit 3', async () => {
    const h = harness();
    try {
      const stop = await latched(h);
      // The command closes the store it is handed, so each run gets its own connection.
      const cmd = createCodexLatchCommand({ makeDeps: async () => latchDeps(h, NOW + 2_000, { store: openStore(h.store.dbPath) }) });
      const older = ctx();
      assert.equal(await cmd.execute?.(['clear', '--through', String(stop + 1), '--reason', 'r'], older.ctx), 3);
      assert.deepEqual(older.err, [`codex latch clear refused: newer-stop: ${stop}`]);
      const probe = ctx();
      assert.equal(await cmd.execute?.(['clear', '--json'], probe.ctx), 0);
      assert.deepEqual(JSON.parse(probe.out[0]), { ok: true, kind: 'probe', latch: 'latched', newestStopId: stop, blockers: [] });
      const probeText = ctx();
      assert.equal(await cmd.execute?.(['clear'], probeText.ctx), 0);
      assert.deepEqual(probeText.out, [`codex latch: latched, newest stop ${stop}`, `nothing else blocks a clear through stop ${stop}`]);
      const done = ctx();
      assert.equal(await cmd.execute?.(['clear', '--through', String(stop), '--reason', 'reviewed'], done.ctx), 0);
      assert.match(done.out[0], new RegExp(`^codex latch cleared through stop ${stop} \\(event \\d+\\)$`));
    } finally { close(h); }
  });
});

describe('qlb codex latch command: locks and production wiring', () => {
  function ctxFor(env: Record<string, string>, dbPath: string): { ctx: CommandContext; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out, err,
      ctx: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line), env, config: { dbPath }, knownSecrets: () => [] } as unknown as CommandContext,
    };
  }

  it('maps a held Codex lock to codex-lock-busy with exit 3 and records no clear', async () => {
    const h = harness();
    try {
      const stop = await latched(h);
      const cmd = createCodexLatchCommand({ makeDeps: async () => latchDeps(h, NOW + 2_000, { store: openStore(h.store.dbPath) }) });
      const c = ctxFor({}, h.store.dbPath);
      const code = await underHeldLock((fn) => withCodexAuthLock({ home: h.root }, fn),
        async () => cmd.execute?.(['clear', '--through', String(stop), '--reason', 'r'], c.ctx), () => undefined);
      assert.equal(code, 3);
      assert.deepEqual(c.err, ['codex latch clear refused: codex-lock-busy']);
      assert.equal(kinds(h, 'latch-clear').length, 0);
    } finally { close(h); }
  });

  it('the default command builds its own deps: a dark build clears a stop and records the flag and build stamp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-latch-default-'));
    try {
      const dbPath = join(root, 'qlb.db');
      const seed = openStore(dbPath);
      (seed as unknown as { db: DatabaseSync }).db
        .prepare('INSERT INTO lifecycle (state, began_at, cutover_at) VALUES (?, ?, ?)').run('cutover', NOW - 10_000_000, NOW - 9_000_000);
      seed.appendCodexStageEvent({ kind: 'stage-start', now: NOW, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, stage: 1, detail: { allow: [] } });
      seed.recordRelogin({ ts: NOW + 1, provider: PROVIDER, accountId: 'a:account', kind: 'wiped' });
      seed.close();
      const env = { QLB_TEST_MODE: '1', QLB_HOME: root, HOME: root, CODEX_HOME: join(root, 'codex') };
      const probe = ctxFor(env, dbPath);
      assert.equal(await command.execute?.(['clear', '--json'], probe.ctx), 0, probe.err.join('\n'));
      const { newestStopId } = JSON.parse(probe.out[0]) as { newestStopId: number };
      const done = ctxFor(env, dbPath);
      assert.equal(await command.execute?.(['clear', '--through', String(newestStopId), '--reason', 'reviewed'], done.ctx), 0, done.err.join('\n'));
      const check = openStore(dbPath);
      try {
        const row = check.readCodexStageLog().events.find((event) => event.kind === 'latch-clear');
        assert.deepEqual([row?.throughId, row?.flagEnabled, row?.buildStamp], [newestStopId, false, readBuildStamp()]);
      } finally { check.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('codex latch admission and ownership', () => {
  it('admits the clear in every phase that admits a Codex switch (KTD15)', () => {
    for (const [state, admittedOps] of Object.entries(PHASE_RULES)) {
      assert.equal(admittedOps.has('codex-latch-clear'), admittedOps.has('switch:manual'), state);
    }
  });

  it('no source file other than the command writes a latch clear or an initialize', () => {
    const srcDir = join(__dirname, '..', '..', 'src');
    const writers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') && /kind: '(latch-clear|initialize)'/.test(readFileSync(path, 'utf8'))) writers.push(path.slice(srcDir.length + 1));
      }
    };
    walk(srcDir);
    assert.deepEqual(writers, ['commands/codex-latch.ts']);
  });

  it('no source file other than the command calls or imports it', () => {
    const srcDir = join(__dirname, '..', '..', 'src');
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') && /codexLatchClear|codex-latch['"]/.test(readFileSync(path, 'utf8'))) callers.push(path.slice(srcDir.length + 1));
      }
    };
    walk(srcDir);
    assert.deepEqual(callers, ['commands/codex-latch.ts']);
  });
});
