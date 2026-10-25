import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { consumeMarkerPathFor, CSWAP_ANTHROPIC_STORE } from './cswap-consume';
import { builtInAdapters } from './adapters';
import { CONFIG_ENV_VARS, OPENROUTER_KEYCHAIN_SERVICE, type QlbConfig } from './config';
import { cswapCachePresent } from './cswap-usage';
import {
  execFileUtf8,
  isSecurityTimeout,
  MACOS_SECURITY_TIMEOUT_MS,
  securityTimeoutError,
  type ExecFileSyncFn,
} from './credential-backends';
import {
  defaultCommandExists,
  MACOS_SECURITY_BIN,
  platformKeychain,
  readNativeOpenRouterKey,
  selectBackendKind,
  type KeychainBackend,
} from './keychain';
import {
  decodeJournalEvidence,
  isStuckMigration,
  untrustedAdvisoryMessage,
  validatedAdvisoryMessage,
} from './migration-health';
import {
  createNativeCredentialReader,
  inspectOwnedNativeDrift,
  readOwnedCredentialFromKeychain,
  type ResyncCredential,
} from './native-resync';
import type { AccountSnapshot, Adapter } from './types';
import { hermesIntegrationChecks } from './hermes-integration';
import { piIntegrationChecks } from './pi-integration';
import { probeHostEnvironment, type HostCommandRunner } from './checks/hosts-env';
import { autoBreakerCheck } from './checks/auto-breaker';
import { claudeOauthClientCheck } from './checks/claude-oauth-client';
import { claudeSlotsCheck } from './checks/claude-slots';
import { codexSlotsCheck } from './checks/codex-slots';
import { lifecyclePhase, lifecyclePhaseCheck, type LifecyclePhaseResult } from './checks/lifecycle-phase';
import { relogin7dCheck } from './checks/relogin-7d';
import { openStoreConnection } from './store';
import { discoverChecks, type CheckDefinition } from './registry';
import { lifecycleWindowCheck } from './checks/lifecycle-window';
import { lifecycleDrillCheck } from './checks/lifecycle-drill';
import { openStore } from './store';

export type CheckLevel = 'PASS' | 'WARN' | 'FAIL' | 'INFO' | 'N/A';

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

/** The diagnostic registry is separate from the runtime report so checks can be added independently. */
export function listCheckNames(): string[] {
  return discoverChecks().map((check) => check.name);
}

/**
 * Reconcile runtime output with the registry without ever turning diagnostics
 * into an exception path. Dynamic prefix checks remain individual report rows;
 * registry mistakes stay visible through doctor:registry.
 */
export function registeredDoctorChecks(
  checks: DoctorCheck[],
  loadChecks: () => CheckDefinition[] = discoverChecks,
): DoctorCheck[] {
  let definitions: CheckDefinition[];
  try {
    definitions = loadChecks();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return [
      ...checks,
      { name: 'doctor:registry', level: 'FAIL', message: `registry load failed: ${reason}` },
    ];
  }
  const emitted = new Map<string, DoctorCheck[]>();
  const unregistered: DoctorCheck[] = [];
  const seen = new Set<string>();
  const mismatches: string[] = [];

  for (const check of checks) {
    const duplicate = seen.has(check.name);
    seen.add(check.name);
    const definition = definitions.find((candidate) =>
      candidate.name === check.name ||
      (candidate.prefix != null && check.name.startsWith(`${candidate.prefix}:`)),
    );
    if (!definition) {
      unregistered.push(check);
      mismatches.push(`unregistered ${check.name}`);
      if (duplicate) mismatches.push(`duplicate ${check.name}`);
      continue;
    }
    if (duplicate) mismatches.push(`duplicate ${check.name}`);
    const rows = emitted.get(definition.name) ?? [];
    rows.push(check);
    emitted.set(definition.name, rows);
  }

  const report: DoctorCheck[] = [];
  for (const definition of definitions) {
    if (definition.name === 'doctor:registry') {
      report.push(mismatches.length > 0
        ? { name: definition.name, level: 'WARN', message: `registry mismatch: ${mismatches.join('; ')}` }
        : { name: definition.name, level: 'PASS', message: 'all emitted checks match the registry' });
      continue;
    }
    const rows = emitted.get(definition.name);
    if (rows && rows.length > 0) {
      report.push(...rows);
    } else {
      report.push({ name: definition.name, level: 'PASS', message: 'not applicable on this host' });
    }
  }
  return [...report, ...unregistered];
}

