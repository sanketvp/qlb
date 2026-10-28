/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/switcher.py:4292-5038.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

// Pure provenance decisions for the active Claude credential path. Effects
// (locks, live-store reads, POSTs, and slot writes) deliberately land in K6-3.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  accessTokenFingerprint,
  buildRefreshRequest,
  classifyRefreshResponse,
  credentialFingerprint,
  extractAccessToken,
  isOAuthTokenExpired,
  parseCredentialBlob,
  parseUsageResponse,
  serializeCredentialBlob,
  type HttpRequestDescription,
} from './anthropic-oauth';
import {
  mergeSharedCredentialFields,
  readClaudeConfig,
  readLiveClaudeCredentials,
  sharedCredentialFields,
  writeLiveClaudeCredentials,
  type ClaudeCredentialsOptions,
} from './cc-credentials';
import { claudePaths } from './cc-paths';
import {
  ClaudeCodeLockTimeout,
  withClaudeConfigLock,
  withClaudeConsumeLock,
  withClaudeCredentialLocks,
  withClaudeSwitchLock,
  type HeldClaudeCredentialLocks,
} from './cc-locks';
import { defaultStashTimestamp } from './cc-consume';
import { ClaudeSlots, type ReadClaudeSlot } from './cc-slots';
import { listCswapProcesses, type CswapProcess } from './cswap-processes';
import { isSuccessor, recordTransition } from './lineage-log';
import type { Store } from './store';

export type ActiveFetchSentinel =
  | 'token-expired'
  | 'foreign-credential'
  | 'keychain-unavailable'
  | 'no-credentials'
  | 'relogin-needed';

/** The value-free result handed to the usage collector by later K6 slices. */
export interface ActiveFetchRecord {
  usage?: unknown;
  error?: string;
  sentinel?: ActiveFetchSentinel;
  retryAfterS?: number;
  unpersisted?: true;
}

export type RefreshOutcome = (
  | { outcome: 'posted'; working: string }
  | { outcome: 'restored'; working: string }
  | { outcome: 'adopted'; working: string }
  | { outcome: 'posted-live-unwritten'; working: string }
  | { outcome: 'posted-slot-unwritten'; working: string }
  | { outcome: 'stashed'; working: string }
  | { outcome: 'unpersisted'; working: string; successorFailure: string }
  | { outcome: 'failed'; reason: 'refresh-failed' | 'invalid_client' | 'foreign-credential' }
  | { outcome: 'dead'; reason: 'invalid_grant' | 'no_refresh_token'; struckFp: string | null }
  | { outcome: 'deferred'; deferReason: 'degraded-read' | 'unattributable' | 'live-read-error' | 'identity-mismatch' | 'live-unattributed-newer' | 'live-moved' | 'locks-held' | 'budget-exhausted' | 'slot-write-failed' | 'unexpected' }
  | { outcome: 'refused'; reason: 'cswap-process-alive' | 'cswap-process-check-failed' | 'store-unmirrored' }
) & { forceRecord?: ActiveFetchRecord };

export interface ProbeVerdict {
  match: boolean;
  source: 'post' | 'oracle';
}

/**
 * In-process, lineage-bound profile verdict cache. It holds no credential
 * bytes; warnings are independently once-only per account/email/condition.
 */
export class ProbeVerdictMemo {
  private readonly verdicts = new Map<string, ProbeVerdict>();
  private readonly warned = new Set<string>();

  private key(accountId: string, email: string, lineageFp: string): string {
    return `${accountId}\u0000${email}\u0000${lineageFp}`;
  }

  get(accountId: string, email: string, lineageFp: string): ProbeVerdict | undefined {
    return this.verdicts.get(this.key(accountId, email, lineageFp));
  }

  set(accountId: string, email: string, lineageFp: string, verdict: ProbeVerdict): void {
    this.verdicts.set(this.key(accountId, email, lineageFp), verdict);
  }

  matches(accountId: string, email: string, lineageFp: string): boolean {
    return this.get(accountId, email, lineageFp)?.match === true;
  }

