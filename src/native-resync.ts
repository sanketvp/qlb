// Detect native-credential drift and resync QLB's owned Keychain copy.
//
// Why this exists: QLB freezes a copy of each provider's credential at
// migration time. For shadow-retain / keychain-retain providers (xai,
// kimi-coding, openai-codex, openrouter) the native store is INTENTIONALLY
// left in place, so anything else on the machine can still refresh it.
// Anthropic uses rename-strategy, but a still-active native extension can
// resurrect/refresh the pool file during a partial rollout. Anthropic (and
// others) rotate the access token on every OAuth refresh, which silently
// invalidates QLB's frozen copy and surfaces as HTTP 401.
//
// Distinction that must stay sharp:
//   native access token DIFFERENT from QLB's copy → resync (write native
//     into the QLB Keychain item) and the caller may retry the request once.
//   native access token IDENTICAL → genuine revocation; do NOT retry.
//
// This is NOT a re-migration. No stage/rehearse/commit. One Keychain
// overwrite. Safe to call on every 401; never throws.

import { existsSync, readFileSync } from 'node:fs';

import type { KeychainBackend } from './keychain';
import { qlbKeychainService } from './keychain';
import {
  accountIdForSingleGrant,
  fingerprintApiKey,
  isSingleGrantProvider,
  isStaticKeyProvider,
  migrationStoreNameFor,
  parseApiKeyPayload,
  parseAuthJsonGrant,
  parsePoolFile,
  preQlbPath,
  type ApiKeyPayload,
  type SingleGrantProvider,
} from './migration';
import { parseGrant } from './refresh-lease';
import type { Store } from './store';
import type { Grant } from './types';

export type ResyncCredential = Grant | ApiKeyPayload;

export interface ResyncResult {
  /** true if native's credential differed and QLB's copy was updated */
  resynced: boolean;
  /** human-readable, for audit logging — never includes token material */
  reason: string;
}

export interface NativeResyncOpts {
  readNativeCredential: () => Promise<ResyncCredential | null>;
  readOwnedCredential: (
    keychain: KeychainBackend,
    accountId: string,
  ) => Promise<ResyncCredential | null>;
  writeOwnedCredential: (
    keychain: KeychainBackend,
    accountId: string,
    credential: ResyncCredential,
  ) => Promise<void>;
  keychain: KeychainBackend;
}

export interface NativeDriftReport {
  provider: string;
  accountId: string;
  level: 'PASS' | 'WARN';
  message: string;
  matches: boolean | null;
}

const OWNED_OR_LATER = new Set(['QLB_OWNED', 'RETIRED']);

