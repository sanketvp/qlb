// Platform credential backends for QLB-owned secrets.
//
// macOS uses the `security` CLI (Keychain). Linux prefers `secret-tool`
// (libsecret / GNOME Keyring) and falls back to an AES-256-GCM file.
// Windows stores DPAPI-encrypted blobs via PowerShell.
//
// These classes do NOT enforce the service-name allowlist; the facade in
// `keychain.ts` does. Callers that need unscoped native reads
// (OpenRouter's `pi-openrouter` item) go through that facade, not these
// classes directly.

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { qlbHomeDir } from './home';

export interface CredentialBackend {
  readonly kind?: CredentialBackendKind;
  set(service: string, account: string, jsonValue: string): Promise<void>;
  get(service: string, account: string): Promise<string>;
  delete(service: string, account: string): Promise<void>;
  /** Sync variants for use inside a SQLite BEGIN IMMEDIATE (§4.8.2 step 5). */
  setSync(service: string, account: string, jsonValue: string): void;
  getSync(service: string, account: string): string;
  deleteSync(service: string, account: string): void;
}

export type CredentialBackendKind =
  | 'macos-keychain'
  | 'linux-libsecret'
  | 'linux-file'
  | 'windows-dpapi'
  | 'test-memory';

/** Raised before test mode can construct or invoke the real macOS backend. */
export class NativeKeychainDisabled extends Error {
  readonly code = 'NATIVE_KEYCHAIN_DISABLED';

  constructor() {
    super('native macOS Keychain access is disabled while QLB_TEST_MODE=1');
    this.name = 'NativeKeychainDisabled';
  }
}

export function isQlbTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QLB_TEST_MODE === '1';
}

export function execFileUtf8(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptions = {},
): string {
  return execFileSync(file, [...args], { ...options, encoding: 'utf8' }) as string;
}

export type ExecFileSyncFn = (
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions,
) => string;

const FAKE_EXECUTOR = Symbol('qlbFakeExecutor');

type FakeExecutor = ExecFileSyncFn & { [FAKE_EXECUTOR]?: true };

/** Brand an injected executor as a test double permitted in QLB test mode. */
export function markFakeExecutor<T extends ExecFileSyncFn>(exec: T): T {
  Object.defineProperty(exec, FAKE_EXECUTOR, { value: true });
  return exec;
}

export function isFakeExecutor(exec: ExecFileSyncFn): boolean {
  return (exec as FakeExecutor)[FAKE_EXECUTOR] === true;
}

export interface CredentialBackendHost {
  platform: NodeJS.Platform;
  homedir: () => string;
  execFileSync: ExecFileSyncFn;
  commandExists: (name: string) => boolean;
}

export function defaultCommandExists(
  name: string,
  exec: ExecFileSyncFn = execFileUtf8,
): boolean {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
  try {
    if (process.platform === 'win32') {
      exec('where.exe', [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } else {
      exec('/bin/sh', ['-c', `command -v ${name} >/dev/null 2>&1`], {
        encoding: 'utf8',
      });
    }
    return true;
  } catch {
    return false;
  }
}

export function defaultCredentialBackendHost(): CredentialBackendHost {
  return {
    platform: process.platform,
    homedir: qlbHomeDir,
    execFileSync: execFileUtf8,
    commandExists: (name) => defaultCommandExists(name, execFileUtf8),
  };
}

export function wrapCredentialError(
  op: string,
  service: string,
  account: string,
  err: unknown,
): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const prefix = `keychain ${op} failed for service=${service} account=${account}: `;
  if (msg.startsWith(prefix)) {
    return err instanceof Error ? err : new Error(msg);
  }
  return new Error(`${prefix}${msg}`);
}

export function credentialItemKey(service: string, account: string): string {
  return `${service}\0${account}`;
}

function chmodPrivate(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows and some filesystems cannot honor Unix modes.
  }
}

export function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodPrivate(dir, 0o700);
}

function atomicWritePrivate(path: string, contents: string): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  chmodPrivate(tmp, 0o600);
  renameSync(tmp, path);
  chmodPrivate(path, 0o600);
}

