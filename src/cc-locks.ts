// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — claude_locks.py (lines 46–70, 75–228).
// See third_party/claude-swap/LICENSE for the upstream license.

import { existsSync, statSync } from 'node:fs';
import { mkdir, rmdir, stat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { basename, join } from 'node:path';

/** Claude Code's `proper-lockfile` stale interval for OAuth-refresh locks. */
export const CREDENTIALS_STALENESS_MS = 60_000;
/** Claude Code's older default stale interval for its global config lock. */
export const CONFIG_STALENESS_MS = 10_000;
/** Refresh lock directory mtime more often than Claude Code's five-second cadence. */
export const TOUCH_INTERVAL_MS = 3_000;
/** Maximum time spent waiting for each individual lock directory. */
export const DEFAULT_TIMEOUT_MS = 9_000;
const RETRY_MIN_MS = 250;
const RETRY_JITTER_MS = 250;
/** Sibling directory suffix used to serialize stale-lock takeovers. */
export const TAKEOVER_SUFFIX = '.takeover';
/** A stale takeover directory is abandoned after this long. */
export const TAKEOVER_STALENESS_MS = 5_000;
/** Sibling suffix used to serialize reclamation of stale takeover directories. */
export const RECLAIM_SUFFIX = '.reclaim';

export class ClaudeCodeLockTimeout extends Error {
  constructor(lockDir: string) {
    super(`Could not acquire ${basename(lockDir)} — Claude Code appears to be refreshing credentials. Retry in a few seconds.`);
    this.name = 'ClaudeCodeLockTimeout';
  }
}

/**
 * Location inputs deliberately make all lock operations testable without using a real home.
 * `configDir` takes precedence over `env.CLAUDE_CONFIG_DIR`, as an explicit test/caller input.
 */
export interface ClaudeLockOptions {
  home?: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stalenessMs?: number;
  touchIntervalMs?: number;
  retryMinMs?: number;
  retryJitterMs?: number;
}

export interface ClaudeLockPaths {
  configHome: string;
  oauthRefreshLockDir: string;
  credentialsLockDir: string;
  configLockDir: string;
}

function resolvedEnv({ env = process.env }: ClaudeLockOptions): NodeJS.ProcessEnv {
  return env;
}

function resolvedHome(options: ClaudeLockOptions): string {
  const fromEnv = resolvedEnv(options).HOME;
  return options.home ?? (typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : homedir());
}

function resolvedConfigHome(options: ClaudeLockOptions): string {
  const fromEnv = resolvedEnv(options).CLAUDE_CONFIG_DIR;
  return options.configDir ?? (typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(resolvedHome(options), '.claude'));
}

/**
 * Resolve C-swap/Claude Code lock paths, choosing legacy `<config-home>/.config.json`
 * only when Claude Code's `_pick_global_config` rule would select it.
 */
export function claudeLockPaths(options: ClaudeLockOptions = {}): ClaudeLockPaths {
  const configHome = resolvedConfigHome(options);
  const legacyGlobalConfig = join(configHome, '.config.json');
  const globalConfig = join((options.configDir ?? resolvedEnv(options).CLAUDE_CONFIG_DIR) || resolvedHome(options), '.claude.json');
  let pickedGlobalConfig = globalConfig;
  try {
    const legacy = statSync(legacyGlobalConfig);
    if (legacy.isFile() && (legacy.size > 0 || ((legacy.mode & 0o222) !== 0 && !existsSync(globalConfig)))) {
      pickedGlobalConfig = legacyGlobalConfig;
    }
  } catch {
    // A missing, inaccessible, or otherwise invalid legacy path makes the global file win.
  }
  return {
    configHome,
    oauthRefreshLockDir: join(configHome, '.oauth_refresh.lock'),
    credentialsLockDir: join(configHome, '..', `${basename(configHome)}.lock`),
    configLockDir: `${pickedGlobalConfig}.lock`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bestEffortRelease(lockDir: string): Promise<void> {
  try {
    await rmdir(lockDir);
  } catch {
    // Match the ignored cleanup failure in claude_locks.py:121-125.
  }
}

async function releaseHeldLock(lockDir: string): Promise<void> {
  try {
    await rmdir(lockDir);
  } catch (error: unknown) {
    // Match claude_locks.py:188-195: release failures must not replace the callback result.
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`Lock ${lockDir} vanished while held (taken over as stale?)`);
    } else {
      console.warn(`Failed to release lock ${lockDir}: ${String(error)}`);
    }
  }
}

/**
 * Remove a stale lock only while holding its sibling takeover directory. The re-check prevents
 * a second stale contender from removing a first contender's freshly recreated lock.
 *
 * The reclaim guard serializes reclamation only among ported contenders. Upstream C-swap
 * contenders and a slow-but-alive holder beyond `TAKEOVER_STALENESS_MS` can still race: this is
 * the upstream-shared, time-bound assumption also used for lock staleness. Native Claude Code
 * ignores both directories.
 */
async function removeIfStillStale(lockDir: string, stalenessMs: number): Promise<boolean> {
  const takeoverDir = `${lockDir}${TAKEOVER_SUFFIX}`;
  const reclaimDir = `${takeoverDir}${RECLAIM_SUFFIX}`;
  try {
    await mkdir(takeoverDir);
  } catch (error: unknown) {
    if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    try {
      const heldTakeover = await stat(takeoverDir);
      if (Date.now() - heldTakeover.mtimeMs <= TAKEOVER_STALENESS_MS) return false;
    } catch {
      return false;
    }

    try {
      await mkdir(reclaimDir);
    } catch {
      try {
        const heldReclaim = await stat(reclaimDir);
        if (Date.now() - heldReclaim.mtimeMs > TAKEOVER_STALENESS_MS) await rmdir(reclaimDir);
      } catch {
        // Another contender released or retook the reclaim directory; retry the lock protocol.
      }
      return false;
    }

    try {
      try {
        const heldTakeover = await stat(takeoverDir);
        if (Date.now() - heldTakeover.mtimeMs > TAKEOVER_STALENESS_MS) await rmdir(takeoverDir);
      } catch {
        // Another contender released or retook the takeover directory; retry the lock protocol.
      }
      return false;
    } finally {
      await bestEffortRelease(reclaimDir);
    }
  }

  try {
    const held = await stat(lockDir);
    if (Date.now() - held.mtimeMs <= stalenessMs) return false;
    await rmdir(lockDir);
    return true;
  } catch {
    return false;
  } finally {
    await bestEffortRelease(takeoverDir);
  }
}

/**
 * Acquire a proper-lockfile-compatible directory lock, execute `fn`, then release it.
 *
 * `mkdir` is the atomic acquisition operation. Existing locks are taken over only when their
 * mtime is older than `stalenessMs`; live holders touch mtime periodically. Its toucher runs on
 * the Node event loop (`setInterval`), unlike upstream's daemon thread, so a blocked holder can
 * let its lock go stale. Do not put network awaits in `fn`: the Claude Code critical sections
 * this mirrors are deliberately short.
 */
export async function withProperLockfile<T>(
  lockDir: string,
  options: ClaudeLockOptions = {},
  fn: () => Promise<T> | T,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stalenessMs = options.stalenessMs ?? CONFIG_STALENESS_MS;
  const touchIntervalMs = options.touchIntervalMs ?? TOUCH_INTERVAL_MS;
  const retryMinMs = options.retryMinMs ?? RETRY_MIN_MS;
  const retryJitterMs = options.retryJitterMs ?? RETRY_JITTER_MS;
  const started = performance.now();

  await mkdir(join(lockDir, '..'), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error: unknown) {
      if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    if (performance.now() - started > timeoutMs) throw new ClaudeCodeLockTimeout(lockDir);

    try {
      const held = await stat(lockDir);
      if (Date.now() - held.mtimeMs > stalenessMs) {
        if (!await removeIfStillStale(lockDir, stalenessMs)) {
          // Match C-swap's tiny backoff after a failed stale-lock removal/takeover.
          await sleep(50);
        }
        continue;
      }
    } catch (error: unknown) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue; // Holder released between mkdir and stat; retry immediately.
      }
      throw error;
    }
    await sleep(retryMinMs + Math.random() * retryJitterMs);
  }

  let touchInFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (touchInFlight) return;
    touchInFlight = utimes(lockDir, new Date(), new Date()).catch(() => {
      // Match claude_locks.py:174-179: a removed/stolen lock ends this touch loop permanently.
      clearInterval(timer);
    }).finally(() => { touchInFlight = undefined; });
  }, touchIntervalMs);
  timer.unref();

  try {
    return await fn();
  } finally {
    clearInterval(timer);
    // Like claude_locks.py:186-195, wait for the toucher then release by pathname.
    await touchInFlight;
    await releaseHeldLock(lockDir);
  }
}

/**
 * Hold Claude Code's refresh locks in its required order: primary OAuth lock, then legacy lock.
 * Each lock receives its own nine-second waiting budget and 60-second stale threshold.
 * Callers must keep this critical section local; do not await network I/O while holding it.
 */
export async function withClaudeCredentialLocks<T>(
  options: ClaudeLockOptions = {},
  fn: () => Promise<T> | T,
): Promise<T> {
  const paths = claudeLockPaths(options);
  const credentialOptions = { ...options, stalenessMs: CREDENTIALS_STALENESS_MS };
  return withProperLockfile(paths.oauthRefreshLockDir, credentialOptions, async () =>
    withProperLockfile(paths.credentialsLockDir, credentialOptions, fn));
}

/** Hold Claude Code's global-config proper-lockfile directory for a local read-modify-write. */
export async function withClaudeConfigLock<T>(
  options: ClaudeLockOptions = {},
  fn: () => Promise<T> | T,
): Promise<T> {
  return withProperLockfile(claudeLockPaths(options).configLockDir, {
    ...options,
    stalenessMs: CONFIG_STALENESS_MS,
  }, fn);
}
