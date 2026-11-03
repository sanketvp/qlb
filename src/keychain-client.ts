import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { qlbHomeDir } from './home';

/**
 * The only production Keychain CLI accepted by this leaf.
 *
 * macOS lockf owns the advisory flock itself and waits for its client; the
 * client does not inherit that lock.  Thus it lives for as long as lockf runs.
 * QLB must never signal lockf (nor a wrapper that could still be waiting for
 * it); callers may abandon only the detached outer wrapper.
 */
export const KEYCHAIN_SECURITY_BIN = '/usr/bin/security';
export const KEYCHAIN_LOCKF_BIN = '/usr/bin/lockf';
export const KEYCHAIN_SECURITY_SUBCOMMANDS = [
  'add-generic-password',
  'find-generic-password',
  'delete-generic-password',
  'dump-keychain',
] as const;
export const KEYCHAIN_HELPER_SYNC_SUBCOMMANDS = ['probe-read', 'delete'] as const;

export type KeychainKind = 'security' | 'helper';
export type KeychainEncoding = 'utf8' | 'buffer';

/** Options deliberately do not extend Node's ExecFileSyncOptions. */
export interface KeychainExecOptions {
  readonly keychainKind: KeychainKind;
  readonly timeout: number;
  readonly maxBuffer?: number;
  readonly encoding?: KeychainEncoding;
}

/** One executor contract for the backend, fakes, buffer reader, and adapter. */
export type KeychainExecFn = <T extends KeychainEncoding = 'utf8'>(
  file: string,
  args: readonly string[],
  options: KeychainExecOptions & { readonly encoding?: T },
) => T extends 'buffer' ? Buffer : string;

export interface KeychainItem {
  service: string;
  account: string;
}

export interface KeychainRequest {
  kind: KeychainKind;
  file: string;
  /** Never contains -X; its value is held only in secretHex. */
  args: string[];
  secretHex?: string;
  item: KeychainItem;
  timeoutMs: number;
  encoding: KeychainEncoding;
  maxBuffer?: number;
  /** Test-only seam.  Production always uses /usr/bin/lockf. */
  lockfPath?: string;
}

export interface KeychainLock {
  readonly lockPath: string;
  /**
   * S4 must spawn this detached outer shell, never lockf directly.  Append
   * mode, deadline, helper path and helper args to outerArgsPrefix.  S4 must
   * never child.kill anything that could be lockf.
   */
  readonly outerFile: '/bin/sh';
  readonly outerArgsPrefix: readonly string[];
}

const LOCK_DIR = 'keychain-locks';
const STARTED_SENTINEL = 'qlb-keychain-client-started\n';
const DEADLINE_MARKER = 'qlb-keychain-wait: deadline-expired';

/** Registry-only key: a wait for one service blocks every account on it. */
export function keychainWaitKey(service: string): string {
  return service;
}

function lockDir(): string {
  return join(qlbHomeDir(process.env), '.qlb', LOCK_DIR);
}

function lockPathForService(service: string): string {
  return join(lockDir(), `${createHash('sha256').update(keychainWaitKey(service)).digest('hex')}.lock`);
}

function lockDirectory(): string {
  const dir = lockDir();
  // This never changes an existing directory's mode.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  const uid = process.getuid?.();
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw new KeychainClientDisabledInTests();
  }
  // mkdir mode 0700 is sufficient under a normal umask; never chmod a
  // pre-existing directory.  Refuse a mode that cannot protect the locks.
  if ((lstatSync(dir).mode & 0o777) !== 0o700) throw new KeychainClientDisabledInTests();
  return dir;
}

function ensureLockFile(service: string): string {
  lockDirectory();
  const path = lockPathForService(service);
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch { throw new KeychainClientDisabledInTests(); }
  closeSync(fd);
  return path;
}

/**
 * S4 uses this to put its helper under exactly the same per-service kernel
 * lock.  The lock file is permanent; only the advisory lock is transient.
 */
export function keychainLockForService(service: string): KeychainLock {
  const lockPath = ensureLockFile(service);
  return {
    lockPath,
    outerFile: '/bin/sh',
    outerArgsPrefix: ['-c', KEYCHAIN_WAIT_SCRIPT, 'qlb-keychain-wait', KEYCHAIN_LOCKF_BIN, lockPath],
  };
}

