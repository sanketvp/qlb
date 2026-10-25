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
  kill(pid: number, signal: NodeJS.Signals): void | Promise<void>;
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
  /** Optional only while the K13 injection seam remains compatible with its existing fakes. */
  drain?(): CswapAgentResult | Promise<CswapAgentResult>;
}

const COOPERATIVE_WAIT_MS = 60_000;
const LOCK_WAIT_MS = 5 * 60_000;
const TERM_WAIT_MS = 10_000;
const POLL_MS = 100;

function survivorCode(processes: CswapProcess[]): string {
  return `cswap-survivor pid=${processes[0]?.pid ?? 'unknown'}`;
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
      for (const process of survivors) await options.kill(process.pid, 'SIGTERM');
      const termDeadline = options.now() + termWaitMs;
      while (survivors.length > 0 && options.now() < termDeadline) {
        await options.sleep(pollMs);
        survivors = await options.listProcesses();
      }
      return survivors.length === 0 ? { ok: true } : { ok: false, code: survivorCode(survivors) };
    } finally {
      await releaseAll(acquired);
    }
  } catch {
    // The caller compensates with restorePlist; no uncertain process may be ignored.
    return { ok: false, code: survivorCode(survivors ?? []) };
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
