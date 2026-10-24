import { join } from 'node:path';

export function loadUsage(provider: string): unknown {
  return require(join(__dirname, 'usage', provider));
}
