#!/usr/bin/env node
import { join } from 'node:path';
import { adapters } from './adapters';
import { createDefaultCodexGateDeps, runCodexGate } from './codex-gate';
import { config, stripConfigArgs } from './config';
import { doctorQlb, initializeQlb, type DoctorReport, type InitReport } from './diagnostics';
import { platformKeychain } from './keychain';
import { createOwnedCredentialSource } from './credentials';
import {
  DEFAULT_AUTH_JSON,
  DEFAULT_POOL_FILE,
  Migration,
  createSingleGrantMigration,
  createStaticKeyMigration,
  defaultOwnerFileFor,
  defaultRehearseFn,
  isMigrateProvider,
  isRealPiAgentPath,
  isSingleGrantProvider,
  isStaticKeyProvider,
  readOpenRouterNativeKey,
  type MigrateProvider,
} from './migration';
import { listPolicies, setPolicy } from './policy';
import { LoopbackProxy } from './proxy';
import { resolveFromSnapshots, providerForModel } from './resolve';
import {
  checkRetirementEligibility,
  defaultNativePathForHarness,
  defaultPingFn,
  isRetireHarness,
  retireNativeStore,
  type RetireHarness,
} from './retire';
import {
  enrichAccounts,
  formatDashboard,
  formatRelative,
  formatUsedPct,
  makeOwnershipReader,
  overrideFromStore,
} from './dashboard';
import { isSetupHarness, setupHarness, type SetupHarness } from './setup';
import { getStore, openStore, type Store } from './store';
import type { AccountSnapshot, Adapter } from './types';

const USAGE = `Usage:
  qlb init [--json]
  qlb doctor [--json] [--live]
  qlb status [--json] [--dashboard|--flat]
  qlb setup pi|claude-code|codex-cli|generic [--json]
  qlb resolve --model <modelId> [--fallback m1,m2,...] [--session <id>] [--harness pi|claude-code|codex|dispatch] [--effort <lvl>] [--json]
  qlb policy set --harness <h> --virtual-model <name> --real-model <id> --effort <lvl> [--fallback m1,m2] [--session-mode header|anon] [--db <path>] [--json]
  qlb policy list [--harness <h>] [--db <path>] [--json]
  qlb gate codex [--json] [--db <path>]
  qlb proxy [--info-path <path>] [--idle-ms <n>] [--db <path>]
  qlb migrate stage    [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] --pool-file <path> --owner-file <path> [--auth-json <path>] [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate rehearse [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] --pool-file <path> --owner-file <path> [--auth-json <path>] [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate commit   [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] --pool-file <path> --owner-file <path> [--auth-json <path>] [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate rollback [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] --pool-file <path> --owner-file <path> [--auth-json <path>] [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate resume   [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] --pool-file <path> --owner-file <path> [--auth-json <path>] [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate status   [--provider anthropic|xai|kimi-coding|openai-codex|openrouter] [--pool-file <path>] [--owner-file <path>] [--auth-json <path>] [--db <path>] [--target-dir <path>] [--json]
  qlb retire status  --harness claude-code|codex-cli [--json] [--db <path>]
  qlb retire execute --harness claude-code|codex-cli --confirm-real-retirement [--db <path>]

SAFETY: running migrate stage/rehearse/commit/rollback/resume without path
overrides targets the REAL ~/.pi/agent/ files (anthropic-pool.json for
--provider anthropic, auth.json for xai|kimi-coding|openai-codex, plus the
matching qlb-owner*.json). That is a REAL cutover and is refused unless
--confirm-real-cutover is also passed. Tests and dry runs MUST pass
--pool-file / --auth-json / --owner-file (or --target-dir) pointing at a
temp copy. Do NOT pass --confirm-real-cutover unless you intend to cut over
live Pi. Default --provider is anthropic (backward compatible).
Single-grant providers (xai, kimi-coding, openai-codex) shadow-retain the
native auth.json entry — QLB never deletes or renames that shared file.
OpenRouter is a static API key in Keychain service pi-openrouter (read-only;
QLB never writes that service). Ownership is qlb-owner-openrouter.json +
journal pi-openrouter; the QLB copy lives at qlb:openrouter:openrouter-default.
qlb gate codex makes a handful of real Codex backend requests (read-only
use of ~/.codex/auth.json). Automated tests never take this path.
qlb retire status is read-only. qlb retire execute is refused unless
--confirm-real-retirement is passed AND eligibility gates pass (QLB_OWNED,
7-day soak, 20 clean decisions, live ping). Do NOT run retire execute until
those production soak criteria are actually met.
Default qlb status human view is the dashboard (grouped by account with
health glyph, ownership, overrides). Pass --flat for the original bucket
table. --json keeps {fetchedAt, accounts} and adds ownership, override,
health, healthGlyph on each account (additive; existing fields unchanged).
qlb setup prints copy-paste snippets only and never edits files outside
this repo (setup pi writes scripts/hooks/pi-advisory.sh here). No override
CLI is wired yet — status shows override=none unless a row already exists
in the overrides table.`;

