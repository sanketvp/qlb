import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { listCswapProcessesAsync, listCswapProcessesToSignalAsync } from './cswap-processes';

/** K13 seam for the destructive C-swap LaunchAgent operations. */
export interface CswapAgentResult {
  ok: boolean;
  code?: string;
}

export interface CswapProcess {
  pid: number;
}

export type CswapLockRelease = (() => void | Promise<void>) & {
  /** Resolves when helper exit, close, stdin failure, or a failed confirmation loses the lease. */
  lost?: Promise<Error>;
  /** Synchronously reports any recorded lease loss, including a failed confirmation. */
  isLost?: () => Error | undefined;
  /** Round-trips to the helper; a timeout, bad reply, or write failure loses the lease and returns undefined. */
  confirmHeld?: () => Promise<number | undefined>;
  /** Reports that bounded release failed or needed SIGKILL, so release is unconfirmed. */
  releaseTimedOut?: () => Error | undefined;
};

/** Every effect used by the S57 drain is supplied by its caller. */
export interface CswapDrainOptions {
  /** Loose liveness list: governs waiting and lock acquisition. */
  listProcesses(): CswapProcess[] | Promise<CswapProcess[]>;
  /** Strict list: only these positively identified PIDs may receive SIGTERM. */
  listSignalTargets(): CswapProcess[] | Promise<CswapProcess[]>;
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
  /** Require helper inode confirmations; production must enable this. */
  requireConfirmHeld?: boolean;
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

type ReleaseFailure = { path: string; error?: Error };

async function releaseAll(locks: CswapLockRelease[], paths: string[]): Promise<ReleaseFailure | undefined> {
  let failure: ReleaseFailure | undefined;
  for (let index = locks.length - 1; index >= 0; index -= 1) {
    const release = locks[index];
    const path = paths[index] ?? 'unknown';
    try {
      await release();
    } catch (error) {
      failure ??= { path, error: error instanceof Error ? error : new Error(String(error)) };
      continue;
    }
    const timeout = release.releaseTimedOut?.();
    if (timeout !== undefined) failure ??= { path, error: timeout };
  }
  return failure;
}

type LeaseLoss = { path: string; error?: Error };

function lostLease(locks: CswapLockRelease[], paths: string[]): LeaseLoss | undefined {
  for (const [index, release] of locks.entries()) {
    const error = release.isLost?.();
    if (error !== undefined) return { path: paths[index] ?? 'unknown', error };
  }
  return undefined;
}

type LeaseCheck = { loss?: LeaseLoss; inodes: Array<number | undefined> };

/** A helper round trip plus the current pathname inode proves the lease. */
async function leaseIntact(
  acquired: CswapLockRelease[],
  paths: string[],
  requireConfirmHeld = false,
): Promise<LeaseCheck> {
  const inodes: Array<number | undefined> = [];
  for (const [index, path] of paths.entries()) {
    const release = acquired[index];
    if (release === undefined) return { loss: { path }, inodes };
    if (release.confirmHeld === undefined) {
      if (requireConfirmHeld) return { loss: { path, error: new Error('no confirmHeld') }, inodes };
      const error = release.isLost?.();
      if (error !== undefined) return { loss: { path, error }, inodes };
      inodes[index] = undefined;
      continue;
    }
    let inode: number | undefined;
    try {
      inode = await release.confirmHeld();
    } catch {
      return { loss: { path, error: release.isLost?.() }, inodes };
    }
    if (inode === undefined) return { loss: { path, error: release.isLost?.() }, inodes };
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== inode) return { loss: { path }, inodes };
    } catch {
      return { loss: { path }, inodes };
    }
    inodes[index] = inode;
  }
  // This catches loss recorded while a later helper was being pinged.
  return { loss: lostLease(acquired, paths), inodes };
}

/** The last synchronous lease and pathname proof before SIGTERM or success. */
function finalSweep(
  acquired: CswapLockRelease[],
  paths: string[],
  inodes: Array<number | undefined>,
): LeaseLoss | undefined {
  const loss = lostLease(acquired, paths);
  if (loss !== undefined) return loss;
  for (const [index, path] of paths.entries()) {
    const inode = inodes[index];
    if (inode === undefined) continue;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== inode) return { path };
    } catch {
      return { path };
    }
  }
  return undefined;
}

function leaseLostResult(lost: LeaseLoss): CswapAgentResult {
  const detail = lost.error === undefined ? '' : `: ${lost.error.message}`;
  return { ok: false, code: `cswap-drain-error lease-lost ${lost.path}${detail}` };
}

