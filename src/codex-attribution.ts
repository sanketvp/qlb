// S56 Codex native-document attribution. Codex has no inter-process lock, so
// observations extend the lineage graph rather than rejecting ordinary rotations.

import { DatabaseSync } from 'node:sqlite';
import { CodexAuthLockCompromised } from './cc-locks';
import { authTime, codexFingerprint, codexIdentity, parseCodexAuth, type CodexAuthDocument } from './codex-auth';
import { isCredentialNotFound } from './credential-backends';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from './keychain';
import { externalLoginCheck, isSuccessor, type HolderObservation } from './lineage-log';
import type { Store } from './store';

const PROVIDER = 'openai-codex';

type Keychain = Pick<KeychainBackend, 'getSync' | 'setSync' | 'deleteSync'>;

export type CodexAttributionAction = 'noop' | 'republish-slot' | 'adopt' | 'drift' | 'unclaimed' | 'wiped' | 'slot-split';

export interface ManagedCodexDocument {
  /** S29 composite identity of the managed slot. */
  accountId: string;
  document: CodexAuthDocument;
  /** Persisted row fingerprint; it is the adoption CAS/noop authority. */
  fingerprint?: string;
}

export interface AttributeLiveDocumentInput {
  store: Store;
  keychain: Keychain;
  slot: ManagedCodexDocument;
  /** The active_login identity when it differs from the live identity's known slot. */
  activeSlotId?: string;
  /** active_login provenance; defaults to import for ordinary observations. */
  activeSetBy?: 'import' | 'adopt';
  /** `null` is the stable-reader's tokens-empty/wiped result. */
  live: CodexAuthDocument | null;
  /** Holder facts around the two observations, injected by the session watcher. */
  holderObservation?: HolderObservation;
  /** C1c/X1 established that Codex's `auth_time` claim has its documented meaning. */
  l40Verified?: boolean;
  now?: () => number;
  /** Assert the caller-owned Codex auth capability immediately before every mutation. */
  assertNotCompromised?: () => void;
  /** Caller-owned atomic auth.json publication; injected for fixture-only tests. */
  republish?: (document: CodexAuthDocument) => Promise<void> | void;
  /** Runs inside attribution's final save before its first write. */
  beforeSave?: (db: DatabaseSync, dbPath: string, slotId: string) => undefined;
  /** Runs inside attribution's final save immediately before COMMIT. */
  beforeSaveCommit?: (db: DatabaseSync, kind: 'existing-mark' | 'existing-adopt') => undefined;
}

export interface CodexAttributionResult {
  action: CodexAttributionAction;
  accountId?: string;
  /** The underlying decision when `action === 'drift'`. */
  disposition?: Exclude<CodexAttributionAction, 'drift'>;
}

function evidenceFor(holders: HolderObservation | undefined): 'holder' | 'identity' {
  return holders?.aliveBefore || holders?.aliveAfter ? 'holder' : 'identity';
}

function reloginEvidence(
  slotFp: string,
  live: CodexAuthDocument,
  input: AttributeLiveDocumentInput,
): 'auth-time' | 'unattributed-rotation' | null {
  const successor = isSuccessor(input.store, PROVIDER, input.slot.accountId, slotFp, codexFingerprint(live));
  const classification = externalLoginCheck({
    provider: PROVIDER,
    successor,
    l40Verified: input.l40Verified,
    authTimeChanged: authTime(input.slot.document) !== authTime(live),
    holderObservation: input.holderObservation,
  });
  return classification === 'hard'
    ? 'auth-time'
    : classification === 'soft'
      ? 'unattributed-rotation'
      : null;
}

function optionalKeychainValue(keychain: Keychain, service: string): string | undefined {
  try {
    return keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
  } catch (error) {
    if (isCredentialNotFound(error)) return undefined;
    throw error;
  }
}

function fingerprintOfStoredDocument(value: string): string | null {
  const parsed = parseCodexAuth(value);
  return parsed.ok ? codexFingerprint(parsed.doc) : null;
}

function assertNotCompromised(input: AttributeLiveDocumentInput): void {
  input.assertNotCompromised?.();
}

