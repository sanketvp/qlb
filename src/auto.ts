import { join } from 'node:path';

import { loadProviderStub } from './provider-loader';

/** Provider module loader. The polling loop is added by slice K7. */
export function loadAutoProvider(provider: string): unknown {
  return loadProviderStub(provider, join(__dirname, 'auto'));
}
