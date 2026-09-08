import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface QlbConfig {
  anthropicPoolPath: string;
  piAuthJsonPath: string;
  codexAuthJsonPath: string;
  kimiCredentialsFile: string;
  openrouterKeychainService: string;
  dbPath: string;
  pluginsDir: string;
  proxyInfoPath: string;
  claudeCodeCredentialsPath: string;
  configPath: string;
}

type ConfigField = Exclude<keyof QlbConfig, 'configPath'>;

const FIELD_META: Record<ConfigField, { env: string; flag: string }> = {
  anthropicPoolPath: { env: 'QLB_ANTHROPIC_POOL_PATH', flag: '--anthropic-pool-path' },
  piAuthJsonPath: { env: 'QLB_PI_AUTH_JSON_PATH', flag: '--pi-auth-json-path' },
  codexAuthJsonPath: { env: 'QLB_CODEX_AUTH_JSON_PATH', flag: '--codex-auth-json-path' },
  kimiCredentialsFile: { env: 'QLB_KIMI_CREDENTIALS_FILE', flag: '--kimi-credentials-file' },
  openrouterKeychainService: { env: 'QLB_OPENROUTER_KEYCHAIN_SERVICE', flag: '--openrouter-keychain-service' },
  dbPath: { env: 'QLB_DB_PATH', flag: '--db-path' },
  pluginsDir: { env: 'QLB_PLUGINS_DIR', flag: '--plugins-dir' },
  proxyInfoPath: { env: 'QLB_PROXY_INFO_PATH', flag: '--proxy-info-path' },
  claudeCodeCredentialsPath: { env: 'QLB_CLAUDE_CODE_CREDENTIALS_PATH', flag: '--claude-code-credentials-path' },
};

export const CONFIG_ENV_VARS = Object.fromEntries(
  Object.entries(FIELD_META).map(([field, meta]) => [field, meta.env]),
) as Record<ConfigField, string>;

export function defaultConfig(home: string = homedir()): QlbConfig {
  const qlbDir = join(home, '.qlb');
  return {
    anthropicPoolPath: join(home, '.pi', 'agent', 'anthropic-pool.json'),
    piAuthJsonPath: join(home, '.pi', 'agent', 'auth.json'),
    codexAuthJsonPath: join(home, '.codex', 'auth.json'),
    kimiCredentialsFile: join(home, 'DEV_vault', '04-Security', 'kimi-code-credentials.md'),
    openrouterKeychainService: 'pi-openrouter',
    dbPath: join(qlbDir, 'qlb.db'),
    pluginsDir: join(qlbDir, 'plugins'),
    proxyInfoPath: join(qlbDir, 'proxy.json'),
    claudeCodeCredentialsPath: join(home, '.claude', 'Claude Code-credentials'),
    configPath: join(qlbDir, 'config.json'),
  };
}

function expandPath(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(home, value.slice(2));
  }
  return isAbsolute(value) ? value : resolve(value);
}

function cliValue(argv: string[], flag: string): string | undefined {
  const index = argv.lastIndexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export interface ResolveConfigOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  warn?: (message: string) => void;
}

export function resolveConfig(options: ResolveConfigOptions = {}): QlbConfig {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const warn = options.warn ?? ((message: string) => console.error(message));
  const defaults = defaultConfig(home);
  const configPathRaw = cliValue(argv, '--config') ?? env.QLB_CONFIG_PATH ?? defaults.configPath;
  const configPath = expandPath(configPathRaw, home);

  let fileConfig: Partial<Record<ConfigField, string>> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('top level must be a JSON object');
      }
      fileConfig = parsed as Partial<Record<ConfigField, string>>;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(`qlb: ignoring invalid config ${configPath}: ${reason}`);
    }
  }

  const result = { ...defaults, configPath };
  for (const [field, meta] of Object.entries(FIELD_META) as Array<[
    ConfigField,
    { env: string; flag: string },
  ]>) {
    const raw = cliValue(argv, meta.flag) ?? env[meta.env] ?? fileConfig[field] ?? defaults[field];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    result[field] = field.endsWith('Path') || field.endsWith('File') || field.endsWith('Dir')
      ? expandPath(raw, home)
      : raw;
  }
  return result;
}

export function stripConfigArgs(argv: string[]): string[] {
  const flags = new Set(['--config', ...Object.values(FIELD_META).map((meta) => meta.flag)]);
  const out = argv.slice(0, 2);
  for (let i = 2; i < argv.length; i++) {
    if (flags.has(argv[i])) {
      i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

export const config = resolveConfig();