  warnOnce(accountId: string, email: string, condition: string): boolean {
    const key = `${accountId}\u0000${email}\u0000${condition}`;
    if (this.warned.has(key)) return false;
    this.warned.add(key);
    return true;
  }
}

export interface LiveIdentity {
  accountId: string;
  email: string;
  orgUuid: string;
}

/** Read Claude Code's current oauthAccount without accepting a partial identity. */
export function liveIdentity(configPath: string, readText?: (path: string) => string): LiveIdentity | null {
  const oauthAccount = readClaudeConfig(configPath, readText).oauthAccount;
  if (!oauthAccount || typeof oauthAccount !== 'object' || Array.isArray(oauthAccount)) return null;
  const account = oauthAccount as Record<string, unknown>;
  if (typeof account.accountUuid !== 'string' || typeof account.emailAddress !== 'string') return null;
  return { accountId: account.accountUuid, email: account.emailAddress, orgUuid: typeof account.organizationUuid === 'string' ? account.organizationUuid : '' };
}

/** Credential lineage is a refresh-token fingerprint, never credential bytes. */
export function credentialLineage(credentials: string | null | undefined): string | null {
  return credentials ? credentialFingerprint(credentials) : null;
}

function oauthExpiry(credentials: string | null): unknown {
  return credentials ? parseCredentialBlob(credentials)?.oauth?.expiresAt : undefined;
}

