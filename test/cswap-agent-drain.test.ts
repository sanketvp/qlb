import assert from 'node:assert/strict';
import test from 'node:test';

import { cooperativeDrain, type CswapAgent } from '../src/cswap-agent';
import { cutoverBegin } from '../src/commands/cutover';
import { phase } from '../src/lifecycle';
import { openStore } from '../src/store';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

function fixtureStore() {
  return openStore(join(mkdtempSync(join(tmpdir(), 'qlb-cswap-drain-')), 'qlb.db'));
}

function drainingAgent(drain: NonNullable<CswapAgent['drain']>): { agent: CswapAgent; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    agent: {
      bootout: () => { calls.push('bootout'); return { ok: true }; },
      disable: () => { calls.push('disable'); return { ok: true }; },
      movePlist: () => { calls.push('move'); return { ok: true }; },
      restorePlist: () => { calls.push('restore'); return { ok: true }; },
      drain,
    },
  };
}

test('waits for a held C-swap consume lock before signaling, then drains cooperatively', async () => {
  let now = 0;
  let lockHeld = true;
  let terminated = false;
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const releases: string[] = [];
  const { agent, calls } = drainingAgent(() => cooperativeDrain({
    listProcesses: () => terminated ? [] : [{ pid: 42 }],
    lockPaths: () => ['backup/.lock', 'backup/credentials/.consume-2.lock'],
    tryAcquireLock: (path) => {
      if (lockHeld) {
        assert.equal(kills.length, 0, 'QLB must not signal while the fixture consume lock is held');
        return null;
      }
      return () => { releases.push(path); };
    },
    kill: (pid, signal) => { kills.push({ pid, signal }); terminated = true; },
    now: () => now,
    sleep: async () => { now += 1; if (now === 5) lockHeld = false; },
    cooperativeWaitMs: 3,
    lockWaitMs: 5,
    termWaitMs: 2,
    pollMs: 1,
  }));
  const store = fixtureStore();
  try {
    const result = await cutoverBegin(store.dbPath, agent);
    assert.deepEqual(result, { ok: true, state: 'cutting-over' });
    assert.deepEqual(calls, ['bootout', 'disable', 'move']);
    assert.deepEqual(kills, [{ pid: 42, signal: 'SIGTERM' }]);
    assert.deepEqual(releases.sort(), ['backup/.lock', 'backup/credentials/.consume-2.lock']);
  } finally {
    store.close();
  }
});

test('refuses a C-swap whose consume lock stays held, without sending any signal', async () => {
  let now = 0;
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
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
    assert.match(result.code ?? '', /^cswap-survivor pid=77$/);
    assert.equal(result.state, 'aborted');
    assert.deepEqual(kills, []);
    assert.deepEqual(calls, ['bootout', 'disable', 'move', 'restore']);
    assert.equal(phase(store).state, 'aborted');
  } finally {
    store.close();
  }
});

test('refuses a SIGTERM-surviving C-swap, restores its plist, and never sends SIGKILL', async () => {
  let now = 0;
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
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
    assert.match(result.code ?? '', /^cswap-survivor pid=99$/);
    assert.equal(result.state, 'aborted');
    assert.deepEqual(calls, ['bootout', 'disable', 'move', 'restore']);
    assert.deepEqual(kills, [{ pid: 99, signal: 'SIGTERM' }]);
    assert.equal(kills.some(({ signal }) => signal === 'SIGKILL'), false);
    assert.equal(phase(store).state, 'aborted');
  } finally {
    store.close();
  }
});