function markImportedActive(input: AttributeLiveDocumentInput, fingerprint: string, ts: number): void {
  assertNotCompromised(input);
  if (!input.store.markCodexSlotImportedActive(input.slot.accountId, fingerprint, ts, input.assertNotCompromised, {
    beforeWrite: input.beforeSave && ((db, dbPath) => input.beforeSave?.(db, dbPath, input.slot.accountId)),
    beforeCommit: input.beforeSaveCommit,
  }, input.activeSetBy)) {
    // The fingerprint was observed under the caller's lease. A mismatch means
    // a successor already selected a different active slot; retry fresh.
    throw new CodexAuthLockCompromised();
  }
}

function repairedFingerprintStillCurrent(input: AttributeLiveDocumentInput, fingerprint: string): boolean {
  // republish() publishes to auth.json asynchronously, so it must not run
  // while SQLite's synchronous write transaction is held. Reacquire that lock
  // immediately before making the post-repair decision observable instead.
  return input.store.runImmediate(
    () => input.store.getCodexSlot(input.slot.accountId)?.fingerprint === fingerprint,
  );
}

async function attributeSameSlot(
  input: AttributeLiveDocumentInput,
  repairedFingerprint?: string,
): Promise<CodexAttributionResult & {
  action: Exclude<CodexAttributionAction, 'drift'>;
}> {
  // The database, rather than a possibly half-written Keychain item, defines
  // both noop and the predecessor required by the CAS.
  const slotFp = input.slot.fingerprint ?? codexFingerprint(input.slot.document);
  const live = input.live;
  if (!live) return { action: 'wiped', accountId: input.slot.accountId };

  const service = qlbKeychainService(PROVIDER, input.slot.accountId);
  // A DB/Keychain split must be resolved before either nooping or republishing:
  // both actions otherwise claim authority for bytes that are not in the slot.
  if (codexFingerprint(input.slot.document) !== slotFp) {
    const liveFp = codexFingerprint(live);
    assertNotCompromised(input);
    const repair = input.store.repairCodexSlotKeychain({
      accountId: input.slot.accountId,
      assertNotCompromised: input.assertNotCompromised,
      // Choose the replacement only after BEGIN IMMEDIATE has re-read the
      // fingerprint that authorizes it and the Keychain document it replaces.
      prepare: (lockedFingerprint) => {
        let recorded: CodexAuthDocument | undefined = liveFp === lockedFingerprint ? live : undefined;
        if (!recorded) {
          const previous = optionalKeychainValue(input.keychain, `${service}:prev`);
          if (previous !== undefined) {
            const parsed = parseCodexAuth(previous);
            if (parsed.ok && codexFingerprint(parsed.doc) === lockedFingerprint) recorded = parsed.doc;
          }
        }
        if (!recorded) return undefined;
        return {
          current: input.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT),
          replacement: JSON.stringify(recorded),
          value: recorded,
        };
      },
      // A Keychain backend has no atomic CAS, so make the final possible
      // compare-before-write while the DB write lock excludes QLB adopters.
      writeIfUnchanged: (candidate) => {
        if (input.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT) !== candidate.current) return false;
        assertNotCompromised(input);
        input.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, candidate.replacement);
        return true;
      },
      restore: (candidate) => {
        // Compensation relies on its value CAS, not the capability that may
        // have failed after this Keychain write.
        if (input.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT) !== candidate.replacement) return false;
        input.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, candidate.current);
        return true;
      },
    });
    if (!repair.repaired || !repair.value || !repair.fingerprint) {
      return { action: 'slot-split', accountId: input.slot.accountId };
    }
    // Use the fingerprint re-read under the transaction, not the caller's
    // pre-lock snapshot, for the follow-up attribution decision.
    return attributeSameSlot(
      { ...input, slot: { ...input.slot, document: repair.value, fingerprint: repair.fingerprint } },
      repair.fingerprint,
    );
  }

  const now = (input.now ?? Date.now)();
  const liveFp = codexFingerprint(live);
  if (slotFp === liveFp) {
    if (repairedFingerprint && !repairedFingerprintStillCurrent(input, repairedFingerprint)) {
      return { action: 'slot-split', accountId: input.slot.accountId };
    }
    markImportedActive(input, slotFp, now);
    return { action: 'noop', accountId: input.slot.accountId };
  }

  // The only leave-equivalent: QLB saved the successor but failed before the
  // auth.json rename, so the managed slot must be published back to Codex.
  if (isSuccessor(input.store, PROVIDER, input.slot.accountId, liveFp, slotFp)) {
    if (repairedFingerprint && !repairedFingerprintStillCurrent(input, repairedFingerprint)) {
      return { action: 'slot-split', accountId: input.slot.accountId };
    }
    assertNotCompromised(input);
    await input.republish?.(input.slot.document);
    markImportedActive(input, slotFp, now);
    return { action: 'republish-slot', accountId: input.slot.accountId };
  }

  const currentBefore = input.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
  const previousService = `${service}:prev`;
  const previousBefore = optionalKeychainValue(input.keychain, previousService);
  const currentWritten = JSON.stringify(live);
  let wroteCurrent = false;
  let wrotePrevious = false;
  assertNotCompromised(input);
  input.store.adoptCodexSlotWithKeychain({
    accountId: input.slot.accountId,
    assertNotCompromised: input.assertNotCompromised,
    beforeWrite: input.beforeSave && ((db, dbPath) => input.beforeSave?.(db, dbPath, input.slot.accountId)),
    beforeCommit: input.beforeSaveCommit,
    previousFingerprint: slotFp,
    fingerprint: liveFp,
    lastRefresh: live.last_refresh ?? null,
    ts: now,
    evidence: evidenceFor(input.holderObservation),
    reloginEvidence: reloginEvidence(slotFp, live, input),
    setBy: input.activeSetBy,
    writeKeychain: () => {
      // On a crash-retry the Keychain can already contain the live document.
      // Do not overwrite a real predecessor with that successor.
      if (fingerprintOfStoredDocument(currentBefore) === slotFp) {
        assertNotCompromised(input);
        input.keychain.setSync(previousService, QLB_KEYCHAIN_ACCOUNT, currentBefore);
        wrotePrevious = true;
      }
      assertNotCompromised(input);
      input.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, currentWritten);
      wroteCurrent = true;
    },
    restoreKeychain: () => {
      // A later adopter may have committed after our write. Compensation is
      // deliberately independent of the lost auth lock: each restoration is
      // a value CAS of bytes this attempt wrote while SQLite excludes QLB
      // adopters.
      let compareAndSetFailed = false;
      if (wroteCurrent) {
        const current = input.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
        if (current === currentWritten) input.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, currentBefore);
        else if (current !== currentBefore) compareAndSetFailed = true;
      }
      if (wrotePrevious) {
        const previous = optionalKeychainValue(input.keychain, previousService);
        if (previous === currentBefore) {
          if (previousBefore === undefined) input.keychain.deleteSync(previousService, QLB_KEYCHAIN_ACCOUNT);
          else input.keychain.setSync(previousService, QLB_KEYCHAIN_ACCOUNT, previousBefore);
        } else if (previous !== previousBefore) {
          compareAndSetFailed = true;
        }
      }
      return !compareAndSetFailed;
    },
  });
  return { action: 'adopt', accountId: input.slot.accountId };
}

