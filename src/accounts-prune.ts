// Prune a stale/orphaned account row from the store.
//
// This is NOT a general-purpose account deletion tool. It exists to clean up
// accounts that are no longer real (e.g. a duplicate ID left behind after a
// native credential file was manually edited) while making it structurally
// impossible to remove an account that QLB currently considers owned or that
// is mid-cutover.
//
// Ownership / participation is determined from the `migrations` journal
// (§4.8.3), not from `accounts.status`. An account is unsafe to prune if it
// appears in the `qlbAccountIds` (or `accounts[].id`) list of any migration
// row whose state is MIRRORED, in-flight VALIDATED, QLB_OWNED, or RETIRED.
// NATIVE after a clean rollback, terminal post-commit-rollback VALIDATED
// (owner file absent — same distinction `qlb doctor` uses), or no migration
// record at all, is safe.
//
// Fail-closed: any error while reading an unsafe-state journal row is treated
// as "owned" (refuse to prune) rather than "safe to prune".

import { config, type QlbConfig } from './config';
import { isStuckMigration } from './migration-health';
import type { MigrationRow, Store } from './store';

export interface AccountOwnershipCheck {
  owned: boolean;
  store?: string;
  state?: string;
  reason?: 'owned' | 'in_flight' | 'untrusted';
}

export type ParseAccountIdsResult =
  | { ok: true; ids: Set<string> }
  | { ok: false };

/**
 * Parse a migration `detail_json` into the set of account IDs it names.
 * Returns `{ ok: false }` on ANY parse failure or wrong-shaped payload —
 * callers must treat that as untrusted, not as "no owned accounts".
 */
export function parseAccountIds(detailJson: string | null | undefined): ParseAccountIdsResult {
  if (detailJson == null || detailJson === '') return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(detailJson);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }
  const detail = parsed as { qlbAccountIds?: unknown; accounts?: unknown };
  const hasQlb = Object.prototype.hasOwnProperty.call(detail, 'qlbAccountIds');
  const hasAccounts = Object.prototype.hasOwnProperty.call(detail, 'accounts');
  if (!hasQlb && !hasAccounts) return { ok: false };

  const ids = new Set<string>();
  if (hasQlb) {
    if (!Array.isArray(detail.qlbAccountIds)) return { ok: false };
    for (const id of detail.qlbAccountIds) {
      if (typeof id !== 'string') return { ok: false };
      ids.add(id);
    }
  }
  if (hasAccounts) {
    if (!Array.isArray(detail.accounts)) return { ok: false };
    for (const account of detail.accounts) {
      if (!account || typeof account !== 'object' || Array.isArray(account)) {
        return { ok: false };
      }
      const id = (account as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0) return { ok: false };
      ids.add(id);
    }
  }
  return { ok: true, ids };
}

const SAFE_STATES = new Set(['NATIVE']);
const IN_FLIGHT_STATES = new Set(['MIRRORED', 'VALIDATED']);
const OWNED_STATES = new Set(['QLB_OWNED', 'RETIRED']);
const UNSAFE_STATES = new Set([...IN_FLIGHT_STATES, ...OWNED_STATES]);

export type AccountSafety =
  | { unsafe: false }
  | { unsafe: true; store: string; state: string; reason: 'owned' | 'in_flight' | 'untrusted' };

/**
 * Decide whether `accountId` is safe to prune given the current journal.
 * Fail-closed: malformed / wrong-shaped detail on any non-NATIVE row, or any
 * unknown state, is treated as unsafe.
 *
 * VALIDATED is overloaded: a completed post-commit rollback (owner file
 * absent) is terminal and safe, matching `isStuckMigration` in diagnostics.
 * A pre-commit / mid-hygiene VALIDATED (owner present or staging) is in-flight.
 */
export function inspectAccountSafety(
  migrations: MigrationRow[],
  accountId: string,
  cfg: QlbConfig = config,
): AccountSafety {
  for (const row of migrations) {
    if (SAFE_STATES.has(row.state)) continue;
    if (row.state === 'VALIDATED' && !isStuckMigration(row, cfg)) continue;
    if (!UNSAFE_STATES.has(row.state)) {
      return { unsafe: true, store: row.store, state: row.state, reason: 'untrusted' };
    }
    const parsed = parseAccountIds(row.detail_json);
    if (!parsed.ok) {
      return { unsafe: true, store: row.store, state: row.state, reason: 'untrusted' };
    }
    if (parsed.ids.has(accountId)) {
      return {
        unsafe: true,
        store: row.store,
        state: row.state,
        reason: IN_FLIGHT_STATES.has(row.state) ? 'in_flight' : 'owned',
      };
    }
  }
  return { unsafe: false };
}

export function safetyRefusalMessage(
  accountId: string,
  safety: Extract<AccountSafety, { unsafe: true }>,
): string {
  if (safety.reason === 'untrusted') {
    return (
      `account '${accountId}' cannot be proven unowned ` +
      `(unreadable migration journal for store '${safety.store}', state ${safety.state}); will not prune`
    );
  }
  if (safety.reason === 'in_flight') {
    return (
      `account '${accountId}' is participating in an in-flight migration ` +
      `(via store '${safety.store}', state ${safety.state}); will not prune`
    );
  }
  return (
    `account '${accountId}' is QLB_OWNED (via store '${safety.store}', ` +
    `state ${safety.state}); will not prune a real owned account`
  );
}

/**
 * Is `accountId` unsafe to prune (owned, in-flight, or untrusted journal)?
 * Fail-closed: any error while reading an unsafe-state journal is treated as
 * "owned" (refuse to prune) rather than "safe to prune".
 *
 * The live prune path does not use this helper for the delete decision —
 * `Store.pruneAccountIfUnowned` re-runs the same inspection inside the
 * delete's BEGIN IMMEDIATE so a concurrent journal commit cannot sneak in.
 */
export function checkAccountOwnership(store: Store, accountId: string): AccountOwnershipCheck {
  const safety = inspectAccountSafety(store.listMigrations(), accountId);
  if (!safety.unsafe) return { owned: false };
  return {
    owned: true,
    store: safety.store,
    state: safety.state,
    reason: safety.reason,
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

/**
 * Remove an account's rows from `accounts`, `snapshots`, `overrides`,
 * `poll_claims`, and the account's refresh lease. Refuses if the account
 * does not exist, is currently QLB_OWNED / RETIRED / in-flight (MIRRORED or
 * pre-commit VALIDATED), has an unreadable journal, or `--confirm` was not passed.
 * A completed post-commit-rollback VALIDATED (owner file absent) is not in-flight.
 * `decisions` rows are left alone — they are audit history, not live state.
 *
 * Existence + journal inspection + cascade delete run in ONE BEGIN IMMEDIATE
 * (see `Store.pruneAccountIfUnowned`) so a concurrent process cannot commit
 * QLB_OWNED between the check and the delete.
 */
export function pruneAccount(store: Store, opts: PruneAccountOpts): PruneAccountResult {
  const { accountId } = opts;
  if (!accountId) {
    refuse('REFUSED: --account is required');
  }
  if (opts.confirm !== true) {
    refuse('REFUSED: --confirm is required to prune an account (this deletes rows permanently)');
  }
  const outcome = store.pruneAccountIfUnowned(accountId);
  if (!outcome.deleted) {
    refuse(`REFUSED: ${outcome.reason}`);
  }
  return { ok: true, accountId, removed: outcome.removed };
}
