/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/claude_locks.py:46-70,75-93,94-127,129-197,198-228.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

import { existsSync, statSync } from 'node:fs';
import { mkdir, rmdir, stat, utimes } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { basename, dirname, join } from 'node:path';
import { qlbHomeDir } from './home';

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

export class ClaudeCodeLockTimeout extends Error {
  constructor(lockDir: string) {
    super(`Could not acquire ${basename(lockDir)} — Claude Code appears to be refreshing credentials. Retry in a few seconds.`);
    this.name = 'ClaudeCodeLockTimeout';
  }
}

const credentialLocksHandle = Symbol('credential-locks-handle');
const configLockHandle = Symbol('config-lock-handle');

/** Opaque capability, valid only while withClaudeCredentialLocks invokes its callback. */
export interface HeldClaudeCredentialLocks {
  readonly [credentialLocksHandle]: true;
}
/** Opaque capability, valid only while withClaudeConfigLock invokes its callback. */
export interface HeldClaudeConfigLock {
  readonly [configLockHandle]: true;
}

const activeCredentialLockHandles = new WeakSet<HeldClaudeCredentialLocks>();
const activeConfigLockHandles = new WeakSet<HeldClaudeConfigLock>();
const activeCredentialLockPaths = new WeakMap<HeldClaudeCredentialLocks, ClaudeLockPaths>();
const activeConfigLockPaths = new WeakMap<HeldClaudeConfigLock, ClaudeLockPaths>();

export class ClaudeCredentialLocksRequired extends Error {
  constructor() {
    super('Claude credential locks must be held by the caller');
    this.name = 'ClaudeCredentialLocksRequired';
  }
}

export class ClaudeConfigLockRequired extends Error {
  constructor() {
    super('Claude config lock must be held by the caller');
    this.name = 'ClaudeConfigLockRequired';
  }
}

/** Fail fast unless this callback's active credential-lock capability was supplied. */
export function assertClaudeCredentialLocksHeld(
  handle: HeldClaudeCredentialLocks | undefined,
  options: ClaudeLockOptions = {},
): asserts handle is HeldClaudeCredentialLocks {
  const expected = claudeLockPaths(options);
  const heldPaths = handle && activeCredentialLockPaths.get(handle);
  if (!handle || !activeCredentialLockHandles.has(handle) ||
    heldPaths?.oauthRefreshLockDir !== expected.oauthRefreshLockDir ||
    heldPaths?.credentialsLockDir !== expected.credentialsLockDir) {
    throw new ClaudeCredentialLocksRequired();
  }
}

/** Fail fast unless this callback's active config-lock capability was supplied. */
export function assertClaudeConfigLockHeld(
  handle: HeldClaudeConfigLock | undefined,
  options: ClaudeLockOptions = {},
): asserts handle is HeldClaudeConfigLock {
  const expected = claudeLockPaths(options);
  const heldPaths = handle && activeConfigLockPaths.get(handle);
  if (!handle || !activeConfigLockHandles.has(handle) || heldPaths?.configLockDir !== expected.configLockDir) {
    throw new ClaudeConfigLockRequired();
  }
}

/**
 * Location inputs deliberately make all lock operations testable without using a real home.
 * `configDir` takes precedence over `env.CLAUDE_CONFIG_DIR`, as an explicit test/caller input.
 * `configPath` pins the config lock to an already-resolved config file, without
 * re-running the legacy selection heuristic.
 */
export interface ClaudeLockOptions {
  home?: string;
  configDir?: string;
  configPath?: string;
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

/** QLB's provider-level locks; independent from Claude Code's own lock paths. */
export interface ClaudeGateLockOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stalenessMs?: number;
}

function gateLockHome(options: ClaudeGateLockOptions): string {
  if (options.home) return options.home;
  return qlbHomeDir(options.env ?? process.env);
}

function assertGateLockAccountId(accountId: string): void {
  if (!accountId || /[\0/\\/:]/.test(accountId)) throw new Error('invalid Claude consume-lock account id');
}

