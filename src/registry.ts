import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface CommandDefinition {
  name: string;
  run(args: string[]): string[];
}

export interface CheckDefinition {
  name: string;
}

function isNamed(value: unknown): value is { name: string } {
  return !!value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string';
}

function loadDefinitions<T extends { name: string }>(directory: string): T[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.js$/.test(entry.name) && !entry.name.startsWith('_'))
    .map((entry) => {
      // Node resolves discovered CommonJS files; binding preserves the caller module's resolution.
      const loadModule: (id: string) => unknown = module.require.bind(module);
      const loaded = loadModule(join(directory, entry.name)) as { default?: unknown };
      if (!isNamed(loaded.default)) {
        throw new Error(`registry entry ${entry.name} must default-export a named definition`);
      }
      return loaded.default as T;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverCommands(directory = join(__dirname, 'commands')): CommandDefinition[] {
  return loadDefinitions<CommandDefinition>(directory);
}

export function discoverChecks(directory = join(__dirname, 'checks')): CheckDefinition[] {
  return loadDefinitions<CheckDefinition>(directory);
}

export function resolveCommand(argv: string[], commands = discoverCommands()): {
  command: CommandDefinition;
  args: string[];
} | null {
  const candidates = commands
    .map((command) => ({ command, words: command.name.split(' ') }))
    .filter(({ words }) => words.every((word, index) => argv[index] === word))
    .sort((a, b) => b.words.length - a.words.length);
  const match = candidates[0];
  return match ? { command: match.command, args: argv.slice(match.words.length) } : null;
}
