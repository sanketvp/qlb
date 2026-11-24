import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { codexFirstSwitchCheck } from '../src/checks/codex-first-switch';
import { codexSlotsCheck } from '../src/checks/codex-slots';
import { relogin7dCheck } from '../src/checks/relogin-7d';
import { readCodexAuthStableWithStat, codexFingerprint, type CodexAuthDocument } from '../src/codex-auth';
import { importActiveCodexSlot } from '../src/codex-slots';
import { codexSwitchJournalPath, switchCodex, writeCodexSwitchJournal, type CodexSwitchDeps } from '../src/codex-switch';
import { buildCodexStageReport, codexStageReportText } from '../src/commands/codex-stage-report';
import { createSwitchOpenAiCodexCommand } from '../src/commands/switch-openai-codex';
import { codexStopLatchCheck } from '../src/checks/codex-stop-latch';
import { defaultConfig } from '../src/config';
import { lifecyclePhase } from '../src/lifecycle-read';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import type { CommandContext } from '../src/registry';
import { openStore, type CodexStageEvent } from '../src/store';

const NOW = 1_700_000_000_000;
const PROVIDER = 'openai-codex';
const RECEIPT_INVALID = 'codex:first-switch:receipt-invalid';

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

/**
 * A cutover store (cut over within three days, no C9 receipt, so both Codex
 * checks are quiet) with slots A and B, A live, and deps for a real switch
 * with the flag on. No stage start is recorded.
 */
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-switch-doctor-gate-'));
  const store = openStore(join(root, 'qlb.db'));
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare('INSERT INTO lifecycle (state, began_at, cutover_at) VALUES (?, ?, ?)').run('cutover', NOW - 10_000_000, NOW - 9_000_000);
  const keychain = new MockKeychain();
  const authPath = join(root, 'auth.json');
  const a = login('a', 'doctor-gate-a');
  const b = login('b', 'doctor-gate-b');
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
    attempt: `doctor-gate-attempt-${tick}`,
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

function stageStart(h: Harness, stage: 1 | 2, allow: string[], at: number = NOW - 1_000): number {
  const id = h.store.appendCodexStageEvent({ kind: 'stage-start', now: at, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, stage,
    detail: stage === 2 ? { allow, frozenStatus: 'pass' } : { allow } });
  assert.ok(id !== null);
  return id;
}

function clear(h: Harness, throughId: number, at: number): void {
  h.store.appendCodexStageEvent({ kind: 'latch-clear', now: at, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true,
    throughId, reason: 'checked' });
}

/** An unparsable C9 receipt: `codex:first-switch` WARNs `receipt-invalid`. */
function invalidReceipt(h: Harness): void {
  h.store.setConfig('codex.l13VerifiedAt', 'not-a-receipt');
}

const latchSets = (h: Harness): CodexStageEvent[] => h.store.readCodexStageLog().events.filter((event) => event.kind === 'latch-set');
const switchRows = (h: Harness): number => (h.db.prepare("SELECT COUNT(*) AS n FROM switch_log WHERE provider = 'openai-codex'").get() as { n: number }).n;
const live = (h: Harness): string => readFileSync(h.authPath, 'utf8');
const firstSwitch = (h: Harness) => codexFirstSwitchCheck(h.store.dbPath, lifecyclePhase(h.store.dbPath), NOW);