export class KeychainRequestStillWaiting extends Error {
  readonly code = 'ETIMEDOUT';
  readonly reason = 'still-waiting';

  constructor(service: string) {
    super(`a Keychain request for ${service} is still waiting for an answer`);
    this.name = 'KeychainRequestStillWaiting';
  }
}

/** A request was rejected before a Keychain client was allowed to run. */
export class KeychainClientNotStarted extends Error {
  readonly code = 'EQLBKEYCHAINNOTSTARTED';
  readonly reason = 'not-started';

  constructor(service: string, detail: string) {
    super(`Keychain request for ${service} was not started: ${detail}`);
    this.name = 'KeychainClientNotStarted';
  }
}

export class KeychainClientDisabledInTests extends Error {
  readonly code = 'EQLBKEYCHAINDISABLED';
  readonly reason = 'disabled-in-tests';

  constructor() {
    super('Keychain client execution is disabled while QLB_TEST_MODE=1');
    this.name = 'KeychainClientDisabledInTests';
  }
}

function causedBy(err: unknown, reason: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ((current as { reason?: unknown }).reason === reason) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isKeychainStillWaiting(err: unknown): boolean {
  return causedBy(err, 'still-waiting');
}

export function isKeychainClientNotStarted(err: unknown): boolean {
  return causedBy(err, 'not-started');
}

function itemFromSecurity(args: readonly string[]): KeychainItem {
  const serviceIndex = args.indexOf('-s');
  const accountIndex = args.indexOf('-a');
  const command = args[0] ?? 'unknown';
  return {
    service: serviceIndex >= 0 && typeof args[serviceIndex + 1] === 'string' ? args[serviceIndex + 1] : `cmd:${command}`,
    account: accountIndex >= 0 && typeof args[accountIndex + 1] === 'string' ? args[accountIndex + 1] : '',
  };
}

function notStartedForArgs(args: readonly string[], detail: string): KeychainClientNotStarted {
  return new KeychainClientNotStarted(itemFromSecurity(args).service, detail);
}

function parseSecurityWrite(args: readonly string[]): { args: string[]; secretHex: string; item: KeychainItem } {
  const out = [args[0]];
  let secretHex: string | undefined;
  let service = `cmd:${args[0] ?? 'unknown'}`;
  let account = '';
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === '-U') { out.push(token); continue; }
    if (token !== '-a' && token !== '-s' && token !== '-T' && token !== '-X') {
      throw notStartedForArgs(args, 'unsupported Keychain write arguments');
    }
    const value = args[index + 1];
    if (value === undefined) throw notStartedForArgs(args, 'unsupported Keychain write arguments');
    index += 1;
    if (token === '-X') {
      if (secretHex !== undefined || !/^(?:[0-9a-f]{2})*$/.test(value)) {
        throw notStartedForArgs(args, 'unsupported Keychain write arguments');
      }
      secretHex = value;
      continue;
    }
    out.push(token, value);
    if (token === '-s') service = value;
    if (token === '-a') account = value;
  }
  if (secretHex === undefined) throw notStartedForArgs(args, 'unsupported Keychain write arguments');
  return { args: out, secretHex, item: { service, account } };
}