/** Serialize refresh-token consumption for one QLB Claude slot. */
export async function withClaudeConsumeLock<T>(
  accountId: string,
  fn: () => Promise<T> | T,
  options: ClaudeGateLockOptions = {},
): Promise<T> {
  assertGateLockAccountId(accountId);
  return withProperLockfile(join(gateLockHome(options), '.qlb', 'locks', `consume-anthropic-${accountId}.lock`), {
    ...options,
    timeoutMs: options.timeoutMs ?? 10_000,
    stalenessMs: options.stalenessMs ?? CREDENTIALS_STALENESS_MS,
  }, fn);
}

/** Briefly serialize slot CAS/adoption with Claude switch operations. */
export async function withClaudeSwitchLock<T>(
  fn: () => Promise<T> | T,
  options: ClaudeGateLockOptions = {},
): Promise<T> {
  return withProperLockfile(join(gateLockHome(options), '.qlb', 'locks', 'switch-anthropic.lock'), {
    ...options,
    timeoutMs: options.timeoutMs ?? 10_000,
    stalenessMs: options.stalenessMs ?? CREDENTIALS_STALENESS_MS,
  }, fn);
}

function resolvedEnv({ env = process.env }: ClaudeLockOptions): NodeJS.ProcessEnv {
  return env;
}