export function isApiKeyCredential(c: ResyncCredential): c is ApiKeyPayload {
  return (c as ApiKeyPayload).type === 'api-key';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function grantFromAccess(
  access: string,
  refresh: string,
  extra?: Record<string, unknown>,
  expires?: number,
  generation?: number,
): Grant {
  const grant: Grant = {
    access,
    refresh,
    expires: expires ?? 0,
    generation: generation ?? 0,
  };
  if (extra) grant.extra = extra;
  return grant;
}

/**
 * Parse a QLB-owned Keychain payload. Accepts the Grant shape, api-key
 * payloads, and the openai-codex JWT / `tokens.access_token` shape used by
 * Codex CLI `auth.json` copies.
 */
export function parseResyncCredential(raw: string): ResyncCredential {
  const parsed: unknown = JSON.parse(raw);
  const obj = asRecord(parsed);
  if (!obj) {
    throw new Error('invalid credential JSON');
  }
  if (obj.type === 'api-key') return parseApiKeyPayload(raw);

  if (typeof obj.access === 'string' && obj.access.length > 0) {
    const extra = asRecord(obj.extra) ?? undefined;
    const grant: Grant = {
      access: obj.access,
      refresh: typeof obj.refresh === 'string' ? obj.refresh : '',
      expires: Number(obj.expires) || 0,
      generation: Number(obj.generation) || 0,
    };
    if (typeof obj.writtenBy === 'string') grant.writtenBy = obj.writtenBy;
    if (extra) grant.extra = extra;
    return grant;
  }

  const tokens = asRecord(obj.tokens);
  if (tokens && typeof tokens.access_token === 'string' && tokens.access_token.length > 0) {
    const extra: Record<string, unknown> = { shape: 'openai-codex-tokens' };
    if (typeof tokens.id_token === 'string') extra.id_token = tokens.id_token;
    if (typeof tokens.account_id === 'string') extra.accountId = tokens.account_id;
    return grantFromAccess(
      tokens.access_token,
      typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '',
      extra,
    );
  }

  if (typeof obj.access_token === 'string' && obj.access_token.length > 0) {
    return grantFromAccess(
      obj.access_token,
      typeof obj.refresh_token === 'string' ? obj.refresh_token : '',
      { shape: 'openai-codex-tokens' },
    );
  }

  return parseGrant(raw);
}

function accessOf(c: ResyncCredential | null | undefined): string | null {
  if (!c || typeof c.access !== 'string' || c.access.length === 0) return null;
  return c.access;
}

/** SHA-256 of the access token. Reuses migration's fingerprint helper. */
export function fingerprintAccess(access: string): string {
  return fingerprintApiKey(access);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mergeOwnedGeneration(
  native: ResyncCredential,
  owned: ResyncCredential | null,
): ResyncCredential {
  if (isApiKeyCredential(native)) {
    const out: ApiKeyPayload = { type: 'api-key', access: native.access, writtenBy: 'native-resync' };
    return out;
  }
  const ownedGen =
    owned && !isApiKeyCredential(owned) ? owned.generation : undefined;
  const grant: Grant = {
    ...native,
    generation: ownedGen ?? native.generation ?? 0,
    writtenBy: 'native-resync',
  };
  return grant;
}

/**
 * Compare native vs QLB-owned access tokens. If they differ, overwrite the
 * QLB Keychain item with native's current credential. Never throws.
 */
export async function detectAndResyncFromNative(
  provider: string,
  accountId: string,
  opts: NativeResyncOpts,
): Promise<ResyncResult> {
  try {
    let native: ResyncCredential | null;
    try {
      native = await opts.readNativeCredential();
    } catch (err) {
      return {
        resynced: false,
        reason: `native credential unreadable for ${provider}/${accountId}: ${errMessage(err)}`,
      };
    }
    const nativeAccess = accessOf(native);
    if (!native || !nativeAccess) {
      return {
        resynced: false,
        reason: `native credential unreadable for ${provider}/${accountId}`,
      };
    }

    let owned: ResyncCredential | null = null;
    try {
      owned = await opts.readOwnedCredential(opts.keychain, accountId);
    } catch (err) {
      owned = null;
      void err;
    }
    const ownedAccess = accessOf(owned);

    if (ownedAccess && fingerprintAccess(ownedAccess) === fingerprintAccess(nativeAccess)) {
      return {
        resynced: false,
        reason:
          'native credential identical to QLB copy (genuine revocation; re-auth required)',
      };
    }

    const toWrite = mergeOwnedGeneration(native, owned);
    try {
      await opts.writeOwnedCredential(opts.keychain, accountId, toWrite);
    } catch (err) {
      return {
        resynced: false,
        reason: `failed to write resynced credential for ${provider}/${accountId}: ${errMessage(err)}`,
      };
    }
    return {
      resynced: true,
      reason: ownedAccess
        ? `native credential differed from QLB copy for ${provider}/${accountId}; Keychain updated`
        : `QLB copy missing/unreadable for ${provider}/${accountId}; wrote native credential`,
    };
  } catch (err) {
    return {
      resynced: false,
      reason: `resync error for ${provider}/${accountId}: ${errMessage(err)}`,
    };
  }
}

export function nativeResyncAuditEntry(opts: {
  provider: string;
  accountId: string;
  result: ResyncResult;
}): Record<string, unknown> {
  return {
    kind: 'native_resync',
    provider: opts.provider,
    accountId: opts.accountId,
    resynced: opts.result.resynced,
    reason: opts.result.reason,
  };
}

/**
 * Retry-once helper for credential-serving paths.
 *
 * First attempt → if auth failure, resync exactly once → if resynced, attempt
 * again. A second auth failure does NOT resync again. `onResync` fires for
 * every resync attempt (success or genuine-revocation) so the audit trail
 * can tell recovered-via-resync from a real re-auth.
 */
export async function attemptWithNativeResyncRetry<T>(opts: {
  attempt: () => Promise<T>;
  isAuthFailure: (result: T) => boolean;
  resync: () => Promise<ResyncResult>;
  onResync?: (result: ResyncResult) => void;
  discardFirst?: (first: T) => void | Promise<void>;
}): Promise<{ result: T; resyncAttempted: ResyncResult | null; retried: boolean }> {
  const first = await opts.attempt();
  if (!opts.isAuthFailure(first)) {
    return { result: first, resyncAttempted: null, retried: false };
  }

  let resync: ResyncResult;
  try {
    resync = await opts.resync();
  } catch (err) {
    resync = { resynced: false, reason: `resync threw: ${errMessage(err)}` };
  }
  try {
    opts.onResync?.(resync);
  } catch {
    // audit must never break the request path
  }
  if (!resync.resynced) {
    return { result: first, resyncAttempted: resync, retried: false };
  }
  try {
    await opts.discardFirst?.(first);
  } catch {
    // best-effort drain
  }
  const second = await opts.attempt();
  return { result: second, resyncAttempted: resync, retried: true };
}

export function readOwnedCredentialFromKeychain(
  keychain: KeychainBackend,
  provider: string,
  accountId: string,
  label: string,
): ResyncCredential | null {
  const service = qlbKeychainService(provider, accountId);
  const names = [label, accountId].filter((n) => typeof n === 'string' && n.length > 0);
  const tried = new Set<string>();
  for (const account of names) {
    if (tried.has(account)) continue;
    tried.add(account);
    try {
      const raw = keychain.getSync(service, account);
      if (isStaticKeyProvider(provider)) return parseApiKeyPayload(raw);
      return parseResyncCredential(raw);
    } catch {
      // try the next account name (Codex adapter labels with JWT email,
      // while migration stores the item under the chatgpt_account_id).
    }
  }
  return null;
}

export function writeOwnedCredentialToKeychain(
  keychain: KeychainBackend,
  provider: string,
  accountId: string,
  label: string,
  credential: ResyncCredential,
): void {
  const service = qlbKeychainService(provider, accountId);
  const account = label || accountId;
  keychain.setSync(service, account, JSON.stringify(credential));
}

/**
 * Production native-credential reader. Tests MUST inject a fake
 * `readNativeCredential` instead of calling this against live files /
 * live OpenRouter Keychain.
 */
export function createNativeCredentialReader(opts: {
  poolFilePath: string;
  authJsonPath: string;
  readOpenRouterKey?: () => string;
}): (provider: string, accountId: string) => Promise<ResyncCredential | null> {
  return async (provider, accountId) => {
    try {
      if (provider === 'anthropic') {
        const live = opts.poolFilePath;
        const retired = preQlbPath(live);
        const path = existsSync(live) ? live : existsSync(retired) ? retired : null;
        if (!path) return null;
        const { accounts } = parsePoolFile(readFileSync(path, 'utf8'));
        const acct = accounts.find((a) => a.id === accountId);
        return acct?.grant ?? null;
      }
      if (isStaticKeyProvider(provider)) {
        const key = opts.readOpenRouterKey?.().trim();
        if (!key) return null;
        return { type: 'api-key', access: key, writtenBy: 'native-resync-read' };
      }
      if (isSingleGrantProvider(provider)) {
        if (!existsSync(opts.authJsonPath)) return null;
        const parsed = parseAuthJsonGrant(
          readFileSync(opts.authJsonPath, 'utf8'),
          provider,
        );
        const id = accountIdForSingleGrant(provider as SingleGrantProvider, parsed);
        if (id !== accountId) return null;
        const extra: Record<string, unknown> = {
          type: parsed.type ?? 'oauth',
          authJsonKey: provider,
        };
        if (parsed.accountId) extra.accountId = parsed.accountId;
        const grant: Grant = {
          access: parsed.access,
          refresh: parsed.refresh,
          expires: parsed.expires,
          generation: 0,
          extra,
        };
        return grant;
      }
      return null;
    } catch {
      return null;
    }
  };
}

export function bindDetectAndResync(opts: {
  keychain: KeychainBackend;
  store: Store;
  readNativeCredential: (
    provider: string,
    accountId: string,
  ) => Promise<ResyncCredential | null>;
}): (accountId: string, provider: string) => Promise<ResyncResult> {
  return async (accountId, provider) => {
    const acct = opts.store.getAccount(accountId);
    const label = acct?.label || accountId;
    return detectAndResyncFromNative(provider, accountId, {
      keychain: opts.keychain,
      readNativeCredential: () => opts.readNativeCredential(provider, accountId),
      readOwnedCredential: async (keychain, id) =>
        readOwnedCredentialFromKeychain(keychain, provider, id, label),
      writeOwnedCredential: async (keychain, id, credential) => {
        writeOwnedCredentialToKeychain(keychain, provider, id, label, credential);
      },
    });
  };
}

function nativeExpectedToExist(provider: string): boolean {
  // Anthropic rename-strategy: native pool may be gone after commit.
  // Shadow-retain / keychain-retain: native is supposed to still be there.
  return provider !== 'anthropic';
}

/**
 * Read-only drift report for `qlb doctor`. Never writes Keychain.
 */
export async function inspectOwnedNativeDrift(opts: {
  accounts: Array<{ id: string; provider: string; label: string }>;
  migrations: Array<{ store: string; state: string }>;
  readNativeCredential: (
    provider: string,
    accountId: string,
  ) => Promise<ResyncCredential | null>;
  readOwnedCredential: (
    provider: string,
    accountId: string,
    label: string,
  ) => Promise<ResyncCredential | null>;
}): Promise<NativeDriftReport[]> {
  const ownedStores = new Set(
    opts.migrations
      .filter((m) => OWNED_OR_LATER.has(m.state))
      .map((m) => m.store),
  );
  const reports: NativeDriftReport[] = [];
  for (const acct of opts.accounts) {
    const storeName = migrationStoreNameFor(acct.provider);
    if (!ownedStores.has(storeName)) continue;

    let native: ResyncCredential | null = null;
    let owned: ResyncCredential | null = null;
    try {
      native = await opts.readNativeCredential(acct.provider, acct.id);
    } catch {
      native = null;
    }
    try {
      owned = await opts.readOwnedCredential(acct.provider, acct.id, acct.label);
    } catch {
      owned = null;
    }
    const nativeAccess = accessOf(native);
    const ownedAccess = accessOf(owned);

    if (!ownedAccess) {
      reports.push({
        provider: acct.provider,
        accountId: acct.id,
        level: 'WARN',
        matches: null,
        message: `QLB_OWNED account ${acct.id} (${acct.provider}): QLB Keychain copy unreadable`,
      });
      continue;
    }
    if (!nativeAccess) {
      const expected = nativeExpectedToExist(acct.provider);
      reports.push({
        provider: acct.provider,
        accountId: acct.id,
        level: expected ? 'WARN' : 'PASS',
        matches: null,
        message: expected
          ? `QLB_OWNED account ${acct.id} (${acct.provider}): native credential unreadable (shadow-retain native should still exist)`
          : `QLB_OWNED account ${acct.id} (${acct.provider}): native store not present (rename-strategy); no drift comparison`,
      });
      continue;
    }
    const matches = fingerprintAccess(ownedAccess) === fingerprintAccess(nativeAccess);
    reports.push({
      provider: acct.provider,
      accountId: acct.id,
      level: matches ? 'PASS' : 'WARN',
      matches,
      message: matches
        ? `QLB Keychain copy matches native for ${acct.id} (${acct.provider})`
        : `QLB Keychain copy DIFFERS from native for ${acct.id} (${acct.provider}) — native may have refreshed independently; next 401 will auto-resync`,
    });
  }
  return reports;
}
