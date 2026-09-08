#!/usr/bin/env node
import { adapters } from './adapters';
import { macosKeychain } from './keychain';
import {
  DEFAULT_OWNER_FILE,
  DEFAULT_POOL_FILE,
  Migration,
  defaultRehearseFn,
  isRealPiAgentPath,
} from './migration';
import { resolveFromSnapshots, providerForModel } from './resolve';
import { getStore, openStore, type Store } from './store';
import type { AccountSnapshot, Adapter } from './types';

const USAGE = `Usage:
  qlb status [--json]
  qlb resolve --model <modelId> [--fallback m1,m2,...] [--session <id>] [--harness pi|claude-code|codex|dispatch] [--effort <lvl>] [--json]
  qlb migrate stage    --pool-file <path> --owner-file <path> [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate rehearse --pool-file <path> --owner-file <path> [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate commit   --pool-file <path> --owner-file <path> [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate rollback --pool-file <path> --owner-file <path> [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate resume   --pool-file <path> --owner-file <path> [--db <path>] [--target-dir <path>] [--confirm-real-cutover]
  qlb migrate status   [--pool-file <path>] [--owner-file <path>] [--db <path>] [--target-dir <path>] [--json]

SAFETY: running migrate stage/rehearse/commit/rollback/resume without path
overrides targets the REAL ~/.pi/agent/anthropic-pool.json and
~/.pi/agent/qlb-owner.json. That is a REAL cutover and is refused unless
--confirm-real-cutover is also passed. Tests and dry runs MUST pass
--pool-file / --owner-file (or --target-dir) pointing at a temp copy.
Do NOT pass --confirm-real-cutover unless you intend to cut over live Pi.`;

type StatusOpts = { cmd: 'status'; json: boolean };
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
  poolFile: string;
  ownerFile: string;
  db?: string;
  confirmRealCutover: boolean;
};
type Opts = StatusOpts | ResolveOpts | MigrateOpts;

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
  let targetDir: string | undefined;
  let db: string | undefined;
  let confirmRealCutover = false;

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

  if (targetDir) {
    if (!ownerFile) ownerFile = `${targetDir.replace(/\/$/, '')}/qlb-owner.json`;
    if (!poolFile) poolFile = `${targetDir.replace(/\/$/, '')}/anthropic-pool.json`;
  }

  return {
    cmd: 'migrate',
    sub: subRaw,
    json,
    poolFile: poolFile ?? DEFAULT_POOL_FILE,
    ownerFile: ownerFile ?? DEFAULT_OWNER_FILE,
    db,
    confirmRealCutover,
  };
}

function parseArgs(argv: string[]): Opts {
  const raw = argv.slice(2);
  if (raw[0] === '-h' || raw[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  if (raw[0] === 'migrate') {
    return parseMigrateArgs(raw.slice(1));
  }

  let cmd: 'status' | 'resolve' = 'status';
  const args = [...raw];
  if (args[0] === 'status' || args[0] === 'resolve') {
    cmd = args.shift() as 'status' | 'resolve';
  }

  let json = false;
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
  return { cmd: 'status', json };
}

function assertSafeMigratePaths(opts: MigrateOpts): void {
  if (opts.sub === 'status') return;
  const real =
    isRealPiAgentPath(opts.poolFile) || isRealPiAgentPath(opts.ownerFile);
  if (real && !opts.confirmRealCutover) {
    console.error(
      'REFUSED: resolved --pool-file / --owner-file is inside ~/.pi/agent/.\n' +
        'This would perform a REAL Pi credential cutover.\n' +
        'Pass --pool-file and --owner-file pointing at a temp copy, or pass\n' +
        '--confirm-real-cutover if you truly intend to cut over live Pi.',
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

function formatRelative(resetAt?: number): string {
  if (resetAt == null || !Number.isFinite(resetAt)) return '-';
  const deltaMs = resetAt - Date.now();
  const absMs = Math.abs(deltaMs);
  const totalMins = Math.round(absMs / 60_000);
  let rel: string;
  if (totalMins < 1) {
    rel = '<1m';
  } else if (totalMins < 60) {
    rel = `${totalMins}m`;
  } else {
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    rel = mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
  }
  return deltaMs >= 0 ? `in ${rel}` : `${rel} ago`;
}

function formatUsedPct(usedPct: number | null): string {
  return usedPct == null ? '—' : `${usedPct}%`;
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

async function runStatus(json: boolean): Promise<void> {
  const nested = await Promise.all(adapters.map((adapter) => safeFetch(adapter)));
  const accounts = nested.flat();
  if (json) {
    console.log(JSON.stringify({ fetchedAt: Date.now(), accounts }, null, 2));
  } else {
    printTable(accounts);
  }
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
    const mig = new Migration(store, macosKeychain, opts.poolFile, opts.ownerFile);
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (opts.cmd === 'status') {
    await runStatus(opts.json);
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
  const code = await runResolve(opts);
  process.exit(code);
}

void main();
