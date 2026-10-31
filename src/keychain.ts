// Platform-dispatching credential store for QLB (§4.8.1).
//
// SAFETY: this module never hardcodes real credential file paths. Its fixed
// allowlist permits QLB-owned `qlb:` items, a read-only C-swap import item, and
// narrowly scoped Claude Code credential items. Phase 2a does not import, move,
// or delete any live credentials.
// Real OAuth grants are Phase 2b, via an explicit user-triggered command.
//
// All subprocess invocations use `execFile`/`execFileSync` with an argv array
// (never `exec` + string interpolation) to avoid shell injection.

import { OPENROUTER_KEYCHAIN_SERVICE } from './config';
import {
  KeychainAccessDeniedError,
  assertKeychainAccess,
  isAllowedKeychainService,
  type KeychainAllowlistOptions,
} from './keychain-allowlist';
import {
  createRawCredentialBackend,
  defaultCredentialBackendHost,
  defaultKeychainHelperPath,
  KeychainBackedOff,
  KeychainHelperMissingError,
  KeychainReadBackoff,
  execFileUtf8,
  isCredentialNotFound,
  isFakeExecutor,
  isQlbTestMode,
  isSecurityTimeout,
  NativeKeychainDisabled,
  MACOS_SECURITY_BIN,
  MACOS_SECURITY_TIMEOUT_MS,
  securityTimeoutError,
  type CredentialBackend,
  type ExecFileSyncFn,
} from './credential-backends';

export type {
  CredentialBackend,
  CredentialBackendHost,
  CredentialBackendKind,
  ExecFileSyncFn,
} from './credential-backends';
export {
  KeychainAccessDeniedError,
  assertKeychainAccess,
  isAllowedKeychainService,
  macosKeychainAccountName,
} from './keychain-allowlist';
export type { KeychainAllowlistOptions, KeychainOperation } from './keychain-allowlist';
export {
  MacosKeychainBackend,
  InMemoryCredentialBackend,
  NativeKeychainDisabled,
  markFakeExecutor,
  LinuxLibsecretBackend,
  LinuxEncryptedFileBackend,
  WindowsDpapiBackend,
  selectBackendKind,
  createRawCredentialBackend,
  linuxSecretToolStoreArgs,
  linuxSecretToolLookupArgs,
  linuxSecretToolClearArgs,
  DPAPI_ENCRYPT_SCRIPT,
  DPAPI_DECRYPT_SCRIPT,
  WINDOWS_POWERSHELL_EXE,
  WINDOWS_POWERSHELL_BASE_ARGS,
  defaultCommandExists,
  defaultCredentialBackendHost,
  defaultKeychainHelperPath,
  KeychainBackedOff,
  KeychainHelperMissingError,
  KeychainReadBackoff,
  MACOS_SECURITY_BIN,
  MACOS_SECURITY_TIMEOUT_MS,
} from './credential-backends';

/** Existing name used by migration / refresh-lease / credentials. */
export type KeychainBackend = CredentialBackend;

/** Spec Keychain table: account attribute for every QLB-owned `qlb:*` item. */
export const QLB_KEYCHAIN_ACCOUNT = 'qlb';

/** Account used when looking up unscoped native secrets (OpenRouter). */
export const NATIVE_SECRET_ACCOUNT = QLB_KEYCHAIN_ACCOUNT;

/** @deprecated Use assertKeychainAccess when an operation and account are known. */
export function isSafeKeychainService(service: string): boolean {
  // The deprecated, operation-free API promises that every operation is safe.
  // QLB-owned and disposable test services meet that promise.
  return service.startsWith('qlb:') || service.startsWith('qlb-test-');
}

/** @deprecated Use assertKeychainAccess when an operation and account are known. */
export function assertSafeKeychainService(service: string): void {
  if (!isSafeKeychainService(service)) {
    // Deliberately test write: partial read-only or account-gated allowances
    // must not be represented as universally safe by this legacy API.
    assertKeychainAccess(service, '', 'write');
  }
}

