import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AUTO_BINDINGS } from '../src/auto';
import type { HealthCheck } from '../src/checks/claude-slots';
import { ClaudeCodeLockTimeout, withCodexAuthLock } from '../src/cc-locks';
import { withCodexSwitchLock } from '../src/codex-consume';
import { evaluateStages } from '../src/codex-stage';
import { readCodexStageInputFrom } from '../src/codex-stop';
import command, {
  CODEX_STAGE_ALLOWABLE_CODES,
  CODEX_STAGE_PREREQUISITES,
  codexStageClose,
  codexStageLocks,
  codexStageStart,
  createCodexStageCommand,
  type CodexStageDeps,
  type CodexStagePrerequisite,
} from '../src/commands/codex-stage';
import { PHASE_RULES } from '../src/lifecycle';
import type { CommandContext } from '../src/registry';
import { openStore, openStoreConnection, type CodexStageEvent, type Store } from '../src/store';

const PROVIDER = 'openai-codex';
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-20T12:00:00.000Z');

const PASS_FIRST: HealthCheck = { name: 'codex:first-switch', level: 'PASS', message: 'C9 receipt recorded' };
const PASS_SLOTS: HealthCheck = { name: 'codex:slots', level: 'PASS', message: 'no dead Codex slots' };
const ALL_PRESENT: CodexStagePrerequisite[] = [
  { name: 'auto-tick-wired', gates: [1, 2], present: true },
  { name: 'decide-and-switch-tick', gates: [2], present: true },
  { name: 'l13-receipt-writer', gates: [], present: true },
];

interface Home { dir: string; dbPath: string; journalDir: string }

function home(phase: string | null = 'cutover'): Home {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-codex-stage-'));
  const dbPath = join(dir, 'qlb.db');
  const store = openStore(dbPath);
  try {
    if (phase !== null) {
      store.runImmediate(() => {
        (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
          .prepare('INSERT INTO lifecycle (state, began_at, cutover_at) VALUES (?, ?, ?)').run(phase, T0 - 10 * DAY, T0 - 9 * DAY);
      });
    }
    store.setConfig('codex.l13VerifiedAt', String(T0 - 8 * DAY));
  } finally { store.close(); }
  return { dir, dbPath, journalDir: join(dir, 'journal') };
}

function deps(h: Home, overrides: Partial<CodexStageDeps> = {}): CodexStageDeps {
  return {
    now: () => T0,
    flagEnabled: true,
    buildStamp: 'build-abc',
    journalDir: h.journalDir,
    prerequisites: ALL_PRESENT,
    runChecks: () => [PASS_SLOTS, PASS_FIRST],
    withLock: codexStageLocks({ home: h.dir }),
    autoLog: () => undefined,
    ...overrides,
  };
}

function events(store: Store): CodexStageEvent[] {
  const log = store.readCodexStageLog();
  assert.equal(log.status, 'readable');
  return log.events;
}

function stageRows(store: Store): CodexStageEvent[] {
  return events(store).filter((event) => event.kind === 'stage-start' || event.kind === 'stage-close');
}

function withStore<T>(h: Home, fn: (store: Store) => Promise<T> | T): Promise<T> {
  const store = openStore(h.dbPath);
  return Promise.resolve(fn(store)).finally(() => store.close());
}

/** Five confirmed manual switches on two local dates, committed after `from`. */
function confirmedManualSwitches(store: Store, from: number, count = 5): number[] {
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = from + 1_000 + (index < 2 ? 0 : DAY) + index * 60_000;
    const id = store.recordSwitch({ ts: at, provider: PROVIDER, toAccount: 'acct-b', trigger: 'manual', outcome: 'ok', committedAt: at });
    store.insertCodexWatchVerdict({ switchId: id, verdict: 'confirmed', now: at + 300_000 });
    ids.push(id);
  }
  return ids;
}

function evaluated(h: Home) {
  const db = openStoreConnection(h.dbPath, true);
  try {
    const input = readCodexStageInputFrom(db);
    assert.ok(input);
    return evaluateStages(input);
  } finally { db.close(); }
}

/** Holds a lock while `during` runs, with the marker call started inside the hold. */
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

function startRow(store: Store, stage: 1 | 2, at: number, detail: unknown = { allow: [] }): number {
  const id = store.appendCodexStageEvent({
    kind: 'stage-start', now: at, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, stage, detail,
  });
  assert.ok(id !== null);
  return id;
}

