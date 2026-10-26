/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/switcher.py:6641-6688,6689-6834.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

// Classifies an outgoing Claude credential without doing filesystem or network
// I/O. The switch transaction supplies fresh slot bytes; profile resolution is
// injected and happens before locks are held (§4.1).

import {
  credentialFingerprint,
  extractAccessToken,
  parseCredentialBlob,
  type OAuthAccount,
} from './anthropic-oauth';

export type ClaudeCredentialClassificationKind =
  | 'own-bytes'
  | 'own-family'
  | 'own-rotated'
  | 'foreign'
  | 'foreign-synced'
  | 'wiped'
  | 'alien'
  | 'known-foreign'
  | 'unresolved';

/** A slot plus its freshly read credential, supplied by the caller. */
export interface ClassifyClaudeSlot {
  /** QLB's Claude account id is the OAuth account UUID (§3.2). */
  accountId: string;
  email: string | null;
  orgUuid: string | null;
  credential: string | null;
}

/** The Phase-A result is trustworthy only for the exact bytes it read. */
export interface PrefetchedLiveIdentity {
  liveCredential: string | null;
  resolved: OAuthAccount | null;
}

export interface PrefetchLiveIdentityOptions {
  outgoing: ClassifyClaudeSlot;
  /** Injected live-store read; errors deliberately degrade to unresolved. */
  readLive: () => Promise<string | null>;
  /** Injected HTTP profile lookup; errors deliberately degrade to unresolved. */
  resolveProfile: (accessToken: string) => Promise<OAuthAccount | null>;
}

export interface ClassifyOutgoingCredentialInput {
  outgoing: ClassifyClaudeSlot;
  /** Includes the outgoing slot and every other managed Claude slot. */
  slots: readonly ClassifyClaudeSlot[];
  /** The Phase-B fresh live read. Empty values must be refused before this call. */
  liveCredential: string;
  provenance: PrefetchedLiveIdentity;
  /** A definitive, same-lineage collect-pass oracle verdict, if one exists. */
  probeVerdict?: boolean;
}

export interface ClassifiedOutgoingCredential {
  kind: ClaudeCredentialClassificationKind;
  /** Only `foreign` and `foreign-synced` may identify another managed slot. */
  foreignSlotId: string | null;
}

export interface CredentialReadProvenance {
  /** A Keychain-fallback read may be a consumed predecessor and cannot be spent. */
  degraded: boolean;
}

function sameLineage(left: string | null, right: string): boolean {
  if (left == null) return false;
  return credentialFingerprint(left) === credentialFingerprint(right);
}

function normalizedOrg(orgUuid: string | null): string {
  return orgUuid ?? '';
}

function sameOrgWhenKnown(left: string | null, right: string | null): boolean {
  return !left || !right || left === right;
}

function isWipedOauthBlob(credential: string): boolean {
  const oauth = parseCredentialBlob(credential)?.oauth;
  return oauth != null && !oauth.accessToken && !oauth.refreshToken;
}

function resolvedSlot(
  slots: readonly ClassifyClaudeSlot[],
  resolved: OAuthAccount,
): ClassifyClaudeSlot | null {
  const uuid = resolved.uuid.trim();
  const email = resolved.email ?? '';
  const orgUuid = normalizedOrg(resolved.organizationUuid);

  let slot = resolved.email === null
    ? undefined
    : slots.find((candidate) => candidate.email === email && normalizedOrg(candidate.orgUuid) === orgUuid);

  // An email/org match is not enough when both records carry different UUIDs:
  // this is a recycled address, not a slot that may receive the live bytes.
  if (slot && uuid && slot.accountId.trim() && slot.accountId.trim() !== uuid) slot = undefined;

  if (!slot && uuid) {
    slot = slots.find((candidate) =>
      candidate.accountId.trim() === uuid && normalizedOrg(candidate.orgUuid) === orgUuid,
    );
  }
  return slot ?? null;
}

/**
 * Resolve ownership before locks are taken. A matching backup has local
 * provenance and does not need HTTP; missing, malformed, moved, or failed
 * inputs are advisory failures and intentionally return `resolved: null`.
 */
