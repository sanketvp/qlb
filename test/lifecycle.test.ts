import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  CUTOVER_BEGIN_IN_PROGRESS,
  PHASE_RULES,
  RETIREMENT_IN_PROGRESS,
  assertAdmitted,
  beginCutover,
  beginRetirementFence,
  clearRetirementFence,
  commitCutover,
  extendWindow,
  isOperational,
  lifecycleCheck,
  markDrillDone,
  phase,
  retirementLockPath,
  transition,
  withRetirementMutationLock,
  closeLifecycle,
} from '../src/lifecycle';
import { cutoverBegin } from '../src/commands/cutover';
import { openStore } from '../src/store';
import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
import { gateLifecycleAdmissionCode, runExecutingCommand } from '../src/cli';
import type { CswapAgent } from '../src/cswap-agent';

function fixtureStore() {
  return openStore(join(mkdtempSync(join(tmpdir(), 'qlb-lifecycle-')), 'qlb.db'));
}

// @ts-expect-error S57 requires every CswapAgent to implement drain.
const agentMissingDrain: CswapAgent = {
  bootout: () => ({ ok: true }),
  disable: () => ({ ok: true }),
  movePlist: () => ({ ok: true }),
  restorePlist: () => ({ ok: true }),
};
void agentMissingDrain;

function prepareCommit(store: ReturnType<typeof openStore>): void {
  insertClaudeImport(store);
  store.recordSwitch({ provider: 'anthropic', fromAccount: 'claude-a', toAccount: 'claude-b', trigger: 'manual', outcome: 'ok' });
  store.recordSwitch({ provider: 'anthropic', fromAccount: 'claude-b', toAccount: 'claude-a', trigger: 'manual', outcome: 'ok' });
  store.setConfig('keychain.liveItemsAuthorizedAt', '1');
  for (const provider of ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter']) {
    store.setConfig(`pi.${provider}.state`, 'migrated');
  }
}

function insertClaudeImport(store: ReturnType<typeof openStore>): void {
  const db = new DatabaseSync(store.dbPath);
  try {
    db.prepare(`INSERT INTO claude_slots (account_id, slot_num, config_json, added_at)
      VALUES (?, ?, ?, ?)`).run('claude-a', 1, '{}', Date.now());
  } finally { db.close(); }
}

