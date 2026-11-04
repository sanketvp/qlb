import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AutoAdmissionRefused, runAuto } from '../src/auto';
import { runAutoCommand } from '../src/commands/auto';
import { claudePaths } from '../src/cc-paths';
import { claudeSwitchJournalPath, createClaudeSwitchJournal, type ClaudeSwitchJournal } from '../src/cc-switch-journal';
import type { ClaudeSwitchDeps } from '../src/cc-switch';
import { defaultConfig } from '../src/config';
import { MockKeychain } from '../src/keychain';
import { reconcileClaudeSwitch } from '../src/journal';
import { runExecutingCommand } from '../src/app';
import type { CommandContext } from '../src/registry';
import { beginCutover, markDrillBegan, markDrillDone, phase, transition } from '../src/lifecycle';
import { openStore } from '../src/store';

const CLI = join(__dirname, '..', 'src', 'cli.js');

type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home };
}

function start(args: string[], env: NodeJS.ProcessEnv, cwd?: string): ChildProcess {
  return spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function collect(child: ChildProcess): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function snapshot(root: string, prefix = ''): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of snapshot(path, relative)) files.set(name, value);
    } else {
      const stat = statSync(path);
      files.set(relative, `${stat.size}:${stat.mtimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  }
  return files;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempts = 0; attempts < 1_000; attempts += 1) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`lock was not created: ${path}`);
}

function waitForOutput(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: string): void => {
      output += chunk;
      if (output.includes(marker)) {
        child.stderr?.off('data', onData);
        resolve();
      }
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', onData);
    child.once('exit', (code, signal) => reject(new Error(`first loop ended before ${marker}: ${code ?? signal}`)));
  });
}

function close(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe('qlb auto --once (G12)', () => {
  it('returns exit 3 for lock and admission refusals', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-agent-refusal-'));
    const home = join(root, 'home');
    const context = (stderr: string[]): CommandContext => ({
      stdout: () => undefined, stderr: (line) => stderr.push(line), env: testEnv(home),
      config: {} as CommandContext['config'], loadConfig: () => { throw new Error('not used'); }, home,
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    });
    try {
      const lockStderr: string[] = [];
      assert.equal(await runAutoCommand(['--once'], context(lockStderr), {
        acquireFlock: async () => null,
        runAuto: async () => { throw new Error('runAuto must not run without a lock'); },
      }), 3);
      assert.deepEqual(lockStderr, ['qlb auto: auto-already-running']);

      const admissionStderr: string[] = [];
      assert.equal(await runAutoCommand(['--once', '--dry-run'], context(admissionStderr), {
        acquireFlock: async () => { throw new Error('dry run must not lock'); },
        runAuto: async () => { throw new AutoAdmissionRefused('cutover-not-ready'); },
      }), 3);
      assert.deepEqual(admissionStderr, ['qlb auto: refused: cutover-not-ready']);
    } finally {
      close(root);
    }
  });

  it('continuous auto refuses an active drill, while --once remains allowed and a completed drill runs normally', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-active-drill-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    assert.equal(markDrillBegan(store, 3).ok, true);
    store.close();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    const lease = Object.assign(async () => undefined, {});
    try {
      assert.equal(await runAutoCommand([], ctx, {
        acquireFlock: async () => { throw new Error('must not lock an active drill'); },
        runAuto: async () => { throw new Error('must not tick an active drill'); },
      }), 3);
      assert.deepEqual(stderr, ['qlb auto: refused: drill-active; finish with qlb lifecycle drill-done']);
      assert.deepEqual(stdout, []);

      for (const args of [['--once'], ['--once', '--dry-run']]) {
        let runs = 0;
        assert.equal(await runAutoCommand(args, ctx, {
          acquireFlock: async () => lease,
          runAuto: async () => {
            runs += 1;
            return { ticks: 1, decisions: [], executed: [] };
          },
        }), 0, args.join(' '));
        assert.equal(runs, 1, args.join(' '));
      }

      const reopened = openStore(config.dbPath);
      try { assert.equal(markDrillDone(reopened, 4).ok, true); } finally { reopened.close(); }
      let normalRuns = 0;
      assert.equal(await runAutoCommand([], ctx, {
        acquireFlock: async () => lease,
        runAuto: async () => {
          normalRuns += 1;
          return { ticks: 1, decisions: [], executed: [] };
        },
      }), 0);
      assert.equal(normalRuns, 1);
    } finally { close(root); }
  });

  it('plain --dry-run runs during an active drill', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-dry-active-drill-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    assert.equal(markDrillBegan(store, 3).ok, true);
    store.close();
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: () => undefined, env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    let runs = 0;
    try {
      assert.equal(await runAutoCommand(['--dry-run'], ctx, {
        acquireFlock: async () => { throw new Error('dry run must not lock'); },
        runAuto: async () => {
          runs += 1;
          return { ticks: 1, decisions: [], executed: [] };
        },
      }), 0);
      assert.equal(runs, 1);
    } finally { close(root); }
  });

  it('a drill-begin that commits while holding auto.lock stops a concurrent continuous loop before its next tick', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-drill-mid-loop-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    let ticks = 0;
    let sleeps = 0;
    let wakeSleep!: () => void;
    let scheduled!: () => void;
    const sleepScheduled = new Promise<void>((resolve) => { scheduled = resolve; });
    try {
      const loop = runAuto({}, {
        makeLiveBinding: () => ({
          store, close: () => {}, reconcile: async () => {}, poll: async () => [],
          tick: async () => {
            ticks += 1;
            return { decision: { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } };
          },
        }),
        listCswapProcesses: () => [], log: () => {},
        setTimeout: (callback) => {
          sleeps += 1;
          if (sleeps > 1) throw new Error('second loop iteration started');
          wakeSleep = callback;
          scheduled();
          return undefined as unknown as ReturnType<typeof setTimeout>;
        },
      });
      await sleepScheduled;

      let leaseHeld = false;
      let markRanWhileLeaseHeld = false;
      const lease = Object.assign(async () => {
        const reopened = openStore(config.dbPath);
        try {
          markRanWhileLeaseHeld = leaseHeld && phase(reopened).drillBeganAt === 3;
        } finally {
          reopened.close();
          leaseHeld = false;
        }
      }, {});
      const ctx: CommandContext = {
        stdout: () => undefined, stderr: () => undefined, env: testEnv(home), config,
        loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
      };
      assert.equal(await runAutoCommand(['drill-begin'], ctx, {
        runAuto: async () => { throw new Error('not used'); }, exec: () => undefined,
        acquireFlock: async () => { leaseHeld = true; return lease; }, now: () => 3,
      }), 0);
      assert.equal(markRanWhileLeaseHeld, true, 'markDrillBegan must run while auto.lock is held');
      assert.equal(leaseHeld, false, 'drill-begin releases auto.lock after marking');

      wakeSleep();
      await assert.rejects(loop, (error: unknown) => (error as AutoAdmissionRefused).code === 'drill-active');
      assert.equal(ticks, 1);
    } finally {
      store.close();
      close(root);
    }
  });

  it('continuous auto runs in retired with an open drill row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-retired-drill-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    assert.equal(markDrillBegan(store, 3).ok, true);
    assert.equal(transition(store, 'retired', 4).ok, true);
    const signals = new EventEmitter();
    let ticks = 0;
    try {
      const result = await runAuto({}, {
        makeLiveBinding: () => ({
          store, close: () => {}, reconcile: async () => {}, poll: async () => [],
          tick: async () => {
            ticks += 1;
            return { decision: { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } };
          },
        }),
        listCswapProcesses: () => [], log: () => {}, signals: signals as unknown as NodeJS.Process,
        setTimeout: (callback) => {
          signals.emit('SIGTERM');
          callback();
          return undefined as unknown as ReturnType<typeof setTimeout>;
        },
      });
      assert.equal(result.ticks, 1);
      assert.equal(ticks, 1);
    } finally {
      store.close();
      close(root);
    }
  });

  it('drill-begin issues the exact /bin/launchctl bootout argv with a 5 s timeout, waits for auto.lock and records drill_began_at', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-drill-begin-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    store.close();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    const execCalls: Array<{ file: string; args: string[]; options: unknown }> = [];
    let probes = 0;
    let now = 10;
    try {
      assert.equal(await runAutoCommand(['drill-begin'], ctx, {
        runAuto: async () => { throw new Error('not used'); },
        exec: (file, args, options) => { execCalls.push({ file, args, options }); },
        acquireFlock: async () => {
          probes += 1;
          return probes === 1 ? null : Object.assign(async () => undefined, {});
        },
        now: () => now,
        sleep: async () => { now += 1_000; },
      }), 0);
      assert.deepEqual(execCalls, [{
        file: '/bin/launchctl', args: ['bootout', `gui/${process.getuid?.() ?? 0}/com.modus.qlb-auto`],
        options: { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
      }]);
      assert.equal(probes, 2);
      assert.deepEqual(stdout, ['auto drill began']);
      assert.deepEqual(stderr, []);
      const reopened = openStore(config.dbPath);
      try { assert.equal(phase(reopened).drillBeganAt, 1_010); } finally { reopened.close(); }
    } finally { close(root); }
  });

  it('drill-begin refuses an ENOENT launchctl spawn failure and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-drill-enoent-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    store.close();
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: (line) => stderr.push(line), env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    let probes = 0;
    try {
      assert.equal(await runAutoCommand(['drill-begin'], ctx, {
        runAuto: async () => { throw new Error('not used'); },
        exec: () => { throw Object.assign(new Error('launchctl unavailable'), { code: 'ENOENT' }); },
        acquireFlock: async () => { probes += 1; return null; },
      }), 3);
      assert.deepEqual(stderr, ['qlb auto drill-begin: refused: ENOENT']);
      assert.equal(probes, 0);
      const reopened = openStore(config.dbPath);
      try { assert.equal(phase(reopened).drillBeganAt, null); } finally { reopened.close(); }
    } finally { close(root); }
  });

  it('drill-begin refuses when the lock stays held and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-drill-held-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    store.close();
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: (line) => stderr.push(line), env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    let now = 0;
    try {
      assert.equal(await runAutoCommand(['drill-begin'], ctx, {
        runAuto: async () => { throw new Error('not used'); }, exec: () => undefined,
        acquireFlock: async () => null, now: () => now, sleep: async () => { now += 1_000; },
      }), 3);
      assert.deepEqual(stderr, ['qlb auto drill-begin: refused: auto-lock-still-held']);
      const reopened = openStore(config.dbPath);
      try {
        assert.equal(phase(reopened).drillBeganAt, null);
        assert.equal(phase(reopened).drillDoneAt, null);
      } finally { reopened.close(); }
    } finally { close(root); }
  });

  it('drill-begin treats a throwing auto.lock probe as held and refuses at the deadline with nothing written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-drill-probe-throw-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    store.close();
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: (line) => stderr.push(line), env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    let now = 0;
    try {
      assert.equal(await runAutoCommand(['drill-begin'], ctx, {
        runAuto: async () => { throw new Error('not used'); }, exec: () => undefined,
        acquireFlock: async () => { throw new Error('probe failed'); }, now: () => now, sleep: async () => { now += 1_000; },
      }), 3);
      assert.deepEqual(stderr, ['qlb auto drill-begin: refused: auto-lock-still-held']);
      const reopened = openStore(config.dbPath);
      try { assert.equal(phase(reopened).drillBeganAt, null); } finally { reopened.close(); }
    } finally { close(root); }
  });

  it('drill-begin after a completed drill clears drill_done_at in the same transaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-drill-repeat-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    assert.equal(markDrillDone(store, 3).ok, true);
    store.close();
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: () => undefined, env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['drill-begin'], ctx, {
        runAuto: async () => { throw new Error('not used'); }, exec: () => undefined,
        acquireFlock: async () => Object.assign(async () => undefined, {}), now: () => 4,
      }), 0);
      const reopened = openStore(config.dbPath);
      try {
        assert.equal(phase(reopened).drillBeganAt, 4);
        assert.equal(phase(reopened).drillDoneAt, null);
      } finally { reopened.close(); }
    } finally { close(root); }
  });

  it('drill-begin in test mode without an exec seam never reaches launchctl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-drill-no-exec-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: (line) => stderr.push(line), env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    let probes = 0;
    try {
      assert.equal(await runAutoCommand(['drill-begin'], ctx, {
        runAuto: async () => { throw new Error('not used'); }, acquireFlock: async () => { probes += 1; return null; },
      }), 3);
      assert.deepEqual(stderr, ['qlb auto drill-begin: refused: exec-seam-required']);
      assert.equal(probes, 0);
    } finally { close(root); }
  });

  it('auto resume anthropic clears suspendedUntil and writes lastResumeAt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-resume-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const suspendedUntil = 1_000_000;
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    store.setConfig('auto.anthropic.suspendedUntil', String(suspendedUntil));
    store.close();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['resume', 'anthropic'], ctx), 0);
      assert.deepEqual(stderr, []);
      assert.deepEqual(stdout, [`resumed anthropic (suspended until ${new Date(suspendedUntil).toISOString()} cleared)`]);
      const reopened = openStore(config.dbPath);
      try {
        assert.equal(reopened.getConfig('auto.anthropic.suspendedUntil'), '');
        assert.equal(Number.isFinite(Number(reopened.getConfig('auto.anthropic.lastResumeAt'))), true);
      } finally { reopened.close(); }
    } finally {
      close(root);
    }
  });

  it('auto resume clears an invalid suspension marker without throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-resume-invalid-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    store.setConfig('auto.anthropic.suspendedUntil', 'not-a-timestamp');
    store.close();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['resume', 'anthropic'], ctx), 0);
      assert.deepEqual(stdout, ['cleared-invalid']);
      assert.deepEqual(stderr, []);
      const reopened = openStore(config.dbPath);
      try {
        assert.equal(reopened.getConfig('auto.anthropic.suspendedUntil'), '');
      } finally { reopened.close(); }
    } finally { close(root); }
  });

  it('auto resume clears an out-of-range suspension marker without throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-resume-out-of-range-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    store.setConfig('auto.anthropic.suspendedUntil', '1e300');
    store.close();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['resume', 'anthropic'], ctx), 0);
      assert.deepEqual(stdout, ['cleared-invalid']);
      assert.deepEqual(stderr, []);
      const reopened = openStore(config.dbPath);
      try {
        assert.equal(reopened.getConfig('auto.anthropic.suspendedUntil'), '');
      } finally { reopened.close(); }
    } finally { close(root); }
  });

  it('auto resume admission runs inside the write transaction', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-auto-resume-transaction-'));
    const config = defaultConfig(home);
    let inTransaction = false;
    let admissionObservedInTransaction = false;
    const values = new Map<string, string>([['auto.anthropic.suspendedUntil', '1000000']]);
    const store = {
      getConfig: (key: string) => values.get(key) ?? null,
      setConfig: (key: string, value: string) => values.set(key, value),
      runImmediate: <T>(fn: () => T) => {
        inTransaction = true;
        try { return fn(); } finally { inTransaction = false; }
      },
      close: () => undefined,
      db: {
        prepare: () => ({ get: () => {
          admissionObservedInTransaction = inTransaction;
          return { id: 1, state: 'cutover', began_at: 1, cutover_at: 2, window_end: null, extended_at: null,
            undo_began_at: null, rollback_at: null, retired_at: null, closed_at: null, release_sha: null,
            drill_began_at: null, drill_done_at: null, note: null, pre_fence_state: null };
        } }),
      },
    };
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: () => undefined, env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    assert.equal(await runAutoCommand(['resume', 'anthropic'], ctx, {
      openStore: () => store as unknown as ReturnType<typeof openStore>,
      runAuto: async () => { throw new Error('not used'); }, acquireFlock: async () => null,
    }), 0);
    assert.equal(admissionObservedInTransaction, true);
    assert.equal(values.get('auto.anthropic.suspendedUntil'), '');
    assert.ok(values.get('auto.anthropic.lastResumeAt'));
    close(home);
  });

  it('auto resume with no suspension exits 0 and writes only lastResumeAt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-resume-empty-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    store.close();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['resume', 'anthropic'], ctx), 0);
      assert.deepEqual(stdout, ['nothing to resume']);
      assert.deepEqual(stderr, []);
      const reopened = openStore(config.dbPath);
      try {
        assert.equal(reopened.hasConfig('auto.anthropic.suspendedUntil'), false);
        assert.equal(Number.isFinite(Number(reopened.getConfig('auto.anthropic.lastResumeAt'))), true);
      } finally { reopened.close(); }
    } finally {
      close(root);
    }
  });

  it('auto resume kimi-coding exits 2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-resume-provider-'));
    const home = join(root, 'home');
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: (line) => stderr.push(line), env: testEnv(home), config: defaultConfig(home),
      loadConfig: () => defaultConfig(home), home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['resume', 'kimi-coding'], ctx), 2);
      assert.deepEqual(stderr, ['qlb auto resume: provider-not-enabled']);
    } finally {
      close(root);
    }
  });

  it('a second loop exits 3', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-lock-'));
    const home = join(root, 'home');
    const env = testEnv(home);
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    store.close();
    const first = start(['auto'], env);
    try {
      await waitForFile(join(home, '.qlb', 'locks', 'auto.lock'));
      await waitForOutput(first, 'auto:');
      const second = await collect(start(['auto', '--once'], env));
      assert.equal(second.code, 3, second.stderr);
      assert.match(second.stderr, /auto-already-running/);
    } finally {
      first.kill('SIGTERM');
      await collect(first);
      const later = await collect(start(['auto', '--once'], env));
      assert.equal(later.code, 0, later.stderr);
      assert.equal(existsSync(join(home, '.qlb', 'locks', 'auto.lock')), true, 'release retains the lock file');
      close(root);
    }
  });

  it('plain --dry-run on an empty QLB_HOME creates no qlb.db and no backups', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-dry-empty-'));
    const home = join(root, 'home');
    const config = defaultConfig(home);
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: () => undefined, env: testEnv(home), config,
      loadConfig: () => config, home, registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['--dry-run'], ctx, {
        acquireFlock: async () => { throw new Error('dry run must not lock'); },
        runAuto: async () => ({ ticks: 1, decisions: [], executed: [] }),
      }), 0);
      assert.equal(existsSync(config.dbPath), false, 'dry run must not create qlb.db');
      assert.equal(existsSync(join(home, '.qlb', 'backups')), false, 'dry run must not create backups');
    } finally { close(root); }
  });

  it('the whole dry-run command on an orphan-journal fixture changes no file under QLB_HOME and makes no HTTP call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-dry-command-'));
    const home = join(root, 'home');
    const env = testEnv(home);
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.close();
    const paths = claudePaths({ home, env });
    const orphan = claudeSwitchJournalPath({ home });
    const journal: ClaudeSwitchJournal = {
      v: 1, provider: 'anthropic', attemptId: 'orphaned-fixture', from: 'from', to: 'to', trigger: 'auto', by: 'fixture',
      republish: false, injected: false, detail: null, decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null },
      outgoingKind: null, bindingJson: null, step: 6, stagedBlobService: 'qlb:anthropic:staged-rollback:fixture',
      stagedAccount: 'qlb', stagedWritten: false, keychainService: paths.keychainService, configPath: paths.globalConfigPath,
      configText: null, configWrittenHash: null, fromOauthAccount: null, credentialsWrittenHash: null,
      credentialsWriteStarted: false, credentialsWritten: false, configWriteStarted: false, configWritten: false,
      closed: null, startedAt: 1, owner: { pid: 999_999, lstart: 'dead fixture owner' },
    };
    mkdirSync(join(orphan, '..'), { recursive: true });
    writeFileSync(orphan, `${JSON.stringify(journal)}\n`);
    writeFileSync(`${config.dbPath}-wal`, 'fixture WAL without shared memory');
    assert.equal(existsSync(`${config.dbPath}-shm`), false);
    const probe = join(root, 'fetch-probe.cjs');
    const called = join(root, 'fetch-called');
    writeFileSync(probe, `const fs = require('node:fs'); global.fetch = () => { fs.writeFileSync(${JSON.stringify(called)}, 'called'); throw new Error('fetch must not run'); };\n`);
    const before = snapshot(home);
    try {
      const result = await collect(start(['auto', '--once', '--dry-run', '--json'], testEnv(home, {
        NODE_OPTIONS: `--require=${probe}`,
      })));
      assert.equal(result.code, 0, result.stderr);
      const receipt = JSON.parse(result.stdout) as { ticks: number; decisions: unknown[]; executed: unknown[] };
      assert.equal(receipt.ticks, 1);
      assert.equal(Array.isArray(receipt.decisions), true);
      assert.deepEqual(receipt.executed, []);
      assert.equal(existsSync(called), false, 'dry run must not make an HTTP request');
      assert.equal(existsSync(`${config.dbPath}-shm`), false, 'partial WAL state must use immutable mode');
      assert.deepEqual(snapshot(home), before, 'dry run must not create, change, or remove a QLB_HOME file');
    } finally {
      close(root);
    }
  });

  it('dry run never reconciles an unfinished journal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-dry-no-reconcile-'));
    const home = join(root, 'home');
    const env = testEnv(home);
    const paths = claudePaths({ home, env });
    const journalPath = claudeSwitchJournalPath({ home });
    const journal: ClaudeSwitchJournal = {
      v: 1, provider: 'anthropic', attemptId: 'dry-orphan-fixture', from: 'from', to: 'to', trigger: 'auto', by: 'fixture',
      republish: false, injected: false, detail: null, decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null },
      outgoingKind: null, bindingJson: null, step: 6, stagedBlobService: 'qlb:anthropic:staged-rollback:dry-fixture',
      stagedAccount: 'qlb', stagedWritten: false, keychainService: paths.keychainService, configPath: paths.globalConfigPath,
      configText: null, configWrittenHash: null, fromOauthAccount: null, credentialsWrittenHash: null,
      credentialsWriteStarted: false, credentialsWritten: false, configWriteStarted: false, configWritten: false,
      closed: null, startedAt: 1, owner: { pid: 999_999, lstart: 'dead fixture owner' },
    };
    createClaudeSwitchJournal(journal, { home, env, configPath: paths.globalConfigPath, keychainService: paths.keychainService });
    const deps: ClaudeSwitchDeps = {
      store: { findCommittedSwitchByAttempt: () => null, recordSwitch: () => 1 } as unknown as ClaudeSwitchDeps['store'],
      slots: {} as ClaudeSwitchDeps['slots'], live: { backend: new MockKeychain(), paths, account: 'fixture' },
      readConfig: () => ({}), resolveProfile: async () => null,
      consume: { postRefresh: async () => ({ status: 500, body: '' }) }, cswapProcesses: () => [], env, home,
      now: () => 1, by: 'qlb-auto', attempt: 'fixture', stillTheSameProcess: async () => false,
    };
    try {
      const output = await runAuto({ once: true, dryRun: true }, {
        makeDryBinding: () => ({
          close: () => {}, admit: () => ({ ok: true }), reconcile: () => reconcileClaudeSwitch(deps),
          tick: async () => ({ decision: { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } }),
        }),
        log: () => {},
      });
      assert.equal(output.ticks, 1);
      assert.equal(existsSync(journalPath), true, 'dry run must not reconcile an unfinished journal');
    } finally {
      close(root);
    }
  });

  it('isolates the shared flock helper from a fcntl.py in the caller cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-flock-isolated-'));
    const home = join(root, 'home');
    const cwd = join(root, 'caller');
    const marker = join(root, 'planted-fcntl-ran');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'fcntl.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('ran')\n`);
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
    store.close();
    try {
      const result = await collect(start(['auto', '--once'], testEnv(home), cwd));
      assert.equal(result.code, 0, result.stderr);
      assert.equal(existsSync(marker), false, 'the planted fcntl module must not run');
    } finally {
      close(root);
    }
  });

  it('stops after the current tick when the held lock helper disappears', async () => {
    let loseLock: (error: Error) => void = () => {};
    const lost = new Promise<Error>((resolve) => { loseLock = resolve; });
    let ticks = 0;
    await assert.rejects(runAuto({}, {
      stopWhen: lost,
      makeLiveBinding: () => ({
        store: { setConfig: () => {} }, close: () => {}, reconcile: async () => {}, poll: async () => [],
        tick: async () => {
          loseLock(new Error('fcntl flock helper exited unexpectedly (SIGTERM)'));
          await Promise.resolve();
          ticks += 1;
          return { decision: { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } };
        },
      }),
      assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: () => {},
    }), /flock helper exited unexpectedly/);
    assert.equal(ticks, 1, 'the in-flight tick completes before the loop stops');
  });

  it('does not begin a tick when the lease was already lost before runAuto starts', async () => {
    const lost = new Error('fcntl flock helper exited unexpectedly (SIGTERM)');
    let reconciles = 0;
    let ticks = 0;
    await assert.rejects(runAuto({ once: true }, {
      stopWhen: Promise.resolve(lost), stopIf: () => lost,
      makeLiveBinding: () => ({
        store: { setConfig: () => {} }, close: () => {},
        reconcile: async () => { reconciles += 1; }, poll: async () => [],
        tick: async () => {
          ticks += 1;
          return { decision: { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } };
        },
      }),
      assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: () => {},
    }), /flock helper exited unexpectedly/);
    assert.equal(reconciles, 0);
    assert.equal(ticks, 0);
  });

  it('does not switch when the lease is lost after polling and before the tick', async () => {
    const lostError = new Error('fcntl flock helper exited unexpectedly (SIGTERM)');
    let loseLock: (error: Error) => void = () => {};
    const lost = new Promise<Error>((resolve) => { loseLock = resolve; });
    let currentLoss: Error | undefined;
    let ticks = 0;
    await assert.rejects(runAuto({ once: true }, {
      stopWhen: lost, stopIf: () => currentLoss,
      makeLiveBinding: () => ({
        store: { setConfig: () => {} }, close: () => {}, reconcile: async () => {},
        poll: async () => {
          currentLoss = lostError;
          loseLock(lostError);
          return [];
        },
        tick: async () => {
          ticks += 1;
          return { decision: { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } };
        },
      }),
      assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: () => {},
    }), /flock helper exited unexpectedly/);
    assert.equal(ticks, 0);
  });

  it('passes a synchronously lost lease to runAuto and returns exit 1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-command-lost-'));
    const home = join(root, 'home');
    const loss = new Error('fcntl flock helper exited unexpectedly (SIGTERM)');
    const lease = Object.assign(async () => {}, { lost: Promise.resolve(loss), isLost: () => loss });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env: testEnv(home),
      config: {} as CommandContext['config'], loadConfig: () => { throw new Error('not used'); }, home,
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    let ticks = 0;
    try {
      const code = await runExecutingCommand({ command: {
        name: 'auto', execute: (args, context) => runAutoCommand(args, context, {
          acquireFlock: async () => lease,
          runAuto: (options, dependencies) => runAuto(options, {
            ...dependencies,
            makeLiveBinding: () => ({
              store: { setConfig: () => {} }, close: () => {}, reconcile: async () => {}, poll: async () => [],
              tick: async () => {
                ticks += 1;
                return { decision: { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } };
              },
            }),
            assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [],
          }),
        }),
      }, args: ['--once'] }, ctx);
      assert.equal(code, 1);
      assert.equal(ticks, 0);
      assert.deepEqual(stdout, []);
      assert.match(stderr.join('\n'), /flock helper exited unexpectedly/);
    } finally {
      close(root);
    }
  });

  it('usage-5xx requires the fault-injection environment before admission or locking', async () => {
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: (line) => stderr.push(line), env: testEnv(mkdtempSync(join(tmpdir(), 'qlb-auto-inject-env-'))),
      config: {} as CommandContext['config'], loadConfig: () => { throw new Error('not used'); }, home: mkdtempSync(join(tmpdir(), 'qlb-auto-inject-env-home-')),
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['--once', '--inject', 'usage-5xx', 'anthropic'], ctx, {
        acquireFlock: async () => { throw new Error('must not lock'); }, runAuto: async () => { throw new Error('must not admit'); },
      }), 2);
      assert.match(stderr.join('\n'), /requires QLB_FAULT_INJECTION=1/);
    } finally { close(ctx.home); close(ctx.env.QLB_HOME!); }
  });

  it('usage-5xx rejects dry-run placement before admission or locking', async () => {
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: (line) => stderr.push(line), env: testEnv(mkdtempSync(join(tmpdir(), 'qlb-auto-inject-dry-')), { QLB_FAULT_INJECTION: '1' }),
      config: {} as CommandContext['config'], loadConfig: () => { throw new Error('not used'); }, home: mkdtempSync(join(tmpdir(), 'qlb-auto-inject-dry-home-')),
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['--once', '--dry-run', '--inject', 'usage-5xx', 'anthropic'], ctx, {
        acquireFlock: async () => { throw new Error('must not lock'); }, runAuto: async () => { throw new Error('must not admit'); },
      }), 2);
      assert.match(stderr.join('\n'), /usage: qlb auto/);
    } finally { close(ctx.home); close(ctx.env.QLB_HOME!); }
  });

  it('usage-5xx rejects a continuous-loop placement before locking', async () => {
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: () => undefined, env: testEnv(mkdtempSync(join(tmpdir(), 'qlb-auto-inject-loop-')), { QLB_FAULT_INJECTION: '1' }),
      config: {} as CommandContext['config'], loadConfig: () => { throw new Error('not used'); }, home: mkdtempSync(join(tmpdir(), 'qlb-auto-inject-loop-home-')),
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['--inject', 'usage-5xx', 'anthropic'], ctx, {
        acquireFlock: async () => { throw new Error('must not lock'); }, runAuto: async () => { throw new Error('must not admit'); },
      }), 2);
    } finally { close(ctx.home); close(ctx.env.QLB_HOME!); }
  });

  it('runAuto rejects usage-5xx outside a live once run', async () => {
    const env = new Proxy({}, { get: () => { throw new Error('must not resolve environment'); } }) as NodeJS.ProcessEnv;
    await assert.rejects(runAuto({ inject: { kind: 'usage-5xx', provider: 'anthropic' } }, { env }), AutoAdmissionRefused);
  });

  it('usage-5xx passes only the fault descriptor through the locked once run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-auto-inject-once-'));
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: () => undefined, env: testEnv(root, { QLB_FAULT_INJECTION: '1' }),
      config: {} as CommandContext['config'], loadConfig: () => { throw new Error('not used'); }, home: root,
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    let locked = 0;
    try {
      assert.equal(await runAutoCommand(['--once', '--inject', 'usage-5xx', 'anthropic', '--json'], ctx, {
        acquireFlock: async () => { locked += 1; return async () => undefined; },
        runAuto: async (options) => {
          assert.deepEqual(options.inject, { kind: 'usage-5xx', provider: 'anthropic' });
          return { ticks: 1, decisions: [], executed: [] };
        },
      }), 0);
      assert.equal(locked, 1);
    } finally { close(root); }
  });

  it('usage-5xx reaches the poll and tick seams without a credential payload', async () => {
    let pollInject: unknown;
    let tickInject: unknown;
    await runAuto({ once: true, inject: { kind: 'usage-5xx', provider: 'anthropic' } }, {
      makeLiveBinding: () => ({
        store: { setConfig: () => {} }, close: () => {}, reconcile: async () => {},
        poll: async (inject) => { pollInject = inject; return []; },
        tick: async (_accounts, inject) => { tickInject = inject; return { decision: { kind: 'stay', reason: 'unknown', unhealthyTicks: 1 } }; },
      }),
      assertAdmitted: () => ({ ok: true }), listCswapProcesses: () => [], log: () => {},
    });
    assert.deepEqual(pollInject, { kind: 'usage-5xx', provider: 'anthropic' });
    assert.deepEqual(tickInject, { kind: 'usage-5xx', provider: 'anthropic' });
  });

  it('no token-shaped string reaches stdout or stderr', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env: testEnv(mkdtempSync(join(tmpdir(), 'qlb-auto-redact-'))),
      config: {} as CommandContext['config'], loadConfig: () => { throw new Error('not used'); }, home: mkdtempSync(join(tmpdir(), 'qlb-auto-redact-home-')),
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      const code = await runExecutingCommand({ command: {
        name: 'auto', execute: (args, context) => runAutoCommand(args, context, {
          acquireFlock: async () => { throw new Error('dry run must not lock'); },
          runAuto: async (_options, dependencies) => {
            dependencies.log?.(`auto: ${secret}`);
            return { ticks: 1, decisions: [{ kind: 'stay', reason: secret, unhealthyTicks: 0 }], executed: [] } as unknown as import('../src/auto').AutoRunResult;
          },
        }),
      }, args: ['--once', '--dry-run', '--json'] }, ctx);
      assert.equal(code, 0);
      assert.equal(`${stdout.join('\n')}\n${stderr.join('\n')}`.includes(secret), false);
      assert.match(stdout[0]!, /\[redacted\]/);
      assert.match(stderr[0]!, /\[redacted\]/);
    } finally {
      close(ctx.home);
      close(ctx.env.QLB_HOME!);
    }
  });
});