function expiryValue(credentials: string | null): number {
  const value = oauthExpiry(credentials);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function hasUsablePair(credentials: string | null): boolean {
  const oauth = credentials ? parseCredentialBlob(credentials)?.oauth : null;
  return typeof oauth?.accessToken === 'string' && Boolean(oauth.accessToken) &&
    typeof oauth.refreshToken === 'string' && Boolean(oauth.refreshToken);
}

function isFreshPair(credentials: string | null, now: number): boolean {
  return hasUsablePair(credentials) && !isOAuthTokenExpired(oauthExpiry(credentials), now);
}

export interface PreLockAttributionInput {
  creds: string;
  slotFp: string | null;
  slotPrevFp: string | null;
  verdict?: ProbeVerdict;
}

/** Local lineage or a memoized oracle result licenses an active credential. */
export function preLockAttribution(input: PreLockAttributionInput): boolean {
  const fp = credentialLineage(input.creds);
  return (fp !== null && (fp === input.slotFp || fp === input.slotPrevFp)) || input.verdict?.match === true;
}

export type AdoptRotatedLiveDecision =
  | { kind: 'none' }
  | { kind: 'foreign' }
  | { kind: 'adopt'; working: string; writeSlot: boolean };

export interface AdoptRotatedLiveInput {
  creds: string;
  live: string | null;
  slotFp: string | null;
  slotPrevFp: string | null;
  verdict?: ProbeVerdict;
  now: number;
}

/**
 * Decide whether a fresh live rotation may be served and whether it has enough
 * provenance to repair the slot. Unknown fresh lineages are served but never
 * written; a known foreign lineage is neither served nor written.
 */
export function adoptRotatedLive(input: AdoptRotatedLiveInput): AdoptRotatedLiveDecision {
  const { live } = input;
  if (!live || live === input.creds || !isFreshPair(live, input.now)) return { kind: 'none' };
  if (input.verdict?.match === false) return { kind: 'foreign' };
  const fp = credentialLineage(live);
  const writeSlot = fp !== null && (fp === input.slotFp || fp === input.slotPrevFp || input.verdict?.match === true);
  return { kind: 'adopt', working: live, writeSlot };
}

export type RefreshInputDecision =
  | { kind: 'post'; input: string; inputLineageIsSlot: boolean; source: 'live' | 'slot' }
  | { kind: 'restore' }
  | { kind: 'defer'; reason: 'unattributable' | 'live-unattributed-newer' | 'live-moved' };

export interface ChooseRefreshInput {
  /** The credential observed before locks were taken. */
  creds: string;
  /** The locked live-store read; null means the live store was cleared. */
  live: string | null;
  /** The locked slot backup. */
  backup: string | null;
  backupUsable: boolean;
  slotFp: string | null;
  /** A same-pass memo verdict or durable successor proof. */
  attributed: boolean;
  forceRefresh: boolean;
  now: number;
}

function postDecision(input: string, slotFp: string | null, source: 'live' | 'slot'): Extract<RefreshInputDecision, { kind: 'post' }> {
  return { kind: 'post', input, inputLineageIsSlot: credentialLineage(input) === slotFp, source };
}

function backupDecision(input: ChooseRefreshInput): RefreshInputDecision {
  if (!input.backup || !input.backupUsable) {
    return input.attributed ? postDecision(input.creds, input.slotFp, 'live') : { kind: 'defer', reason: 'unattributable' };
  }
  if (!input.forceRefresh && !isOAuthTokenExpired(oauthExpiry(input.backup), input.now)) return { kind: 'restore' };
  return postDecision(input.backup, input.slotFp, 'slot');
}

/**
 * Choose only a safe refresh source. A lineage that appeared while locks were
 * pending is never consumed. A stranded, usable slot backup is restored before
 * spending another grant unless recovery was explicitly forced.
 */
export function chooseRefreshInput(input: ChooseRefreshInput): RefreshInputDecision {
  if (!input.live) return backupDecision(input);

  const liveFp = credentialLineage(input.live);
  if (liveFp !== null && liveFp === input.slotFp) return postDecision(input.live, input.slotFp, 'live');
  if (input.live !== input.creds) return { kind: 'defer', reason: 'live-moved' };

  const backupFp = credentialLineage(input.backup);
  if (liveFp !== null && liveFp === backupFp) return postDecision(input.live, input.slotFp, 'live');

  if (expiryValue(input.live) > expiryValue(input.backup) && hasUsablePair(input.live)) {
    return input.attributed
      ? postDecision(input.live, input.slotFp, 'live')
      : { kind: 'defer', reason: 'live-unattributed-newer' };
  }
  return backupDecision(input);
}

export interface RefreshHttpResponse {
  status: number;
  body: string;
}

type Lock = <T>(fn: () => Promise<T>, options?: { timeoutMs?: number }) => Promise<T>;
type CredentialLock = <T>(fn: (held: HeldClaudeCredentialLocks) => Promise<T>, options?: { timeoutMs?: number }) => Promise<T>;
type ConfigLock = <T>(fn: () => Promise<T>, options?: { timeoutMs?: number }) => Promise<T>;

export interface RefreshActiveLoginDeps {
  slots: ClaudeSlots;
  store: Store;
  live: ClaudeCredentialsOptions;
  readLiveIdentity?: () => LiveIdentity | null;
  postRefresh: (request: HttpRequestDescription) => Promise<RefreshHttpResponse>;
  now: () => number;
  warn?: (message: string) => void;
  verdicts: ProbeVerdictMemo;
  env: NodeJS.ProcessEnv;
  by: 'qlb-auto' | 'qlb-gate' | 'qlb-cli';
  cswapProcesses?: () => CswapProcess[];
  withConsumeLock?: Lock;
  withSwitchLock?: Lock;
  withCredentialLocks?: CredentialLock;
  withConfigLock?: ConfigLock;
  stashTimestamp?: () => string;
  deferSignals?: <T>(fn: () => Promise<T>) => Promise<T>;
  autoLog?: (line: string) => void;
}

export interface RefreshActiveLoginInput {
  accountId: string;
  email: string;
  orgUuid: string;
  /** Credentials observed by the caller before it entered the locked path. */
  creds: string;
  forceRecord?: ActiveFetchRecord;
  degraded: boolean;
  /** Retained for compatibility with K6-2 callers; D-B65 deliberately ignores it. */
  deadlineAt?: number;
  /** Retained for compatibility with K6-2 callers; D-B65 deliberately ignores it. */
  postFloorMs?: number;
}

/** Resolve S24 once, treating test mode in either the process or injected env as hermetic. */
export function resolveCswapCheck(
  injected: (() => CswapProcess[]) | undefined,
  depsEnv: NodeJS.ProcessEnv,
  list: () => CswapProcess[] = listCswapProcesses,
): () => CswapProcess[] {
  if (injected) return injected;
  return process.env.QLB_TEST_MODE === '1' || depsEnv.QLB_TEST_MODE === '1' ? () => [] : list;
}

function withForce<T extends Omit<RefreshOutcome, 'forceRecord'>>(
  input: RefreshActiveLoginInput,
  outcome: T,
): T & Pick<RefreshOutcome, 'forceRecord'> {
  return (input.forceRecord === undefined ? outcome : { ...outcome, forceRecord: input.forceRecord }) as T & Pick<RefreshOutcome, 'forceRecord'>;
}

function warn(deps: RefreshActiveLoginDeps, message: string): void {
  try { deps.warn?.(message); } catch { /* diagnostics never affect a credential safety path */ }
}

function refreshedCredential(current: string, response: Extract<ReturnType<typeof classifyRefreshResponse>, { kind: 'success' }>, now: number): string | null {
  const blob = parseCredentialBlob(current);
  if (!blob?.oauth) return null;
  blob.oauth.accessToken = response.accessToken;
  blob.oauth.expiresAt = now + response.expiresInMs;
  if (response.refreshToken) blob.oauth.refreshToken = response.refreshToken;
  if (response.scopes) blob.oauth.scopes = response.scopes;
  return serializeCredentialBlob(blob);
}

function defaultDeferSignals<T>(fn: () => Promise<T>): Promise<T> {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  const seen: NodeJS.Signals[] = [];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => { seen.push(signal); };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return fn().finally(() => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    // Re-raise only after all persistence attempts completed. A test can inject
    // this seam instead of delivering a process signal to its runner.
    for (const signal of seen) process.kill(process.pid, signal);
  });
}