type StatusOpts = { cmd: 'status'; json: boolean; view: 'dashboard' | 'flat' };
type SetupOpts = { cmd: 'setup'; json: boolean; harness: SetupHarness };
type InitOpts = { cmd: 'init'; json: boolean };
type DoctorOpts = { cmd: 'doctor'; json: boolean; live: boolean };
type ResolveOpts = {
  cmd: 'resolve';
  json: boolean;
  model: string;
  fallback: string[];
  session?: string;
  harness?: string;
  effort?: string;
};
type MigrateSub = 'stage' | 'rehearse' | 'commit' | 'rollback' | 'resume' | 'status';
type MigrateOpts = {
  cmd: 'migrate';
  sub: MigrateSub;
  json: boolean;
  provider: MigrateProvider;
  poolFile: string;
  ownerFile: string;
  authJson: string;
  db?: string;
  confirmRealCutover: boolean;
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
type Opts = InitOpts | DoctorOpts | StatusOpts | SetupOpts | ResolveOpts | MigrateOpts | PolicyOpts | GateOpts | ProxyOpts | RetireOpts;

const MIGRATE_SUBS: readonly MigrateSub[] = [
  'stage',
  'rehearse',
  'commit',
  'rollback',
  'resume',
  'status',
];

function isMigrateSub(s: string | undefined): s is MigrateSub {
  return !!s && (MIGRATE_SUBS as readonly string[]).includes(s);
}

function parseMigrateArgs(args: string[]): MigrateOpts {
  const subRaw = args[0];
  if (subRaw === '-h' || subRaw === '--help' || subRaw === undefined) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!isMigrateSub(subRaw)) {
    console.error('qlb migrate: unknown subcommand. Expected stage|rehearse|commit|rollback|resume|status');
    console.error(USAGE);
    process.exit(1);
  }
  const rest = args.slice(1);
  let json = false;
  let poolFile: string | undefined;
  let ownerFile: string | undefined;
  let authJson: string | undefined;
  let targetDir: string | undefined;
  let db: string | undefined;
  let confirmRealCutover = false;
  let providerRaw: string | undefined;

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
      poolFile = rest[++i];
      continue;
    }
    if (arg === '--owner-file') {
      ownerFile = rest[++i];
      continue;
    }
    if (arg === '--auth-json') {
      authJson = rest[++i];
      continue;
    }
    if (arg === '--provider') {
      providerRaw = rest[++i];
      continue;
    }
    if (arg === '--target-dir') {
      targetDir = rest[++i];
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

  if (targetDir) {
    const dir = targetDir.replace(/[/\\]+$/, '');
    if (!ownerFile) {
      ownerFile =
        provider === 'anthropic'
          ? join(dir, 'qlb-owner.json')
          : join(dir, `qlb-owner-${provider}.json`);
    }
    if (!poolFile) poolFile = join(dir, 'anthropic-pool.json');
    if (!authJson) authJson = join(dir, 'auth.json');
  }

  return {
    cmd: 'migrate',
    sub: subRaw,
    json,
    provider,
    poolFile: poolFile ?? DEFAULT_POOL_FILE,
    ownerFile: ownerFile ?? defaultOwnerFileFor(provider),
    authJson: authJson ?? DEFAULT_AUTH_JSON,
    db,
    confirmRealCutover,
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
  const target = args.shift();
  if (target === '-h' || target === '--help' || target === undefined) {
    console.log(USAGE);
    process.exit(0);
  }
  if (target !== 'codex') {
    console.error('qlb gate: unknown target. Expected: qlb gate codex');
    console.error(USAGE);
    process.exit(1);
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
  if (args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const db = takeFlag(args, '--db');
  const infoPath = takeFlag(args, '--info-path');
  const idleRaw = takeFlag(args, '--idle-ms');
  if (args.length > 0) {
    console.error(`qlb proxy: unknown argument ${args[0]}`);
    process.exit(1);
  }
  const idleMs = idleRaw != null ? Number(idleRaw) : undefined;
  if (idleRaw != null && (!Number.isFinite(idleMs) || (idleMs ?? 0) <= 0)) {
    console.error('qlb proxy: --idle-ms must be a positive number');
    process.exit(1);
  }
  return { cmd: 'proxy', json, db, infoPath, idleMs };
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
      'REFUSED: qlb retire execute requires --confirm-real-retirement.\n' +
        'This would retire a native Claude Code / Codex CLI credential store.\n' +
        'Run `qlb retire status --harness <h>` (read-only) first.',
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
  if (!isSetupHarness(harness)) {
    console.error(
      'qlb setup: harness is required (pi|claude-code|codex-cli|generic)',
    );
    console.error(USAGE);
    process.exit(1);
  }
  return { cmd: 'setup', json, harness };
}

function parseArgs(argv: string[]): Opts {
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
  if (raw[0] === 'migrate') {
    return parseMigrateArgs(raw.slice(1));
  }
  if (raw[0] === 'policy') {
    return parsePolicyArgs(raw.slice(1));
  }
  if (raw[0] === 'gate') {
    return parseGateArgs(raw.slice(1));
  }
  if (raw[0] === 'proxy') {
    return parseProxyArgs(raw.slice(1));
  }
  if (raw[0] === 'retire') {
    return parseRetireArgs(raw.slice(1));
  }
  if (raw[0] === 'setup') {
    return parseSetupArgs(raw.slice(1));
  }

  let cmd: 'status' | 'resolve' = 'status';
  const args = [...raw];
  if (args[0] === 'status' || args[0] === 'resolve') {
    cmd = args.shift() as 'status' | 'resolve';
  }

  let json = false;
  let view: 'dashboard' | 'flat' = 'dashboard';
  let model: string | undefined;
  let fallback: string[] = [];
  let session: string | undefined;
  let harness: string | undefined;
  let effort: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--dashboard') {
      view = 'dashboard';
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
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    console.error(USAGE);
    process.exit(1);
  }

  if (cmd === 'resolve') {
    if (!model) {
      console.error('qlb resolve: --model is required');
      console.error(USAGE);
      process.exit(1);
    }
    return { cmd, json, model, fallback, session, harness, effort };
  }
  return { cmd: 'status', json, view };
}

function assertSafeMigratePaths(opts: MigrateOpts): void {
  if (opts.sub === 'status') return;
  const nativePath = isStaticKeyProvider(opts.provider)
    ? opts.ownerFile
    : opts.provider === 'anthropic'
      ? opts.poolFile
      : opts.authJson;
  const real =
    isRealPiAgentPath(nativePath) || isRealPiAgentPath(opts.ownerFile);
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

async function safeFetch(adapter: Adapter): Promise<AccountSnapshot[]> {
  try {
    return await adapter.fetchSnapshots();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      {
        accountId: adapter.id,
        provider: adapter.id,
        label: adapter.displayName,
        buckets: {},
        error: message,
      },
    ];
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

interface Row {
  provider: string;
  label: string;
  bucket: string;
  usedPct: string;
  confidence: string;
  reset: string;
}

function toRows(accounts: AccountSnapshot[]): Row[] {
  const rows: Row[] = [];
  for (const snap of accounts) {
    const entries = Object.entries(snap.buckets);
    if (entries.length === 0 && snap.error) {
      rows.push({
        provider: snap.provider,
        label: snap.label,
        bucket: '-',
        usedPct: '-',
        confidence: 'error',
        reset: snap.error,
      });
      continue;
    }
    for (const [bucket, reading] of entries) {
      rows.push({
        provider: snap.provider,
        label: snap.label,
        bucket,
        usedPct: formatUsedPct(reading.usedPct),
        confidence: reading.confidence,
        reset: formatRelative(reading.resetAt),
      });
    }
  }
  return rows;
}

function printTable(accounts: AccountSnapshot[]): void {
  const rows = toRows(accounts);
  const widths = {
    provider: 'provider'.length,
    label: 'account'.length,
    bucket: 'bucket'.length,
    usedPct: 'used'.length,
    confidence: 'confidence'.length,
    reset: 'resets'.length,
  };
  for (const row of rows) {
    widths.provider = Math.max(widths.provider, row.provider.length);
    widths.label = Math.max(widths.label, row.label.length);
    widths.bucket = Math.max(widths.bucket, row.bucket.length);
    widths.usedPct = Math.max(widths.usedPct, row.usedPct.length);
    widths.confidence = Math.max(widths.confidence, row.confidence.length);
    widths.reset = Math.max(widths.reset, `resets ${row.reset}`.length);
  }

  const line = (
    provider: string,
    label: string,
    bucket: string,
    usedPct: string,
    confidence: string,
    reset: string,
  ): string =>
    [
      pad(provider, widths.provider),
      pad(label, widths.label),
      pad(bucket, widths.bucket),
      pad(usedPct, widths.usedPct),
      pad(confidence, widths.confidence),
      pad(reset, widths.reset),
    ].join(' | ');

  console.log(line('provider', 'account', 'bucket', 'used', 'confidence', 'resets'));
  for (const row of rows) {
    console.log(
      line(row.provider, row.label, row.bucket, row.usedPct, row.confidence, `resets ${row.reset}`),
    );
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

async function runStatus(opts: StatusOpts): Promise<void> {
  const nested = await Promise.all(adapters.map((adapter) => safeFetch(adapter)));
  const accounts = nested.flat();
  const store = getStore();
  const enriched = enrichAccounts(accounts, {
    ownershipForProvider: makeOwnershipReader(store),
    overrideForAccount: (id) => overrideFromStore(store, id),
  });
  if (opts.json) {
    console.log(JSON.stringify({ fetchedAt: Date.now(), accounts: enriched }, null, 2));
    return;
  }
  if (opts.view === 'flat') {
    printTable(accounts);
    return;
  }
  console.log(formatDashboard(enriched));
}

async function collectSnapshots(models: string[]): Promise<AccountSnapshot[]> {
  const providers = new Set<Adapter['id']>();
  for (const m of models) {
    const p = providerForModel(m);
    if (p) providers.add(p);
  }
  const snaps: AccountSnapshot[] = [];
  for (const adapter of adapters) {
    if (!providers.has(adapter.id)) continue;
    snaps.push(...(await safeFetch(adapter)));
  }
  return snaps;
}

function printResolveHuman(decision: ReturnType<typeof resolveFromSnapshots>): void {
  if (!decision.ok) {
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
  console.log(`reason:    ${decision.reason}`);
  for (const [bucket, reading] of Object.entries(decision.snapshot.buckets)) {
    console.log(
      `  ${bucket}  ${formatUsedPct(reading.usedPct)}  ${reading.confidence}  resets ${formatRelative(reading.resetAt)}`,
    );
  }
}

function printResolveJson(decision: ReturnType<typeof resolveFromSnapshots>): void {
  if (!decision.ok) {
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
        snapshot: decision.snapshot,
      },
      null,
      2,
    ),
  );
}

async function runResolve(opts: ResolveOpts): Promise<number> {
  if (!providerForModel(opts.model)) {
    console.error(`qlb resolve: unknown model '${opts.model}' (cannot map to a provider)`);
    return 1;
  }
  const models = [opts.model, ...opts.fallback];
  const snapshots = await collectSnapshots(models);
  const decision = resolveFromSnapshots({
    model: opts.model,
    fallback: opts.fallback,
    session: opts.session,
    harness: opts.harness,
    effort: opts.effort,
    snapshots,
    store: getStore(),
  });
  if (opts.json) printResolveJson(decision);
  else printResolveHuman(decision);
  return decision.ok ? 0 : 1;
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
}

async function runMigrate(opts: MigrateOpts): Promise<number> {
  assertSafeMigratePaths(opts);
  let store: Store;
  let opened = false;
  if (opts.db) {
    store = openStore(opts.db);
    opened = true;
  } else {
    store = getStore();
  }
  try {
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
        : new Migration(store, platformKeychain, opts.poolFile, opts.ownerFile);
    let status;
    switch (opts.sub) {
      case 'stage':
        status = mig.stage();
        break;
      case 'rehearse':
        status = await mig.rehearse(defaultRehearseFn);
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

async function runProxy(opts: ProxyOpts): Promise<number> {
  const opened = !!opts.db;
  const store = opts.db ? openStore(opts.db) : getStore();
  const proxy = new LoopbackProxy({
    store,
    infoPath: opts.infoPath,
    idleTimeoutMs: opts.idleMs,
    getCredentialForAccount: createOwnedCredentialSource({
      store,
      keychain: platformKeychain,
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (opts.cmd === 'init') {
    const report = initializeQlb(config);
    printInit(report, opts.json);
    process.exit(0);
  }
  if (opts.cmd === 'doctor') {
    const report = await doctorQlb(config, { live: opts.live });
    printDoctor(report, opts.json);
    process.exit(report.overall === 'FAIL' ? 1 : 0);
  }
  if (opts.cmd === 'setup') {
    const result = setupHarness(opts.harness);
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
    await runStatus(opts);
    process.exit(0);
  }
  if (opts.cmd === 'migrate') {
    try {
      const code = await runMigrate(opts);
      process.exit(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`qlb migrate ${opts.sub}: ${msg}`);
      process.exit(1);
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
  if (opts.cmd === 'gate') {
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
  const code = await runResolve(opts);
  process.exit(code);
}

void main();