export function keychainRequestFromArgv(
  kind: KeychainKind,
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number; encoding?: KeychainEncoding; maxBuffer?: number; lockfPath?: string },
): KeychainRequest {
  const command = args[0];
  if (!command || !Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw notStartedForArgs(args, 'unsupported Keychain command');
  }
  if (kind === 'security') {
    if (!(KEYCHAIN_SECURITY_SUBCOMMANDS as readonly string[]).includes(command)) {
      throw notStartedForArgs(args, 'unsupported Keychain command');
    }
    if (command === 'add-generic-password') {
      const parsed = parseSecurityWrite(args);
      return { kind, file, args: parsed.args, secretHex: parsed.secretHex, item: parsed.item, timeoutMs: opts.timeoutMs, encoding: opts.encoding ?? 'utf8', maxBuffer: opts.maxBuffer, lockfPath: opts.lockfPath };
    }
    if (args.some((arg) => arg === '-X' || (arg.startsWith('-') && arg.slice(1).includes('X')))) {
      throw notStartedForArgs(args, 'unsupported Keychain write arguments');
    }
    return { kind, file, args: [...args], item: itemFromSecurity(args), timeoutMs: opts.timeoutMs, encoding: opts.encoding ?? 'utf8', maxBuffer: opts.maxBuffer, lockfPath: opts.lockfPath };
  }
  if (!['delete', 'probe-read', 'set'].includes(command) || args.length !== 3 || args.some((arg) => arg === '-X' || (arg.startsWith('-') && arg.slice(1).includes('X')))) {
    throw new KeychainClientNotStarted('unknown', 'unsupported Keychain command');
  }
  return { kind, file, args: [...args], item: { service: args[args.length - 2], account: args[args.length - 1] }, timeoutMs: opts.timeoutMs, encoding: opts.encoding ?? 'utf8', maxBuffer: opts.maxBuffer, lockfPath: opts.lockfPath };
}

function isUnderTmp(candidate: string): boolean {
  try {
    const root = realpathSync(tmpdir());
    if (root === '/') return false;
    const rel = relative(root, realpathSync(candidate));
    return rel === '' || (rel !== '..' && !rel.startsWith('../'));
  } catch { return false; }
}

function clientAllowed(file: string, kind: KeychainKind): boolean {
  if (process.env.QLB_TEST_MODE !== '1') {
    return kind === 'security' ? file === KEYCHAIN_SECURITY_BIN : isAbsolute(file);
  }
  try {
    const candidate = realpathSync(file);
    // These denials are independent of TMPDIR and prevent a test from ever
    // reaching the real Keychain clients.
    if (file === KEYCHAIN_SECURITY_BIN || candidate === KEYCHAIN_SECURITY_BIN || basename(candidate) === 'qlb-keychain-helper') return false;
  } catch { return false; }
  return isUnderTmp(file);
}

function lockfAllowed(path: string): boolean {
  if (process.env.QLB_TEST_MODE !== '1') return path === KEYCHAIN_LOCKF_BIN;
  return path === KEYCHAIN_LOCKF_BIN || isUnderTmp(path);
}

/**
 * Node kills only this outer shell on a timeout.  It waits for a background
 * lockf process rather than execing it itself, so killing the outer shell does
 * not release lockf's lock or signal lockf's Keychain-client child.
 */
export const KEYCHAIN_WAIT_SCRIPT = `umask 077
trap '' PIPE
exec 4<&0 0</dev/null
lockf=$1; lock=$2; mode=$3; deadline=$4; shift 4
(
  # Ignore a shell's job-control HUP if QLB dies while this background lockf
  # process is still waiting for its client.
  trap '' HUP
  exec "$lockf" -k -t 0 "$lock" /bin/sh -c '
    trap "" PIPE
    mode=$1; deadline=$2; shift 2
    before_deadline() {
      now=$(date +%s%3N 2>/dev/null || true)
      case "$now" in
        ""|*[!0-9]*) now=$(/usr/bin/perl -MTime::HiRes=time -e "printf qq(%.0f), time*1000" 2>/dev/null || true);;
      esac
      case "$now" in
        ""|*[!0-9]*) [ "$(date +%s)" -lt $((deadline / 1000 - 1)) ];;
        *) [ "$now" -lt "$deadline" ];;
      esac
    }
    before_deadline || { echo "qlb-keychain-wait: deadline-expired" >&2; exit 125; }
    printf "qlb-keychain-client-started\\n" >&3
    exec 3>&-
    if [ "$mode" = w ]; then
      IFS= read -r hex || { echo "qlb-keychain-wait: no-secret" >&2; exit 125; }
      before_deadline || { echo "qlb-keychain-wait: deadline-expired" >&2; exit 125; }
      exec 0</dev/null
      exec "$@" -X "$hex"
    fi
    before_deadline || { echo "qlb-keychain-wait: deadline-expired" >&2; exit 125; }
    exec 0</dev/null
    exec "$@"
  ' qlb-keychain-inner "$mode" "$deadline" "$@" 0<&4
) &
p=$!
exec 4<&-
wait "$p"
exit $?
`;