function defaultAutoLog(store: Store, line: string): void {
  try {
    const directory = dirname(store.dbPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(join(directory, 'auto.log'), `${line}\n`, { mode: 0o600 });
  } catch { /* audit evidence must not discard an issued successor */ }
}

function identityMatches(observed: LiveIdentity | null, input: RefreshActiveLoginInput): boolean {
  return observed !== null && observed.accountId === input.accountId
    && observed.email === input.email && observed.orgUuid === input.orgUuid;
}

function slotUsable(credential: string | null): boolean {
  return credential !== null && hasUsablePair(credential);
}

/**
 * Refresh the one active Claude credential under the complete consume/switch/
 * Claude-Code lock hierarchy. No caller is allowed to reuse an unlocked slot
 * read: every provenance, restore, and strike decision below starts with the
 * fresh slot read performed inside those locks.
 */
export interface ActiveUsageResponse {
  status: number;
  body: string;
  retryAfterS?: number;
}

export interface AcceptedUsageContext {
  accountId: string;
  email: string;
  orgUuid: string;
  creds: string;
  usage: unknown;
}

export interface FetchActiveUsageDeps extends RefreshActiveLoginDeps {
  getUsage: (accessToken: string) => Promise<ActiveUsageResponse>;
  /** Best-effort hook for the K6-5 resync path; never runs from a degraded read. */
  afterAcceptedUsage?: (context: AcceptedUsageContext) => void | Promise<void>;
}

export type FetchActiveUsageInput = Omit<RefreshActiveLoginInput, 'forceRecord'>;

function httpRecord(response: ActiveUsageResponse): ActiveFetchRecord {
  const record: ActiveFetchRecord = { error: `http-${response.status}` };
  if (response.retryAfterS !== undefined) record.retryAfterS = response.retryAfterS;
  return record;
}

async function fetchUsageRecord(
  deps: FetchActiveUsageDeps,
  input: FetchActiveUsageInput,
  creds: string,
): Promise<ActiveFetchRecord> {
  const accessToken = extractAccessToken(creds);
  if (!accessToken) return { sentinel: 'no-credentials' };

  let response: ActiveUsageResponse;
  try {
    response = await deps.getUsage(accessToken);
  } catch {
    return { error: 'usage-fetch-failed' };
  }
  if (response.status < 200 || response.status >= 300) return httpRecord(response);

  let usage: unknown;
  try {
    usage = parseUsageResponse(JSON.parse(response.body));
  } catch {
    return { error: 'usage-unreadable' };
  }
  if (!input.degraded) {
    try {
      await deps.afterAcceptedUsage?.({
        accountId: input.accountId,
        email: input.email,
        orgUuid: input.orgUuid,
        creds,
        usage,
      });
    } catch {
      // Resync is intentionally best-effort; accepted usage remains usable.
      warn(deps, 'Claude active usage resync failed');
    }
  }
  if (deps.verdicts.get(input.accountId, input.email, credentialLineage(creds) ?? '')?.match === false) {
    return { sentinel: 'foreign-credential' };
  }
  return { usage };
}

/**
 * Fetch usage for the active Claude login.  The only recovery POST is delegated
 * to refreshActiveLogin; this wrapper keeps usage I/O outside every credential
 * lock and translates every closed RefreshOutcome into collector-safe data.
 */
export type RefreshOutcomeMapping = ActiveFetchRecord | { working: string };

/** Map the closed refresh result union without ever exposing an unsafe successor. */
export function mapRefreshOutcome(outcome: RefreshOutcome): RefreshOutcomeMapping {
  switch (outcome.outcome) {
    case 'posted':
    case 'posted-slot-unwritten':
    case 'restored':
    case 'adopted':
      return { working: outcome.working };
    case 'posted-live-unwritten':
    case 'stashed':
      return { sentinel: 'token-expired' };
    case 'unpersisted':
      return { sentinel: 'token-expired', unpersisted: true };
    case 'failed':
      return outcome.reason === 'foreign-credential'
        ? { sentinel: 'foreign-credential' }
        : { error: outcome.reason };
    case 'dead':
      return { sentinel: 'relogin-needed', error: outcome.reason };
    case 'deferred':
      if (outcome.deferReason === 'degraded-read') {
        return outcome.forceRecord ?? { sentinel: 'keychain-unavailable' };
      }
      return outcome.forceRecord ?? { sentinel: 'token-expired' };
    case 'refused':
      return { error: outcome.reason };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export async function fetchActiveUsage(
  deps: FetchActiveUsageDeps,
  input: FetchActiveUsageInput,
): Promise<ActiveFetchRecord> {
  // A strike binds to the slot, not the live blob.  Check it before even a
  // locally-valid access token can make a usage request.
  if (deps.slots.getSlot(input.accountId)?.dead) return { sentinel: 'relogin-needed' };

  const accessToken = extractAccessToken(input.creds);
  if (!accessToken) return { sentinel: 'no-credentials' };

  let forceRecord: ActiveFetchRecord | undefined;
  if (!isOAuthTokenExpired(oauthExpiry(input.creds), deps.now())) {
    const initial = await fetchUsageRecord(deps, input, input.creds);
    if (initial.error !== 'http-401') return initial;

    // A different access generation means Claude Code already rotated; never
    // consume a grant based on the rejected snapshot in that case.
    try {
      const live = await readLiveClaudeCredentials({ ...deps.live, env: deps.live.env ?? deps.env });
      if (accessTokenFingerprint(live ?? '') !== accessTokenFingerprint(input.creds)) return initial;
    } catch {
      return initial;
    }
    forceRecord = initial;
  }

  const mapped = mapRefreshOutcome(await refreshActiveLogin(deps, { ...input, forceRecord }));
  return 'working' in mapped ? fetchUsageRecord(deps, input, mapped.working) : mapped;
}

export async function refreshActiveLogin(
  deps: RefreshActiveLoginDeps,
  input: RefreshActiveLoginInput,
): Promise<RefreshOutcome> {
  const finish = (outcome: RefreshOutcome): RefreshOutcome => withForce(input, outcome as Omit<RefreshOutcome, 'forceRecord'>) as RefreshOutcome;
  const effectiveEnv = deps.live.env ?? deps.env;
  const liveOptions = { ...deps.live, env: effectiveEnv };
  const earlySlot = deps.slots.getSlot(input.accountId);
  if (earlySlot?.dead) return finish({ outcome: 'dead', reason: earlySlot.deadReason === 'no_refresh_token' ? 'no_refresh_token' : 'invalid_grant', struckFp: null });
  if (effectiveEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR) return finish({ outcome: 'refused', reason: 'store-unmirrored' });
  if (input.degraded) return finish({ outcome: 'deferred', deferReason: 'degraded-read' });

  const earlyVerdict = deps.verdicts.get(input.accountId, input.email, credentialLineage(input.creds) ?? '');
  if (!preLockAttribution({ creds: input.creds, slotFp: earlySlot?.fingerprint ?? null, slotPrevFp: earlySlot?.prevFingerprint ?? null, verdict: earlyVerdict })
    && !slotUsable(input.creds)) {
    if (deps.verdicts.warnOnce(input.accountId, input.email, 'unattributable')) warn(deps, 'Claude refresh deferred: credential is unattributable');
    return finish({ outcome: 'deferred', deferReason: 'unattributable' });
  }

  try {
    if (resolveCswapCheck(deps.cswapProcesses, deps.env)().length > 0) return finish({ outcome: 'refused', reason: 'cswap-process-alive' });
  } catch {
    return finish({ outcome: 'refused', reason: 'cswap-process-check-failed' });
  }

  const paths = liveOptions.paths ?? claudePaths(liveOptions);
  const lockEnv = effectiveEnv;
  const consumeLock: Lock = deps.withConsumeLock ?? ((fn, options) => withClaudeConsumeLock(input.accountId, fn, {
    home: deps.live.home, env: lockEnv, timeoutMs: options?.timeoutMs,
  }));
  const switchLock: Lock = deps.withSwitchLock ?? ((fn, options) => withClaudeSwitchLock(fn, {
    home: deps.live.home, env: lockEnv, timeoutMs: options?.timeoutMs,
  }));
  const credentialLocks: CredentialLock = deps.withCredentialLocks ?? ((fn, options) => withClaudeCredentialLocks({
    configDir: paths.configHome, env: lockEnv, timeoutMs: options?.timeoutMs,
  }, fn));
  const configLock: ConfigLock = deps.withConfigLock ?? ((fn, options) => withClaudeConfigLock({
    configDir: paths.configHome, env: lockEnv, timeoutMs: options?.timeoutMs,
  }, () => fn()));

  try {
    return await consumeLock(() => switchLock(() => credentialLocks(async (heldLocks) => {
      // This is deliberately the sole slot input for all work beneath it.
      const row = deps.slots.getSlot(input.accountId);
      if (!row) throw new Error('Claude slot is absent');
      const locked = await deps.slots.readSlot(input.accountId, { fresh: true });
      if (row.dead) return finish({ outcome: 'dead', reason: row.deadReason === 'no_refresh_token' ? 'no_refresh_token' : 'invalid_grant', struckFp: null });

      let live: string | null;
      try { live = await readLiveClaudeCredentials(liveOptions); } catch {
        return finish({ outcome: 'deferred', deferReason: 'live-read-error' });
      }
      const readIdentity = deps.readLiveIdentity ?? (() => liveIdentity(paths.globalConfigPath, liveOptions.readText));
      if (!identityMatches(readIdentity(), input)) return finish({ outcome: 'deferred', deferReason: 'identity-mismatch' });

      let backup: ReadClaudeSlot = locked;
      let slotFp: string | null = locked.fingerprint;
      let slotPrevFp = row?.prevFingerprint ?? null;
      const liveFp = credentialLineage(live);
      const memo = liveFp ? deps.verdicts.get(input.accountId, input.email, liveFp) : undefined;
      const adopted = adoptRotatedLive({ creds: input.creds, live, slotFp, slotPrevFp, verdict: memo, now: deps.now() });
      if (adopted.kind === 'foreign') return finish({ outcome: 'failed', reason: 'foreign-credential' });
      if (adopted.kind === 'adopt') {
        if (adopted.writeSlot) {
          try { await deps.slots.writeSlot(input.accountId, adopted.working, { cause: 'adopt', by: deps.by, evidence: memo?.source === 'post' ? 'post' : memo ? 'oracle' : 'lineage' }); }
          catch { warn(deps, 'Claude rotated live credential could not repair slot'); }
        }
        return finish({ outcome: 'adopted', working: adopted.working });
      }

      const decide = (): RefreshInputDecision => {
        const fp = credentialLineage(live);
        const attributed = Boolean(fp && (deps.verdicts.matches(input.accountId, input.email, fp)
          || (slotFp !== null && isSuccessor(deps.store, 'anthropic', input.accountId, slotFp, fp))));
        return chooseRefreshInput({ creds: input.creds, live, backup: backup.credential, backupUsable: slotUsable(backup.credential), slotFp, attributed, forceRefresh: input.forceRecord !== undefined, now: deps.now() });
      };
      const publish = async (working: string, mergeLive: boolean): Promise<void> => {
        const shared = mergeLive ? sharedCredentialFields(live) : null;
        const target = shared ? mergeSharedCredentialFields(working, shared) : working;
        await configLock(() => writeLiveClaudeCredentials(target, liveOptions, heldLocks));
      };

      let choice = decide();
      if (choice.kind === 'defer') return finish({ outcome: 'deferred', deferReason: choice.reason });
      if (choice.kind === 'restore') {
        try { await publish(backup.credential, true); return finish({ outcome: 'restored', working: backup.credential }); }
        catch { return finish({ outcome: 'deferred', deferReason: 'unexpected' }); }
      }

      // S36's key is the currently locked slot lineage. It must be checked
      // immediately before spending a grant, not before waiting for locks.
      const stashed = await deps.slots.adoptStashedSuccessor(input.accountId);
      if (stashed) {
        backup = stashed;
        slotFp = stashed.fingerprint;
        slotPrevFp = deps.slots.getSlot(input.accountId)?.prevFingerprint ?? slotPrevFp;
        choice = decide();
        if (choice.kind === 'defer') return finish({ outcome: 'deferred', deferReason: choice.reason });
        if (choice.kind === 'restore') {
          try { await publish(backup.credential, true); return finish({ outcome: 'restored', working: backup.credential }); }
          catch { return finish({ outcome: 'deferred', deferReason: 'unexpected' }); }
        }
      }

      if (!choice.inputLineageIsSlot) {
        const evidence = memo?.source === 'post' ? 'post' : memo ? 'oracle' : 'lineage';
        try { await deps.slots.writeSlot(input.accountId, choice.input, { cause: 'adopt', by: deps.by, evidence }); }
        catch { return finish({ outcome: 'deferred', deferReason: 'slot-write-failed' }); }
        slotFp = credentialLineage(choice.input);
      }

      const request = buildRefreshRequest(choice.input, 6_000);
      if (request.kind === 'no_refresh_token') {
        const fp = credentialLineage(choice.input);
        if (!fp) return finish({ outcome: 'failed', reason: 'refresh-failed' });
        try {
          const strike = await deps.slots.strikeDead(input.accountId, { reason: 'no_refresh_token', struckFp: fp, ts: deps.now() });
          return strike === 'lineage-moved' ? finish({ outcome: 'failed', reason: 'refresh-failed' }) : finish({ outcome: 'dead', reason: 'no_refresh_token', struckFp: fp });
        } catch { warn(deps, 'Claude dead-token strike failed'); return finish({ outcome: 'failed', reason: 'refresh-failed' }); }
      }
      if (request.kind !== 'request') return finish({ outcome: 'failed', reason: 'refresh-failed' });

      return (deps.deferSignals ?? defaultDeferSignals)(async () => {
        let response: RefreshHttpResponse;
        try { response = await deps.postRefresh(request.request); } catch { return finish({ outcome: 'failed', reason: 'refresh-failed' }); }
        const classified = classifyRefreshResponse(response.status, response.body);
        if (classified.kind === 'dead') {
          // Re-read the source of the POSTed credential before a permanent
          // strike. Live and slot blobs can differ while sharing a lineage.
          const fp = credentialLineage(choice.input);
          let sourceNow: string | null = null;
          try {
            sourceNow = choice.source === 'live'
              ? await readLiveClaudeCredentials(liveOptions)
              : (await deps.slots.readSlot(input.accountId, { fresh: true })).credential;
          } catch { /* an unreadable source does not falsely demote the strike */ }
          if (sourceNow && credentialLineage(sourceNow) !== fp) return finish({ outcome: 'failed', reason: 'refresh-failed' });
          if (!fp) return finish({ outcome: 'failed', reason: 'refresh-failed' });
          try {
            const strike = await deps.slots.strikeDead(input.accountId, { reason: 'invalid_grant', struckFp: fp, ts: deps.now() });
            return strike === 'lineage-moved' ? finish({ outcome: 'failed', reason: 'refresh-failed' }) : finish({ outcome: 'dead', reason: 'invalid_grant', struckFp: fp });
          } catch { warn(deps, 'Claude dead-token strike failed'); return finish({ outcome: 'failed', reason: 'refresh-failed' }); }
        }
        if (classified.kind === 'invalid_client') return finish({ outcome: 'failed', reason: 'invalid_client' });
        if (classified.kind !== 'success') return finish({ outcome: 'failed', reason: 'refresh-failed' });
        const working = refreshedCredential(choice.input, classified, deps.now());
        if (!working) return finish({ outcome: 'failed', reason: 'refresh-failed' });
        const postedFp = credentialLineage(choice.input);
        const workingFp = credentialLineage(working);
        if (workingFp) deps.verdicts.set(input.accountId, input.email, workingFp, { match: true, source: 'post' });

        let slotWritten = true;
        try { await deps.slots.writeSlot(input.accountId, working, { cause: 'post', by: deps.by, evidence: 'post' }); }
        catch {
          slotWritten = false;
          warn(deps, 'Claude refresh successor slot write failed');
          if (postedFp && workingFp) {
            try { recordTransition(deps.store, { provider: 'anthropic', accountId: input.accountId, fromFp: postedFp, toFp: workingFp, cause: 'post', by: deps.by, evidence: 'post' }); }
            catch { warn(deps, 'Claude refresh successor lineage write failed'); }
          }
        }

        let liveWritten = true;
        try { await publish(working, choice.input !== live); }
        catch { liveWritten = false; warn(deps, 'Claude refresh successor live write failed'); }
        if (slotWritten && liveWritten) return finish({ outcome: 'posted', working });
        if (!slotWritten && liveWritten) return finish({ outcome: 'posted-slot-unwritten', working });
        if (slotWritten) return finish({ outcome: 'posted-live-unwritten', working });

        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const stashId = deps.stashTimestamp?.() ?? defaultStashTimestamp(deps.now());
            await deps.slots.stashUnclaimed(stashId, working, postedFp ?? undefined, input.accountId);
            return finish({ outcome: 'stashed', working });
          } catch (error) {
            if (!deps.stashTimestamp && error instanceof Error && /already exists/.test(error.message) && attempt < 2) continue;
            break;
          }
        }
        const successorFailure = 'unable to persist refresh successor';
        try { (deps.autoLog ?? ((line) => defaultAutoLog(deps.store, line)))(`claude:unpersisted-token provider=anthropic account=${input.accountId} at=${deps.now()}`); } catch { /* still return the explicit unsafe outcome */ }
        return finish({ outcome: 'unpersisted', working, successorFailure });
      });
    })), { timeoutMs: undefined });
  } catch (error) {
    if (error instanceof ClaudeCodeLockTimeout) return finish({ outcome: 'deferred', deferReason: 'locks-held' });
    warn(deps, 'Claude active refresh failed unexpectedly');
    return finish({ outcome: 'deferred', deferReason: 'unexpected' });
  }
}
