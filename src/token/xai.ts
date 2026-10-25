import { platformKeychain, qlbKeychainService, type KeychainBackend } from '../keychain';

export interface TokenResolution {
  token: string;
  accountId: 'default';
  expiresAt?: number;
  source: 'keychain';
}

export interface TokenResolverDeps {
  keychain?: Pick<KeychainBackend, 'getSync'>;
}

function credentialUnavailable(): Error {
  return new Error('credential unavailable');
}

/** Resolves the QLB-owned xAI OAuth access token without refreshing it. */
export function resolve({ keychain = platformKeychain }: TokenResolverDeps = {}): TokenResolution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keychain.getSync(qlbKeychainService('xai', 'default'), 'default'));
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