function releaseUnconfirmedResult(failure: ReleaseFailure, prior?: CswapAgentResult): CswapAgentResult {
  const detail = failure.error === undefined ? '' : `: ${failure.error.message}`;
  const after = prior?.ok === false && prior.code !== undefined ? `; after ${prior.code}` : '';
  return { ok: false, code: `cswap-drain-error lease-release-unconfirmed ${failure.path}${detail}${after}` };
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
    if (complete) {
      const lost = lostLease(locks, paths);
      if (lost !== undefined) {
        const releaseFailure = await releaseAll(locks, paths);
        return releaseFailure === undefined ? leaseLostResult(lost) : releaseUnconfirmedResult(releaseFailure);
      }
      return locks;
    }
    const releaseFailure = await releaseAll(locks, paths);
    if (releaseFailure !== undefined) return releaseUnconfirmedResult(releaseFailure);
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
    let result: CswapAgentResult;
    let releaseFailure: ReleaseFailure | undefined;
    try {
      try {
        // Steps 4–8: all completion paths take the final release below.
        survivors = await options.listProcesses();
        if (survivors.length === 0) {
          const check = await leaseIntact(acquired, paths, options.requireConfirmHeld);
          const finalLoss = check.loss ?? finalSweep(acquired, paths, check.inodes);
          result = finalLoss === undefined ? { ok: true } : leaseLostResult(finalLoss);
        } else {
          // Step 5 is a strict all-survivor preflight, before any signal.
          const preflight = new Set((await options.listSignalTargets()).map(({ pid }) => pid));
          if (survivors.some(({ pid }) => !preflight.has(pid))) {
            result = { ok: false, code: 'cswap-unidentified-survivor' };
          } else {
            const exited = new Set<number>();
            let bodyFailure: CswapAgentResult | undefined;
            for (const process of survivors) {
              const check = await leaseIntact(acquired, paths, options.requireConfirmHeld);
              if (check.loss !== undefined) { bodyFailure = leaseLostResult(check.loss); break; }
              const targetPids = new Set((await options.listSignalTargets()).map(({ pid }) => pid));
              if (!targetPids.has(process.pid)) {
                const livePids = new Set((await options.listProcesses()).map(({ pid }) => pid));
                if (livePids.has(process.pid)) { bodyFailure = { ok: false, code: 'cswap-unidentified-survivor' }; break; }
                exited.add(process.pid);
                continue;
              }
              // Give check-phase helper notifications one chance to be observed.
              await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
              // finalSweep is the last proof: do not await between it and kill.
              const finalLoss = finalSweep(acquired, paths, check.inodes);
              if (finalLoss !== undefined) { bodyFailure = leaseLostResult(finalLoss); break; }
              let killing: void | Promise<void>;
              try {
                killing = options.kill(process.pid, 'SIGTERM');
              } catch (error) {
                if (errorCode(error) === 'ESRCH') { exited.add(process.pid); continue; }
                bodyFailure = { ok: false, code: drainErrorCode(error) };
                break;
              }
              try {
                await killing;
              } catch (error) {
                if (errorCode(error) === 'ESRCH') { exited.add(process.pid); continue; }
                bodyFailure = { ok: false, code: drainErrorCode(error) };
                break;
              }
            }
            if (bodyFailure !== undefined) {
              result = bodyFailure;
            } else {
              const termDeadline = options.now() + termWaitMs;
              while (survivors.length > 0 && options.now() < termDeadline) {
                await options.sleep(pollMs);
                const check = await leaseIntact(acquired, paths, options.requireConfirmHeld);
                if (check.loss !== undefined) { bodyFailure = leaseLostResult(check.loss); break; }
                survivors = (await options.listProcesses()).filter(({ pid }) => !exited.has(pid));
              }
              if (bodyFailure !== undefined) result = bodyFailure;
              else if (survivors.length !== 0) result = { ok: false, code: survivorCode(survivors) };
              else {
                const check = await leaseIntact(acquired, paths, options.requireConfirmHeld);
                const finalLoss = check.loss ?? finalSweep(acquired, paths, check.inodes);
                result = finalLoss === undefined ? { ok: true } : leaseLostResult(finalLoss);
              }
            }
          }
        }
      } catch (error) {
        result = { ok: false, code: drainErrorCode(error) };
      }
    } finally {
      releaseFailure = await releaseAll(acquired, paths);
    }
    return releaseFailure === undefined ? result! : releaseUnconfirmedResult(releaseFailure, result);
  } catch (error) {
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
  /** Defaults to the reviewed A14 loose liveness classifier; tests inject a hermetic seam. */
  listProcesses?(): CswapProcess[] | Promise<CswapProcess[]>;
  /** Defaults to the strict signal-target classifier; tests inject a hermetic seam. */
  listSignalTargets?(): CswapProcess[] | Promise<CswapProcess[]>;
  /** A non-blocking fcntl flock compatible with C-swap's flock locks. */
  tryAcquireLock(path: string): CswapLockRelease | null | Promise<CswapLockRelease | null>;
  kill(pid: number, signal: 'SIGTERM'): void | Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Production requires a helper confirmation for every held lock. */
  requireConfirmHeld?: boolean;
}

