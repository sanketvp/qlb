import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { credentialFingerprint } from '../anthropic-oauth';
import { runRetirementDrain, unavailableCswapAgent, type CswapAgent } from '../cswap-agent';
import { retireCswap, type CswapRetireDependencies, type CswapRetireResult } from '../cswap-retire';
import { doctorQlb, type DoctorReport } from '../diagnostics';
import { qlbHomeDir } from '../home';
import { withUndoCapability } from '../keychain-allowlist';
import { listUnclaimedKeychainServices, platformKeychain } from '../keychain';
import { isCredentialNotFound } from '../credential-backends';
import { defaultPiMigratePaths } from '../pi-migrate';
import { openStore, openStoreConnection, type Store } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

export interface RetireCswapCommandDependencies {
  /** Tests inject the entire retirement transaction and all destructive effects. */
  retire?: (store: Store, context: CommandContext) => Promise<CswapRetireResult>;
  /** The production S57 implementation is injected until its platform adapter exists. */
  cswapAgent?: CswapAgent;
}

function parse(args: string[]): { json: boolean } | null {
  if (args.length === 0) return { json: false };
  return args.length === 1 && args[0] === '--json' ? { json: true } : null;
}

function fingerprint(value: string): string {
  const result = credentialFingerprint(value);
  if (!result) throw new Error('credential fingerprint is unavailable');
  return result;
}

function cswapAccounts(sequencePath: string): string[] {
  const parsed = JSON.parse(readFileSync(sequencePath, 'utf8')) as { sequence?: unknown; accounts?: unknown };
  if (!Array.isArray(parsed.sequence) || !parsed.accounts || typeof parsed.accounts !== 'object') throw new Error('C-swap account registry is unreadable');
  const accounts = parsed.accounts as Record<string, unknown>;
  return parsed.sequence.map((number) => {
    const entry = accounts[String(number)];
    if ((typeof number !== 'number' && typeof number !== 'string') || !entry || typeof entry !== 'object' || typeof (entry as { email?: unknown }).email !== 'string' || !(entry as { email: string }).email) {
      throw new Error('C-swap account registry is unreadable');
    }
    return `account-${number}-${(entry as { email: string }).email}`;
  });
}

/** S64 maps the complete production report, not its already-WARN aggregate. */
export function s64DoctorVerdict(report: DoctorReport): { overall: 'PASS' | 'FAIL'; autoAgent: 'PASS' | 'FAIL' } {
  const blockingCheck = report.checks.some((check) => check.level === 'FAIL'
    || (check.level === 'WARN' && check.name !== 'lifecycle:window'));
  const blockingProvider = report.providers.some((provider) => provider.level === 'FAIL' || provider.level === 'WARN');
  const autoAgent = report.checks.find((check) => check.name === 'auto:agent')?.level === 'PASS' ? 'PASS' : 'FAIL';
  return { overall: blockingCheck || blockingProvider ? 'FAIL' : 'PASS', autoAgent };
}

