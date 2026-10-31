/**
 * Pure single-grant ownership classification (P7b5 S0).
 *
 * This module deliberately does not read the store, owner files, Keychain, or
 * Pi's auth.json. Callers collect those durable facts, then pass their
 * normalized result here before making a state-changing decision.
 */

import { qlbKeychainService } from './keychain';
import { ADAPTER_ACCOUNT_IDS, type MigrationState } from './migration';

export type RollbackSourceKind =
  | 'keychain'
  | 'exact-backup'
  | 'legacy-backup'
  | 'none';

/**
 * The complete durable S2 decision. It is written atomically with the fence;
 * `null` fields describe a source that has no corresponding value (for
 * example, kind `none` has no Keychain source fingerprint).
 */
export interface RollbackDecision {
  kind: RollbackSourceKind;
  generation: number | null;
  fingerprint: string | null;
  entryPresent: boolean;
  sourceDigest: string | null;
  kd0: string;
  decidedAt: number;
  fencedGeneration: number;
}

export type KeychainDisposition = 'delete' | 'keep';

export type SingleGrantKeychainProvider = 'xai' | 'kimi-coding';

export interface SingleGrantKeychainCoords {
  service: string;
  account: string;
}

export class JournalKeychainInvalidError extends Error {
  readonly code = 'journal-keychain-invalid';

  constructor() {
    super('journal-keychain-invalid');
    this.name = 'JournalKeychainInvalidError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Returns the shared Keychain coordinates for a single-grant provider. */
export function sharedSingleGrantCoords(provider: SingleGrantKeychainProvider): SingleGrantKeychainCoords {
  return { service: `qlb:${provider}:default`, account: 'qlb' };
}

/**
 * Resolves a durable single-grant journal account to its Keychain item.
 * Legacy accounts omit `keychain`; any recorded coordinates must be the
 * provider's exact shared item so malformed journals fail closed.
 */
export function resolveSingleGrantKeychain(
  provider: SingleGrantKeychainProvider,
  account: unknown,
): SingleGrantKeychainCoords {
  const id = ADAPTER_ACCOUNT_IDS[provider];
  if (!isRecord(account) || account.provider !== provider || account.id !== id) {
    throw new JournalKeychainInvalidError();
  }

  if (!Object.prototype.hasOwnProperty.call(account, 'keychain')) {
    const label = typeof account.label === 'string' ? account.label : '';
    return { service: qlbKeychainService(provider, id), account: label || id };
  }

  const keychain = account.keychain;
  const shared = sharedSingleGrantCoords(provider);
  if (
    !isRecord(keychain)
    || Object.keys(keychain).length !== 2
    || keychain.service !== shared.service
    || keychain.account !== shared.account
  ) {
    throw new JournalKeychainInvalidError();
  }

  return shared;
}

/** The complete durable S5 hand-back marker. */
export interface HandbackMarker {
  phase: 'cleanup-pending';
  keychainDisposition: KeychainDisposition;
  piFingerprint: string | null;
  decision: RollbackDecision | null;
  fencedGeneration: number | null;
  rolledBackAt: number;
}

/** Design notation aliases, exported for readers that use the S2/S5 names. */
export type H = HandbackMarker;
export type SingleGrantRollbackDecision = RollbackDecision;

/**
 * Durable facts used by the S0 classifier. Claim is derived from the three
 * ownership facts O, L, and Oc. The L/Oc components remain separate because
 * S0.6 ignores O and C5 treats only L as proof of this path's commit.
 */
export interface SingleGrantOwnershipFacts {
  p7aOwned: boolean;
  state: MigrationState | null;
  handback: HandbackMarker | null;
  rollbackIntent: boolean;
  rollbackDecision: RollbackDecision | null;
  hasV2OwnerEntry: boolean;
  hasLegacySidecar: boolean;
  hasCustomOwnerFile: boolean;
  commitGeneration: number | null;
  hasStaging: boolean;
}

export type SingleGrantOwnershipRule =
  | 'C1'
  | 'C2'
  | 'C3'
  | 'C4'
  | 'C5'
  | 'C6'
  | 'C7'
  | 'C8'
  | 'C9';

export type SingleGrantOwnershipRoute =
  | 'dual-ownership'
  | 'owned-by-pi-migrate'
  | 'handback-cleanup-pending'
  | 'rollback-in-progress'
  | 'post-commit'
  | 'owner-file-orphan'
  | 'validated-staging'
  | 'pre-commit'
  | 'at-rest';

export interface SingleGrantOwnershipClassification {
  rule: SingleGrantOwnershipRule;
  route: SingleGrantOwnershipRoute;
}

function hasHandback(facts: SingleGrantOwnershipFacts): boolean {
  return facts.handback != null;
}

function isGenericCommit(
  facts: SingleGrantOwnershipFacts,
  claim: boolean,
): boolean {
  return facts.state === 'QLB_OWNED'
    || facts.state === 'RETIRED'
    || (
      facts.state === 'VALIDATED'
      && claim
      && (facts.hasLegacySidecar || facts.commitGeneration != null)
    );
}

/**
 * Implements S0 C1-C9 in table order. The first matching rule wins.
 */
export function classifySingleGrant(
  facts: SingleGrantOwnershipFacts,
): SingleGrantOwnershipClassification {
  const handbackPending = hasHandback(facts);
  const hasRollback = facts.rollbackIntent || facts.rollbackDecision != null;
  const claim = facts.hasV2OwnerEntry
    || facts.hasLegacySidecar
    || facts.hasCustomOwnerFile;
  const committed = isGenericCommit(facts, claim);

  if (facts.p7aOwned && (committed || hasRollback || handbackPending)) {
    return { rule: 'C1', route: 'dual-ownership' };
  }
  if (facts.p7aOwned) return { rule: 'C2', route: 'owned-by-pi-migrate' };
  if (handbackPending) return { rule: 'C3', route: 'handback-cleanup-pending' };
  if (hasRollback) return { rule: 'C4', route: 'rollback-in-progress' };
  if (committed) return { rule: 'C5', route: 'post-commit' };
  if (claim) return { rule: 'C6', route: 'owner-file-orphan' };
  if (facts.state === 'VALIDATED' && facts.hasStaging) {
    return { rule: 'C7', route: 'validated-staging' };
  }
  if (facts.state === 'MIRRORED' || facts.hasStaging) {
    return { rule: 'C8', route: 'pre-commit' };
  }
  return { rule: 'C9', route: 'at-rest' };
}

/** S0.6: generic migration admission predicate for `qlb pi migrate`. */
export function isSingleGrantAtRest(facts: SingleGrantOwnershipFacts): boolean {
  return !hasHandback(facts)
    && !facts.rollbackIntent
    && facts.rollbackDecision == null
    && !facts.hasLegacySidecar
    && !facts.hasCustomOwnerFile
    && !facts.hasStaging
    && (facts.state === null || facts.state === 'NATIVE' || facts.state === 'VALIDATED');
}