function closeRow(store: Store, stage: 1 | 2, at: number, frozenStatus: string): number {
  const id = store.appendCodexStageEvent({
    kind: 'stage-close', now: at, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, stage, detail: { frozenStatus },
  });
  assert.ok(id !== null);
  return id;
}

describe('qlb codex stage start', () => {
  it('a Stage 1 start in cutover with the flag on appends one row with build stamp, flag value and allow-list', async () => {
    const h = home();
    await withStore(h, async (store) => {
      const result = await codexStageStart(store, { stage: 1, allow: ['codex:first-switch:receipt-overdue'] }, deps(h));
      assert.equal(result.ok, true);
      const rows = stageRows(store);
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.equal(row.kind, 'stage-start');
      assert.equal(row.stage, 1);
      assert.equal(row.recordedAt, T0);
      assert.equal(row.buildStamp, 'build-abc');
      assert.equal(row.flagEnabled, true);
      assert.equal(row.lifecycleId, 1);
      assert.deepEqual(row.detail, { allow: ['codex:first-switch:receipt-overdue'] });
      assert.deepEqual(result, { ok: true, stage: 1, eventId: row.id, allow: ['codex:first-switch:receipt-overdue'] });
    });
  });

  it('a start outside cutover is refused with the phase', async () => {
    const h = home('cutting-over');
    await withStore(h, async (store) => {
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: [] }, deps(h)), { ok: false, reason: 'phase=cutting-over' });
      assert.equal(stageRows(store).length, 0);
    });
  });

  it('a start with the flag off is refused before anything else is read', async () => {
    const h = home('cutting-over');
    await withStore(h, async (store) => {
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: [] }, deps(h, { flagEnabled: false })), { ok: false, reason: 'flag-off' });
      assert.equal(stageRows(store).length, 0);
    });
  });

  it('a start with an open watch is refused', async () => {
    const h = home();
    await withStore(h, async (store) => {
      const switchId = store.recordSwitch({ ts: T0 - 1_000, provider: PROVIDER, toAccount: 'acct-b', trigger: 'manual', outcome: 'ok' });
      (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
        .prepare('INSERT INTO codex_watch (switch_id, provider, outgoing, target, next_at, until) VALUES (?, ?, ?, ?, ?, ?)')
        .run(switchId, PROVIDER, 'acct-a', 'acct-b', T0, T0 + 300_000);
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: [] }, deps(h)), { ok: false, reason: 'open-watch' });
      assert.equal(stageRows(store).length, 0);
    });
  });

  it('a start while a recovery fence is set is refused', async () => {
    const h = home();
    await withStore(h, async (store) => {
      store.setConfig('codex.recoveryFence', 'not-json');
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: [] }, deps(h)), { ok: false, reason: 'recovery-fence' });
      assert.equal(stageRows(store).length, 0);
    });
  });

  it('a start while latched is refused', async () => {
    const h = home();
    await withStore(h, async (store) => {
      startRow(store, 1, T0 - DAY);
      store.appendCodexStageEvent({
        kind: 'latch-set', now: T0 - 1_000, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, evidence: 'relogin_events:1',
      });
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: [] }, deps(h)), { ok: false, reason: 'latched' });
      assert.equal(stageRows(store).length, 1);
    });
  });

  it('runs the sweep first, so an unrecorded stop since the last start refuses the restart', async () => {
    const h = home();
    await withStore(h, async (store) => {
      startRow(store, 1, T0 - DAY);
      store.recordRelogin({ ts: T0 - 1_000, provider: PROVIDER, accountId: 'acct-a', kind: 'wiped' });
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: [] }, deps(h)), { ok: false, reason: 'latched' });
      assert.equal(events(store).filter((event) => event.kind === 'latch-set').length, 1);
    });
  });

  it('a start while the latch cannot be read is refused', async () => {
    const h = home();
    await withStore(h, async (store) => {
      (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
        .prepare("INSERT INTO codex_stage_events (kind, recorded_at) VALUES ('initialize-required', ?)").run(T0 - 1);
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: [] }, deps(h)), { ok: false, reason: 'latch-unknown' });
    });
  });

  it('a start with a failing precondition is refused and names each one', async () => {
    const h = home();
    await withStore(h, async (store) => {
      store.setConfig('codex.l13VerifiedAt', 'garbage');
      const missing: CodexStagePrerequisite[] = ALL_PRESENT.map((row) => ({ ...row, present: row.name === 'l13-receipt-writer' }));
      const result = await codexStageStart(store, { stage: 1, allow: [] }, deps(h, {
        prerequisites: missing,
        runChecks: () => [PASS_SLOTS, { name: 'codex:first-switch', level: 'WARN', code: 'receipt-invalid', message: 'C9 receipt invalid' }],
      }));
      assert.deepEqual(result, { ok: false, reason: 'precondition-failing', detail: ['codex-first-switch-pass', 'l13-receipt', 'auto-tick-wired'] });
      assert.equal(stageRows(store).length, 0);
    });
  });

  it('a Stage 2 start also needs the decide-and-switch tick; Stage 1 does not', async () => {
    const h = home();
    await withStore(h, async (store) => {
      const noTick = ALL_PRESENT.map((row) => ({ ...row, present: row.name !== 'decide-and-switch-tick' }));
      startRow(store, 1, T0 - 3 * DAY);
      closeRow(store, 1, T0 - DAY, 'pass');
      assert.deepEqual(await codexStageStart(store, { stage: 2, allow: [] }, deps(h, { prerequisites: noTick })),
        { ok: false, reason: 'precondition-failing', detail: ['decide-and-switch-tick'] });
      assert.equal((await codexStageStart(store, { stage: 1, allow: [] }, deps(h, { prerequisites: noTick }))).ok, true);
    });
  });

  it('a WARN off the allow-list refuses the start; the same WARN on it is admitted', async () => {
    const h = home();
    const warn: HealthCheck = { name: 'codex:slots', level: 'WARN', code: 'phase-unavailable', message: 'phase unavailable' };
    await withStore(h, async (store) => {
      const runChecks = (): HealthCheck[] => [warn, PASS_FIRST];
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: [] }, deps(h, { runChecks })),
        { ok: false, reason: 'check-not-allowed', detail: ['codex:slots:phase-unavailable'] });
      assert.equal(stageRows(store).length, 0);
      assert.equal((await codexStageStart(store, { stage: 1, allow: ['codex:slots:phase-unavailable'] }, deps(h, { runChecks }))).ok, true);
    });
  });

  it('a FAIL refuses the start even when its code is on the allow-list', async () => {
    const h = home();
    await withStore(h, async (store) => {
      const runChecks = (): HealthCheck[] => [{ name: 'codex:slots', level: 'FAIL', code: 'dead-slots', message: '1 dead' }, PASS_FIRST];
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: ['codex:slots:dead-slots'] }, deps(h, { runChecks })),
        { ok: false, reason: 'check-fail', detail: ['codex:slots:dead-slots'] });
    });
  });

  it('a Stage 2 start without a Stage 1 pass is refused; with one, the row holds the frozen result and the inherited allow-list', async () => {
    const h = home();
    await withStore(h, async (store) => {
      startRow(store, 1, T0 - 3 * DAY, { allow: ['codex:slots:phase-unavailable'] });
      assert.deepEqual(await codexStageStart(store, { stage: 2, allow: [] }, deps(h)), { ok: false, reason: 'stage-1-not-passed' });
      confirmedManualSwitches(store, T0 - 3 * DAY);
      const result = await codexStageStart(store, { stage: 2, allow: [] }, deps(h));
      assert.equal(result.ok, true);
      const row = stageRows(store).at(-1);
      assert.equal(row?.stage, 2);
      assert.deepEqual(row?.detail, { allow: ['codex:slots:phase-unavailable'], frozenStatus: 'pass' });
    });
  });

  it('refuses to replace an open run of the same or a later stage (owner decision 2026-11-23)', async () => {
    const stage1Open = home();
    await withStore(stage1Open, async (store) => {
      startRow(store, 1, T0 - DAY);
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: [] }, deps(stage1Open)), { ok: false, reason: 'run-open' });
    });
    const stage2Open = home();
    await withStore(stage2Open, async (store) => {
      startRow(store, 1, T0 - 5 * DAY);
      closeRow(store, 1, T0 - 4 * DAY, 'pass');
      startRow(store, 2, T0 - 3 * DAY, { allow: [], frozenStatus: 'pass' });
      assert.deepEqual(await codexStageStart(store, { stage: 1, allow: [] }, deps(stage2Open)), { ok: false, reason: 'run-open' });
      assert.deepEqual(await codexStageStart(store, { stage: 2, allow: [] }, deps(stage2Open)), { ok: false, reason: 'run-open' });
      assert.equal(stageRows(store).length, 3);
    });
  });

  it('restarts a stopped run once the latch is cleared', async () => {
    const h = home();
    await withStore(h, async (store) => {
      startRow(store, 1, T0 - DAY);
      const stop = store.appendCodexStageEvent({
        kind: 'latch-set', now: T0 - 2_000, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, evidence: 'relogin_events:1',
      });
      assert.ok(stop !== null);
      store.appendCodexStageEvent({
        kind: 'latch-clear', now: T0 - 1_000, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, throughId: stop, reason: 'reviewed',
      });
      assert.equal((await codexStageStart(store, { stage: 1, allow: [] }, deps(h))).ok, true);
    });
  });

  it('a Stage 2 start refuses an allow-list of its own: Stage 2 inherits Stage 1\'s', async () => {
    const h = home();
    await withStore(h, async (store) => {
      assert.deepEqual(await codexStageStart(store, { stage: 2, allow: ['codex:slots:dead-slots'] }, deps(h)),
        { ok: false, reason: 'stage-2-inherits-allow-list' });
    });
  });

  it('takes the switch lock before reading the clock, so no switch can be in flight across the start', async () => {
    const h = home();
    let clock = T0;
    await withStore(h, async (store) => {
      const result = await underHeldLock((fn) => withCodexSwitchLock(h.dbPath, fn),
        () => codexStageStart(store, { stage: 1, allow: [] }, deps(h, { now: () => clock })),
        () => {
          // A switch that started before the stage commits while still holding the lock.
          store.recordSwitch({ ts: T0 + 1, provider: PROVIDER, toAccount: 'acct-b', trigger: 'manual', outcome: 'failed', detail: 'wiped' });
          clock = T0 + 5_000;
        });
      assert.equal(result.ok, true);
      const [row] = stageRows(store);
      assert.equal(row.recordedAt, T0 + 5_000, 'the start is stamped after every switch that held the lock');
    });
  });

  it('also waits on the Codex auth lock, so a `codex add` re-login row cannot straddle the start', async () => {
    const h = home();
    let clock = T0;
    await withStore(h, async (store) => {
      const result = await underHeldLock((fn) => withCodexAuthLock({ home: h.dir }, fn),
        () => codexStageStart(store, { stage: 1, allow: [] }, deps(h, { now: () => clock })),
        () => {
          store.recordRelogin({ ts: T0 + 1, provider: PROVIDER, accountId: 'acct-a', kind: 'identity-replaced' });
          clock = T0 + 5_000;
        });
      assert.equal(result.ok, true);
      assert.equal(stageRows(store)[0].recordedAt, T0 + 5_000);
    });
  });
});