/** Exported for adapter tests; callers must not invoke effects in test mode. */
export function productionDependencies(
  store: Store,
  ctx: CommandContext,
  agent: CswapAgent = unavailableCswapAgent,
  enumerateUnclaimed: () => string[] = listUnclaimedKeychainServices,
): CswapRetireDependencies {
  const sequencePath = ctx.config.cswapSequencePath;
  const cswapBackup = dirname(sequencePath);
  const stateDir = join(qlbHomeDir(ctx.env), '.qlb');
  const cswapItems = () => cswapAccounts(sequencePath).flatMap((account) => {
    try {
      return [{ id: account, fingerprint: fingerprint(platformKeychain.getSync('claude-swap', account)) }];
    } catch (error) {
      // A previously completed delete can be replayed before its checkpoint.
      if (isCredentialNotFound(error)) return [];
      throw error;
    }
  });
  const archive = (source: string, target: string, optional = false): void => {
    if (!existsSync(source)) {
      if (optional) return;
      throw new Error('retirement archive source is unavailable');
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // A final-name archive is trusted only when its journal phase was durable.
    // This effect is called only for an unticked phase, so rebuild any remnant.
    rmSync(target, { force: true });
    const temporary = `${target}.${process.pid}.tmp`;
    rmSync(temporary, { force: true });
    try {
      execFileSync('tar', ['-czf', temporary, '-C', dirname(source), basename(source)], { stdio: 'ignore' });
      const listing = String(execFileSync('tar', ['-tzf', temporary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      const expected = basename(source);
      if (!listing.split(/\r?\n/).some((entry) => entry === expected || entry.startsWith(`${expected}/`))) {
        throw new Error('retirement archive verification failed');
      }
      chmodSync(temporary, 0o600);
      renameSync(temporary, target);
      chmodSync(target, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  const hasUnadoptedStash = (): boolean => {
    const stash = join(stateDir, 'unclaimed');
    let fileStash: boolean;
    try { fileStash = readdirSync(stash).some((entry) => entry.endsWith('.json')); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fileStash = false;
      else throw error;
    }
    // This enumerates only attributes, never credential values. Failure is
    // intentionally propagated so retireCswap maps it to a closed gate.
    return fileStash || enumerateUnclaimed().length > 0;
  };
  return {
    now: Date.now,
    stateDir,
    backupsDir: join(stateDir, 'backups'),
    journalDir: join(stateDir, 'journal'),
    doctor: async () => s64DoctorVerdict(await doctorQlb(ctx.config)),
    reportReceiptPasses: () => store.getConfig('report.receiptAt') != null,
    hasFourInjectedDrillRows: () => {
      const db = openStoreConnection(store.dbPath, true);
      try {
        const row = db.prepare("SELECT count(*) AS count FROM switch_log WHERE injected = 1 AND outcome = 'ok'").get() as { count: number };
        return row.count >= 4;
      } finally { db.close(); }
    },
    hasUnadoptedStash,
    claudeSlotsPass: () => {
      const db = openStoreConnection(store.dbPath, true);
      try { return !db.prepare('SELECT 1 FROM claude_slots WHERE archived_at IS NULL AND dead = 1 LIMIT 1').get(); } finally { db.close(); }
    },
    slots: () => {
      const db = openStoreConnection(store.dbPath, true);
      try {
        return db.prepare(`SELECT s.account_id AS accountId, s.source AS source, s.fingerprint AS currentFingerprint,
          (SELECT to_fp FROM lineage_log l WHERE l.provider = 'anthropic' AND l.account_id = s.account_id AND l.cause = 'import' ORDER BY l.id ASC LIMIT 1) AS sourceFingerprint
          FROM claude_slots s WHERE s.archived_at IS NULL ORDER BY s.account_id`).all() as Array<{ accountId: string; source: string | null; sourceFingerprint: string | null; currentFingerprint: string | null }>;
      } finally { db.close(); }
    },
    cswapItems,
    readSlotFingerprint: (accountId) => fingerprint(platformKeychain.getSync(`qlb:anthropic:${accountId}`, 'qlb')),
    effects: {
      drainCswap: () => runRetirementDrain(agent),
      archiveCswap: (archivePath) => archive(cswapBackup, archivePath),
      deleteCswapItems: (items) => withUndoCapability(() => {
        for (const item of items) {
          try {
            const current = fingerprint(platformKeychain.getSync('claude-swap', item.id));
            if (current !== item.fingerprint) throw new Error('captured C-swap item fingerprint changed');
            platformKeychain.deleteSync('claude-swap', item.id);
          } catch (error) {
            if (!isCredentialNotFound(error)) throw error;
          }
        }
      }),
      uninstallCswap: () => {
        try { execFileSync('uv', ['tool', 'uninstall', 'claude-swap'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) {
          const detail = `${String((error as { stdout?: unknown }).stdout ?? '')}\n${String((error as { stderr?: unknown }).stderr ?? '')}\n${String(error)}`;
          if (!/is not installed/i.test(detail)) throw error;
        }
      },
      removeCswapLaunchArtifacts: () => {
        rmSync(join(ctx.home, 'Library', 'LaunchAgents', 'com.claude-swap.auto.plist'), { force: true });
        rmSync(join(ctx.home, '.local', 'bin', 'cswap'), { force: true });
      },
      deletePiBaselines: () => rmSync(defaultPiMigratePaths(qlbHomeDir(ctx.env), ctx.config.piAuthJsonPath).baselineDir, { recursive: true, force: true }),
      archiveExpiredStash: (archivePath) => archive(join(stateDir, 'unclaimed'), `${archivePath}.stash.tar.gz`, true),
    },
  };
}

export async function runRetireCswapCommand(
  args: string[],
  ctx: CommandContext,
  dependencies: RetireCswapCommandDependencies = {},
): Promise<number> {
  const options = parse(args);
  if (!options) {
    ctx.stderr('usage: qlb retire cswap [--json]');
    return 2;
  }

  const store = openStore(ctx.config.dbPath);
  try {
    // Test-mode has no native capability. Tests inject `retire`; production is
    // fully wired and can only run outside that explicit safety mode.
    const result = dependencies.retire
      ? await dependencies.retire(store, ctx)
      : ctx.env.QLB_TEST_MODE === '1'
        ? { ok: false as const, code: 'native-retirement-disabled-in-test-mode' }
        : await retireCswap(store, productionDependencies(store, ctx, dependencies.cswapAgent));
    if (options.json) ctx.stdout(JSON.stringify(result));
    else ctx.stderr(result.ok ? `C-swap retired; archive: ${result.archivePath}` : `qlb retire cswap: refused: ${result.code}`);
    return result.ok ? 0 : 3;
  } finally {
    store.close();
  }
}

const command: CommandDefinition = { name: 'retire cswap', execute: runRetireCswapCommand };
export default command;
