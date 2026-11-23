import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { readCodexAuthStableWithStat, codexFingerprint, type CodexAuthDocument } from '../src/codex-auth';
import { CODEX_NAMED_REFUSALS } from '../src/codex-refusals';
import { importActiveCodexSlot } from '../src/codex-slots';
import {
  CODEX_SWITCH_COMMAND_ENABLED,
  codexSwitchJournalPath,
  runDueCodexWatches,
  switchCodex,
  writeCodexSwitchJournal,
  type CodexSwitchDeps,
  type CodexWatch,
} from '../src/codex-switch';
import { createSwitchOpenAiCodexCommand, defaultSwitchDeps } from '../src/commands/switch-openai-codex';
import { readBuildStamp } from '../src/codex-stop';
import { defaultConfig } from '../src/config';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import type { CommandContext } from '../src/registry';
import { openStore, type CodexStageEvent } from '../src/store';

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

/** A cutover store with slots A and B, A live, and deps for a real switch with the flag on. No stage start is recorded. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-switch-latch-'));
  const store = openStore(join(root, 'qlb.db'));
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare('INSERT INTO lifecycle (state, began_at, cutover_at) VALUES (?, ?, ?)').run('cutover', NOW - 10_000_000, NOW - 9_000_000);
  const keychain = new MockKeychain();
  const authPath = join(root, 'auth.json');
  const a = login('a', 'switch-latch-a');
  const b = login('b', 'switch-latch-b');
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
  const autoLog: string[] = [];
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
    // Skip the foreground checks: the durable watch is what these tests read.
    sleep: async () => { throw new Error('skip foreground checks'); },
    journalOwner: { pid: process.pid, lstart: 'fixture-owner' },
    attempt: `latch-attempt-${tick}`,
    flagEnabled: true,
    buildStamp: 'build-abc',
    lifecycleId: () => 1,
    autoLog: (line) => { autoLog.push(line); },
    ...overrides,
  });
  return { root, store, db, a, b, authPath, deps, autoLog };
}

type Harness = ReturnType<typeof harness>;

function close(h: Harness): void {
  h.store.close();
  rmSync(h.root, { recursive: true, force: true });
}

function stageStart(h: Harness, stage: 1 | 2, at: number = NOW - 1_000): void {
  h.store.appendCodexStageEvent({ kind: 'stage-start', now: at, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, stage,
    detail: stage === 2 ? { allow: [], frozenStatus: 'pass' } : { allow: [] } });
}

const events = (h: Harness): CodexStageEvent[] => h.store.readCodexStageLog().events;
const latchSets = (h: Harness): CodexStageEvent[] => events(h).filter((event) => event.kind === 'latch-set');
const switchRows = (h: Harness): number => (h.db.prepare("SELECT COUNT(*) AS n FROM switch_log WHERE provider = 'openai-codex'").get() as { n: number }).n;
const live = (h: Harness): string => readFileSync(h.authPath, 'utf8');

function wiped(h: Harness, ts: number): number {
  return h.store.recordRelogin({ ts, provider: PROVIDER, accountId: 'a:account', kind: 'wiped' });
}

function watchOf(h: Harness): CodexWatch {
  const row = h.db.prepare(`SELECT w.switch_id, w.outgoing, w.target, w.until, s.trigger, json_extract(s.steps_json, '$.attempt') AS attempt,
    s.published_at FROM codex_watch w JOIN switch_log s ON s.id = w.switch_id`).get() as {
    switch_id: number; outgoing: string; target: string; until: number; trigger: string; attempt: string; published_at: number;
  };
  return { switchId: row.switch_id, outgoing: row.outgoing, target: row.target, trigger: row.trigger, attempt: row.attempt,
    publishedAt: row.published_at, until: row.until, openSessions: [] };
}

/** An A→B attempt killed after its rename: auth.json holds `live`, and only the journal records the attempt. */
function orphanJournal(h: Harness, live: CodexAuthDocument): string {
  const outgoing = readFileSync(h.authPath);
  const outgoingIno = statSync(h.authPath).ino;
  writeFileSync(h.authPath, JSON.stringify(live));
  const journalDir = join(h.root, 'journal');
  writeCodexSwitchJournal({
    v: 2, attemptId: 'orphan-attempt', from: 'a:account', to: 'b:account',
    target: { identity: { chatgpt_user_id: 'b', account_id: 'account' }, fingerprint: codexFingerprint(h.b) },
    adoptingTarget: [], trigger: 'manual', decision: null, openSessions: [],
    outgoing: { sha256: `sha256-file:${createHash('sha256').update(outgoing).digest('hex')}`, inode: outgoingIno },
    publishedAt: NOW - 100, owner: { pid: process.pid, lstart: 'fixture-owner', state: 'released' },
  }, { journalDir });
  return codexSwitchJournalPath({ journalDir });
}

