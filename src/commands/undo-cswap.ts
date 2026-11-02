import { execFileSync } from 'node:child_process';
import { credentialFingerprint, type HttpRequestDescription } from '../anthropic-oauth';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  CswapUndoActiveLoginError,
  CswapUndoDrainError,
  CswapUndoPendingStashError,
  CswapUndoRefusalError,
  CswapUndoSequenceError,
  CswapUndoVerificationError,
  executeHandBack,
  planHandBack,
  type ExecuteHandBackDependencies,
  type HandBackPlan,
  type PlanHandBackDependencies,
} from '../cswap-undo';
import { claudePaths } from '../cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository, type ClaudeSlotBackend } from '../cc-slots';
import { CREDENTIALS_STALENESS_MS, withClaudeCredentialLocks, withClaudeSwitchLock } from '../cc-locks';
import { cacheProfileVerdict, credentialLineage, liveIdentity, ProbeVerdictMemo, resyncUnderHeldLocks, type ResyncProfileResponse } from '../cc-resync';
import { productionLaunchctlCswapAgent, productionTryAcquireLock, unavailableCswapAgent, type CswapAgent } from '../cswap-agent';
import type { CredentialBackend } from '../credential-backends';
import { qlbHomeDir } from '../home';
import { withUndoCapability } from '../keychain-allowlist';
import { isSuccessor } from '../lineage-log';
import { listUnclaimedKeychainServices, macosKeychainAccountName, platformKeychain } from '../keychain';
import { listStashes } from '../unclaimed-index';
import { CSWAP_RESTORE_PENDING, clearCswapRestorePending, phase, transition } from '../lifecycle';
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
  validateActiveSequence?: ExecuteHandBackDependencies['validateActiveSequence'];
  setActiveAccountNumber?: ExecuteHandBackDependencies['setActiveAccountNumber'];
  /** The C-swap agent owns launchctl and its own plist restoration. */
  cswapAgent?: Pick<CswapAgent, 'restorePlist'>;
  /** Moves QLB's agent plist only after a verified hand-back. */
  moveQlbPlist?: () => { ok: boolean; code?: string } | Promise<{ ok: boolean; code?: string }>;
  /** Test seam for the active-login ownership oracle. */
  getProfile?: (request: HttpRequestDescription) => Promise<ResyncProfileResponse>;
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
    const record = error as { code?: unknown; status?: unknown } | undefined;
    const code = typeof record?.code === 'string' ? record.code : 'launchctl-failed';
    // execFileSync reports launchctl's status separately from its OS error
    // code. A missing job is therefore status 3, not code ESRCH.
    if (code === 'ESRCH' || record?.status === 3) return { ok: true };
    return { ok: false, code };
  }
}

function defaultQlbPids(): number[] {
  const output = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
  }));
  const rows = new Map<number, { parent: number; command: string }>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) rows.set(Number(match[1]), { parent: Number(match[2]), command: match[3] });
  }
  const ignored = new Set<number>();
  for (let pid: number | undefined = process.pid; pid && !ignored.has(pid); pid = rows.get(pid)?.parent) ignored.add(pid);
  return [...rows].filter(([pid, row]) => !ignored.has(pid) && isQlbProcessCommand(row.command)).map(([pid]) => pid).sort((a, b) => a - b);
}

/** Match only QLB's executable or Node script position, never ordinary arguments. */
export function isQlbProcessCommand(command: string): boolean {
  const [executable, ...args] = command.trim().split(/\s+/);
  if (!executable) return false;
  if (basename(executable) === 'qlb') return true;
  if (basename(executable) !== 'node') return false;
  const script = args.find((arg) => !arg.startsWith('-'));
  return script !== undefined && (basename(script) === 'qlb' || /(?:^|[\\/])dist[\\/]cli\.js$/.test(script));
}

