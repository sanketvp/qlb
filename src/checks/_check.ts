import type { CheckDefinition } from '../registry';

export function check(name: string): CheckDefinition {
  return { name };
}
