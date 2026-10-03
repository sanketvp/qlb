// Read-only GET of the active Claude Code Keychain item.
// Allowlisted argv only. Never writes. Never submits a refresh token.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

export const ACTIVE_CC_SERVICE = 'Claude Code-credentials';
export const SECURITY_BIN = '/usr/bin/security';
export const FALLBACK_ACCOUNT = 'claude-code-user';

export interface SecurityRunner {
  (executable: string, args: readonly string[]): string;
}

export interface ConsumedAccess {
  access: string;
  expiresAt: number;
  fingerprint: string;
}

export function activeKeychainAccount(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.USER;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  try {
    const name = userInfo().username;
    if (typeof name === 'string' && name.length > 0) return name;
  } catch {
    // fall through
  }
  return FALLBACK_ACCOUNT;
}

export function activeCcSecurityArgs(account: string): string[] {
  return ['find-generic-password', '-a', account, '-w', '-s', ACTIVE_CC_SERVICE];
}

function defaultRunner(executable: string, args: readonly string[]): string {
  return execFileSync(executable, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function fingerprintAccess(access: string): string {
  return createHash('sha256').update(access, 'utf8').digest('hex');
}

export function parseActiveCcBlob(raw: string, nowMs: number = Date.now()): ConsumedAccess {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('active Claude Code credential unreadable');
  }
  const root = asRecord(parsed);
  const oauth = asRecord(root?.claudeAiOauth);
  const access = oauth?.accessToken;
  const expiresAt = oauth?.expiresAt;
  if (typeof access !== 'string' || access.length === 0) {
    throw new Error('active Claude Code credential missing access');
  }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new Error('active Claude Code credential missing expiry');
  }
  if (expiresAt < nowMs) {
    throw new Error('active Claude Code credential expired');
  }
  return {
    access,
    expiresAt,
    fingerprint: fingerprintAccess(access),
  };
}

export function getActiveClaudeCodeAccess(opts: {
  runner?: SecurityRunner;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
} = {}): ConsumedAccess {
  const account = activeKeychainAccount(opts.env);
  const args = activeCcSecurityArgs(account);
  const runner = opts.runner ?? defaultRunner;
  let stdout: string;
  try {
    stdout = runner(SECURITY_BIN, args);
  } catch {
    throw new Error('active Claude Code credential unreadable');
  }
  return parseActiveCcBlob(String(stdout).replace(/\n$/, ''), opts.nowMs);
}
