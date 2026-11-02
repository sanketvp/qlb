import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runAutoCommand } from '../src/commands/auto';
import { defaultConfig } from '../src/config';
import { runExecutingCommand } from '../src/cli';
import type { CommandContext } from '../src/registry';
import { beginCutover, transition } from '../src/lifecycle';
import { openStore } from '../src/store';

const CLI = join(__dirname, '..', 'src', 'cli.js');

type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home };
}

function start(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.close();
    const orphan = join(home, '.qlb', 'journals', 'switch-anthropic.json');
    mkdirSync(join(orphan, '..'), { recursive: true });
    writeFileSync(orphan, '{"orphaned":true}\n');
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
      assert.deepEqual(snapshot(home), before, 'dry run must not create, change, or remove a QLB_HOME file');
    } finally {
      close(root);
    }
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
