import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runAuto } from '../src/auto';
import { runAutoCommand } from '../src/commands/auto';
import { claudePaths } from '../src/cc-paths';
import { claudeSwitchJournalPath, createClaudeSwitchJournal, type ClaudeSwitchJournal } from '../src/cc-switch-journal';
import type { ClaudeSwitchDeps } from '../src/cc-switch';
import { defaultConfig } from '../src/config';
import { MockKeychain } from '../src/keychain';
import { reconcileClaudeSwitch } from '../src/journal';
import { runExecutingCommand } from '../src/cli';
import type { CommandContext } from '../src/registry';
import { beginCutover, transition } from '../src/lifecycle';
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
      store: { findClaudeSwitchByAttempt: () => null, recordSwitch: () => 1 } as unknown as ClaudeSwitchDeps['store'],
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