/** Spec §4.8.1 / task convention: service `qlb:<provider>:<accountId>`. */
export function qlbKeychainService(provider: string, accountId: string): string {
  return `qlb:${provider}:${accountId}`;
}

interface ListingCredentialBackend extends CredentialBackend {
  /** Test-memory enumeration used only for the retirement stash gate. */
  listServices?(): string[];
}

export function withServiceGuard(
  backend: CredentialBackend,
  allowlistOptions: KeychainAllowlistOptions = {},
): CredentialBackend {
  // The test-mode backend is entirely in memory. Retain the production
  // capability matrix while allowing QLB tests to exercise fake credentials.
  const effectiveAllowlistOptions = backend.kind === 'test-memory'
    ? { ...allowlistOptions, env: {} }
    : allowlistOptions;
  // The production Keychain has no safe item-listing API. In test mode retain
  // service names at this facade boundary so the retirement stash gate can be
  // exercised without ever invoking `security`.
  const testMemoryItems = new Set<string>();
  const testMemoryKey = (service: string, account: string) => `${service}\0${account}`;
  const guarded: ListingCredentialBackend = {
    kind: backend.kind,
    async set(service, account, jsonValue) {
      assertKeychainAccess(service, account, 'write', effectiveAllowlistOptions);
      await backend.set(service, account, jsonValue);
      if (backend.kind === 'test-memory') testMemoryItems.add(testMemoryKey(service, account));
    },
    get(service, account) {
      assertKeychainAccess(service, account, 'read', effectiveAllowlistOptions);
      return backend.get(service, account);
    },
    async delete(service, account) {
      assertKeychainAccess(service, account, 'write', effectiveAllowlistOptions);
      await backend.delete(service, account);
      if (backend.kind === 'test-memory') testMemoryItems.delete(testMemoryKey(service, account));
    },
    setSync(service, account, jsonValue) {
      assertKeychainAccess(service, account, 'write', effectiveAllowlistOptions);
      backend.setSync(service, account, jsonValue);
      if (backend.kind === 'test-memory') testMemoryItems.add(testMemoryKey(service, account));
    },
    getSync(service, account) {
      assertKeychainAccess(service, account, 'read', effectiveAllowlistOptions);
      return backend.getSync(service, account);
    },
    deleteSync(service, account) {
      assertKeychainAccess(service, account, 'write', effectiveAllowlistOptions);
      backend.deleteSync(service, account);
      if (backend.kind === 'test-memory') testMemoryItems.delete(testMemoryKey(service, account));
    },
    assertHelperUsable() {
      backend.assertHelperUsable?.();
    },
    listServices() {
      if (backend.kind !== 'test-memory') {
        throw new Error('credential backend does not support service enumeration');
      }
      return [...new Set([...testMemoryItems].map((key) => key.slice(0, key.indexOf('\0'))))];
    },
  };
  return guarded;
}

const rawDarwin = createRawCredentialBackend({
  ...defaultCredentialBackendHost(),
  platform: 'darwin',
});
const rawPlatform = createRawCredentialBackend();

/**
 * Darwin `security` CLI backend, guarded. Kept so existing imports continue
 * to work on macOS; Linux/Windows callers should use `platformKeychain`.
 */
export const macosKeychain: KeychainBackend = withServiceGuard(rawDarwin);

/** Guarded backend for the current `process.platform`. */
export const platformKeychain: KeychainBackend = withServiceGuard(rawPlatform);

export function keychainSetSync(
  service: string,
  account: string,
  jsonValue: string,
): void {
  platformKeychain.setSync(service, account, jsonValue);
}

export function keychainGetSync(service: string, account: string): string {
  return platformKeychain.getSync(service, account);
}

export function keychainDeleteSync(service: string, account: string): void {
  platformKeychain.deleteSync(service, account);
}

export async function keychainSet(
  service: string,
  account: string,
  jsonValue: string,
): Promise<void> {
  await platformKeychain.set(service, account, jsonValue);
}

