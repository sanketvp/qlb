import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, it } from 'node:test';

import type { AccountSnapshot, BucketReading, Confidence } from '../src/types';
import { hashSession, SPREAD_MARGIN } from '../src/scoring';
import { resolveFromSnapshots } from '../src/resolve';
import { openStore } from '../src/store';

function reading(
  usedPct: number,
  confidence: Confidence = 'authoritative',
): BucketReading {
  return {
    usedPct,
    source: 'poll',
    confidence,
    fetchedAt: Date.now(),
  };
}

function anthropic(
  id: string,
  buckets: Record<string, BucketReading>,
  error?: string,
): AccountSnapshot {
  const snap: AccountSnapshot = {
    accountId: id,
    provider: 'anthropic',
    label: id,
    buckets,
  };
  if (error) snap.error = error;
  return snap;
}

function sessionForSlot(slot: number, count: number): string {
  for (let i = 0; i < 20_000; i++) {
    const id = `synth-session-${i}`;
    if (hashSession(id) % count === slot) return id;
  }
  throw new Error(`could not find session hashing to slot ${slot}`);
}

describe('strategy: headroom (default, unchanged)', () => {
  it('picks the higher-scoring account without a --strategy flag', () => {
    const A = anthropic('A', { '5h': reading(70), '7d': reading(20) });
    const B = anthropic('B', { '5h': reading(40), '7d': reading(65) });
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [A, B],
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, 'A');
    assert.equal(decision.mode, 'headroom');
    assert.equal(decision.strategy, 'headroom');
    assert.equal(decision.score, 10);
  });
});

describe('strategy: spread', () => {
  it('diversifies two session IDs among near-tied candidates, stably', () => {
    const A = anthropic('A', { '5h': reading(50), '7d': reading(50) });
    const B = anthropic('B', { '5h': reading(50), '7d': reading(50) });
    const sess0 = sessionForSlot(0, 2);
    const sess1 = sessionForSlot(1, 2);
    const d0 = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [A, B],
      strategy: 'spread',
      session: sess0,
    });
    const d1 = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [A, B],
      strategy: 'spread',
      session: sess1,
    });
    assert.equal(d0.ok, true);
    assert.equal(d1.ok, true);
    if (!d0.ok || !d1.ok) return;
    assert.notEqual(d0.accountId, d1.accountId);
    const again = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [A, B],
      strategy: 'spread',
      session: sess0,
    });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.accountId, d0.accountId);
    assert.ok(Math.abs(d0.score - d1.score) <= SPREAD_MARGIN);
  });

  it('falls back to headroom when no session id is provided', () => {
    const A = anthropic('A', { '5h': reading(70), '7d': reading(20) });
    const B = anthropic('B', { '5h': reading(40), '7d': reading(65) });
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [A, B],
      strategy: 'spread',
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, 'A');
    assert.equal(decision.strategy, 'headroom');
    assert.equal(decision.mode, 'headroom');
  });
});

