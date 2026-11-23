import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { readBuildStamp, readCodexLatch, sweepCodexStops, type CodexStopContext } from '../src/codex-stop';
import { openStore, type Store } from '../src/store';

const PROVIDER = 'openai-codex';
const T0 = 1_800_000_000_000;

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'qlb-codex-stop-')), 'qlb.db');
}

function harness(store: Store, now = T0 + 10_000): { ctx: CodexStopContext; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    ctx: {
      store,
      now: () => now,
      buildStamp: 'build-abc',
      flagEnabled: true,
      lifecycleId: 7,
      autoLog: (line) => lines.push(line),
    },
  };
}

function startStage(store: Store, at = T0): number {
  const id = store.appendCodexStageEvent({
    kind: 'stage-start', now: at, lifecycleId: 7, buildStamp: 'build-abc', flagEnabled: true, stage: 1,
  });
  assert.ok(id !== null);
  return id;
}

function switchRow(store: Store, ts: number, outcome: string, detail: string | null): number {
  return store.recordSwitch({ ts, provider: PROVIDER, toAccount: 'acct-b', trigger: 'manual', outcome, detail });
}

function latchSets(store: Store) {
  const log = store.readCodexStageLog();
  return log.events.filter((event) => event.kind === 'latch-set');
}

describe('codex stop sweep', () => {
  it('records no stop before the first stage start', () => {
    const store = openStore(dbPath());
    try {
      store.recordRelogin({ ts: T0 + 1, provider: PROVIDER, accountId: 'acct-a', kind: 'wiped' });
      const { ctx, lines } = harness(store);
      assert.deepEqual(sweepCodexStops(ctx), { recorded: [] });
      assert.equal(latchSets(store).length, 0);
      assert.deepEqual(lines, []);
      assert.deepEqual(readCodexLatch(store), { state: 'clear' });
    } finally {
      store.close();
    }
  });

  it('ignores evidence older than the first stage start', () => {
    const store = openStore(dbPath());
    try {
      store.recordRelogin({ ts: T0 - 1, provider: PROVIDER, accountId: 'acct-a', kind: 'wiped' });
      const old = switchRow(store, T0 - 3, 'ok', null);
      assert.equal(store.insertCodexWatchVerdict({ switchId: old, verdict: 'reverted', now: T0 - 2 }), true);
      startStage(store);
      assert.deepEqual(sweepCodexStops(harness(store).ctx), { recorded: [] });
      assert.deepEqual(readCodexLatch(store), { state: 'clear' });
    } finally {
      store.close();
    }
  });

  it('records one latch-set per stop kind with its evidence pointer, build stamp, flag and lifecycle', () => {
    const store = openStore(dbPath());
    try {
      startStage(store);
      const relogin = store.recordRelogin({ ts: T0 + 1, provider: PROVIDER, accountId: 'acct-a', kind: 'identity-replaced' });
      const halfFinished = switchRow(store, T0 + 2, 'failed', 'unknown-live-identity');
      const refused = switchRow(store, T0 + 3, 'refused', 'no-such-named-refusal');
      const reverted = switchRow(store, T0 + 4, 'ok', null);
      assert.equal(store.insertCodexWatchVerdict({ switchId: reverted, verdict: 'reverted', now: T0 + 5 }), true);
      // Clean rows record nothing.
      switchRow(store, T0 + 6, 'ok', null);
      store.recordRelogin({ ts: T0 + 7, provider: PROVIDER, accountId: 'acct-a', kind: 'healed' });

      const { ctx } = harness(store);
      const result = sweepCodexStops(ctx);
      const rows = latchSets(store);
      assert.deepEqual(result.recorded, rows.map((row) => row.id));
      assert.deepEqual(rows.map((row) => [row.evidence, (row.detail as { rule: string }).rule]), [
        [`relogin_events:${relogin}`, 'forced-relogin'],
        [`switch_log:${halfFinished}`, 'half-finished-switch'],
        [`switch_log:${refused}`, 'unexplained-refusal'],
        [`codex_watch_verdicts:${reverted}`, 'unconfirmed-switch'],
      ]);
      for (const row of rows) {
        assert.equal(row.buildStamp, 'build-abc');
        assert.equal(row.flagEnabled, true);
        assert.equal(row.lifecycleId, 7);
        assert.equal(row.recordedAt, T0 + 10_000);
      }
      assert.deepEqual(readCodexLatch(store), {
        state: 'set', newestStopId: rows.at(-1)!.id, stopIds: rows.map((row) => row.id),
      });
    } finally {
      store.close();
    }
  });

  it('records nothing new on a second sweep', () => {
    const store = openStore(dbPath());
    try {
      startStage(store);
      store.recordRelogin({ ts: T0 + 1, provider: PROVIDER, accountId: 'acct-a', kind: 'wiped' });
      const { ctx, lines } = harness(store);
      assert.equal(sweepCodexStops(ctx).recorded.length, 1);
      assert.equal(lines.length, 1);
      assert.deepEqual(sweepCodexStops(ctx), { recorded: [] });
      assert.equal(latchSets(store).length, 1);
      assert.equal(lines.length, 1);
    } finally {
      store.close();
    }
  });

  it('records a wiped re-login and its failed switch as two stops', () => {
    const store = openStore(dbPath());
    try {
      startStage(store);
      const relogin = store.recordRelogin({ ts: T0 + 1, provider: PROVIDER, accountId: 'acct-a', kind: 'wiped' });
      const failed = switchRow(store, T0 + 2, 'failed', 'wiped');
      const { ctx } = harness(store);
      assert.equal(sweepCodexStops(ctx).recorded.length, 2);
      assert.deepEqual(latchSets(store).map((row) => row.evidence), [`relogin_events:${relogin}`, `switch_log:${failed}`]);
    } finally {
      store.close();
    }
  });

  it('writes one auto.log line per new latch-set naming the stop, rule and evidence', () => {
    const store = openStore(dbPath());
    try {
      startStage(store);
      const relogin = store.recordRelogin({ ts: T0 + 1, provider: PROVIDER, accountId: 'acct-a', kind: 'dead' });
      const { ctx, lines } = harness(store);
      const [stopId] = sweepCodexStops(ctx).recorded;
      assert.deepEqual(lines, [
        `codex:stop-latched stop=${stopId} rule=forced-relogin evidence=relogin_events:${relogin} at=${T0 + 10_000}`,
      ]);
    } finally {
      store.close();
    }
  });

  it('keeps sweeping after a clear, so a later stop latches again', () => {
    const store = openStore(dbPath());
    try {
      startStage(store);
      store.recordRelogin({ ts: T0 + 1, provider: PROVIDER, accountId: 'acct-a', kind: 'wiped' });
      const { ctx } = harness(store);
      const [first] = sweepCodexStops(ctx).recorded;
      store.appendCodexStageEvent({
        kind: 'latch-clear', now: T0 + 2, lifecycleId: 7, buildStamp: 'build-abc', flagEnabled: true, throughId: first, reason: 'reviewed',
      });
      assert.deepEqual(readCodexLatch(store), { state: 'clear' });
      store.recordRelogin({ ts: T0 + 3, provider: PROVIDER, accountId: 'acct-a', kind: 'wiped' });
      const [second] = sweepCodexStops(ctx).recorded;
      // The latch lists only the stops since the last clear.
      assert.deepEqual(readCodexLatch(store), { state: 'set', newestStopId: second, stopIds: [second] });
    } finally {
      store.close();
    }
  });

  it('does not let an auto.log failure undo or repeat a recorded stop', () => {
    const store = openStore(dbPath());
    try {
      startStage(store);
      store.recordRelogin({ ts: T0 + 1, provider: PROVIDER, accountId: 'acct-a', kind: 'wiped' });
      const { ctx } = harness(store);
      const failing: CodexStopContext = { ...ctx, autoLog: () => { throw new Error('disk full'); } };
      assert.equal(sweepCodexStops(failing).recorded.length, 1);
      assert.equal(latchSets(store).length, 1);
      assert.equal(readCodexLatch(store).state, 'set');
    } finally {
      store.close();
    }
  });
});

