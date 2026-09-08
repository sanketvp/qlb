// Platform-dispatching credential store for QLB (§4.8.1).
//
// SAFETY: this module never hardcodes real credential file paths and refuses
// Keychain / credential-store service names that do not start with `qlb:` or
// `qlb-test-`. Phase 2a does not import, move, or delete any live credentials.
// Real OAuth grants are Phase 2b, via an explicit user-triggered command.
//
// All subprocess invocations use `execFile`/`execFileSync` with an argv array
// (never `exec` + string interpolation) to avoid shell injection. Secrets are
// never passed as command-line arguments on Linux/Windows (stdin only).

import { execFileSync } from 'node:child_process';

import {
  createRawCredentialBackend,
  defaultCredentialBackendHost,
  type CredentialBackend,
} from './credential-backends';

export type {
  CredentialBackend,
  CredentialBackendHost,
  CredentialBackendKind,
  ExecFileSyncFn,
} from './credential-backends';
export {
  MacosKeychainBackend,
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
} from './credential-backends';

/** Existing name used by migration / refresh-lease / credentials. */
export type KeychainBackend = CredentialBackend;

const SAFE_SERVICE_PREFIXES = ['qlb:', 'qlb-test-'] as const;

/** Account used when looking up unscoped native secrets (OpenRouter). */
export const NATIVE_SECRET_ACCOUNT = 'qlb';

export function isSafeKeychainService(service: string): boolean {
  return SAFE_SERVICE_PREFIXES.some((p) => service.startsWith(p));
}

export function assertSafeKeychainService(service: string): void {
  if (!isSafeKeychainService(service)) {
    throw new Error(
      `refusing Keychain operation for service '${service}': service name must start with 'qlb:' or 'qlb-test-'`,
    );
  }
}

/** Spec §4.8.1 / task convention: service `qlb:<provider>:<accountId>`. */
export function qlbKeychainService(provider: string, accountId: string): string {
  return `qlb:${provider}:${accountId}`;
}

export function withServiceGuard(backend: CredentialBackend): CredentialBackend {
  return {
    kind: backend.kind,
    set(service, account, jsonValue) {
      assertSafeKeychainService(service);
      return backend.set(service, account, jsonValue);
    },
    get(service, account) {
      assertSafeKeychainService(service);
      return backend.get(service, account);
    },
    delete(service, account) {
      assertSafeKeychainService(service);
      return backend.delete(service, account);
    },
    setSync(service, account, jsonValue) {
      assertSafeKeychainService(service);
      backend.setSync(service, account, jsonValue);
    },
    getSync(service, account) {
      assertSafeKeychainService(service);
      return backend.getSync(service, account);
    },
    deleteSync(service, account) {
      assertSafeKeychainService(service);
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
 * READ-ONLY lookup of a native (non-`qlb:`) secret. Used for OpenRouter's
 * `pi-openrouter` item. Never writes. On macOS this is a service-only
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

export function readNativeOpenRouterKey(service: string): string {
  if (process.platform === 'darwin') {
    try {
      const stdout = execFileSync(
        'security',
        ['find-generic-password', '-s', service, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const key = String(stdout).replace(/\n$/, '').trim();
      if (key.length > 0) return key;
    } catch {
      // Normalize Keychain lookup failures without exposing command output.
    }
    throw new Error(openRouterMissingKeyMessage(service));
  }
  try {
    const key = rawPlatform.getSync(service, NATIVE_SECRET_ACCOUNT).trim();
    if (key.length > 0) return key;
  } catch {
    // Normalize lookup failures without exposing command output.
  }
  throw new Error(openRouterMissingKeyMessage(service));
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
