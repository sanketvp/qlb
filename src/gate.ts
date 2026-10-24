import { join } from 'node:path';

export function loadGate(provider: string): unknown {
  return require(join(__dirname, 'gate', provider));
}
