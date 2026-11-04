import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { cooperativeDrain as runCooperativeDrain, FLOCK_HELPER, FlockHelperExitedError, launchctlCswapAgent, productionTryAcquireLock, runRetirementDrain, type CswapAgent, type CswapDrainOptions, type LaunchctlCswapAgentDependencies } from '../src/cswap-agent';
import { listCswapProcesses, listCswapProcessesAsync, listCswapProcessesToSignal, listCswapProcessesToSignalAsync } from '../src/cswap-processes';
import { cutoverBegin } from '../src/commands/cutover';
import { phase } from '../src/lifecycle';
import { openStore } from '../src/store';
import { join } from 'node:path';
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

function helperEnv(home: string): NodeJS.ProcessEnv {
  return { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home };
}

function cooperativeDrain(options: CswapDrainOptions) {
  return runCooperativeDrain(options);
}

type FakeFlockHelper = {
  child: ChildProcess;
  stdout: EventEmitter;
  readonly killCalls: number;
  exit(code: number | null, signal: NodeJS.Signals | null): void;
  close(code: number | null, signal: NodeJS.Signals | null): void;
};

function fakeFlockHelper(piped = true): FakeFlockHelper {
  const stdout = new EventEmitter();
  let killCalls = 0;
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter | null;
    stdin: (EventEmitter & { end(): void; write(chunk: string, callback?: (error?: Error | null) => void): boolean; destroyed: boolean; writable: boolean }) | null;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals): boolean;
  };
  const stdin = new EventEmitter() as EventEmitter & { end(): void; write(chunk: string, callback?: (error?: Error | null) => void): boolean; destroyed: boolean; writable: boolean };
  stdin.end = () => { child.emit('close', 0, null); };
  stdin.write = (_chunk, callback) => { callback?.(); return true; };
  stdin.destroyed = false;
  stdin.writable = true;
  child.stdout = piped ? stdout : null;
  child.stdin = piped ? stdin : null;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { killCalls += 1; return true; };
  return {
    child: child as unknown as ChildProcess,
    stdout,
    get killCalls() { return killCalls; },
    exit: (code, signal) => {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
    },
    close: (code, signal) => { child.emit('close', code, signal); },
  };
}

function fixtureStore() {
  return openStore(join(mkdtempSync(join(tmpdir(), 'qlb-cswap-drain-')), 'qlb.db'));
}

function drainingAgent(drain: CswapAgent['drain']): { agent: CswapAgent; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    agent: {
      bootout: () => { calls.push('bootout'); return { ok: true }; },
      disable: () => { calls.push('disable'); return { ok: true }; },
      movePlist: () => { calls.push('move'); return { ok: true }; },
      restorePlist: () => { calls.push('restore'); return { ok: true }; },
      drain: async () => { calls.push('drain'); return drain(); },
    },
  };
}

function assertNoSignalBeforeConsumeLock(killsWhenConsumeLockBecameAvailable: number | undefined): void {
  assert.equal(killsWhenConsumeLockBecameAvailable, 0, 'QLB must not signal while the fixture consume lock is held');
}

test('production flock waits for a complete newline-delimited helper status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-flock-split-status-'));
  const lockDirectory = join(root, 'locks');
  mkdirSync(lockDirectory, { recursive: true });
  try {
    const lease = await productionTryAcquireLock(join(lockDirectory, 'auto.lock'), (_lockPath, cwd) => {
      return spawn(process.execPath, ['-e', [
        "process.stdout.write('loc');",
        "setImmediate(() => { process.stdout.write('ked\\n'); setImmediate(() => process.exit(0)); });",
      ].join(' ')], { cwd, env: helperEnv(root), stdio: ['pipe', 'pipe', 'ignore'] });
    });
    assert.ok(lease, 'a status split across stdout chunks must still acquire the lease');
    await lease();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production flock rejects a buffered locked result from an exited helper', async () => {
  const helper = fakeFlockHelper();
  const acquisition = productionTryAcquireLock('/fixture/auto.lock', () => helper.child);
  let protectedWorkRan = false;
  const protectedWork = acquisition.then(
    (lease) => { if (lease !== null) protectedWorkRan = true; },
    () => {},
  );

  helper.exit(17, null);
  helper.stdout.emit('data', Buffer.from('locked\n'));
  helper.close(17, null);

  await assert.rejects(acquisition, /fcntl flock helper exited unexpectedly \(17\)/);
  await protectedWork;
  assert.equal(protectedWorkRan, false, 'an exited helper must not permit protected work');
});

test('helper loss is reported with code flock-helper-exited', async () => {
  const helper = fakeFlockHelper();
  const acquisition = productionTryAcquireLock('/fixture/auto.lock', () => helper.child);
  helper.stdout.emit('data', Buffer.from('locked\n'));
  const lease = await acquisition;
  if (lease === null || lease.lost === undefined) throw new Error('expected a lease with loss reporting');

  helper.exit(17, null);
  const observed = lease.isLost?.();
  assert.ok(observed, 'helper exit before release must report a lost lease');
  assert.ok(observed instanceof FlockHelperExitedError);
  assert.equal(observed.code, 'flock-helper-exited');
  await lease();
  helper.close(17, null);
  const lost = await lease.lost;
  assert.ok(lost instanceof FlockHelperExitedError);
  assert.equal(lost.code, 'flock-helper-exited');
  assert.match(lost.message, /flock helper exited unexpectedly/);
  assert.equal(observed, lost);
});

test('production flock keeps a release requested before helper exit clean', async () => {
  const helper = fakeFlockHelper();
  const acquisition = productionTryAcquireLock('/fixture/auto.lock', () => helper.child);
  helper.stdout.emit('data', Buffer.from('locked\n'));
  const lease = await acquisition;
  if (lease === null) throw new Error('expected a lease');

  const released = lease();
  helper.exit(0, null);
  helper.close(0, null);
  await released;
  assert.equal(lease.isLost?.(), undefined);
});

test('production flock kills a helper with missing pipes before rejecting', async () => {
  const helper = fakeFlockHelper(false);
  await assert.rejects(
    productionTryAcquireLock('/fixture/auto.lock', () => helper.child),
    /fcntl flock helper must use piped stdin and stdout/,
  );
  assert.equal(helper.killCalls, 1);
});

test('production flock exposes helper loss synchronously and through its lost promise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-flock-lost-'));
  const lockDirectory = join(root, 'locks');
  mkdirSync(lockDirectory, { recursive: true });
  try {
    const lease = await productionTryAcquireLock(join(lockDirectory, 'auto.lock'), (_lockPath, cwd) => {
      return spawn(process.execPath, ['-e', "process.stdout.write('locked\\n'); setImmediate(() => process.exit(17));"], {
        cwd, env: helperEnv(root), stdio: ['pipe', 'pipe', 'ignore'],
      });
    });
    if (lease === null || lease.lost === undefined) throw new Error('expected a lease with loss reporting');
    const lost = await lease.lost;
    assert.match(lost.message, /flock helper exited unexpectedly/);
    assert.equal(lease.isLost?.(), lost);
    await lease();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stdin error during an active ping resolves it undefined and loses the lease permanently', async () => {
  const helper = fakeFlockHelper();
  const acquisition = productionTryAcquireLock('/fixture/active-ping.lock', () => helper.child);
  helper.stdout.emit('data', Buffer.from('locked\n'));
  const lease = await acquisition;
  assert.ok(lease);
  const pending = lease.confirmHeld?.();
  (helper.child.stdin as unknown as EventEmitter).emit('error', new Error('EPIPE'));
  assert.equal(await pending, undefined);
  assert.match(lease.isLost?.()?.message ?? '', /stdin failed/);
  assert.equal(await lease.confirmHeld?.(), undefined);
  await lease();
});