describe('strategy: round-robin', () => {
  it('cycles through eligible accounts in a fixed order', () => {
    const store = openStore(':memory:');
    const A = anthropic('A', { '5h': reading(10), '7d': reading(10) });
    const B = anthropic('B', { '5h': reading(20), '7d': reading(20) });
    const C = anthropic('C', { '5h': reading(30), '7d': reading(30) });
    const snapshots = [C, A, B];
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const decision = resolveFromSnapshots({
        model: 'claude-sonnet-5',
        snapshots,
        strategy: 'round-robin',
        store,
      });
      assert.equal(decision.ok, true);
      if (!decision.ok) return;
      seen.push(decision.accountId);
    }
    assert.deepEqual(seen, ['A', 'B', 'C', 'A', 'B', 'C']);
    store.close();
  });

  it('skips fully-exhausted and error accounts', () => {
    const store = openStore(':memory:');
    const A = anthropic('A', { '5h': reading(100), '7d': reading(100) });
    const B = anthropic('B', { '5h': reading(10), '7d': reading(10) });
    const C = anthropic('C', { '5h': reading(10), '7d': reading(10) }, 'auth expired');
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const decision = resolveFromSnapshots({
        model: 'claude-sonnet-5',
        snapshots: [A, B, C],
        strategy: 'round-robin',
        store,
      });
      assert.equal(decision.ok, true);
      if (!decision.ok) return;
      seen.push(decision.accountId);
    }
    assert.deepEqual(seen, ['B', 'B', 'B']);
    store.close();
  });

  it('serializes concurrent index increments under BEGIN IMMEDIATE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-rr-conc-'));
    const dbPath = join(dir, 'qlb.db');
    const setup = openStore(dbPath);
    setup.close();
    const workerPath = join(__dirname, '..', 'src', 'store.js');
    const count = 8;
    const results = await Promise.all(
      Array.from({ length: count }, () =>
        new Promise<number>((resolve, reject) => {
          let settled = false;
          const worker = new Worker(
            `
            const { openStore } = require(${JSON.stringify(workerPath)});
            const { parentPort, workerData } = require('node:worker_threads');
            const store = openStore(workerData.dbPath);
            try {
              const idx = store.nextRoundRobinIndex(workerData.key, workerData.count);
              parentPort.postMessage(idx);
            } finally {
              store.close();
            }
            `,
            {
              eval: true,
              workerData: { dbPath, key: 'round-robin:anthropic', count: 1000 },
            },
          );
          worker.on('message', (idx: number) => {
            settled = true;
            resolve(idx);
          });
          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (!settled && code !== 0) reject(new Error(`worker exit ${code}`));
          });
        }),
      ),
    );
    assert.equal(new Set(results).size, count);
  });

  it('T4 drains 25 rounds of 8 worker-thread constructor/index lifecycles', { timeout: 30_000 }, async () => {
    const rounds = 25;
    const count = 8;
    const workerPath = join(__dirname, '..', 'src', 'store.js');
    let completedRounds = 0;
    for (let round = 0; round < rounds; round++) {
      const dir = mkdtempSync(join(tmpdir(), `qlb-rr-t4-${round}-`));
      const dbPath = join(dir, 'qlb.db');
      const setup = openStore(dbPath);
      setup.close();
      try {
        const workers = Array.from({ length: count }, (_, workerIndex) =>
          new Promise<{
            workerIndex: number;
            value?: number;
            code: number;
            signal: string | null;
            error?: string;
            timedOut: boolean;
          }>((resolve) => {
            let value: number | undefined;
            let workerError: string | undefined;
            let timedOut = false;
            const worker = new Worker(
              `
              const { openStore } = require(${JSON.stringify(workerPath)});
              const { parentPort, workerData } = require('node:worker_threads');
              const store = openStore(workerData.dbPath);
              try {
                parentPort.postMessage(store.nextRoundRobinIndex(workerData.key, workerData.count));
              } finally {
                store.close();
              }
              `,
              {
                eval: true,
                workerData: { dbPath, key: 'round-robin:t4', count: 1000 },
              },
            );
            worker.on('message', (idx: number) => { value = idx; });
            worker.on('error', (err) => {
              workerError = err instanceof Error ? err.stack || err.message : String(err);
            });
            const timer = setTimeout(() => {
              timedOut = true;
              void worker.terminate();
            }, 10_000);
            worker.once('exit', (code) => {
              clearTimeout(timer);
              resolve({
                workerIndex,
                value,
                code,
                signal: null,
                error: workerError,
                timedOut,
              });
            });
          }),
        );
        const outcomes = await Promise.all(workers);
        const failures = outcomes.filter((row) =>
          row.timedOut || row.code !== 0 || row.error !== undefined || row.value === undefined,
        );
        assert.deepEqual(failures, [], `round ${round} lifecycle failures: ${JSON.stringify(outcomes)}`);
        const values = outcomes.map((row) => row.value as number);
        assert.equal(values.length, count, `round ${round} values`);
        assert.equal(new Set(values).size, count, `round ${round} distinct indices`);
        completedRounds += 1;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.equal(completedRounds, rounds);
  });
});

describe('strategy: failover', () => {
  it('sticks to one account until it is genuinely exhausted, then switches', () => {
    const store = openStore(':memory:');
    const A = anthropic('A', { '5h': reading(90), '7d': reading(90) });
    const B = anthropic('B', { '5h': reading(10), '7d': reading(10) });
    const first = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [A, B],
      strategy: 'failover',
      store,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.accountId, 'A');
    const second = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [A, B],
      strategy: 'failover',
      store,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.accountId, 'A');

    const Adead = anthropic('A', { '5h': reading(100), '7d': reading(100) });
    const third = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: [Adead, B],
      strategy: 'failover',
      store,
    });
    assert.equal(third.ok, true);
    if (!third.ok) return;
    assert.equal(third.accountId, 'B');
    store.close();
  });
});
