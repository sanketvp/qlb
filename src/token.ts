import { join } from 'node:path';

import { loadProviderStub } from './provider-loader';

export function loadTokenResolver(provider: string): unknown {
  return loadProviderStub(provider, join(__dirname, 'token'));
}