export async function keychainGet(
  service: string,
  account: string,
): Promise<string> {
  return platformKeychain.get(service, account);
}

export async function keychainDelete(
  service: string,
  account: string,
): Promise<void> {
  await platformKeychain.delete(service, account);
}

const UNCLAIMED_SERVICE = /^qlb:[^:]+:unclaimed:/;
const KEPT_SERVICE = /^qlb:[^:]+:kept:/;
const KEYCHAIN_DUMP_MAX_BUFFER = 64 * 1024 * 1024;

export interface KeychainEnumerationDependencies {
  platform?: NodeJS.Platform;
  exec?: ExecFileSyncFn;
  /** Tests may provide a names-only in-memory backend. */
  keychain?: KeychainBackend;
}

function enumerationError(error: unknown): Error {
  const code = typeof error === 'object' && error != null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
  // Never retain a security dump attached as stdout/stderr on the thrown error.
  return Object.assign(new Error(`Keychain service enumeration failed${code ? `: ${code}` : ''}`), code ? { code } : {});
}

function parsedServiceAttribute(line: string): string | null {
  const quoted = /^\s*"svce"<blob>="([^"]*)"\s*$/.exec(line);
  if (quoted) return quoted[1];
  if (/^\s*"svce"<blob>=<NULL>\s*$/.test(line)) return null;
  const hex = /^\s*"svce"<blob>=0x([0-9a-fA-F]+)\s+"[^"]*"\s*$/.exec(line);
  if (hex && hex[1].length % 2 === 0) return Buffer.from(hex[1], 'hex').toString('utf8');
  throw new Error('unable to parse Keychain service attribute');
}

/** Lists matching service names only; it never reads Keychain credential bytes. */
function listKeychainServices(
  matcher: RegExp,
  dependencies: KeychainEnumerationDependencies,
): string[] {
  const keychain = dependencies.keychain ?? platformKeychain;
  if (keychain.kind === 'test-memory' && dependencies.platform === undefined && dependencies.exec === undefined) {
    const services = (keychain as ListingCredentialBackend).listServices;
    if (!services) throw new Error('test Keychain service enumeration is unavailable');
    return services().filter((service) => matcher.test(service));
  }
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    throw new Error('Keychain service enumeration is unavailable on this platform');
  }
  let output: string;
  try {
    output = String((dependencies.exec ?? execFileUtf8)(MACOS_SECURITY_BIN, ['dump-keychain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: MACOS_SECURITY_TIMEOUT_MS,
      maxBuffer: KEYCHAIN_DUMP_MAX_BUFFER,
    }));
  } catch (error) {
    if (isSecurityTimeout(error)) throw securityTimeoutError('dump-keychain');
    throw enumerationError(error);
  }
  const services: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('"svce"')) continue;
    const service = parsedServiceAttribute(line);
    if (service != null && matcher.test(service)) services.push(service);
  }
  return services;
}

/** Lists the Keychain-first unclaimed-stash index without reading secret bytes. */
export function listUnclaimedKeychainServices(dependencies: KeychainEnumerationDependencies = {}): string[] {
  return listKeychainServices(UNCLAIMED_SERVICE, dependencies);
}

/** Lists generic hand-back kept-copy names without reading secret bytes. */
export function listKeptKeychainServices(dependencies: KeychainEnumerationDependencies = {}): string[] {
  return listKeychainServices(KEPT_SERVICE, dependencies);
}

/**
 * READ-ONLY lookup of the native OpenRouter secret. The fixed allowlist is
 * enforced before any backend call: only the `pi-openrouter` service is
 * accepted. On macOS this is a service-only
 * `security find-generic-password -s <service> -w` lookup — the same argv
 * QLB has always used, so existing Keychain items keep working. On
 * Linux/Windows it reads account `qlb` from the platform store.
 *
 * Automated tests MUST NOT call this against a real store — inject a fake
 * `readNativeKey` into `createStaticKeyMigration` instead.
 */