/** An A→B attempt killed after its rename: auth.json holds B, and only the journal records the attempt. */
function orphanJournal(h: Harness): string {
  const outgoing = readFileSync(h.authPath);
  const outgoingIno = statSync(h.authPath).ino;
  writeFileSync(h.authPath, JSON.stringify(h.b));
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

/** Another process's doctor stop for the same run, recorded between this switch's latch check and its gate. */
function racingStop(h: Harness, startId: number): number {
  const id = h.store.appendCodexStageEvent({ kind: 'latch-set', now: NOW + 50, lifecycleId: 1, buildStamp: 'build-other', flagEnabled: true,
    evidence: `doctor:${RECEIPT_INVALID}@${startId}`, detail: { rule: 'doctor-not-allowed' } });
  assert.ok(id !== null);
  return id;
}

function context(): { ctx: CommandContext; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const home = '/tmp/qlb-codex-switch-doctor-gate-command';
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

describe('pre-switch Codex doctor gate (U9)', () => {
  it('a WARN on the allow-list lets the switch proceed', async () => {
    const h = harness();
    try {
      stageStart(h, 1, [RECEIPT_INVALID]);
      invalidReceipt(h);
      assert.equal(`${firstSwitch(h).name}:${firstSwitch(h).code}`, RECEIPT_INVALID, 'the warning is live');
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'ok', JSON.stringify(result));
      assert.equal(h.store.getCodexActiveLogin(), 'b:account');
      assert.deepEqual(latchSets(h), []);
    } finally { close(h); }
  });

  it('a WARN off the allow-list records one stop and refuses the switch, before anything is written or published', async () => {
    const h = harness();
    try {
      const startId = stageStart(h, 1, []);
      invalidReceipt(h);
      const before = live(h);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'refused');
      assert.equal(result.reason, 'codex-stop-latched');
      const sets = latchSets(h);
      assert.equal(sets.length, 1);
      const [stop] = sets;
      assert.equal(stop.evidence, `doctor:${RECEIPT_INVALID}@${startId}`);
      assert.deepEqual(stop.detail, {
        rule: 'doctor-not-allowed', check: 'codex:first-switch', code: 'receipt-invalid', level: 'WARN', message: 'C9 receipt invalid',
        offending: [RECEIPT_INVALID],
      });
      assert.equal(stop.buildStamp, 'build-abc');
      assert.equal(stop.flagEnabled, true);
      assert.equal(stop.lifecycleId, 1);
      assert.deepEqual(result.latch, { state: 'set', newestStopId: stop.id, evidence: stop.evidence });
      assert.ok(h.autoLog.some((line) => line.startsWith(`codex:stop-latched stop=${stop.id} rule=doctor-not-allowed evidence=${stop.evidence} `)),
        h.autoLog.join('\n'));
      assert.equal(switchRows(h), 0);
      assert.equal(live(h), before);
      assert.equal(h.store.getCodexActiveLogin(), 'a:account');
    } finally { close(h); }
  });

  it('the same warning on the next attempt is refused by the latch and records no second stop', async () => {
    const h = harness();
    try {
      stageStart(h, 1, []);
      invalidReceipt(h);
      await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      const again = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(again.reason, 'codex-stop-latched');
      assert.equal(latchSets(h).length, 1);
      assert.equal(h.autoLog.filter((line) => line.startsWith('codex:stop-latched')).length, 1);
    } finally { close(h); }
  });

  it('after a clear and a new stage start, the same warning records a new stop and latches again', async () => {
    const h = harness();
    try {
      stageStart(h, 1, []);
      invalidReceipt(h);
      await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      const [first] = latchSets(h);
      clear(h, first.id, NOW + 100);
      const restart = stageStart(h, 1, [], NOW + 200);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched');
      const sets = latchSets(h);
      assert.equal(sets.length, 2);
      assert.equal(sets[1].evidence, `doctor:${RECEIPT_INVALID}@${restart}`);
      assert.deepEqual(result.latch, { state: 'set', newestStopId: sets[1].id, evidence: sets[1].evidence });
      assert.equal(switchRows(h), 0);
    } finally { close(h); }
  });

  it('a stop ends the run: after a clear with no new stage start, the gate is skipped', async () => {
    const h = harness();
    try {
      stageStart(h, 1, []);
      invalidReceipt(h);
      await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      const [stop] = latchSets(h);
      clear(h, stop.id, NOW + 100);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'ok', JSON.stringify(result));
      assert.equal(latchSets(h).length, 1);
    } finally { close(h); }
  });

  it('relogin:7d does not stop a Codex switch', async () => {
    const h = harness();
    try {
      stageStart(h, 1, []);
      h.store.recordRelogin({ ts: NOW - 500, provider: 'anthropic', accountId: 'someone', kind: 'dead' });
      assert.notEqual(relogin7dCheck(h.store.dbPath, 'cutover', NOW).level, 'PASS', 'relogin:7d is unhealthy');
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'ok', JSON.stringify(result));
      assert.deepEqual(latchSets(h), []);
    } finally { close(h); }
  });

  it('after stage close, a WARN off the allow-list does not stop the switch', async () => {
    const h = harness();
    try {
      stageStart(h, 1, []);
      h.store.appendCodexStageEvent({ kind: 'stage-close', now: NOW - 500, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true,
        stage: 1, detail: { frozenStatus: 'not-yet' } });
      invalidReceipt(h);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'ok', JSON.stringify(result));
      assert.deepEqual(latchSets(h), []);
    } finally { close(h); }
  });

  it('with no stage start, a WARN off any allow-list does not stop the switch', async () => {
    const h = harness();
    try {
      invalidReceipt(h);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'ok', JSON.stringify(result));
      assert.deepEqual(latchSets(h), []);
    } finally { close(h); }
  });

  it('a Stage 2 run reads the allow-list its start row carries', async () => {
    const h = harness();
    try {
      stageStart(h, 1, [RECEIPT_INVALID], NOW - 2_000);
      stageStart(h, 2, [RECEIPT_INVALID]);
      invalidReceipt(h);
      const allowed = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(allowed.outcome, 'ok', JSON.stringify(allowed));
      assert.deepEqual(latchSets(h), []);
    } finally { close(h); }
  });

  it('the latest start row\'s allow-list governs, not an earlier run\'s', async () => {
    const h = harness();
    try {
      stageStart(h, 1, [RECEIPT_INVALID], NOW - 2_000);
      const stage2 = stageStart(h, 2, []);
      invalidReceipt(h);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched');
      assert.equal(latchSets(h)[0]?.evidence, `doctor:${RECEIPT_INVALID}@${stage2}`);
    } finally { close(h); }
  });

  it('a FAIL stops the switch even when its pair is on the allow-list', async () => {
    const h = harness();
    try {
      const startId = stageStart(h, 1, ['codex:slots:dead-slots']);
      h.db.prepare("UPDATE codex_slots SET dead = 1, dead_reason = 'fixture' WHERE account_id = 'a:account'").run();
      assert.equal(codexSlotsCheck(h.store.dbPath, 'cutover').level, 'FAIL', 'the failure is live');
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched');
      const [stop] = latchSets(h);
      assert.equal(stop.evidence, `doctor:codex:slots:dead-slots@${startId}`);
      assert.equal((stop.detail as { level: string }).level, 'FAIL');
      assert.equal(switchRows(h), 0);
    } finally { close(h); }
  });

  it('an allow-list that is not a list of strings allows nothing', async () => {
    const h = harness();
    try {
      h.store.appendCodexStageEvent({ kind: 'stage-start', now: NOW - 1_000, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true,
        stage: 1, detail: { allow: RECEIPT_INVALID } });
      invalidReceipt(h);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched');
      assert.equal(latchSets(h).length, 1);
    } finally { close(h); }
  });

  it('a stop already recorded in the run leaves the gate to the latch: no doctor stop joins a sweep stop', async () => {
    const h = harness();
    try {
      stageStart(h, 1, []);
      invalidReceipt(h);
      const relogin = h.store.recordRelogin({ ts: NOW, provider: PROVIDER, accountId: 'a:account', kind: 'wiped' });
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched');
      assert.deepEqual(latchSets(h).map((event) => event.evidence), [`relogin_events:${relogin}`]);
    } finally { close(h); }
  });

  it('a stop another process recorded for the same warning in the same run is not recorded twice, and the switch reports it', async () => {
    const h = harness();
    try {
      const startId = stageStart(h, 1, []);
      invalidReceipt(h);
      let other = 0;
      const result = await switchCodex(h.deps({ hooks: { beforeDoctorGate: () => { other = racingStop(h, startId); } } }),
        { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched');
      assert.deepEqual(latchSets(h).map((event) => event.id), [other]);
      assert.deepEqual(result.latch, { state: 'set', newestStopId: other, evidence: `doctor:${RECEIPT_INVALID}@${startId}` });
      assert.deepEqual(h.autoLog.filter((line) => line.startsWith('codex:stop-latched')), []);
      assert.equal(switchRows(h), 0);
    } finally { close(h); }
  });

  it('when the latch does not read as set after the gate\'s stop, the switch still refuses, as latch unknown', async () => {
    const h = harness();
    try {
      const startId = stageStart(h, 1, []);
      invalidReceipt(h);
      // The gate's first clock read comes after it read the log: another process records this stop and the owner clears it there.
      let armed = false;
      let tick = NOW + 1_000;
      const now = (): number => {
        if (armed) { armed = false; clear(h, racingStop(h, startId), NOW + 60); }
        return tick++;
      };
      const result = await switchCodex(h.deps({ now, hooks: { beforeDoctorGate: () => { armed = true; } } }),
        { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched');
      assert.deepEqual(result.latch, { state: 'unknown', reason: 'doctor-gate' });
      assert.equal(switchRows(h), 0);
    } finally { close(h); }
  });

  it('a gate refusal comes before recovery and preflight: it never reads the live login or settles a journal', async () => {
    const h = harness();
    try {
      stageStart(h, 1, []);
      invalidReceipt(h);
      const journal = orphanJournal(h);
      const readLive = async (): Promise<never> => { throw new Error('preflight must not run'); };
      const result = await switchCodex(h.deps({ readLive }), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched');
      assert.equal(latchSets(h).length, 1);
      assert.equal(existsSync(journal), true);
      assert.equal(switchRows(h), 0);
    } finally { close(h); }
  });

  it('an automatic switch in a Stage 2 run is stopped by a WARN off the allow-list', async () => {
    const h = harness();
    try {
      const startId = stageStart(h, 2, []);
      invalidReceipt(h);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'auto' });
      assert.equal(result.reason, 'codex-stop-latched');
      assert.equal(latchSets(h)[0]?.evidence, `doctor:${RECEIPT_INVALID}@${startId}`);
    } finally { close(h); }
  });

  it('only a close of the open run\'s own stage ends it', async () => {
    const h = harness();
    try {
      stageStart(h, 1, [], NOW - 2_000);
      const stage2 = stageStart(h, 2, []);
      h.store.appendCodexStageEvent({ kind: 'stage-close', now: NOW - 500, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true,
        stage: 1, detail: { frozenStatus: 'not-yet' } });
      invalidReceipt(h);
      const result = await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-stop-latched');
      assert.equal(latchSets(h)[0]?.evidence, `doctor:${RECEIPT_INVALID}@${stage2}`);
    } finally { close(h); }
  });

  it('an unreadable lifecycle phase refuses the switch without recording a stop', async () => {
    const h = harness();
    try {
      stageStart(h, 1, []);
      const dbPath = join(h.root, 'missing.db');
      assert.equal(lifecyclePhase(dbPath).available, false, 'the phase is unreadable');
      const result = await switchCodex(h.deps({ dbPath }), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.outcome, 'refused');
      assert.equal(result.reason, 'codex-doctor-gate-unavailable');
      assert.equal(result.latch, undefined);
      assert.deepEqual(latchSets(h), []);
      assert.equal(switchRows(h), 0);
    } finally { close(h); }
  });

  it('a check that throws refuses the switch without recording a stop', async () => {
    const h = harness();
    try {
      stageStart(h, 1, []);
      const dbPath = join(h.root, 'no-slots.db');
      h.db.exec(`VACUUM INTO '${dbPath}'`);
      const copy = openStore(dbPath);
      try { (copy as unknown as { db: DatabaseSync }).db.exec('DROP TABLE codex_slots'); } finally { copy.close(); }
      assert.equal(codexSlotsCheck(dbPath, 'cutover').code, 'check-threw', 'the check throws');
      const result = await switchCodex(h.deps({ dbPath }), { target: 'b:account', trigger: 'manual' });
      assert.equal(result.reason, 'codex-doctor-gate-unavailable');
      assert.deepEqual(latchSets(h), []);
      assert.equal(switchRows(h), 0);
    } finally { close(h); }
  });

  it('every offending pair is kept on the stop row', async () => {
    const h = harness();
    try {
      stageStart(h, 1, []);
      invalidReceipt(h);
      h.db.prepare("UPDATE codex_slots SET dead = 1, dead_reason = 'fixture' WHERE account_id = 'a:account'").run();
      await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      const [stop] = latchSets(h);
      assert.equal(stop.evidence?.startsWith('doctor:codex:slots:dead-slots@'), true);
      assert.deepEqual((stop.detail as { offending: string[] }).offending, ['codex:slots:dead-slots', RECEIPT_INVALID]);
    } finally { close(h); }
  });

  it('the stage report and the codex:stop-latch doctor check name a doctor-gate stop from its row', async () => {
    const h = harness();
    try {
      const startId = stageStart(h, 1, []);
      invalidReceipt(h);
      await switchCodex(h.deps(), { target: 'b:account', trigger: 'manual' });
      const [stop] = latchSets(h);
      const pointer = `doctor:${RECEIPT_INVALID}@${startId}`;
      const built = buildCodexStageReport(h.store.dbPath, { now: () => NOW + 10_000, knownSecrets: [] });
      assert.ok(built.ok, JSON.stringify(built));
      const [reported] = built.report.latch.stops;
      assert.equal(reported.evidence, pointer);
      assert.equal(reported.rule, 'doctor-not-allowed');
      assert.deepEqual(reported.row, { table: 'doctor', check: 'codex:first-switch', code: 'receipt-invalid', level: 'WARN', stageStartId: startId });
      assert.ok(codexStageReportText(built.report).some((line) => line.includes(
        `doctor-not-allowed, ${pointer} — doctor check codex:first-switch WARN receipt-invalid in the run started by event ${startId}`)));
      const latch = codexStopLatchCheck(h.store.dbPath);
      assert.equal(latch.code, 'latched');
      assert.match(latch.message, new RegExp(`stop ${stop.id} \\(evidence ${pointer}\\)`));
    } finally { close(h); }
  });

  it('the report shows an unknown level on a doctor stop row as unrecognized', () => {
    const h = harness();
    try {
      const startId = stageStart(h, 1, []);
      h.store.appendCodexStageEvent({ kind: 'latch-set', now: NOW, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true,
        evidence: `doctor:codex:slots:dead-slots@${startId}`, detail: { rule: 'doctor-not-allowed', level: 'sk-not-a-level' } });
      const built = buildCodexStageReport(h.store.dbPath, { now: () => NOW + 10_000, knownSecrets: [] });
      assert.ok(built.ok);
      assert.equal((built.report.latch.stops[0].row as { level: string }).level, 'unrecognized');
    } finally { close(h); }
  });

  it('the command prints a doctor-gate evidence pointer, and still hides anything else', async () => {
    const run = async (latch: unknown, json = false) => {
      const out = context();
      const store = { getCodexActiveLogin: () => 'a:account', close: () => {} };
      const command = createSwitchOpenAiCodexCommand({ enabled: true, openStore: () => store as never,
        makeSwitchDeps: () => ({}) as CodexSwitchDeps,
        switchCodex: async () => Object.assign({ outcome: 'refused' as const, reason: 'codex-stop-latched', latch } as never, { from: 'a:account' }) });
      assert.equal(await command.execute!(json ? ['b:account', '--json'] : ['b:account'], out.ctx), 3);
      return out.stdout;
    };
    const pointer = `doctor:${RECEIPT_INVALID}@3`;
    assert.equal((await run({ state: 'set', newestStopId: 4, evidence: pointer }))[1],
      `latched by stop 4 (evidence ${pointer}); see qlb codex stage report, then qlb codex latch clear --through 4 --reason <text>`);
    assert.deepEqual(JSON.parse((await run({ state: 'set', newestStopId: 4, evidence: pointer }, true))[0]).latch,
      { state: 'set', newestStopId: 4, evidence: pointer });
    for (const evidence of [`${pointer} sk-secret`, 'doctor:codex:slots:Dead@3', 'doctor:claude:slots:dead-slots@3', 'doctor:codex:slots@3']) {
      assert.match((await run({ state: 'set', newestStopId: 4, evidence }))[1], /\(evidence unrecognized\)/, evidence);
    }
  });
});