export const CSWAP_AGENT_LABEL = 'com.cswap.auto';
const CSWAP_PLIST = `${CSWAP_AGENT_LABEL}.plist`;

export type CswapAgentStatus = 'loaded' | 'not-loaded' | 'unknown';

export interface CswapAgentStatusDependencies {
  /** `launchctl print` is an inspection only; callers inject this in tests. */
  exec(file: string, args: readonly string[]): string | void;
  uid(): number;
}

function missingAgent(error: unknown): boolean {
  const code = errorCode(error);
  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : undefined;
  const message = error instanceof Error ? error.message : '';
  return code === 'ESRCH' || status === 113 || /(?:not found|could not find service|no such process)/i.test(message);
}

/**
 * Read the C-swap LaunchAgent state without changing it. Unknown command
 * failures remain distinct from an unloaded service so doctor can warn rather
 * than claim the hand-off is safe.
 */
export function inspectCswapAgent(
  deps: CswapAgentStatusDependencies,
): CswapAgentStatus {
  try {
    deps.exec('/bin/launchctl', ['print', `gui/${deps.uid()}/${CSWAP_AGENT_LABEL}`]);
    return 'loaded';
  } catch (error) {
    return missingAgent(error) ? 'not-loaded' : 'unknown';
  }
}

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
    bootout: () => operation(deps, ['bootout', `${domain()}/${CSWAP_AGENT_LABEL}`], true),
    disable: () => operation(deps, ['disable', `${domain()}/${CSWAP_AGENT_LABEL}`], true),
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
          return { ok: false, code: 'cswap-plist-missing' };
        }
      } catch (error) {
        return { ok: false, code: commandErrorCode(error) };
      }
      const enable = operation(deps, ['enable', `${domain()}/${CSWAP_AGENT_LABEL}`], true);
      if (!enable.ok) return enable;
      // bootstrap reports an opaque EIO when an already-loaded job is supplied.
      // Ask launchd directly instead of interpreting its error text.
      if (inspectCswapAgent(deps) === 'loaded') return { ok: true };
      try {
        deps.exec('/bin/launchctl', ['bootstrap', domain(), source]);
        return { ok: true };
      } catch (error) {
        return inspectCswapAgent(deps) === 'loaded'
          ? { ok: true }
          : { ok: false, code: commandErrorCode(error) };
      }
    },
    drain: async () => cooperativeDrain({
      listProcesses: () => deps.listProcesses ? deps.listProcesses() : listCswapProcessesAsync(),
      listSignalTargets: () => deps.listSignalTargets ? deps.listSignalTargets() : listCswapProcessesToSignalAsync(),
      lockPaths: () => sequenceLockPaths(deps),
      tryAcquireLock: (path) => deps.tryAcquireLock(path),
      kill: (pid, signal) => deps.kill(pid, signal),
      now: () => deps.now(),
      sleep: (ms) => deps.sleep(ms),
      requireConfirmHeld: deps.requireConfirmHeld,
    }),
  };
}

export const FLOCK_HELPER = [
  'import fcntl, os, sys',
  'fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)',
  'try:',
  '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  'except BlockingIOError:',
  '    print("busy", flush=True)',
  '    sys.exit(0)',
  'print("locked", flush=True)',
  'while True:',
  '    command = sys.stdin.buffer.readline()',
  '    if not command: break',
  '    parts = command.split()',
  '    if len(parts) == 2 and parts[0] == b"p" and parts[1].isdigit():',
  '        print(f"held {parts[1].decode()} {os.fstat(fd).st_ino}", flush=True)',
  'fcntl.flock(fd, fcntl.LOCK_UN)',
  'os.close(fd)',
].join('\n');

