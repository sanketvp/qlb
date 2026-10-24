import { join } from 'node:path';

/** Provider module loader. The polling loop is added by slice K7. */
export function loadAutoProvider(provider: string): unknown {
  return require(join(__dirname, 'auto', provider));
}
