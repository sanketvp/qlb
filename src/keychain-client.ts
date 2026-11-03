import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { qlbHomeDir } from './home';

/** The only production Keychain CLI accepted by this leaf. */
export const KEYCHAIN_SECURITY_BIN = '/usr/bin/security';

export type KeychainKind = 'security' | 'helper';
export type KeychainEncoding = 'utf8' | 'buffer';

/**
 * Options deliberately do not extend Node's ExecFileSyncOptions.  Keychain
 * callers must state which trusted protocol they intend to use.
 */
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
  /** Test-only seam. Ignored outside QLB_TEST_MODE. */
  psPath?: string;
}

const LSTART = /^[A-Za-z0-9: ]+$/;
const REGISTRY_DIR = 'keychain-waiting';
const PS_TIMEOUT_MS = 2_000;
const PS_POLL_MS = 50;

/**
 * A security lookup without -a can resolve the same item as an account
 * qualified lookup.  Therefore one service has one waiting slot.
 */
/** Registry-only key: a wait for one service blocks every account on it. */
export function keychainWaitKey(service: string): string {
  return service;
}

function registryDir(): string {
  return join(qlbHomeDir(process.env), '.qlb', REGISTRY_DIR);
}

function registryPath(item: KeychainItem): string {
  return join(registryDir(), `${createHash('sha256').update(keychainWaitKey(item.service)).digest('hex')}.json`);
}

function validLstart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && LSTART.test(value);
}

function normalLstart(value: string): string | null {
  // Preserve leading spaces: lstart identity is compared byte-for-byte with
  // ps output, while command substitution removes only its final newlines.
  const normalized = value.replace(/[\r\n]+$/, '');
  return validLstart(normalized) ? normalized : null;
}

function errorCode(err: unknown): unknown {
  return err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
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

function ensureDir(): void {
  const dir = registryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}

function writePrivateAtomic(path: string, value: string): void {
  ensureDir();
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  }
}

interface ClientRecord {
  pid: number;
  lstart: string | null;
  state?: 'reserving';
}

function recordText(record: ClientRecord): string {
  return JSON.stringify(record);
}

function parseRecord(path: string): ClientRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const { pid, lstart, state } = parsed as { pid?: unknown; lstart?: unknown; state?: unknown };
    if (!Number.isSafeInteger(pid) || typeof pid !== 'number' || pid <= 0) return null;
    if (lstart !== null && !validLstart(lstart)) return null;
    if (state !== undefined && state !== 'reserving') return null;
    return { pid, lstart: lstart === null ? null : normalLstart(lstart), ...(state === 'reserving' ? { state } : {}) };
  } catch {
    return null;
  }
}

/**
 * Compare before unlinking.  Registry records are ownership claims, never
 * disposable scratch files: a later owner must not lose its claim.
 */
function removeRecordIfMatches(path: string, expected: ClientRecord): void {
  const current = parseRecord(path);
  if (!current || current.pid !== expected.pid || current.lstart !== expected.lstart || current.state !== expected.state) return;
  try { unlinkSync(path); } catch { /* a racing cleaner is harmless */ }
}

function remove(path: string): void {
  try { unlinkSync(path); } catch { /* only used for private probe/temp files */ }
}

function usablePsPath(requested: string | undefined): string {
  if (process.env.QLB_TEST_MODE !== '1' || !requested) return '/bin/ps';
  try {
    const root = realpathSync(tmpdir());
    const candidate = realpathSync(requested);
    if (candidate === root || !relative(root, candidate).startsWith('..')) return candidate;
  } catch {
    // A non-resolved injected path is not a permitted test seam.
  }
  return '/bin/ps';
}

function readPs(pid: number, psPath?: string): string {
  return execFileSync(usablePsPath(psPath), ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: PS_TIMEOUT_MS,
  }) as string;
}

/** Refuse a new client if a recorded client for this service may still exist. */
export function assertNoWaitingClient(item: KeychainItem, deps: { psPath?: string } = {}): void {
  const path = registryPath(item);
  if (!existsSync(path)) return;
  const record = parseRecord(path);
  if (!record) {
    // Corruption is not an ownership claim, but do not unlink a replacement.
    try { unlinkSync(path); } catch { /* a racing cleaner is harmless */ }
    return;
  }
  // A reservation records its QLB owner identity, so a dead owner is cleaned
  // by the same fail-closed liveness proof as a filled client record.
  try {
    const lstart = normalLstart(readPs(record.pid, deps.psPath));
    if (record.lstart === null || lstart === record.lstart) {
      throw new KeychainRequestStillWaiting(item.service);
    }
    removeRecordIfMatches(path, record); // pid reuse, or ps gave no start time
  } catch (err) {
    if (err instanceof KeychainRequestStillWaiting) throw err;
    if ((err as { status?: unknown } | undefined)?.status === 1) {
      removeRecordIfMatches(path, record);
      return;
    }
    // ps uncertainty is fail-closed.
    throw new KeychainRequestStillWaiting(item.service);
  }
}

