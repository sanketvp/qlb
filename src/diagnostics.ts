import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { builtInAdapters } from './adapters';
import { CONFIG_ENV_VARS, type QlbConfig } from './config';
import {
  defaultCommandExists,
  platformKeychain,
  readNativeOpenRouterKey,
  selectBackendKind,
  type KeychainBackend,
} from './keychain';
import {
  createNativeCredentialReader,
  inspectOwnedNativeDrift,
  readOwnedCredentialFromKeychain,
  type ResyncCredential,
} from './native-resync';
import type { AccountSnapshot, Adapter } from './types';

export type CheckLevel = 'PASS' | 'WARN' | 'FAIL';

export interface ProviderDiagnostic {
  provider: string;
  level: CheckLevel;
  source: string;
  message: string;
  envVar: string;
  example: string;
  live?: { ok: boolean; message: string };
}

export interface InitReport {
  command: 'init';
  overall: 'PASS' | 'WARN';
  configPath: string;
  configWritten: boolean;
  configured: Partial<QlbConfig>;
  providers: ProviderDiagnostic[];
}

export interface DoctorCheck {
  name: string;
  level: CheckLevel;
  message: string;
  detail?: unknown;
}

export interface DoctorReport {
  command: 'doctor';
  overall: CheckLevel;
  checks: DoctorCheck[];
  providers: ProviderDiagnostic[];
}

type CommandRunner = (command: string, args: string[]) => string;

const runCommand: CommandRunner = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function found(
  provider: string,
  source: string,
  envVar: string,
  example: string,
): ProviderDiagnostic {
  return { provider, level: 'PASS', source, envVar, example, message: `credential source found: ${source}` };
}

function missing(
  provider: string,
  source: string,
  envVar: string,
  example: string,
): ProviderDiagnostic {
  return {
    provider,
    level: 'WARN',
    source,
    envVar,
    example,
    message: `credential source not found; set ${envVar}. Example: ${example}`,
  };
}

export function inspectProviders(
  config: QlbConfig,
  command: CommandRunner = runCommand,
): ProviderDiagnostic[] {
  const pool = readJson(config.anthropicPoolPath);
  const accounts = Array.isArray(pool?.accounts) ? pool.accounts : [];
  const anthropicOk = accounts.some((account) => {
    if (!account || typeof account !== 'object') return false;
    const credentials = (account as { credentials?: unknown }).credentials;
    return !!credentials && typeof credentials === 'object' &&
      typeof (credentials as { access?: unknown }).access === 'string';
  });

  const piAuth = readJson(config.piAuthJsonPath);
  const xai = piAuth?.xai;
  const xaiOk = !!xai && typeof xai === 'object' &&
    typeof (xai as { access?: unknown }).access === 'string';

  const codex = readJson(config.codexAuthJsonPath);
  const tokens = codex?.tokens;
  const codexOk = !!tokens && typeof tokens === 'object' &&
    typeof (tokens as { access_token?: unknown }).access_token === 'string';

  let kimiOk = false;
  try {
    kimiOk = /sk-kimi-[A-Za-z0-9]+/.test(readFileSync(config.kimiCredentialsFile, 'utf8'));
  } catch {
    kimiOk = false;
  }

  let openrouterOk = false;
  try {
    if (command === runCommand) {
      openrouterOk = readNativeOpenRouterKey(config.openrouterKeychainService).trim().length > 0;
    } else {
      openrouterOk = command('security', [
        'find-generic-password', '-s', config.openrouterKeychainService, '-w',
      ]).trim().length > 0;
    }
  } catch {
    openrouterOk = false;
  }

  const openrouterSource = openRouterSourceLabel(config.openrouterKeychainService);
  const openrouterExample = openRouterSetupExample(config.openrouterKeychainService);

  return [
    anthropicOk
      ? found('anthropic', config.anthropicPoolPath, CONFIG_ENV_VARS.anthropicPoolPath, `export ${CONFIG_ENV_VARS.anthropicPoolPath}=~/.pi/agent/anthropic-pool.json`)
      : missing('anthropic', config.anthropicPoolPath, CONFIG_ENV_VARS.anthropicPoolPath, `export ${CONFIG_ENV_VARS.anthropicPoolPath}=~/path/to/anthropic-pool.json`),
    xaiOk
      ? found('xai', `${config.piAuthJsonPath} (xai entry)`, CONFIG_ENV_VARS.piAuthJsonPath, `export ${CONFIG_ENV_VARS.piAuthJsonPath}=~/.pi/agent/auth.json`)
      : missing('xai', `${config.piAuthJsonPath} (xai entry)`, CONFIG_ENV_VARS.piAuthJsonPath, `export ${CONFIG_ENV_VARS.piAuthJsonPath}=~/path/to/pi-auth.json`),
    codexOk
      ? found('openai-codex', config.codexAuthJsonPath, CONFIG_ENV_VARS.codexAuthJsonPath, `export ${CONFIG_ENV_VARS.codexAuthJsonPath}=~/.codex/auth.json`)
      : missing('openai-codex', config.codexAuthJsonPath, CONFIG_ENV_VARS.codexAuthJsonPath, `export ${CONFIG_ENV_VARS.codexAuthJsonPath}=~/path/to/codex-auth.json`),
    kimiOk
      ? found('kimi-coding', config.kimiCredentialsFile, CONFIG_ENV_VARS.kimiCredentialsFile, `export ${CONFIG_ENV_VARS.kimiCredentialsFile}=~/path/to/kimi-credentials.md`)
      : missing('kimi-coding', config.kimiCredentialsFile, CONFIG_ENV_VARS.kimiCredentialsFile, `export ${CONFIG_ENV_VARS.kimiCredentialsFile}=~/path/to/file-containing-sk-kimi-key`),
    openrouterOk
      ? found('openrouter', openrouterSource, CONFIG_ENV_VARS.openrouterKeychainService, `export ${CONFIG_ENV_VARS.openrouterKeychainService}=pi-openrouter`)
      : missing('openrouter', openrouterSource, CONFIG_ENV_VARS.openrouterKeychainService, openrouterExample),
  ];
}

