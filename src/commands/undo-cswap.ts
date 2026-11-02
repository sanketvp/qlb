import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CswapUndoDrainError,
  CswapUndoRefusalError,
  CswapUndoVerificationError,
  executeHandBack,
  planHandBack,
  type ExecuteHandBackDependencies,
  type HandBackPlan,
  type PlanHandBackDependencies,
} from '../cswap-undo';
import { claudePaths } from '../cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository, type ClaudeSlotBackend } from '../cc-slots';
import { withClaudeCredentialLocks, withClaudeSwitchLock } from '../cc-locks';
import { liveIdentity } from '../cc-resync';
import { qlbHomeDir } from '../home';
import { withUndoCapability } from '../keychain-allowlist';
import { listUnclaimedKeychainServices, macosKeychainAccountName, platformKeychain } from '../keychain';
import { transition } from '../lifecycle';
import { openStoreConnection, openStore } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

export interface UndoCswapCommandDependencies {
  plan?: (deps: PlanHandBackDependencies) => Promise<HandBackPlan>;
  /** Test seam for all Keychain calls. */
  keychain?: PlanHandBackDependencies['keychain'];
  backupDir?: string;
  /** The sole launchctl seam; tests must inject this and never invoke launchctl. */
  bootoutQlbAgent?: () => { ok: boolean; code?: string } | Promise<{ ok: boolean; code?: string }>;
  /** Test seam for process enumeration; returns other QLB pids only. */
  listQlbPids?: () => number[] | Promise<number[]>;
  /** Test seam for lock observation; returns held QLB lock basenames only. */
  listHeldLocks?: () => string[] | Promise<string[]>;
  pendingStash?: () => string | null | Promise<string | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  deleteEnc?: (path: string) => void | Promise<void>;
  withActiveLocks?: ExecuteHandBackDependencies['withActiveLocks'];
  readActiveCredential?: ExecuteHandBackDependencies['readActiveCredential'];
  resyncActive?: ExecuteHandBackDependencies['resyncActive'];
  readBack?: ExecuteHandBackDependencies['readBack'];
}

type Options = { json: boolean; dryRun: boolean; resume: boolean };

function parse(args: string[]): Options | null {
  const allowed = new Set(['--dry-run', '--resume', '--json']);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length || (args.includes('--dry-run') && args.includes('--resume'))) return null;
  return { json: args.includes('--json'), dryRun: args.includes('--dry-run'), resume: args.includes('--resume') };
}

/** Every callback opens a fresh readonly connection so a post-drain plan cannot reuse stale metadata. */
function readPlanState(dbPath: string): Pick<PlanHandBackDependencies, 'slots' | 'activeAccountId' | 'migratedPiProviders'> {
  return {
    slots: () => {
      const db = openStoreConnection(dbPath, true);
      try {
        return db.prepare(`SELECT account_id AS accountId, slot_num AS slotNum, email, fingerprint, source, dead
          FROM claude_slots WHERE archived_at IS NULL ORDER BY slot_num, account_id`).all() as unknown as ReturnType<PlanHandBackDependencies['slots']>;
      } finally { db.close(); }
    },
    activeAccountId: () => {
      const db = openStoreConnection(dbPath, true);
      try {
        const active = db.prepare("SELECT account_id AS accountId FROM active_login WHERE provider = 'anthropic'").get() as { accountId: string | null } | undefined;
        return active?.accountId ?? null;
      } finally { db.close(); }
    },
    migratedPiProviders: () => {
      const db = openStoreConnection(dbPath, true);
      try {
        const migrated = db.prepare("SELECT key FROM config WHERE key LIKE 'pi.%.state' AND value = 'migrated' ORDER BY key").all() as Array<{ key: string }>;
        return migrated.map(({ key }) => key.slice('pi.'.length, -'.state'.length));
      } finally { db.close(); }
    },
  };
}