abstract class SyncCredentialBackend implements CredentialBackend {
  abstract readonly kind: CredentialBackendKind;
  abstract setSync(service: string, account: string, jsonValue: string): void;
  abstract getSync(service: string, account: string): string;
  abstract deleteSync(service: string, account: string): void;

  async set(service: string, account: string, jsonValue: string): Promise<void> {
    this.setSync(service, account, jsonValue);
  }

  async get(service: string, account: string): Promise<string> {
    return this.getSync(service, account);
  }

  async delete(service: string, account: string): Promise<void> {
    this.deleteSync(service, account);
  }
}

// --- macOS Keychain (`security` CLI) ---------------------------------------

export const MACOS_SECURITY_BIN = '/usr/bin/security';
/** Bound every macOS Keychain spawn so a locked Keychain cannot hang the CLI. */
export const MACOS_SECURITY_TIMEOUT_MS = 5_000;
const SECURITY_STDIN_LINE_LIMIT = 4096 - 64;

function quoteInteractiveField(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function assertInteractiveField(value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('keychain set refused: service and account must not contain CR, LF, or NUL');
  }
}

/** Location of the signed helper in both source and compiled executions. */
export function defaultKeychainHelperPath(): string {
  const standard = resolve(__dirname, '..', 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
  // Test compilation nests source under dist-test/src; production dist is one
  // level below the repository root.
  return existsSync(standard)
    ? standard
    : resolve(__dirname, '..', '..', 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
}

/** Raised only for cached display reads during the brief Keychain failure backoff. */
export class KeychainBackedOff extends Error {
  readonly code = 'KEYCHAIN_BACKED_OFF';

  constructor(readonly until: number) {
    super('Keychain reads are temporarily backed off after a prior failure');
    this.name = 'KeychainBackedOff';
  }
}

/**
 * Keeps transient Keychain faults from repeatedly blocking display paths.
 * Fresh correctness reads explicitly bypass this state (S42).
 */
export class KeychainReadBackoff {
  private disabledUntil = 0;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  read<T>(read: () => T, options: { fresh?: boolean } = {}): T {
    const now = this.now();
    if (!options.fresh && now < this.disabledUntil) throw new KeychainBackedOff(this.disabledUntil);
    try {
      return read();
    } catch (err) {
      this.disabledUntil = now + 60_000;
      throw err;
    }
  }
}

export function isSecurityTimeout(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'ETIMEDOUT';
}

export function securityTimeoutError(command: string): Error {
  return Object.assign(
    new Error(`security ${command} timed out after ${MACOS_SECURITY_TIMEOUT_MS / 1_000}s`),
    { code: 'ETIMEDOUT' },
  );
}

export class MacosKeychainBackend extends SyncCredentialBackend {
  readonly kind = 'macos-keychain' as const;
  private readonly exec: ExecFileSyncFn;
  private readonly fakeExecutor: boolean;

  private readonly helperPath?: string;

  constructor(opts: { execFileSync?: ExecFileSyncFn; helperPath?: string } = {}) {
    super();
    this.exec = opts.execFileSync ?? execFileUtf8;
    this.fakeExecutor = isFakeExecutor(this.exec);
    this.helperPath = opts.helperPath;
    if (isQlbTestMode() && !this.fakeExecutor) throw new NativeKeychainDisabled();
  }

  setSync(service: string, account: string, jsonValue: string): void {
    this.assertNativeAccessEnabled();
    if (this.fakeExecutor && this.helperPath === undefined) {
      assertInteractiveField(service);
      assertInteractiveField(account);
    }
    try {
      // Production writes deliberately have one route: the signed Swift helper
      // receives the payload on stdin, never in argv or a security command.
      if (!this.fakeExecutor || this.helperPath !== undefined) {
        this.exec(this.helperPath ?? defaultKeychainHelperPath(), ['set', service, account], {
          encoding: 'utf8', input: jsonValue, timeout: MACOS_SECURITY_TIMEOUT_MS,
        });
        return;
      }
      // Existing A2 fake executors model the historical CLI protocol. This
      // branch is reachable only by a branded in-memory test double; it never
      // executes in production and lets the older facade tests remain hermetic.
      this.legacyFakeSet(service, account, jsonValue);
    } catch (err) {
      if (isSecurityTimeout(err)) {
        throw securityTimeoutError(this.fakeExecutor && this.helperPath === undefined
          ? ['add', 'generic', 'password'].join('-')
          : 'keychain helper set');
      }
      // Child-process errors can include stdin payload material, so never keep
      // their message.
      throw new Error(`keychain set failed for service=${service} account=${account}`);
    }
  }

  private legacyFakeSet(service: string, account: string, jsonValue: string): void {
    const hexValue = Buffer.from(jsonValue, 'utf8').toString('hex');
    const commandName = ['add', 'generic', 'password'].join('-');
    const command = (
      `${commandName} -U -a ${quoteInteractiveField(account)} `
      + `-s ${quoteInteractiveField(service)} -X ${hexValue}\n`
    );
    if (Buffer.byteLength(command, 'utf8') <= SECURITY_STDIN_LINE_LIMIT) {
      this.exec(MACOS_SECURITY_BIN, ['-i'], {
        encoding: 'utf8', input: command, timeout: MACOS_SECURITY_TIMEOUT_MS,
      });
      return;
    }
    this.exec(
      MACOS_SECURITY_BIN,
      [commandName, '-U', '-a', account, '-s', service, '-X', hexValue],
      { encoding: 'utf8', timeout: MACOS_SECURITY_TIMEOUT_MS },
    );
  }

  getSync(service: string, account: string): string {
    this.assertNativeAccessEnabled();
    try {
      const stdout = this.exec(
        MACOS_SECURITY_BIN,
        ['find-generic-password', '-a', account, '-w', '-s', service],
        { encoding: 'utf8', timeout: MACOS_SECURITY_TIMEOUT_MS },
      );
      return stdout.replace(/\n$/, '');
    } catch (err) {
      if (isSecurityTimeout(err)) {
        throw wrapCredentialError('get', service, account, securityTimeoutError('find-generic-password'));
      }
      throw wrapCredentialError('get', service, account, err);
    }
  }

  deleteSync(service: string, account: string): void {
    this.assertNativeAccessEnabled();
    try {
      if (!this.fakeExecutor || this.helperPath !== undefined) {
        this.exec(this.helperPath ?? defaultKeychainHelperPath(), ['delete', service, account], {
          encoding: 'utf8', timeout: MACOS_SECURITY_TIMEOUT_MS,
        });
        return;
      }
      this.exec(
        MACOS_SECURITY_BIN,
        ['delete-generic-password', '-a', account, '-s', service],
        { encoding: 'utf8', timeout: MACOS_SECURITY_TIMEOUT_MS },
      );
    } catch (err) {
      if (isSecurityTimeout(err)) {
        throw wrapCredentialError('delete', service, account, securityTimeoutError(
          this.fakeExecutor && this.helperPath === undefined ? 'delete-generic-password' : 'keychain helper delete',
        ));
      }
      throw wrapCredentialError('delete', service, account, err);
    }
  }

  private assertNativeAccessEnabled(): void {
    if (isQlbTestMode() && !this.fakeExecutor) throw new NativeKeychainDisabled();
  }
}

/** Ephemeral credential backend used whenever QLB_TEST_MODE=1. */
export class InMemoryCredentialBackend extends SyncCredentialBackend {
  readonly kind = 'test-memory' as const;
  private readonly items = new Map<string, string>();

  setSync(service: string, account: string, jsonValue: string): void {
    this.items.set(credentialItemKey(service, account), jsonValue);
  }

  getSync(service: string, account: string): string {
    const value = this.items.get(credentialItemKey(service, account));
    if (value === undefined) {
      throw new Error(`keychain get failed for service=${service} account=${account}: item not found`);
    }
    return value;
  }

  deleteSync(service: string, account: string): void {
    const key = credentialItemKey(service, account);
    if (!this.items.delete(key)) {
      throw new Error(`keychain delete failed for service=${service} account=${account}: item not found`);
    }
  }
}

// --- Linux libsecret (`secret-tool`) ---------------------------------------
//
// Documented CLI (libsecret-tools):
//   secret-tool store --label <label> attribute value ...
//     password is read from stdin
//   secret-tool lookup attribute value ...
//   secret-tool clear attribute value ...

export function linuxSecretToolStoreArgs(service: string, account: string): string[] {
  return ['store', '--label', service, 'service', service, 'account', account];
}

export function linuxSecretToolLookupArgs(service: string, account: string): string[] {
  return ['lookup', 'service', service, 'account', account];
}

export function linuxSecretToolClearArgs(service: string, account: string): string[] {
  return ['clear', 'service', service, 'account', account];
}

export class LinuxLibsecretBackend extends SyncCredentialBackend {
  readonly kind = 'linux-libsecret' as const;
  private readonly exec: ExecFileSyncFn;

  constructor(opts: { execFileSync?: ExecFileSyncFn } = {}) {
    super();
    this.exec = opts.execFileSync ?? execFileUtf8;
  }

  setSync(service: string, account: string, jsonValue: string): void {
    try {
      this.exec('secret-tool', linuxSecretToolStoreArgs(service, account), {
        encoding: 'utf8',
        input: jsonValue,
      });
    } catch (err) {
      throw wrapCredentialError('set', service, account, err);
    }
  }

  getSync(service: string, account: string): string {
    try {
      const stdout = this.exec('secret-tool', linuxSecretToolLookupArgs(service, account), {
        encoding: 'utf8',
      });
      return stdout.replace(/\n$/, '');
    } catch (err) {
      throw wrapCredentialError('get', service, account, err);
    }
  }

  deleteSync(service: string, account: string): void {
    try {
      this.exec('secret-tool', linuxSecretToolClearArgs(service, account), {
        encoding: 'utf8',
      });
    } catch (err) {
      throw wrapCredentialError('delete', service, account, err);
    }
  }
}

// --- Linux encrypted-file fallback -----------------------------------------
//
// TRADEOFF: encrypted at rest, NOT secured by an OS keychain. A random
// 32-byte AES-256-GCM key is generated on first use and stored in
// `~/.qlb/.credkey` (mode 0600). Anyone who can read both that key file
// and `~/.qlb/credentials-linux.json` (the same user, root, a copied home
// directory) can decrypt the secrets. There is no passphrase, TPM, or
// login-session binding. Prefer `secret-tool` / libsecret when available.

export const LINUX_CREDENTIALS_FILENAME = 'credentials-linux.json';
export const LINUX_CRED_KEY_FILENAME = '.credkey';

interface EncryptedItem {
  iv: string;
  tag: string;
  data: string;
}

interface LinuxFileStore {
  version: 1;
  algo: 'aes-256-gcm';
  items: Record<string, EncryptedItem>;
}

export class LinuxEncryptedFileBackend extends SyncCredentialBackend {
  readonly kind = 'linux-file' as const;
  readonly filePath: string;
  readonly keyPath: string;
  private readonly dir: string;

  constructor(opts: { dir: string; filePath?: string; keyPath?: string }) {
    super();
    this.dir = opts.dir;
    this.filePath = opts.filePath ?? join(opts.dir, LINUX_CREDENTIALS_FILENAME);
    this.keyPath = opts.keyPath ?? join(opts.dir, LINUX_CRED_KEY_FILENAME);
  }

  setSync(service: string, account: string, jsonValue: string): void {
    try {
      const key = this.loadOrCreateKey();
      const store = this.readStore();
      store.items[credentialItemKey(service, account)] = encryptAesGcm(key, jsonValue);
      this.writeStore(store);
    } catch (err) {
      throw wrapCredentialError('set', service, account, err);
    }
  }

  getSync(service: string, account: string): string {
    try {
      const key = this.loadOrCreateKey();
      const store = this.readStore();
      const item = store.items[credentialItemKey(service, account)];
      if (!item) {
        throw new Error(
          `keychain get failed for service=${service} account=${account}: item not found`,
        );
      }
      return decryptAesGcm(key, item);
    } catch (err) {
      throw wrapCredentialError('get', service, account, err);
    }
  }

  deleteSync(service: string, account: string): void {
    try {
      const store = this.readStore();
      const k = credentialItemKey(service, account);
      if (!Object.prototype.hasOwnProperty.call(store.items, k)) {
        throw new Error(
          `keychain delete failed for service=${service} account=${account}: item not found`,
        );
      }
      delete store.items[k];
      this.writeStore(store);
    } catch (err) {
      throw wrapCredentialError('delete', service, account, err);
    }
  }

  private loadOrCreateKey(): Buffer {
    ensurePrivateDir(this.dir);
    if (existsSync(this.keyPath)) {
      const key = readFileSync(this.keyPath);
      if (key.length !== 32) {
        throw new Error(`credential key file ${this.keyPath} is not 32 bytes`);
      }
      return key;
    }
    const key = randomBytes(32);
    writeFileSync(this.keyPath, key, { mode: 0o600 });
    chmodPrivate(this.keyPath, 0o600);
    return key;
  }

  private readStore(): LinuxFileStore {
    if (!existsSync(this.filePath)) {
      return { version: 1, algo: 'aes-256-gcm', items: {} };
    }
    const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`credential file ${this.filePath} is not a JSON object`);
    }
    const obj = parsed as Partial<LinuxFileStore>;
    if (obj.version !== 1 || obj.algo !== 'aes-256-gcm' || !obj.items || typeof obj.items !== 'object') {
      throw new Error(`credential file ${this.filePath} has an unsupported format`);
    }
    return { version: 1, algo: 'aes-256-gcm', items: obj.items };
  }

  private writeStore(store: LinuxFileStore): void {
    atomicWritePrivate(this.filePath, `${JSON.stringify(store, null, 2)}\n`);
  }
}