describe('qlb codex stage close', () => {
  it('after a pass it freezes pass; a later stop does not change the frozen row', async () => {
    const h = home();
    await withStore(h, async (store) => {
      startRow(store, 1, T0 - 3 * DAY);
      const confirmed = confirmedManualSwitches(store, T0 - 3 * DAY);
      const result = await codexStageClose(store, deps(h));
      assert.equal(result.ok, true);
      const close = stageRows(store).at(-1);
      assert.equal(close?.kind, 'stage-close');
      assert.equal(close?.stage, 1);
      assert.equal(close?.recordedAt, T0);
      assert.equal((close?.detail as { frozenStatus: string }).frozenStatus, 'pass');
      assert.deepEqual((close?.detail as { confirmed: number[] }).confirmed, confirmed);

      store.recordRelogin({ ts: T0 + 1_000, provider: PROVIDER, accountId: 'acct-a', kind: 'wiped' });
      const later = deps(h, { now: () => T0 + 2_000 });
      // The later stop is recorded (the latch stays armed after close) but the close row is untouched.
      assert.deepEqual(await codexStageClose(store, later), { ok: false, reason: 'no-open-run' });
      assert.equal(events(store).filter((event) => event.kind === 'latch-set').length, 1);
      assert.deepEqual(stageRows(store).at(-1), close);
      const { stage1 } = evaluated(h);
      assert.deepEqual([stage1.status, stage1.frozen], ['pass', true], 'the evaluator honours the frozen pass after the stop');
    });
  });

  it('after an unswept stop it freezes stop, stamped after the latch-set the sweep records', async () => {
    const h = home();
    let clock = T0;
    await withStore(h, async (store) => {
      startRow(store, 1, T0 - 3 * DAY);
      confirmedManualSwitches(store, T0 - 3 * DAY);
      const relogin = store.recordRelogin({ ts: T0 - 1_000, provider: PROVIDER, accountId: 'acct-a', kind: 'wiped' });
      const result = await codexStageClose(store, deps(h, { now: () => (clock += 1) }));
      assert.deepEqual(result.ok && result.status, 'stop');
      const latchSet = events(store).find((event) => event.kind === 'latch-set');
      const close = stageRows(store).at(-1);
      assert.ok(latchSet && close);
      assert.ok(close.recordedAt > latchSet.recordedAt, 'the close is never stamped before the stop it follows');
      assert.deepEqual((close.detail as { stops: string[] }).stops, [`relogin_events:${relogin}`]);
    });
  });

  it('takes the switch lock before reading the clock', async () => {
    const h = home();
    let clock = T0;
    await withStore(h, async (store) => {
      startRow(store, 1, T0 - DAY);
      const result = await underHeldLock((fn) => withCodexSwitchLock(h.dbPath, fn),
        () => codexStageClose(store, deps(h, { now: () => clock })),
        () => { clock = T0 + 5_000; });
      assert.equal(result.ok, true);
      assert.equal(stageRows(store).at(-1)?.recordedAt, T0 + 5_000);
    });
  });

  it('records not-yet when the bar is not met', async () => {
    const h = home();
    await withStore(h, async (store) => {
      startRow(store, 1, T0 - 3 * DAY);
      confirmedManualSwitches(store, T0 - 3 * DAY, 2);
      const result = await codexStageClose(store, deps(h));
      assert.deepEqual(result.ok && result.status, 'not-yet');
    });
  });

  it('closes the current stage: the Stage 2 run after a Stage 2 start', async () => {
    const h = home();
    await withStore(h, async (store) => {
      startRow(store, 1, T0 - 5 * DAY);
      closeRow(store, 1, T0 - 4 * DAY, 'pass');
      startRow(store, 2, T0 - 3 * DAY, { allow: [], frozenStatus: 'pass' });
      const result = await codexStageClose(store, deps(h));
      assert.deepEqual(result.ok && [result.stage, result.status], [2, 'not-yet']);
    });
  });

  it('refuses with no stage started, with an open watch, outside cutover, and while the log is unreadable', async () => {
    const none = home();
    await withStore(none, async (store) => assert.deepEqual(await codexStageClose(store, deps(none)), { ok: false, reason: 'no-open-run' }));

    const watched = home();
    await withStore(watched, async (store) => {
      startRow(store, 1, T0 - DAY);
      const switchId = store.recordSwitch({ ts: T0 - 1_000, provider: PROVIDER, toAccount: 'acct-b', trigger: 'manual', outcome: 'ok', committedAt: T0 - 1_000 });
      (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
        .prepare('INSERT INTO codex_watch (switch_id, provider, outgoing, target, next_at, until) VALUES (?, ?, ?, ?, ?, ?)')
        .run(switchId, PROVIDER, 'acct-a', 'acct-b', T0, T0 + 300_000);
      assert.deepEqual(await codexStageClose(store, deps(watched)), { ok: false, reason: 'open-watch' });
    });

    const retired = home('retired');
    await withStore(retired, async (store) => assert.deepEqual(await codexStageClose(store, deps(retired)), { ok: false, reason: 'phase=retired' }));

    const unknown = home();
    await withStore(unknown, async (store) => {
      (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
        .prepare("INSERT INTO codex_stage_events (kind, recorded_at) VALUES ('from-a-newer-build', ?)").run(T0 - 1);
      assert.deepEqual(await codexStageClose(store, deps(unknown)), { ok: false, reason: 'latch-unknown' });
    });
  });
});

describe('qlb codex stage command', () => {
  function ctx(h: Home): { ctx: CommandContext; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out, err,
      ctx: {
        stdout: (line: string) => out.push(line),
        stderr: (line: string) => err.push(line),
        env: { QLB_TEST_MODE: '1' },
        config: { dbPath: h.dbPath },
        knownSecrets: () => [],
      } as unknown as CommandContext,
    };
  }

  it('is registered as `codex stage`', () => {
    assert.equal(command.name, 'codex stage');
  });

  it('refuses while the flag is off, exit 3, before parsing', async () => {
    const h = home();
    const c = ctx(h);
    assert.equal(await createCodexStageCommand({ flagEnabled: false }).execute?.(['start', '--stage', '1'], c.ctx), 3);
    assert.deepEqual(c.err, ['codex stage start refused: flag-off']);
  });

  it('rejects bad arguments and unknown allow-list pairs with exit 2', async () => {
    const h = home();
    const run = async (args: string[]): Promise<number | undefined> =>
      createCodexStageCommand(deps(h)).execute?.(args, ctx(h).ctx);
    assert.equal(await run([]), 2);
    assert.equal(await run(['start']), 2);
    assert.equal(await run(['start', '--stage', '3']), 2);
    assert.equal(await run(['start', '--stage', '1', '--allow', 'codex:slots:not-a-code']), 2);
    assert.equal(await run(['start', '--stage', '1', '--allow', 'relogin:7d:stale']), 2);
    assert.equal(await run(['close', '--stage', '1']), 2);
    assert.equal(await run(['start', '--stage', '1', '--allow', 'codex:slots:dead-slots']), 2, 'a FAIL code is never allowable');
  });

  it('a held Codex lock is a named refusal, not a crash', async () => {
    const h = home();
    const c = ctx(h);
    const busy = createCodexStageCommand(deps(h, { withLock: async () => { throw new ClaudeCodeLockTimeout(h.dir); } }));
    assert.equal(await busy.execute?.(['start', '--stage', '1'], c.ctx), 3);
    assert.deepEqual(c.err, ['codex stage start refused: codex-lock-busy']);
  });

  it('prints the started row as JSON and exits 0', async () => {
    const h = home();
    const c = ctx(h);
    const code = await createCodexStageCommand(deps(h)).execute?.(['start', '--stage', '1', '--allow', 'codex:slots:phase-unavailable', '--json'], c.ctx);
    assert.equal(code, 0, c.err.join('\n'));
    const printed = JSON.parse(c.out[0]) as { ok: boolean; stage: number; allow: string[] };
    assert.deepEqual([printed.ok, printed.stage, printed.allow], [true, 1, ['codex:slots:phase-unavailable']]);
  });

  it('prints a refusal with its reason and exits 3', async () => {
    const h = home('cutting-over');
    const c = ctx(h);
    assert.equal(await createCodexStageCommand(deps(h)).execute?.(['close'], c.ctx), 3);
    assert.deepEqual(c.err, ['codex stage close refused: phase=cutting-over']);
  });
});

describe('codex stage admission, codes and prerequisites', () => {
  it('admits stage start and close in cutover only (KTD15)', () => {
    for (const [state, admitted] of Object.entries(PHASE_RULES)) {
      assert.equal(admitted.has('codex-stage-start'), state === 'cutover', state);
      assert.equal(admitted.has('codex-stage-close'), state === 'cutover', state);
    }
  });

  it('the allowable codes are exactly the WARN codes the two Codex checks can emit', () => {
    const emitted = new Set<string>();
    for (const name of ['codex-slots', 'codex-first-switch']) {
      const source = readFileSync(join(__dirname, '..', '..', 'src', 'checks', `${name}.ts`), 'utf8');
      for (const match of source.matchAll(/level: 'WARN',\s+code: '([a-z-]+)'/g)) emitted.add(`codex:${name.slice('codex-'.length)}:${match[1]}`);
    }
    assert.ok(emitted.size >= 5, 'the source scan still finds the WARN codes');
    assert.deepEqual([...CODEX_STAGE_ALLOWABLE_CODES].sort(), [...emitted].sort());
  });

  it('the auto-tick prerequisite follows AUTO_BINDINGS', () => {
    const autoTick = CODEX_STAGE_PREREQUISITES.find((row) => row.name === 'auto-tick-wired');
    assert.equal(autoTick?.present, (AUTO_BINDINGS as readonly string[]).includes(PROVIDER));
  });

  it('with today\'s code a Stage 1 start is refused on the missing prerequisites', async () => {
    const h = home();
    await withStore(h, async (store) => {
      const result = await codexStageStart(store, { stage: 1, allow: [] }, deps(h, { prerequisites: CODEX_STAGE_PREREQUISITES }));
      assert.deepEqual(result, { ok: false, reason: 'precondition-failing', detail: ['auto-tick-wired'] });
    });
  });
});