function formatHuman(plan: HandBackPlan): string[] {
  const active = plan.activeAccountNumber === null ? 'none' : String(plan.activeAccountNumber);
  return [
    `activeAccountNumber=${active}`,
    ...plan.slots.map((slot) => `slot ${slot.accountNumber}: ${slot.action} claude-swap/${slot.item} fingerprint=${slot.fingerprint}`),
    ...plan.deleteEnc.map((path) => `delete .enc ${path}`),
  ];
}

function defaultBootout(): { ok: boolean; code?: string } {
  try {
    const uid = process.getuid?.() ?? 0;
    execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/com.modus.qlb-auto`], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
    return { ok: true };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code : 'launchctl-failed';
    // bootout is idempotent: an already-unloaded auto agent is stopped.
    if (code === 'ESRCH') return { ok: true };
    return { ok: false, code };
  }
}

function defaultQlbPids(): number[] {
  const output = String(execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
  }));
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    // This command itself is necessarily a qlb process. Only another CLI/agent
    // instance blocks hand-back; process command lines are never retained.
    if (pid !== process.pid && /(?:^|[\\/\s])qlb(?:\s|$)|qlb-auto|dist[\\/]cli\.js\s+auto(?:\s|$)/.test(match[2])) pids.push(pid);
  }
  return pids;
}

function defaultHeldLocks(home: string): string[] {
  const directory = join(home, '.qlb', 'locks');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name === 'auto.lock' || /^consume-.*\.lock$/.test(name) || /^switch-.*\.lock$/.test(name))
    .sort();
}

function defaultPendingStash(home: string): string | null {
  const directory = join(home, '.qlb', 'unclaimed');
  try {
    const file = readdirSync(directory).sort().find((name) => name.endsWith('.json'));
    if (file) return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const service = listUnclaimedKeychainServices().sort()[0];
  return service ?? null;
}

function refusal(ctx: CommandContext, options: Options, error: CswapUndoRefusalError): number {
  if (error.code === 'qlb-add-slot') {
    if (options.json) ctx.stdout(JSON.stringify({ dryRun: options.dryRun, refused: error.code, slots: error.slots }));
    else ctx.stderr(`qlb undo cswap: refused: qlb-add slots ${error.slots.map((slot) => `${slot.accountNumber} (${slot.email || 'no email'})`).join(', ')}`);
    return 3;
  }
  const detail = error.code === 'pi-migrated' ? `migrated Pi provider ${error.provider ?? 'unknown'}` : 'active Claude slot';
  ctx.stderr(`qlb undo cswap: refused: ${detail}`);
  return 3;
}

function drainMessage(error: CswapUndoDrainError): string {
  const pids = error.pids.length > 0 ? `pids ${error.pids.join(',')}` : '';
  const locks = error.locks.length > 0 ? `locks ${error.locks.join(',')}` : '';
  return [pids, locks].filter(Boolean).join('; ') || 'drain did not clear';
}

/** Called only inside the active switch + credential lock hold. */
async function defaultResyncActive(
  dbPath: string,
  home: string,
  keychain: ExecuteHandBackDependencies['keychain'],
  accountId: string,
  credential: string,
): Promise<void> {
  const repository = SqliteClaudeSlotRepository.open(dbPath);
  try {
    const slots = new ClaudeSlots({ backend: keychain as unknown as ClaudeSlotBackend, repository, stashDir: join(home, '.qlb', 'unclaimed') });
    const current = await slots.readSlot(accountId, { fresh: true });
    if (current.credential !== credential) await slots.writeSlot(accountId, credential, { cause: 'resync', by: 'qlb-cli', evidence: 'lineage' });
  } finally { repository.close(); }
}

/** `qlb undo cswap [--dry-run | --resume]`: G16 plan and G17 hand-back. */
export async function runUndoCswapCommand(
  args: string[],
  ctx: CommandContext,
  dependencies: UndoCswapCommandDependencies = {},
): Promise<number> {
  const options = parse(args);
  if (!options) {
    ctx.stderr('usage: qlb undo cswap [--dry-run | --resume] [--json]');
    return 2;
  }

  const home = qlbHomeDir(ctx.env);
  const keychain = dependencies.keychain ?? platformKeychain;
  const state = readPlanState(ctx.config.dbPath);
  const base: PlanHandBackDependencies = {
    ...state,
    backupDir: dependencies.backupDir ?? dirname(ctx.config.cswapSequencePath),
    keychain,
    readSlotCredential: (accountId) => keychain.get(`qlb:anthropic:${accountId}`, 'qlb'),
  };
  try {
    if (options.dryRun) {
      const plan = await (dependencies.plan ?? planHandBack)(base);
      if (options.json) ctx.stdout(JSON.stringify({ ...plan, dryRun: true }));
      else for (const line of formatHuman(plan)) ctx.stdout(line);
      return 0;
    }
    // Never let a test command reach the host LaunchAgent. Test cases that
    // exercise G17 inject the seam (and all Keychain/process effects).
    if (ctx.env.QLB_TEST_MODE === '1' && !dependencies.bootoutQlbAgent) {
      ctx.stderr('qlb undo cswap: unavailable in test mode without injected agent');
      return 1;
    }
    const now = dependencies.now ?? Date.now;
    const result = await executeHandBack({
      ...base,
      keychain: keychain as ExecuteHandBackDependencies['keychain'],
      plan: dependencies.plan ? () => dependencies.plan!(base) : undefined,
      transitionUndoing: () => {
        const store = openStore(ctx.config.dbPath);
        try { return transition(store, 'undoing', now()).ok; } finally { store.close(); }
      },
      bootoutQlbAgent: dependencies.bootoutQlbAgent ?? defaultBootout,
      drainState: async () => ({
        pids: await (dependencies.listQlbPids ?? defaultQlbPids)(),
        locks: await (dependencies.listHeldLocks ?? (() => defaultHeldLocks(home)))(),
      }),
      now,
      sleep: dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      pendingStash: dependencies.pendingStash ?? (() => defaultPendingStash(home)),
      deleteEnc: dependencies.deleteEnc ?? ((path) => { rmSync(path, { force: true }); }),
      withUndoCapability: (fn) => withUndoCapability(fn),
      withActiveLocks: dependencies.withActiveLocks ?? ((fn) => withClaudeSwitchLock(
        () => withClaudeCredentialLocks({ home: ctx.home, env: ctx.env }, fn),
        { home: ctx.home, env: ctx.env },
      )),
      readActiveCredential: dependencies.readActiveCredential ?? (async () => {
        const paths = claudePaths({ home: ctx.home, env: ctx.env });
        const identity = liveIdentity(paths.globalConfigPath);
        return { credential: await keychain.get(paths.keychainService, macosKeychainAccountName(ctx.env)), accountId: identity?.accountId ?? null };
      }),
      resyncActive: dependencies.resyncActive ?? ((accountId, credential) => defaultResyncActive(
        ctx.config.dbPath,
        ctx.home,
        keychain as ExecuteHandBackDependencies['keychain'],
        accountId,
        credential,
      )),
      readBack: dependencies.readBack,
    }, options.resume);
    if (options.json) ctx.stdout(JSON.stringify({ ...result.plan, skipped: result.skipped, resumed: options.resume }));
    else ctx.stdout(`qlb undo cswap: verified; skipped=${result.skipped}`);
    return 0;
  } catch (error) {
    if (error instanceof CswapUndoRefusalError) return refusal(ctx, options, error);
    if (error instanceof CswapUndoDrainError) {
      ctx.stderr(`qlb undo cswap: refused: drain timeout (${drainMessage(error)})`);
      return 3;
    }
    if (error instanceof CswapUndoVerificationError) {
      ctx.stderr(`qlb undo cswap: verification failed for slot ${error.accountNumber}`);
      return 1;
    }
    // Backend/process messages can contain credentials or command lines.
    ctx.stderr('qlb undo cswap: hand-back failed');
    return 1;
  }
}

const command: CommandDefinition = { name: 'undo cswap', execute: runUndoCswapCommand };
export default command;
