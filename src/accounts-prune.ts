// Prune a stale/orphaned account row from the store.
//
// This is NOT a general-purpose account deletion tool. It exists to clean up
// accounts that are no longer real (e.g. a duplicate ID left behind after a
// native credential file was manually edited) while making it structurally
// impossible to remove an account that QLB currently considers QLB_OWNED.
//
// Ownership is determined from the `migrations` journal (§4.8.3), not from
// `accounts.status` — a store can be QLB_OWNED while its detail_json still
// lists the specific account IDs that were migrated. An account counts as
// "QLB_OWNED" if it appears in the `qlbAccountIds` (or `accounts[].id`) list
// of any migration row whose state is QLB_OWNED or RETIRED.

import type { Store } from './store';

export interface AccountOwnershipCheck {
  owned: boolean;
  store?: string;
  state?: string;
}

function parseAccountIds(detailJson: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!detailJson) return ids;
  try {
    const parsed: unknown = JSON.parse(detailJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ids;
    const detail = parsed as {
      qlbAccountIds?: unknown;
      accounts?: Array<{ id?: unknown }>;
    };
    if (Array.isArray(detail.qlbAccountIds)) {
      for (const id of detail.qlbAccountIds) {
        if (typeof id === 'string') ids.add(id);
      }
    }
    if (Array.isArray(detail.accounts)) {
      for (const account of detail.accounts) {
        if (account && typeof account.id === 'string') ids.add(account.id);
      }
    }
  } catch {
    // malformed journal detail — treat as no known owned accounts
  }
  return ids;
}

const OWNED_STATES = new Set(['QLB_OWNED', 'RETIRED']);

/**
 * Is `accountId` part of the migrated/owned account set for any store in
 * QLB_OWNED or RETIRED state? Fail-closed: any error while reading the
 * journal is treated as "owned" (refuse to prune) rather than "safe to
 * prune".
 */
export function checkAccountOwnership(store: Store, accountId: string): AccountOwnershipCheck {
  const migrations = store.listMigrations();
  for (const row of migrations) {
    if (!OWNED_STATES.has(row.state)) continue;
    const ids = parseAccountIds(row.detail_json);
    if (ids.has(accountId)) {
      return { owned: true, store: row.store, state: row.state };
    }
  }
  return { owned: false };
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
  };
}

function refuse(message: string): never {
  throw new Error(message);
}

/**
 * Remove an account's rows from `accounts`, `snapshots`, `overrides`, and
 * `poll_claims`. Refuses if the account does not exist, is currently
 * QLB_OWNED (per the migrations journal), or `--confirm` was not passed.
 * `decisions` rows are left alone \u2014 they are audit history, not live state.
 */
export function pruneAccount(store: Store, opts: PruneAccountOpts): PruneAccountResult {
  const { accountId } = opts;
  if (!accountId) {
    refuse('REFUSED: --account is required');
  }
  const account = store.getAccount(accountId);
  if (!account) {
    refuse(`REFUSED: no account found with id '${accountId}'`);
  }
  const ownership = checkAccountOwnership(store, accountId);
  if (ownership.owned) {
    refuse(
      `REFUSED: account '${accountId}' is QLB_OWNED (via store '${ownership.store}', ` +
        `state ${ownership.state}); will not prune a real owned account`,
    );
  }
  if (opts.confirm !== true) {
    refuse('REFUSED: --confirm is required to prune an account (this deletes rows permanently)');
  }
  const removed = store.deleteAccountCascade(accountId);
  return { ok: true, accountId, removed };
}