async function defaultHeldLocks(home: string, now: () => number): Promise<string[]> {
  const directory = join(home, '.qlb', 'locks');
  if (!existsSync(directory)) return [];
  const held: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (name === 'auto.lock') {
      // flock ownership, rather than the persistent lock-file's existence,
      // determines whether the auto tick is still running.
      const release = await productionTryAcquireLock(path);
      if (release === null) held.push(name);
      else await release();
    } else if (/^(?:consume|switch)-.*\.lock$/.test(name)) {
      try {
        // proper-lockfile directories left by a dead owner are stale after
        // the same lease used by the credential lock implementation.
        if (now() - statSync(path).mtimeMs <= CREDENTIALS_STALENESS_MS) held.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return held;
}

async function defaultPendingStash(home: string): Promise<string | null> {
  const indexed = await listStashes(join(home, '.qlb', 'unclaimed'), 'anthropic');
  if (indexed.length > 0) return indexed[0]!.stashId;
  const directory = join(home, '.qlb', 'unclaimed');
  try {
    const file = readdirSync(directory).sort().find((name) => name.endsWith('.json'));
    if (file) return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const service = listUnclaimedKeychainServices().filter((name) => name.startsWith('qlb:anthropic:unclaimed:')).sort()[0];
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

async function productionProfileRequest(request: HttpRequestDescription): Promise<ResyncProfileResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  return { status: response.status, body: await response.text() };
}

/** Called only inside the active switch + credential lock hold. */
async function defaultResyncActive(
  dbPath: string,
  home: string,
  env: NodeJS.ProcessEnv,
  keychain: ExecuteHandBackDependencies['keychain'],
  getProfile: (request: HttpRequestDescription) => Promise<ResyncProfileResponse>,
  accountId: string,
  credential: string,
): Promise<void> {
  const repository = SqliteClaudeSlotRepository.open(dbPath);
  const store = openStore(dbPath);
  try {
    const slots = new ClaudeSlots({ backend: keychain as unknown as ClaudeSlotBackend, repository, stashDir: join(home, '.qlb', 'unclaimed') });
    const current = await slots.readSlot(accountId, { fresh: true });
    const registered = slots.getSlot(accountId);
    if (!registered) return;
    const paths = claudePaths({ home, env });
    const observed = (() => {
      try { return liveIdentity(paths.globalConfigPath); } catch { return null; }
    })();
    // UUID is the identity authority. Email and organization only corroborate
    // when QLB recorded them; an old import with either field absent is valid.
    const knownIdentityMatches = observed !== null
      && observed.accountId === accountId
      && (registered.email == null || observed.email === registered.email)
      && (registered.orgUuid == null || observed.orgUuid === registered.orgUuid);
    if (!knownIdentityMatches) throw new CswapUndoActiveLoginError(registered.slotNum ?? 0);

    const verdicts = new ProbeVerdictMemo();
    const input = {
      accountId, email: registered.email ?? '', orgUuid: registered.orgUuid ?? '',
      creds: credential, slot: current,
    };
    const liveFp = credentialLineage(credential);
    if (liveFp === current.fingerprint) {
      // Refreshes can retain their refresh token while changing access/expiry
      // bytes. Persist those exact locked live bytes before exporting them.
      if (current.credential !== credential) {
        await slots.writeSlot(accountId, credential, { cause: 'adopt', by: 'qlb-cli', evidence: 'lineage' });
      }
      return;
    }

    const slotAhead = liveFp !== null && current.fingerprint !== null
      && (liveFp === registered.prevFingerprint
        || isSuccessor(store, 'anthropic', accountId, liveFp, current.fingerprint));
    // A native Claude Code rotation has no QLB lineage edge. Attribute that
    // locked live credential through the same profile oracle as resync before
    // asking resyncUnderHeldLocks to promote it.
    let profileMatch: boolean | null = null;
    if (!slotAhead) {
      try { profileMatch = await cacheProfileVerdict({ getProfile, verdicts }, input); } catch { /* fail closed below */ }
    }
    if (registered.email == null || registered.orgUuid == null) {
      // resyncUnderHeldLocks deliberately requires exact stored identity. An
      // old imported slot may lack corroborating fields, so the same UUID
      // profile oracle is the authority for this one locked adoption.
      if (!slotAhead && profileMatch === true) {
        await slots.writeSlot(accountId, credential, { cause: 'resync', by: 'qlb-cli', evidence: 'oracle' });
      }
    } else {
      await resyncUnderHeldLocks({
        slots, store, live: { backend: keychain as unknown as CredentialBackend, paths, env }, env,
        verdicts, now: Date.now,
        readLiveIdentity: () => observed,
        getProfile,
        by: 'qlb-cli',
      }, input);
    }
    const after = await slots.readSlot(accountId, { fresh: true });
    if (liveFp === null || (after.fingerprint !== liveFp
      && !isSuccessor(store, 'anthropic', accountId, liveFp, after.fingerprint))) {
      throw new CswapUndoActiveLoginError(registered.slotNum ?? 0);
    }
  } finally { store.close(); repository.close(); }
}

function defaultReadBack(backupDir: string, keychain: ExecuteHandBackDependencies['keychain']): ExecuteHandBackDependencies['readBack'] {
  return async (slot) => {
    const path = join(backupDir, 'credentials', `.creds-${slot.accountNumber}-${slot.email}.enc`);
    if (existsSync(path)) {
      try {
        const value = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64').toString('utf8');
        if (credentialFingerprint(value)) return value;
      } catch { /* corrupt .enc falls through to Keychain */ }
    }
    try { return await keychain.get('claude-swap', slot.item); } catch { return null; }
  };
}

function readActiveSequence(sequencePath: string, accountNumber: number): Record<string, unknown> {
  if (!existsSync(sequencePath)) throw new CswapUndoSequenceError('missing');
  try {
    const parsed: unknown = JSON.parse(readFileSync(sequencePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const sequence = parsed as Record<string, unknown>;
    const accounts = sequence.accounts;
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)
      || !(String(accountNumber) in accounts)) throw new Error('account missing');
    return sequence;
  } catch (error) {
    if (error instanceof CswapUndoSequenceError) throw error;
    throw new CswapUndoSequenceError('malformed');
  }
}

function defaultValidateActiveSequence(sequencePath: string): ExecuteHandBackDependencies['validateActiveSequence'] {
  return async (accountNumber) => {
    if (accountNumber !== null) readActiveSequence(sequencePath, accountNumber);
  };
}

function defaultSetActiveAccountNumber(sequencePath: string): ExecuteHandBackDependencies['setActiveAccountNumber'] {
  return async (accountNumber) => {
    if (accountNumber === null) return;
    await defaultValidateActiveSequence(sequencePath)!(accountNumber);
    const release = await productionTryAcquireLock(join(dirname(sequencePath), '.lock'));
    if (release === null) throw new Error('C-swap sequence lock is held');
    try {
      // Re-read and decide equality beneath C-swap's own flock so no
      // concurrent writer can invalidate an unlocked observation.
      const current = readActiveSequence(sequencePath, accountNumber);
      if (current.activeAccountNumber === accountNumber) return;
      const temporary = `${sequencePath}.tmp.${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify({ ...current, activeAccountNumber: accountNumber })}\n`, { mode: 0o600 });
      renameSync(temporary, sequencePath);
    } finally { await release(); }
  };
}

function defaultCswapAgent(ctx: CommandContext): Pick<CswapAgent, 'restorePlist'> {
  if (ctx.env.QLB_TEST_MODE === '1' || process.env.QLB_TEST_MODE === '1') return unavailableCswapAgent;
  return productionLaunchctlCswapAgent(ctx.home, qlbHomeDir(ctx.env), ctx.config.cswapSequencePath);
}

function defaultMoveQlbPlist(ctx: CommandContext): { ok: boolean; code?: string } {
  if (ctx.env.QLB_TEST_MODE === '1' || process.env.QLB_TEST_MODE === '1') return { ok: false, code: 'qlb-plist-mover-not-injected' };
  const source = join(ctx.home, 'Library', 'LaunchAgents', 'com.modus.qlb-auto.plist');
  const backupDir = join(qlbHomeDir(ctx.env), '.qlb', 'backups', 'qlb-plist');
  const target = join(backupDir, 'com.modus.qlb-auto.plist');
  try {
    // Before cutover commit the QLB agent has not been installed, so no plist
    // is normal. A prior move followed by a failed C-swap restore is likewise
    // already complete from this mover's perspective.
    if (!existsSync(source)) return { ok: true };
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    renameSync(source, target);
    return { ok: true };
  } catch {
    return { ok: false, code: 'qlb-plist-move-failed' };
  }
}

type TerminalHandBack = { state: 'rolled-back' | 'aborted'; lifecycleId: number; restorePending: boolean };

class CswapUndoFinalizationError extends Error {
  constructor(readonly state: string) {
    super('hand-back finalization failed');
    this.name = 'CswapUndoFinalizationError';
  }
}

function clearRestorePending(ctx: CommandContext): void {
  const store = openStore(ctx.config.dbPath);
  try {
    if (!clearCswapRestorePending(store).ok) throw new CswapUndoFinalizationError(phase(store).state);
  } finally { store.close(); }
}

async function restoreCswap(ctx: CommandContext, dependencies: UndoCswapCommandDependencies, final: TerminalHandBack): Promise<void> {
  const restored = await (dependencies.cswapAgent ?? defaultCswapAgent(ctx)).restorePlist();
  if (!restored.ok) throw new CswapUndoFinalizationError(final.state);
  // Leave the durable fence in place until the agent confirms its plist is restored.
  clearRestorePending(ctx);
}

async function finishHandBack(
  ctx: CommandContext,
  dependencies: UndoCswapCommandDependencies,
  now: number,
): Promise<TerminalHandBack> {
  const moved = await (dependencies.moveQlbPlist ?? (() => defaultMoveQlbPlist(ctx)))();
  if (!moved.ok) throw new CswapUndoFinalizationError(terminalHandBackPhase(ctx)?.state ?? 'undoing');
  const store = openStore(ctx.config.dbPath);
  let final: TerminalHandBack;
  try {
    const current = phase(store);
    const target = current.preFenceState === 'cutover' ? 'rolled-back'
      : current.preFenceState === 'cutting-over' ? 'aborted' : null;
    if (current.state !== 'undoing' || target === null) throw new CswapUndoFinalizationError(current.state);
    // State and fence share one compare-and-set write, so a crash leaves a
    // terminal row that only the restore-only resume path can finish.
    const transitioned = transition(store, target, now, CSWAP_RESTORE_PENDING);
    if (!transitioned.ok) throw new CswapUndoFinalizationError(phase(store).state);
    final = { state: target, lifecycleId: transitioned.row!.id, restorePending: true };
  } finally { store.close(); }
  await restoreCswap(ctx, dependencies, final);
  return { ...final, restorePending: false };
}

function terminalHandBackPhase(ctx: CommandContext): TerminalHandBack | null {
  const store = openStore(ctx.config.dbPath);
  try {
    const current = phase(store);
    return current.state === 'rolled-back' || current.state === 'aborted'
      ? { state: current.state, lifecycleId: current.id, restorePending: current.note === CSWAP_RESTORE_PENDING } : null;
  } finally { store.close(); }
}

function reportComplete(ctx: CommandContext, options: Options, result: HandBackPlan | null, skipped: number, state: 'rolled-back' | 'aborted', lifecycleId: number): void {
  const nextStep = `qlb lifecycle close ${lifecycleId}`;
  if (options.json) {
    ctx.stdout(JSON.stringify(result === null
      ? { resumed: true, state, nextStep }
      : { ...result, skipped, resumed: options.resume, state, nextStep }));
  } else {
    ctx.stdout(`qlb undo cswap: restored; next: ${nextStep}`);
  }
}

/** `qlb undo cswap [--dry-run | --resume]`: G16–G18 hand-back. */
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
    // A failed C-swap restore happens after the durable terminal transition.
    // Its one resume must not fence, drain, write slots, or move QLB again.
    const terminal = options.resume ? terminalHandBackPhase(ctx) : null;
    if (terminal) {
      if (terminal.restorePending) await restoreCswap(ctx, dependencies, terminal);
      reportComplete(ctx, options, null, 0, terminal.state, terminal.lifecycleId);
      return 0;
    }
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
        locks: await (dependencies.listHeldLocks ?? (() => defaultHeldLocks(home, now)))(),
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
        ctx.env,
        keychain as ExecuteHandBackDependencies['keychain'],
        dependencies.getProfile ?? productionProfileRequest,
        accountId,
        credential,
      )),
      readBack: dependencies.readBack ?? defaultReadBack(dependencies.backupDir ?? dirname(ctx.config.cswapSequencePath), keychain as ExecuteHandBackDependencies['keychain']),
      validateActiveSequence: dependencies.validateActiveSequence ?? defaultValidateActiveSequence(ctx.config.cswapSequencePath),
      setActiveAccountNumber: dependencies.setActiveAccountNumber ?? defaultSetActiveAccountNumber(ctx.config.cswapSequencePath),
    }, options.resume);
    const finished = await finishHandBack(ctx, dependencies, now());
    reportComplete(ctx, options, result.plan, result.skipped, finished.state, finished.lifecycleId);
    return 0;
  } catch (error) {
    if (error instanceof CswapUndoRefusalError) return refusal(ctx, options, error);
    if (error instanceof CswapUndoDrainError) {
      ctx.stderr(`qlb undo cswap: refused: drain timeout (${drainMessage(error)})`);
      return 3;
    }
    if (error instanceof CswapUndoPendingStashError) {
      ctx.stderr(`qlb undo cswap: refused: pending Claude stash ${error.stash}`);
      return 3;
    }
    if (error instanceof CswapUndoSequenceError) {
      ctx.stderr(`qlb undo cswap: refused: C-swap sequence.json is ${error.reason}`);
      return 3;
    }
    if (error instanceof CswapUndoVerificationError) {
      ctx.stderr(`qlb undo cswap: verification failed for slot ${error.accountNumber}`);
      return 1;
    }
    if (error instanceof CswapUndoActiveLoginError) {
      ctx.stderr(`qlb undo cswap: active account ${error.accountNumber}: ${error.reason}`);
      return 1;
    }
    if (error instanceof CswapUndoFinalizationError) {
      ctx.stderr(`qlb undo cswap: hand-back failed; state=${error.state}; run qlb undo cswap --resume`);
      return 1;
    }
    // Backend/process messages can contain credentials or command lines.
    ctx.stderr('qlb undo cswap: hand-back failed');
    return 1;
  }
}

const command: CommandDefinition = { name: 'undo cswap', execute: runUndoCswapCommand };
export default command;
