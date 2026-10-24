import { join } from 'node:path';

import { KNOWN_PROVIDER_NAMES } from './registry';

const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/;

type RequireModule = (id: string) => unknown;
type JoinPath = (...parts: string[]) => string;

export interface ProviderLoaderOptions {
  requireModule?: RequireModule;
  joinPath?: JoinPath;
}

/**
 * Load a legacy provider stub only after accepting its registry-owned identifier.
 * The guard deliberately runs before path construction so provider input cannot
 * escape a stub directory.
 */
export function loadProviderStub(
  provider: string,
  directory: string,
  options: ProviderLoaderOptions = {},
): unknown {
  if (!PROVIDER_NAME.test(provider) || !(KNOWN_PROVIDER_NAMES as readonly string[]).includes(provider)) {
    throw new Error(`unknown provider: ${provider}`);
  }
  const joinPath = options.joinPath ?? join;
  const requireModule = options.requireModule ?? module.require.bind(module);
  return requireModule(joinPath(directory, provider));
}