export async function prefetchLiveIdentity(
  options: PrefetchLiveIdentityOptions,
): Promise<PrefetchedLiveIdentity> {
  let liveCredential: string | null;
  try {
    liveCredential = await options.readLive();
  } catch {
    return { liveCredential: null, resolved: null };
  }
  if (!liveCredential || options.outgoing.credential === liveCredential || sameLineage(options.outgoing.credential, liveCredential)) {
    return { liveCredential, resolved: null };
  }

  const accessToken = extractAccessToken(liveCredential);
  if (!accessToken) return { liveCredential, resolved: null };
  try {
    return { liveCredential, resolved: await options.resolveProfile(accessToken) };
  } catch {
    return { liveCredential, resolved: null };
  }
}

/**
 * Classify the Phase-B live credential. A prefetch result is usable only when
 * it names the identical credential bytes; otherwise a stale profile result
 * cannot authorize a destructive slot write.
 */
export function classifyOutgoingCredential(
  input: ClassifyOutgoingCredentialInput,
): ClassifiedOutgoingCredential {
  const { outgoing, liveCredential, provenance } = input;
  if (outgoing.credential === liveCredential) return { kind: 'own-bytes', foreignSlotId: null };
  if (sameLineage(outgoing.credential, liveCredential)) return { kind: 'own-family', foreignSlotId: null };
  if (isWipedOauthBlob(liveCredential)) return { kind: 'wiped', foreignSlotId: null };

  // The cached false verdict remains a safety boundary even if the new probe
  // failed or Phase-A bytes moved. A true verdict never substitutes for a
  // fresh, byte-bound identity response.
  if (provenance.resolved === null || provenance.liveCredential !== liveCredential) {
    return input.probeVerdict === false
      ? { kind: 'known-foreign', foreignSlotId: null }
      : { kind: 'unresolved', foreignSlotId: null };
  }

  const resolved = provenance.resolved;
  const resolvedUuid = resolved.uuid.trim();
  if (
    resolvedUuid
    && outgoing.accountId.trim() === resolvedUuid
    && sameOrgWhenKnown(outgoing.orgUuid, resolved.organizationUuid)
  ) {
    return { kind: 'own-rotated', foreignSlotId: null };
  }

  const slot = resolvedSlot(input.slots, resolved);
  if (slot?.accountId === outgoing.accountId) return { kind: 'own-rotated', foreignSlotId: null };
  if (slot === null) {
    // A positive alien requires the complete email+organization pair. Partial
    // profile shapes are schema drift and must retain the fail-open path.
    return resolved.email !== null && resolved.organizationUuid !== null
      ? { kind: 'alien', foreignSlotId: null }
      : { kind: 'unresolved', foreignSlotId: null };
  }

  // A cross-slot attribution is UUID-positive. `resolvedSlot` can only return
  // this slot after its nonempty UUID matched the profile UUID.
  if (!resolvedUuid || slot.accountId.trim() !== resolvedUuid) {
    return { kind: 'alien', foreignSlotId: null };
  }
  if (slot.credential === liveCredential || sameLineage(slot.credential, liveCredential)) {
    return { kind: 'foreign-synced', foreignSlotId: slot.accountId };
  }
  return { kind: 'foreign', foreignSlotId: slot.accountId };
}

/** The self-switch short-circuit is safe only for locally matching bytes. */
export function decideSelfSwitchAction(input: {
  outgoing: ClassifyClaudeSlot;
  liveCredential: string | null;
  provenance: PrefetchedLiveIdentity;
}): 'noop' | 'noop-diverged' | 'reconcile' {
  // The upstream keeps an unreadable or empty live store as a no-op rather
  // than overwriting it with an unverified backup.
  if (!input.liveCredential || input.outgoing.credential === input.liveCredential || sameLineage(input.outgoing.credential, input.liveCredential)) {
    return 'noop';
  }
  return input.provenance.resolved === null ? 'noop-diverged' : 'reconcile';
}

/** Degraded Keychain-fallback bytes may be served/adopted, never consumed. */
export function mayConsumeCredential(provenance: CredentialReadProvenance): boolean {
  return !provenance.degraded;
}
