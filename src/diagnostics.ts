import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { builtInAdapters } from './adapters';
import { CONFIG_ENV_VARS, type QlbConfig } from './config';
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
    openrouterOk = command('security', [
      'find-generic-password', '-s', config.openrouterKeychainService, '-w',
    ]).trim().length > 0;
  } catch {
    openrouterOk = false;
  }

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
      ? found('openrouter', `macOS Keychain service ${config.openrouterKeychainService}`, CONFIG_ENV_VARS.openrouterKeychainService, `export ${CONFIG_ENV_VARS.openrouterKeychainService}=pi-openrouter`)
      : missing('openrouter', `macOS Keychain service ${config.openrouterKeychainService}`, CONFIG_ENV_VARS.openrouterKeychainService, `security add-generic-password -s ${config.openrouterKeychainService} -a qlb -w '<key>'`),
  ];
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

export async function doctorQlb(
  config: QlbConfig,
  options: { live?: boolean; command?: CommandRunner } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let migrations: Array<{ store: string; state: string }> = [];

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

  try {
    (options.command ?? runCommand)('security', ['list-keychains', '-d', 'user']);
    checks.push({ name: 'keychain', level: 'PASS', message: 'macOS Keychain command is reachable' });
  } catch {
    checks.push({ name: 'keychain', level: 'WARN', message: 'macOS Keychain command is unavailable or unreachable' });
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
