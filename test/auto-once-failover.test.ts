import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AUTO_BINDINGS, runAuto } from '../src/auto';
import { anthropicTick, type AnthropicTickResult } from '../src/auto/anthropic';
import { SqliteClaudeSlotRepository, type ClaudeSlot } from '../src/cc-slots';
import { defaultConfig } from '../src/config';
import { openStore, openStoreConnection } from '../src/store';

const decision = { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } as const;

function liveBinding(overrides: Partial<{
  reconcile(): Promise<void>;
  poll(): Promise<[]>;
  tick(): Promise<AnthropicTickResult>;
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
    on: (_signal: string, value: () => void) => { handler = value; },
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
    assert.deepEqual(output.decisions, [decision]);
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

  it('SIGTERM during sleep clears the timer and ends the loop', async () => {
    const term = signals();
    let timer: (() => void) | undefined;
    let cleared = false;
    const pending = runAuto({}, {
      makeLiveBinding: () => liveBinding(),
      assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [],
      signals: term,
      log: () => {},
      setTimeout: (callback) => { timer = callback; return {} as ReturnType<typeof setTimeout>; },
      clearTimeout: () => { cleared = true; },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(timer);
    term.emit();
    const output = await pending;
    assert.equal(cleared, true);
    assert.equal(output.ticks, 1);
  });

  it('a real SIGTERM re-raised after refresh persistence still finishes the tick and exits 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-auto-signal-'));
    const modulePath = join(process.cwd(), 'dist-test', 'src', 'auto.js');
    const script = `
      const { runAuto } = require(${JSON.stringify(modulePath)});
      const keepAlive = setInterval(() => {}, 1000);
      process.once('SIGTERM', () => setImmediate(() => {
        process.kill(process.pid, 'SIGTERM');
        clearInterval(keepAlive);
        process.emit('refresh-persisted');
      }));
      runAuto({}, {
        makeLiveBinding: () => ({
          store: { setConfig: () => {} }, close: () => {}, reconcile: async () => {}, poll: async () => [],
          tick: async () => {
            console.log('refresh-started');
            await new Promise((resolve) => process.once('refresh-persisted', resolve));
            console.log('tick-finished');
            return { decision: { kind: 'stay', reason: 'fixture', unhealthyTicks: 0 } };
          },
        }),
        assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: () => {},
      }).then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ['-e', script], {
      env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let signaled = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (!signaled && stdout.includes('refresh-started')) {
          signaled = true;
          child.kill('SIGTERM');
        }
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal || code !== 0) reject(new Error(`child exit=${code} signal=${signal} output=${stdout}`));
        else resolve(stdout);
      });
    });
    assert.match(output, /tick-finished/);
  });

  it('records only successful switches as executed and logs a refusal reason', async () => {
    const refused: AnthropicTickResult = { decision: { kind: 'switch', targetId: 'next', reason: 'at-limit', unhealthyTicks: 1, leftHeadroom: 0, leftRecoveryAtMs: null, leftTrigger: 'at-limit' },
      switchResult: { outcome: 'refused', from: 'active', to: 'next', reason: 'switch-journal-present', attempt: 'fixture', exitCode: 3 } };
    const refusedLines: string[] = [];
    const refusedResult = await runAuto({ once: true }, {
      makeLiveBinding: () => liveBinding({ tick: async () => refused }), assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [], log: (line) => refusedLines.push(line),
    });
    assert.deepEqual(refusedResult.executed, []);
    assert.deepEqual(refusedLines, ['auto: switch(next,at-limit,refused,switch-journal-present)']);

    const ok: AnthropicTickResult = { decision: { kind: 'switch', targetId: 'next', reason: 'at-limit', unhealthyTicks: 1, leftHeadroom: 0, leftRecoveryAtMs: null, leftTrigger: 'at-limit' },
      switchResult: { outcome: 'ok', from: 'active', to: 'next', attempt: 'fixture', exitCode: 0 } };
    const okResult = await runAuto({ once: true }, {
      makeLiveBinding: () => liveBinding({ tick: async () => ok }), assertAdmitted: () => ({ ok: true }),
      listCswapProcesses: () => [], log: () => {},
    });
    assert.deepEqual(okResult.executed, ['next']);
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

  it('dry run reports the same breaker stay as a live decision', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-auto-breaker-'));
    const config = defaultConfig(home);
    const now = 1_000_000;
    const store = openStore(config.dbPath);
    const repository = SqliteClaudeSlotRepository.open(config.dbPath);
    const slot = (accountId: string, slotNum: number): ClaudeSlot => ({
      accountId, slotNum, email: null, alias: null, orgUuid: null, configJson: '{}', fingerprint: null,
      prevFingerprint: null, threshold: null, dead: false, deadReason: null, deadAt: null, healedAt: null,
      addedAt: now, lastActiveAt: null, source: 'fixture', archivedAt: null,
    });
    repository.createSlot(slot('active', 1));
    repository.createSlot(slot('next', 2));
    repository.close();
    store.setActiveLogin('anthropic', 'active', 'fixture', now);
    store.upsertSnapshot('active', '5h', { usedPct: 100, fetchedAt: now, source: 'poll', confidence: 'authoritative' });
    store.upsertSnapshot('next', '5h', { usedPct: 0, fetchedAt: now, source: 'poll', confidence: 'authoritative' });
    for (let index = 0; index < 3; index += 1) store.recordSwitch({
      ts: now - index, provider: 'anthropic', fromAccount: 'active', toAccount: 'next', trigger: 'at-limit', outcome: 'ok', committedAt: now - index,
    });
    const slots = [slot('active', 1), slot('next', 2)];
    const live = await anthropicTick({ store, slots: { listSlots: () => slots } as unknown as import('../src/cc-slots').ClaudeSlots, now: () => now });
    store.setConfig('auto.anthropic.suspendedUntil', '');
    store.close();
    const dry = await runAuto({ once: true, dryRun: true }, {
      config, home, env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, now: () => now, log: () => {},
    });
    assert.deepEqual(dry.decisions, [live.decision]);
    assert.equal(dry.decisions[0]?.kind, 'stay');
    assert.equal(dry.decisions[0]?.reason, 'breaker');
  });

  it('token-shaped text in a thrown error never reaches the auto log or health_log', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const home = mkdtempSync(join(tmpdir(), 'qlb-auto-redact-'));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.close();
    const lines: string[] = [];
    const binding = liveBinding({ tick: async () => { throw new Error(`network ${secret}\nforged-line`); } });
    await runAuto({ once: true }, {
      config, home, env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, makeLiveBinding: () => binding,
      assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: (line) => lines.push(line),
    });
    assert.equal(lines.join('\n').includes(secret), false);
    assert.equal(lines[0]?.includes('\n'), false);
    const db = openStoreConnection(config.dbPath, true);
    try {
      const rows = db.prepare('SELECT failing_json, dead_slots_json FROM health_log').all() as Array<{ failing_json: string; dead_slots_json: string }>;
      assert.equal(rows.some((row) => row.failing_json.includes(secret) || row.dead_slots_json.includes(secret)), false);
    } finally { db.close(); }
    assert.equal(binding.writes.length, 0);
  });
});