test('a duplicate reply for an earlier ping cannot settle the next ping', async () => {
  const helper = fakeFlockHelper();
  const acquisition = productionTryAcquireLock('/fixture/sequence.lock', () => helper.child);
  helper.stdout.emit('data', Buffer.from('locked\n'));
  const lease = await acquisition;
  assert.ok(lease);
  const first = lease.confirmHeld?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  helper.stdout.emit('data', Buffer.from('held 1 123\n'));
  assert.equal(await first, 123);
  const second = lease.confirmHeld?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  helper.stdout.emit('data', Buffer.from('held 1 999\n'));
  let settled = false;
  void second?.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  helper.stdout.emit('data', Buffer.from('held 2 123\n'));
  assert.equal(await second, 123);
  await lease();
});

test('a helper that stops answering pings fails closed before SIGTERM', async () => {
  const kills: number[] = [];
  const lease = Object.assign(() => {}, {
    confirmHeld: async () => undefined,
    isLost: () => undefined,
  });
  const result = await cooperativeDrain({
    listProcesses: () => [{ pid: 17 }],
    listSignalTargets: () => [{ pid: 17 }],
    lockPaths: () => ['backup/.lock'],
    tryAcquireLock: () => lease,
    kill: (pid) => { kills.push(pid); },
    now: () => 0,
    sleep: async () => {},
    cooperativeWaitMs: 0,
    termWaitMs: 0,
  });

  assert.deepEqual(result, { ok: false, code: 'cswap-drain-error lease-lost backup/.lock' });
  assert.deepEqual(kills, []);
});

test('an injected fake without confirmHeld falls back to isLost with the path and helper detail', async () => {
  const loss = new Error('helper exited');
  let lost: Error | undefined;
  const kills: number[] = [];
  const lease = Object.assign(() => {}, { isLost: () => lost });
  const result = await cooperativeDrain({
    listProcesses: () => [{ pid: 17 }, { pid: 18 }],
    listSignalTargets: () => [{ pid: 17 }, { pid: 18 }],
    lockPaths: () => ['backup/.lock'],
    tryAcquireLock: () => lease,
    kill: (pid) => { kills.push(pid); lost = loss; },
    now: () => 0,
    sleep: async () => {},
    cooperativeWaitMs: 0,
    termWaitMs: 0,
  });

  assert.deepEqual(result, { ok: false, code: 'cswap-drain-error lease-lost backup/.lock: helper exited' });
  assert.deepEqual(kills, [17]);
});