export type FlockHelperSpawner = (lockPath: string, lockDirectory: string) => ChildProcess;

function spawnFlockHelper(lockPath: string, lockDirectory: string): ChildProcess {
  return spawn('/usr/bin/python3', ['-I', '-c', FLOCK_HELPER, lockPath], {
    cwd: lockDirectory,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

/** Keeps a real fcntl flock in a tiny helper process until its release seam. */
export function productionTryAcquireLock(path: string, startHelper: FlockHelperSpawner = spawnFlockHelper): Promise<CswapLockRelease | null> {
  const lockPath = resolve(path);
  const lockDirectory = dirname(lockPath);
  return new Promise((resolveLock, rejectLock) => {
    const child = startHelper(lockPath, lockDirectory);
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (stdout === null || stdin === null) {
      child.kill();
      rejectLock(new Error('fcntl flock helper must use piped stdin and stdout'));
      return;
    }
    let state: 'pending' | 'locked' | 'busy' = 'pending';
    let response = '';
    let releaseRequested = false;
    let pendingExit: Error | undefined;
    let released: Promise<void> | undefined;
    let releaseTimeoutError: Error | undefined;
    let lostError: Error | undefined;
    let resolveConfirmation: { sequence: number; resolve(line: string | undefined): void } | undefined;
    let confirmationSequence = 0;
    let confirmationQueue: Promise<void> = Promise.resolve();
    let notifyLost: (error: Error) => void = () => {};
    const lost = new Promise<Error>((resolveLoss) => { notifyLost = resolveLoss; });
    const markLost = (error: Error): void => {
      if (lostError !== undefined) return;
      lostError = error;
      notifyLost(error);
    };
    const completeConfirmation = (line: string | undefined, sequence?: number): void => {
      const pending = resolveConfirmation;
      if (pending === undefined || (sequence !== undefined && pending.sequence !== sequence)) return;
      resolveConfirmation = undefined;
      pending.resolve(line);
    };
    const failConfirmation = (error: Error): void => {
      markLost(error);
      completeConfirmation(undefined);
    };
    // Attach this before any write: a dead helper emits EPIPE on stdin itself.
    stdin.on('error', (error) => {
      if (state === 'locked') failConfirmation(new Error(`fcntl flock helper stdin failed (${error.message})`));
      else completeConfirmation(undefined);
    });
    const confirmHeldOnce = (): Promise<number | undefined> => {
      if (state !== 'locked' || lostError !== undefined) return Promise.resolve(undefined);
      if (child.exitCode !== null || child.signalCode !== null) {
        markLost(unexpectedExit(child.exitCode, child.signalCode));
        return Promise.resolve(undefined);
      }
      return new Promise((resolveConfirmationResult) => {
        const sequence = ++confirmationSequence;
        let settled = false;
        const finish = (line: string | undefined): void => {
          if (settled) return;
          settled = true;
          if (resolveConfirmation?.resolve === finish) resolveConfirmation = undefined;
          clearTimeout(timeout);
          const match = /^held [0-9]+ ([0-9]+)$/.exec(line ?? '');
          const inode = match === null ? undefined : Number(match[1]);
          if (inode === undefined || !Number.isSafeInteger(inode) || inode < 0) {
            failConfirmation(new Error('fcntl flock helper confirmation failed'));
            resolveConfirmationResult(undefined);
            return;
          }
          resolveConfirmationResult(inode);
        };
        const timeout = setTimeout(() => {
          if (resolveConfirmation?.resolve === finish) resolveConfirmation = undefined;
          markLost(new Error('fcntl flock helper confirmation timed out'));
          finish(undefined);
        }, 2_000);
        resolveConfirmation = { sequence, resolve: finish };
        try {
          if (stdin.destroyed || !stdin.writable) {
            failConfirmation(new Error('fcntl flock helper stdin is unavailable'));
          } else {
            stdin.write(`p ${sequence}\n`, (error) => {
              if (error !== undefined && error !== null) failConfirmation(new Error(`fcntl flock helper stdin failed (${error.message})`));
            });
          }
        } catch (error) {
          failConfirmation(new Error(`fcntl flock helper stdin failed (${error instanceof Error ? error.message : String(error)})`));
        }
      });
    };
    const confirmHeld = (): Promise<number | undefined> => {
      const confirmation = confirmationQueue.then(confirmHeldOnce, confirmHeldOnce);
      confirmationQueue = confirmation.then(() => undefined, () => undefined);
      return confirmation;
    };
    const unexpectedExit = (code: number | null, signal: NodeJS.Signals | null): Error =>
      new Error(`fcntl flock helper exited unexpectedly (${code ?? signal ?? 'unknown'})`);
    const closed = new Promise<void>((resolveClose, rejectClose) => {
      child.once('error', (error) => {
        if (state === 'locked') markLost(new Error(`fcntl flock helper exited unexpectedly (${error.message})`));
        completeConfirmation(undefined);
        rejectClose(error);
      });
      child.once('exit', (code, signal) => {
        const error = unexpectedExit(code, signal);
        if (state === 'pending') pendingExit = error;
        else if (state === 'locked' && !releaseRequested) markLost(error);
        completeConfirmation(undefined);
      });
      child.once('close', (code, signal) => {
        completeConfirmation(undefined);
        if (state === 'locked') {
          if (!releaseRequested) markLost(unexpectedExit(code, signal));
          resolveClose();
        } else if (state === 'busy' || code === 0) {
          resolveClose();
        } else {
          rejectClose(new Error('fcntl flock helper failed'));
        }
      });
    });
    stdout.on('data', (chunk: Buffer) => {
      response += String(chunk);
      for (;;) {
        const newline = response.indexOf('\n');
        if (newline === -1) return;
        const line = response.slice(0, newline);
        response = response.slice(newline + 1);
        if (state === 'locked') {
          const held = /^held ([0-9]+) ([0-9]+)$/.exec(line);
          if (held !== null) completeConfirmation(line, Number(held[1]));
          else if (resolveConfirmation !== undefined) failConfirmation(new Error('fcntl flock helper confirmation failed'));
          continue;
        }
        if (state !== 'pending') continue;
        if (line === 'busy') {
          state = 'busy';
          continue;
        }
        if (line !== 'locked') continue;
        const exited = pendingExit
          ?? (child.exitCode !== null || child.signalCode !== null
            ? unexpectedExit(child.exitCode, child.signalCode)
            : undefined);
        if (exited !== undefined) {
          rejectLock(exited);
          return;
        }
        state = 'locked';
        const waitForClose = (timeoutMs: number): Promise<boolean> => new Promise((resolveWait) => {
          let settled = false;
          const finish = (closedBeforeTimeout: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolveWait(closedBeforeTimeout);
          };
          const timeout = setTimeout(() => finish(false), timeoutMs);
          void closed.then(() => finish(true), () => finish(true));
        });
        const release = Object.assign(() => {
          if (!released) {
            const exited = child.exitCode !== null || child.signalCode !== null;
            if (exited && !releaseRequested) markLost(unexpectedExit(child.exitCode, child.signalCode));
            releaseRequested = true;
            if (exited) released = Promise.resolve();
            else {
              released = (async () => {
                try {
                  stdin.end();
                } catch {
                  releaseTimeoutError = new Error('fcntl flock helper release failed');
                  try { child.kill('SIGKILL'); } catch { /* child may have exited while ending stdin */ }
                  await waitForClose(1_000);
                  return;
                }
                if (await waitForClose(2_000)) return;
                releaseTimeoutError = new Error('fcntl flock helper release timed out');
                try { child.kill('SIGKILL'); } catch { /* child may have exited while timing out */ }
                await waitForClose(1_000);
              })();
            }
          }
          return released;
        }, { lost, isLost: () => lostError, confirmHeld, releaseTimedOut: () => releaseTimeoutError });
        resolveLock(release);
      }
    });
    closed.then(() => {
      if (state === 'busy') resolveLock(null);
      else if (state === 'pending') rejectLock(new Error('fcntl flock helper failed'));
    }, (error) => {
      if (state !== 'locked') rejectLock(error);
    });
  });
}

/** The live adapter's platform calls remain behind the factory seams above. */
export function productionLaunchctlCswapAgent(
  home: string,
  qlbHome: string,
  cswapSequencePath?: string,
  makeAgent: (deps: LaunchctlCswapAgentDependencies) => CswapAgent = launchctlCswapAgent,
): CswapAgent {
  const sequencePath = cswapSequencePath ?? join(home, '.claude-swap-backup', 'sequence.json');
  return makeAgent({
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
    listProcesses: listCswapProcessesAsync,
    listSignalTargets: listCswapProcessesToSignalAsync,
    requireConfirmHeld: true,
    tryAcquireLock: productionTryAcquireLock,
    kill: (pid, signal) => { process.kill(pid, signal); },
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
