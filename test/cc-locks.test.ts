import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  assertClaudeConfigLockHeld,
  ClaudeCodeLockTimeout,
  ClaudeConfigLockRequired,
  claudeLockPaths,
  withClaudeConfigLock,
  withClaudeCredentialLocks,
  withCodexAuthLock,
  codexAuthLockDir,
  CodexAuthLockCompromised,
  withProperLockfile,
} from '../src/cc-locks';
import { spliceOauthAccount } from '../src/cc-credentials';

const PYTHON = 'python3';
const PYTHON_REQUIREMENT = 'vendored claude-swap v0.28.0 requires Python 3.12 or newer';
const CSWAP_V028_SOURCE = resolve(__dirname, '../../test/oracle/claude-swap-v0.28.0/src');
const CHILD_TIMEOUT_MS = 10_000;

type ChildOutput = { stdout: string; stderr: string };
type SpawnedPython = { child: ChildProcess; output: ChildOutput };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'qlb-cc-locks-'));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000, description = 'lock state'): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description} within ${timeoutMs}ms`);
    await sleep(5);
  }
}

function outputSummary(output: ChildOutput): string {
  const text = [output.stdout, output.stderr].filter(Boolean).join('\n').trim();
  return text ? ` Output: ${text.slice(0, 1_000)}` : '';
}

function captureChildOutput(child: ChildProcess): ChildOutput {
  if (!child.stdout || !child.stderr) throw new Error('vendored C-swap child must have piped output');
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data: string) => { output.stdout += data; });
  child.stderr.on('data', (data: string) => { output.stderr += data; });
  return output;
}

function waitForChildExit(
  child: ChildProcess,
  output: ChildOutput,
  description: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      rejectExit(new Error(`${description} failed: ${error.message}${outputSummary(output)}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      rejectExit(new Error(`${description} did not exit within ${CHILD_TIMEOUT_MS}ms; killed it.${outputSummary(output)}`));
    }, CHILD_TIMEOUT_MS);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForOutput(child: ChildProcess, output: ChildOutput, marker: string, description: string): Promise<void> {
  if (output.stdout.includes(marker)) return Promise.resolve();
  return new Promise((resolveOutput, rejectOutput) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onData = () => {
      if (!output.stdout.includes(marker)) return;
      cleanup();
      resolveOutput();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectOutput(new Error(`${description} exited before ${marker} (code ${code}, signal ${signal}).${outputSummary(output)}`));
    };
    const onError = (error: Error) => {
      cleanup();
      rejectOutput(new Error(`${description} failed before ${marker}: ${error.message}${outputSummary(output)}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      rejectOutput(new Error(`${description} did not print ${marker} within ${CHILD_TIMEOUT_MS}ms; killed it.${outputSummary(output)}`));
    }, CHILD_TIMEOUT_MS);
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function terminateChild(child: ChildProcess | undefined, output: ChildOutput | undefined, description: string): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, output ?? { stdout: '', stderr: '' }, `${description} cleanup`);
}

function findVendoredPython(path = process.env.PATH): string | undefined {
  const env = { ...process.env, PATH: path };
  const isCompatible = (python: string): boolean => {
    const result = spawnSync(
      python,
      ['-I', '-B', '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
      { encoding: 'utf8', env },
    );
    if (result.error || result.status !== 0) return false;
    const [major, minor] = result.stdout.trim().split('.').map(Number);
    return major > 3 || (major === 3 && minor >= 12);
  };

  if (isCompatible(PYTHON)) return PYTHON;
  const uv = spawnSync('uv', ['python', 'find', '3.12'], { encoding: 'utf8', env });
  if (uv.error || uv.status !== 0) return undefined;
  const candidate = uv.stdout.trim();
  return candidate && isCompatible(candidate) ? candidate : undefined;
}

function spawnVendoredPython(python: string, home: string, body: string): SpawnedPython {
  const oracleProgram = [
    'import os, pathlib, sys, tempfile',
    `os.environ["HOME"] = ${JSON.stringify(home)}`,
    `os.environ["CLAUDE_CONFIG_DIR"] = ${JSON.stringify(join(home, '.claude'))}`,
    `source = ${JSON.stringify(CSWAP_V028_SOURCE)}`,
    'with tempfile.TemporaryDirectory() as temp:',
    '    metadata = pathlib.Path(temp) / "claude_swap-0.28.0.dist-info"',
    '    metadata.mkdir()',
    '    (metadata / "METADATA").write_text("Metadata-Version: 2.1\\nName: claude-swap\\nVersion: 0.28.0\\n")',
    '    sys.path[:0] = [source, temp]',
    ...body.split('\n').map((line) => `    ${line}`),
  ].join('\n');
  const child = spawn(python, ['-I', '-B', '-c', oracleProgram], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, output: captureChildOutput(child) };
}

it('detects missing Python and uv through an injected PATH without throwing', async () => {
  const noCommands = await mkdtemp(join(tmpdir(), 'qlb-no-python-or-uv-'));
  try {
    assert.equal(findVendoredPython(noCommands), undefined);
  } finally {
    await rm(noCommands, { recursive: true, force: true });
  }
});

async function pythonHolder(python: string, home: string, seconds: number): Promise<SpawnedPython> {
  const spawned = spawnVendoredPython(python, home, [
    'import time',
    'from claude_swap.claude_locks import claude_credentials_lock',
    'with claude_credentials_lock(timeout=2):',
    '    print("READY", flush=True)',
    `    time.sleep(${seconds})`,
  ].join('\n'));
  try {
    await waitForOutput(spawned.child, spawned.output, 'READY', 'vendored C-swap holder');
    return spawned;
  } catch (error) {
    await terminateChild(spawned.child, spawned.output, 'vendored C-swap holder');
    throw error;
  }
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

  it('matches upstream stale takeover-sidecar handling', async () => {
    const home = await tempHome();
    const lock = join(home, 'stale.lock');
    const takeover = `${lock}.takeover`;
    try {
      await mkdir(lock, { recursive: true });
      await mkdir(takeover);
      const old = new Date(Date.now() - 6_000);
      await utimes(lock, old, old);

      await assert.rejects(
        withProperLockfile(lock, { stalenessMs: 100, timeoutMs: 60, retryMinMs: 5, retryJitterMs: 0 }, async () => {}),
        ClaudeCodeLockTimeout,
      );
      assert.equal(existsSync(takeover), true, 'a fresh sidecar is respected');

      await utimes(takeover, old, old);
      await withProperLockfile(lock, { stalenessMs: 100, timeoutMs: 500, retryMinMs: 5, retryJitterMs: 0 }, async () => {
        assert.equal(existsSync(lock), true);
      });
      assert.equal(existsSync(takeover), false, 'an abandoned sidecar is removed before retrying');
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

  it('backs off when a foreign owner token appears during acquisition', async () => {
    const home = await tempHome();
    const lock = join(home, 'exclusive-owner.lock');
    const foreignToken = '.qlb-owner-999-deadbeef';
    const fsPromises = require('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
    const originalWriteFile = fsPromises.writeFile;
    let ownerWrites = 0;
    let callbackRan = false;
    try {
      fsPromises.writeFile = async (...args: any[]) => {
        const result = await originalWriteFile(...args);
        if (String(args[0]).startsWith(`${lock}/.qlb-owner-`) && ++ownerWrites === 1) {
          await originalWriteFile(join(lock, foreignToken), '', { flag: 'wx' });
        }
        return result;
      };

      await assert.rejects(
        withProperLockfile(lock, {
          onCompromised: () => {},
          timeoutMs: 60,
          stalenessMs: 1_000,
          retryMinMs: 5,
          retryJitterMs: 0,
        }, async () => { callbackRan = true; }),
        ClaudeCodeLockTimeout,
      );
      assert.equal(callbackRan, false, 'a holder with a foreign token must not enter its callback');
      assert.deepEqual(await readdir(lock), [foreignToken], 'only this holder\'s token is removed');
    } finally {
      fsPromises.writeFile = originalWriteFile;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('marks an opt-in holder compromised when a foreign owner token appears', async () => {
    const home = await tempHome();
    const lock = join(home, 'foreign-owner-after-acquisition.lock');
    let compromised = 0;
    try {
      await withProperLockfile(lock, { onCompromised: () => { compromised += 1; } }, async (held) => {
        await writeFile(join(lock, '.qlb-owner-999-deadbeef'), '', { flag: 'wx' });
        assert.throws(() => held.assertNotCompromised(), /Lock ownership was lost/);
        assert.throws(() => held.assertNotCompromised(), /Lock ownership was lost/);
      });
      assert.equal(compromised, 1, 'a foreign token marks the holder compromised once');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not enter A while a stalled acquisition writes into B\'s replacement lock', async () => {
    const home = await tempHome();
    const lock = join(home, 'exclusive-owner-race.lock');
    const fsPromises = require('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
    const originalWriteFile = fsPromises.writeFile;
    let releaseAWrite!: () => void;
    const aWriteReleased = new Promise<void>((resolve) => { releaseAWrite = resolve; });
    let aWriteStalled!: () => void;
    const aWriteStarted = new Promise<void>((resolve) => { aWriteStalled = resolve; });
    let releaseB!: () => void;
    const bReleased = new Promise<void>((resolve) => { releaseB = resolve; });
    let bEntered!: () => void;
    const bEnteredCallback = new Promise<void>((resolve) => { bEntered = resolve; });
    let ownerWrites = 0;
    let aCallbackRan = false;
    let bPastAssert = 0;
    let mostPastAssert = 0;
    try {
      fsPromises.writeFile = async (...args: any[]) => {
        if (String(args[0]).startsWith(`${lock}/.qlb-owner-`) && ++ownerWrites === 1) {
          aWriteStalled();
          await aWriteReleased;
        }
        return originalWriteFile(...args);
      };

      const a = withProperLockfile(lock, {
        onCompromised: () => {},
        timeoutMs: 100,
        // A must never judge B's live lock stale while it retries; only B's
        // short staleness is needed (to take over A's stalled directory).
        // A 10 ms window let a slow CI runner's late toucher look abandoned.
        stalenessMs: 60_000,
        touchIntervalMs: 5,
        retryMinMs: 1,
        retryJitterMs: 0,
      }, async (held) => {
        held.assertNotCompromised();
        aCallbackRan = true;
      });
      await aWriteStarted;
      const old = new Date(Date.now() - 1_000);
      await utimes(lock, old, old);

      const b = withProperLockfile(lock, {
        onCompromised: () => {},
        timeoutMs: 1_000,
        stalenessMs: 10,
        touchIntervalMs: 5,
        retryMinMs: 1,
        retryJitterMs: 0,
      }, async (held) => {
        held.assertNotCompromised();
        bPastAssert += 1;
        mostPastAssert = Math.max(mostPastAssert, bPastAssert);
        bEntered();
        await bReleased;
        bPastAssert -= 1;
      });
      await bEnteredCallback;
      releaseAWrite();

      await assert.rejects(a, ClaudeCodeLockTimeout);
      assert.equal(aCallbackRan, false, 'A must retry or time out rather than enter B\'s lock');
      const entries = await readdir(lock);
      assert.equal(entries.length, 1, 'A removes the token it wrote into B\'s lock');
      assert.match(entries[0], /^\.qlb-owner-\d+-[0-9a-f]+$/);
      assert.equal(mostPastAssert, 1, 'at most one holder is past its compromise assertion');

      releaseB();
      await b;
    } finally {
      releaseAWrite?.();
      releaseB?.();
      fsPromises.writeFile = originalWriteFile;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('a takeover during the final mutation makes withCodexAuthLock throw CodexAuthLockCompromised, not succeed', async () => {
    const home = await tempHome();
    const lock = codexAuthLockDir({ home });
    try {
      await assert.rejects(
        withCodexAuthLock({ home }, async () => {
          await rm(lock, { recursive: true });
          await mkdir(lock);
          return 'callback succeeded';
        }),
        (error: unknown) => error instanceof CodexAuthLockCompromised && error.retryable,
      );
      assert.equal(existsSync(lock), true, 'the displaced holder must not release the successor lock');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('detects a Codex-lock takeover even when stat reports a reused inode', async () => {
    const home = await tempHome();
    const lock = codexAuthLockDir({ home });
    const fs = require('node:fs') as { statSync: (...args: any[]) => any };
    const originalStatSync = fs.statSync;
    try {
      // Model Linux immediately reusing the deleted directory's dev/ino pair;
      // this must not rely on a filesystem allocator's behaviour.
      fs.statSync = (...args: any[]) => {
        const held = originalStatSync(...args);
        return String(args[0]) === lock ? { ...held, dev: 1, ino: 1 } : held;
      };
      await assert.rejects(
        withCodexAuthLock({ home }, async () => {
          await rm(lock, { recursive: true });
          await mkdir(lock);
          return 'callback succeeded';
        }),
        (error: unknown) => error instanceof CodexAuthLockCompromised && error.retryable,
      );
      assert.equal(existsSync(lock), true, 'the displaced holder must not release the successor lock');
    } finally {
      fs.statSync = originalStatSync;
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

  it('records the config lock actually acquired when the layout flips while waiting', async () => {
    const home = await tempHome();
    const configDir = join(home, 'profile');
    const globalConfig = join(configDir, '.claude.json');
    const legacyConfig = join(configDir, '.config.json');
    const globalLock = `${globalConfig}.lock`;
    const originalConfig = '{"preserved":true}\n';
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(globalConfig, originalConfig);
      await mkdir(globalLock);

      const waiter = withClaudeConfigLock(
        { configDir, env: {}, timeoutMs: 1_000, retryMinMs: 5, retryJitterMs: 0 },
        async (held) => {
          assert.equal(existsSync(globalLock), true, 'the waiter holds the global lock selected before waiting');
          assert.equal(existsSync(`${legacyConfig}.lock`), false, 'the legacy lock was never acquired');
          await assert.rejects(
            spliceOauthAccount(globalConfig, { replacement: true }, held),
            ClaudeConfigLockRequired,
          );
          assert.equal(await readFile(globalConfig, 'utf8'), originalConfig, 'a differently guarded config is not written');

          await rm(legacyConfig);
          assert.doesNotThrow(() => assertClaudeConfigLockHeld(held, { configDir, env: {} }));
        },
      );

      await writeFile(legacyConfig, '{"legacy":true}\n');
      await rm(globalLock, { recursive: true });
      await waiter;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('blocks behind vendored C-swap v0.28.0 and blocks it in return', async (t) => {
    const python = findVendoredPython();
    if (!python) {
      t.skip(PYTHON_REQUIREMENT);
      return;
    }
    assert.equal(existsSync(CSWAP_V028_SOURCE), true, `missing vendored oracle at ${CSWAP_V028_SOURCE}`);
    const home = await tempHome();
    let holder: SpawnedPython | undefined;
    let waiter: SpawnedPython | undefined;
    let release: (() => void) | undefined;
    try {
      holder = await pythonHolder(python, home, 0.25);
      const started = Date.now();
      await withClaudeCredentialLocks({ home, env: {}, timeoutMs: 2_000, retryMinMs: 5, retryJitterMs: 0 }, async () => {});
      assert.ok(Date.now() - started >= 150, 'QLB waited for the vendored C-swap holder');
      const holderExit = await waitForChildExit(holder.child, holder.output, 'vendored C-swap holder');
      assert.equal(holderExit.code, 0, outputSummary(holder.output));

      const held = new Promise<void>((resolve) => { release = resolve; });
      const qlb = withClaudeCredentialLocks({ home, env: {}, timeoutMs: 2_000 }, async () => { await held; });
      await waitFor(() =>
        existsSync(join(home, '.claude', '.oauth_refresh.lock')) && existsSync(join(home, '.claude.lock')),
      );
      waiter = spawnVendoredPython(python, home, [
        'import threading, time',
        'from claude_swap.claude_locks import claude_credentials_lock',
        'started = time.monotonic()',
        'acquired = threading.Event()',
        'def confirm_contention():',
        '    if not acquired.wait(0.15): print("STILL_WAITING", flush=True)',
        'threading.Thread(target=confirm_contention, daemon=True).start()',
        'with claude_credentials_lock(timeout=2):',
        '    acquired.set()',
        '    print(f"ACQUIRED {time.monotonic() - started}", flush=True)',
      ].join('\n'));
      await waitForOutput(waiter.child, waiter.output, 'STILL_WAITING', 'vendored C-swap waiter to confirm contention');
      release?.();
      await qlb;
      const waiterExit = await waitForChildExit(waiter.child, waiter.output, 'vendored C-swap waiter');
      assert.equal(waiterExit.code, 0, outputSummary(waiter.output));
      const waited = /^ACQUIRED ([\d.]+)$/m.exec(waiter.output.stdout)?.[1];
      assert.ok(waited && Number.parseFloat(waited) >= 0.15, `vendored C-swap should wait, got ${waiter.output.stdout}`);
    } finally {
      release?.();
      await terminateChild(holder?.child, holder?.output, 'vendored C-swap holder');
      await terminateChild(waiter?.child, waiter?.output, 'vendored C-swap waiter');
      await rm(home, { recursive: true, force: true });
    }
  });
});