function openRouterSourceLabel(service: string): string {
  if (process.platform === 'darwin') return `macOS Keychain service ${service}`;
  if (process.platform === 'win32') return `DPAPI credential store service ${service}`;
  const kind = selectBackendKind({
    platform: process.platform,
    commandExists: defaultCommandExists,
  });
  if (kind === 'linux-libsecret') return `libsecret service ${service}`;
  return `encrypted credential file service ${service}`;
}

function openRouterSetupExample(service: string): string {
  if (process.platform === 'darwin') {
    return `security add-generic-password -s ${service} -a qlb -w '<key>'`;
  }
  if (process.platform === 'win32') {
    return `store the key in the DPAPI credential file (~/.qlb/credentials-windows.json) as service ${service} account qlb`;
  }
  const kind = selectBackendKind({
    platform: process.platform,
    commandExists: defaultCommandExists,
  });
  if (kind === 'linux-libsecret') {
    return `printf '%s' '<key>' | secret-tool store --label ${service} service ${service} account qlb`;
  }
  return `store the key in ~/.qlb/credentials-linux.json as service ${service} account qlb`;
}

export function initializeQlb(
  config: QlbConfig,
  command?: CommandRunner,
): InitReport {
  const providers = inspectProviders(config, command);
  const configured: Partial<QlbConfig> = {};
  const byProvider = new Map(providers.map((provider) => [provider.provider, provider]));
  if (byProvider.get('anthropic')?.level === 'PASS') configured.anthropicPoolPath = config.anthropicPoolPath;
  if (byProvider.get('xai')?.level === 'PASS') configured.piAuthJsonPath = config.piAuthJsonPath;
  if (byProvider.get('openai-codex')?.level === 'PASS') configured.codexAuthJsonPath = config.codexAuthJsonPath;
  if (byProvider.get('kimi-coding')?.level === 'PASS') configured.kimiCredentialsFile = config.kimiCredentialsFile;
  if (byProvider.get('openrouter')?.level === 'PASS') configured.openrouterKeychainService = config.openrouterKeychainService;
  configured.dbPath = config.dbPath;
  configured.pluginsDir = config.pluginsDir;

  let configWritten = false;
  if (!existsSync(config.configPath)) {
    mkdirSync(dirname(config.configPath), { recursive: true, mode: 0o700 });
    writeFileSync(config.configPath, `${JSON.stringify(configured, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try { chmodSync(config.configPath, 0o600); } catch { /* best effort */ }
    configWritten = true;
  }

  return {
    command: 'init',
    overall: providers.every((provider) => provider.level === 'PASS') ? 'PASS' : 'WARN',
    configPath: config.configPath,
    configWritten,
    configured,
    providers,
  };
}

async function safeLiveFetch(adapter: Adapter): Promise<AccountSnapshot[]> {
  try {
    return await adapter.fetchSnapshots();
  } catch (err) {
    return [{
      accountId: adapter.id,
      provider: adapter.id,
      label: adapter.displayName,
      buckets: {},
      error: err instanceof Error ? err.message : String(err),
    }];
  }
}

function combineOverall(checks: Array<{ level: CheckLevel }>): CheckLevel {
  if (checks.some((check) => check.level === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.level === 'WARN')) return 'WARN';
  return 'PASS';
}

function probeCredentialStore(command?: CommandRunner): DoctorCheck {
  // Tests inject a command runner and still speak the macOS `security` CLI.
  if (command) {
    try {
      command('security', ['list-keychains', '-d', 'user']);
      return { name: 'keychain', level: 'PASS', message: 'macOS Keychain command is reachable' };
    } catch {
      return { name: 'keychain', level: 'WARN', message: 'macOS Keychain command is unavailable or unreachable' };
    }
  }
  if (process.platform === 'darwin') {
    try {
      runCommand('security', ['list-keychains', '-d', 'user']);
      return { name: 'keychain', level: 'PASS', message: 'macOS Keychain command is reachable' };
    } catch {
      return { name: 'keychain', level: 'WARN', message: 'macOS Keychain command is unavailable or unreachable' };
    }
  }
  if (process.platform === 'win32') {
    return {
      name: 'keychain',
      level: 'PASS',
      message: 'Windows DPAPI credential backend is available',
    };
  }
  const kind = selectBackendKind({
    platform: process.platform,
    commandExists: defaultCommandExists,
  });
  if (kind === 'linux-libsecret') {
    return {
      name: 'keychain',
      level: 'PASS',
      message: 'Linux libsecret (secret-tool) credential backend is available',
    };
  }
  return {
    name: 'keychain',
    level: 'PASS',
    message: 'Linux encrypted-file credential backend is available (weaker than libsecret; see CREDENTIAL-SAFETY.md)',
  };
}

export async function doctorQlb(
  config: QlbConfig,
  options: {
    live?: boolean;
    command?: CommandRunner;
    /** Tests inject MockKeychain. Production defaults to platformKeychain. */
    keychain?: KeychainBackend;
    /** Tests inject a fake. Production reads native files / OpenRouter Keychain. */
    readNativeCredential?: (
      provider: string,
      accountId: string,
    ) => Promise<ResyncCredential | null>;
  } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let migrations: Array<{ store: string; state: string }> = [];
  let accounts: Array<{ id: string; provider: string; label: string }> = [];

  if (!existsSync(config.dbPath)) {
    checks.push({ name: 'sqlite', level: 'WARN', message: `database does not exist yet: ${config.dbPath}; run qlb status` });
  } else {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(config.dbPath, { readOnly: true });
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      if (integrity?.integrity_check !== 'ok') {
        checks.push({ name: 'sqlite', level: 'FAIL', message: 'PRAGMA integrity_check failed', detail: integrity });
      } else {
        checks.push({ name: 'sqlite', level: 'PASS', message: `database opens and integrity_check passes: ${config.dbPath}` });
      }
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'").get();
      if (table) {
        migrations = db.prepare('SELECT store, state FROM migrations').all() as Array<{ store: string; state: string }>;
      }
      const acctTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get();
      if (acctTable) {
        accounts = db.prepare('SELECT id, provider, label FROM accounts').all() as Array<{
          id: string;
          provider: string;
          label: string;
        }>;
      }
    } catch (err) {
      checks.push({ name: 'sqlite', level: 'FAIL', message: `database check failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      try { db?.close(); } catch { /* already unusable */ }
    }
  }

  const stuck = migrations.filter((migration) => !['NATIVE', 'QLB_OWNED'].includes(migration.state));
  checks.push(stuck.length > 0
    ? {
        name: 'migrations',
        level: 'WARN',
        message: `MIGRATION NEEDS ATTENTION: ${stuck.map((m) => `${m.store}=${m.state}`).join(', ')}; run qlb migrate resume or qlb migrate rollback`,
        detail: stuck,
      }
    : { name: 'migrations', level: 'PASS', message: 'no incomplete migrations detected' });

  checks.push(probeCredentialStore(options.command));

  const owned = migrations.filter((m) => m.state === 'QLB_OWNED' || m.state === 'RETIRED');
  if (owned.length > 0 && accounts.length > 0) {
    const keychain = options.keychain ?? platformKeychain;
    const readNative =
      options.readNativeCredential ??
      createNativeCredentialReader({
        poolFilePath: config.anthropicPoolPath,
        authJsonPath: config.piAuthJsonPath,
        readOpenRouterKey: () => readNativeOpenRouterKey(config.openrouterKeychainService),
      });
    const drift = await inspectOwnedNativeDrift({
      accounts,
      migrations,
      readNativeCredential: readNative,
      readOwnedCredential: async (provider, accountId, label) =>
        readOwnedCredentialFromKeychain(keychain, provider, accountId, label),
    });
    for (const row of drift) {
      checks.push({
        name: `native-sync:${row.accountId}`,
        level: row.level,
        message: row.message,
        detail: { provider: row.provider, matches: row.matches },
      });
    }
  }

  const providers = inspectProviders(config, options.command);
  if (options.live) {
    const adapterById = new Map(builtInAdapters.map((adapter) => [adapter.id, adapter]));
    await Promise.all(providers.map(async (provider) => {
      const adapter = adapterById.get(provider.provider);
      if (!adapter || provider.level !== 'PASS') return;
      const snapshots = await safeLiveFetch(adapter);
      const errors = snapshots.map((snapshot) => snapshot.error).filter(Boolean);
      provider.live = errors.length === 0
        ? { ok: true, message: 'live check succeeded' }
        : { ok: false, message: errors.join('; ') };
      if (errors.length > 0) provider.level = 'WARN';
    }));
  }

  return {
    command: 'doctor',
    overall: combineOverall([...checks, ...providers]),
    checks,
    providers,
  };
}