test('an inode replacement fails closed before SIGTERM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-flock-inode-'));
  const lock = join(root, 'auto.lock');
  const replacement = join(root, 'replacement.lock');
  writeFileSync(lock, 'original');
  const originalInode = lstatSync(lock).ino;
  writeFileSync(replacement, 'replacement');
  renameSync(replacement, lock);
  const kills: number[] = [];
  const lease = Object.assign(() => {}, { confirmHeld: async () => originalInode });
  try {
    const result = await cooperativeDrain({
      listProcesses: () => [{ pid: 18 }],
      listSignalTargets: () => [{ pid: 18 }],
      lockPaths: () => [lock],
      tryAcquireLock: () => lease,
      kill: (pid) => { kills.push(pid); },
      now: () => 0,
      sleep: async () => {},
      cooperativeWaitMs: 0,
      termWaitMs: 0,
    });
    assert.deepEqual(result, { ok: false, code: `cswap-drain-error lease-lost ${lock}` });
    assert.deepEqual(kills, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a real flock helper confirms its inode and reports loss after its test child is killed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-flock-confirm-'));
  const lock = join(root, 'auto.lock');
  let helper: ChildProcess | undefined;
  try {
    const lease = await productionTryAcquireLock(lock, (lockPath, cwd) => {
      helper = spawn('/usr/bin/python3', ['-I', '-c', FLOCK_HELPER, lockPath], {
        cwd,
        env: helperEnv(root),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return helper;
    });
    assert.ok(lease);
    if (helper === undefined) throw new Error('expected the test to start a flock helper');
    const testHelper = helper;
    assert.equal(await lease.confirmHeld?.(), lstatSync(lock).ino);
    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      const exited = new Promise<void>((resolve) => testHelper.once('exit', () => resolve()));
      testHelper.kill('SIGKILL');
      await exited;
      assert.equal(await lease.confirmHeld?.(), undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(uncaught, [], 'a dead helper stdin must not emit an uncaught EPIPE');
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    await lease();
  } finally {
    if (helper !== undefined && helper.exitCode === null && helper.signalCode === null) helper.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a SIGSTOPped helper release is bounded and kills only its test child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-flock-release-timeout-'));
  const lock = join(root, 'auto.lock');
  let helper: ChildProcess | undefined;
  try {
    const lease = await productionTryAcquireLock(lock, (lockPath, cwd) => {
      helper = spawn('/usr/bin/python3', ['-I', '-c', FLOCK_HELPER, lockPath], {
        cwd,
        env: helperEnv(root),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return helper;
    });
    assert.ok(lease);
    if (helper === undefined) throw new Error('expected the test to start a flock helper');
    const testHelper = helper;
    testHelper.kill('SIGSTOP');
    const exited = new Promise<void>((resolve) => testHelper.once('exit', () => resolve()));
    await Promise.race([
      lease(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('bounded release exceeded 5 seconds')), 5_000)),
    ]);
    await exited;
    assert.notEqual(testHelper.signalCode, null);
  } finally {
    if (helper !== undefined && helper.exitCode === null && helper.signalCode === null) {
      helper.kill('SIGCONT');
      helper.kill('SIGKILL');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a late held reply after timeout cannot credit a later confirmation', async () => {
  const helper = fakeFlockHelper();
  const acquisition = productionTryAcquireLock('/fixture/auto.lock', () => helper.child);
  helper.stdout.emit('data', Buffer.from('locked\n'));
  const lease = await acquisition;
  assert.ok(lease);

  const first = lease.confirmHeld?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 2_050));
  helper.stdout.emit('data', Buffer.from('held 1 123\n'));
  assert.equal(await first, undefined);
  assert.match(lease.isLost?.()?.message ?? '', /confirmation timed out/);
  assert.equal(await lease.confirmHeld?.(), undefined);
  await lease();
});

test('a second lock lost while the first helper is pinged is refused before the per-target strict scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-flock-final-sweep-'));
  const firstPath = join(root, 'first.lock');
  const secondPath = join(root, 'second.lock');
  writeFileSync(firstPath, 'first');
  writeFileSync(secondPath, 'second');
  let releaseFirstPing: (() => void) | undefined;
  let secondLost: Error | undefined;
  let firstPinged: (() => void) | undefined;
  const pingStarted = new Promise<void>((resolve) => { firstPinged = resolve; });
  const first = Object.assign(() => {}, {
    confirmHeld: () => new Promise<number>((resolve) => {
      firstPinged?.();
      releaseFirstPing = () => resolve(lstatSync(firstPath).ino);
    }),
  });
  const second = Object.assign(() => {}, {
    confirmHeld: async () => lstatSync(secondPath).ino,
    isLost: () => secondLost,
  });
  const kills: number[] = [];
  let targetCalls = 0;
  try {
    const resultPromise = cooperativeDrain({
      listProcesses: () => [{ pid: 61 }],
      listSignalTargets: () => ++targetCalls === 1 ? [{ pid: 61 }] : (() => { throw new Error('must not reach strict scan'); })(),
      lockPaths: () => [firstPath, secondPath],
      tryAcquireLock: (path) => path === firstPath ? first : second,
      kill: (pid) => { kills.push(pid); },
      now: () => 0,
      sleep: async () => {},
      cooperativeWaitMs: 0,
      termWaitMs: 0,
    });
    await pingStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    secondLost = new Error('second helper exited');
    releaseFirstPing?.();
    assert.deepEqual(await resultPromise, { ok: false, code: `cswap-drain-error lease-lost ${secondPath}: second helper exited` });
    assert.deepEqual(kills, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('signals immediately after the final sweep with no intervening scan', async () => {
  let now = 0;
  let alive = true;
  let targetChecked = false;
  let finalSweepSeen = false;
  let microtaskFired = false;
  const order: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'qlb-cswap-order-'));
  const lock = join(root, 'auto.lock');
  writeFileSync(lock, 'locked');
  const lease = Object.assign(() => {}, {
    confirmHeld: async () => { order.push('pings'); return lstatSync(lock).ino; },
    isLost: () => {
      order.push('sweep');
      if (targetChecked) {
        finalSweepSeen = true;
        queueMicrotask(() => { microtaskFired = true; });
      }
      return undefined;
    },
  });
  try {
    const result = await cooperativeDrain({
      listProcesses: () => { order.push('processes'); return alive ? [{ pid: 62 }] : []; },
      listSignalTargets: (() => { let calls = 0; return () => { if (++calls > 1) targetChecked = true; order.push('targets'); return [{ pid: 62 }]; }; })(),
      lockPaths: () => [lock],
      tryAcquireLock: () => lease,
      kill: () => {
        order.push('kill');
        assert.equal(finalSweepSeen, true, 'kill must run in the final sweep\'s synchronous turn');
        assert.equal(microtaskFired, false, 'no await may intervene between finalSweep and kill');
        alive = false;
      },
      now: () => now,
      sleep: async () => { now += 1; },
      cooperativeWaitMs: 0,
      termWaitMs: 1,
      pollMs: 1,
    });
    const kill = order.indexOf('kill');
    assert.deepEqual(result, { ok: true });
    assert.ok(order.lastIndexOf('pings', kill) < order.lastIndexOf('targets', kill), 'pings must precede target identity');
    assert.ok(order.lastIndexOf('targets', kill) < order.lastIndexOf('sweep', kill), 'target identity must precede the final sweep');
    const finalSweep = order.lastIndexOf('sweep', kill);
    assert.ok(finalSweep < kill, 'the final lease sweep must precede SIGTERM');
    assert.equal(order.slice(finalSweep + 1, kill).some((event) => event === 'processes' || event === 'targets'), false, 'no lister call may fall between the final sweep and SIGTERM');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses PID reuse when target identity changes during lease pings', async () => {
  let resolvePing: (() => void) | undefined;
  let pingStarted: (() => void) | undefined;
  let strictTarget = true;
  const started = new Promise<void>((resolve) => { pingStarted = resolve; });
  const kills: number[] = [];
  const root = mkdtempSync(join(tmpdir(), 'qlb-cswap-pid-reuse-'));
  const lock = join(root, 'auto.lock');
  writeFileSync(lock, 'locked');
  const lease = Object.assign(() => {}, {
    confirmHeld: () => new Promise<number>((resolve) => {
      pingStarted?.();
      resolvePing = () => resolve(lstatSync(lock).ino);
    }),
  });
  const resultPromise = cooperativeDrain({
    listProcesses: () => [{ pid: 63 }],
    listSignalTargets: () => strictTarget ? [{ pid: 63 }] : [],
    lockPaths: () => [lock],
    tryAcquireLock: () => lease,
    kill: (pid) => { kills.push(pid); },
    now: () => 0,
    sleep: async () => {},
    cooperativeWaitMs: 0,
    termWaitMs: 0,
  });

  try {
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    strictTarget = false;
    resolvePing?.();
    assert.deepEqual(await resultPromise, { ok: false, code: 'cswap-unidentified-survivor' });
    assert.deepEqual(kills, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when a helper loses its lease while target identity is re-classified', async () => {
  let resolveTargets: ((targets: { pid: number }[]) => void) | undefined;
  let targetsStarted: (() => void) | undefined;
  let lost: Error | undefined;
  const started = new Promise<void>((resolve) => { targetsStarted = resolve; });
  const kills: number[] = [];
  const root = mkdtempSync(join(tmpdir(), 'qlb-cswap-reclassify-'));
  const lock = join(root, 'auto.lock');
  writeFileSync(lock, 'locked');
  const lease = Object.assign(() => {}, {
    confirmHeld: async () => lstatSync(lock).ino,
    isLost: () => lost,
  });
  const resultPromise = cooperativeDrain({
    listProcesses: () => [{ pid: 64 }],
    listSignalTargets: () => new Promise((resolve) => {
      targetsStarted?.();
      resolveTargets = resolve;
    }),
    lockPaths: () => [lock],
    tryAcquireLock: () => lease,
    kill: (pid) => { kills.push(pid); },
    now: () => 0,
    sleep: async () => {},
    cooperativeWaitMs: 0,
    termWaitMs: 0,
  });

  try {
    await started;
    lost = new Error('helper exited');
    resolveTargets?.([{ pid: 64 }]);
    assert.deepEqual(await resultPromise, { ok: false, code: `cswap-drain-error lease-lost ${lock}: helper exited` });
    assert.deepEqual(kills, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skips a PID that leaves the strict target list and is no longer live', async () => {
  let now = 0;
  let processCalls = 0;
  let targetCalls = 0;
  const kills: number[] = [];
  const result = await cooperativeDrain({
    listProcesses: () => ++processCalls <= 2 ? [{ pid: 31 }] : [],
    // Step 5 identifies it; only the per-target step-6b scan loses it.
    listSignalTargets: () => ++targetCalls === 1 ? [{ pid: 31 }] : [],
    lockPaths: () => ['backup/.lock'],
    tryAcquireLock: () => () => {},
    kill: (pid) => { kills.push(pid); },
    now: () => now,
    sleep: async () => { now += 1; },
    cooperativeWaitMs: 0,
    termWaitMs: 1,
    pollMs: 1,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(kills, []);
});

test('refuses a live PID that leaves the strict target list before SIGTERM', async () => {
  const kills: number[] = [];
  const result = await cooperativeDrain({
    listProcesses: () => [{ pid: 32 }],
    listSignalTargets: () => [],
    lockPaths: () => ['backup/.lock'],
    tryAcquireLock: () => () => {},
    kill: (pid) => { kills.push(pid); },
    now: () => 0,
    sleep: async () => {},
    cooperativeWaitMs: 0,
    termWaitMs: 0,
  });

  assert.deepEqual(result, { ok: false, code: 'cswap-unidentified-survivor' });
  assert.deepEqual(kills, []);
});

test('fails closed when releasing a partial acquisition times out', async () => {
  const lockA = 'backup/.lock';
  const lockB = 'backup/credentials/.consume-2.lock';
  const releases: string[] = [];
  const attempts: string[] = [];
  const kills: number[] = [];
  const releaseA = Object.assign(() => { releases.push(lockA); }, {
    releaseTimedOut: () => new Error('helper release timed out'),
  });
  const result = await cooperativeDrain({
    listProcesses: () => [{ pid: 65 }],
    listSignalTargets: () => [{ pid: 65 }],
    lockPaths: () => [lockA, lockB],
    tryAcquireLock: (path) => {
      attempts.push(path);
      return path === lockA ? releaseA : null;
    },
    kill: (pid) => { kills.push(pid); },
    now: () => 0,
    sleep: async () => { throw new Error('must not retry after an unconfirmed release'); },
    cooperativeWaitMs: 0,
    lockWaitMs: 1,
    termWaitMs: 0,
  });

  assert.deepEqual(result, { ok: false, code: `cswap-drain-error lease-release-unconfirmed ${lockA}: helper release timed out` });
  assert.deepEqual(attempts, [lockA, lockB]);
  assert.deepEqual(releases, [lockA]);
  assert.deepEqual(kills, []);
});

test('step 3b release failure after a lease loss keeps the lease-lost code', async () => {
  const first = Object.assign(() => {}, { releaseTimedOut: () => new Error('first release timed out') });
  const second = Object.assign(() => {}, { isLost: () => new Error('second helper exited') });
  const result = await cooperativeDrain({
    listProcesses: () => [{ pid: 66 }], listSignalTargets: () => [{ pid: 66 }], lockPaths: () => ['first.lock', 'second.lock'],
    tryAcquireLock: (path) => path === 'first.lock' ? first : second,
    kill: () => { throw new Error('must not signal after a 3b lease loss'); }, now: () => 0, sleep: async () => {}, cooperativeWaitMs: 0,
  });
  assert.deepEqual(result, {
    ok: false,
    code: 'cswap-drain-error lease-release-unconfirmed first.lock: first release timed out; after cswap-drain-error lease-lost second.lock: second helper exited',
  });
});

test('a lock path replaced during the per-target strict scan fails closed before SIGTERM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-final-sweep-scan-'));
  const lock = join(root, 'auto.lock');
  const replacement = join(root, 'replacement.lock');
  writeFileSync(lock, 'original');
  const inode = lstatSync(lock).ino;
  const kills: number[] = [];
  let targetCalls = 0;
  let confirmations = 0;
  try {
    const result = await cooperativeDrain({
      listProcesses: () => [{ pid: 70 }],
      listSignalTargets: () => {
        targetCalls += 1;
        if (targetCalls === 2) {
          assert.equal(confirmations, 1, 'the leaseIntact inode check must pass before the per-target scan');
          assert.equal(lstatSync(lock).ino, inode, 'the original inode must still be present before replacement');
          writeFileSync(replacement, 'replacement');
          renameSync(replacement, lock);
        }
        return [{ pid: 70 }];
      },
      lockPaths: () => [lock], tryAcquireLock: () => Object.assign(() => {}, { confirmHeld: async () => { confirmations += 1; return inode; } }),
      kill: (pid) => { kills.push(pid); }, now: () => 0, sleep: async () => {}, cooperativeWaitMs: 0, termWaitMs: 0,
    });
    assert.equal(targetCalls, 2, 'the per-target strict scan must be reached');
    assert.match(result.code ?? '', new RegExp(`lease-lost ${lock}`));
    assert.deepEqual(kills, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a first lock replaced while the second helper is pinged fails closed before SIGTERM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-final-sweep-two-'));
  const firstPath = join(root, 'first.lock'); const secondPath = join(root, 'second.lock'); const replacement = join(root, 'replacement.lock');
  writeFileSync(firstPath, 'first'); writeFileSync(secondPath, 'second');
  const firstInode = lstatSync(firstPath).ino; const secondInode = lstatSync(secondPath).ino;
  const first = Object.assign(() => {}, { confirmHeld: async () => firstInode });
  let secondPings = 0;
  const second = Object.assign(() => {}, { confirmHeld: async () => { if (++secondPings === 1) { writeFileSync(replacement, 'replacement'); renameSync(replacement, firstPath); } return secondInode; } });
  const kills: number[] = [];
  try {
    const result = await cooperativeDrain({ listProcesses: () => [{ pid: 71 }], listSignalTargets: () => [{ pid: 71 }], lockPaths: () => [firstPath, secondPath], tryAcquireLock: (path) => path === firstPath ? first : second, kill: (pid) => { kills.push(pid); }, now: () => 0, sleep: async () => {}, cooperativeWaitMs: 0, termWaitMs: 0 });
    assert.match(result.code ?? '', new RegExp(`lease-lost ${firstPath}`)); assert.deepEqual(kills, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an inode mismatch present at leaseIntact\'s own lstat is refused before the per-target strict scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-inner-inode-'));
  const lock = join(root, 'auto.lock'); const replacement = join(root, 'replacement.lock');
  writeFileSync(lock, 'original'); const inode = lstatSync(lock).ino; writeFileSync(replacement, 'replacement'); renameSync(replacement, lock);
  try {
    let targetCalls = 0;
    const result = await cooperativeDrain({ listProcesses: () => [{ pid: 72 }], listSignalTargets: () => ++targetCalls === 1 ? [{ pid: 72 }] : (() => { throw new Error('strict scan reached'); })(), lockPaths: () => [lock], tryAcquireLock: () => Object.assign(() => {}, { confirmHeld: async () => inode }), kill: () => { throw new Error('kill'); }, now: () => 0, sleep: async () => {}, cooperativeWaitMs: 0 });
    assert.match(result.code ?? '', new RegExp(`lease-lost ${lock}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an empty survivor set under two locks fails closed when the first lock is replaced during the second ping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-empty-two-'));
  const firstPath = join(root, 'first.lock'); const secondPath = join(root, 'second.lock'); const replacement = join(root, 'replacement.lock');
  writeFileSync(firstPath, 'first'); writeFileSync(secondPath, 'second');
  const firstInode = lstatSync(firstPath).ino; const secondInode = lstatSync(secondPath).ino;
  try {
    let lists = 0;
    const result = await cooperativeDrain({
      listProcesses: () => ++lists === 1 ? [{ pid: 73 }] : [], listSignalTargets: () => [], lockPaths: () => [firstPath, secondPath],
      tryAcquireLock: (path) => path === firstPath ? Object.assign(() => {}, { confirmHeld: async () => firstInode }) : Object.assign(() => {}, { confirmHeld: async () => { writeFileSync(replacement, 'replacement'); renameSync(replacement, firstPath); return secondInode; } }),
      kill: () => { throw new Error('kill'); }, now: () => 0, sleep: async () => {}, cooperativeWaitMs: 0,
    });
    assert.match(result.code ?? '', new RegExp(`lease-lost ${firstPath}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('step 8 finalSweep catches a first lock replaced during the second final ping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-step-8-final-sweep-'));
  const firstPath = join(root, 'first.lock'); const secondPath = join(root, 'second.lock'); const replacement = join(root, 'replacement.lock');
  writeFileSync(firstPath, 'first'); writeFileSync(secondPath, 'second');
  const firstInode = lstatSync(firstPath).ino; const secondInode = lstatSync(secondPath).ino;
  const first = Object.assign(() => {}, { confirmHeld: async () => firstInode });
  let secondPings = 0;
  const second = Object.assign(() => {}, { confirmHeld: async () => {
    secondPings += 1;
    if (secondPings === 3) { writeFileSync(replacement, 'replacement'); renameSync(replacement, firstPath); }
    return secondInode;
  } });
  let now = 0;
  const kills: number[] = [];
  try {
    const result = await cooperativeDrain({
      listProcesses: (() => { let lists = 0; return () => ++lists <= 2 ? [{ pid: 73 }] : []; })(),
      listSignalTargets: () => [{ pid: 73 }], lockPaths: () => [firstPath, secondPath],
      tryAcquireLock: (path) => path === firstPath ? first : second,
      kill: (pid) => { kills.push(pid); }, now: () => now, sleep: async () => { now += 1; }, cooperativeWaitMs: 0, termWaitMs: 1, pollMs: 1,
    });
    assert.equal(secondPings, 3, 'replacement must occur only during the step-8 lease check');
    assert.deepEqual(kills, [73]);
    assert.match(result.code ?? '', new RegExp(`lease-lost ${firstPath}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses before any SIGTERM when one of several survivors is absent from the strict preflight', async () => {
  const kills: number[] = []; let postLockLists = 0;
  const result = await cooperativeDrain({ listProcesses: () => { postLockLists += 1; return [{ pid: 74 }, { pid: 75 }]; }, listSignalTargets: () => [{ pid: 74 }], lockPaths: () => ['a'], tryAcquireLock: () => () => {}, kill: (pid) => { kills.push(pid); }, now: () => 0, sleep: async () => {}, cooperativeWaitMs: 0 });
  assert.deepEqual(result, { ok: false, code: 'cswap-unidentified-survivor' }); assert.deepEqual(kills, []); assert.equal(postLockLists, 2);
});

test('a helper exit queued during the per-target scan is seen before SIGTERM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-queued-exit-'));
  const lock = join(root, 'auto.lock');
  writeFileSync(lock, 'lock');
  const inode = lstatSync(lock).ino;
  const helper = fakeFlockHelper();
  const acquisition = productionTryAcquireLock(lock, () => helper.child);
  helper.stdout.emit('data', Buffer.from('locked\n'));
  const lease = await acquisition;
  if (lease === null || helper.child.stdin === null) throw new Error('expected a production-style lease with stdin');
  const stdin = helper.child.stdin as unknown as { write(chunk: string, callback?: (error?: Error | null) => void): boolean };
  stdin.write = (chunk, callback) => {
    callback?.();
    const sequence = /^p ([0-9]+)\n$/.exec(chunk)?.[1];
    if (sequence !== undefined) setImmediate(() => helper.stdout.emit('data', Buffer.from(`held ${sequence} ${inode}\n`)));
    return true;
  };
  let targetCalls = 0;
  const kills: number[] = [];
  try {
    const result = await cooperativeDrain({
      listProcesses: () => [{ pid: 76 }],
      listSignalTargets: () => {
        if (++targetCalls === 2) setImmediate(() => helper.exit(17, null));
        return [{ pid: 76 }];
      },
      lockPaths: () => [lock], tryAcquireLock: () => lease,
      kill: (pid) => { kills.push(pid); }, now: () => 0, sleep: async () => {}, cooperativeWaitMs: 0, termWaitMs: 0,
    });
    assert.match(result.code ?? '', /lease-lost .*flock helper exited unexpectedly \(17\)/);
    assert.deepEqual(kills, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a thrown drain step still reports lease-release-unconfirmed with the prior code appended', async () => {
  const release = Object.assign(() => {}, { releaseTimedOut: () => new Error('release timed out') });
  const result = await cooperativeDrain({ listProcesses: () => [{ pid: 77 }], listSignalTargets: () => Promise.reject(new Error('scan failed')), lockPaths: () => ['a'], tryAcquireLock: () => release, kill: () => {}, now: () => 0, sleep: async () => {}, cooperativeWaitMs: 0 });
  assert.match(result.code ?? '', /^cswap-drain-error lease-release-unconfirmed a: release timed out; after cswap-drain-error scan failed$/);
});

test('an async kill rejecting with ESRCH is treated as exited', async () => {
  let now = 0; let alive = true;
  const result = await cooperativeDrain({ listProcesses: () => alive ? [{ pid: 78 }] : [], listSignalTargets: () => [{ pid: 78 }], lockPaths: () => ['a'], tryAcquireLock: () => () => {}, kill: async () => { alive = false; throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }, now: () => now, sleep: async () => { now += 1; }, cooperativeWaitMs: 0, termWaitMs: 1, pollMs: 1 });
  assert.deepEqual(result, { ok: true });
});

test('an injected requireConfirmHeld refuses a lease without confirmHeld as lease-lost', async () => {
  const kills: number[] = []; let now = 0;
  const agent = launchctlCswapAgent({ exec: () => '', fs: { exists: () => true, mkdir: () => {}, readFile: () => JSON.stringify({ sequence: [] }), rename: () => {} }, uid: () => 1, home: () => '/fixture', qlbHome: () => '/fixture', listProcesses: () => [{ pid: 79 }], listSignalTargets: () => [{ pid: 79 }], requireConfirmHeld: true, tryAcquireLock: () => () => {}, kill: (pid) => { kills.push(pid); }, now: () => now, sleep: async () => { now += 60_000; } });
  const result = await agent.drain(); assert.match(result.code ?? '', /lease-lost .*no confirmHeld/); assert.deepEqual(kills, []);
});

test('requireConfirmHeld refuses a lease without confirmHeld at step 4', async () => {
  let lists = 0;
  const result = await cooperativeDrain({
    listProcesses: () => ++lists === 1 ? [{ pid: 79 }] : [], listSignalTargets: () => [], lockPaths: () => ['a'],
    tryAcquireLock: () => () => {}, kill: () => { throw new Error('must not signal'); }, now: () => 0, sleep: async () => {},
    cooperativeWaitMs: 0, requireConfirmHeld: true,
  });
  assert.deepEqual(result, { ok: false, code: 'cswap-drain-error lease-lost a: no confirmHeld' });
});

test('requireConfirmHeld refuses a lease without confirmHeld at step 8', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qlb-require-confirm-final-'));
  const lock = join(root, 'auto.lock');
  writeFileSync(lock, 'locked');
  const inode = lstatSync(lock).ino;
  const lease: (() => void) & { confirmHeld?: () => Promise<number> } = () => {};
  lease.confirmHeld = async () => inode;
  let now = 0;
  let processCalls = 0;
  const kills: number[] = [];
  try {
    const result = await cooperativeDrain({
      listProcesses: () => {
        processCalls += 1;
        if (processCalls <= 2) return [{ pid: 79 }];
        delete lease.confirmHeld;
        return [];
      },
      listSignalTargets: () => [{ pid: 79 }], lockPaths: () => [lock], tryAcquireLock: () => lease,
      kill: (pid) => { kills.push(pid); }, now: () => now, sleep: async () => { now += 1; },
      cooperativeWaitMs: 0, termWaitMs: 1, pollMs: 1, requireConfirmHeld: true,
    });
    assert.equal(processCalls, 3, 'the missing confirmHeld must be introduced after the step-7 check');
    assert.deepEqual(kills, [79]);
    assert.deepEqual(result, { ok: false, code: `cswap-drain-error lease-lost ${lock}: no confirmHeld` });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the production factory supplies requireConfirmHeld true and async process scans', () => {
  let captured: LaunchctlCswapAgentDependencies | undefined;
  const { productionLaunchctlCswapAgent } = require('../src/cswap-agent') as typeof import('../src/cswap-agent');
  productionLaunchctlCswapAgent('/fixture', '/fixture', undefined, (deps) => { captured = deps; return unavailableAgent; });
  assert.equal(captured?.requireConfirmHeld, true);
  assert.equal(captured?.listProcesses, listCswapProcessesAsync);
  assert.equal(captured?.listSignalTargets, listCswapProcessesToSignalAsync);
});

const unavailableAgent: CswapAgent = { bootout: () => ({ ok: true }), disable: () => ({ ok: true }), movePlist: () => ({ ok: true }), restorePlist: () => ({ ok: true }), drain: () => ({ ok: true }) };

test('refuses when a process genuinely exits between the loose scan and the strict preflight', async () => {
  let lists = 0; const kills: number[] = [];
  const result = await cooperativeDrain({ listProcesses: () => ++lists <= 2 ? [{ pid: 80 }] : [], listSignalTargets: () => [], lockPaths: () => ['a'], tryAcquireLock: () => () => {}, kill: (pid) => { kills.push(pid); }, now: () => 0, sleep: async () => {}, cooperativeWaitMs: 0 });
  assert.deepEqual(result, { ok: false, code: 'cswap-unidentified-survivor' }); assert.deepEqual(kills, []);
});

test('waits for a held C-swap consume lock before signaling, then drains cooperatively', async () => {
  let now = 0;
  let consumeLockHeld = true;
  let killsWhenConsumeLockBecameAvailable: number | undefined;
  let terminated = false;
  const kills: Array<{ pid: number; signal: 'SIGTERM' }> = [];
  const releases: string[] = [];
  const { agent, calls } = drainingAgent(() => cooperativeDrain({
    listProcesses: () => terminated ? [] : [{ pid: 42 }],
    listSignalTargets: () => terminated ? [] : [{ pid: 42 }],
    lockPaths: () => ['backup/.lock', 'backup/credentials/.consume-2.lock'],
    tryAcquireLock: (path) => {
      if (path.endsWith('.consume-2.lock') && consumeLockHeld) return null;
      if (path.endsWith('.consume-2.lock')) killsWhenConsumeLockBecameAvailable = kills.length;
      return () => { releases.push(path); };
    },
    kill: (pid, signal) => { kills.push({ pid, signal }); terminated = true; },
    now: () => now,
    sleep: async () => { now += 1; if (now === 5) consumeLockHeld = false; },
    cooperativeWaitMs: 3,
    lockWaitMs: 5,
    termWaitMs: 2,
    pollMs: 1,
  }));
  const store = fixtureStore();
  try {
    const result = await cutoverBegin(store.dbPath, agent);
    assert.deepEqual(result, { ok: true, state: 'cutting-over' });
    assert.deepEqual(calls, ['bootout', 'disable', 'move', 'drain']);
    assertNoSignalBeforeConsumeLock(killsWhenConsumeLockBecameAvailable);
    assert.deepEqual(kills, [{ pid: 42, signal: 'SIGTERM' }]);
    assert.deepEqual(releases, [
      'backup/.lock',
      'backup/.lock',
      'backup/credentials/.consume-2.lock',
      'backup/.lock',
    ]);
  } finally {
    store.close();
  }
});

test('refuses to signal an unidentified loose-list survivor', async () => {
  const kills: Array<{ pid: number; signal: 'SIGTERM' }> = [];
  const result = await cooperativeDrain({
    listProcesses: () => [{ pid: 88 }],
    listSignalTargets: () => [],
    lockPaths: () => ['backup/.lock'],
    tryAcquireLock: () => () => {},
    kill: (pid, signal) => { kills.push({ pid, signal }); },
    now: () => 0,
    sleep: async () => {},
    cooperativeWaitMs: 0,
  });

  assert.deepEqual(result, { ok: false, code: 'cswap-unidentified-survivor' });
  assert.deepEqual(kills, []);
});

test('signals a survivor only when the strict lister identifies its PID', async () => {
  let now = 0;
  let terminated = false;
  const kills: Array<{ pid: number; signal: 'SIGTERM' }> = [];
  const result = await cooperativeDrain({
    listProcesses: () => terminated ? [] : [{ pid: 89 }],
    listSignalTargets: () => terminated ? [] : [{ pid: 89 }],
    lockPaths: () => ['backup/.lock'],
    tryAcquireLock: () => () => {},
    kill: (pid, signal) => { kills.push({ pid, signal }); terminated = true; },
    now: () => now,
    sleep: async () => { now += 1; },
    cooperativeWaitMs: 0,
    termWaitMs: 1,
    pollMs: 1,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(kills, [{ pid: 89, signal: 'SIGTERM' }]);
});

test('launchctlCswapAgent issues bootout, disable and plist move with the exact argv', async () => {
  const root = '/fixture-home';
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let plistMoved = false;
  const agent = launchctlCswapAgent({
    exec: (file, args) => { calls.push({ file, args }); },
    fs: {
      exists: (path) => path === `${root}/Library/LaunchAgents/com.cswap.auto.plist` ? !plistMoved : plistMoved,
      mkdir: () => {}, readFile: () => JSON.stringify({ sequence: [] }),
      rename: () => { plistMoved = true; },
    },
    uid: () => 501, home: () => root, qlbHome: () => root,
    tryAcquireLock: () => () => {}, kill: () => {}, now: () => 0, sleep: async () => {},
  });
  assert.deepEqual(await agent.bootout(), { ok: true });
  assert.deepEqual(await agent.disable(), { ok: true });
  assert.deepEqual(await agent.movePlist(), { ok: true });
  assert.deepEqual(calls, [
    { file: '/bin/launchctl', args: ['bootout', 'gui/501/com.cswap.auto'] },
    { file: '/bin/launchctl', args: ['disable', 'gui/501/com.cswap.auto'] },
  ]);
});

test('restorePlist accepts a bootstrap EIO only when launchd reports the service loaded', async () => {
  const root = '/fixture-home';
  const source = `${root}/Library/LaunchAgents/com.cswap.auto.plist`;
  const calls: string[][] = [];
  let prints = 0;
  const agent = launchctlCswapAgent({
    exec: (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'print' && ++prints === 1) throw Object.assign(new Error('Could not find service'), { code: 'ESRCH' });
      if (args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5: Input/output error');
    },
    fs: { exists: (path) => path === source, mkdir: () => {}, readFile: () => JSON.stringify({ sequence: [] }), rename: () => {} },
    uid: () => 501, home: () => root, qlbHome: () => root,
    tryAcquireLock: () => () => {}, kill: () => {}, now: () => 0, sleep: async () => {},
  });

  assert.deepEqual(await agent.restorePlist(), { ok: true });
  assert.deepEqual(calls, [
    ['enable', 'gui/501/com.cswap.auto'],
    ['print', 'gui/501/com.cswap.auto'],
    ['bootstrap', 'gui/501', source],
    ['print', 'gui/501/com.cswap.auto'],
  ]);
});

test('restorePlist leaves bootstrap failure fatal when launchd reports the service not loaded', async () => {
  const root = '/fixture-home';
  const source = `${root}/Library/LaunchAgents/com.cswap.auto.plist`;
  const agent = launchctlCswapAgent({
    exec: (_file, args) => {
      if (args[0] === 'print') throw Object.assign(new Error('Could not find service'), { code: 'ESRCH' });
      if (args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5: Input/output error');
    },
    fs: { exists: (path) => path === source, mkdir: () => {}, readFile: () => JSON.stringify({ sequence: [] }), rename: () => {} },
    uid: () => 501, home: () => root, qlbHome: () => root,
    tryAcquireLock: () => () => {}, kill: () => {}, now: () => 0, sleep: async () => {},
  });

  assert.deepEqual(await agent.restorePlist(), { ok: false, code: 'cswap-agent-error' });
});

test('a repeat restore sees the loaded service and does not bootstrap it again', async () => {
  const root = '/fixture-home';
  const source = `${root}/Library/LaunchAgents/com.cswap.auto.plist`;
  let bootstraps = 0;
  const agent = launchctlCswapAgent({
    exec: (_file, args) => {
      if (args[0] === 'print' && bootstraps === 0) throw Object.assign(new Error('Could not find service'), { code: 'ESRCH' });
      if (args[0] === 'bootstrap') bootstraps += 1;
    },
    fs: { exists: (path) => path === source, mkdir: () => {}, readFile: () => JSON.stringify({ sequence: [] }), rename: () => {} },
    uid: () => 501, home: () => root, qlbHome: () => root,
    tryAcquireLock: () => () => {}, kill: () => {}, now: () => 0, sleep: async () => {},
  });

  assert.deepEqual(await agent.restorePlist(), { ok: true });
  assert.deepEqual(await agent.restorePlist(), { ok: true });
  assert.equal(bootstraps, 1);
});

test('restorePlist reports a terminal code when neither plist copy exists', async () => {
  const agent = launchctlCswapAgent({
    exec: () => { throw new Error('must not invoke launchctl'); },
    fs: { exists: () => false, mkdir: () => {}, readFile: () => JSON.stringify({ sequence: [] }), rename: () => {} },
    uid: () => 501, home: () => '/fixture-home', qlbHome: () => '/fixture-qlb-home',
    tryAcquireLock: () => () => {}, kill: () => {}, now: () => 0, sleep: async () => {},
  });

  assert.deepEqual(await agent.restorePlist(), { ok: false, code: 'cswap-plist-missing' });
});

test('an already booted-out agent is treated as drained', async () => {
  const agent = launchctlCswapAgent({
    exec: (file) => {
      if (file === '/bin/launchctl') throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      return '';
    },
    fs: { exists: () => true, mkdir: () => {}, readFile: () => JSON.stringify({ sequence: [] }), rename: () => {} },
    uid: () => 501, home: () => '/fixture-home', qlbHome: () => '/fixture-home',
    listProcesses: () => [], tryAcquireLock: () => () => {}, kill: () => {}, now: () => 0, sleep: async () => {},
  });
  assert.deepEqual(await runRetirementDrain(agent), { ok: true });
});

test('a resume after a crash inside remove-launch-artifacts completes (both plist copies already gone)', async () => {
  const agent = launchctlCswapAgent({
    exec: () => {},
    fs: { exists: () => false, mkdir: () => { throw new Error('must not create a backup directory'); }, readFile: () => '', rename: () => { throw new Error('must not move a missing plist'); } },
    uid: () => 501, home: () => '/fixture-home', qlbHome: () => '/fixture-home',
    tryAcquireLock: () => () => {}, kill: () => {}, now: () => 0, sleep: async () => {},
  });

  assert.deepEqual(await agent.movePlist(), { ok: true });
});

test('the production drain uses the A14 classifier and fails closed when ps output is empty', async () => {
  let now = 0;
  let alive = true;
  const locked: string[] = [];
  const customBackup = '/configured/cswap-state';
  const dependencies: LaunchctlCswapAgentDependencies = {
    exec: () => '',
    fs: {
      exists: () => true, mkdir: () => {},
      readFile: (path: string) => {
        assert.equal(path, `${customBackup}/sequence.json`);
        return JSON.stringify({ sequence: [9] });
      },
      rename: () => {},
    },
    uid: () => 501, home: () => '/fixture-home', qlbHome: () => '/fixture-home',
    cswapSequencePath: () => `${customBackup}/sequence.json`,
    listProcesses: () => alive ? listCswapProcesses({ platform: 'linux', runPs: () => '123 python3 -m claude_swap auto' }) : [],
    listSignalTargets: () => alive ? listCswapProcessesToSignal({ platform: 'linux', runPs: () => '123 python3 -m claude_swap auto' }) : [],
    tryAcquireLock: (path: string) => { locked.push(path); return () => {}; },
    kill: () => { alive = false; }, now: () => now, sleep: async () => { now += 60_000; },
  };
  const agent = launchctlCswapAgent(dependencies);

  assert.deepEqual(await agent.drain(), { ok: true });
  assert.deepEqual(locked, [
    `${customBackup}/.lock`,
    `${customBackup}/credentials/.consume-9.lock`,
  ]);

  const emptyAgent = launchctlCswapAgent({
    ...dependencies,
    listProcesses: () => listCswapProcesses({ platform: 'linux', runPs: () => '' }),
  });
  const empty = await emptyAgent.drain();
  assert.equal(empty.ok, false);
  assert.match(empty.code ?? '', /cswap-drain-error process table was empty/);
});

test('the production agent takes locks under the configured C-swap directory', async () => {
  let now = 0;
  let alive = true;
  const locked: string[] = [];
  const customBackup = '/configured/cswap-state';
  const agent = launchctlCswapAgent({
    exec: () => '',
    fs: { exists: () => true, mkdir: () => {}, readFile: () => JSON.stringify({ sequence: ['42'] }), rename: () => {} },
    uid: () => 501, home: () => '/fixture-home', qlbHome: () => '/fixture-home',
    cswapSequencePath: () => `${customBackup}/sequence.json`,
    listProcesses: () => alive ? [{ pid: 42 }] : [],
    listSignalTargets: () => alive ? [{ pid: 42 }] : [],
    tryAcquireLock: (path: string) => { locked.push(path); return () => {}; },
    kill: () => { alive = false; }, now: () => now, sleep: async () => { now += 60_000; },
  });

  assert.deepEqual(await agent.drain(), { ok: true });
  assert.deepEqual(locked, [
    `${customBackup}/.lock`,
    `${customBackup}/credentials/.consume-42.lock`,
  ]);
});

test('AC58 barrier assertion rejects a fake drain that signals before the consume lock is available', async () => {
  const kills: Array<{ pid: number; signal: 'SIGTERM' }> = [];
  let consumeLockHeld = true;
  const earlySignalDrain: CswapAgent['drain'] = () => {
    if (consumeLockHeld) kills.push({ pid: 42, signal: 'SIGTERM' });
    return { ok: true };
  };

  await earlySignalDrain();
  const killsWhenConsumeLockBecameAvailable = kills.length;
  consumeLockHeld = false;

  assert.throws(
    () => assertNoSignalBeforeConsumeLock(killsWhenConsumeLockBecameAvailable),
    /QLB must not signal while the fixture consume lock is held/,
  );
  assert.equal(consumeLockHeld, false);
});

test('refuses a C-swap whose consume lock stays held, without sending any signal', async () => {
  let now = 0;
  const kills: Array<{ pid: number; signal: 'SIGTERM' }> = [];
  const { agent, calls } = drainingAgent(() => cooperativeDrain({
    listProcesses: () => [{ pid: 77 }],
    listSignalTargets: () => [{ pid: 77 }],
    lockPaths: () => ['backup/.lock', 'backup/credentials/.consume-2.lock'],
    tryAcquireLock: () => null,
    kill: (pid, signal) => { kills.push({ pid, signal }); },
    now: () => now,
    sleep: async () => { now += 1; },
    cooperativeWaitMs: 2,
    lockWaitMs: 2,
    termWaitMs: 2,
    pollMs: 1,
  }));
  const store = fixtureStore();
  try {
    const result = await cutoverBegin(store.dbPath, agent);
    assert.equal(result.ok, false);
    assert.match(result.code ?? '', /^cswap-survivor 77$/);
    assert.equal(result.state, 'aborted');
    assert.deepEqual(kills, []);
    assert.deepEqual(calls, ['bootout', 'disable', 'move', 'drain', 'restore']);
    assert.equal(phase(store).state, 'aborted');
  } finally {
    store.close();
  }
});

test('refuses a SIGTERM-surviving C-swap, restores its plist, and never sends SIGKILL', async () => {
  let now = 0;
  const kills: Array<{ pid: number; signal: 'SIGTERM' }> = [];
  const { agent, calls } = drainingAgent(() => cooperativeDrain({
    listProcesses: () => [{ pid: 99 }],
    listSignalTargets: () => [{ pid: 99 }],
    lockPaths: () => ['backup/.lock', 'backup/credentials/.consume-2.lock'],
    tryAcquireLock: () => () => {},
    kill: (pid, signal) => { kills.push({ pid, signal }); },
    now: () => now,
    sleep: async () => { now += 1; },
    cooperativeWaitMs: 2,
    lockWaitMs: 2,
    termWaitMs: 2,
    pollMs: 1,
  }));
  const store = fixtureStore();
  try {
    const result = await cutoverBegin(store.dbPath, agent);
    assert.equal(result.ok, false);
    assert.match(result.code ?? '', /^cswap-survivor 99$/);
    assert.equal(result.state, 'aborted');
    assert.deepEqual(calls, ['bootout', 'disable', 'move', 'drain', 'restore']);
    assert.deepEqual(kills, [{ pid: 99, signal: 'SIGTERM' }]);
    assert.equal(kills.every(({ signal }) => signal === 'SIGTERM'), true);
    assert.equal(phase(store).state, 'aborted');
  } finally {
    store.close();
  }
});

test('names every SIGTERM survivor in the S57 refusal code', async () => {
  let now = 0;
  const result = await cooperativeDrain({
    listProcesses: () => [{ pid: 101 }, { pid: 102 }],
    listSignalTargets: () => [{ pid: 101 }, { pid: 102 }],
    lockPaths: () => ['backup/.lock'],
    tryAcquireLock: () => () => {},
    kill: () => {},
    now: () => now,
    sleep: async () => { now += 1; },
    cooperativeWaitMs: 1,
    lockWaitMs: 1,
    termWaitMs: 1,
    pollMs: 1,
  });

  assert.deepEqual(result, { ok: false, code: 'cswap-survivor 101 102' });
});

test('treats ESRCH from SIGTERM as an already-exited process', async () => {
  let now = 0;
  let listed = true;
  const result = await cooperativeDrain({
    listProcesses: () => listed ? [{ pid: 123 }] : [],
    listSignalTargets: () => listed ? [{ pid: 123 }] : [],
    lockPaths: () => ['backup/.lock'],
    tryAcquireLock: () => () => {},
    kill: () => {
      listed = false;
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
    now: () => now,
    sleep: async () => { now += 1; },
    cooperativeWaitMs: 1,
    lockWaitMs: 1,
    termWaitMs: 1,
    pollMs: 1,
  });

  assert.deepEqual(result, { ok: true });
});

test('fails closed with the named error when SIGTERM fails for another reason', async () => {
  let now = 0;
  const result = await cooperativeDrain({
    listProcesses: () => [{ pid: 124 }],
    listSignalTargets: () => [{ pid: 124 }],
    lockPaths: () => ['backup/.lock'],
    tryAcquireLock: () => () => {},
    kill: () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); },
    now: () => now,
    sleep: async () => { now += 1; },
    cooperativeWaitMs: 1,
    lockWaitMs: 1,
    termWaitMs: 1,
    pollMs: 1,
  });

  assert.deepEqual(result, { ok: false, code: 'cswap-drain-error EPERM: not permitted' });
});
