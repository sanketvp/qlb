import type { CommandDefinition } from '../registry';

export function legacyCommand(name: string, legacy: string[] = name.split(' ')): CommandDefinition {
  return {
    name,
    run: (args) => [...legacy, ...args],
  };
}
