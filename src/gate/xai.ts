import { resolve, type TokenResolution } from '../token/xai';
import type { GateCredential, ProviderGate } from '../pi-gate';

export interface XaiGateDeps {
  /** Injectable for tests; production resolves through P6's Keychain-backed resolver. */
  resolve?: () => TokenResolution;
}

/**
 * Read the current xAI access token. Refresh ownership moves to P13's
 * single-consume gate; this module intentionally does no direct refresh.
 */
export function read(deps: XaiGateDeps = {}): GateCredential {
  const credential = (deps.resolve ?? resolve)();
  return {
    token: credential.token,
    accountId: credential.accountId,
    ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    source: credential.source,
  };
}

/** P13 replaces this hook with single-consume's wait-for-winner refresh. */
export async function refresh(): Promise<never> {
  throw new Error('not-implemented');
}

const gate: ProviderGate = { read, refresh };
export default gate;
