import type { GateCredential } from '../pi-gate';
import { resolve as resolveToken } from '../token/openrouter';
import type { TokenResolverDeps } from '../token/xai';

export interface OpenRouterGateDeps extends TokenResolverDeps {
  resolve?: typeof resolveToken;
}

/** OpenRouter has a static QLB-owned API key; its gate never refreshes it. */
export function read(deps: OpenRouterGateDeps = {}): GateCredential {
  const resolution = (deps.resolve ?? resolveToken)(deps);
  return {
    token: resolution.token,
    accountId: resolution.accountId,
    source: resolution.source,
  };
}

export default { read };