/**
 * Attribute a stable native auth.json observation under S56. A malformed or
 * unknown identity is never copied into a managed slot; a known other identity
 * moves active ownership only after applying this same rule to that slot.
 */
export async function attributeLiveDocument(input: AttributeLiveDocumentInput): Promise<CodexAttributionResult> {
  if (!input.live) return { action: 'wiped', accountId: input.slot.accountId };
  const identity = codexIdentity(input.live);
  if (!identity) return { action: 'unclaimed' };

  if (identity === input.slot.accountId) {
    const disposition = await attributeSameSlot(input);
    if (input.activeSlotId && input.activeSlotId !== input.slot.accountId) {
      return { action: 'drift', accountId: input.slot.accountId, disposition: disposition.action };
    }
    return disposition;
  }

  const driftSlot = input.store.getCodexSlotByIdentity(identity);
  if (!driftSlot) return { action: 'unclaimed' };

  const text = input.keychain.getSync(
    qlbKeychainService(PROVIDER, driftSlot.accountId),
    QLB_KEYCHAIN_ACCOUNT,
  );
  const parsed = parseCodexAuth(text);
  if (!parsed.ok) throw new Error('stored Codex slot is malformed');
  const sameInput: AttributeLiveDocumentInput = {
    ...input,
    slot: { accountId: driftSlot.accountId, document: parsed.doc, fingerprint: driftSlot.fingerprint ?? undefined },
  };
  const disposition = await attributeSameSlot(sameInput);
  return { action: 'drift', accountId: driftSlot.accountId, disposition: disposition.action };
}
