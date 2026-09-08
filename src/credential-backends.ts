// Platform credential backends for QLB-owned secrets.
//
// macOS uses the `security` CLI (Keychain). Linux prefers `secret-tool`
// (libsecret / GNOME Keyring) and falls back to an AES-256-GCM file.
// Windows stores DPAPI-encrypted blobs via PowerShell.
//
// These classes do NOT enforce the `qlb:` / `qlb-test-` service-name guard;
// the facade in `keychain.ts` does. Callers that need unscoped native reads
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
import { homedir as osHomedir } from 'node:os';
import { dirname, join } from 'node:path';

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
  | 'windows-dpapi';

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
    homedir: osHomedir,
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

export class MacosKeychainBackend extends SyncCredentialBackend {
  readonly kind = 'macos-keychain' as const;
  private readonly exec: ExecFileSyncFn;

  constructor(opts: { execFileSync?: ExecFileSyncFn } = {}) {
    super();
    this.exec = opts.execFileSync ?? execFileUtf8;
  }

  setSync(service: string, account: string, jsonValue: string): void {
    try {
      this.exec(
        'security',
        ['add-generic-password', '-a', account, '-s', service, '-w', jsonValue, '-U'],
        { encoding: 'utf8' },
      );
    } catch (err) {
      throw wrapCredentialError('set', service, account, err);
    }
  }

  getSync(service: string, account: string): string {
    try {
      const stdout = this.exec(
        'security',
        ['find-generic-password', '-a', account, '-s', service, '-w'],
        { encoding: 'utf8' },
      );
      return stdout.replace(/\n$/, '');
    } catch (err) {
      throw wrapCredentialError('get', service, account, err);
    }
  }

  deleteSync(service: string, account: string): void {
    try {
      this.exec(
        'security',
        ['delete-generic-password', '-a', account, '-s', service],
        { encoding: 'utf8' },
      );
    } catch (err) {
      throw wrapCredentialError('delete', service, account, err);
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

export function createRawCredentialBackend(
  host: CredentialBackendHost = defaultCredentialBackendHost(),
): CredentialBackend {
  const kind = selectBackendKind({
    platform: host.platform,
    commandExists: host.commandExists,
  });
  const qlbDir = join(host.homedir(), '.qlb');
  switch (kind) {
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