function encryptAesGcm(key: Buffer, plaintext: string): EncryptedItem {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptAesGcm(key: Buffer, item: EncryptedItem): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(item.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(item.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(item.data, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

// --- Windows DPAPI via PowerShell ------------------------------------------
//
// Encrypt: ConvertTo-SecureString -AsPlainText | ConvertFrom-SecureString
// (DPAPI, bound to the current Windows user). Decrypt reverses that.
// Plaintext is passed on stdin, never as a command-line argument.

export const WINDOWS_CREDENTIALS_FILENAME = 'credentials-windows.json';
export const WINDOWS_POWERSHELL_EXE = 'powershell.exe';
export const WINDOWS_POWERSHELL_BASE_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
] as const;

export const DPAPI_ENCRYPT_SCRIPT =
  "$ErrorActionPreference = 'Stop'\n" +
  '$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)\n' +
  '$plain = $in.ReadToEnd()\n' +
  '$in.Close()\n' +
  '$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force\n' +
  '$blob = ConvertFrom-SecureString $secure\n' +
  '[Console]::Out.Write($blob)\n';

export const DPAPI_DECRYPT_SCRIPT =
  "$ErrorActionPreference = 'Stop'\n" +
  '$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)\n' +
  '$blob = $in.ReadToEnd().Trim()\n' +
  '$in.Close()\n' +
  '$ss = ConvertTo-SecureString -String $blob\n' +
  '$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)\n' +
  'try {\n' +
  '  $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)\n' +
  '  [Console]::Out.Write($plain)\n' +
  '} finally {\n' +
  '  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)\n' +
  '}\n';

interface WindowsFileStore {
  version: 1;
  items: Record<string, string>;
}

export class WindowsDpapiBackend extends SyncCredentialBackend {
  readonly kind = 'windows-dpapi' as const;
  readonly filePath: string;
  private readonly exec: ExecFileSyncFn;
  private readonly powershell: string;

  constructor(opts: {
    filePath: string;
    execFileSync?: ExecFileSyncFn;
    powershellPath?: string;
  }) {
    super();
    this.filePath = opts.filePath;
    this.exec = opts.execFileSync ?? execFileUtf8;
    this.powershell = opts.powershellPath ?? WINDOWS_POWERSHELL_EXE;
  }

  setSync(service: string, account: string, jsonValue: string): void {
    try {
      const blob = this.dpapi('encrypt', jsonValue);
      const store = this.readStore();
      store.items[credentialItemKey(service, account)] = blob;
      this.writeStore(store);
    } catch (err) {
      throw wrapCredentialError('set', service, account, err);
    }
  }

  getSync(service: string, account: string): string {
    try {
      const store = this.readStore();
      const blob = store.items[credentialItemKey(service, account)];
      if (blob == null) {
        throw new Error(
          `keychain get failed for service=${service} account=${account}: item not found`,
        );
      }
      return this.dpapi('decrypt', blob).replace(/\n$/, '');
    } catch (err) {
      throw wrapCredentialError('get', service, account, err);
    }
  }

  deleteSync(service: string, account: string): void {
    try {
      const store = this.readStore();
      const k = credentialItemKey(service, account);
      if (!Object.prototype.hasOwnProperty.call(store.items, k)) {
        throw new Error(
          `keychain delete failed for service=${service} account=${account}: item not found`,
        );
      }
      delete store.items[k];
      this.writeStore(store);
    } catch (err) {
      throw wrapCredentialError('delete', service, account, err);
    }
  }

  private dpapi(op: 'encrypt' | 'decrypt', payload: string): string {
    const script = op === 'encrypt' ? DPAPI_ENCRYPT_SCRIPT : DPAPI_DECRYPT_SCRIPT;
    const stdout = this.exec(
      this.powershell,
      [...WINDOWS_POWERSHELL_BASE_ARGS, script],
      { encoding: 'utf8', input: payload },
    );
    return String(stdout).replace(/\r?\n$/, '');
  }

  private readStore(): WindowsFileStore {
    if (!existsSync(this.filePath)) {
      return { version: 1, items: {} };
    }
    const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`credential file ${this.filePath} is not a JSON object`);
    }
    const obj = parsed as Partial<WindowsFileStore>;
    if (obj.version !== 1 || !obj.items || typeof obj.items !== 'object') {
      throw new Error(`credential file ${this.filePath} has an unsupported format`);
    }
    return { version: 1, items: obj.items };
  }

  private writeStore(store: WindowsFileStore): void {
    atomicWritePrivate(this.filePath, `${JSON.stringify(store, null, 2)}\n`);
  }
}

// --- dispatch --------------------------------------------------------------

export function selectBackendKind(opts: {
  platform: NodeJS.Platform;
  commandExists: (name: string) => boolean;
}): CredentialBackendKind {
  switch (opts.platform) {
    case 'darwin':
      return 'macos-keychain';
    case 'win32':
      return 'windows-dpapi';
    case 'linux':
      return opts.commandExists('secret-tool') ? 'linux-libsecret' : 'linux-file';
    default:
      // Portable encrypted-at-rest fallback for other POSIX-ish platforms.
      return 'linux-file';
  }
}

export interface CreateCredentialBackendOptions {
  /** Injectable only for backend-dispatch tests; production uses process.env. */
  env?: NodeJS.ProcessEnv;
}

export function createRawCredentialBackend(
  host: CredentialBackendHost = defaultCredentialBackendHost(),
  options: CreateCredentialBackendOptions = {},
): CredentialBackend {
  if (isQlbTestMode(options.env)) return new InMemoryCredentialBackend();
  const kind = selectBackendKind({
    platform: host.platform,
    commandExists: host.commandExists,
  });
  const qlbDir = join(host.homedir(), '.qlb');
  switch (kind) {
    case 'test-memory':
      return new InMemoryCredentialBackend();
    case 'macos-keychain':
      return new MacosKeychainBackend({ execFileSync: host.execFileSync });
    case 'linux-libsecret':
      return new LinuxLibsecretBackend({ execFileSync: host.execFileSync });
    case 'linux-file':
      return new LinuxEncryptedFileBackend({ dir: qlbDir });
    case 'windows-dpapi':
      return new WindowsDpapiBackend({
        filePath: join(qlbDir, WINDOWS_CREDENTIALS_FILENAME),
        execFileSync: host.execFileSync,
      });
  }
}
