import { join } from 'node:path';

export function loadTokenResolver(provider: string): unknown {
  return require(join(__dirname, 'token', provider));
}
