/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/credentials.py:191-304,789-793,1033-1058.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteText } from './fsutil';
import { macosKeychainAccountName } from './keychain';
import { type CredentialBackend } from './credential-backends';
import { claudePaths, type ClaudePaths } from './cc-paths';

export { InMemoryCredentialBackend } from './credential-backends';

export const SHARED_CREDENTIAL_KEYS = [
  'mcpOAuth',
  'mcpOAuthClientConfig',
  'mcpXaaIdp',
  'mcpXaaIdpConfig',
  'pluginSecrets',
] as const;

export class ClaudeConfigFileError extends Error {
  constructor(path: string, reason: string) {
    super(`Claude config file is unreadable at ${path}: ${reason}`);
    this.name = 'ClaudeConfigFileError';
  }
}

type JsonObject = Record<string, unknown>;

export interface ClaudeCredentialsOptions {
  /** Keychain effects are always dependency-injected. */
  backend: CredentialBackend;
  paths?: ClaudePaths;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** The caller supplies the OS account in tests; production mirrors Claude Code. */
  account?: string;
  /** Injected to make fixture-only filesystem effects explicit. */
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
  writeText?: (path: string, text: string) => void;
}

function credentialObject(credentials: string | null | undefined): JsonObject | null {
  if (!credentials || looksLikeApiKey(credentials)) return null;
  try {
    const value: unknown = JSON.parse(credentials);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : null;
  } catch {
    return null;
  }
}

/** A bare non-OAuth sk-ant-* value is a managed API key, not an OAuth blob. */
export function looksLikeApiKey(credentials: string | null | undefined): boolean {
  if (!credentials) return false;
  const text = credentials.trim();
  return !text.startsWith('{') && text.startsWith('sk-ant-') &&
    !text.startsWith('sk-ant-oat') && !text.startsWith('sk-ant-ort');
}

/** Return only the live-owned shared fields, including an authoritative empty object. */
export function sharedCredentialFields(credentials: string | null | undefined): JsonObject | null {
  const parsed = credentialObject(credentials);
  if (parsed === null) return null;
  const fields: JsonObject = {};
  for (const key of SHARED_CREDENTIAL_KEYS) {
    if (key in parsed) fields[key] = parsed[key];
  }
  return fields;
}

/** Compose target credentials with the live machine-shared fields only. */
export function mergeSharedCredentialFields(targetCredentials: string, sharedFields: JsonObject): string {
  const target = credentialObject(targetCredentials);
  if (target === null || !('claudeAiOauth' in target)) return targetCredentials;
  const composed: JsonObject = {};
  for (const [key, value] of Object.entries(target)) {
    if (!(SHARED_CREDENTIAL_KEYS as readonly string[]).includes(key)) composed[key] = value;
  }
  Object.assign(composed, sharedFields);
  return JSON.stringify(composed);
}

function defaultRead(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Read a config object. Missing, malformed, scalar, or array config is a hard
 * error: S22 deliberately refuses a lossy switch instead of salvaging it.
 */
export function readClaudeConfig(path: string, readText: (path: string) => string = defaultRead): JsonObject {
  let text: string;
  try {
    text = readText(path);
  } catch (error) {
    throw new ClaudeConfigFileError(path, error instanceof Error ? error.message : String(error));
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top level must be a JSON object');
    }
    return parsed as JsonObject;
  } catch (error) {
    throw new ClaudeConfigFileError(path, error instanceof Error ? error.message : String(error));
  }
}

/** Replace exactly oauthAccount, preserving every other config field. */
export function spliceOauthAccount(
  path: string,
  oauthAccount: JsonObject,
  options: Pick<ClaudeCredentialsOptions, 'readText' | 'writeText'> = {},
): void {
  const config = readClaudeConfig(path, options.readText ?? defaultRead);
  config.oauthAccount = oauthAccount;
  const text = `${JSON.stringify(config, null, 2)}\n`;
  (options.writeText ?? ((target, value) => { atomicWriteText(target, value, { mode: 0o600 }); }))(path, text);
}

/**
 * Refresh an existing plaintext credential file to notify Claude Code. It never
 * creates a new file, and fsutil's private temp is always beside that fixture.
 */
export function rewriteCredentialsFileIfPresent(
  path: string,
  credentials: string,
  options: Pick<ClaudeCredentialsOptions, 'exists' | 'writeText'> = {},
): boolean {
  if (!(options.exists ?? existsSync)(path)) return false;
  (options.writeText ?? ((target, value) => { atomicWriteText(target, value, { mode: 0o600 }); }))(path, credentials);
  return true;
}

function resolvedPaths(options: ClaudeCredentialsOptions): ClaudePaths {
  return options.paths ?? claudePaths({ home: options.home, env: options.env });
}

function resolvedAccount(options: ClaudeCredentialsOptions): string {
  return options.account ?? macosKeychainAccountName(options.env);
}

/** Read the live OAuth blob exclusively through the injected credential backend. */
export async function readLiveClaudeCredentials(options: ClaudeCredentialsOptions): Promise<string> {
  const paths = resolvedPaths(options);
  return options.backend.get(paths.keychainService, resolvedAccount(options));
}

/**
 * Publish the live Keychain credential, then best-effort rewrite a pre-existing
 * plaintext file. The Keychain write remains authoritative; a file failure is
 * reported to the caller as `credentialsFileRefreshed: false` rather than
 * undoing the successful credential write.
 */
export async function writeLiveClaudeCredentials(
  credentials: string,
  options: ClaudeCredentialsOptions,
): Promise<{ credentialsFileRefreshed: boolean }> {
  const paths = resolvedPaths(options);
  await options.backend.set(paths.keychainService, resolvedAccount(options), credentials);
  try {
    return {
      credentialsFileRefreshed: rewriteCredentialsFileIfPresent(paths.credentialsPath, credentials, options),
    };
  } catch {
    return { credentialsFileRefreshed: false };
  }
}
