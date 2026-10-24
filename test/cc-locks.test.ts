import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  ClaudeCodeLockTimeout,
  RECLAIM_SUFFIX,
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
      const paths = claudeLockPaths({ home, env: {} });
      assert.equal(paths.oauthRefreshLockDir, join(home, '.claude', '.oauth_refresh.lock'));
      assert.equal(paths.credentialsLockDir, join(home, '.claude.lock'));
      assert.equal(paths.configLockDir, join(home, '.claude.json.lock'));

      await mkdir(paths.credentialsLockDir, { recursive: true });
      const held = withClaudeCredentialLocks(
        { home, env: {}, timeoutMs: 500, retryMinMs: 5, retryJitterMs: 0 },
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

  it('honors CLAUDE_CONFIG_DIR and Claude Code legacy global-config selection', async () => {
    const home = await tempHome();
    const configDir = join(home, 'profile');
    const legacy = join(configDir, '.config.json');
    const globalConfig = join(configDir, '.claude.json');
    try {
      const paths = claudeLockPaths({ home, env: { CLAUDE_CONFIG_DIR: configDir } });
      assert.equal(paths.oauthRefreshLockDir, join(configDir, '.oauth_refresh.lock'));
      assert.equal(paths.credentialsLockDir, `${configDir}.lock`);
      assert.equal(paths.configLockDir, `${globalConfig}.lock`);
      await mkdir(configDir, { recursive: true });

      assert.equal(claudeLockPaths({ home, configDir, env: {} }).configLockDir, `${globalConfig}.lock`);
      await writeFile(legacy, 'legacy');
      assert.equal(claudeLockPaths({ home, configDir, env: {} }).configLockDir, `${legacy}.lock`);
      await writeFile(legacy, '');
      assert.equal(claudeLockPaths({ home, configDir, env: {} }).configLockDir, `${legacy}.lock`);
      await writeFile(globalConfig, '{}');
      assert.equal(claudeLockPaths({ home, configDir, env: {} }).configLockDir, `${globalConfig}.lock`);
      await rm(globalConfig);
      await chmod(legacy, 0o444);
      assert.equal(claudeLockPaths({ home, configDir, env: {} }).configLockDir, `${globalConfig}.lock`);
      await chmod(legacy, 0o644);
      await rm(legacy);
      await mkdir(legacy);
      assert.equal(claudeLockPaths({ home, configDir, env: {} }).configLockDir, `${globalConfig}.lock`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses process CLAUDE_CONFIG_DIR when no environment is injected', async () => {
    const home = await tempHome();
    const configDir = join(home, 'process-profile');
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir;
      const paths = claudeLockPaths({ home });
      assert.equal(paths.configHome, configDir);
      assert.equal(paths.oauthRefreshLockDir, join(configDir, '.oauth_refresh.lock'));
      assert.equal(paths.credentialsLockDir, `${configDir}.lock`);
      assert.equal(paths.configLockDir, join(configDir, '.claude.json.lock'));
      await withClaudeCredentialLocks({ home, timeoutMs: 200 }, async () => {
        assert.equal(existsSync(paths.oauthRefreshLockDir), true);
        assert.equal(existsSync(paths.credentialsLockDir), true);
      });
      assert.equal(existsSync(join(home, '.claude', '.oauth_refresh.lock')), false);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
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

  it('does not let a delayed stale reclaimer disturb a fresh third contender sidecar', async () => {
    const home = await tempHome();
    const lock = join(home, 'race.lock');
    const takeover = `${lock}.takeover`;
    const reclaim = `${takeover}${RECLAIM_SUFFIX}`;
    const fsPromises = require('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
    const originalMkdir = fsPromises.mkdir;
    const originalRename = fsPromises.rename;
    const originalRmdir = fsPromises.rmdir;
    const originalStat = fsPromises.stat;
    let releaseInitialStats!: () => void;
    const initialStatsReady = new Promise<void>((resolve) => { releaseInitialStats = resolve; });
    let releaseBRetry!: () => void;
    const bRetryReady = new Promise<void>((resolve) => { releaseBRetry = resolve; });
    let releaseDelayedA!: () => void;
    const delayedAReady = new Promise<void>((resolve) => { releaseDelayedA = resolve; });
    let releaseCLockRemoval!: () => void;
    const cLockRemovalReady = new Promise<void>((resolve) => { releaseCLockRemoval = resolve; });
    let staleTakeoverCleared!: () => void;
    const staleTakeoverClearedReady = new Promise<void>((resolve) => { staleTakeoverCleared = resolve; });
    let freshSidecarCreated!: () => void;
    const freshSidecarReady = new Promise<void>((resolve) => { freshSidecarCreated = resolve; });
    let delayedAReclaimFailed!: () => void;
    const delayedAReclaimFailedReady = new Promise<void>((resolve) => { delayedAReclaimFailed = resolve; });
    let initialStats = 0;
    let reclaimMkdirs = 0;
    let takeoverRemovals = 0;
    let takeoverHolders = 1;
    let mostTakeoverHolders = 1;
    let freshSidecarClaimFailures = 0;
    let renameCalls = 0;
    try {
      await mkdir(lock, { recursive: true });
      await mkdir(takeover);
      const old = new Date(Date.now() - 6_000);
      await utimes(lock, old, old);
      await utimes(takeover, old, old);

      fsPromises.stat = async (...args: any[]) => {
        const result = await originalStat(...args);
        if (String(args[0]) === takeover && initialStats < 2) {
          initialStats += 1;
          if (initialStats === 2) releaseInitialStats();
          await initialStatsReady;
        }
        return result;
      };
      fsPromises.mkdir = async (...args: any[]) => {
        const path = String(args[0]);
        const delayedA = path === reclaim && ++reclaimMkdirs === 2;
        if (delayedA) await delayedAReady;
        let result;
        try {
          result = await originalMkdir(...args);
        } catch (error) {
          if (delayedA) delayedAReclaimFailed();
          if (path === takeover && takeoverHolders === 1) freshSidecarClaimFailures += 1;
          throw error;
        }
        if (path === takeover) {
          takeoverHolders += 1;
          mostTakeoverHolders = Math.max(mostTakeoverHolders, takeoverHolders);
          freshSidecarCreated();
        }
        return result;
      };
      fsPromises.rmdir = async (...args: any[]) => {
        const path = String(args[0]);
        const result = await originalRmdir(...args);
        if (path === takeover) {
          takeoverHolders -= 1;
          if (++takeoverRemovals === 1) {
            staleTakeoverCleared();
            await bRetryReady;
          }
        }
        if (path === lock && existsSync(takeover)) await cLockRemovalReady;
        return result;
      };
      fsPromises.rename = async (...args: any[]) => {
        renameCalls += 1;
        return originalRename(...args);
      };

      const [a, b] = [0, 1].map(() => withProperLockfile(
        lock,
        { stalenessMs: 100, timeoutMs: 2_000, retryMinMs: 5, retryJitterMs: 0 },
        async () => {},
      ));
      await waitFor(() => initialStats === 2);
      releaseInitialStats();
      await staleTakeoverClearedReady;
      freshSidecarClaimFailures = 0;

      const c = withProperLockfile(lock, { stalenessMs: 100, timeoutMs: 2_000, retryMinMs: 5, retryJitterMs: 0 }, async () => {});
      await freshSidecarReady;
      assert.equal(existsSync(takeover), true, 'C holds the freshly recreated sidecar');
      releaseDelayedA();
      await delayedAReclaimFailedReady;
      assert.equal(takeoverRemovals, 1, 'A must not remove C\'s fresh sidecar');
      assert.equal(renameCalls, 0, 'A must not rename C\'s fresh sidecar');
      assert.equal(mostTakeoverHolders, 1, 'no two contenders may hold the sidecar at once');

      await assert.rejects(fsPromises.mkdir(takeover), /EEXIST/);
      assert.ok(freshSidecarClaimFailures > 0, 'another contender cannot mkdir C\'s held sidecar');
      releaseBRetry();
      releaseCLockRemoval();
      await Promise.all([a, b, c]);
    } finally {
      releaseInitialStats?.();
      releaseBRetry?.();
      releaseDelayedA?.();
      releaseCLockRemoval?.();
      fsPromises.mkdir = originalMkdir;
      fsPromises.rename = originalRename;
      fsPromises.rmdir = originalRmdir;
      fsPromises.stat = originalStat;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('clears a stale abandoned reclaim directory before taking over a lock', async () => {
    const home = await tempHome();
    const lock = join(home, 'stale.lock');
    const takeover = `${lock}.takeover`;
    const reclaim = `${takeover}${RECLAIM_SUFFIX}`;
    try {
      await mkdir(lock, { recursive: true });
      await mkdir(takeover);
      await mkdir(reclaim);
      const old = new Date(Date.now() - 6_000);
      await utimes(lock, old, old);
      await utimes(takeover, old, old);
      await utimes(reclaim, old, old);
      await withProperLockfile(lock, { stalenessMs: 100, timeoutMs: 500, retryMinMs: 5, retryJitterMs: 0 }, async () => {});
      assert.equal(existsSync(reclaim), false);
      assert.equal(existsSync(takeover), false);
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

  it('touches and releases a replacement lock by pathname, matching upstream', async () => {
    const home = await tempHome();
    const lock = join(home, 'replacement.lock');
    try {
      await withProperLockfile(lock, { touchIntervalMs: 10 }, async () => {
        await rm(lock, { recursive: true });
        await mkdir(join(home, 'spacer'));
        await mkdir(lock);
        const old = new Date(Date.now() - 60_000);
        await utimes(lock, old, old);
        const replacementMtime = (await stat(lock)).mtimeMs;
        await sleep(80);
        assert.ok((await stat(lock)).mtimeMs > replacementMtime, 'upstream toucher refreshes by pathname');
      });
      assert.equal(existsSync(lock), false, 'upstream release removes by pathname');
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
      const paths = claudeLockPaths({ home, env: {} });
      await assert.rejects(withClaudeConfigLock({ home, env: {} }, async () => { throw new Error('stop'); }), /stop/);
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
      await withClaudeCredentialLocks({ home, env: {}, timeoutMs: 2_000, retryMinMs: 5, retryJitterMs: 0 }, async () => {});
      assert.ok(Date.now() - started >= 150, 'QLB waited for the C-swap holder');
      await once(holder, 'exit');

      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const qlb = withClaudeCredentialLocks({ home, env: {}, timeoutMs: 2_000 }, async () => { await held; });
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
