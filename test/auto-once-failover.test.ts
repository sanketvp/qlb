import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AUTO_BINDINGS, runAuto } from '../src/auto';
import { defaultConfig } from '../src/config';
import { openStore } from '../src/store';

const decision = { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } as const;

function liveBinding(overrides: Partial<{
  reconcile(): Promise<void>;
  poll(): Promise<[]>;
  tick(): Promise<{ decision: typeof decision }>;
}> = {}) {
  const writes: Array<[string, string]> = [];
  return {
    store: { setConfig: (key: string, value: string) => { writes.push([key, value]); } },
    close: () => {},
    reconcile: overrides.reconcile ?? (async () => {}),
    poll: overrides.poll ?? (async () => [] as []),
    tick: overrides.tick ?? (async () => ({ decision })),
    writes,
  };
}

function signals() {
  let handler: (() => void) | undefined;
  return {
    once: (_signal: string, value: () => void) => { handler = value; },
    removeListener: (_signal: string, value: () => void) => { if (handler === value) handler = undefined; },
    emit: () => handler?.(),
  };
}

describe('auto once failover (G11)', () => {
  it('a live C-swap process stays', async () => {
    const binding = liveBinding({
      reconcile: async () => { throw new Error('reconcile must not run'); },
      poll: async () => { throw new Error('poll must not run'); },
      tick: async () => { throw new Error('tick must not run'); },
    });
    const lines: string[] = [];
    const output = await runAuto({ once: true }, {
      makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [{ pid: 1 }],
      now: () => 100,
      log: (line) => lines.push(line),
    });
    assert.equal(output.ticks, 1);
    assert.deepEqual(output.decisions, []);
    assert.deepEqual(binding.writes, [['auto.heartbeatAt', '100']]);
    assert.deepEqual(lines, ['auto: stay(cswap-alive)']);
  });

  it('a thrown tick logs and continues', async () => {
    let ticks = 0;
    const term = signals();
    const binding = liveBinding({
      tick: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error('first tick failed');
        term.emit();
        return { decision };
      },
    });
    const lines: string[] = [];
    const output = await runAuto({}, {
      makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [],
      log: (line) => lines.push(line),
      signals: term,
      setTimeout: (callback) => { callback(); return {} as ReturnType<typeof setTimeout>; },
    });
    assert.equal(ticks, 2);
    assert.equal(output.ticks, 1);
    assert.deepEqual(lines, ['auto: tick error: first tick failed', 'auto: stay(unknown)']);
  });

  it('SIGTERM during a tick finishes it', async () => {
    const term = signals();
    let finished = false;
    const binding = liveBinding({
      tick: async () => {
        term.emit();
        await Promise.resolve();
        finished = true;
        return { decision };
      },
    });
    const output = await runAuto({}, {
      makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [],
      signals: term,
      log: () => {},
    });
    assert.equal(finished, true);
    assert.equal(output.ticks, 1);
  });

  it('xai and kimi bindings are never called', async () => {
    const binding = liveBinding();
    await runAuto({ once: true }, {
      makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [],
      now: () => 100,
      log: () => {},
    });
    assert.deepEqual(AUTO_BINDINGS, ['anthropic']);
    assert.deepEqual(binding.writes, [['auto.heartbeatAt', '100']]);
  });

  it('dry run never calls reconcile, poll, refresh or the heartbeat writer', async () => {
    let dryTicks = 0;
    let liveBindings = 0;
    const output = await runAuto({ once: true, dryRun: true }, {
      makeLiveBinding: () => { liveBindings += 1; return liveBinding(); },
      makeDryBinding: () => ({
        admit: () => ({ ok: true }), close: () => {}, tick: async () => { dryTicks += 1; return { decision }; },
      }),
      log: () => {},
    });
    assert.equal(dryTicks, 1);
    assert.equal(liveBindings, 0);
    assert.equal(output.ticks, 1);
  });

  it('the production dry branch uses stored readings without changing the database', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-auto-dry-'));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.close();
    const before = readFileSync(config.dbPath);
    const output = await runAuto({ once: true, dryRun: true }, {
      config, home, env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, now: () => 100,
      log: () => {},
    });
    assert.equal(output.ticks, 1);
    assert.deepEqual(readFileSync(config.dbPath), before);
  });

  it('token-shaped text in a thrown error never reaches the auto log or health_log', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const lines: string[] = [];
    const binding = liveBinding({ tick: async () => { throw new Error(`network ${secret}`); } });
    await runAuto({ once: true }, {
      makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [],
      log: (line) => lines.push(line),
    });
    assert.equal(lines.join('\n').includes(secret), false);
    assert.equal(binding.writes.length, 0);
  });
});
