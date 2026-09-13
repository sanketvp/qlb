import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { openStore } from '../src/store';

const support = join(__dirname, '..', '..', 'test', 'support');
const holderPath = join(support, 'hold-exclusive.cjs');
const observerPath = join(support, 'store-init-observe.cjs');
const compiledStorePath = join(__dirname, '..', 'src', 'store.js');
const waitArray = new Int32Array(new SharedArrayBuffer(4));

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type RunningChild = {
  child: ChildProcess;
  result: Promise<ChildResult>;
};

function spawnNode(script: string, opts: Record<string, unknown>): RunningChild {
  const child = spawn(process.execPath, [script, JSON.stringify(opts)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let stdout = '';
  let stderr = '';
  let childError: Error | undefined;
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', (err) => { childError = err; });
  const result = new Promise<ChildResult>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr, error: childError }));
  });
  return { child, result };
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`fixture marker timeout: ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function waitForFileSync(file: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`fixture marker timeout: ${file}`);
    Atomics.wait(waitArray, 0, 0, 5);
  }
}

function writeMarker(dir: string, name: string): void {
  const file = join(dir, `${name}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ phase: name, at: Date.now() }));
  renameSync(temp, file);
}

async function boundedExit(running: RunningChild, timeoutMs: number): Promise<ChildResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      running.result,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          running.child.kill('SIGKILL');
          reject(new Error(`child exit timeout pid=${running.child.pid}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertCleanExit(result: ChildResult, label: string): void {
  assert.equal(result.error, undefined, `${label} child error`);
  assert.equal(result.code, 0, `${label} exit ${result.code}/${result.signal}: ${result.stderr}`);
  assert.equal(result.signal, null, `${label} signal`);
  assert.equal(result.stderr, '', `${label} stderr`);
}

function initializeDb(dbPath: string): void {
  const store = openStore(dbPath);
  store.close();
}

function rawError(fn: () => unknown): Error & { code?: string; errcode?: number } {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  return caught as Error & { code?: string; errcode?: number };
}

async function abortAndDrain(dir: string, children: RunningChild[]): Promise<void> {
  try {
    writeMarker(dir, 'abort');
  } catch {
    // Directory may already have been removed after every child exited.
  }
  await Promise.all(children.map(async (child) => {
    if (child.child.exitCode === null && child.child.signalCode === null) {
      try {
        await boundedExit(child, 3000);
      } catch {
        child.child.kill('SIGKILL');
        await child.result;
      }
    }
  }));
}

function holderOptions(dir: string, dbPath: string, mode: 'finite' | 'hold-until-outcome') {
  return {
    fixtureDir: dir,
    dbPath,
    mode,
    holdMs: 1500,
    failsafeMs: 15000,
  };
}

function observerOptions(
  dir: string,
  dbPath: string,
  extra: Record<string, unknown> = {},
) {
  return {
    fixtureDir: dir,
    dbPath,
    storePath: compiledStorePath,
    observationPath: join(dir, 'observation.json'),
    ...extra,
  };
}

describe('Store constructor contention and cleanup', () => {
  it('T1 installs busy_timeout before WAL and succeeds under an observed exclusive hold', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-store-open-t1-'));
    const dbPath = join(dir, 'qlb.db');
    const children: RunningChild[] = [];
    initializeDb(dbPath);
    try {
      const holder = spawnNode(holderPath, holderOptions(dir, dbPath, 'finite'));
      children.push(holder);
      await waitForFile(join(dir, 'ready.json'), 5000);

      const raw = new DatabaseSync(dbPath);
      try {
        raw.exec('PRAGMA busy_timeout = 0');
        const negative = rawError(() => raw.exec('PRAGMA journal_mode = WAL'));
        assert.equal(negative.code, 'ERR_SQLITE_ERROR');
        assert.equal(negative.errcode, 5);
        assert.equal(existsSync(join(dir, 'releaseStarted.json')), false);
      } finally {
        raw.close();
      }

      const observer = spawnNode(observerPath, observerOptions(dir, dbPath, {
        mode: 't1-success',
        waitForRun: true,
        observeWal: true,
        ackTimeoutMs: 2000,
      }));
      children.push(observer);
      await waitForFile(join(dir, 'observerReady.json'), 5000);
      assert.equal(existsSync(join(dir, 'releaseStarted.json')), false);
      writeMarker(dir, 'run');
      await waitForFile(join(dir, 'observation.json'), 10_000);
      const observation = JSON.parse(readFileSync(join(dir, 'observation.json'), 'utf8'));
      assert.equal(observation.storeConstructed, true);
      assert.deepEqual(observation.execSql.slice(0, 2), [
        'PRAGMA busy_timeout = 5000',
        'PRAGMA journal_mode = WAL',
      ]);
      assert.equal(observation.wal.operationEntry, true);
      assert.equal(observation.wal.receiverMatched, true);
      assert.equal(observation.wal.armed, true);
      assert.equal(observation.wal.recheckPassed, true);
      assert.equal(observation.wal.delegatedCalls, 1);
      assert.equal(observation.wal.returned, true);
      assert.equal(observation.phases.failsafe, false);
      assert.equal(observation.phases.lostWindow, false);
      await waitForFile(join(dir, 'releaseComplete.json'), 5000);
      assertCleanExit(await boundedExit(holder, 5000), 'holder');
      assertCleanExit(await boundedExit(observer, 5000), 'observer');
    } finally {
      await abortAndDrain(dir, children);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T1 mechanism control: raw 300ms timeout expires while the acknowledged hold remains active', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-store-open-t1-raw-'));
    const dbPath = join(dir, 'qlb.db');
    const children: RunningChild[] = [];
    initializeDb(dbPath);
    try {
      const holder = spawnNode(holderPath, holderOptions(dir, dbPath, 'finite'));
      children.push(holder);
      await waitForFile(join(dir, 'ready.json'), 5000);
      const raw = new DatabaseSync(dbPath);
      try {
        raw.exec('PRAGMA busy_timeout = 300');
        writeMarker(dir, 'operationEntry');
        waitForFileSync(join(dir, 'armed.json'), 2000);
        assert.equal(existsSync(join(dir, 'releaseStarted.json')), false);
        assert.equal(existsSync(join(dir, 'failsafe.json')), false);
        const started = process.hrtime.bigint();
        const timed = rawError(() => raw.exec('PRAGMA journal_mode = WAL'));
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        assert.equal(timed.code, 'ERR_SQLITE_ERROR');
        assert.equal(timed.errcode, 5);
        assert.ok(elapsedMs >= 150, `expected accumulated busy wait, got ${elapsedMs}ms`);
        assert.ok(elapsedMs < 5000, `mechanism-control watchdog exceeded: ${elapsedMs}ms`);
      } finally {
        raw.close();
      }
      writeMarker(dir, 'abort');
      await waitForFile(join(dir, 'releaseComplete.json'), 5000);
      assertCleanExit(await boundedExit(holder, 5000), 'raw-control holder');
    } finally {
      await abortAndDrain(dir, children);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T2 actual Store holds through timeout, preserves WAL error identity, and closes once', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-store-open-t2-'));
    const dbPath = join(dir, 'qlb.db');
    const children: RunningChild[] = [];
    initializeDb(dbPath);
    try {
      const holder = spawnNode(holderPath, holderOptions(dir, dbPath, 'hold-until-outcome'));
      children.push(holder);
      await waitForFile(join(dir, 'ready.json'), 5000);
      const observer = spawnNode(observerPath, observerOptions(dir, dbPath, {
        mode: 't2-timeout',
        waitForRun: true,
        observeWal: true,
        writeOutcome: true,
        ackTimeoutMs: 2000,
      }));
      children.push(observer);
      await waitForFile(join(dir, 'observerReady.json'), 5000);
      writeMarker(dir, 'run');
      await waitForFile(join(dir, 'observation.json'), 12_000);
      const observation = JSON.parse(readFileSync(join(dir, 'observation.json'), 'utf8'));
      assert.equal(observation.storeConstructed, false, 'held-through-outcome Store must time out');
      assert.deepEqual(observation.execSql.slice(0, 2), [
        'PRAGMA busy_timeout = 5000',
        'PRAGMA journal_mode = WAL',
      ]);
      assert.equal(observation.sameOrigin, true);
      assert.equal(observation.originating.code, 'ERR_SQLITE_ERROR');
      assert.equal(observation.originating.errcode, 5);
      assert.equal(observation.wal.sql, 'PRAGMA journal_mode = WAL');
      assert.equal(observation.wal.returned, false);
      assert.equal(observation.wal.delegatedCalls, 1);
      assert.equal(observation.closeCalls, 1);
      assert.equal(observation.closedError.code, 'ERR_INVALID_STATE');
      if ('isOpen' in observation) assert.equal(observation.isOpen, false);
      assert.ok(observation.wal.elapsedMs >= 2500, `busy wait too short: ${observation.wal.elapsedMs}ms`);
      assert.ok(observation.elapsedMs < 15000, `observer watchdog exceeded: ${observation.elapsedMs}ms`);
      assert.equal(observation.phases.failsafe, false);
      assert.equal(observation.phases.lostWindow, false);
      await waitForFile(join(dir, 'releaseComplete.json'), 5000);
      assertCleanExit(await boundedExit(holder, 5000), 'timeout holder');
      assertCleanExit(await boundedExit(observer, 5000), 'timeout observer');
      const fresh = openStore(dbPath);
      fresh.close();
    } finally {
      await abortAndDrain(dir, children);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const fixture of [
    { name: 'early schema-version failure', initKind: 'early', mutate: 'PRAGMA user_version = 99' },
    { name: 'late prepare failure', initKind: 'late', mutate: 'DROP TABLE leases' },
    { name: 'close failure preserves early origin', initKind: 'early-close-failure', mutate: 'PRAGMA user_version = 99', injectCloseFailure: true },
  ]) {
    it(`T3 ${fixture.name}: one cleanup attempt and original error identity`, { timeout: 10_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qlb-store-open-t3-'));
      const dbPath = join(dir, 'qlb.db');
      initializeDb(dbPath);
      const mutate = new DatabaseSync(dbPath);
      mutate.exec(fixture.mutate);
      mutate.close();
      const observer = spawnNode(observerPath, observerOptions(dir, dbPath, {
        mode: fixture.initKind,
        initKind: fixture.initKind.startsWith('early') ? 'early' : 'late',
        injectCloseFailure: fixture.injectCloseFailure === true,
      }));
      try {
        const result = await boundedExit(observer, 5000);
        assertCleanExit(result, fixture.name);
        const report = JSON.parse(result.stdout.trim());
        assert.equal(report.storeConstructed, false);
        assert.equal(report.sameOrigin, true);
        assert.equal(report.closeCalls, 1);
        if (fixture.injectCloseFailure) {
          assert.equal(report.injectedCloseError.message, 'injected-close-failure');
          assert.notEqual(report.caught.message, report.injectedCloseError.message);
          assert.equal(report.afterFixtureCleanup.closedError.code, 'ERR_INVALID_STATE');
          if ('isOpen' in report.afterFixtureCleanup) assert.equal(report.afterFixtureCleanup.isOpen, false);
        } else {
          assert.equal(report.closedError.code, 'ERR_INVALID_STATE');
          if ('isOpen' in report) assert.equal(report.isOpen, false);
        }
        if (fixture.initKind === 'late') {
          assert.equal(report.originating.errcode, 1);
          assert.match(report.originating.message, /no such table: leases/);
        } else {
          assert.match(report.originating.message, /schema user_version=99/);
        }
        const fresh = new DatabaseSync(dbPath);
        fresh.exec('PRAGMA busy_timeout = 0');
        fresh.exec('PRAGMA locking_mode = EXCLUSIVE');
        fresh.exec('BEGIN IMMEDIATE');
        fresh.exec('COMMIT');
        fresh.close();
      } finally {
        if (observer.child.exitCode === null && observer.child.signalCode === null) {
          observer.child.kill('SIGKILL');
          await observer.result;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