function resolvedHome(options: ClaudeLockOptions): string {
  if (options.home) return options.home;
  const env = resolvedEnv(options);
  if (env.QLB_TEST_MODE === '1') return qlbHomeDir(env);
  const fromEnv = env.HOME;
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : qlbHomeDir(env);
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
  const globalConfig = options.configPath ?? join((options.configDir ?? resolvedEnv(options).CLAUDE_CONFIG_DIR) || resolvedHome(options), '.claude.json');
  let pickedGlobalConfig = globalConfig;
  if (!options.configPath) {
    try {
      const legacy = statSync(legacyGlobalConfig);
      if (legacy.isFile() && (legacy.size > 0 || ((legacy.mode & 0o222) !== 0 && !existsSync(globalConfig)))) {
        pickedGlobalConfig = legacyGlobalConfig;
      }
    } catch {
      // A missing, inaccessible, or otherwise invalid legacy path makes the global file win.
    }
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
 * Like upstream claude_locks.py:94-125, this sidecar coordinates only ported/C-swap contenders;
 * Claude Code's native proper-lockfile does not consult it, so the native-lock takeover race
 * remains an intentional upstream limitation.
 */
async function removeIfStillStale(lockDir: string, stalenessMs: number): Promise<boolean> {
  const takeoverDir = `${lockDir}${TAKEOVER_SUFFIX}`;
  try {
    await mkdir(takeoverDir);
  } catch (error: unknown) {
    if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    try {
      const heldTakeover = await stat(takeoverDir);
      if (Date.now() - heldTakeover.mtimeMs > TAKEOVER_STALENESS_MS) await rmdir(takeoverDir);
    } catch {
      // Another contender released or retook the takeover directory; retry the lock protocol.
    }
    return false;
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
 * mtime is older than `stalenessMs`; live holders touch mtime periodically. Do not put network
 * awaits in `fn`: the Claude Code critical sections this mirrors are deliberately short.
 *
 * Known upstream-shared limitations:
 * - Native Claude Code's `proper-lockfile` does not consult the takeover sidecar
 *   (`claude_locks.py:94-125`).
 * - A holder that loses its lease still touches and releases by pathname
 *   (`claude_locks.py:174-195`).
 * - Stale-sidecar reclaim is check-then-delete, so a crashed holder plus three or more contenders
 *   in the same instant can let one contender remove a fresh sidecar (`claude_locks.py:100-123`).
 *
 * Advisory: this mtime toucher runs on the Node event loop (`setInterval`), whereas upstream uses
 * a daemon thread; a blocked Node holder can therefore let its lock go stale.
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
  fn: (held: HeldClaudeCredentialLocks) => Promise<T> | T,
): Promise<T> {
  const paths = claudeLockPaths(options);
  const credentialOptions = { ...options, stalenessMs: CREDENTIALS_STALENESS_MS };
  return withProperLockfile(paths.oauthRefreshLockDir, credentialOptions, async () =>
    withProperLockfile(paths.credentialsLockDir, credentialOptions, async () => {
      const held = { [credentialLocksHandle]: true } as HeldClaudeCredentialLocks;
      activeCredentialLockHandles.add(held);
      activeCredentialLockPaths.set(held, paths);
      try {
        return await fn(held);
      } finally {
        activeCredentialLockHandles.delete(held);
        activeCredentialLockPaths.delete(held);
      }
    }));
}

/**
 * Hold the proper-lockfile for an already resolved Claude global-config path.
 *
 * Callers that read a path chosen by claudePaths() must use this overload rather
 * than resolving again: legacy `.config.json` selection is filesystem-dependent.
 */
export async function withClaudeConfigPathLock<T>(
  configPath: string,
  options: ClaudeLockOptions = {},
  fn: (held: HeldClaudeConfigLock) => Promise<T> | T,
): Promise<T> {
  const paths = { ...claudeLockPaths(options), configLockDir: `${configPath}.lock` };
  return withProperLockfile(paths.configLockDir, {
    ...options,
    stalenessMs: CONFIG_STALENESS_MS,
  }, async () => {
    const held = { [configLockHandle]: true } as HeldClaudeConfigLock;
    activeConfigLockHandles.add(held);
    activeConfigLockPaths.set(held, paths);
    try {
      return await fn(held);
    } finally {
      activeConfigLockHandles.delete(held);
      activeConfigLockPaths.delete(held);
    }
  });
}

/** Hold Claude Code's global-config proper-lockfile directory for a local read-modify-write. */
export async function withClaudeConfigLock<T>(
  options: ClaudeLockOptions = {},
  fn: (held: HeldClaudeConfigLock) => Promise<T> | T,
): Promise<T> {
  const paths = claudeLockPaths(options);
  return withProperLockfile(paths.configLockDir, {
    ...options,
    stalenessMs: CONFIG_STALENESS_MS,
  }, async () => {
    const held = { [configLockHandle]: true } as HeldClaudeConfigLock;
    activeConfigLockHandles.add(held);
    activeConfigLockPaths.set(held, paths);
    try {
      return await fn(held);
    } finally {
      activeConfigLockHandles.delete(held);
      activeConfigLockPaths.delete(held);
    }
  });
}

/** A concurrent C-swap import must fail closed instead of racing Keychain/SQLite effects. */
export class CswapImportInProgress extends Error {
  constructor() {
    super('C-swap import already in progress');
    this.name = 'CswapImportInProgress';
  }
}

/**
 * A non-waiting, process-wide import lock. Unlike Claude Code's refresh locks,
 * a second importer is an operator refusal, not work that may safely queue.
 */
export async function withCswapImportLock<T>(lockDir: string, fn: () => Promise<T> | T): Promise<T> {
  await mkdir(dirname(lockDir), { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (error: unknown) {
    if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A live peer is refused immediately. A crashed peer leaves a directory,
    // which follows the same guarded stale-takeover protocol as Claude locks.
    let removed = false;
    try {
      const held = await stat(lockDir);
      if (Date.now() - held.mtimeMs > CREDENTIALS_STALENESS_MS) {
        removed = await removeIfStillStale(lockDir, CREDENTIALS_STALENESS_MS);
      }
    } catch { /* a racing release is still an in-progress refusal */ }
    if (!removed) throw new CswapImportInProgress();
    try {
      await mkdir(lockDir);
    } catch (retryError: unknown) {
      if (retryError && typeof retryError === 'object' && (retryError as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CswapImportInProgress();
      }
      throw retryError;
    }
  }
  let touchInFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (touchInFlight) return;
    touchInFlight = utimes(lockDir, new Date(), new Date()).catch(() => {
      clearInterval(timer);
    }).finally(() => { touchInFlight = undefined; });
  }, TOUCH_INTERVAL_MS);
  timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await touchInFlight;
    await bestEffortRelease(lockDir);
  }
}
