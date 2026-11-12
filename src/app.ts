#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { adapters } from './adapters';
import { createCodexAdapter } from './adapters/codex';
import { assertTestHomeIsIsolated } from './bootstrap';
import { CSWAP_RESTORE_PENDING, FINISH_CSWAP_RESTORE_FIRST, FINISH_RETIREMENT_FIRST, RETIREMENT_IN_PROGRESS, assertAdmitted, assertAdmittedInConnection, phase, phaseForConnection, type LifecycleOperation } from './lifecycle';
import { createDefaultCodexGateDeps, runCodexGate } from './codex-gate';
import { config, resolveConfig, stripConfigArgs } from './config';
import { qlbHomeDir } from './home';
import { hasLegacyPiOwnerEntry, readPiOwnerProviders } from './pi-migrate';
import { discoverCommands, resolveCommand, type CommandContext, type CommandDefinition } from './registry';
import { runCodexProbeClaims } from './commands/codex-probe-claims';
import { redactError, redactSecrets } from './redact';
import { reloginsInWindow, type ReloginEvent } from './relogin';
import { doctorQlb, initializeQlb, listCheckNames, type DoctorReport, type InitReport } from './diagnostics';
import {
  formatAnthropicReceipt,
  isReceiptPhase,
  projectAnthropicReceipt,
  readAnthropicReceiptSources,
  receiptPhaseList,
  type AnthropicReceiptPhase,
} from './anthropic-receipt';
import { formatAnthropicPreflight, runAnthropicPreflight } from './anthropic-preflight';
import { loginExpiresAtIso } from './anthropic-oauth';
import { qlbOwnsAnthropicUsage } from './anthropic-usage-view';
import { platformKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from './keychain';
import { createOwnedCredentialSource } from './credentials';
import {
  CSWAP_ANTHROPIC_STORE,
  CONSUME_STATE,
  consumeMarkerPathFor,
  isConsumedState,
} from './cswap-consume';
import {
  bindDetectAndResync,
  createNativeCredentialReader,
} from './native-resync';
import {
  DEFAULT_AUTH_JSON,
  DEFAULT_POOL_FILE,
  Migration,
  createSingleGrantMigration,
  createStaticKeyMigration,
  defaultOwnerFileFor,
  anthropicPoolFetchTransport,
  defaultRehearseFn,
  isMigrateProvider,
  isSingleGrantProvider,
  isStaticKeyProvider,
  PI_POOL_STORE,
  readOpenRouterNativeKey,
  type MigrateProvider,
} from './migration';
import { listPolicies, setPolicy } from './policy';
import { LoopbackProxy } from './proxy';
import { parseUntil } from './overrides';
import {
  MigratePathError,
  assertSupportedPlatform,
  isInsideProtectedRoot,
  resolveMigratePath,
  resolveProtectedRoot,
  validateRawMigratePath,
  type MigratePathKind,
} from './migrate-paths';
import { resolveFromSnapshots, providerForModel, snapshotsFromStore } from './resolve';
import { isStrategy, STRATEGIES, type Strategy } from './scoring';
import {
  checkRetirementEligibility,
  defaultNativePathForHarness,
  defaultPingFn,
  isRetireHarness,
  retireNativeStore,
  type RetireHarness,
} from './retire';
import { pruneAccount, PruneRefusedError } from './accounts-prune';
import {
  activeAnthropicMarker,
  decorateStatusJson,
  enrichAccounts,
  formatDashboard,
  formatFlatTable,
  formatRelative,
  formatUsedPct,
  makeOwnershipReader,
  overrideFromStore,
} from './dashboard';
import { isSetupHarness, setupHarness, type SetupHarness } from './setup';
import { setupHermes } from './setup-hermes';
import { formatRefresh, refreshCommand, runRefresh } from './refresh';
import { DEFAULT_AUDIT_LIMIT, formatAudit, toAuditDecision } from './audit';
import { DEFAULT_WHY_MODEL, explainWhy, formatWhyHuman } from './why';
import { collectCandidates, recordObservation, safeFetch } from './candidates';
import { probeCodexUsage } from './usage/openai-codex';
import {
  getStore,
  isWalSidecarUnreadableError,
  openDecisionsReader,
  openStore,
  openStoreConnection,
  readOnlySchemaRefusal,
  WAL_SIDECAR_UNREADABLE,
  walSidecarUnreadableMessage,
  type Store,
} from './store';

const USAGE = `Usage:
  qlb init [--json]
  qlb doctor [--json] [--live]
  qlb refresh [--provider kimi-coding|openai-codex] [--allow-probe] [--json]
  qlb native-resync --provider anthropic|xai|kimi-coding|openai-codex|openrouter --account <id> [--json] [--db <path>]
  qlb status [--json] [--dashboard|--flat]
  qlb status --switches|--relogins [--window] [--json]
  qlb report cutover [--json]
  qlb export --cache-only --json
  qlb setup pi|claude-code|codex-cli|generic|hermes [--json]
  qlb resolve --model <modelId> [--fallback m1,m2,...] [--session <id>] [--harness pi|claude-code|codex|dispatch] [--effort <lvl>] [--strategy headroom|spread|round-robin|failover] [--json]
  qlb why [--model <modelId>] [--fallback m1,m2,...] [--session <id>] [--strategy headroom|spread|round-robin|failover] [--json]
  qlb override pin --session <id> --account <account-id> [--until <ISO-datetime|2h>] [--db <path>] [--json]
  qlb override reserve --account <account-id> [--until <ISO-datetime|2h>] [--db <path>] [--json]
  qlb override drain-first --account <account-id> [--until <ISO-datetime|2h>] [--db <path>] [--json]
  qlb override clear --session <id> | --account <account-id> | --all [--db <path>] [--json]
  qlb override list [--db <path>] [--json]
  qlb policy set --harness <h> --virtual-model <name> --real-model <id> --effort <lvl> [--fallback m1,m2] [--session-mode header|anon] [--db <path>] [--json]
  qlb policy list [--harness <h>] [--db <path>] [--json]
  qlb codex gate [--json] [--db <path>]
  qlb codex probe-claims --json
  qlb codex usage-diagnostic [--json]
  qlb proxy [--info-path <path>] [--idle-ms <n>] [--no-idle] [--port <n>] [--started-by wrapper|cli] [--db <path>]
  qlb consume enable|disable|status --provider anthropic [--json] [--db <path>]
  qlb migrate stage    [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] --pool-file <path> --owner-file <path> [--auth-json <path>] [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate rehearse [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] --pool-file <path> --owner-file <path> [--auth-json <path>] [--db <path>] [--target-dir <path>] [--initial-active <alias>] [--confirm-real-cutover]
  qlb migrate commit   [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] --pool-file <path> --owner-file <path> [--auth-json <path>] [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate rollback [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] --pool-file <path> --owner-file <path> [--auth-json <path>] [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate resume   [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] --pool-file <path> --owner-file <path> [--auth-json <path>] [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate status   [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] [--pool-file <path>] [--owner-file <path>] [--auth-json <path>] [--db <path>] [--target-dir <path>] [--json]
  qlb migrate receipt  --provider anthropic --phase stage|rehearse|commit|failure|preflight [--pool-file <path>] [--owner-file <path>] [--db <path>] [--target-dir <path>] [--json]
  qlb retire native status  --harness claude-code|codex-cli [--json] [--db <path>]
  qlb retire native execute --harness claude-code|codex-cli --confirm-real-retirement [--db <path>]
  qlb accounts prune --account <id> --confirm [--json] [--db <path>]
  qlb audit [--limit N] [--json] [--db <path>]

SAFETY: running migrate stage/rehearse/commit/rollback/resume without path
overrides targets the REAL ~/.pi/agent/ files (anthropic-pool.json for
--provider anthropic, auth.json for xai|kimi-coding|openai-codex, plus the
matching qlb-owner*.json). That is a REAL cutover and is refused unless
--confirm-real-cutover is also passed. Tests and dry runs MUST pass
--pool-file / --auth-json (including the Anthropic Pi auth.json) / --owner-file (or --target-dir) pointing at a
temp copy. Do NOT pass --confirm-real-cutover unless you intend to cut over
live Pi. Default --provider is anthropic (backward compatible).
Single-grant providers (xai, kimi-coding, openai-codex) shadow-retain the
native auth.json entry — QLB never deletes or renames that shared file.
OpenRouter is a static API key in Keychain service pi-openrouter (read-only;
QLB never writes that service). Ownership is qlb-owner-openrouter.json +
journal pi-openrouter; the QLB copy lives at qlb:openrouter:openrouter-default.
qlb codex gate makes a handful of real Codex backend requests (read-only
use of ~/.codex/auth.json). Automated tests never take this path.
qlb retire native status is read-only. qlb retire native execute is refused unless
--confirm-real-retirement is passed AND eligibility gates pass (QLB_OWNED,
7-day soak, 20 clean decisions, live ping). Do NOT run retire execute until
those production soak criteria are actually met.
Default qlb status human view is the dashboard (grouped by account with
health glyph, ownership, overrides, remaining capacity, and 5h/7d reset
times). Pass --flat for the original bucket table. --json keeps
{fetchedAt, accounts} and adds ownership, override, health, healthGlyph
on each account (additive; existing fields unchanged).
qlb setup prints copy-paste snippets only and never edits files outside
this repo (setup pi writes scripts/hooks/pi-advisory.sh here), except
setup hermes, which installs QLB's own files under ~/.hermes/{plugins,scripts}
and ~/Library/LaunchAgents — never inside the hermes-agent checkout.
qlb override pin/reserve/drain-first: --until defaults to 24h from now when
omitted (ISO datetime or duration like 2h/30m/1d). Pin forces that account
for one session id; reserve excludes an account from automatic selection;
drain-first biases selection toward an account.
qlb audit is read-only: last N routing decisions (default 20, newest first).
Empty store prints "no decisions" or [].`;

type StatusHistoryKind = 'switches' | 'relogins';
type StatusOpts = {
  cmd: 'status';
  json: boolean;
  view: 'dashboard' | 'flat';
  history?: StatusHistoryKind;
  window: boolean;
};
type SetupOpts = { cmd: 'setup'; json: boolean; harness: SetupHarness | 'hermes' };
type InitOpts = { cmd: 'init'; json: boolean };
type DoctorOpts = { cmd: 'doctor'; json: boolean; live: boolean };
type RefreshProvider = 'kimi-coding' | 'openai-codex';
type RefreshOpts = { cmd: 'refresh'; json: boolean; allowProbe: boolean; provider?: RefreshProvider };

export function filterRefreshAdapters<T extends { id: string }>(adapters: T[], provider?: string): T[] {
  return provider === undefined ? adapters : adapters.filter((adapter) => adapter.id === provider);
}
type WhyOpts = {
  cmd: 'why';
  json: boolean;
  model?: string;
  fallback: string[];
  session?: string;
  strategy?: Strategy;
};
type ResolveOpts = {
  cmd: 'resolve';
  json: boolean;
  model: string;
  fallback: string[];
  session?: string;
  harness?: string;
  effort?: string;
  strategy: Strategy;
};
type OverridePinOpts = {
  cmd: 'override';
  sub: 'pin';
  json: boolean;
  db?: string;
  session: string;
  account: string;
  until?: string;
};
type OverrideAccountOpts = {
  cmd: 'override';
  sub: 'reserve' | 'drain-first';
  json: boolean;
  db?: string;
  account: string;
  until?: string;
};
type OverrideClearOpts = {
  cmd: 'override';
  sub: 'clear';
  json: boolean;
  db?: string;
  session?: string;
  account?: string;
  all: boolean;
};
type OverrideListOpts = {
  cmd: 'override';
  sub: 'list';
  json: boolean;
  db?: string;
};
type OverrideOpts = OverridePinOpts | OverrideAccountOpts | OverrideClearOpts | OverrideListOpts;
type MigrateSub = 'stage' | 'rehearse' | 'commit' | 'rollback' | 'resume' | 'status' | 'receipt';
type MigrateOpts = {
  cmd: 'migrate';
  sub: MigrateSub;
  json: boolean;
  provider: MigrateProvider;
  providerExplicit: boolean;
  poolFile: string;
  ownerFile: string;
  authJson: string;
  /** Raw winning config spelling, admitted before config normalization. */
  protectedPiAuthJsonPath: string;
  db?: string;
  confirmRealCutover: boolean;
  phase?: AnthropicReceiptPhase | 'preflight';
  initialActive?: string;
};
type PolicySetOpts = {
  cmd: 'policy';
  sub: 'set';
  json: boolean;
  db?: string;
  harness: string;
  virtualModel: string;
  realModel: string;
  effort: string;
  fallback: string[];
  sessionMode: string;
};
type PolicyListOpts = {
  cmd: 'policy';
  sub: 'list';
  json: boolean;
  db?: string;
  harness?: string;
};
type PolicyOpts = PolicySetOpts | PolicyListOpts;
type CodexProbeClaimsOpts = {
  cmd: 'codex-probe-claims';
  args: string[];
};
type GateOpts = {
  cmd: 'gate';
  target: 'codex';
  json: boolean;
  db?: string;
};
type ProxyOpts = {
  cmd: 'proxy';
  json: boolean;
  db?: string;
  infoPath?: string;
  idleMs?: number;
  noIdle: boolean;
  port?: number;
  startedBy?: string;
};
type ConsumeSub = 'enable' | 'disable' | 'status';
type ConsumeOpts = {
  cmd: 'consume';
  sub: ConsumeSub;
  json: boolean;
  provider: 'anthropic';
  db?: string;
};
type RetireSub = 'status' | 'execute';
type RetireOpts = {
  cmd: 'retire';
  sub: RetireSub;
  json: boolean;
  harness: RetireHarness;
  db?: string;
  confirmRealRetirement: boolean;
};
type NativeResyncOpts = {
  cmd: 'native-resync';
  json: boolean;
  provider: MigrateProvider;
  account: string;
  db?: string;
};
type AccountsSub = 'prune';
type AccountsOpts = {
  cmd: 'accounts';
  sub: AccountsSub;
  json: boolean;
  account: string;
  confirm: boolean;
  db?: string;
};
type AuditOpts = {
  cmd: 'audit';
  json: boolean;
  limit: number;
  db?: string;
};
type Opts = InitOpts | DoctorOpts | RefreshOpts | WhyOpts | StatusOpts | SetupOpts | ResolveOpts | MigrateOpts | PolicyOpts | CodexProbeClaimsOpts | GateOpts | ProxyOpts | ConsumeOpts | RetireOpts | NativeResyncOpts | OverrideOpts | AccountsOpts | AuditOpts;

const MIGRATE_SUBS: readonly MigrateSub[] = [
  'stage',
  'rehearse',
  'commit',
  'rollback',
  'resume',
  'status',
  'receipt',
];

function isMigrateSub(s: string | undefined): s is MigrateSub {
  return !!s && (MIGRATE_SUBS as readonly string[]).includes(s);
}

function physicalCwd(): string {
  return realpathSync.native(process.cwd());
}

function validateCliMigratePath(
  raw: string | undefined,
  flag: string,
  kind: MigratePathKind,
  cwd: string,
): string {
  if (raw === undefined) throw new MigratePathError(flag, 'path must be a string');
  return validateRawMigratePath(raw, { flag, kind, cwd });
}

function targetChild(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/** Expand only a leading home marker by literal concatenation; never normalize it. */
function expandRawPiAuthJsonPath(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return home === '/' ? `/${raw.slice(2)}` : `${home}/${raw.slice(2)}`;
  }
  return raw;
}

function parseMigrateArgs(args: string[]): MigrateOpts {
  const subRaw = args[0];
  if (subRaw === '-h' || subRaw === '--help' || subRaw === undefined) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!isMigrateSub(subRaw)) {
    console.error('qlb migrate: unknown subcommand. Expected stage|rehearse|commit|rollback|resume|status|receipt');
    console.error(USAGE);
    process.exit(1);
  }
  const rest = args.slice(1);
  const cwd = physicalCwd();
  let json = false;
  let poolFile: string | undefined;
  let ownerFile: string | undefined;
  let authJson: string | undefined;
  let targetDir: string | undefined;
  let db: string | undefined;
  let confirmRealCutover = false;
  let providerRaw: string | undefined;
  let phaseRaw: string | undefined;
  let initialActive: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--confirm-real-cutover') {
      confirmRealCutover = true;
      continue;
    }
    if (arg === '--pool-file') {
      poolFile = validateCliMigratePath(rest[++i], '--pool-file', 'file', cwd);
      continue;
    }
    if (arg === '--owner-file') {
      ownerFile = validateCliMigratePath(rest[++i], '--owner-file', 'file', cwd);
      continue;
    }
    if (arg === '--auth-json') {
      authJson = validateCliMigratePath(rest[++i], '--auth-json', 'file', cwd);
      continue;
    }
    if (arg === '--provider') {
      providerRaw = rest[++i];
      continue;
    }
    if (arg === '--phase') {
      phaseRaw = rest[++i];
      continue;
    }
    if (arg === '--initial-active') {
      const alias = rest[++i];
      if (!alias || alias.startsWith('--')) {
        console.error('qlb migrate: --initial-active requires an alias');
        process.exit(1);
      }
      initialActive = alias;
      continue;
    }
    if (arg === '--target-dir') {
      targetDir = validateCliMigratePath(rest[++i], '--target-dir', 'dir', cwd);
      continue;
    }
    if (arg === '--db') {
      db = rest[++i];
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    console.error(`qlb migrate: unknown argument ${arg}`);
    console.error(USAGE);
    process.exit(1);
  }

  const providerRawOrDefault = providerRaw ?? 'anthropic';
  if (!isMigrateProvider(providerRawOrDefault)) {
    console.error(
      'qlb migrate: --provider must be anthropic|xai|kimi-coding|openai-codex|openrouter',
    );
    console.error(USAGE);
    process.exit(1);
  }
  const provider: MigrateProvider = providerRawOrDefault;
  if (subRaw === 'receipt') {
    if (provider !== 'anthropic') {
      console.error('qlb migrate receipt: --provider must be anthropic');
      process.exit(1);
    }
    if (!isReceiptPhase(phaseRaw)) {
      console.error(`qlb migrate receipt: --phase must be ${receiptPhaseList()}`);
      process.exit(1);
    }
  } else if (phaseRaw !== undefined) {
    console.error('qlb migrate: --phase is only valid with receipt');
    process.exit(1);
  }
  if (initialActive !== undefined && (subRaw !== 'rehearse' || provider !== 'anthropic')) {
    console.error('qlb migrate: --initial-active is only valid with rehearse --provider anthropic');
    process.exit(1);
  }

  // config.ts retains the actual winning spelling (flag, env, config file, or
  // default) so normalization cannot erase a hostile segment before migration
  // admission sees it.
  const piAuthJsonFlag = config.piAuthJsonPathSource === 'flag'
    ? '--pi-auth-json-path'
    : config.piAuthJsonPathSource === 'env'
      ? 'QLB_PI_AUTH_JSON_PATH'
      : config.piAuthJsonPathSource === 'config-file'
        ? 'config piAuthJsonPath'
        : 'default piAuthJsonPath';
  const protectedPiAuthJsonPath = validateCliMigratePath(
    expandRawPiAuthJsonPath(config.piAuthJsonPathRaw, qlbHomeDir()),
    piAuthJsonFlag,
    'file',
    cwd,
  );

  if (targetDir !== undefined) {
    if (!ownerFile) ownerFile = targetChild(targetDir, 'qlb-owner.json');
    if (!poolFile) poolFile = targetChild(targetDir, 'anthropic-pool.json');
    if (!authJson) authJson = targetChild(targetDir, 'auth.json');
  }

  return {
    cmd: 'migrate',
    sub: subRaw,
    json,
    provider,
    providerExplicit: providerRaw !== undefined,
    poolFile: validateCliMigratePath(poolFile ?? DEFAULT_POOL_FILE, '--pool-file', 'file', cwd),
    ownerFile: validateCliMigratePath(ownerFile ?? defaultOwnerFileFor(provider), '--owner-file', 'file', cwd),
    authJson: validateCliMigratePath(authJson ?? DEFAULT_AUTH_JSON, '--auth-json', 'file', cwd),
    protectedPiAuthJsonPath,
    db,
    confirmRealCutover,
    phase: isReceiptPhase(phaseRaw) ? phaseRaw : undefined,
    ...(initialActive === undefined ? {} : { initialActive }),
  };
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function parsePolicyArgs(argsIn: string[]): PolicyOpts {
  const args = [...argsIn];
  const sub = args.shift();
  if (sub === '-h' || sub === '--help' || sub === undefined) {
    console.log(USAGE);
    process.exit(0);
  }
  if (sub !== 'set' && sub !== 'list') {
    console.error('qlb policy: unknown subcommand. Expected set|list');
    console.error(USAGE);
    process.exit(1);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const db = takeFlag(args, '--db');
  const harness = takeFlag(args, '--harness');
  if (sub === 'list') {
    if (args.length > 0) {
      console.error(`qlb policy list: unknown argument ${args[0]}`);
      process.exit(1);
    }
    return { cmd: 'policy', sub: 'list', json, db, harness };
  }
  const virtualModel =
    takeFlag(args, '--virtual-model') ?? takeFlag(args, '--virtual');
  const realModel = takeFlag(args, '--real-model') ?? takeFlag(args, '--real');
  const effort = takeFlag(args, '--effort');
  const fallbackRaw = takeFlag(args, '--fallback');
  const sessionMode = takeFlag(args, '--session-mode') ?? 'header';
  if (args.length > 0) {
    console.error(`qlb policy set: unknown argument ${args[0]}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (!harness || !virtualModel || !realModel || !effort) {
    console.error(
      'qlb policy set: --harness, --virtual-model, --real-model, and --effort are required',
    );
    console.error(USAGE);
    process.exit(1);
  }
  const fallback = (fallbackRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    cmd: 'policy',
    sub: 'set',
    json,
    db,
    harness,
    virtualModel,
    realModel,
    effort,
    fallback,
    sessionMode,
  };
}

function parseGateArgs(argsIn: string[]): GateOpts {
  const args = [...argsIn];
  if (args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const db = takeFlag(args, '--db');
  if (args.length > 0) {
    console.error(`qlb gate: unknown argument ${args[0]}`);
    process.exit(1);
  }
  return { cmd: 'gate', target: 'codex', json, db };
}

function parseProxyArgs(argsIn: string[]): ProxyOpts {
  const args = [...argsIn];
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const noIdle = args.includes('--no-idle');
  if (noIdle) args.splice(args.indexOf('--no-idle'), 1);
  const db = takeFlag(args, '--db');
  const infoPath = takeFlag(args, '--info-path');
  const idleRaw = takeFlag(args, '--idle-ms');
  const portRaw = takeFlag(args, '--port');
  let startedBy = takeFlag(args, '--started-by');
  if (!startedBy) {
    const eq = args.find((a) => a.startsWith('--started-by='));
    if (eq) {
      startedBy = eq.slice('--started-by='.length);
      args.splice(args.indexOf(eq), 1);
    }
  }
  if (args.length > 0) {
    console.error(`qlb proxy: unknown argument ${args[0]}`);
    process.exit(1);
  }
  const idleMs = idleRaw != null ? Number(idleRaw) : undefined;
  if (idleRaw != null && (!Number.isFinite(idleMs) || (idleMs ?? 0) <= 0)) {
    console.error('qlb proxy: --idle-ms must be a positive number');
    process.exit(1);
  }
  const port = portRaw != null ? Number(portRaw) : undefined;
  if (portRaw != null && (!Number.isInteger(port) || (port ?? 0) < 1 || (port ?? 0) > 65535)) {
    console.error('qlb proxy: --port must be an integer between 1 and 65535');
    process.exit(1);
  }
  if (startedBy != null && startedBy !== 'wrapper' && startedBy !== 'cli') {
    console.error('qlb proxy: --started-by must be wrapper or cli');
    process.exit(1);
  }
  return { cmd: 'proxy', json, db, infoPath, idleMs, noIdle, port, startedBy };
}

function parseConsumeArgs(argsIn: string[]): ConsumeOpts {
  const args = [...argsIn];
  const sub = args.shift();
  if (sub === '-h' || sub === '--help' || sub === undefined) {
    console.log(USAGE);
    process.exit(0);
  }
  if (sub !== 'enable' && sub !== 'disable' && sub !== 'status') {
    console.error('qlb consume: unknown subcommand. Expected enable|disable|status');
    console.error(USAGE);
    process.exit(1);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const db = takeFlag(args, '--db');
  const provider = takeFlag(args, '--provider');
  if (args.length > 0) {
    console.error(`qlb consume ${sub}: unknown argument ${args[0]}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (provider !== 'anthropic') {
    console.error('qlb consume: --provider must be anthropic');
    console.error(USAGE);
    process.exit(1);
  }
  return { cmd: 'consume', sub, json, provider: 'anthropic', db };
}

function parseAccountsArgs(argsIn: string[]): AccountsOpts {
  const args = [...argsIn];
  const sub = args.shift();
  if (sub === '-h' || sub === '--help' || sub === undefined) {
    console.log(USAGE);
    process.exit(0);
  }
  if (sub !== 'prune') {
    console.error('qlb accounts: unknown subcommand. Expected prune');
    console.error(USAGE);
    process.exit(1);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const confirm = args.includes('--confirm');
  if (confirm) args.splice(args.indexOf('--confirm'), 1);
  const db = takeFlag(args, '--db');
  const account = takeFlag(args, '--account');
  if (args.length > 0) {
    console.error(`qlb accounts ${sub}: unknown argument ${args[0]}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (!account) {
    console.error('qlb accounts prune: --account is required');
    console.error(USAGE);
    process.exit(1);
  }
  if (!confirm) {
    console.error(
      'REFUSED: not_confirmed — qlb accounts prune requires --confirm.\n' +
        'This permanently deletes the account\'s local metadata rows (accounts/snapshots/overrides/poll_claims/leases).\n' +
        'Credentials (Keychain, native stores, owner files) are never removed.\n' +
        'Participants of any trusted MIRRORED/VALIDATED/QLB_OWNED/RETIRED journal row are refused, including after rollback (post-rollback prune is deferred).',
    );
    process.exit(2);
  }
  return { cmd: 'accounts', sub, json, account, confirm, db };
}

function parseAuditArgs(argsIn: string[]): AuditOpts {
  const args = [...argsIn];
  if (args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const db = takeFlag(args, '--db');
  let limit = DEFAULT_AUDIT_LIMIT;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1) {
    const raw = args[limitIdx + 1];
    if (raw === undefined || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      console.error('qlb audit: --limit must be a positive integer');
      process.exit(1);
    }
    args.splice(limitIdx, 2);
    limit = Number(raw);
  }
  if (args.length > 0) {
    console.error(`qlb audit: unknown argument ${args[0]}`);
    console.error(USAGE);
    process.exit(1);
  }
  return { cmd: 'audit', json, db, limit };
}

function parseRetireArgs(argsIn: string[]): RetireOpts {
  const args = [...argsIn];
  const sub = args.shift();
  if (sub === '-h' || sub === '--help' || sub === undefined) {
    console.log(USAGE);
    process.exit(0);
  }
  if (sub !== 'status' && sub !== 'execute') {
    console.error('qlb retire: unknown subcommand. Expected status|execute');
    console.error(USAGE);
    process.exit(1);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const confirmRealRetirement = args.includes('--confirm-real-retirement');
  if (confirmRealRetirement) {
    args.splice(args.indexOf('--confirm-real-retirement'), 1);
  }
  const db = takeFlag(args, '--db');
  const harnessRaw = takeFlag(args, '--harness');
  if (args.length > 0) {
    console.error(`qlb retire ${sub}: unknown argument ${args[0]}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (!isRetireHarness(harnessRaw)) {
    console.error(
      'qlb retire: --harness is required and must be claude-code or codex-cli',
    );
    console.error(USAGE);
    process.exit(1);
  }
  if (sub === 'execute' && !confirmRealRetirement) {
    console.error(
      'REFUSED: qlb retire native execute requires --confirm-real-retirement.\n' +
        'This would retire a native Claude Code / Codex CLI credential store.\n' +
        'Run `qlb retire native status --harness <h>` (read-only) first.',
    );
    process.exit(2);
  }
  return {
    cmd: 'retire',
    sub,
    json,
    harness: harnessRaw,
    db,
    confirmRealRetirement,
  };
}

function parseSetupArgs(argsIn: string[]): SetupOpts {
  const args = [...argsIn];
  if (args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const harness = args.shift();
  if (args.length > 0) {
    console.error(`qlb setup: unknown argument ${args[0]}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (harness !== 'hermes' && !isSetupHarness(harness)) {
    console.error(
      'qlb setup: harness is required (pi|claude-code|codex-cli|generic|hermes)',
    );
    console.error(USAGE);
    process.exit(1);
  }
  return { cmd: 'setup', json, harness };
}

function parseNativeResyncArgs(argsIn: string[]): NativeResyncOpts {
  const args = [...argsIn];
  if (args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const db = takeFlag(args, '--db');
  const providerRaw = takeFlag(args, '--provider');
  const account = takeFlag(args, '--account');
  if (args.length > 0) {
    console.error(`qlb native-resync: unknown argument ${args[0]}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (!isMigrateProvider(providerRaw)) {
    console.error(
      'qlb native-resync: --provider is required and must be anthropic|xai|kimi-coding|openai-codex|openrouter',
    );
    console.error(USAGE);
    process.exit(1);
  }
  if (!account) {
    console.error('qlb native-resync: --account is required');
    console.error(USAGE);
    process.exit(1);
  }
  return { cmd: 'native-resync', json, provider: providerRaw, account, db };
}

function parseOverrideArgs(argsIn: string[]): OverrideOpts {
  const args = [...argsIn];
  const sub = args.shift();
  if (sub === '-h' || sub === '--help' || sub === undefined) {
    console.log(USAGE);
    process.exit(0);
  }
  const known = new Set(['pin', 'reserve', 'drain-first', 'clear', 'list']);
  if (!known.has(sub)) {
    console.error('qlb override: unknown subcommand. Expected pin|reserve|drain-first|clear|list');
    console.error(USAGE);
    process.exit(1);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const all = args.includes('--all');
  if (all) args.splice(args.indexOf('--all'), 1);
  const db = takeFlag(args, '--db');
  const session = takeFlag(args, '--session');
  const account = takeFlag(args, '--account');
  const until = takeFlag(args, '--until');
  if (args.length > 0) {
    console.error(`qlb override ${sub}: unknown argument ${args[0]}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (sub === 'list') {
    return { cmd: 'override', sub: 'list', json, db };
  }
  if (sub === 'clear') {
    if (!session && !account && !all) {
      console.error('qlb override clear: require --session, --account, or --all');
      console.error(USAGE);
      process.exit(1);
    }
    return { cmd: 'override', sub: 'clear', json, db, session, account, all };
  }
  if (sub === 'pin') {
    if (!session || !account) {
      console.error('qlb override pin: --session and --account are required');
      console.error(USAGE);
      process.exit(1);
    }
    return { cmd: 'override', sub: 'pin', json, db, session, account, until };
  }
  if (sub !== 'reserve' && sub !== 'drain-first') {
    console.error('qlb override: unknown subcommand. Expected pin|reserve|drain-first|clear|list');
    console.error(USAGE);
    process.exit(1);
  }
  if (!account) {
    console.error(`qlb override ${sub}: --account is required`);
    console.error(USAGE);
    process.exit(1);
  }
  return { cmd: 'override', sub, json, db, account, until };
}

function parseWhyArgs(argsIn: string[]): WhyOpts {
  const args = [...argsIn];
  if (args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const model = takeFlag(args, '--model');
  const session = takeFlag(args, '--session');
  const strategyRaw = takeFlag(args, '--strategy');
  const fallbackRaw = takeFlag(args, '--fallback');
  if (args.length > 0) {
    console.error(`qlb why: unknown argument ${args[0]}`);
    console.error(USAGE);
    process.exit(1);
  }
  let strategy: Strategy | undefined;
  if (strategyRaw !== undefined) {
    if (!isStrategy(strategyRaw)) {
      console.error(
        `qlb why: --strategy must be ${STRATEGIES.join('|')} (got '${strategyRaw}')`,
      );
      console.error(USAGE);
      process.exit(1);
    }
    strategy = strategyRaw;
  }
  const fallback = (fallbackRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { cmd: 'why', json, model, fallback, session, strategy };
}

export function parseArgs(argv: string[]): Opts {
  const raw = stripConfigArgs(argv).slice(2);
  if (raw[0] === '-h' || raw[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  if (raw[0] === 'init') {
    const rest = raw.slice(1);
    const json = rest.includes('--json');
    if (json) rest.splice(rest.indexOf('--json'), 1);
    if (rest.length > 0) {
      console.error(`qlb init: unknown argument ${rest[0]}`);
      process.exit(1);
    }
    return { cmd: 'init', json };
  }
  if (raw[0] === 'doctor') {
    const rest = raw.slice(1);
    const json = rest.includes('--json');
    if (json) rest.splice(rest.indexOf('--json'), 1);
    const live = rest.includes('--live');
    if (live) rest.splice(rest.indexOf('--live'), 1);
    if (rest.length > 0) {
      console.error(`qlb doctor: unknown argument ${rest[0]}`);
      process.exit(1);
    }
    return { cmd: 'doctor', json, live };
  }
  if (raw[0] === 'refresh') {
    const rest = raw.slice(1);
    const json = rest.includes('--json');
    if (json) rest.splice(rest.indexOf('--json'), 1);
    const allowProbe = rest.includes('--allow-probe');
    if (allowProbe) rest.splice(rest.indexOf('--allow-probe'), 1);
    const hasProvider = rest.includes('--provider');
    const provider = takeFlag(rest, '--provider');
    if (hasProvider && provider !== 'kimi-coding' && provider !== 'openai-codex') {
      console.error(`qlb refresh: --provider must be kimi-coding|openai-codex (got '${provider ?? ''}')`);
      console.error(USAGE);
      process.exit(1);
    }
    if (rest.length > 0) {
      console.error(`qlb refresh: unknown argument ${rest[0]}`);
      process.exit(1);
    }
    return { cmd: 'refresh', json, allowProbe, provider: provider as RefreshProvider | undefined };
  }
  if (raw[0] === 'why') {
    return parseWhyArgs(raw.slice(1));
  }
  if (raw[0] === 'migrate') {
    return parseMigrateArgs(raw.slice(1));
  }
  if (raw[0] === 'policy') {
    return parsePolicyArgs(raw.slice(1));
  }
  if (raw[0] === 'codex-probe-claims') {
    return { cmd: 'codex-probe-claims', args: raw.slice(1) };
  }
  if (raw[0] === 'gate' && raw[1] === '--codex') {
    return parseGateArgs(raw.slice(2));
  }
  if (raw[0] === 'proxy') {
    return parseProxyArgs(raw.slice(1));
  }
  if (raw[0] === 'consume') {
    return parseConsumeArgs(raw.slice(1));
  }
  if (raw[0] === 'retire' && raw[1] === '--native') {
    return parseRetireArgs(raw.slice(2));
  }
  if (raw[0] === 'native-resync') {
    return parseNativeResyncArgs(raw.slice(1));
  }
  if (raw[0] === 'override') {
    return parseOverrideArgs(raw.slice(1));
  }
  if (raw[0] === 'setup') {
    return parseSetupArgs(raw.slice(1));
  }
  if (raw[0] === 'accounts') {
    return parseAccountsArgs(raw.slice(1));
  }
  if (raw[0] === 'audit') {
    return parseAuditArgs(raw.slice(1));
  }

  let cmd: 'status' | 'resolve' = 'status';
  const args = [...raw];
  if (args[0] === 'status' || args[0] === 'resolve') {
    cmd = args.shift() as 'status' | 'resolve';
  }

  let json = false;
  let view: 'dashboard' | 'flat' = 'dashboard';
  let dashboard = false;
  let history: StatusHistoryKind | undefined;
  let window = false;
  let model: string | undefined;
  let fallback: string[] = [];
  let session: string | undefined;
  let harness: string | undefined;
  let effort: string | undefined;
  let strategyRaw: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--dashboard') {
      view = 'dashboard';
      dashboard = true;
      continue;
    }
    if (arg === '--switches' || arg === '--relogins') {
      if (history !== undefined) {
        if (cmd === 'resolve') {
          console.error('qlb resolve: --switches, --relogins, and --window are only valid with status');
          console.error(USAGE);
          process.exit(1);
        }
        console.error('qlb status: choose only one of --switches or --relogins');
        process.exit(1);
      }
      history = arg.slice(2) as StatusHistoryKind;
      continue;
    }
    if (arg === '--window') {
      window = true;
      continue;
    }
    if (arg === '--flat') {
      view = 'flat';
      continue;
    }
    if (arg === '--model') {
      model = args[++i];
      continue;
    }
    if (arg === '--fallback') {
      fallback = (args[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === '--session') {
      session = args[++i];
      continue;
    }
    if (arg === '--harness') {
      harness = args[++i];
      continue;
    }
    if (arg === '--effort') {
      effort = args[++i];
      continue;
    }
    if (arg === '--strategy') {
      strategyRaw = args[++i];
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    console.error(USAGE);
    process.exit(1);
  }

  if (cmd === 'resolve') {
    if (history !== undefined || window) {
      console.error('qlb resolve: --switches, --relogins, and --window are only valid with status');
      console.error(USAGE);
      process.exit(1);
    }
    if (!model) {
      console.error('qlb resolve: --model is required');
      console.error(USAGE);
      process.exit(1);
    }
    const strategyCandidate = strategyRaw ?? config.defaultStrategy;
    if (!isStrategy(strategyCandidate)) {
      console.error(
        `qlb resolve: --strategy must be ${STRATEGIES.join('|')} (got '${strategyCandidate}')`,
      );
      console.error(USAGE);
      process.exit(1);
    }
    return { cmd, json, model, fallback, session, harness, effort, strategy: strategyCandidate };
  }
  if (window && history === undefined) {
    console.error('qlb status: --window requires --switches or --relogins');
    process.exit(1);
  }
  if (history !== undefined && (dashboard || view !== 'dashboard')) {
    console.error('qlb status: --dashboard and --flat cannot be used with history output');
    process.exit(1);
  }
  return { cmd: 'status', json, view, history, window };
}

type MigratePathAdmission = {
  protectedRoot: ReturnType<typeof resolveProtectedRoot>;
  native: ReturnType<typeof resolveMigratePath>;
  owner: ReturnType<typeof resolveMigratePath>;
  auth?: ReturnType<typeof resolveMigratePath>;
};

/**
 * Resolve only paths this provider can touch, before opening the store. This
 * keeps structural refusals from creating a database or migration backup.
 */
function prepareMigratePathAdmission(opts: MigrateOpts): MigratePathAdmission | undefined {
  if (opts.sub === 'status' || opts.sub === 'receipt') return undefined;
  assertSupportedPlatform();
  const cwd = physicalCwd();
  const protectedRoot = resolveProtectedRoot(opts.protectedPiAuthJsonPath, {
    flag: 'QLB_PI_AUTH_JSON_PATH', cwd,
  });
  const owner = resolveMigratePath(opts.ownerFile, {
    flag: '--owner-file', kind: 'file', entryLeaf: true,
  });
  if (opts.provider === 'anthropic') {
    const pool = resolveMigratePath(opts.poolFile, {
      flag: '--pool-file', kind: 'file', entryLeaf: true,
    });
    const auth = resolveMigratePath(opts.authJson, { flag: '--auth-json', kind: 'file' });
    return { protectedRoot, native: pool, owner, auth };
  }
  if (isSingleGrantProvider(opts.provider)) {
    const auth = resolveMigratePath(opts.authJson, { flag: '--auth-json', kind: 'file' });
    return { protectedRoot, native: auth, owner };
  }
  return { protectedRoot, native: owner, owner };
}

/** Keep the cswap ownership refusal ahead of the explicit real-cutover policy. */
function assertNoUnconfirmedRealCutover(opts: MigrateOpts, paths: MigratePathAdmission | undefined): void {
  if (paths === undefined) return;
  const real =
    isInsideProtectedRoot(paths.native, paths.protectedRoot)
    || isInsideProtectedRoot(paths.owner, paths.protectedRoot)
    || (paths.auth !== undefined && isInsideProtectedRoot(paths.auth, paths.protectedRoot));
  if (real && !opts.confirmRealCutover) {
    console.error(
      'REFUSED: resolved native / owner path is inside ~/.pi/agent/.\n' +
        'This would perform a REAL Pi credential cutover.\n' +
        'Pass --pool-file / --auth-json and --owner-file pointing at a temp copy,\n' +
        'or pass --confirm-real-cutover if you truly intend to cut over live Pi.',
    );
    process.exit(2);
  }
}

function printInit(report: InitReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.overall}: QLB setup scan`);
  console.log(`${report.configWritten ? 'Wrote' : 'Kept existing'} config: ${report.configPath}`);
  for (const provider of report.providers) {
    console.log(`[${provider.level}] ${provider.provider}: ${provider.message}`);
  }
}

function printDoctor(report: DoctorReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const check of report.checks) {
    console.log(`[${check.level}] ${check.name}: ${check.message}`);
  }
  for (const provider of report.providers) {
    const live = provider.live ? `; ${provider.live.message}` : '';
    console.log(`[${provider.level}] ${provider.provider}: ${provider.message}${live}`);
  }
  console.log(`Overall: ${report.overall}`);
}

type StatusSwitch = {
  ts: string;
  provider: string;
  from: string | null;
  to: string;
  trigger: string;
  outcome: string;
  detail: string | null;
  injected: boolean;
};

type StatusRelogin = Omit<ReloginEvent, 'ts' | 'provider' | 'accountId' | 'kind' | 'detail' | 'evidence' | 'userDeniedAt'> & {
  ts: string;
  provider: string;
  accountId: string | null;
  kind: string;
  detail: string | null;
  evidence: string | null;
  userDeniedAt: string | null;
};

function redactedStatusString(value: string | null): string | null {
  return value === null ? null : redactSecrets(value, []);
}

function isoStatusTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function isoStatusTimestampOrNull(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  try {
    return isoStatusTimestamp(value);
  } catch {
    return null;
  }
}

function statusConfigTimestamp(store: Store, key: string): string | null {
  const raw = store.getConfig(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return value > Date.now() ? isoStatusTimestampOrNull(value) : null;
}

export type StatusCredentialReader = (accountId: string) => string;

export function statusAnthropicLoginExpiry(
  accountId: string,
  readCredential: StatusCredentialReader = (id) =>
    platformKeychain.getSync(qlbKeychainService('anthropic', id), QLB_KEYCHAIN_ACCOUNT),
): string | null {
  try {
    return loginExpiresAtIso(readCredential(accountId));
  } catch {
    return null;
  }
}

function statusActiveLogins(dbPath: string): Record<string, string | null> {
  const db = openStoreConnection(dbPath, true);
  try {
    const rows = db.prepare('SELECT provider, account_id AS accountId FROM active_login ORDER BY provider').all() as Array<{
      provider: string;
      accountId: string | null;
    }>;
    return Object.fromEntries(rows.map((row) => [
      redactedStatusString(row.provider) ?? '[redacted]',
      redactedStatusString(row.accountId),
    ]));
  } finally {
    db.close();
  }
}

function statusWindow(db: ReturnType<typeof openStoreConnection>): { start: number; end: number } | null {
  const current = phaseForConnection(db);
  if (current.id === 0 || current.cutoverAt === null || current.windowEnd === null) return null;
  return { start: current.cutoverAt, end: current.windowEnd };
}

function listStatusSwitches(
  db: ReturnType<typeof openStoreConnection>,
  window: { start: number; end: number } | undefined,
): StatusSwitch[] {
  const range = window ? 'WHERE ts >= ? AND ts <= ?' : '';
  const rows = db.prepare(`SELECT ts, provider, from_account AS fromAccount, to_account AS toAccount,
    trigger, outcome, detail, injected FROM switch_log ${range} ORDER BY ts DESC, id DESC`)
    .all(...(window ? [window.start, window.end] : [])) as Array<{
      ts: number; provider: string; fromAccount: string | null; toAccount: string; trigger: string;
      outcome: string; detail: string | null; injected: number;
    }>;
  return rows.map((row) => ({
    ts: isoStatusTimestamp(row.ts), provider: redactedStatusString(row.provider)!,
    from: redactedStatusString(row.fromAccount), to: redactedStatusString(row.toAccount)!,
    trigger: redactedStatusString(row.trigger)!, outcome: redactedStatusString(row.outcome)!,
    detail: redactedStatusString(row.detail), injected: row.injected !== 0,
  }));
}

function formatStatusRelogin(row: ReloginEvent): StatusRelogin {
  return {
    id: row.id, ts: isoStatusTimestamp(row.ts), provider: redactedStatusString(row.provider)!,
    accountId: redactedStatusString(row.accountId), kind: redactedStatusString(row.kind)!,
    detail: redactedStatusString(row.detail), evidence: redactedStatusString(row.evidence),
    userDeniedAt: row.userDeniedAt === null ? null : isoStatusTimestamp(row.userDeniedAt),
  };
}

async function runStatus(opts: StatusOpts): Promise<number> {
  if (opts.history !== undefined) {
    if (!existsSync(config.dbPath)) {
      if (opts.window) {
        console.error('qlb status: no-cutover-window');
        return 3;
      }
      console.error('qlb status: warning: history is not restricted to the cutover window');
      if (opts.json) console.log(JSON.stringify({ [opts.history]: [] }));
      return 0;
    }

    const db = openStoreConnection(config.dbPath, true);
    try {
      const schemaRefusal = readOnlySchemaRefusal(db);
      if (schemaRefusal) {
        console.error(`qlb status: refused: ${schemaRefusal}`);
        return 3;
      }
      const window = opts.window ? statusWindow(db) : undefined;
      if (opts.window && window === null) {
        console.error('qlb status: no-cutover-window');
        return 3;
      }
      if (!opts.window) console.error('qlb status: warning: history is not restricted to the cutover window');
      const activeWindow = window ?? undefined;
      const rows = opts.history === 'switches'
        ? listStatusSwitches(db, activeWindow)
        : reloginsInWindow(db, activeWindow).map(formatStatusRelogin);
      if (opts.json) {
        console.log(JSON.stringify({ [opts.history]: rows }));
      } else {
        for (const row of rows) console.log(JSON.stringify(row));
      }
      return 0;
    } finally {
      db.close();
    }
  }

  const store = getStore();
  const nested = await Promise.all(adapters.map(async (adapter) => {
    const snaps = await safeFetch(adapter);
    recordObservation(
      store,
      { provider: adapter.id, persistsSnapshots: adapter.persistsSnapshots },
      snaps,
      'status',
    );
    return snaps;
  }));
  const lifecycle = phase(store);
  const accounts = nested.flat().map((account) =>
    account.provider === 'anthropic'
      && qlbOwnsAnthropicUsage(lifecycle.state)
      && !(account.accountId === account.provider && account.error !== undefined)
      ? { ...account, loginExpiresAt: statusAnthropicLoginExpiry(account.accountId) }
      : account,
  );
  const ownershipForProvider = makeOwnershipReader(store);
  // Use the lifecycle reader shared with `qlb cutover`, rather than Pi's
  // ownership journal, to decide whether Claude's active_login is authoritative.
  const claudeCutoverPhase = lifecycle.state;
  const enriched = enrichAccounts(accounts, {
    ownershipForProvider,
    overrideForAccount: (id) => overrideFromStore(store, id),
    claudeCutoverPhase,
    activeAccountForProvider: (provider, providerAccounts) => {
      // The dashboard invokes this once for eligible Anthropic rows, so a
      // status render takes one active_login snapshot rather than one per row.
      const accountId = store.getActiveLogin(provider)?.accountId;
      if (!accountId) return undefined;
      return activeAnthropicMarker(store.getAnthropicSlotStatusIdentity(accountId), providerAccounts);
    },
  });
  if (opts.json) {
    console.log(JSON.stringify({
      fetchedAt: Date.now(),
      lifecycle: {
        state: lifecycle.state,
        windowEnd: isoStatusTimestampOrNull(lifecycle.windowEnd),
      },
      activeLogin: statusActiveLogins(config.dbPath),
      parked: statusConfigTimestamp(store, 'auto.anthropic.parkedUntil'),
      breaker: statusConfigTimestamp(store, 'auto.anthropic.suspendedUntil'),
      accounts: decorateStatusJson(enriched),
    }, null, 2));
    return 0;
  }
  if (opts.view === 'flat') {
    console.log(formatFlatTable(enriched));
    return 0;
  }
  console.log(formatDashboard(enriched));
  return 0;
}

function printResolveHuman(decision: ReturnType<typeof resolveFromSnapshots>): void {
  if (!decision.ok) {
    if (decision.error === 'PINNED_UNAVAILABLE') {
      console.log('PINNED_UNAVAILABLE');
      console.log(decision.reason);
      return;
    }
    if (decision.error === 'UNAVAILABLE') {
      console.log('UNAVAILABLE');
      console.log(decision.reason);
      return;
    }
    console.log('EXHAUSTED');
    if (decision.earliestReset) {
      console.log(
        `earliest reset: ${decision.earliestReset.accountId} ${decision.earliestReset.limitType} ${formatRelative(decision.earliestReset.at)}`,
      );
    } else {
      console.log('earliest reset: unknown');
    }
    return;
  }
  const substituted = decision.servedModel !== decision.requestedModel;
  if (substituted) {
    console.log(`⚠ served by ${decision.servedModel}`);
  }
  console.log(`provider:  ${decision.provider}`);
  console.log(`account:   ${decision.snapshot.label} (${decision.accountId})`);
  console.log(`requested: ${decision.requestedModel}`);
  console.log(`served:    ${decision.servedModel}`);
  console.log(`mode:      ${decision.mode}`);
  console.log(`strategy:  ${decision.strategy}`);
  console.log(`reason:    ${decision.reason}`);
  for (const [bucket, reading] of Object.entries(decision.snapshot.buckets)) {
    console.log(
      `  ${bucket}  ${formatUsedPct(reading.usedPct)}  ${reading.confidence}  resets ${formatRelative(reading.resetAt)}`,
    );
  }
}

function printResolveJson(decision: ReturnType<typeof resolveFromSnapshots>): void {
  if (!decision.ok) {
    if (decision.error === 'PINNED_UNAVAILABLE') {
      console.log(
        JSON.stringify(
          {
            error: 'PINNED_UNAVAILABLE',
            requestedModel: decision.requestedModel,
            accountId: decision.accountId,
            reason: decision.reason,
            decisionId: decision.decisionId,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (decision.error === 'UNAVAILABLE') {
      console.log(JSON.stringify({
        error: 'UNAVAILABLE',
        requestedModel: decision.requestedModel,
        reason: decision.reason,
        decisionId: decision.decisionId,
      }, null, 2));
      return;
    }
    console.log(
      JSON.stringify(
        {
          error: 'EXHAUSTED',
          requestedModel: decision.requestedModel,
          earliestReset: decision.earliestReset,
          decisionId: decision.decisionId,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    JSON.stringify(
      {
        decisionId: decision.decisionId,
        provider: decision.provider,
        accountId: decision.accountId,
        model: decision.requestedModel,
        requestedModel: decision.requestedModel,
        servedModel: decision.servedModel,
        reason: decision.reason,
        mode: decision.mode,
        strategy: decision.strategy,
        snapshot: decision.snapshot,
      },
      null,
      2,
    ),
  );
}

async function collectRoutingCandidates(
  store: Store,
  models: string[],
  probe: boolean,
  recordAs?: 'resolve',
) {
  const usesCodex = models.some((model) => providerForModel(model) === 'openai-codex');
  const collected = await collectCandidates({
    adapters,
    store,
    models: models.filter((model) => providerForModel(model) !== 'openai-codex'),
    probe,
    ...(recordAs === undefined ? {} : { recordAs }),
  });
  return {
    ...collected,
    snapshots: usesCodex
      ? [...collected.snapshots, ...snapshotsFromStore(store, 'openai-codex')]
      : collected.snapshots,
  };
}

async function runResolve(opts: ResolveOpts): Promise<number> {
  if (!providerForModel(opts.model)) {
    console.error(`qlb resolve: unknown model '${opts.model}' (cannot map to a provider)`);
    return 1;
  }
  const store = getStore();
  const models = [opts.model, ...opts.fallback];
  const { snapshots } = await collectRoutingCandidates(store, models, true, 'resolve');
  const decision = resolveFromSnapshots({
    model: opts.model,
    fallback: opts.fallback,
    session: opts.session,
    harness: opts.harness,
    effort: opts.effort,
    strategy: opts.strategy,
    snapshots,
    store,
  });
  if (opts.json) printResolveJson(decision);
  else printResolveHuman(decision);
  return decision.ok ? 0 : 1;
}

async function runWhy(opts: WhyOpts): Promise<number> {
  const store = getStore();
  let model: string;
  let modelSource: 'flag' | 'last routing decision' | 'default';
  if (opts.model) {
    if (!providerForModel(opts.model)) {
      console.error(`qlb why: unknown model '${opts.model}' (cannot map to a provider)`);
      return 1;
    }
    model = opts.model;
    modelSource = 'flag';
  } else {
    const last = store.listRoutingDecisions(1)[0];
    if (last?.requested_model && providerForModel(last.requested_model)) {
      model = last.requested_model;
      modelSource = 'last routing decision';
    } else {
      model = DEFAULT_WHY_MODEL;
      modelSource = 'default';
    }
  }
  const strategy: Strategy = opts.strategy
    ?? (isStrategy(config.defaultStrategy) ? config.defaultStrategy : 'headroom');
  const { snapshots, observations } = await collectRoutingCandidates(store, [model, ...opts.fallback], false);
  const report = explainWhy({
    model,
    modelSource,
    fallback: opts.fallback,
    session: opts.session,
    strategy,
    snapshots,
    store,
    observations,
  });
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatWhyHuman(report));
  return 0;
}

async function printAnthropicPreflight(opts: MigrateOpts): Promise<number> {
  if (process.env.QLB_TEST_MODE === '1') {
    console.error('qlb migrate receipt: preflight-credentials-unavailable');
    return 1;
  }
  try {
    const receipt = await runAnthropicPreflight({
      dbPath: opts.db ?? config.dbPath,
      poolFile: opts.poolFile,
      backend: platformKeychain,
    });
    console.log(formatAnthropicPreflight(receipt, opts.json));
    return receipt.disposition === 'go' ? 0 : 1;
  } catch {
    console.error('qlb migrate receipt: preflight-failed');
    return 1;
  }
}

function printMigrate(status: ReturnType<Migration['status']>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`store:     ${status.store}`);
  if (status.provider) console.log(`provider:  ${status.provider}`);
  if (status.nativeStrategy) console.log(`strategy:  ${status.nativeStrategy}`);
  console.log(`state:     ${status.state}`);
  console.log(`owner:     ${status.ownerFile}`);
  console.log(`native:    ${status.nativeStore}`);
  console.log(`pi next:   ${status.piAtNextLaunch}`);
  console.log(`resume:    ${status.resumeAction}`);
  if (status.handback) {
    const value = (field: string): string => {
      const current = status.handback![field];
      return current !== null && typeof current === 'object'
        ? JSON.stringify(current)
        : String(current);
    };
    console.log(`hand-back phase: ${value('phase')}`);
    console.log(`hand-back keychain disposition: ${value('keychainDisposition')}`);
    console.log(`hand-back pi fingerprint: ${value('piFingerprint')}`);
    console.log(`hand-back decision: ${value('decision')}`);
    console.log(`hand-back fenced generation: ${value('fencedGeneration')}`);
    console.log(`hand-back rolled back at: ${value('rolledBackAt')}`);
  }
}

/** Refusal code shared by the Pi-ownership vs cswap-consume guards. */
const DUAL_OWNERSHIP_REFUSED = 'DUAL_OWNERSHIP_REFUSED';
const PI_POOL_OWNING_STATES = new Set(['MIRRORED', 'VALIDATED', 'QLB_OWNED', 'RETIRED']);

function piOwnerClaimsAnthropic(path: string): boolean {
  try {
    if (hasLegacyPiOwnerEntry(path, 'anthropic')) return true;
    const entry = readPiOwnerProviders(path).anthropic;
    return !!entry && typeof entry === 'object' && !Array.isArray(entry)
      && (entry as Record<string, unknown>).mode === 'qlb';
  } catch {
    // Ambiguous ownership must keep consume enable safely refused.
    return true;
  }
}
const FORWARD_MIGRATE_SUBS = new Set(['stage', 'rehearse', 'commit', 'resume']);

async function runMigrate(opts: MigrateOpts): Promise<number> {
  const paths = prepareMigratePathAdmission(opts);
  if (opts.phase === 'preflight') {
    return printAnthropicPreflight(opts);
  }
  let store: Store;
  let opened = false;
  if (opts.db) {
    store = openStore(opts.db);
    opened = true;
  } else {
    store = getStore();
  }
  try {
    if (
      opts.provider === 'anthropic' &&
      FORWARD_MIGRATE_SUBS.has(opts.sub) &&
      isConsumedState(store.getMigration(CSWAP_ANTHROPIC_STORE)?.state)
    ) {
      console.error(
        `qlb migrate ${opts.sub}: ${DUAL_OWNERSHIP_REFUSED} — cswap consume is enabled for Anthropic. ` +
          'Run `qlb consume disable --provider anthropic` first.',
      );
      return 1;
    }
    // After the ownership guard (which needs the store) so a CONSUMED journal
    // reports DUAL_OWNERSHIP_REFUSED even on default (live) paths; still before
    // any migration object is built or any native/owner file is touched.
    assertNoUnconfirmedRealCutover(opts, paths);
    if (opts.sub === 'receipt') {
      const phase = opts.phase;
      if (opts.provider !== 'anthropic' || phase === undefined) {
        console.error(`qlb migrate receipt: --provider must be anthropic and --phase must be ${receiptPhaseList()}`);
        return 1;
      }
      const sources = readAnthropicReceiptSources(
        opts.poolFile,
        opts.ownerFile,
        store.getMigration(PI_POOL_STORE)?.detail_json,
      );
      sources.adoptionSlots = store.listClaudeAdoptionSlots();
      sources.activeAccountId = store.getActiveLogin('anthropic')?.accountId ?? null;
      const receipt = projectAnthropicReceipt(phase, sources);
      console.log(formatAnthropicReceipt(receipt, opts.json));
      return receipt.disposition === 'success' ? 0 : 1;
    }
    const mig = isStaticKeyProvider(opts.provider)
      ? createStaticKeyMigration(
          store,
          platformKeychain,
          opts.provider,
          opts.ownerFile,
          readOpenRouterNativeKey,
        )
      : isSingleGrantProvider(opts.provider)
        ? createSingleGrantMigration(
            store,
            platformKeychain,
            opts.provider,
            opts.authJson,
            opts.ownerFile,
          )
        : new Migration(store, platformKeychain, opts.poolFile, opts.ownerFile, undefined, {
          authJsonPath: opts.authJson,
          allowPoolLegacyConversion: opts.provider === 'anthropic' && opts.providerExplicit,
        });
    let status;
    switch (opts.sub) {
      case 'stage':
        status = mig.stage();
        break;
      case 'rehearse':
        status = await mig.rehearse(
          defaultRehearseFn,
          process.env.QLB_TEST_MODE === '1' ? undefined : anthropicPoolFetchTransport(),
          opts.initialActive,
        );
        break;
      case 'commit':
        status = mig.commit();
        break;
      case 'rollback':
        status = mig.rollback();
        break;
      case 'resume':
        status = mig.resume();
        break;
      case 'status':
        status = mig.status();
        break;
    }
    printMigrate(status, opts.json);
    return 0;
  } finally {
    if (opened) store.close();
  }
}

function withStore<T>(db: string | undefined, fn: (store: Store) => Promise<T> | T): Promise<T> {
  const opened = !!db;
  const store = db ? openStore(db) : getStore();
  const run = async (): Promise<T> => {
    try {
      return await fn(store);
    } finally {
      if (opened) store.close();
    }
  };
  return run();
}

async function runPolicy(opts: PolicyOpts): Promise<number> {
  return withStore(opts.db, (store) => {
    if (opts.sub === 'list') {
      const rows = listPolicies(store, opts.harness);
      if (opts.json) {
        console.log(JSON.stringify({ policies: rows }, null, 2));
      } else if (rows.length === 0) {
        console.log('(no policies)');
      } else {
        for (const p of rows) {
          const fb = p.fallback.length ? p.fallback.join(',') : '-';
          console.log(
            `${p.harness}  ${p.virtualModel}  →  ${p.realModel}  effort=${p.effort}  fallback=${fb}  session=${p.sessionMode}`,
          );
        }
      }
      return 0;
    }
    const policy = setPolicy(store, {
      harness: opts.harness,
      virtualModel: opts.virtualModel,
      realModel: opts.realModel,
      effort: opts.effort,
      fallback: opts.fallback,
      sessionMode: opts.sessionMode,
    });
    if (opts.json) {
      console.log(JSON.stringify(policy, null, 2));
    } else {
      console.log(
        `set ${policy.harness} ${policy.virtualModel} → ${policy.realModel} effort=${policy.effort}`,
      );
    }
    return 0;
  });
}

async function runGate(opts: GateOpts): Promise<number> {
  return withStore(opts.db, async (store) => {
    const result = await runCodexGate(store, createDefaultCodexGateDeps());
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`verdict:  ${result.verdict}`);
      console.log(`version:  ${result.codexVersion ?? 'unknown'}`);
      console.log(`time:     ${new Date(result.timestamp).toISOString()}`);
      if (result.path) console.log(`path:     ${result.path}`);
      for (const step of result.steps) {
        const mark = step.skipped ? 'skip' : step.passed ? 'pass' : 'FAIL';
        console.log(`  ${step.step}  ${mark}  ${step.detail}`);
      }
    }
    return result.verdict === 'GO' ? 0 : 1;
  });
}

function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (busy: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(busy);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}


/**
 * qlb-pi finds the database (and the marker beside it) only through the environment
 * and config.json, resolved in its own working directory. Enabling consume on any
 * other database — a one-off --db/--db-path/--config, or a relative path — would
 * leave Pi on anthropic-pool. Returns the refusal reason, or null.
 */
function consumeTargetInvisibleToPi(dbPath: string): string | null {
  const configWarnings: string[] = [];
  const piVisibleDb = resolve(resolveConfig({ argv: [], warn: (m) => { configWarnings.push(m); } }).dbPath);
  const relative = configWarnings.find((m) => /\/dbPath '|QLB_CONFIG_PATH\/--config '/.test(m));
  if (relative) return `${relative.replace(/^qlb: /, '')} (Pi may start from another directory)`;
  if (resolve(dbPath) !== piVisibleDb) {
    return `${dbPath} is not the database Pi uses (${piVisibleDb}). ` +
      'Set QLB_DB_PATH in the environment Pi runs with (or dbPath in ~/.qlb/config.json) instead of a one-off flag.';
  }
  return null;
}

async function runConsume(opts: ConsumeOpts): Promise<number> {
  if (opts.sub === 'enable') {
    // Checked before the store is opened, so a refused target is never created.
    const refusal = consumeTargetInvisibleToPi(opts.db ?? config.dbPath);
    if (refusal) {
      console.error(`qlb consume enable: refusing — ${refusal}`);
      return 1;
    }
  }
  return withStore(opts.db, async (store) => {
    const dbPath = opts.db ?? config.dbPath;
    const marker = consumeMarkerPathFor(dbPath);
    if (opts.sub === 'enable') {
      const piPool = store.getMigration(PI_POOL_STORE)?.state;
      if ((piPool && PI_POOL_OWNING_STATES.has(piPool)) || piOwnerClaimsAnthropic(defaultOwnerFileFor('anthropic'))) {
        console.error(
          `qlb consume enable: ${DUAL_OWNERSHIP_REFUSED} — Pi's Anthropic accounts are QLB-owned ` +
            `(pi-pool ${piPool ?? 'owner file present'}). Roll back with ` +
            '`qlb migrate rollback --provider anthropic` first.',
        );
        return 1;
      }
      // Marker before journal: CONSUMED must never exist without the marker qlb-pi
      // uses to fail closed when `qlb consume status` is unreadable.
      try {
        mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
        writeFileSync(marker, `${JSON.stringify({ state: CONSUME_STATE })}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        console.error(`qlb consume enable: cannot write ${marker}: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      store.upsertMigration(CSWAP_ANTHROPIC_STORE, CONSUME_STATE, '{}');
      console.error('qlb consume enable: restart running Pi sessions; Pi picks its Anthropic mode at startup.');
    } else if (opts.sub === 'disable') {
      store.upsertMigration(CSWAP_ANTHROPIC_STORE, 'NATIVE', '{}');
      try {
        if (existsSync(marker)) unlinkSync(marker);
      } catch (err) {
        // A surviving marker makes Pi refuse Anthropic (fail closed): say exactly what to remove.
        console.error(
          `qlb consume disable: journal is NATIVE but ${marker} could not be removed ` +
            `(${err instanceof Error ? err.message : String(err)}); delete it, then restart Pi.`,
        );
        return 1;
      }
    }
    const state = store.getMigration(CSWAP_ANTHROPIC_STORE)?.state ?? 'NATIVE';
    if (opts.json) {
      console.log(JSON.stringify({ provider: 'anthropic', store: CSWAP_ANTHROPIC_STORE, state }));
    } else {
      console.log(`cswap-anthropic: ${state}`);
    }
    return 0;
  });
}

async function runProxy(opts: ProxyOpts): Promise<number> {
  if (opts.port != null) {
    const busy = await isPortListening(opts.port);
    if (busy) {
      console.error(`qlb proxy: 127.0.0.1:${opts.port} already in use`);
      return 1;
    }
  }
  const opened = !!opts.db;
  const store = opts.db ? openStore(opts.db) : getStore();
  const proxy = new LoopbackProxy({
    store,
    infoPath: opts.infoPath,
    idleTimeoutMs: opts.idleMs,
    noIdle: opts.noIdle,
    port: opts.port,
    startedBy: opts.startedBy,
    getCredentialForAccount: createOwnedCredentialSource({
      store,
      keychain: platformKeychain,
    }),
    resyncFromNative: bindDetectAndResync({
      store,
      keychain: platformKeychain,
      readNativeCredential: createNativeCredentialReader({
        poolFilePath: config.anthropicPoolPath,
        authJsonPath: config.piAuthJsonPath,
        readOpenRouterKey: readOpenRouterNativeKey,
      }),
    }),
    onIdle: () => {
      if (opened) store.close();
      process.exit(0);
    },
  });
  const info = await proxy.start();
  const publicInfo = { port: info.port, pid: info.pid, startedAt: info.startedAt };
  if (opts.json) {
    console.log(JSON.stringify({ ...publicInfo, infoPath: proxy.infoPath }, null, 2));
  } else {
    console.log(`qlb-proxy listening on 127.0.0.1:${info.port} (token in ${proxy.infoPath}, mode 0600)`);
  }
  const stop = async () => {
    await proxy.stop();
    if (opened) store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void stop();
  });
  process.on('SIGTERM', () => {
    void stop();
  });
  await new Promise(() => {
    /* stay alive until idle-exit or signal */
  });
  return 0;
}

function printRetireStatus(
  result: ReturnType<typeof checkRetirementEligibility>,
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`harness:    ${result.harness}`);
  console.log(`eligible:   ${result.eligible ? 'yes' : 'no'}`);
  console.log(`state:      ${result.migrationState ?? '(none)'}`);
  console.log(
    `committed:  ${result.committedAt != null ? new Date(result.committedAt).toISOString() : '(none)'}`,
  );
  console.log(`ok:         ${result.okDecisionCount} / 20`);
  console.log(`failed:     ${result.failedDecisionCount}`);
  if (result.reasons.length > 0) {
    console.log('reasons:');
    for (const reason of result.reasons) {
      console.log(`  - ${reason}`);
    }
  }
}

async function runAccounts(opts: AccountsOpts): Promise<number> {
  return withStore(opts.db, (store) => {
    if (opts.sub === 'prune') {
      const result = pruneAccount(store, { accountId: opts.account, confirm: opts.confirm });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`pruned account ${result.accountId}`);
        console.log(
          `removed: accounts=${result.removed.accounts} snapshots=${result.removed.snapshots} ` +
            `overrides=${result.removed.overrides} poll_claims=${result.removed.pollClaims} ` +
            `leases=${result.removed.leases} usage_discrepancies=${result.removed.usageDiscrepancies}`,
        );
      }
      return 0;
    }
    return 1;
  });
}

async function runRetire(opts: RetireOpts): Promise<number> {
  return withStore(opts.db, async (store) => {
    if (opts.sub === 'status') {
      const result = checkRetirementEligibility(store, opts.harness);
      printRetireStatus(result, opts.json);
      return result.eligible ? 0 : 1;
    }
    const result = await retireNativeStore(store, opts.harness, {
      nativePathToRemove: defaultNativePathForHarness(opts.harness),
      confirmRealRetirement: opts.confirmRealRetirement,
      pingFn: () => defaultPingFn(opts.harness),
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`retired ${opts.harness}: ${result.nativePathRemoved} → ${result.backupPath}`);
      console.log(`state:   ${result.state}`);
    }
    return 0;
  });
}

function printOverride(row: { kind: string; account_id: string; session: string | null; until: number | null }, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(row));
    return;
  }
  const until =
    row.until == null ? 'never' : new Date(row.until).toISOString();
  const session = row.session ? ` session=${row.session}` : '';
  console.log(`${row.kind}  account=${row.account_id}${session}  until=${until}`);
}

function printAuditOpenError(path: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('upgrade qlb')) {
    console.error(msg);
    return;
  }
  if (msg === WAL_SIDECAR_UNREADABLE || isWalSidecarUnreadableError(err)) {
    console.error(walSidecarUnreadableMessage(dirname(path)));
    return;
  }
  console.error(`qlb audit: cannot open store read-only (${msg})`);
}

async function runAudit(opts: AuditOpts): Promise<number> {
  const path = opts.db ?? config.dbPath;
  let reader;
  try {
    reader = openDecisionsReader(path);
  } catch (err) {
    printAuditOpenError(path, err);
    return 1;
  }
  if (!reader) {
    console.log(opts.json ? '[]' : 'no decisions');
    return 0;
  }
  try {
    const rows = reader.listRoutingDecisions(opts.limit);
    const decisions = rows.map((row) =>
      toAuditDecision(row, {
        accountProvider: row.account_id ? reader.getAccountProvider(row.account_id) : null,
      }),
    );
    console.log(formatAudit(decisions, opts.json));
    return 0;
  } catch (err) {
    printAuditOpenError(path, err);
    return 1;
  } finally {
    reader.close();
  }
}

async function runOverride(opts: OverrideOpts): Promise<number> {
  return withStore(opts.db, (store) => {
    if (opts.sub === 'list') {
      const rows = store.listActiveOverrides();
      if (opts.json) {
        console.log(JSON.stringify({ overrides: rows }, null, 2));
      } else if (rows.length === 0) {
        console.log('(no overrides)');
      } else {
        for (const row of rows) printOverride(row, false);
      }
      return 0;
    }
    if (opts.sub === 'clear') {
      const cleared = store.clearOverrides({
        all: opts.all,
        session: opts.session,
        accountId: opts.account,
      });
      if (opts.json) {
        console.log(JSON.stringify({ cleared }));
      } else {
        console.log(`cleared ${cleared} override${cleared === 1 ? '' : 's'}`);
      }
      return 0;
    }
    let until: number;
    try {
      until = parseUntil(opts.until);
    } catch (err) {
      console.error(`qlb override ${opts.sub}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const account = opts.account;
    const session = opts.sub === 'pin' ? opts.session : null;
    const row = store.upsertOverride({
      kind: opts.sub,
      accountId: account,
      session,
      until,
    });
    if (opts.json) {
      console.log(JSON.stringify(row, null, 2));
    } else {
      printOverride(row, false);
      if (!opts.until) {
        console.log('(until defaulted to 24h from now)');
      }
    }
    return 0;
  });
}

async function runNativeResync(opts: NativeResyncOpts): Promise<number> {
  return withStore(opts.db, async (store) => {
    const resync = bindDetectAndResync({
      store,
      keychain: platformKeychain,
      readNativeCredential: createNativeCredentialReader({
        poolFilePath: config.anthropicPoolPath,
        authJsonPath: config.piAuthJsonPath,
        readOpenRouterKey: readOpenRouterNativeKey,
      }),
    });
    const result = await resync(opts.account, opts.provider);
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`${result.resynced ? 'resynced' : 'unchanged'}: ${result.reason}`);
    }
    return 0;
  });
}

export function prepareCommandArgv(
  argv: string[],
  commands: CommandDefinition[] = discoverCommands(),
): string[] {
  const stripped = stripConfigArgs(argv);
  const match = resolveCommand(stripped.slice(2), commands);
  return match?.command.run
    ? [...stripped.slice(0, 2), ...match.command.run(match.args)]
    : stripped;
}

export function listCommandNames(commands: CommandDefinition[] = discoverCommands()): string[] {
  return commands.map((command) => command.name);
}

export function createCommandContext(): CommandContext {
  // Keep the state behind copied methods rather than an object-identity map:
  // commands commonly decorate a context with `{ ...context, stdout }`.
  const secrets = new Set<string>();
  return {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
    env: process.env,
    config,
    loadConfig: resolveConfig,
    home: qlbHomeDir(),
    registerSecret: (value) => {
      if (value) secrets.add(value);
    },
    deliverSecret: (value) => console.log(value),
    knownSecrets: () => [...secrets],
  };
}

function knownCommandSecrets(context: CommandContext): string[] {
  const secrets = new Set(context.knownSecrets());
  for (const [key, value] of Object.entries(context.env)) {
    if (
      /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL|COOKIE|AUTH/i.test(key)
      && value
      && value.length >= 8
      && !/^(true|false|yes|no|on|off|\d+)$/i.test(value)
    ) {
      secrets.add(value);
    }
  }
  return [...secrets];
}

/** Runs an executing registry fragment, or returns null for a legacy fragment. */
export async function dispatchCommand(
  argv: string[],
  commands: CommandDefinition[] = discoverCommands(),
  context: CommandContext = createCommandContext(),
): Promise<number | null> {
  const match = resolveCommand(stripConfigArgs(argv).slice(2), commands);
  return match?.command.execute
    ? runExecutingCommand(match, context)
    : null;
}

export function exitCodeForError(err: unknown): number {
  if (err instanceof MigratePathError) return 2;
  return typeof err === 'object' && err !== null && (err as { exitCode?: unknown }).exitCode === 3 ? 3 : 1;
}

function readOnlyLifecycleOperation(operation: LifecycleOperation): boolean {
  return operation.endsWith(':dry-run');
}

function lifecycleAdmissionCode(dbPath: string, operation: LifecycleOperation): string | null {
  if (readOnlyLifecycleOperation(operation)) {
    // A missing store has the same pre-cutover lifecycle state that openStore()
    // would have created for a dry run, but creating it would violate dry-run.
    if (!existsSync(dbPath)) return null;
    const db = openStoreConnection(dbPath, true);
    try {
      // Do not let an admission check upgrade or repair an old store just to
      // discover its lifecycle state.
      const schemaRefusal = readOnlySchemaRefusal(db);
      if (schemaRefusal) return schemaRefusal;
      const result = assertAdmittedInConnection(db, operation);
      return result.ok ? null : result.code ?? 'lifecycle-refused';
    } finally { db.close(); }
  }

  const store = openStore(dbPath);
  try {
    const result = assertAdmitted(store, operation);
    return result.ok ? null : result.code ?? 'lifecycle-refused';
  } finally { store.close(); }
}

// The legacy gate path must select its lifecycle store before opening it, or
// --db would both admit against and create the wrong database.
export function gateLifecycleAdmissionCode(gateDbPath: string | undefined, defaultDbPath: string): string | null {
  return lifecycleAdmissionCode(gateDbPath ?? defaultDbPath, 'gate');
}

function lifecycleOperationFor(command: string, args: string[]): LifecycleOperation | null {
  if (command === 'doctor') return 'doctor';
  if (command === 'status') return 'status';
  if (command === 'report cutover') return 'report-cutover';
  if (command === 'gate') return 'gate';
  if (command === 'cutover') {
    if (args[0] === 'begin') return args.includes('--dry-run') ? 'cutover-begin:dry-run' : 'cutover-begin';
    if (args[0] === 'commit') return 'cutover-commit';
    if (args[0] === 'abort') return 'cutover-abort';
  }
  if (command === 'undo cswap') {
    if (args.includes('--record-drill')) return 'undo-cswap:dry-run-record';
    if (args.includes('--dry-run')) return 'undo-cswap:dry-run';
    return args.includes('--resume') ? 'undo-cswap:resume' : 'undo-cswap';
  }
  if (command === 'lifecycle') {
    if (args[0] === 'sentinels' && args[1] === 'record') return 'lifecycle-sentinels-record';
    if (args[0] === 'drill-done') return 'lifecycle-drill-done';
    if (args[0] === 'close') return 'lifecycle-close';
    if (args[0] === 'status') return 'status';
  }
  return null;
}

const INVALID_EXECUTING_COMMAND_EXIT_CODE = 1;

function isValidExecutingCommandExitCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}

/**
 * Runs an executing registry fragment behind the redacting output/error boundary.
 * Fragments must return an integer exit code in [0, 255]; invalid values return 1.
 */
export async function runExecutingCommand(
  match: { command: CommandDefinition; args: string[] },
  context: CommandContext,
): Promise<number> {
  let redactingContext: CommandContext;
  const redactOutput = (message: string): string => redactSecrets(message, knownCommandSecrets(redactingContext));
  redactingContext = {
    ...context,
    stdout: (message) => context.stdout(redactOutput(message)),
    stderr: (message) => context.stderr(redactOutput(message)),
    deliverSecret: (value) => {
      context.registerSecret(value);
      context.stdout(value);
    },
  };
  try {
    // Fault-injection capability errors are usage errors, before lifecycle
    // admission can create or migrate a store.
    if (match.command.name === 'undo cswap' && match.args.includes('--record-drill') && context.env.QLB_FAULT_INJECTION !== '1') {
      return match.command.execute!(match.args, redactingContext);
    }
    const operation = lifecycleOperationFor(match.command.name, match.args);
    if (operation != null) {
      const refusal = lifecycleAdmissionCode(context.config.dbPath, operation);
      if (refusal != null) {
        const guidance = operation === 'lifecycle-close' && refusal === RETIREMENT_IN_PROGRESS
          ? `; ${FINISH_RETIREMENT_FIRST}`
          : operation === 'lifecycle-close' && refusal === CSWAP_RESTORE_PENDING
            ? `; ${FINISH_CSWAP_RESTORE_FIRST}`
            : refusal === 'undo-in-progress'
              ? '; run qlb undo cswap --resume'
              : '';
        redactingContext.stderr(`qlb ${match.command.name}: refused: ${refusal}${guidance}`);
        return 3;
      }
    }
    const code = await match.command.execute!(match.args, redactingContext);
    if (!isValidExecutingCommandExitCode(code)) {
      redactingContext.stderr(`qlb ${match.command.name}: invalid exit code (expected integer 0-255)`);
      return INVALID_EXECUTING_COMMAND_EXIT_CODE;
    }
    return code;
  } catch (err) {
    redactingContext.stderr(`qlb ${match.command.name}: ${redactError(err, knownCommandSecrets(redactingContext))}`);
    return exitCodeForError(err);
  }
}

function isExactListRequest(args: string[], flag: string): boolean {
  return args.length === 2 && args.includes(flag) && args.includes('--json');
}

export async function main(): Promise<void> {
  assertTestHomeIsIsolated();
  const commands = discoverCommands();
  const stripped = stripConfigArgs(process.argv);
  const raw = stripped.slice(2);
  if (isExactListRequest(raw, '--list-commands')) {
    console.log(JSON.stringify(listCommandNames(commands)));
    return;
  }
  if (raw[0] === 'doctor' && isExactListRequest(raw.slice(1), '--list-checks')) {
    console.log(JSON.stringify(listCheckNames()));
    return;
  }
  const command = resolveCommand(raw, commands);
  if (command?.command.execute) {
    const context = createCommandContext();
    process.exit(await runExecutingCommand(command, context));
  }
  let opts: Opts;
  try {
    opts = parseArgs(prepareCommandArgv(process.argv, commands));
  } catch (err) {
    if (raw[0] === 'migrate') {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb migrate ${raw[1] ?? ''}: ${msg}`);
      process.exit(exitCodeForError(err));
    }
    throw err;
  }
  if (opts.cmd === 'init') {
    const report = initializeQlb(config);
    printInit(report, opts.json);
    process.exit(0);
  }
  if (opts.cmd === 'doctor') {
    const report = await doctorQlb(config, { live: opts.live, appendHealthLog: true });
    if (report.healthLogError) console.error(`qlb doctor: warning: health log was not appended: ${report.healthLogError}`);
    printDoctor(report, opts.json);
    process.exit(report.overall === 'FAIL' ? 1 : 0);
  }
  if (opts.cmd === 'refresh') {
    try {
      const refreshAdapters = opts.provider === 'openai-codex'
        ? [createCodexAdapter({ probeUsage: probeCodexUsage, getStore })]
        : filterRefreshAdapters(adapters, opts.provider);
      if (opts.allowProbe) {
        const store = getStore();
        const report = await runRefresh(refreshAdapters, { allowProbe: true });
        for (const result of report.results) {
          const adapter = refreshAdapters.find((a) => a.id === result.provider);
          const input = {
            provider: result.provider,
            persistsSnapshots: adapter?.persistsSnapshots,
          };
          const allFailed =
            result.status === 'error' ||
            (result.accountsFailed > 0 && result.accountsOk === 0);
          if (allFailed) {
            recordObservation(store, input, [], 'refresh', {
              outcome: 'failed',
              error:
                result.error ??
                (result.errors.length > 0
                  ? result.errors.map((e) => e.error).join('; ')
                  : 'probe failed'),
            });
            continue;
          }
          const snaps = result.snapshots.map((snapshot) => {
            const listed = result.errors.find((e) => e.accountId === snapshot.accountId);
            const caf = snapshot.probe?.outcome === 'cached-after-failure';
            if (!snapshot.error && !caf && !listed) return snapshot;
            return {
              ...snapshot,
              failed: true,
              error:
                snapshot.error ??
                listed?.error ??
                (caf
                  ? `probe failed: ${snapshot.probe?.detail ?? 'unknown error'}; cached reading retained`
                  : 'probe failed'),
            };
          });
          recordObservation(store, input, snaps, 'refresh');
        }
        console.log(opts.json ? JSON.stringify(report, null, 2) : formatRefresh(report));
        process.exit(0);
      }
      process.exit(await refreshCommand(refreshAdapters, { allowProbe: false, json: opts.json }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb refresh: ${msg}`);
      process.exit(exitCodeForError(err));
    }
  }
  if (opts.cmd === 'setup' && opts.harness === 'hermes') {
    try {
      const result = setupHermes();
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const f of result.files) console.log(`${f.action.padEnd(9)} ${f.path}`);
        for (const a of [result.launchd, result.watch]) {
          if (a) console.log(`launchd   ${a.label}: ${a.action}${a.detail ? ` (${a.detail})` : ''}`);
        }
        if (result.models) for (const line of result.models.split('\n')) console.log(`models    ${line}`);
        console.log('');
        console.log(result.instructions);
      }
      process.exit(0);
    } catch (err) {
      console.error(`qlb setup hermes: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  if (opts.cmd === 'setup') {
    const result = setupHarness(opts.harness as SetupHarness);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.instructions);
      if (result.snippetWritten) {
        console.log(`\nWrote ${result.snippetWritten}`);
      }
    }
    process.exit(0);
  }
  if (opts.cmd === 'status') {
    process.exit(await runStatus(opts));
  }
  if (opts.cmd === 'audit') {
    try {
      const code = await runAudit(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb audit: ${msg}`);
      process.exit(1);
    }
  }
  if (opts.cmd === 'migrate') {
    try {
      const code = await runMigrate(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb migrate ${opts.sub}: ${msg}`);
      process.exit(exitCodeForError(err));
    }
  }
  if (opts.cmd === 'policy') {
    try {
      const code = await runPolicy(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb policy ${opts.sub}: ${msg}`);
      process.exit(1);
    }
  }
  if (opts.cmd === 'codex-probe-claims') {
    process.exit(await runCodexProbeClaims(opts.args));
  }
  if (opts.cmd === 'gate') {
    const refusal = gateLifecycleAdmissionCode(opts.db, config.dbPath);
    if (refusal != null) {
      console.error(`qlb gate: refused: ${refusal}`);
      process.exit(3);
    }
    try {
      const code = await runGate(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb gate ${opts.target}: ${msg}`);
      process.exit(1);
    }
  }
  if (opts.cmd === 'proxy') {
    try {
      const code = await runProxy(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb proxy: ${msg}`);
      process.exit(1);
    }
  }
  if (opts.cmd === 'consume') {
    try {
      const code = await runConsume(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb consume ${opts.sub}: ${msg}`);
      process.exit(1);
    }
  }
  if (opts.cmd === 'retire') {
    try {
      const code = await runRetire(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb retire ${opts.sub}: ${msg}`);
      process.exit(1);
    }
  }
  if (opts.cmd === 'accounts') {
    try {
      const code = await runAccounts(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof PruneRefusedError) {
        console.error(`qlb accounts ${opts.sub}: ${msg}`);
        process.exit(2);
      }
      const rec = err && typeof err === 'object' ? (err as { code?: unknown; errcode?: unknown }) : {};
      const bits: string[] = [];
      if (rec.code != null) bits.push(`code=${String(rec.code)}`);
      if (rec.errcode != null) bits.push(`errcode=${String(rec.errcode)}`);
      const extra = bits.length > 0 ? ` [${bits.join(' ')}]` : '';
      console.error(`qlb accounts ${opts.sub}: ${msg}${extra}`);
      process.exit(exitCodeForError(err));
    }
  }
  if (opts.cmd === 'native-resync') {
    try {
      const code = await runNativeResync(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb native-resync: ${msg}`);
      process.exit(exitCodeForError(err));
    }
  }
  if (opts.cmd === 'override') {
    try {
      const code = await runOverride(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb override: ${msg}`);
      process.exit(1);
    }
  }
  if (opts.cmd === 'why') {
    try {
      process.exit(await runWhy(opts));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb why: ${msg}`);
      process.exit(1);
    }
  }
  const code = await runResolve(opts);
  process.exit(code);
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`qlb: ${message}`);
    process.exitCode = 2;
  });
}