function context(): { ctx: CommandContext; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const home = '/tmp/qlb-codex-switch-latch-command';
  return {
    stdout, stderr,
    ctx: {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
      env: { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: join(home, 'qlb') },
      config: defaultConfig(home), loadConfig: () => defaultConfig(home), home,
      registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    },
  };
}

describe('Codex switch latch check (U7)', () => {
  it('AE2: after a reverted verdict in a Stage 2 run, the next automatic switch is refused as latched and writes no switch_log row', async () => {
    const h = harness();
    try {
      stageStart(h, 2);
      h.store.setConfig('codex.l13VerifiedAt', String(NOW - 2_000));
      const first = await switchCodex(h.deps(), { target: 'b:account', trigger: 'auto' });
      assert.equal(first.outcome, 'ok', JSON.stringify(first));
      const watch = watchOf(h);
      h.store.endCodexWatch({ switchId: watch.switchId, verdict: 'reverted', now: watch.publishedAt + 1 });
      const rows = switchRows(h);

      const next = await switchCodex(h.deps(), { target: 'a:account', trigger: 'auto' });
      assert.equal(next.outcome, 'refused');
      assert.equal(next.reason, 'codex-stop-latched');
      assert.equal(switchRows(h), rows);
      const [stop] = latchSets(h);
      assert.ok(stop, 'the sweep recorded the stop');
      assert.equal(stop.evidence, `codex_watch_verdicts:${watch.switchId}`);
      assert.deepEqual(next.latch, { state: 'set', newestStopId: stop.id, evidence: stop.evidence });
      assert.ok(h.autoLog.some((line) => line.includes(`stop=${stop.id}`)));
    } finally { close(h); }
  });

  it('a manual switch while latched is refused the same way, and the command exits 3 naming the stop and its evidence', async () => {
    const h = harness();
    try {
      stageStart(h, 1);
      const relogin = wiped(h, NOW);
      const before = live(h);
      const run = context();
      const command = createSwitchOpenAiCodexCommand({
        enabled: true,
        openStore: () => openStore(h.store.dbPath),
        makeSwitchDeps: (_ctx, store) => h.deps({ store }),
      });
      assert.equal(await command.execute!(['b:account'], run.ctx), 3);
      const [stop] = latchSets(h);
      assert.equal(stop.evidence, `relogin_events:${relogin}`);
      assert.deepEqual(run.stdout, [
        'Codex switch a:account → b:account: refused: codex-stop-latched',
        `latched by stop ${stop.id} (evidence relogin_events:${relogin}); see qlb codex stage report, then qlb codex latch clear --through ${stop.id} --reason <text>`,
      ]);
      assert.equal(switchRows(h), 0);
      assert.equal(live(h), before);

      const json = context();
      assert.equal(await command.execute!(['b:account', '--json'], json.ctx), 3);
      const receipt = JSON.parse(json.stdout[0]) as Record<string, unknown>;
      assert.equal(receipt.reason, 'codex-stop-latched');
      assert.deepEqual(receipt.latch, { state: 'set', newestStopId: stop.id, evidence: `relogin_events:${relogin}` });
    } finally { close(h); }
  });

  it('a stop committed during beforeFreshenLock is caught by the under-lock check, and nothing is published', async () => {
    const h = harness();
    try {
      stageStart(h, 1);
      const before = live(h);
      let relogin = 0;
      const result = await switchCodex(h.deps({ hooks: { beforeFreshenLock: () => { relogin = wiped(h, NOW + 5); } } }),
        { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'refused');
      assert.equal(result.reason, 'codex-stop-latched');
      assert.ok(relogin > 0);
      assert.equal(latchSets(h)[0]?.evidence, `relogin_events:${relogin}`);
      assert.equal(live(h), before, 'auth.json is unchanged');
      assert.equal(switchRows(h), 0);
      assert.equal(h.store.getCodexActiveLogin(), 'a:account');
    } finally { close(h); }
  });

  it('an open watch still ticks to its verdict while latched', async () => {
    const h = harness();
    try {
      stageStart(h, 1);
      const committed = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(committed.outcome, 'ok');
      const watch = watchOf(h);
      wiped(h, watch.publishedAt + 1);
      const refused = await switchCodex(h.deps(), { target: 'a:account', trigger: 'manual' });
      assert.equal(refused.reason, 'codex-stop-latched');

      await runDueCodexWatches(h.deps({ now: () => watch.until + 1 }), watch.until + 1);
      const verdict = h.store.listCodexWatchVerdicts().find((row) => row.switchId === watch.switchId);
      assert.equal(verdict?.verdict, 'confirmed');
      assert.equal(h.store.hasCodexWatch(watch.switchId), false);
    } finally { close(h); }
  });

  it('the due-watch runner sweeps after its ticks, so a stop from the verdict it wrote is recorded at once', async () => {
    const h = harness();
    try {
      stageStart(h, 1);
      const committed = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(committed.outcome, 'ok');
      const watch = watchOf(h);
      // Codex writes back its own login: the watch ends reverted.
      writeFileSync(h.authPath, JSON.stringify(h.a));
      await runDueCodexWatches(h.deps({ now: () => watch.until + 1 }), watch.until + 1);
      assert.equal(h.store.listCodexWatchVerdicts().find((row) => row.switchId === watch.switchId)?.verdict, 'reverted');
      assert.ok(latchSets(h).some((stop) => stop.evidence === `codex_watch_verdicts:${watch.switchId}`), JSON.stringify(latchSets(h)));
    } finally { close(h); }
  });

  it('an unreadable or uninitialized event log refuses the switch', async () => {
    const h = harness();
    try {
      h.db.prepare("INSERT INTO codex_stage_events (kind, recorded_at, flag_enabled) VALUES ('initialize-required', ?, 0)").run(NOW - 5);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched');
      assert.deepEqual(result.latch, { state: 'unknown', reason: 'initialize-required' });
      assert.equal(switchRows(h), 0);

      h.db.prepare("UPDATE codex_stage_events SET kind = 'not-a-kind'").run();
      const unreadable = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(unreadable.reason, 'codex-stop-latched');
      assert.deepEqual(unreadable.latch, { state: 'unknown', reason: 'unreadable-row' });
      assert.equal(switchRows(h), 0);
    } finally { close(h); }
  });

  it('with no stage start recorded and the flag on, a manual switch behaves as today', async () => {
    const h = harness();
    try {
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'ok', JSON.stringify(result));
      assert.equal(h.store.getCodexActiveLogin(), 'b:account');
      assert.deepEqual(latchSets(h), []);
    } finally { close(h); }
  });

  it('an automatic switch during an open Stage 1 run is refused, and writes nothing', async () => {
    const h = harness();
    try {
      stageStart(h, 1);
      const before = live(h);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'auto' });
      assert.equal(result.outcome, 'refused');
      assert.equal(result.reason, 'codex-auto-outside-stage-2');
      assert.equal(result.latch, undefined);
      assert.equal(switchRows(h), 0);
      assert.equal(live(h), before);
    } finally { close(h); }
  });

  it('an automatic switch after a latch clear with no stage run open is refused', async () => {
    const h = harness();
    try {
      stageStart(h, 2);
      wiped(h, NOW);
      const latched = await switchCodex(h.deps(), { target: 'b:account', trigger: 'auto' });
      assert.equal(latched.reason, 'codex-stop-latched');
      const [stop] = latchSets(h);
      h.store.appendCodexStageEvent({ kind: 'latch-clear', now: NOW + 10, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true,
        throughId: stop.id, reason: 'checked' });
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'auto' });
      assert.equal(result.reason, 'codex-auto-outside-stage-2');
      assert.equal(switchRows(h), 0);
    } finally { close(h); }
  });

  it('with the flag off, a manual or automatic switch is refused, including by default', async () => {
    const h = harness();
    try {
      stageStart(h, 2);
      for (const trigger of ['manual', 'auto']) {
        const result = await switchCodex(h.deps({ flagEnabled: false }), { target: 'b:account', trigger });
        assert.equal(result.reason, 'codex-switch-disabled', trigger);
      }
      assert.equal(switchRows(h), 0);
      // Left unset, the engine follows CODEX_SWITCH_COMMAND_ENABLED (false until the flag-flip PR).
      const { flagEnabled: _omitted, ...defaults } = h.deps();
      const result = await switchCodex(defaults, { target: 'b:account', trigger: 'manual' });
      if (CODEX_SWITCH_COMMAND_ENABLED) assert.notEqual(result.reason, 'codex-switch-disabled');
      else assert.equal(result.reason, 'codex-switch-disabled');
    } finally { close(h); }
  });

  it('a refused switch stops before recovery and preflight: it never reads the live login or settles a journal', async () => {
    const h = harness();
    try {
      stageStart(h, 1);
      wiped(h, NOW);
      // Recovery would commit this orphaned attempt; a latched switch must leave it alone.
      const journal = orphanJournal(h, h.b);
      const readLive = async (): Promise<never> => { throw new Error('preflight must not run'); };
      const latched = await switchCodex(h.deps({ readLive }), { target: 'b:account', trigger: 'manual' });
      assert.equal(latched.reason, 'codex-stop-latched');
      assert.equal(existsSync(journal), true);
      assert.equal(switchRows(h), 0);
      // Unlatched, the same recovery commits it: the journal above was live.
      const control = harness();
      try {
        const controlJournal = orphanJournal(control, control.b);
        await switchCodex(control.deps(), { target: 'b:account', trigger: 'manual' });
        assert.equal(existsSync(controlJournal), false);
        assert.ok(switchRows(control) > 0);
      } finally { close(control); }
      const outside = harness();
      try {
        stageStart(outside, 1);
        const auto = await switchCodex(outside.deps({ readLive }), { target: 'b:account', trigger: 'auto' });
        assert.equal(auto.reason, 'codex-auto-outside-stage-2');
        const disabled = await switchCodex(outside.deps({ readLive, flagEnabled: false }), { target: 'b:account', trigger: 'manual' });
        assert.equal(disabled.reason, 'codex-switch-disabled');
      } finally { close(outside); }
    } finally { close(h); }
  });

  it('a foreground watch that ends in a stop verdict records the stop before the switch returns', async () => {
    const h = harness();
    try {
      stageStart(h, 1);
      // At the first foreground check Codex has written its own login back.
      const result = await switchCodex(h.deps({ sleep: async () => { writeFileSync(h.authPath, JSON.stringify(h.a)); } }),
        { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'reverted-by-codex', JSON.stringify(result));
      assert.ok(latchSets(h).length > 0, 'the stop was recorded by the foreground runner');
    } finally { close(h); }
  });

  it('the command prints only a sweep-shaped evidence pointer, and the initialize guidance for an uninitialized log', async () => {
    const run = async (latch: unknown, json = false) => {
      const out = context();
      const store = { getCodexActiveLogin: () => 'a:account', close: () => {} };
      const command = createSwitchOpenAiCodexCommand({ enabled: true, openStore: () => store as never,
        makeSwitchDeps: () => ({}) as CodexSwitchDeps,
        switchCodex: async () => Object.assign({ outcome: 'refused' as const, reason: 'codex-stop-latched', latch } as never, { from: 'a:account' }) });
      assert.equal(await command.execute!(json ? ['b:account', '--json'] : ['b:account'], out.ctx), 3);
      return out.stdout;
    };
    assert.equal((await run({ state: 'set', newestStopId: 4, evidence: 'switch_log:9 sk-secret' }))[1],
      'latched by stop 4 (evidence unrecognized); see qlb codex stage report, then qlb codex latch clear --through 4 --reason <text>');
    assert.deepEqual(JSON.parse((await run({ state: 'set', newestStopId: 4, evidence: 'switch_log:9 sk-secret' }, true))[0]).latch,
      { state: 'set', newestStopId: 4, evidence: null });
    assert.equal((await run({ state: 'unknown', reason: 'initialize-required' }))[1],
      'the latch state is unknown (initialize-required); see qlb codex stage report, then qlb codex latch clear --initialize --reason <text>');
    assert.equal((await run({ state: 'unknown', reason: 'unreadable-row' }))[1],
      'the latch state is unknown (unreadable-row); see qlb codex stage report');
  });

  it('the production deps carry the command flag, the build stamp and the lifecycle id', () => {
    const h = harness();
    try {
      const deps = defaultSwitchDeps(context().ctx, h.store, { enabled: true });
      assert.equal(deps.flagEnabled, true);
      assert.equal(defaultSwitchDeps(context().ctx, h.store, {}).flagEnabled, CODEX_SWITCH_COMMAND_ENABLED);
      assert.equal(deps.buildStamp, readBuildStamp());
      const id = (h.db.prepare('SELECT id FROM lifecycle').get() as { id: number }).id;
      assert.equal(deps.lifecycleId?.(), id);
    } finally { close(h); }
  });

  it('a stop that this switch\'s own recovery commits refuses the switch before the pre-switch refresh', async () => {
    const h = harness();
    try {
      stageStart(h, 1);
      // Codex wrote its own login back over B before recovery ran.
      orphanJournal(h, login('a', 'switch-latch-a-prime'));
      let freshened = 0;
      const result = await switchCodex(h.deps({ hooks: { beforeFreshenLock: () => { freshened += 1; } } }), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched', JSON.stringify(result));
      assert.equal(freshened, 0);
      assert.ok(latchSets(h).some((stop) => stop.evidence?.startsWith('switch_log:')), JSON.stringify(latchSets(h)));
    } finally { close(h); }
  });

  it('the under-lock check applies the stage gate too: a Stage 1 start during an automatic switch refuses it before publish', async () => {
    const h = harness();
    try {
      stageStart(h, 2);
      h.store.setConfig('codex.l13VerifiedAt', String(NOW - 2_000));
      const before = live(h);
      const result = await switchCodex(h.deps({ hooks: { beforeFreshenLock: () => { stageStart(h, 1, NOW + 5); } } }),
        { target: 'b:account', trigger: 'auto' });
      assert.equal(result.reason, 'codex-auto-outside-stage-2');
      assert.equal(live(h), before);
      assert.equal(switchRows(h), 0);
    } finally { close(h); }
  });

  it('a switch that commits a revert records its stop before it returns', async () => {
    const h = harness();
    try {
      stageStart(h, 1);
      // Codex saves its own login between QLB's rename and the verify read.
      const result = await switchCodex(h.deps({ hooks: { afterRename: () => { writeFileSync(h.authPath, JSON.stringify(login('a', 'switch-latch-a-saved'))); } } }),
        { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'reverted-by-codex', JSON.stringify(result));
      assert.ok(latchSets(h).length > 0);
    } finally { close(h); }
  });

  it('a failing sweep after the due-watch runner does not fail the runner; the next latch check sweeps again', async () => {
    const h = harness();
    try {
      stageStart(h, 1);
      wiped(h, NOW);
      // The real store, except that recording a stop fails.
      const store = Object.create(h.store, { appendCodexStageEvent: { value: () => { throw new Error('disk full'); } } }) as typeof h.store;
      await runDueCodexWatches(h.deps({ store }), NOW);
      assert.deepEqual(latchSets(h), []);
      const refused = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(refused.reason, 'codex-stop-latched');
    } finally { close(h); }
  });

  it('the admission refusals join the named refusal list', () => {
    for (const reason of ['codex-stop-latched', 'codex-switch-disabled', 'codex-auto-outside-stage-2']) {
      assert.ok(CODEX_NAMED_REFUSALS.has(reason), reason);
    }
  });
});
