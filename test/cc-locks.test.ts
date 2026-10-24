import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  ClaudeCodeLockTimeout,
  claudeLockPaths,
  withClaudeConfigLock,
  withClaudeCredentialLocks,
  withProperLockfile,
} from '../src/cc-locks';

const PYTHON = `${process.env.HOME}/.local/share/uv/tools/claude-swap/bin/python`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'qlb-cc-locks-'));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for lock state');
    await sleep(5);
  }
}

async function pythonHolder(home: string, seconds: number): Promise<ReturnType<typeof spawn>> {
  const script = [
    'import os, sys, time',
    `os.environ["HOME"] = ${JSON.stringify(home)}`,
    `os.environ["CLAUDE_CONFIG_DIR"] = ${JSON.stringify(join(home, '.claude'))}`,
    'from claude_swap.claude_locks import claude_credentials_lock',
    'with claude_credentials_lock(timeout=2):',
    ' print("READY", flush=True)',
    ` time.sleep(${seconds})`,
  ].join('\n');
  const child = spawn(PYTHON, ['-I', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => { output += data; });
  await waitFor(() => output.includes('READY'));
  return child;
}

describe('Claude Code proper-lockfile locks', () => {
  it('uses Claude Code paths, acquires in order, and releases credential locks', async () => {
    const home = await tempHome();
    try {
      const paths = claudeLockPaths({ home });
      assert.equal(paths.oauthRefreshLockDir, join(home, '.claude', '.oauth_refresh.lock'));
      assert.equal(paths.credentialsLockDir, join(home, '.claude.lock'));
      assert.equal(paths.configLockDir, join(home, '.claude.json.lock'));

      await mkdir(paths.credentialsLockDir, { recursive: true });
      const held = withClaudeCredentialLocks(
        { home, timeoutMs: 500, retryMinMs: 5, retryJitterMs: 0 },
        async () => {
          assert.equal(existsSync(paths.oauthRefreshLockDir), true, 'primary is acquired before legacy');
          assert.equal(existsSync(paths.credentialsLockDir), true);
        },
      );
      await waitFor(() => existsSync(paths.oauthRefreshLockDir));
      await rm(paths.credentialsLockDir, { recursive: true });
      await held;
      assert.equal(existsSync(paths.oauthRefreshLockDir), false);
      assert.equal(existsSync(paths.credentialsLockDir), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('honors CLAUDE_CONFIG_DIR and the legacy global config location', async () => {
    const home = await tempHome();
    const configDir = join(home, 'profile');
    try {
      const paths = claudeLockPaths({ home, env: { CLAUDE_CONFIG_DIR: configDir } });
      assert.equal(paths.oauthRefreshLockDir, join(configDir, '.oauth_refresh.lock'));
      assert.equal(paths.credentialsLockDir, `${configDir}.lock`);
      assert.equal(paths.configLockDir, join(configDir, '.claude.json.lock'));
      await mkdir(configDir, { recursive: true });
      await mkdir(join(configDir, '.config.json'), { recursive: true });
      assert.equal(
        claudeLockPaths({ home, configDir }).configLockDir,
        join(configDir, '.config.json.lock'),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('waits for a held lock and times out within its budget', async () => {
    const home = await tempHome();
    const lock = join(home, 'held.lock');
    try {
      await mkdir(lock, { recursive: true });
      const started = Date.now();
      await assert.rejects(
        withProperLockfile(lock, { timeoutMs: 60, retryMinMs: 5, retryJitterMs: 0 }, async () => {}),
        ClaudeCodeLockTimeout,
      );
      assert.ok(Date.now() - started >= 55);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('takes over stale locks but not young locks', async () => {
    const home = await tempHome();
    const stale = join(home, 'stale.lock');
    const young = join(home, 'young.lock');
    try {
      await mkdir(stale, { recursive: true });
      const old = new Date(Date.now() - 200);
      await utimes(stale, old, old);
      await withProperLockfile(stale, { stalenessMs: 100, timeoutMs: 100 }, async () => {
        assert.equal(existsSync(stale), true);
      });
      assert.equal(existsSync(stale), false);

      await mkdir(young, { recursive: true });
      await assert.rejects(
        withProperLockfile(young, { stalenessMs: 1_000, timeoutMs: 40, retryMinMs: 5, retryJitterMs: 0 }, async () => {}),
        ClaudeCodeLockTimeout,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('serializes two waiters taking over one stale lock', async () => {
    const home = await tempHome();
    const lock = join(home, 'race.lock');
    const fsPromises = require('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
    const originalMkdir = fsPromises.mkdir;
    const originalRmdir = fsPromises.rmdir;
    const originalStat = fsPromises.stat;
    let releaseBothStaleStats!: () => void;
    const bothStaleStats = new Promise<void>((resolve) => { releaseBothStaleStats = resolve; });
    let releaseRetaken!: () => void;
    const retaken = new Promise<void>((resolve) => { releaseRetaken = resolve; });
    let staleStats = 0;
    let lockRemovals = 0;
    let inside = 0;
    let mostInside = 0;
    try {
      await mkdir(lock, { recursive: true });
      const old = new Date(Date.now() - 200);
      await utimes(lock, old, old);

      // Force #420's interleaving: both waiters see the dead directory, then the
      // second pre-fix rmdir waits until the first has recreated it.
      fsPromises.stat = async (...args: any[]) => {
        const result = await originalStat(...args);
        if (String(args[0]) === lock && staleStats < 2) {
          staleStats += 1;
          if (staleStats === 2) releaseBothStaleStats();
          await bothStaleStats;
        }
        return result;
      };
      fsPromises.mkdir = async (...args: any[]) => {
        const result = await originalMkdir(...args);
        if (String(args[0]) === lock) releaseRetaken();
        return result;
      };
      fsPromises.rmdir = async (...args: any[]) => {
        if (String(args[0]) === lock && ++lockRemovals === 2) await retaken;
        return originalRmdir(...args);
      };

      await Promise.all([0, 1].map(() => withProperLockfile(
        lock,
        { stalenessMs: 100, timeoutMs: 2_000, retryMinMs: 5, retryJitterMs: 0 },
        async () => {
          inside += 1;
          mostInside = Math.max(mostInside, inside);
          await sleep(100);
          inside -= 1;
        },
      )));
      assert.equal(mostInside, 1, 'only one waiter may hold a taken-over lock at once');
    } finally {
      fsPromises.mkdir = originalMkdir;
      fsPromises.rmdir = originalRmdir;
      fsPromises.stat = originalStat;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('leaves no takeover directory after stale-lock takeover', async () => {
    const home = await tempHome();
    const lock = join(home, 'stale.lock');
    try {
      await mkdir(lock, { recursive: true });
      const old = new Date(Date.now() - 200);
      await utimes(lock, old, old);
      await withProperLockfile(lock, { stalenessMs: 100, timeoutMs: 100 }, async () => {});
      assert.deepEqual((await readdir(home)).sort(), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('clears a stale takeover directory before taking over a lock', async () => {
    const home = await tempHome();
    const lock = join(home, 'stale.lock');
    const takeover = `${lock}.takeover`;
    try {
      await mkdir(lock, { recursive: true });
      await mkdir(takeover, { recursive: true });
      const old = new Date(Date.now() - 6_000);
      await utimes(lock, old, old);
      await utimes(takeover, old, old);
      await withProperLockfile(lock, { stalenessMs: 100, timeoutMs: 500, retryMinMs: 5, retryJitterMs: 0 }, async () => {
        assert.equal(existsSync(lock), true);
      });
      assert.equal(existsSync(takeover), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('touches held locks and releases them when the callback throws', async () => {
    const home = await tempHome();
    const lock = join(home, 'touch.lock');
    try {
      await assert.rejects(
        withProperLockfile(lock, { touchIntervalMs: 15 }, async () => {
          const before = (await stat(lock)).mtimeMs;
          await sleep(45);
          assert.ok((await stat(lock)).mtimeMs > before, 'the holder refreshed mtime');
          throw new Error('expected failure');
        }),
        /expected failure/,
      );
      assert.equal(existsSync(lock), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('releases the config lock after exceptions', async () => {
    const home = await tempHome();
    try {
      const paths = claudeLockPaths({ home });
      await assert.rejects(withClaudeConfigLock({ home }, async () => { throw new Error('stop'); }), /stop/);
      assert.equal(existsSync(paths.configLockDir), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('blocks behind C-swap and blocks C-swap in return', { skip: !existsSync(PYTHON) ? 'C-swap Python is not installed' : false }, async () => {
    const home = await tempHome();
    try {
      const holder = await pythonHolder(home, 0.25);
      const started = Date.now();
      await withClaudeCredentialLocks({ home, timeoutMs: 2_000, retryMinMs: 5, retryJitterMs: 0 }, async () => {});
      assert.ok(Date.now() - started >= 150, 'QLB waited for the C-swap holder');
      await once(holder, 'exit');

      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const qlb = withClaudeCredentialLocks({ home, timeoutMs: 2_000 }, async () => { await held; });
      const child = spawn(PYTHON, ['-I', '-c', [
        'import os, time',
        `os.environ["HOME"] = ${JSON.stringify(home)}`,
        `os.environ["CLAUDE_CONFIG_DIR"] = ${JSON.stringify(join(home, '.claude'))}`,
        'from claude_swap.claude_locks import claude_credentials_lock',
        'started = time.monotonic()',
        'with claude_credentials_lock(timeout=2): print(time.monotonic() - started, flush=True)',
      ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8');
      let out = '';
      child.stdout.on('data', (data: string) => { out += data; });
      await sleep(180);
      release();
      await qlb;
      const [code] = await once(child, 'exit') as [number | null];
      assert.equal(code, 0);
      assert.ok(Number.parseFloat(out) >= 0.15, `C-swap should wait, got ${out}`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