export function createCommandRunner(exec: ExecFileSyncFn = execFileUtf8): CommandRunner {
  return (command, args) => exec(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: MACOS_SECURITY_TIMEOUT_MS,
  });
}

const runCommand = createCommandRunner();

/** A bounded runner for host probes; never return login-shell environment output. */
const runHostCommand: HostCommandRunner = (command, args, options) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
    env: options?.env,
  });

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
  const anthropicOk = cswapCachePresent({
    sequencePath: config.cswapSequencePath,
    usagePath: config.cswapUsagePath,
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

  const openrouterSupported = config.openrouterKeychainService === OPENROUTER_KEYCHAIN_SERVICE;
  let openrouterOk = false;
  let openrouterTimedOut = false;
  if (openrouterSupported) {
    try {
      if (command === runCommand) {
        openrouterOk = readNativeOpenRouterKey(config.openrouterKeychainService).trim().length > 0;
      } else {
        openrouterOk = command(MACOS_SECURITY_BIN, [
          'find-generic-password', '-s', config.openrouterKeychainService, '-w',
        ]).trim().length > 0;
      }
    } catch (err) {
      openrouterTimedOut = isSecurityTimeout(err);
    }
  }

  const openrouterSource = openRouterSourceLabel(config.openrouterKeychainService);
  const openrouterExample = openRouterSetupExample();

  return [
    anthropicOk
      ? found('anthropic', `${config.cswapSequencePath} + ${config.cswapUsagePath}`, CONFIG_ENV_VARS.cswapSequencePath, `export ${CONFIG_ENV_VARS.cswapSequencePath}=~/.claude-swap-backup/sequence.json`)
      : missing('anthropic', `${config.cswapSequencePath} + ${config.cswapUsagePath}`, CONFIG_ENV_VARS.cswapSequencePath, `export ${CONFIG_ENV_VARS.cswapSequencePath}=~/.claude-swap-backup/sequence.json`),
    xaiOk
      ? found('xai', `${config.piAuthJsonPath} (xai entry)`, CONFIG_ENV_VARS.piAuthJsonPath, `export ${CONFIG_ENV_VARS.piAuthJsonPath}=~/.pi/agent/auth.json`)
      : missing('xai', `${config.piAuthJsonPath} (xai entry)`, CONFIG_ENV_VARS.piAuthJsonPath, `export ${CONFIG_ENV_VARS.piAuthJsonPath}=~/path/to/pi-auth.json`),
    codexOk
      ? found('openai-codex', config.codexAuthJsonPath, CONFIG_ENV_VARS.codexAuthJsonPath, `export ${CONFIG_ENV_VARS.codexAuthJsonPath}=~/.codex/auth.json`)
      : missing('openai-codex', config.codexAuthJsonPath, CONFIG_ENV_VARS.codexAuthJsonPath, `export ${CONFIG_ENV_VARS.codexAuthJsonPath}=~/path/to/codex-auth.json`),
    kimiOk
      ? found('kimi-coding', config.kimiCredentialsFile, CONFIG_ENV_VARS.kimiCredentialsFile, `export ${CONFIG_ENV_VARS.kimiCredentialsFile}=~/path/to/kimi-credentials.md`)
      : missing('kimi-coding', config.kimiCredentialsFile, CONFIG_ENV_VARS.kimiCredentialsFile, `export ${CONFIG_ENV_VARS.kimiCredentialsFile}=~/path/to/file-containing-sk-kimi-key`),
    !openrouterSupported
      ? unsupportedOpenRouterService(config.openrouterKeychainService)
      : openrouterOk
        ? found('openrouter', openrouterSource, CONFIG_ENV_VARS.openrouterKeychainService, `export ${CONFIG_ENV_VARS.openrouterKeychainService}=pi-openrouter`)
        : openrouterTimedOut
          ? timedOutFixedOpenRouter(openrouterSource)
          : missingFixedOpenRouter(openrouterSource, openrouterExample),
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

function timedOutFixedOpenRouter(source: string): ProviderDiagnostic {
  return {
    provider: 'openrouter',
    level: 'WARN',
    source,
    envVar: CONFIG_ENV_VARS.openrouterKeychainService,
    example: '',
    message: securityTimeoutError('find-generic-password').message,
  };
}

function missingFixedOpenRouter(source: string, example: string): ProviderDiagnostic {
  return {
    provider: 'openrouter',
    level: 'WARN',
    source,
    envVar: CONFIG_ENV_VARS.openrouterKeychainService,
    example,
    message: `credential source not found in fixed pi-openrouter service. Example: ${example}`,
  };
}

function unsupportedOpenRouterService(service: string): ProviderDiagnostic {
  return {
    provider: 'openrouter',
    level: 'WARN',
    source: openRouterSourceLabel(service),
    envVar: CONFIG_ENV_VARS.openrouterKeychainService,
    example: `remove the override or set ${CONFIG_ENV_VARS.openrouterKeychainService}=pi-openrouter`,
    message: `unsupported OpenRouter Keychain service '${service}'; only pi-openrouter is supported`,
  };
}

function openRouterSetupExample(): string {
  const service = OPENROUTER_KEYCHAIN_SERVICE;
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
  if (byProvider.get('anthropic')?.level === 'PASS') {
    configured.cswapSequencePath = config.cswapSequencePath;
    configured.cswapUsagePath = config.cswapUsagePath;
  }
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
      command(MACOS_SECURITY_BIN, ['list-keychains', '-d', 'user']);
      return { name: 'keychain', level: 'PASS', message: 'macOS Keychain command is reachable' };
    } catch (err) {
      return isSecurityTimeout(err)
        ? { name: 'keychain', level: 'WARN', message: securityTimeoutError('list-keychains').message }
        : { name: 'keychain', level: 'WARN', message: 'macOS Keychain command is unavailable or unreachable' };
    }
  }
  if (process.platform === 'darwin') {
    try {
      runCommand(MACOS_SECURITY_BIN, ['list-keychains', '-d', 'user']);
      return { name: 'keychain', level: 'PASS', message: 'macOS Keychain command is reachable' };
    } catch (err) {
      return isSecurityTimeout(err)
        ? { name: 'keychain', level: 'WARN', message: securityTimeoutError('list-keychains').message }
        : { name: 'keychain', level: 'WARN', message: 'macOS Keychain command is unavailable or unreachable' };
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
    /** Tests inject this bounded host command runner. */
    hostCommand?: HostCommandRunner;
    /** Tests inject host process properties without mutating the real process. */
    hostPlatform?: NodeJS.Platform;
    hostShell?: string;
    hostShellExists?: (path: string) => boolean;
    /** Tests inject a stable read; production reads lifecycle once per report. */
    readLifecyclePhase?: (dbPath: string) => LifecyclePhaseResult;
  } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let migrations: Array<{ store: string; state: string; detail_json?: string }> = [];
  let accounts: Array<{ id: string; provider: string; label: string }> = [];
  let recoveryPending = false;

  if (!existsSync(config.dbPath)) {
    checks.push({ name: 'sqlite', level: 'WARN', message: `database does not exist yet: ${config.dbPath}; run qlb status` });
  } else {
    let db: ReturnType<typeof openStoreConnection> | undefined;
    let sqliteCheck: DoctorCheck | undefined;
    try {
      db = openStoreConnection(config.dbPath, true);
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      sqliteCheck = integrity?.integrity_check !== 'ok'
        ? { name: 'sqlite', level: 'FAIL', message: 'PRAGMA integrity_check failed', detail: integrity }
        : { name: 'sqlite', level: 'PASS', message: `database opens and integrity_check passes: ${config.dbPath}` };
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'").get();
      if (table) {
        migrations = db.prepare('SELECT store, state, detail_json FROM migrations').all() as Array<{
          store: string;
          state: string;
          detail_json?: string;
        }>;
      }
      const acctTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get();
      if (acctTable) {
        accounts = db.prepare('SELECT id, provider, label FROM accounts').all() as Array<{
          id: string;
          provider: string;
          label: string;
        }>;
      }
      const cfgTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='config'").get();
      if (cfgTable) {
        const marker = db.prepare('SELECT value FROM config WHERE key = ?').get('migrations.recovery_pending');
        recoveryPending = marker != null;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (sqliteCheck?.level === 'FAIL') {
        sqliteCheck = {
          ...sqliteCheck,
          message: `${sqliteCheck.message}; database query failed: ${reason}`,
          detail: { integrity: sqliteCheck.detail, queryError: reason },
        };
      } else {
        sqliteCheck = { name: 'sqlite', level: 'FAIL', message: `database check failed: ${reason}` };
      }
    } finally {
      try { db?.close(); } catch { /* already unusable */ }
    }
    checks.push(sqliteCheck);
  }

  const stuck = migrations.filter((migration) => isStuckMigration(migration));
  if (stuck.length > 0) {
    const parts = stuck.map((migration) => {
      const ev = decodeJournalEvidence(migration);
      if (!ev.trusted) {
        return untrustedAdvisoryMessage(migration.store, migration.state, ev.reason);
      }
      if (ev.state === 'VALIDATED') {
        return validatedAdvisoryMessage(migration.store, ev.participants.size);
      }
      return `${migration.store}=${migration.state} — advisory: in-flight staging; accounts are prune-protected; see qlb migrate status`;
    });
    checks.push({
      name: 'migrations',
      level: 'WARN',
      message: `MIGRATION NEEDS ATTENTION: ${parts.join('; ')}`,
      detail: stuck,
    });
  } else {
    checks.push({ name: 'migrations', level: 'PASS', message: 'no incomplete migrations detected' });
  }

  if (recoveryPending) {
    checks.push({
      name: 'recovery',
      level: 'WARN',
      message: 'recovery marker present — destructive maintenance refused until reconciled',
    });
  }

  checks.push(probeCredentialStore(options.command));
  checks.push(probeHostEnvironment(options.hostCommand ?? runHostCommand, {
    platform: options.hostPlatform ?? process.platform,
    // An explicit hostShell key (even undefined) overrides the real SHELL, so tests are host-independent.
    shell: 'hostShell' in options ? options.hostShell : process.env.SHELL,
    shellExists: options.hostShellExists ?? existsSync,
  }));

  // A7 checks are real doctor rows, never registry reconciliation placeholders.
  // An unavailable lifecycle phase deliberately makes phase-aware checks WARN.
  const lifecycle = (options.readLifecyclePhase ?? lifecyclePhase)(config.dbPath);

  // Doctor never migrates: openStore would upgrade a missing or pre-v5 store, so the
  // lifecycle window/drill rows run only once the read-only phase read succeeds.
  if (lifecycle.available) {
    try {
      const lifecycleStore = openStore(config.dbPath);
      try {
        checks.push(lifecycleWindowCheck(lifecycleStore), lifecycleDrillCheck(lifecycleStore));
      } finally { lifecycleStore.close(); }
    } catch (err) {
      checks.push({
        name: 'lifecycle:window', level: 'WARN',
        message: `lifecycle checks unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
      checks.push({ name: 'lifecycle:drill', level: 'WARN', message: 'lifecycle checks unavailable' });
    }
  }

  const phase = lifecycle.phase;
  checks.push(
    autoBreakerCheck(config.dbPath, 'anthropic', lifecycle),
    claudeOauthClientCheck(config.dbPath, lifecycle),
    claudeSlotsCheck(config.dbPath, phase),
    codexSlotsCheck(config.dbPath, phase),
    lifecyclePhaseCheck(lifecycle),
    relogin7dCheck(config.dbPath, phase),
  );

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

  // Hermes integration (external to the Hermes checkout): config, plugin, local fix, supervisor,
  // and — with --live — the exact Hermes symbols the plugin patches. Never throws.
  try {
    checks.push(...hermesIntegrationChecks({ probeSeams: options.live === true }));
  } catch (err) {
    checks.push({ name: 'hermes', level: 'WARN', message: `hermes checks failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  // qlb-pi decides its startup mode from the consume marker without spawning the
  // CLI when no marker/owner file exists, so CONSUMED without a marker must surface.
  {
    const consumed = migrations.find((m) => m.store === CSWAP_ANTHROPIC_STORE)?.state === 'CONSUMED';
    const marker = consumeMarkerPathFor(config.dbPath);
    const markerExists = existsSync(marker);
    if (consumed && !markerExists) {
      checks.push({
        name: 'consume:marker', level: 'FAIL',
        message: `cswap-anthropic is CONSUMED but ${marker} is missing; new Pi sessions will not use cswap`,
        detail: { fix: 'qlb consume enable --provider anthropic   # rewrites the marker; then restart Pi' },
      });
    } else if (!consumed && markerExists) {
      checks.push({
        name: 'consume:marker', level: 'WARN',
        message: `${marker} exists but cswap-anthropic is not CONSUMED; Pi refuses Anthropic until this is reconciled`,
        detail: { fix: 'qlb consume enable --provider anthropic  OR  qlb consume disable --provider anthropic; then restart Pi' },
      });
    } else if (consumed) {
      checks.push({ name: 'consume:marker', level: 'PASS', message: `cswap consume enabled; marker present (${marker})` });
    }
  }
  try {
    checks.push(...piIntegrationChecks({ typecheck: options.live === true }));
  } catch (err) {
    checks.push({ name: 'pi', level: 'WARN', message: `pi checks failed: ${err instanceof Error ? err.message : String(err)}` });
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

  const registeredChecks = registeredDoctorChecks(checks);
  return {
    command: 'doctor',
    overall: combineOverall([...registeredChecks, ...providers]),
    checks: registeredChecks,
    providers,
  };
}
