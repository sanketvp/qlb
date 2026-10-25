// Ported from claude-swap 0.26.0 (MIT, Copyright (c) realiti4) — macos_keychain.py, session.py
// Fixed Keychain capability policy for QLB and the C-swap credential import.

import { AsyncLocalStorage } from 'node:async_hooks';
import { userInfo } from 'node:os';

import { OPENROUTER_KEYCHAIN_SERVICE } from './config';

export type KeychainOperation = 'read' | 'write';

interface UndoCapability {
  active: boolean;
}

const undoCapabilityStorage = new AsyncLocalStorage<UndoCapability>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as PromiseLike<unknown>).then === 'function';
}

/**
 * Runs work with the otherwise read-only C-swap write/delete capability.
 *
 * The capability is scoped to this async call chain and is revoked on either
 * synchronous return/throw or asynchronous settlement.
 */
export function withUndoCapability<T>(fn: () => T): T {
  const capability: UndoCapability = { active: true };
  return undoCapabilityStorage.run(capability, () => {
    try {
      const result = fn();
      if (isPromiseLike(result)) {
        return Promise.resolve(result).finally(() => {
          capability.active = false;
        }) as T;
      }
      capability.active = false;
      return result;
    } catch (err) {
      capability.active = false;
      throw err;
    }
  });
}

function hasUndoCapability(): boolean {
  return undoCapabilityStorage.getStore()?.active === true;
}

export const MACOS_KEYCHAIN_ACCOUNT_FALLBACK = 'claude-code-user';

export interface KeychainAllowlistOptions {
  /** Injectable only for tests; production uses Claude Code's username rule. */
  macosUserName?: () => string;
  /** Injectable only for fake-backend policy tests; production uses process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Raised before a forbidden Keychain subprocess can be invoked. */
export class KeychainAccessDeniedError extends Error {
  readonly code = 'KEYCHAIN_ACCESS_DENIED';
  readonly service: string;
  readonly operation: KeychainOperation;

  constructor(service: string, operation: KeychainOperation, reason: string) {
    super(`refusing Keychain ${operation} for service '${service}': ${reason}`);
    this.name = 'KeychainAccessDeniedError';
    this.service = service;
    this.operation = operation;
  }
}

function isQlbTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QLB_TEST_MODE === '1';
}

const CLAUDE_CODE_CREDENTIALS = 'Claude Code-credentials';
const CLAUDE_CODE_CREDENTIALS_RE = /^Claude Code-credentials-[0-9a-f]{8}$/;

/**
 * Claude Code's macOS Keychain account convention, mirrored from C-swap:
 * `$USER`, then the operating-system account name, then a stable fallback.
 */
export function macosKeychainAccountName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.USER) return env.USER;
  try {
    return userInfo().username;
  } catch {
    return MACOS_KEYCHAIN_ACCOUNT_FALLBACK;
  }
}

function isClaudeCodeCredentialsService(service: string): boolean {
  return service === CLAUDE_CODE_CREDENTIALS || CLAUDE_CODE_CREDENTIALS_RE.test(service);
}

/** Whether a service is recognized by the fixed capability allowlist. */
export function isAllowedKeychainService(service: string): boolean {
  if (isQlbTestMode()) return false;
  return service.startsWith('qlb:')
    || service.startsWith('qlb-test-')
    || service === 'claude-swap'
    || service === OPENROUTER_KEYCHAIN_SERVICE
    || isClaudeCodeCredentialsService(service);
}

/**
 * Enforce the fixed Keychain capability allowlist before any backend call.
 * `claude-swap` is import-only, while Claude Code's credential items must use
 * the same account name that Claude Code itself derives on macOS.
 */
export function assertKeychainAccess(
  service: string,
  account: string,
  operation: KeychainOperation,
  options: KeychainAllowlistOptions = {},
): void {
  if (isQlbTestMode(options.env)) {
    throw new KeychainAccessDeniedError(service, operation, 'native Keychain access is disabled in test mode');
  }
  if (service.startsWith('qlb:') || service.startsWith('qlb-test-')) return;

  if (service === 'claude-swap' || service === OPENROUTER_KEYCHAIN_SERVICE) {
    if (operation === 'read') return;
    if (service === 'claude-swap' && hasUndoCapability()) return;
    throw new KeychainAccessDeniedError(service, operation, `${service} is read-only`);
  }

  if (isClaudeCodeCredentialsService(service)) {
    const expectedAccount = (options.macosUserName ?? macosKeychainAccountName)();
    if (account === expectedAccount) return;
    throw new KeychainAccessDeniedError(
      service,
      operation,
      'account name must match the macOS user name',
    );
  }

  throw new KeychainAccessDeniedError(service, operation, 'service is not allowlisted');
}
