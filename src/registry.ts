import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface CommandDefinition {
  name: string;
  run(args: string[]): string[];
}

export interface CheckDefinition {
  name: string;
}

/** Provider identifiers accepted by the legacy provider-module loaders. */
export const KNOWN_PROVIDER_NAMES = [
  'anthropic',
  'xai',
  'openai-codex',
  'kimi-coding',
  'openrouter',
] as const;

type ModuleLoader = (id: string) => unknown;

function isNamed(value: unknown): value is { name: string } {
  return !!value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string';
}

function runtimeExtensions(): string[] {
  // ts-node preserves this module's .ts filename; compiled CLIs load .js only.
  return [__filename.endsWith('.ts') ? '.ts' : '.js'];
}

function loadDefinitions<T extends { name: string }>(
  directory: string,
  extensions = runtimeExtensions(),
  loadModule: ModuleLoader = module.require.bind(module),
): T[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.includes(extname(entry.name)) && !entry.name.startsWith('_'))
    .map((entry) => {
      const loaded = loadModule(join(directory, entry.name)) as { default?: unknown };
      if (!isNamed(loaded.default)) {
        throw new Error(`registry entry ${entry.name} must default-export a named definition`);
      }
      return loaded.default as T;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverCommands(
  directory = join(__dirname, 'commands'),
  extensions?: string[],
  loadModule?: ModuleLoader,
): CommandDefinition[] {
  return loadDefinitions<CommandDefinition>(directory, extensions, loadModule);
}

export function discoverChecks(
  directory = join(__dirname, 'checks'),
  extensions?: string[],
  loadModule?: ModuleLoader,
): CheckDefinition[] {
  return loadDefinitions<CheckDefinition>(directory, extensions, loadModule);
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
