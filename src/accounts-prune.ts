// Prune a stale/orphaned account row from the store.
//
// Local metadata only: accounts, snapshots, overrides, poll_claims, and the
// refresh:<id> lease. Never touches credentials, native stores, owner files,
// or decisions/errors. Participants of any trusted MIRRORED / VALIDATED /
// QLB_OWNED / RETIRED journal row are refused, including after rollback
// (post-rollback prune is deferred), as are participants of a NATIVE row whose
// hand-back kept the Keychain copy or is still pending cleanup. Untrusted rows
// and a pending recovery marker refuse globally.

import {
  decodeJournalEvidence,
  parseAccountIds,
  type UntrustedReason,
} from './migration-health';

export interface JournalRow {
  store: string;
  state: string;
  detail_json?: string | null;
}

export interface PruneStore {
  pruneAccountIfUnowned(accountId: string):
    | {
        deleted: true;
        removed: {
          accounts: number;
          snapshots: number;
          overrides: number;
          pollClaims: number;
          leases: number;
        };
      }
    | { deleted: false; reason: string };
  listMigrations(): JournalRow[];
  getAccount(id: string): { provider: string | null } | null;
}

export { parseAccountIds } from './migration-health';
export type { ParseAccountIdsResult } from './migration-health';

export interface AccountOwnershipCheck {
  owned: boolean;
  store?: string;
  state?: string;
  reason?: 'protected' | 'untrusted' | 'recovery_pending';
  token?: string;
}

export type AccountSafety =
  | { unsafe: false }
  | {
      unsafe: true;
      store: string;
      state: string;
      reason: 'protected' | 'untrusted';
      token: string;
    };

/** Distinguish a missing account row from a present row with SQL NULL provider. */
export type ProviderLookup = (id: string) =>
  | { present: false }
  | { present: true; provider: string | null };

/**
 * Decide whether `accountId` is safe to prune given the current journal.
 * First untrusted row fails closed. Then D-ID provider consistency. Then any
 * trusted non-NATIVE row, or NATIVE row that kept its Keychain copy, that
 * names the target protects it. VALIDATED always
 * protects named participants (option A: no receipt/filesystem exception).
 */
export function inspectAccountSafety(
  migrations: JournalRow[],
  accountId: string,
  lookupProvider?: ProviderLookup,
): AccountSafety {
  const decoded: Array<{ row: JournalRow; ev: ReturnType<typeof decodeJournalEvidence> }> = [];
  for (const row of migrations) {
    const ev = decodeJournalEvidence(row);
    decoded.push({ row, ev });
    if (!ev.trusted) {
      return {
        unsafe: true,
        store: row.store,
        state: row.state,
        reason: 'untrusted',
        token: `untrusted:${ev.reason}`,
      };
    }
  }

  if (lookupProvider) {
    for (const { row, ev } of decoded) {
      if (!ev.trusted) continue;
      for (const [id, provider] of ev.providers) {
        const existing = lookupProvider(id);
        if (!existing.present) continue;
        if (existing.provider !== provider) {
          return {
            unsafe: true,
            store: row.store,
            state: row.state,
            reason: 'untrusted',
            token: 'untrusted:provider_mismatch',
          };
        }
      }
    }
  }

  for (const { row, ev } of decoded) {
    if (!ev.trusted) continue;
    if (ev.state === 'NATIVE' && !keepsHandedBackCredential(row)) continue;
    if (ev.participants.has(accountId)) {
      return {
        unsafe: true,
        store: row.store,
        state: ev.state,
        reason: 'protected',
        token: `protected:${ev.state}`,
      };
    }
  }
  return { unsafe: false };
}

/**
 * A post-commit hand-back ends at NATIVE; when it kept the Keychain copy (or its
 * cleanup is still pending), that copy may hold the newest grant, so the
 * account stays protected. Any disposition other than 'delete' reads as keep.
 */
function keepsHandedBackCredential(row: JournalRow): boolean {
  let detail: unknown;
  try {
    detail = JSON.parse(row.detail_json ?? 'null');
  } catch {
    return false;
  }
  if (detail === null || typeof detail !== 'object') return false;
  const { handback, lastRollback } = detail as { handback?: unknown; lastRollback?: unknown };
  if (handback != null) return true;
  if (lastRollback === null || typeof lastRollback !== 'object' || !('keychainDisposition' in lastRollback)) {
    return false;
  }
  return lastRollback.keychainDisposition !== 'delete';
}

export function safetyRefusalMessage(
  _accountId: string,
  safety: Extract<AccountSafety, { unsafe: true }>,
): string {
  return `${safety.token} (store '${safety.store}')`;
}

export function checkAccountOwnership(
  store: PruneStore,
  accountId: string,
): AccountOwnershipCheck {
  const safety = inspectAccountSafety(store.listMigrations(), accountId, (id) => {
    const row = store.getAccount(id);
    if (!row) return { present: false };
    return { present: true, provider: row.provider ?? null };
  });
  if (!safety.unsafe) return { owned: false };
  return {
    owned: true,
    store: safety.store,
    state: safety.state,
    reason: safety.reason,
    token: safety.token,
  };
}

export class PruneRefusedError extends Error {
  readonly exitCode = 2 as const;
  constructor(message: string) {
    super(message);
    this.name = 'PruneRefusedError';
  }
}

export interface PruneAccountOpts {
  accountId: string;
  confirm: boolean;
}

export interface PruneAccountResult {
  ok: true;
  accountId: string;
  removed: {
    accounts: number;
    snapshots: number;
    overrides: number;
    pollClaims: number;
    leases: number;
  };
}

function refuse(message: string): never {
  throw new PruneRefusedError(message);
}

export function pruneAccount(store: PruneStore, opts: PruneAccountOpts): PruneAccountResult {
  const { accountId } = opts;
  if (!accountId) {
    refuse('REFUSED: no_such_account');
  }
  if (opts.confirm !== true) {
    refuse('REFUSED: not_confirmed');
  }
  const outcome = store.pruneAccountIfUnowned(accountId);
  if (!outcome.deleted) {
    refuse(`REFUSED: ${outcome.reason}`);
  }
  return { ok: true, accountId, removed: outcome.removed };
}

export type { UntrustedReason };