describe('codex latch read', () => {
  it('reports unreadable for a malformed event row', () => {
    const path = dbPath();
    let store = openStore(path);
    store.close();
    const raw = new DatabaseSync(path);
    try {
      raw.prepare("INSERT INTO codex_stage_events (kind, recorded_at) VALUES ('from-a-newer-build', ?)").run(T0);
    } finally {
      raw.close();
    }
    store = openStore(path);
    try {
      assert.deepEqual(readCodexLatch(store), { state: 'unreadable', reason: 'unreadable-row' });
    } finally {
      store.close();
    }
  });

  it('reports unreadable on a restored store that has Codex history and no initialize row', () => {
    const path = dbPath();
    let store = openStore(path);
    switchRow(store, T0, 'ok', null);
    store.close();
    const raw = new DatabaseSync(path);
    try {
      raw.exec('DROP TABLE codex_stage_events; DROP TABLE codex_watch_verdicts;');
    } finally {
      raw.close();
    }
    store = openStore(path);
    try {
      assert.deepEqual(readCodexLatch(store), { state: 'unreadable', reason: 'initialize-required' });
      // A sweep on an unreadable log records nothing and does not throw.
      assert.deepEqual(sweepCodexStops(harness(store).ctx), { recorded: [] });
    } finally {
      store.close();
    }
  });

  it('reads the build stamp beside the compiled modules, or null without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-build-stamp-'));
    assert.equal(readBuildStamp(dir), null);
    writeFileSync(join(dir, '.build-sha'), 'abc123\n');
    assert.equal(readBuildStamp(dir), 'abc123');
  });

  it('reports clear while armed with no stop', () => {
    const store = openStore(dbPath());
    try {
      startStage(store);
      assert.deepEqual(readCodexLatch(store), { state: 'clear' });
    } finally {
      store.close();
    }
  });
});
