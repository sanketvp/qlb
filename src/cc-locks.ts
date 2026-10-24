// Ported from claude-swap 0.26.0 (MIT, Copyright (c) realiti4) — claude_locks.py
// See third_party/claude-swap/LICENSE for the upstream license.

import { existsSync } from 'node:fs';
import { mkdir, rmdir, stat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
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

function resolvedHome(options: ClaudeLockOptions): string {
  const fromEnv = options.env?.HOME;
  return options.home ?? (typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : homedir());
}

function resolvedConfigHome(options: ClaudeLockOptions): string {
  const fromEnv = options.env?.CLAUDE_CONFIG_DIR;
  return options.configDir ?? (typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(resolvedHome(options), '.claude'));
}

/**
 * Resolve C-swap/Claude Code lock paths, including CLAUDE_CONFIG_DIR and the legacy
 * `<config-home>/.config.json` global-config location.
 */
export function claudeLockPaths(options: ClaudeLockOptions = {}): ClaudeLockPaths {
  const configHome = resolvedConfigHome(options);
  const legacyGlobalConfig = join(configHome, '.config.json');
  // Claude Code uses the legacy in-profile config when it exists. Otherwise its global
  // config is beside CLAUDE_CONFIG_DIR, or beside HOME for the default profile.
  const globalConfig = existsSync(legacyGlobalConfig)
    ? legacyGlobalConfig
    : join((options.configDir ?? options.env?.CLAUDE_CONFIG_DIR) || resolvedHome(options), '.claude.json');
  return {
    configHome,
    oauthRefreshLockDir: join(configHome, '.oauth_refresh.lock'),
    credentialsLockDir: join(configHome, '..', `${basename(configHome)}.lock`),
    configLockDir: `${globalConfig}.lock`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bestEffortRelease(lockDir: string): Promise<void> {
  try {
    await rmdir(lockDir);
  } catch (error) {
    // C-swap logs these cases, but cleanup must never replace the caller's result.
    // ENOENT means a stale-lock contender already removed it; other failures are similarly
    // non-fatal here because a subsequent contender will apply the stale-lock protocol.
    void error;
  }
}

/**
 * Acquire a proper-lockfile-compatible directory lock, execute `fn`, then release it.
 *
 * `mkdir` is the atomic acquisition operation. Existing locks are taken over only when their
 * mtime is older than `stalenessMs`; live holders touch mtime periodically. Do not put network
 * awaits in `fn`: the Claude Code critical sections this mirrors are deliberately short.
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
  const started = Date.now();

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

    if (Date.now() - started > timeoutMs) throw new ClaudeCodeLockTimeout(lockDir);

    try {
      const held = await stat(lockDir);
      if (Date.now() - held.mtimeMs > stalenessMs) {
        try {
          await rmdir(lockDir);
        } catch {
          // Match C-swap's tiny backoff after a failed stale-lock removal.
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
      // The lock was removed or stolen; there is nothing left to refresh.
    }).finally(() => { touchInFlight = undefined; });
  }, touchIntervalMs);
  timer.unref();

  try {
    return await fn();
  } finally {
    clearInterval(timer);
    // Like C-swap's thread join, never let a prior holder touch a newly acquired directory.
    await touchInFlight;
    await bestEffortRelease(lockDir);
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
