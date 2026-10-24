import type { CheckDefinition } from '../registry';

export function check(name: string, prefix?: string): CheckDefinition {
  return prefix ? { name, prefix } : { name };
}
