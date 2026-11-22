import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  listCodexStopEvidenceFrom,
  listCodexWatchVerdictsFrom,
  openStore,
  readCodexStageLogFrom,
} from '../src/store';

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'qlb-codex-stage-store-')), 'qlb.db');
}

function newBackups(path: string, before: Set<string>): string[] {
  const dir = join(dirname(path), 'backups');
  return existsSync(dir) ? readdirSync(dir).filter((name) => !before.has(name) && name.endsWith('.sqlite')) : [];
}

function backupNames(path: string): Set<string> {
  const dir = join(dirname(path), 'backups');
  return new Set(existsSync(dir) ? readdirSync(dir) : []);
}

function tableCount(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN ('codex_stage_events', 'codex_watch_verdicts')`).get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function dropStageTables(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec('DROP TABLE codex_stage_events; DROP TABLE codex_watch_verdicts;');
  } finally {
    raw.close();
  }
}

const common = { lifecycleId: 1, buildStamp: 'build-1', flagEnabled: false };

describe('codex stage-event and verdict tables', () => {
  it('creates both tables on a store without them, once', () => {
    const path = dbPath();
    let store = openStore(path);
    store.close();
    dropStageTables(path);
    assert.equal(tableCount(path), 0);

    const before = backupNames(path);
    store = openStore(path);
    store.close();
    assert.equal(tableCount(path), 2);
    assert.equal(newBackups(path, before).length, 1);

    const afterFirst = backupNames(path);
    store = openStore(path);
    store.close();
    assert.equal(newBackups(path, afterFirst).length, 0, 'a second open needs no migration');
  });

  it('appends each event kind and reads them back in order', () => {
    const store = openStore(dbPath());
    try {
      const start = store.appendCodexStageEvent({
        ...common, kind: 'stage-start', now: 1_000, stage: 1, detail: { allowList: ['codex:slots/no-slots'] },
      });
      const stop = store.appendCodexStageEvent({
        ...common, kind: 'latch-set', now: 2_000, evidence: 'switch_log:7', detail: { rule: 'half-finished-switch' },
      });
      assert.ok(stop !== null);
      const clear = store.appendCodexStageEvent({
        ...common, kind: 'latch-clear', now: 3_000, throughId: stop, reason: 'checked the login by hand',
      });
      const close = store.appendCodexStageEvent({
        ...common, kind: 'stage-close', now: 4_000, stage: 1, detail: { passed: false },
      });

      const log = store.readCodexStageLog();
      assert.equal(log.status, 'readable');
      assert.deepEqual(log.events.map(({ id, kind }) => [id, kind]), [
        [start, 'stage-start'], [stop, 'latch-set'], [clear, 'latch-clear'], [close, 'stage-close'],
      ]);
      const [startRow, stopRow, clearRow] = log.events;
      assert.deepEqual(
        { stage: startRow.stage, detail: startRow.detail, lifecycleId: startRow.lifecycleId, buildStamp: startRow.buildStamp, flagEnabled: startRow.flagEnabled, recordedAt: startRow.recordedAt },
        { stage: 1, detail: { allowList: ['codex:slots/no-slots'] }, lifecycleId: 1, buildStamp: 'build-1', flagEnabled: false, recordedAt: 1_000 },
      );
      assert.equal(stopRow.evidence, 'switch_log:7');
      assert.equal(clearRow.throughId, stop);
      assert.equal(clearRow.reason, 'checked the login by hand');
    } finally {
      store.close();
    }
  });

  it('inserts nothing for a second latch-set with the same evidence pointer', () => {
    const store = openStore(dbPath());
    try {
      const first = store.appendCodexStageEvent({ ...common, kind: 'latch-set', now: 1, evidence: 'relogin_events:3' });
      const second = store.appendCodexStageEvent({ ...common, kind: 'latch-set', now: 2, evidence: 'relogin_events:3' });
      assert.equal(typeof first, 'number');
      assert.equal(second, null);
      assert.equal(store.readCodexStageLog().events.length, 1);
    } finally {
      store.close();
    }
  });

  it('keeps the first verdict for a switch', () => {
    const store = openStore(dbPath());
    try {
      assert.equal(store.insertCodexWatchVerdict({ switchId: 9, verdict: 'confirmed', now: 10 }), true);
      assert.equal(store.insertCodexWatchVerdict({ switchId: 9, verdict: 'reverted', now: 20 }), false);
      assert.deepEqual(store.listCodexWatchVerdicts(), [{ switchId: 9, verdict: 'confirmed', recordedAt: 10, detail: null }]);
    } finally {
      store.close();
    }
  });

  it('lists the Codex switch and re-login rows recorded since a time', () => {
    const store = openStore(dbPath());
    try {
      store.recordSwitch({ ts: 5, provider: 'openai-codex', toAccount: 'b', trigger: 'manual', outcome: 'committed' });
      const late = store.recordSwitch({ ts: 50, provider: 'openai-codex', toAccount: 'b', trigger: 'auto', outcome: 'failed', error: 'boom' });
      store.recordSwitch({ ts: 60, provider: 'anthropic', toAccount: 'x', trigger: 'auto', outcome: 'failed' });
      store.recordRelogin({ ts: 4, provider: 'openai-codex', accountId: 'b', kind: 'wiped' });
      const relogin = store.recordRelogin({ ts: 55, provider: 'openai-codex', accountId: 'b', kind: 'identity-replaced' });
      store.recordRelogin({ ts: 56, provider: 'anthropic', accountId: 'x', kind: 'wiped' });

      const evidence = store.listCodexStopEvidence(10);
      assert.deepEqual(evidence.switches.map(({ id, outcome, trigger, error }) => ({ id, outcome, trigger, error })), [
        { id: late, outcome: 'failed', trigger: 'auto', error: 'boom' },
      ]);
      assert.deepEqual(evidence.relogins.map(({ id, kind }) => ({ id, kind })), [{ id: relogin, kind: 'identity-replaced' }]);
    } finally {
      store.close();
    }
  });

  it('read-only readers return empty lists when the tables are missing', () => {
    const path = dbPath();
    openStore(path).close();
    dropStageTables(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const log = readCodexStageLogFrom(db);
      assert.deepEqual(log, { status: 'unknown', reason: 'tables-missing', events: [] });
      assert.deepEqual(listCodexWatchVerdictsFrom(db), []);
      assert.deepEqual(listCodexStopEvidenceFrom(db, 0), { switches: [], relogins: [] });
    } finally {
      db.close();
    }
  });

  it('reads as unknown when a row has an event kind this build does not know', () => {
    const path = dbPath();
    const store = openStore(path);
    try {
      store.appendCodexStageEvent({ ...common, kind: 'stage-start', now: 1, stage: 1 });
      const raw = new DatabaseSync(path);
      try {
        raw.prepare("INSERT INTO codex_stage_events (kind, recorded_at) VALUES ('stage-pause', 2)").run();
      } finally {
        raw.close();
      }
      const log = store.readCodexStageLog();
      assert.equal(log.status, 'unknown');
      assert.equal(log.status === 'unknown' && log.reason, 'unreadable-row');
    } finally {
      store.close();
    }
  });

  it('marks a restored store with Codex switch history as initialize-required', () => {
    const path = dbPath();
    let store = openStore(path);
    store.recordSwitch({ ts: 5, provider: 'openai-codex', toAccount: 'b', trigger: 'manual', outcome: 'committed' });
    store.close();
    dropStageTables(path);

    store = openStore(path);
    try {
      const log = store.readCodexStageLog();
      assert.equal(log.status, 'unknown');
      assert.equal(log.status === 'unknown' && log.reason, 'initialize-required');
      assert.deepEqual(log.events.map(({ kind }) => kind), ['initialize-required']);

      store.appendCodexStageEvent({ ...common, kind: 'initialize', now: 9, reason: 'restored from backup' });
      assert.equal(store.readCodexStageLog().status, 'readable');
    } finally {
      store.close();
    }

    store = openStore(path);
    try {
      assert.deepEqual(store.readCodexStageLog().events.map(({ kind }) => kind), ['initialize-required', 'initialize']);
    } finally {
      store.close();
    }
  });

  it('reads a store without Codex switch history as empty', () => {
    const path = dbPath();
    let store = openStore(path);
    store.recordSwitch({ ts: 5, provider: 'anthropic', toAccount: 'x', trigger: 'manual', outcome: 'committed' });
    store.close();
    dropStageTables(path);

    store = openStore(path);
    try {
      assert.deepEqual(store.readCodexStageLog(), { status: 'readable', events: [] });
    } finally {
      store.close();
    }
  });
});
