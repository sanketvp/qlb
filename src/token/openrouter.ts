import { platformKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from '../keychain';
import type { TokenResolution, TokenResolverDeps } from './xai';

/** Canonical QLB credential location consumed by the OpenRouter Pi gate. */
export const OPENROUTER_GATE_KEYCHAIN_SERVICE = qlbKeychainService('openrouter', 'default');

function credentialUnavailable(): Error {
  return new Error('credential unavailable');
}

/** Resolves the QLB-owned OpenRouter API key; native `pi-openrouter` is never read here. */
export function resolve({ keychain = platformKeychain }: TokenResolverDeps = {}): TokenResolution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keychain.getSync(qlbKeychainService('openrouter', 'default'), QLB_KEYCHAIN_ACCOUNT));
  } catch {
    throw credentialUnavailable();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw credentialUnavailable();
  const credential = parsed as { type?: unknown; access?: unknown };
  if (credential.type !== 'api-key' || typeof credential.access !== 'string' || credential.access.length === 0) {
    throw credentialUnavailable();
  }
  return { token: credential.access, accountId: 'default', source: 'keychain' };
}