/** Verify that the registry is writable before starting an async helper. */
export function ensureRegistryWritable(): void {
  ensureDir();
  const path = join(registryDir(), `.probe.${process.pid}.${Math.random().toString(16).slice(2)}`);
  try {
    writeFileSync(path, '', { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600);
  } finally {
    remove(path);
  }
}

/** Claim the service slot before any wrapper process can exist. */
function reserveClientSlot(item: KeychainItem): ClientRecord {
  let lstart: string | null;
  try { lstart = normalLstart(readPs(process.pid)); } catch {
    throw new KeychainClientNotStarted(item.service, 'could not identify waiting-process owner');
  }
  if (!lstart) throw new KeychainClientNotStarted(item.service, 'could not identify waiting-process owner');
  const record: ClientRecord = { pid: process.pid, lstart, state: 'reserving' };
  const path = registryPath(item);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, recordText(record), { encoding: 'utf8' });
    chmodSync(path, 0o600);
    return record;
  } catch (err) {
    if (errorCode(err) === 'EEXIST') throw new KeychainRequestStillWaiting(item.service);
    throw new KeychainClientNotStarted(item.service, 'waiting registry is not writable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Writes a valid record only; an invalid lstart becomes null and fails closed. */
export function writeClientRecord(item: KeychainItem, record: ClientRecord): void {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw new KeychainClientNotStarted(item.service, 'invalid client pid');
  }
  const lstart = record.lstart === null ? null : normalLstart(record.lstart);
  writePrivateAtomic(registryPath(item), JSON.stringify({ pid: record.pid, lstart }));
}

/**
 * Best effort post-payload identity fill.  A failed ps leaves null in place,
 * which remains fail-closed while the pid exists.
 */
export function fillClientLstart(item: KeychainItem, pid: number, deps: { psPath?: string } = {}): void {
  let lstart: string | null = null;
  try { lstart = normalLstart(readPs(pid, deps.psPath)); } catch { return; }
  if (!lstart) return;
  const path = registryPath(item);
  const current = parseRecord(path);
  if (!current || current.pid !== pid) return;
  writeClientRecord(item, { pid, lstart });
}

/** Remove only the record still belonging to this client. */
export function removeClientRecordIf(item: KeychainItem, pid: number, lstart?: string | null): void {
  const path = registryPath(item);
  const current = parseRecord(path);
  if (!current || current.pid !== pid) return;
  // S4 passes the lstart it recorded.  The optional form retains the leaf's
  // compatibility while still snapshots both identity fields before removal.
  if (lstart !== undefined && current.lstart !== lstart) return;
  removeRecordIfMatches(path, current);
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
  opts: { timeoutMs: number; encoding?: KeychainEncoding; maxBuffer?: number; psPath?: string },
): KeychainRequest {
  const command = args[0];
  if (!command || !Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw notStartedForArgs(args, 'unsupported Keychain command');
  }
  if (kind === 'security') {
    if (!['add-generic-password', 'find-generic-password', 'delete-generic-password', 'dump-keychain'].includes(command)) {
      throw notStartedForArgs(args, 'unsupported Keychain command');
    }
    if (command === 'add-generic-password') {
      const parsed = parseSecurityWrite(args);
      return { kind, file, args: parsed.args, secretHex: parsed.secretHex, item: parsed.item, timeoutMs: opts.timeoutMs, encoding: opts.encoding ?? 'utf8', maxBuffer: opts.maxBuffer, psPath: opts.psPath };
    }
    if (args.includes('-X')) throw notStartedForArgs(args, 'unsupported Keychain write arguments');
    return { kind, file, args: [...args], item: itemFromSecurity(args), timeoutMs: opts.timeoutMs, encoding: opts.encoding ?? 'utf8', maxBuffer: opts.maxBuffer, psPath: opts.psPath };
  }
  if (!['delete', 'probe-read', 'set'].includes(command) || args.length < 3 || args.includes('-X')) {
    throw new KeychainClientNotStarted('unknown', 'unsupported Keychain command');
  }
  return {
    kind, file, args: [...args],
    item: { service: args[args.length - 2], account: args[args.length - 1] },
    timeoutMs: opts.timeoutMs, encoding: opts.encoding ?? 'utf8', maxBuffer: opts.maxBuffer, psPath: opts.psPath,
  };
}

function isUnderTmp(candidate: string): boolean {
  try {
    const root = realpathSync(tmpdir());
    // A TMPDIR of / would turn every executable into a test fake.
    if (root === '/') return false;
    const rel = relative(root, realpathSync(candidate));
    return rel === '' || (rel !== '..' && !rel.startsWith('../'));
  } catch {
    return false;
  }
}

function testClientAllowed(file: string): boolean {
  if (process.env.QLB_TEST_MODE !== '1') return true;
  try {
    const candidate = realpathSync(file);
    // These denials do not depend on TMPDIR being sane (and security is not
    // installed on Linux CI, so do not require resolving it here).
    if (file === KEYCHAIN_SECURITY_BIN || candidate === KEYCHAIN_SECURITY_BIN || basename(candidate) === 'qlb-keychain-helper') return false;
  } catch {
    return false;
  }
  return isUnderTmp(file);
}

/**
 * The direct child is only this outer shell.  The Keychain client is an inner
 * detached-session descendant and never receives a signal from Node's timer.
 */
export const KEYCHAIN_WAIT_SCRIPT = `umask 077
trap '' PIPE
exec 4<&0 0</dev/null
/bin/sh -c '
  m=$1; r=$2; ps=$3; deadline=$4; owner=$5; ownerstart=$6; shift 6
  bound=\${QLB_KEYCHAIN_PS_BOUND_MS:-2000}
  case "$bound" in *[!0-9]*|"") bound=2000;; esac
  before_deadline() {
    # GNU date supplies milliseconds in CI. On macOS, use its bundled perl
    # HiRes clock; only if neither is available use a one-second-margin clock.
    now=$(date +%s%3N 2>/dev/null || true)
    case "$now" in
      ""|*[!0-9]*) now=$(/usr/bin/perl -MTime::HiRes=time -e "printf qq(%.0f), time*1000" 2>/dev/null || true);;
    esac
    case "$now" in
      ""|*[!0-9]*) now=$(date +%s); [ "$now" -lt $((deadline / 1000 - 1)) ];;
      *) [ "$now" -lt $((deadline - 100)) ];;
    esac
  }
  before_deadline || { echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
  ticks=$((bound / ${PS_POLL_MS}))
  [ "$ticks" -gt 0 ] || ticks=1
  po="$r.ps.$$"
  "$ps" -p $$ -o lstart= >"$po" 2>/dev/null &
  p=$!
  while kill -0 "$p" 2>/dev/null; do
    [ "$ticks" -gt 0 ] || {
      # p is the ps child we just started; reap it immediately after signalling.
      kill -TERM "$p" 2>/dev/null; wait "$p" 2>/dev/null
      rm -f "$po"; echo "qlb-keychain-wait: record-failed" >&2; exit 125
    }
    sleep 0.05
    ticks=$((ticks - 1))
  done
  wait "$p" || { rm -f "$po"; echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
  l=$(cat "$po"); rm -f "$po"
  case "$l" in ""|*[!A-Za-z0-9:\\ ]*) echo "qlb-keychain-wait: record-failed" >&2; exit 125;; esac
  before_deadline || { echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
  expected=$(printf "{\\"pid\\":%s,\\"lstart\\":\\"%s\\",\\"state\\":\\"reserving\\"}" "$owner" "$ownerstart")
  current=$(cat "$r" 2>/dev/null || :)
  [ "$current" = "$expected" ] || { echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
  tmp="$r.client.$$"
  printf "{\\"pid\\":%s,\\"lstart\\":\\"%s\\"}" "$$" "$l" > "$tmp" || { echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
  # Do not mv over a newer owner: link our completed private record only into
  # the empty slot after removing the matching reservation.
  rm "$r" || { rm -f "$tmp"; echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
  ln "$tmp" "$r" && rm -f "$tmp" || { rm -f "$tmp"; echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
  before_deadline || { echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
  if [ "$m" = w ]; then
    IFS= read -r hex || { echo "qlb-keychain-wait: no-secret" >&2; exit 125; }
    exec 0</dev/null
    exec "$@" -X "$hex"
  fi
  exec 0</dev/null
  exec "$@"
' qlb-keychain-client "$@" 0<&4 4<&- 3>&- &
exec 4<&-
wait "$!"; rc=$?
printf 'qlb-keychain-wait-exit %s\\n' "$rc" >&3
exit "$rc"
`;

function resultError(code: string, props: Record<string, unknown>): Error {
  return Object.assign(new Error('Keychain wrapper did not prove client exit'), { code, ...props });
}

function validateRequest(request: KeychainRequest): void {
  const service = typeof request?.item?.service === 'string' ? request.item.service : 'unknown';
  if (!request || (request.kind !== 'security' && request.kind !== 'helper')) {
    throw new KeychainClientNotStarted(service, 'unsupported Keychain command kind');
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new KeychainClientNotStarted(service, 'invalid timeout');
  }
  if (request.encoding !== 'utf8' && request.encoding !== 'buffer') {
    throw new KeychainClientNotStarted(service, 'invalid output encoding');
  }
  if (typeof request.file !== 'string' || !Array.isArray(request.args) || !request.args.every((arg) => typeof arg === 'string')) {
    throw new KeychainClientNotStarted(service, 'invalid Keychain request');
  }
  if (!request.item || typeof request.item.service !== 'string' || typeof request.item.account !== 'string') {
    throw new KeychainClientNotStarted(service, 'invalid Keychain item');
  }
  if (request.secretHex !== undefined && (typeof request.secretHex !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(request.secretHex))) {
    throw new KeychainClientNotStarted(service, 'invalid write value');
  }
  if (request.args.some((arg) => arg.startsWith('-X')) || (request.secretHex !== undefined && request.secretHex !== '' && request.args.includes(request.secretHex))) {
    throw new KeychainClientNotStarted(service, 'unstructured write arguments');
  }
  if (request.kind === 'helper' && request.args[0] === 'set') {
    throw new KeychainClientNotStarted(service, 'helper writes require the async runner');
  }
}

function removeCurrentRecord(path: string): void {
  const current = parseRecord(path);
  if (current) removeRecordIfMatches(path, current);
}

export function runKeychainClientSync(request: KeychainRequest): string | Buffer {
  validateRequest(request);
  assertNoWaitingClient(request.item, { psPath: request.psPath });
  if (!testClientAllowed(request.file)) throw new KeychainClientDisabledInTests();
  try {
    ensureRegistryWritable();
  } catch {
    throw new KeychainClientNotStarted(request.item.service, 'waiting registry is not writable');
  }
  const reservation = reserveClientSlot(request.item);
  const path = registryPath(request.item);
  const mode = request.secretHex === undefined ? 'r' : 'w';
  const deadlineMs = Date.now() + request.timeoutMs;
  // The shell also checks deadlineMs immediately before exec.  This bound only
  // limits its ps probe; it is not the correctness clock.
  const psBound = Math.max(1, Math.min(PS_TIMEOUT_MS, Math.max(1, request.timeoutMs - 100)));
  const result = spawnSync('/bin/sh', [
    '-c', KEYCHAIN_WAIT_SCRIPT, 'qlb-keychain-wait', mode, path, usablePsPath(request.psPath),
    String(deadlineMs), String(reservation.pid), reservation.lstart ?? '', request.file, ...request.args,
  ], {
    detached: true,
    stdio: [mode === 'w' ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe'],
    input: mode === 'w' ? `${request.secretHex}\n` : undefined,
    timeout: request.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: request.maxBuffer ?? 1024 * 1024,
    encoding: null,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC', HOME: qlbHomeDir({}), QLB_KEYCHAIN_PS_BOUND_MS: String(psBound) },
  } as Parameters<typeof spawnSync>[2]);
  const fd3 = result.output?.[3];
  const proved = result.error === undefined && result.status !== null && Buffer.isBuffer(fd3) && /^qlb-keychain-wait-exit \d+\n$/.test(fd3.toString('utf8'));
  if (proved) {
    removeCurrentRecord(path);
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '');
    if (result.status === 125 && stderr.includes('qlb-keychain-wait:')) {
      throw new KeychainClientNotStarted(request.item.service, 'client record was not created');
    }
    if (result.status === 0) {
      const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
      if (request.encoding === 'buffer') return stdout;
      const text = stdout.toString('utf8');
      stdout.fill(0);
      return text;
    }
    throw Object.assign(new Error(`Command failed: ${basename(request.file)} ${request.args[0]}\n${stderr}`), { status: result.status });
  }
  // Once Node has abandoned the outer wrapper, only its own reservation may be
  // removed.  A filled client record remains the durable waiting claim.
  removeRecordIfMatches(path, reservation);
  if (result.error) throw result.error;
  if (result.signal && result.status === null) {
    throw resultError('EQLBKEYCHAINWRAPPERSIGNALLED', { signal: result.signal, writeOutcome: 'unknown' });
  }
  throw resultError('EQLBKEYCHAINWRAPPERNOPROOF', { status: result.status, writeOutcome: 'unknown' });
}

export const keychainClientExec: KeychainExecFn = ((file: string, args: readonly string[], options: KeychainExecOptions) => {
  if (!options || (options.keychainKind !== 'security' && options.keychainKind !== 'helper')) {
    throw new KeychainClientNotStarted('unknown', 'missing Keychain command kind');
  }
  const request = keychainRequestFromArgv(options.keychainKind, file, args, {
    timeoutMs: options.timeout,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: options.maxBuffer,
  });
  return runKeychainClientSync(request);
}) as KeychainExecFn;
