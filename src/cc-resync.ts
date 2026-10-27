/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/switcher.py:4292-5038.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

// Pure provenance decisions for the active Claude credential path. Effects
// (locks, live-store reads, POSTs, and slot writes) deliberately land in K6-3.

import { credentialFingerprint, isOAuthTokenExpired, parseCredentialBlob } from './anthropic-oauth';
import { readClaudeConfig } from './cc-credentials';

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
  | { kind: 'post'; input: string; inputLineageIsSlot: boolean }
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

function postDecision(input: string, slotFp: string | null): Extract<RefreshInputDecision, { kind: 'post' }> {
  return { kind: 'post', input, inputLineageIsSlot: credentialLineage(input) === slotFp };
}

function backupDecision(input: ChooseRefreshInput): RefreshInputDecision {
  if (!input.backup || !input.backupUsable) {
    return input.attributed ? postDecision(input.creds, input.slotFp) : { kind: 'defer', reason: 'unattributable' };
  }
  if (!input.forceRefresh && !isOAuthTokenExpired(oauthExpiry(input.backup), input.now)) return { kind: 'restore' };
  return postDecision(input.backup, input.slotFp);
}

/**
 * Choose only a safe refresh source. A lineage that appeared while locks were
 * pending is never consumed. A stranded, usable slot backup is restored before
 * spending another grant unless recovery was explicitly forced.
 */
export function chooseRefreshInput(input: ChooseRefreshInput): RefreshInputDecision {
  if (!input.live) return backupDecision(input);

  const liveFp = credentialLineage(input.live);
  if (liveFp !== null && liveFp === input.slotFp) return postDecision(input.live, input.slotFp);
  if (input.live !== input.creds) return { kind: 'defer', reason: 'live-moved' };

  const backupFp = credentialLineage(input.backup);
  if (liveFp !== null && liveFp === backupFp) return postDecision(input.live, input.slotFp);

  if (expiryValue(input.live) > expiryValue(input.backup) && hasUsablePair(input.live)) {
    return input.attributed
      ? postDecision(input.live, input.slotFp)
      : { kind: 'defer', reason: 'live-unattributed-newer' };
  }
  return backupDecision(input);
}