function serviceFromRequest(request: KeychainRequest): string {
  const fallback = typeof request?.item?.service === 'string' ? request.item.service : 'unknown';
  if (request.kind === 'security') {
    if (request.args[0] === 'dump-keychain') {
      if (request.args.includes('-s')) throw new KeychainClientNotStarted(fallback, 'dump-keychain must not specify a service');
      return 'cmd:dump-keychain';
    }
    const services = request.args.flatMap((arg, index) => arg === '-s' && typeof request.args[index + 1] === 'string' ? [request.args[index + 1]] : []);
    if (services.length !== 1) throw new KeychainClientNotStarted(fallback, 'Keychain security request must have exactly one service');
    return services[0];
  }
  if (request.args[0] === 'set') throw new KeychainClientNotStarted(fallback, 'helper writes require the async runner');
  if (request.args.length !== 3 || !(KEYCHAIN_HELPER_SYNC_SUBCOMMANDS as readonly string[]).includes(request.args[0])) {
    throw new KeychainClientNotStarted(fallback, 'unsupported Keychain helper command');
  }
  return request.args[1];
}

/** Validate the direct-runner safety boundary without spawning a process. */
export function validateRequest(request: KeychainRequest): void {
  const fallback = typeof request?.item?.service === 'string' ? request.item.service : 'unknown';
  if (!request || (request.kind !== 'security' && request.kind !== 'helper')) throw new KeychainClientNotStarted(fallback, 'unsupported Keychain command kind');
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new KeychainClientNotStarted(fallback, 'invalid timeout');
  if (request.encoding !== 'utf8' && request.encoding !== 'buffer') throw new KeychainClientNotStarted(fallback, 'invalid output encoding');
  if (typeof request.file !== 'string' || request.file.includes('\0') || !Array.isArray(request.args) || !request.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) throw new KeychainClientNotStarted(fallback, 'invalid Keychain request');
  const service = serviceFromRequest(request);
  if (!request.item || typeof request.item.service !== 'string' || typeof request.item.account !== 'string') throw new KeychainClientNotStarted(service, 'invalid Keychain item');
  if (request.item.service !== service) throw new KeychainClientNotStarted(service, 'item service does not match command service');
  if (request.kind === 'security') {
    if (!(KEYCHAIN_SECURITY_SUBCOMMANDS as readonly string[]).includes(request.args[0])) throw new KeychainClientNotStarted(service, 'unsupported Keychain command');
    if (process.env.QLB_TEST_MODE !== '1' && request.file !== KEYCHAIN_SECURITY_BIN) throw new KeychainClientNotStarted(service, 'unsupported Keychain executable');
  } else {
    if (request.args[0] === 'set') throw new KeychainClientNotStarted(service, 'helper writes require the async runner');
    if (process.env.QLB_TEST_MODE !== '1' && !isAbsolute(request.file)) throw new KeychainClientNotStarted(service, 'helper executable must be absolute');
  }
  if (request.maxBuffer !== undefined && (!Number.isInteger(request.maxBuffer) || request.maxBuffer < 0)) throw new KeychainClientNotStarted(service, 'invalid output limit');
  if (request.secretHex !== undefined && (typeof request.secretHex !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(request.secretHex))) throw new KeychainClientNotStarted(service, 'invalid write value');
  if (request.kind === 'helper' && request.secretHex !== undefined) throw new KeychainClientNotStarted(service, 'helper writes require the async runner');
  const secretInArgv = request.secretHex !== undefined && request.secretHex !== '' && request.args.some((arg) => arg.includes(request.secretHex!));
  const combinedX = request.args.some((arg) => arg.startsWith('-') && arg.slice(1).includes('X'));
  const writeWithValue = request.secretHex !== undefined && request.args.some((arg, index) => arg === '-w' && request.args[index + 1] !== undefined);
  if (combinedX || secretInArgv || writeWithValue) throw new KeychainClientNotStarted(service, 'unstructured write arguments');
  const lockfPath = request.lockfPath ?? KEYCHAIN_LOCKF_BIN;
  if (typeof lockfPath !== 'string' || lockfPath.includes('\0') || !lockfAllowed(lockfPath)) throw new KeychainClientNotStarted(service, 'unsupported lockf executable');
}

