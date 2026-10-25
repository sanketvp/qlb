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
  execFileUtf8,
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

export function withServiceGuard(
  backend: CredentialBackend,
  allowlistOptions: KeychainAllowlistOptions = {},
): CredentialBackend {
  // The test-mode backend is entirely in memory. Retain the production
  // capability matrix while allowing QLB tests to exercise fake credentials.
  const effectiveAllowlistOptions = backend.kind === 'test-memory'
    ? { ...allowlistOptions, env: {} }
    : allowlistOptions;
  return {
    kind: backend.kind,
    set(service, account, jsonValue) {
      assertKeychainAccess(service, account, 'write', effectiveAllowlistOptions);
      return backend.set(service, account, jsonValue);
    },
    get(service, account) {
      assertKeychainAccess(service, account, 'read', effectiveAllowlistOptions);
      return backend.get(service, account);
    },
    delete(service, account) {
      assertKeychainAccess(service, account, 'write', effectiveAllowlistOptions);
      return backend.delete(service, account);
    },
    setSync(service, account, jsonValue) {
      assertKeychainAccess(service, account, 'write', effectiveAllowlistOptions);
      backend.setSync(service, account, jsonValue);
    },
    getSync(service, account) {
      assertKeychainAccess(service, account, 'read', effectiveAllowlistOptions);
      return backend.getSync(service, account);
    },
    deleteSync(service, account) {
      assertKeychainAccess(service, account, 'write', effectiveAllowlistOptions);
      backend.deleteSync(service, account);
    },
  };
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
      const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
      const message = typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : undefined;
      if (status !== 44 && !(typeof message === 'string' && /(could not be found|item not found)/i.test(message))) throw err;
    }
    throw new NativeOpenRouterKeyNotFoundError(service);
  }
  try {
    const key = rawPlatform.getSync(service, NATIVE_SECRET_ACCOUNT).trim();
    if (key.length > 0) return key;
  } catch (error) {
    // The platform backends use this stable wording for an absent item. Other
    // failures (timeouts, denial, disabled native access) are operational
    // errors and must remain visible to callers.
    if (!(error instanceof Error) || !/item not found$/i.test(error.message)) throw error;
  }
  throw new NativeOpenRouterKeyNotFoundError(service);
}

/**
 * In-memory Keychain for tests. Never calls `security`. Same 3-method shape
 * as the real wrapper (`set`/`get`/`delete`), plus sync variants.
 */
export class MockKeychain implements KeychainBackend {
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
}
