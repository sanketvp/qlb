import assert from 'node:assert/strict';
import test from 'node:test';

import { cooperativeDrain, launchctlCswapAgent, runRetirementDrain, type CswapAgent } from '../src/cswap-agent';
import { cutoverBegin } from '../src/commands/cutover';
import { phase } from '../src/lifecycle';
import { openStore } from '../src/store';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

test('waits for a held C-swap consume lock before signaling, then drains cooperatively', async () => {
  let now = 0;
  let consumeLockHeld = true;
  let killsWhenConsumeLockBecameAvailable: number | undefined;
  let terminated = false;
  const kills: Array<{ pid: number; signal: 'SIGTERM' }> = [];
  const releases: string[] = [];
  const { agent, calls } = drainingAgent(() => cooperativeDrain({
    listProcesses: () => terminated ? [] : [{ pid: 42 }],
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

test('an already booted-out agent is treated as drained', async () => {
  const agent = launchctlCswapAgent({
    exec: (file) => {
      if (file === '/bin/launchctl') throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      return '';
    },
    fs: { exists: () => true, mkdir: () => {}, readFile: () => JSON.stringify({ sequence: [] }), rename: () => {} },
    uid: () => 501, home: () => '/fixture-home', qlbHome: () => '/fixture-home',
    tryAcquireLock: () => () => {}, kill: () => {}, now: () => 0, sleep: async () => {},
  });
  assert.deepEqual(await runRetirementDrain(agent), { ok: true });
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
