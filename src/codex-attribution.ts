// S56 Codex native-document attribution. Codex has no inter-process lock, so
// observations extend the lineage graph rather than rejecting ordinary rotations.

import { authTime, codexFingerprint, codexIdentity, parseCodexAuth, type CodexAuthDocument } from './codex-auth';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from './keychain';
import { externalLoginCheck, isSuccessor, type HolderObservation } from './lineage-log';
import type { Store } from './store';

const PROVIDER = 'openai-codex';

type Keychain = Pick<KeychainBackend, 'getSync' | 'setSync'>;

export type CodexAttributionAction = 'noop' | 'republish-slot' | 'adopt' | 'drift' | 'unclaimed' | 'wiped';

export interface ManagedCodexDocument {
  /** S29 composite identity of the managed slot. */
  accountId: string;
  document: CodexAuthDocument;
}

export interface AttributeLiveDocumentInput {
  store: Store;
  keychain: Keychain;
  slot: ManagedCodexDocument;
  /** `null` is the stable-reader's tokens-empty/wiped result. */
  live: CodexAuthDocument | null;
  /** Holder facts around the two observations, injected by the session watcher. */
  holderObservation?: HolderObservation;
  /** C1c/X1 established that Codex's `auth_time` claim has its documented meaning. */
  l40Verified?: boolean;
  now?: () => number;
  /** Caller-owned atomic auth.json publication; injected for fixture-only tests. */
  republish?: (document: CodexAuthDocument) => Promise<void> | void;
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

async function attributeSameSlot(input: AttributeLiveDocumentInput): Promise<CodexAttributionResult & {
  action: Exclude<CodexAttributionAction, 'drift'>;
}> {
  const slotFp = codexFingerprint(input.slot.document);
  const live = input.live;
  if (!live) return { action: 'wiped', accountId: input.slot.accountId };

  const liveFp = codexFingerprint(live);
  if (slotFp === liveFp) return { action: 'noop', accountId: input.slot.accountId };

  // The only leave-equivalent: QLB saved the successor but failed before the
  // auth.json rename, so the managed slot must be published back to Codex.
  if (isSuccessor(input.store, PROVIDER, input.slot.accountId, liveFp, slotFp)) {
    await input.republish?.(input.slot.document);
    return { action: 'republish-slot', accountId: input.slot.accountId };
  }

  const service = qlbKeychainService(PROVIDER, input.slot.accountId);
  input.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(input.slot.document));
  input.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(live));
  input.store.adoptCodexSlot({
    accountId: input.slot.accountId,
    previousFingerprint: slotFp,
    fingerprint: liveFp,
    lastRefresh: live.last_refresh ?? null,
    ts: (input.now ?? Date.now)(),
    evidence: evidenceFor(input.holderObservation),
    reloginEvidence: reloginEvidence(slotFp, live, input),
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

  if (identity === input.slot.accountId) return attributeSameSlot(input);

  const driftSlot = input.store.getCodexSlotByIdentity(identity);
  if (!driftSlot) return { action: 'unclaimed' };

  const text = input.keychain.getSync(
    qlbKeychainService(PROVIDER, driftSlot.accountId),
    QLB_KEYCHAIN_ACCOUNT,
  );
  const parsed = parseCodexAuth(text);
  if (!parsed.ok) throw new Error('stored Codex slot is malformed');
  const sameInput: AttributeLiveDocumentInput = { ...input, slot: { accountId: driftSlot.accountId, document: parsed.doc } };
  const disposition = await attributeSameSlot(sameInput);
  input.store.setCodexActiveLogin(driftSlot.accountId, (input.now ?? Date.now)());
  return { action: 'drift', accountId: driftSlot.accountId, disposition: disposition.action };
}
