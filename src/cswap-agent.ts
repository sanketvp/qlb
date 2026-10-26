/**
 * K13 seam for the destructive C-swap LaunchAgent operations. No production
 * effect is implemented here: callers must inject every external operation.
 */
export interface CswapAgentResult {
  ok: boolean;
  code?: string;
}

export interface CswapProcess {
  pid: number;
}

export type CswapLockRelease = () => void | Promise<void>;

/** Every effect used by the S57 drain is supplied by its caller. */
export interface CswapDrainOptions {
  listProcesses(): CswapProcess[] | Promise<CswapProcess[]>;
  lockPaths(): string[] | Promise<string[]>;
  tryAcquireLock(path: string): CswapLockRelease | null | Promise<CswapLockRelease | null>;
  /** Sends only SIGTERM; ESRCH means the target already exited. */
  kill(pid: number, signal: 'SIGTERM'): void | Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  cooperativeWaitMs?: number;
  lockWaitMs?: number;
  termWaitMs?: number;
  pollMs?: number;
}

export interface CswapAgent {
  bootout(): CswapAgentResult | Promise<CswapAgentResult>;
  disable(): CswapAgentResult | Promise<CswapAgentResult>;
  movePlist(): CswapAgentResult | Promise<CswapAgentResult>;
  restorePlist(): CswapAgentResult | Promise<CswapAgentResult>;
  /** S57 drain required before cutover can complete. */
  drain(): CswapAgentResult | Promise<CswapAgentResult>;
}

const COOPERATIVE_WAIT_MS = 60_000;
const LOCK_WAIT_MS = 5 * 60_000;
const TERM_WAIT_MS = 10_000;
const POLL_MS = 100;

function survivorCode(processes: CswapProcess[]): string {
  const pids = processes.map(({ pid }) => pid).join(' ');
  return `cswap-survivor ${pids || 'unknown'}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error == null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function drainErrorCode(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return `cswap-drain-error ${code ? `${code}: ` : ''}${message}`;
}

async function releaseAll(locks: CswapLockRelease[]): Promise<void> {
  for (const release of locks.reverse()) {
    try { await release(); } catch { /* releasing a lock must not hide a refusal */ }
  }
}

async function acquireAllLocks(options: CswapDrainOptions, paths: string[], deadline: number, survivor: CswapProcess[]): Promise<CswapLockRelease[] | CswapAgentResult> {
  const pollMs = options.pollMs ?? POLL_MS;
  for (;;) {
    const locks: CswapLockRelease[] = [];
    let complete = true;
    try {
      for (const path of paths) {
        const release = await options.tryAcquireLock(path);
        if (release == null) { complete = false; break; }
        locks.push(release);
      }
    } catch {
      complete = false;
    }
    if (complete) return locks;
    await releaseAll(locks);
    if (options.now() >= deadline) return { ok: false, code: survivorCode(survivor) };
    await options.sleep(pollMs);
  }
}

/**
 * S57 cooperative drain. It observes first and never signals while a C-swap
 * lock is held. Once every C-swap lock is held, SIGTERM is the sole signal.
 */
export async function cooperativeDrain(options: CswapDrainOptions): Promise<CswapAgentResult> {
  const cooperativeWaitMs = options.cooperativeWaitMs ?? COOPERATIVE_WAIT_MS;
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  const termWaitMs = options.termWaitMs ?? TERM_WAIT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  let survivors: CswapProcess[] = [];
  try {
    survivors = await options.listProcesses();
    const cooperativeDeadline = options.now() + cooperativeWaitMs;
    while (survivors.length > 0 && options.now() < cooperativeDeadline) {
      await options.sleep(pollMs);
      survivors = await options.listProcesses();
    }
    if (survivors.length === 0) return { ok: true };

    const paths = await options.lockPaths();
    if (paths.length === 0) return { ok: false, code: survivorCode(survivors) };
    const acquired = await acquireAllLocks(options, paths, options.now() + lockWaitMs, survivors);
    if (!Array.isArray(acquired)) return acquired;
    try {
      // Re-read under every lock so we never signal a process that already left.
      survivors = await options.listProcesses();
      if (survivors.length === 0) return { ok: true };
      const exited = new Set<number>();
      for (const process of survivors) {
        try {
          await options.kill(process.pid, 'SIGTERM');
        } catch (error) {
          if (errorCode(error) === 'ESRCH') {
            exited.add(process.pid);
            continue;
          }
          return { ok: false, code: drainErrorCode(error) };
        }
      }
      const termDeadline = options.now() + termWaitMs;
      while (survivors.length > 0 && options.now() < termDeadline) {
        await options.sleep(pollMs);
        survivors = (await options.listProcesses()).filter(({ pid }) => !exited.has(pid));
      }
      return survivors.length === 0 ? { ok: true } : { ok: false, code: survivorCode(survivors) };
    } finally {
      await releaseAll(acquired);
    }
  } catch (error) {
    // The caller compensates with restorePlist; no uncertain process may be ignored.
    return { ok: false, code: drainErrorCode(error) };
  }
}

const unavailable = (): CswapAgentResult => ({ ok: false, code: 'cswap-agent-not-yet-available' });

export const unavailableCswapAgent: CswapAgent = {
  bootout: unavailable,
  disable: unavailable,
  movePlist: unavailable,
  restorePlist: unavailable,
  drain: unavailable,
};