describe('lifecycle (AC49)', () => {
  it('starts one durable cutover and SQLite itself rejects a second open row', () => {
    const store = fixtureStore();
    try {
      const started = beginCutover(store, 1_000);
      assert.equal(started.state, 'cutting-over');
      assert.equal(phase(store).state, 'cutting-over');
      assert.throws(() => beginCutover(store, 2_000), /SQLITE_CONSTRAINT/);
    } finally { store.close(); }
  });

  it('uses the injected C-swap agent seam and fails closed when the K13 stub is unavailable', async () => {
    const store = fixtureStore();
    try {
      const calls: string[] = [];
      const success = await cutoverBegin(store.dbPath, {
        bootout: () => { calls.push('bootout'); return { ok: true }; },
        disable: () => { calls.push('disable'); return { ok: true }; },
        movePlist: () => { calls.push('move'); return { ok: true }; },
        restorePlist: () => { calls.push('restore'); return { ok: true }; },
        drain: () => { calls.push('drain'); return { ok: true }; },
      });
      assert.deepEqual(calls, ['bootout', 'disable', 'move', 'drain']);
      assert.deepEqual(success, { ok: true, state: 'cutting-over' });
    } finally { store.close(); }

    const failedStore = fixtureStore();
    try {
      const failed = await cutoverBegin(failedStore.dbPath);
      assert.equal(failed.ok, false);
      // The fail-closed stub cannot restore a possibly changed external state.
      assert.equal(failed.state, 'cutting-over');
      assert.equal(failed.code, 'cswap-restore-failed');
    } finally { failedStore.close(); }
  });

  it('evaluates legacy gate admission against --db without creating the default database', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-gate-admission-'));
    const defaultDb = join(root, 'default.db');
    const targetDb = join(root, 'target.db');
    const target = openStore(targetDb);
    try { beginCutover(target); } finally { target.close(); }

    assert.equal(gateLifecycleAdmissionCode(targetDb, defaultDb), null);
    assert.equal(existsSync(defaultDb), false);

    const defaultStore = openStore(defaultDb);
    try { beginCutover(defaultStore); } finally { defaultStore.close(); }
    const preCutoverDb = join(root, 'pre-cutover.db');
    assert.equal(gateLifecycleAdmissionCode(preCutoverDb, defaultDb), 'phase=pre-cutover');
    assert.equal(existsSync(preCutoverDb), true);
  });

  it('uses the §4.15 table for admission, including normal operation after retirement', () => {
    const store = fixtureStore();
    try {
      assert.equal(assertAdmitted(store, 'gate').code, 'phase=pre-cutover');
      assert.equal(assertAdmitted(store, 'cutover-begin').ok, true);
      beginCutover(store);
      assert.equal(assertAdmitted(store, 'switch:manual').ok, true);
      assert.equal(assertAdmitted(store, 'auto').code, 'phase=cutting-over');
      assert.equal(assertAdmitted(store, 'auto:dry-run').ok, true);
      const db = new DatabaseSync(store.dbPath);
      try { db.prepare("UPDATE lifecycle SET state = 'retired'").run(); } finally { db.close(); }
      assert.equal(isOperational(phase(store).state), true);
      assert.equal(assertAdmitted(store, 'gate').ok, true);
      assert.equal(assertAdmitted(store, 'switch:manual').ok, true);
      assert.equal(assertAdmitted(store, 'auto').ok, true);
      assert.equal(assertAdmitted(store, 'pi-migrate').code, 'phase=retired');
      assert.ok(PHASE_RULES.retired.has('gate'));
    } finally { store.close(); }
  });

  it('retirement fence refuses only undo-cswap, undo-cswap:resume, pi-rollback and retire-cswap', () => {
    const store = fixtureStore();
    try {
      beginCutover(store);
      const db = new DatabaseSync(store.dbPath);
      try { db.prepare("UPDATE lifecycle SET state = 'cutover', note = ?").run(RETIREMENT_IN_PROGRESS); } finally { db.close(); }
      for (const operation of ['gate', 'switch:manual', 'switch:auto', 'auto', 'report-cutover', 'claude-add', 'doctor', 'status', 'retire-cswap:resume'] as const) {
        assert.equal(assertAdmitted(store, operation).ok, true, operation);
      }
      for (const operation of ['undo-cswap', 'undo-cswap:resume', 'pi-rollback', 'retire-cswap'] as const) {
        assert.equal(assertAdmitted(store, operation).code, RETIREMENT_IN_PROGRESS, operation);
      }
    } finally { store.close(); }
  });

  it('retire-cswap:resume is admitted in cutover and retired without a fence', () => {
    const store = fixtureStore();
    try {
      beginCutover(store);
      const db = new DatabaseSync(store.dbPath);
      try { db.prepare("UPDATE lifecycle SET state = 'cutover'").run(); } finally { db.close(); }
      assert.equal(assertAdmitted(store, 'retire-cswap:resume').ok, true);
      const retired = new DatabaseSync(store.dbPath);
      try { retired.prepare("UPDATE lifecycle SET state = 'retired'").run(); } finally { retired.close(); }
      assert.equal(assertAdmitted(store, 'retire-cswap:resume').ok, true);
    } finally { store.close(); }
  });

  it('clearRetirementFence refuses outside retired-with-fence', () => {
    const store = fixtureStore();
    try {
      beginCutover(store);
      assert.equal(beginRetirementFence(store).ok, false);
      const db = new DatabaseSync(store.dbPath);
      try { db.prepare("UPDATE lifecycle SET state = 'cutover'").run(); } finally { db.close(); }
      assert.equal(beginRetirementFence(store).ok, true);
      assert.equal(beginRetirementFence(store).ok, true, 'idempotent');
      assert.equal(clearRetirementFence(store).code, 'retirement-fence-state-lost');
      const retired = new DatabaseSync(store.dbPath);
      try { retired.prepare("UPDATE lifecycle SET state = 'retired'").run(); } finally { retired.close(); }
      assert.equal(clearRetirementFence(store).ok, true);
      assert.equal(phase(store).note, null);
      assert.equal(clearRetirementFence(store).code, 'retirement-fence-state-lost');
    } finally { store.close(); }
  });

  it('withRetirementMutationLock refuses with retirement-locked when the lock dir has no owner file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-retirement-lock-'));
    const lockPath = retirementLockPath(join(root, '.qlb'));
    mkdirSync(lockPath, { recursive: true });
    let called = false;
    await assert.rejects(
      withRetirementMutationLock(lockPath, async () => { called = true; }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'retirement-locked');
        assert.match(error instanceof Error ? error.message : String(error), new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      },
    );
    assert.equal(called, false);
  });

  it('refuses a disallowed operation through the executing CLI dispatch path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-lifecycle-cli-'));
    const config = defaultConfig(home);
    const stderr: string[] = [];
    let executed = false;
    const code = await runExecutingCommand({ command: { name: 'gate', execute: async () => { executed = true; return 0; } }, args: ['anthropic'] }, {
      config, env: {}, home, stdout: () => {}, stderr: (message) => stderr.push(message),
      loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => ['phase=pre-cutover'],
    });
    assert.equal(code, 3);
    assert.equal(executed, false);
    assert.match(stderr[0]!, /\[redacted\]/);
    assert.doesNotMatch(stderr[0]!, /phase=pre-cutover/);
  });

  it('refuses a second begin with an open row as a lifecycle refusal', async () => {
    const store = fixtureStore();
    try {
      const agent = {
        bootout: () => ({ ok: true }), disable: () => ({ ok: true }), movePlist: () => ({ ok: true }),
        restorePlist: () => ({ ok: true }),
        drain: () => ({ ok: true }),
      };
      assert.equal((await cutoverBegin(store.dbPath, agent)).ok, true);
      const second = await cutoverBegin(store.dbPath, agent);
      assert.deepEqual(second, { ok: false, code: 'phase=cutting-over', state: 'cutting-over' });
    } finally { store.close(); }
  });

  it('refuses commit until import, a manual ok round-trip, live authorization, and every Pi state are present', () => {
    const store = fixtureStore();
    try {
      beginCutover(store, 10);
      assert.equal(commitCutover(store, { now: 20 }).code, 'import-not-complete');
      insertClaudeImport(store);
      assert.equal(commitCutover(store, { now: 20 }).code, 'manual-round-trip-required');
      store.recordSwitch({ provider: 'anthropic', fromAccount: 'claude-a', toAccount: 'claude-b', trigger: 'manual', outcome: 'ok' });
      store.recordSwitch({ provider: 'anthropic', fromAccount: 'claude-b', toAccount: 'claude-a', trigger: 'manual', outcome: 'ok' });
      assert.equal(commitCutover(store, { now: 20 }).code, 'keychain-live-items-not-authorized');
      store.setConfig('keychain.liveItemsAuthorizedAt', '19');
      assert.equal(commitCutover(store, { now: 20 }).code, 'pi-state-missing:anthropic');
      for (const provider of ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter']) {
        store.setConfig(`pi.${provider}.state`, 'migrated');
      }
      assert.equal(commitCutover(store, { now: 20, releaseSha: 'fixture' }).ok, true);
      const row = phase(store);
      assert.equal(row.state, 'cutover');
      assert.equal(row.windowEnd, 20 + 7 * 24 * 60 * 60 * 1000);
    } finally { store.close(); }
  });

  it('fails closed for missing or stale Pi session evidence only when a shared target exists', () => {
    const store = fixtureStore();
    try {
      beginCutover(store, 10);
      insertClaudeImport(store);
      store.recordSwitch({ provider: 'anthropic', fromAccount: 'a', toAccount: 'b', trigger: 'manual', outcome: 'ok' });
      store.recordSwitch({ provider: 'anthropic', fromAccount: 'b', toAccount: 'a', trigger: 'manual', outcome: 'ok' });
      store.setConfig('keychain.liveItemsAuthorizedAt', '1');
      for (const provider of ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter']) store.setConfig(`pi.${provider}.state`, 'migrated');
      const db = new DatabaseSync(store.dbPath);
      try { db.prepare('INSERT INTO pi_export_targets (provider, target, slot_account_id, lineage_fp, recorded_at) VALUES (?, ?, ?, ?, ?)')
        .run('anthropic', 'pool', 'a', 'fp', 1); } finally { db.close(); }
      assert.equal(commitCutover(store).code, 'pi-stale-sessions-unknown');
      for (const malformed of ['', 'abc', '-1', '01', 'tru']) {
        store.setConfig('pi.staleSessionCount', malformed);
        assert.equal(commitCutover(store).code, 'pi-stale-sessions-unknown', malformed);
      }
      store.setConfig('pi.staleSessionCount', '1');
      assert.equal(commitCutover(store).code, 'pi-stale-sessions-shared');
      store.setConfig('pi.staleSessionCount', '0');
      assert.equal(commitCutover(store).ok, true);
    } finally { store.close(); }
  });

  it('emits lifecycle window and drill WARNs through qlb doctor', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-lifecycle-doctor-'));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    try {
      beginCutover(store, 1);
      const db = new DatabaseSync(store.dbPath);
      try { db.prepare("UPDATE lifecycle SET state = 'cutover', window_end = ?").run(1); } finally { db.close(); }
    } finally { store.close(); }
    const report = await doctorQlb(config, { command: () => '', hostCommand: () => '' });
    assert.deepEqual(report.checks.find((check) => check.name === 'lifecycle:window'),
      { name: 'lifecycle:window', level: 'WARN', message: 'cutover window has ended; run report cutover' });
    assert.deepEqual(report.checks.find((check) => check.name === 'lifecycle:drill'),
      { name: 'lifecycle:drill', level: 'WARN', message: 'cutover fire drill is not recorded' });
  });

  it('persists the undo and retirement transition timestamps and only reopens after lifecycle close', () => {
    const store = fixtureStore();
    try {
      beginCutover(store, 10);
      assert.equal(transition(store, 'aborted', 20).ok, true);
      const aborted = phase(store);
      assert.equal(aborted.rollbackAt, 20);
      assert.throws(() => beginCutover(store, 30), /SQLITE_CONSTRAINT/);
      assert.equal(closeLifecycle(store, aborted.id, 'fixture', 40).ok, true);
      assert.equal(phase(store).state, 'pre-cutover');
      assert.equal(beginCutover(store, 50).state, 'cutting-over');
    } finally { store.close(); }
  });

  it('refuses commit while begin is paused and aborts a failed begin after restoring the plist', async () => {
    const store = fixtureStore();
    try {
      prepareCommit(store);
      let releaseBootout!: () => void;
      const bootoutReleased = new Promise<void>((resolve) => { releaseBootout = resolve; });
      let startedBootout!: () => void;
      const bootoutStarted = new Promise<void>((resolve) => { startedBootout = resolve; });
      const begin = cutoverBegin(store.dbPath, {
        bootout: async () => { startedBootout(); await bootoutReleased; return { ok: true }; },
        disable: () => ({ ok: true }), movePlist: () => ({ ok: true }), restorePlist: () => ({ ok: true }),
        drain: () => ({ ok: true }),
      });
      await bootoutStarted;
      for (const operation of ['import-cswap', 'pi-migrate', 'pi-rollback', 'switch:manual', 'gate', 'cutover-commit', 'cutover-abort'] as const) {
        assert.equal(assertAdmitted(store, operation).code, 'cutover-begin-in-progress', operation);
      }
      assert.equal(gateLifecycleAdmissionCode(store.dbPath, store.dbPath), 'cutover-begin-in-progress');
      assert.equal(commitCutover(store).code, 'cutover-begin-in-progress');
      assert.equal(assertAdmitted(store, 'status').ok, true);
      assert.equal(assertAdmitted(store, 'doctor').ok, true);
      releaseBootout();
      assert.deepEqual(await begin, { ok: true, state: 'cutting-over' });
      for (const operation of ['import-cswap', 'pi-migrate', 'pi-rollback', 'switch:manual', 'gate'] as const) {
        assert.equal(assertAdmitted(store, operation).ok, true, operation);
      }
    } finally { store.close(); }

    const failedStore = fixtureStore();
    try {
      let restored = false;
      const result = await cutoverBegin(failedStore.dbPath, {
        bootout: () => ({ ok: false, code: 'bootout-failed' }),
        disable: () => ({ ok: true }), movePlist: () => ({ ok: true }),
        restorePlist: () => { restored = true; return { ok: true }; },
        drain: () => ({ ok: true }),
      });
      assert.equal(restored, true);
      assert.deepEqual(result, { ok: false, code: 'bootout-failed', state: 'aborted' });
      assert.equal(phase(failedStore).state, 'aborted');
      assert.notEqual(phase(failedStore).note, CUTOVER_BEGIN_IN_PROGRESS);
    } finally { failedStore.close(); }
  });

  it('uses compare-and-set transitions so a competing transition is refused', () => {
    const store = fixtureStore();
    try {
      beginCutover(store, 10);
      const db = new DatabaseSync(store.dbPath);
      try { db.prepare("UPDATE lifecycle SET state = 'cutover'").run(); } finally { db.close(); }
      // The first contender wins; the second cannot overwrite its result.
      assert.equal(transition(store, 'retired', 20).ok, true);
      assert.equal(transition(store, 'undoing', 21).ok, false);
      assert.equal(phase(store).state, 'retired');
    } finally { store.close(); }
  });

  it('enforces the one permitted +14-day extension and records the fire drill', () => {
    const store = fixtureStore();
    try {
      beginCutover(store, 0);
      insertClaudeImport(store);
      store.recordSwitch({ provider: 'anthropic', fromAccount: 'a', toAccount: 'b', trigger: 'manual', outcome: 'ok' });
      store.recordSwitch({ provider: 'anthropic', fromAccount: 'b', toAccount: 'a', trigger: 'manual', outcome: 'ok' });
      store.setConfig('keychain.liveItemsAuthorizedAt', '1');
      for (const provider of ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter']) store.setConfig(`pi.${provider}.state`, 'migrated');
      assert.equal(commitCutover(store, { now: 1 }).ok, true);
      const initial = phase(store).windowEnd!;
      assert.equal(extendWindow(store, initial).ok, true);
      assert.equal(phase(store).windowEnd, 1 + 14 * 24 * 60 * 60 * 1000);
      assert.equal(extendWindow(store, initial).code, 'window-already-extended');
      assert.equal(markDrillDone(store, initial).ok, true);
      assert.equal(lifecycleCheck(store, 'drill').level, 'PASS');
    } finally { store.close(); }
  });
});
