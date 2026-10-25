import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { QlbConfig, ResolveConfigOptions } from './config';

export interface CommandContext {
  stdout(message: string): void;
  stderr(message: string): void;
  env: NodeJS.ProcessEnv;
  config: QlbConfig;
  loadConfig(options?: ResolveConfigOptions): QlbConfig;
  home: string;
  /** Register any runtime credential before it can appear in command output or an error. */
  registerSecret(value: string): void;
  /** Registered runtime credentials, retained across copied or wrapped contexts. */
  knownSecrets(): readonly string[];
}

export interface CommandDefinition {
  name: string;
  /** Rewrites argv for a command still handled by cli.ts's legacy parser. */
  run?: (args: string[]) => string[];
  /** Runs a self-contained command fragment and returns its process exit code. */
  execute?: (args: string[], ctx: CommandContext) => Promise<number> | number;
}

export interface CheckDefinition {
  name: string;
  /** Also accepts dynamic doctor result names under this colon-delimited prefix. */
  prefix?: string;
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
): Array<{ definition: T; moduleName: string }> {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.includes(extname(entry.name)) && !entry.name.startsWith('_'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const loaded = loadModule(join(directory, entry.name)) as { default?: unknown };
      if (!isNamed(loaded.default)) {
        throw new Error(`registry entry ${entry.name} must default-export a named definition`);
      }
      return { definition: loaded.default as T, moduleName: entry.name };
    })
    .sort((a, b) => a.definition.name.localeCompare(b.definition.name));
}

export function discoverCommands(
  directory = join(__dirname, 'commands'),
  extensions?: string[],
  loadModule?: ModuleLoader,
): CommandDefinition[] {
  const entries = loadDefinitions<CommandDefinition>(directory, extensions, loadModule);
  const modulesByName = new Map<string, string>();
  for (const { definition: command, moduleName } of entries) {
    if (typeof command.run !== 'function' && typeof command.execute !== 'function') {
      throw new Error(`command registry entry ${command.name} must provide run or execute`);
    }
    const firstModule = modulesByName.get(command.name);
    if (firstModule) {
      throw new Error(`duplicate command name "${command.name}" in ${firstModule} and ${moduleName}`);
    }
    modulesByName.set(command.name, moduleName);
  }
  return entries.map(({ definition }) => definition);
}

export function discoverChecks(
  directory = join(__dirname, 'checks'),
  extensions?: string[],
  loadModule?: ModuleLoader,
): CheckDefinition[] {
  return loadDefinitions<CheckDefinition>(directory, extensions, loadModule)
    .map(({ definition }) => definition);
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
