// macOS Keychain wrapper for QLB credential storage (§4.8.1).
//
// SAFETY: this module never hardcodes real credential file paths and refuses
// Keychain service names that do not start with `qlb:` or `qlb-test-`. Phase 2a
// does not import, move, or delete any live credentials. Real OAuth grants are
// Phase 2b, via an explicit user-triggered command.
//
// All `security` invocations use `execFile`/`execFileSync` with an argv array
// (never `exec` + string interpolation) to avoid shell injection.

import { execFileSync } from 'node:child_process';

const SAFE_SERVICE_PREFIXES = ['qlb:', 'qlb-test-'] as const;

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

export interface KeychainBackend {
  set(service: string, account: string, jsonValue: string): Promise<void>;
  get(service: string, account: string): Promise<string>;
  delete(service: string, account: string): Promise<void>;
  /** Sync variants for use inside a SQLite BEGIN IMMEDIATE (§4.8.2 step 5). */
  setSync(service: string, account: string, jsonValue: string): void;
  getSync(service: string, account: string): string;
  deleteSync(service: string, account: string): void;
}

function wrapSecurityError(
  op: string,
  service: string,
  account: string,
  err: unknown,
): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(
    `keychain ${op} failed for service=${service} account=${account}: ${msg}`,
  );
}

export function keychainSetSync(
  service: string,
  account: string,
  jsonValue: string,
): void {
  assertSafeKeychainService(service);
  try {
    execFileSync(
      'security',
      ['add-generic-password', '-a', account, '-s', service, '-w', jsonValue, '-U'],
      { encoding: 'utf8' },
    );
  } catch (err) {
    throw wrapSecurityError('set', service, account, err);
  }
}

export function keychainGetSync(service: string, account: string): string {
  assertSafeKeychainService(service);
  try {
    const stdout = execFileSync(
      'security',
      ['find-generic-password', '-a', account, '-s', service, '-w'],
      { encoding: 'utf8' },
    );
    return stdout.replace(/\n$/, '');
  } catch (err) {
    throw wrapSecurityError('get', service, account, err);
  }
}

export function keychainDeleteSync(service: string, account: string): void {
  assertSafeKeychainService(service);
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-a', account, '-s', service],
      { encoding: 'utf8' },
    );
  } catch (err) {
    throw wrapSecurityError('delete', service, account, err);
  }
}

export async function keychainSet(
  service: string,
  account: string,
  jsonValue: string,
): Promise<void> {
  keychainSetSync(service, account, jsonValue);
}

export async function keychainGet(
  service: string,
  account: string,
): Promise<string> {
  return keychainGetSync(service, account);
}

export async function keychainDelete(
  service: string,
  account: string,
): Promise<void> {
  keychainDeleteSync(service, account);
}

export const macosKeychain: KeychainBackend = {
  set: keychainSet,
  get: keychainGet,
  delete: keychainDelete,
  setSync: keychainSetSync,
  getSync: keychainGetSync,
  deleteSync: keychainDeleteSync,
};

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
