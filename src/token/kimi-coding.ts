import { platformKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from '../keychain';
import type { TokenResolution, TokenResolverDeps } from './xai';

function credentialUnavailable(): Error {
  return new Error('credential unavailable');
}

/** Resolves the QLB-owned Kimi Coding OAuth access token without refreshing it. */
export function resolve({ keychain = platformKeychain }: TokenResolverDeps = {}): TokenResolution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keychain.getSync(qlbKeychainService('kimi-coding', 'default'), QLB_KEYCHAIN_ACCOUNT));
  } catch {
    throw credentialUnavailable();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw credentialUnavailable();
  const credential = parsed as { access?: unknown; expires?: unknown };
  if (typeof credential.access !== 'string' || credential.access.length === 0) throw credentialUnavailable();
  const expiresAt = typeof credential.expires === 'number' && Number.isFinite(credential.expires)
    ? credential.expires
    : undefined;
  return { token: credential.access, accountId: 'default', ...(expiresAt === undefined ? {} : { expiresAt }), source: 'keychain' };
}
