import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  PHASE_RULES,
  assertAdmitted,
  beginCutover,
  commitCutover,
  extendWindow,
  isOperational,
  lifecycleCheck,
  markDrillDone,
  phase,
  transition,
  closeLifecycle,
} from '../src/lifecycle';
import { cutoverBegin } from '../src/commands/cutover';
import { openStore } from '../src/store';

function fixtureStore() {
  return openStore(join(mkdtempSync(join(tmpdir(), 'qlb-lifecycle-')), 'qlb.db'));
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
      });
      assert.deepEqual(calls, ['bootout', 'disable', 'move']);
      assert.deepEqual(success, { ok: true, state: 'cutting-over' });
    } finally { store.close(); }

    const failedStore = fixtureStore();
    try {
      const failed = await cutoverBegin(failedStore.dbPath);
      assert.equal(failed.ok, false);
      assert.equal(failed.state, 'aborted');
    } finally { failedStore.close(); }
  });

  it('uses the §4.15 table for admission, including normal operation after retirement', () => {
    const store = fixtureStore();
    try {
      assert.equal(assertAdmitted(store, 'gate').code, 'phase=pre-cutover');
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
