import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
export function keychainItemKey(service: string, _account: string): string {
  return service;
}

function registryDir(): string {
  return join(qlbHomeDir(process.env), '.qlb', REGISTRY_DIR);
}

function registryPath(item: KeychainItem): string {
  return join(registryDir(), `${createHash('sha256').update(keychainItemKey(item.service, item.account)).digest('hex')}.json`);
}

function validLstart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && LSTART.test(value);
}

function normalLstart(value: string): string | null {
  const normalized = value.trim();
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

interface ClientRecord { pid: number; lstart: string | null }

function parseRecord(path: string): ClientRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const { pid, lstart } = parsed as { pid?: unknown; lstart?: unknown };
    if (!Number.isSafeInteger(pid) || typeof pid !== 'number' || pid <= 0) return null;
    if (lstart !== null && !validLstart(lstart)) return null;
    return { pid, lstart: lstart === null ? null : normalLstart(lstart) };
  } catch {
    return null;
  }
}

function remove(path: string): void {
  try { unlinkSync(path); } catch { /* a racing cleaner is harmless */ }
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
    remove(path);
    return;
  }
  try {
    const lstart = normalLstart(readPs(record.pid, deps.psPath));
    if (record.lstart === null || lstart === record.lstart) {
      throw new KeychainRequestStillWaiting(item.service);
    }
    remove(path); // pid reuse, or ps gave no start time
  } catch (err) {
    if (err instanceof KeychainRequestStillWaiting) throw err;
    if ((err as { status?: unknown } | undefined)?.status === 1) {
      remove(path);
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
export function removeClientRecordIf(item: KeychainItem, pid: number): void {
  const path = registryPath(item);
  const current = parseRecord(path);
  if (current?.pid === pid) remove(path);
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
  let service = '';
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

function testClientAllowed(file: string): boolean {
  if (process.env.QLB_TEST_MODE !== '1') return true;
  try {
    const root = realpathSync(tmpdir());
    const candidate = realpathSync(file);
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${join('', '')}`) && rel !== '..' && !rel.startsWith('../'));
  } catch {
    return false;
  }
}

/**
 * The direct child is only this outer shell.  The Keychain client is an inner
 * detached-session descendant and never receives a signal from Node's timer.
 */
export const KEYCHAIN_WAIT_SCRIPT = `umask 077
trap '' PIPE
exec 4<&0 0</dev/null
/bin/sh -c '
  m=$1; r=$2; ps=$3; shift 3
  bound=\${QLB_KEYCHAIN_PS_BOUND_MS:-2000}
  case "$bound" in *[!0-9]*|"") bound=2000;; esac
  ticks=$((bound / ${PS_POLL_MS}))
  [ "$ticks" -gt 0 ] || ticks=1
  po="$r.ps.$$"
  "$ps" -p $$ -o lstart= >"$po" 2>/dev/null &
  p=$!
  while kill -0 "$p" 2>/dev/null; do
    [ "$ticks" -gt 0 ] || { kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; rm -f "$po"; echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
    sleep 0.05
    ticks=$((ticks - 1))
  done
  wait "$p" || { rm -f "$po"; echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
  l=$(cat "$po"); rm -f "$po"
  case "$l" in ""|*[!A-Za-z0-9:\\ ]*) echo "qlb-keychain-wait: record-failed" >&2; exit 125;; esac
  printf "{\\"pid\\":%s,\\"lstart\\":\\"%s\\"}\\n" "$$" "$l" > "$r.tmp.$$" && mv -f "$r.tmp.$$" "$r" ||
    { echo "qlb-keychain-wait: record-failed" >&2; exit 125; }
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

export function runKeychainClientSync(request: KeychainRequest): string | Buffer {
  if (request.args.includes('-X')) throw new KeychainClientNotStarted(request.item.service, 'unstructured write arguments');
  assertNoWaitingClient(request.item, { psPath: request.psPath });
  if (!testClientAllowed(request.file)) throw new KeychainClientDisabledInTests();
  try {
    ensureRegistryWritable();
  } catch {
    throw new KeychainClientNotStarted(request.item.service, 'waiting registry is not writable');
  }

  const mode = request.secretHex === undefined ? 'r' : 'w';
  // Keep a margin before Node's timeout so a stalled ps reports not-started.
  const psBound = Math.max(1, Math.min(PS_TIMEOUT_MS, Math.floor(request.timeoutMs / 2)));
  const result = spawnSync('/bin/sh', ['-c', KEYCHAIN_WAIT_SCRIPT, 'qlb-keychain-wait', mode, registryPath(request.item), usablePsPath(request.psPath), request.file, ...request.args], {
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
    remove(registryPath(request.item));
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
