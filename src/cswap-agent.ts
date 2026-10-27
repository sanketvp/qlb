import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { listCswapProcesses } from './cswap-processes';

/** K13 seam for the destructive C-swap LaunchAgent operations. */
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

/**
 * The retirement S57 sequence. The agent owns platform effects; this runner
 * fixes their required order and does not continue after an uncertain step.
 */
export async function runRetirementDrain(agent: CswapAgent): Promise<CswapAgentResult> {
  for (const operation of [agent.bootout, agent.disable, agent.movePlist]) {
    const result = await operation.call(agent);
    if (!result.ok) return result;
  }
  return agent.drain();
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

export interface LaunchctlCswapAgentFs {
  exists(path: string): boolean;
  mkdir(path: string): void;
  readFile(path: string): string;
  rename(from: string, to: string): void;
}

export interface LaunchctlCswapAgentDependencies {
  /** All commands are passed as file plus argv; never through a shell. */
  exec(file: string, args: readonly string[]): string | void;
  fs: LaunchctlCswapAgentFs;
  uid(): number;
  home(): string;
  qlbHome(): string;
  /** C-swap's configured sequence.json; its parent owns all C-swap locks. */
  cswapSequencePath?(): string;
  /** Defaults to the reviewed A14 classifier; tests inject a hermetic seam. */
  listProcesses?(): CswapProcess[] | Promise<CswapProcess[]>;
  /** A non-blocking fcntl flock compatible with C-swap's flock locks. */
  tryAcquireLock(path: string): CswapLockRelease | null | Promise<CswapLockRelease | null>;
  kill(pid: number, signal: 'SIGTERM'): void | Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const CSWAP_LABEL = 'com.cswap.auto';
const CSWAP_PLIST = `${CSWAP_LABEL}.plist`;

function commandErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code ? `cswap-agent-error ${code}` : 'cswap-agent-error';
}

function alreadyInactive(error: unknown): boolean {
  if (errorCode(error) === 'ESRCH') return true;
  const message = error instanceof Error ? error.message : '';
  return /(?:not found|no such process|could not find service|already disabled)/i.test(message);
}

function operation(
  deps: LaunchctlCswapAgentDependencies,
  args: string[],
  idempotent = false,
): CswapAgentResult {
  try {
    deps.exec('/bin/launchctl', args);
    return { ok: true };
  } catch (error) {
    return idempotent && alreadyInactive(error) ? { ok: true } : { ok: false, code: commandErrorCode(error) };
  }
}

function sequenceLockPaths(deps: LaunchctlCswapAgentDependencies): string[] {
  const sequencePath = deps.cswapSequencePath?.() ?? join(deps.home(), '.claude-swap-backup', 'sequence.json');
  const backup = dirname(sequencePath);
  const parsed = JSON.parse(deps.fs.readFile(sequencePath)) as { sequence?: unknown };
  if (!Array.isArray(parsed.sequence) || !parsed.sequence.every((value) => typeof value === 'number' || typeof value === 'string')) {
    throw new Error('C-swap account registry is unreadable');
  }
  return [
    join(backup, '.lock'),
    ...parsed.sequence.map((number) => join(backup, 'credentials', `.consume-${number}.lock`)),
  ];
}

/**
 * Real S57 adapter. Every process, filesystem, uid, clock, and flock effect
 * is a constructor seam so tests can exercise its exact argv without touching
 * a host LaunchAgent, process, or Keychain-adjacent C-swap directory.
 */
export function launchctlCswapAgent(deps: LaunchctlCswapAgentDependencies): CswapAgent {
  const domain = () => `gui/${deps.uid()}`;
  const plist = () => join(deps.home(), 'Library', 'LaunchAgents', CSWAP_PLIST);
  const backup = () => join(deps.qlbHome(), '.qlb', 'backups', 'cswap-plist', CSWAP_PLIST);
  return {
    bootout: () => operation(deps, ['bootout', `${domain()}/${CSWAP_LABEL}`], true),
    disable: () => operation(deps, ['disable', `${domain()}/${CSWAP_LABEL}`], true),
    movePlist: () => {
      const source = plist();
      const target = backup();
      try {
        if (!deps.fs.exists(source)) return { ok: true };
        deps.fs.mkdir(join(deps.qlbHome(), '.qlb', 'backups', 'cswap-plist'));
        deps.fs.rename(source, target);
        return { ok: true };
      } catch (error) {
        return { ok: false, code: commandErrorCode(error) };
      }
    },
    restorePlist: () => {
      const source = plist();
      const target = backup();
      try {
        if (deps.fs.exists(target)) {
          deps.fs.mkdir(join(deps.home(), 'Library', 'LaunchAgents'));
          deps.fs.rename(target, source);
        } else if (!deps.fs.exists(source)) {
          return { ok: false, code: 'cswap-plist-unavailable' };
        }
      } catch (error) {
        return { ok: false, code: commandErrorCode(error) };
      }
      const enable = operation(deps, ['enable', `${domain()}/${CSWAP_LABEL}`], true);
      if (!enable.ok) return enable;
      return operation(deps, ['bootstrap', domain(), source]);
    },
    drain: async () => cooperativeDrain({
      listProcesses: () => deps.listProcesses ? deps.listProcesses() : listCswapProcesses(),
      lockPaths: () => sequenceLockPaths(deps),
      tryAcquireLock: (path) => deps.tryAcquireLock(path),
      kill: (pid, signal) => deps.kill(pid, signal),
      now: () => deps.now(),
      sleep: (ms) => deps.sleep(ms),
    }),
  };
}

const FLOCK_HELPER = [
  'import fcntl, os, sys',
  'fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)',
  'try:',
  '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  'except BlockingIOError:',
  '    print("busy", flush=True)',
  '    sys.exit(0)',
  'print("locked", flush=True)',
  'sys.stdin.buffer.read(1)',
  'fcntl.flock(fd, fcntl.LOCK_UN)',
  'os.close(fd)',
].join('\n');

/** Keeps a real fcntl flock in a tiny helper process until its release seam. */
function productionTryAcquireLock(path: string): Promise<CswapLockRelease | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-c', FLOCK_HELPER, path], { stdio: ['pipe', 'pipe', 'ignore'] });
    let state: 'pending' | 'locked' | 'busy' = 'pending';
    let released: Promise<void> | undefined;
    const closed = new Promise<void>((resolveClose, rejectClose) => {
      child.once('error', rejectClose);
      child.once('close', (code) => code === 0 ? resolveClose() : rejectClose(new Error('fcntl flock helper failed')));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      const line = String(chunk).trim();
      if (state !== 'pending') return;
      if (line === 'busy') state = 'busy';
      else if (line === 'locked') {
        state = 'locked';
        resolve(() => {
          if (!released) {
            child.stdin.end();
            released = closed;
          }
          return released;
        });
      }
    });
    closed.then(() => {
      if (state === 'busy') resolve(null);
      else if (state === 'pending') reject(new Error('fcntl flock helper failed'));
    }, (error) => {
      if (state !== 'locked') reject(error);
    });
  });
}

/** The live adapter's platform calls remain behind the factory seams above. */
export function productionLaunchctlCswapAgent(home: string, qlbHome: string, cswapSequencePath?: string): CswapAgent {
  const sequencePath = cswapSequencePath ?? join(home, '.claude-swap-backup', 'sequence.json');
  return launchctlCswapAgent({
    exec: (file, args) => String(execFileSync(file, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })),
    fs: {
      exists: existsSync,
      mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
      readFile: (path) => readFileSync(path, 'utf8'),
      rename: renameSync,
    },
    uid: () => process.getuid?.() ?? 0,
    home: () => home,
    qlbHome: () => qlbHome,
    cswapSequencePath: () => sequencePath,
    listProcesses: listCswapProcesses,
    tryAcquireLock: productionTryAcquireLock,
    kill: (pid, signal) => { process.kill(pid, signal); },
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