function unknownOutcome(error: Error, request: KeychainRequest): Error {
  return request.secretHex === undefined ? error : Object.assign(error, { writeOutcome: 'unknown' });
}

function resultError(code: string, props: Record<string, unknown>): Error {
  return Object.assign(new Error('Keychain wrapper did not prove client exit'), { code, ...props });
}

/**
 * Display-only doctor probe.  It briefly takes a free service's lock while
 * /usr/bin/true runs, so no write path may use it as a gate.  Errors fail
 * closed because an unavailable probe must not permit a duplicate prompt.
 */
export function isKeychainServiceBusy(service: string, opts?: { lockfPath?: string }): boolean {
  const lockfPath = opts?.lockfPath ?? KEYCHAIN_LOCKF_BIN;
  if (!lockfAllowed(lockfPath)) return true;
  try {
    const lockPath = ensureLockFile(service);
    const result = spawnSync(lockfPath, ['-k', '-t', '0', lockPath, '/usr/bin/true'], { stdio: 'ignore' });
    return result.status !== 0;
  } catch {
    return true;
  }
}

export function runKeychainClientSync(request: KeychainRequest): string | Buffer {
  validateRequest(request);
  const service = serviceFromRequest(request);
  if (!clientAllowed(request.file, request.kind)) throw new KeychainClientDisabledInTests();
  const lockfPath = request.lockfPath ?? KEYCHAIN_LOCKF_BIN;
  let lockPath: string;
  try { lockPath = ensureLockFile(service); } catch (err) {
    if (err instanceof KeychainClientDisabledInTests) throw err;
    throw new KeychainClientNotStarted(service, 'lock directory is not writable');
  }
  const mode = request.secretHex === undefined ? 'r' : 'w';
  const result = spawnSync('/bin/sh', ['-c', KEYCHAIN_WAIT_SCRIPT, 'qlb-keychain-wait', lockfPath, lockPath, mode, String(Date.now() + request.timeoutMs), request.file, ...request.args], {
    detached: true,
    stdio: [mode === 'w' ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe'],
    input: mode === 'w' ? `${request.secretHex}\n` : undefined,
    timeout: request.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: request.maxBuffer ?? 1024 * 1024,
    encoding: null,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC', HOME: qlbHomeDir({}) },
  } as Parameters<typeof spawnSync>[2]);
  const fd3 = result.output?.[3];
  const started = Buffer.isBuffer(fd3) && fd3.toString('utf8') === STARTED_SENTINEL;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '');
  // This marker proves the inner shell refused to exec the client, even when
  // it happened before the fd-3 start sentinel was emitted.
  if (result.status === 125 && stderr.includes(DEADLINE_MARKER)) {
    throw new KeychainClientNotStarted(service, 'client was not started before the deadline');
  }
  if (result.error) throw unknownOutcome(result.error, request);
  if (result.status === 75 && !started) throw new KeychainRequestStillWaiting(service);
  if (result.signal && result.status === null) throw unknownOutcome(resultError('EQLBKEYCHAINWRAPPERSIGNALLED', { signal: result.signal }), request);
  if (result.status === null || !started) throw unknownOutcome(resultError('EQLBKEYCHAINWRAPPERNOPROOF', { status: result.status }), request);
  if (result.status === 0) {
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
    if (request.encoding === 'buffer') return stdout;
    const text = stdout.toString('utf8');
    stdout.fill(0);
    return text;
  }
  throw Object.assign(new Error(`Command failed: ${basename(request.file)} ${request.args[0]}\n${stderr}`), { status: result.status });
}

export const keychainClientExec: KeychainExecFn = ((file: string, args: readonly string[], options: KeychainExecOptions) => {
  if (!options || (options.keychainKind !== 'security' && options.keychainKind !== 'helper')) throw new KeychainClientNotStarted('unknown', 'missing Keychain command kind');
  return runKeychainClientSync(keychainRequestFromArgv(options.keychainKind, file, args, { timeoutMs: options.timeout, encoding: options.encoding ?? 'utf8', maxBuffer: options.maxBuffer }));
}) as KeychainExecFn;