export function openRouterMissingKeyMessage(service: string): string {
  return process.platform === 'darwin'
    ? `OpenRouter key not found in macOS Keychain (service ${service})`
    : `OpenRouter key not found in credential store (service ${service})`;
}

/** The only native OpenRouter lookup failure that means "not applicable". */
export class NativeOpenRouterKeyNotFoundError extends Error {
  constructor(service: string) {
    super(openRouterMissingKeyMessage(service));
    this.name = 'NativeOpenRouterKeyNotFoundError';
  }
}

export function isNativeOpenRouterKeyNotFound(error: unknown): boolean {
  return error instanceof NativeOpenRouterKeyNotFoundError;
}

/** Enforce the native OpenRouter reader's narrower service capability. */
export function assertNativeOpenRouterService(
  service: string,
  allowlistOptions: KeychainAllowlistOptions = {},
): void {
  assertKeychainAccess(service, NATIVE_SECRET_ACCOUNT, 'read', allowlistOptions);
  if (service !== OPENROUTER_KEYCHAIN_SERVICE) {
    throw new KeychainAccessDeniedError(
      service,
      'read',
      'only pi-openrouter is a valid native OpenRouter source',
    );
  }
}

export function readNativeOpenRouterKey(
  service: string,
  exec: ExecFileSyncFn = execFileUtf8,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isQlbTestMode() && !isFakeExecutor(exec)) throw new NativeKeychainDisabled();
  assertNativeOpenRouterService(service, isFakeExecutor(exec) ? { env: {} } : {});
  if (platform === 'darwin') {
    try {
      const stdout = exec(
        MACOS_SECURITY_BIN,
        ['find-generic-password', '-s', service, '-w'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: MACOS_SECURITY_TIMEOUT_MS,
        },
      );
      const key = String(stdout).replace(/\n$/, '').trim();
      if (key.length > 0) return key;
    } catch (err) {
      if (isSecurityTimeout(err)) throw securityTimeoutError('find-generic-password');
      // `security` uses errSecItemNotFound (44) for a missing item. stderr is
      // intentionally discarded here, so its stable wording is only a
      // secondary signal; a denial or other failure must remain operational.
      if (!isCredentialNotFound(err)) throw err;
    }
    throw new NativeOpenRouterKeyNotFoundError(service);
  }
  try {
    const key = rawPlatform.getSync(service, NATIVE_SECRET_ACCOUNT).trim();
    if (key.length > 0) return key;
  } catch (error) {
    // Other failures (timeouts, denial, disabled native access) are
    // operational errors and must remain visible to callers.
    if (!isCredentialNotFound(error)) throw error;
  }
  throw new NativeOpenRouterKeyNotFoundError(service);
}

/**
 * In-memory Keychain for tests. Never calls `security`. Same 3-method shape
 * as the real wrapper (`set`/`get`/`delete`), plus sync variants.
 */
export class MockKeychain implements KeychainBackend {
  readonly kind = 'test-memory' as const;
  private readonly items = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}\0${account}`;
  }

  setSync(service: string, account: string, jsonValue: string): void {
    this.items.set(this.key(service, account), jsonValue);
  }

  getSync(service: string, account: string): string {
    const value = this.items.get(this.key(service, account));
    if (value === undefined) {
      throw new Error(
        `keychain get failed for service=${service} account=${account}: item not found`,
      );
    }
    return value;
  }

  deleteSync(service: string, account: string): void {
    const k = this.key(service, account);
    if (!this.items.has(k)) {
      throw new Error(
        `keychain delete failed for service=${service} account=${account}: item not found`,
      );
    }
    this.items.delete(k);
  }

  async set(service: string, account: string, jsonValue: string): Promise<void> {
    this.setSync(service, account, jsonValue);
  }

  async get(service: string, account: string): Promise<string> {
    return this.getSync(service, account);
  }

  async delete(service: string, account: string): Promise<void> {
    this.deleteSync(service, account);
  }

  listServices(): string[] {
    return [...new Set([...this.items.keys()].map((key) => key.slice(0, key.indexOf('\0'))))];
  }
}
