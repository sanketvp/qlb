// Fenced generation CAS + heartbeat lease protocol (§4.8.2).
//
// Two mechanisms with distinct jobs:
//   - Generation is the CORRECTNESS mechanism. Every write of a refreshed grant
//     is a compare-and-swap on accounts.grant_generation, evaluated INSIDE the
//     same SQLite BEGIN IMMEDIATE that performs the Keychain write. A refresh
//     computed from g0 can never land after another process committed g1.
//   - The lease is only a DE-DUPLICATION mechanism (avoid N concurrent refresh
//     HTTP calls). Bounded (15s), heartbeat-renewed every 5s; losing it aborts
//     the in-flight HTTP call via AbortController. Correctness NEVER depends
//     on the lease — step 5 always re-verifies generation regardless of lease
//     state.
//
// Crash analysis (must match spec C1–C4 exactly):
//   C1  before step 4 (HTTP)          → lease lapses in 15s (no heartbeat);
//                                       next caller takes over; nothing lost.
//   C2  during step 4 after provider  → rotated refresh token never persisted;
//       consumed the token, before     next refresher gets invalid_grant with
//       local persist                  generation unchanged → auth_revoked
//                                       (residual R9, one HTTP round-trip).
//                                       If generation DID move, invalid_grant
//                                       is a lost race, not revocation.
//   C3  inside step 5 after Keychain  → SQLite rolls back: Keychain says
//       write, before COMMIT           gen+1, journal says gen. Next reader's
//                                       step 1 repairs the journal (kgen > gen)
//                                       and step 2 returns the fresh token —
//                                       no refresh, no loss. This is why step 6
//                                       never jumps straight to step 3.
//   C4  after COMMIT                  → done, fully consistent.
//
// `me` is per-operation (`${processUuid}:${opId}`), matching the v6 poll_claims
// fix: two concurrent async callers in one process must not share a holder id
// or the second would treat the first's live lease as its own and issue a
// duplicate refresh.

import { randomUUID } from 'node:crypto';
import type { KeychainBackend } from './keychain';
import { qlbKeychainService } from './keychain';
import {
  refreshLeaseName,
  type Store,
} from './store';
import { QlbError, type Grant } from './types';

const PROCESS_UUID = randomUUID();

export const DEFAULT_LEASE_TTL_MS = 15_000;
export const DEFAULT_HEARTBEAT_MS = 5_000;
export const DEFAULT_HARD_TIMEOUT_MS = 45_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_WAIT_POLL_MS = 100;
export const DEFAULT_EXPIRY_SKEW_MS = 60_000;
const MAX_OUTER_ATTEMPTS = 32;

/**
 * Per-provider OAuth refresh call.
 *
 * CANCELLATION IS CONTRACTUAL, NOT OPTIONAL/ADVISORY. The implementation MUST
 * accept `opts.signal` and MUST stop promptly when it aborts — typically by
 * passing the signal to `fetch()`. Ignoring the signal means a lost lease
 * cannot abort an in-flight HTTP call, which is a protocol violation (§4.8.2
 * step 4). When aborted, reject (e.g. DOMException AbortError) rather than
 * returning a grant.
 */
export type AdapterRefreshFn = (
  grant: Grant,
  opts: { signal: AbortSignal },
) => Promise<Grant>;

export interface RefreshLeaseOpts {
  leaseTtlMs?: number;
  heartbeatMs?: number;
  hardTimeoutMs?: number;
  waitTimeoutMs?: number;
  waitPollMs?: number;
  expirySkewMs?: number;
  onEvent?: (event: string, detail?: unknown) => void;
}

export function parseGrant(raw: string): Grant {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid grant JSON');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.access !== 'string' || typeof obj.refresh !== 'string') {
    throw new Error('invalid grant: access/refresh required');
  }
  const extra =
    obj.extra && typeof obj.extra === 'object'
      ? (obj.extra as Record<string, unknown>)
      : undefined;
  const grant: Grant = {
    access: obj.access,
    refresh: obj.refresh,
    expires: Number(obj.expires) || 0,
    generation: Number(obj.generation) || 0,
  };
  if (typeof obj.writtenBy === 'string') grant.writtenBy = obj.writtenBy;
  if (extra) grant.extra = extra;
  return grant;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function isAuthRevoked(err: unknown): boolean {
  if (err instanceof QlbError) {
    return err.kind === 'auth_revoked' || err.kind === 'invalid_grant';
  }
  if (err && typeof err === 'object' && 'kind' in err) {
    const kind = (err as { kind?: string }).kind;
    if (kind === 'auth_revoked' || kind === 'invalid_grant') return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid_grant/i.test(msg);
}

function keychainCoords(account: { id: string; provider: string; label: string }): {
  service: string;
  account: string;
} {
  return {
    service: qlbKeychainService(account.provider, account.id),
    account: account.label || account.id,
  };
}

export class RefreshLease {
  private readonly store: Store;
  private readonly keychain: KeychainBackend;
  private readonly adapterRefreshFn: AdapterRefreshFn;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly hardTimeoutMs: number;
  private readonly waitTimeoutMs: number;
  private readonly waitPollMs: number;
  private readonly expirySkewMs: number;
  private readonly onEvent?: (event: string, detail?: unknown) => void;

  constructor(
    store: Store,
    keychain: KeychainBackend,
    adapterRefreshFn: AdapterRefreshFn,
    opts: RefreshLeaseOpts = {},
  ) {
    this.store = store;
    this.keychain = keychain;
    this.adapterRefreshFn = adapterRefreshFn;
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.hardTimeoutMs = opts.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
    this.waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.waitPollMs = opts.waitPollMs ?? DEFAULT_WAIT_POLL_MS;
    this.expirySkewMs = opts.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;
    this.onEvent = opts.onEvent;
  }

  /**
   * §4.8.2 `getAccessToken` protocol. Returns the current (possibly refreshed)
   * grant. `currentGrant` is used only to bootstrap an empty Keychain item;
   * the Keychain payload is always re-read at step 1 (never write from an
   * in-memory copy — the pool-store.ts read-modify-write pattern is retired).
   */
  async refreshIfNeeded(accountId: string, currentGrant: Grant): Promise<Grant> {
    this.bootstrapIfMissing(accountId, currentGrant);

    for (let attempt = 0; attempt < MAX_OUTER_ATTEMPTS; attempt++) {
      // Step 1 — read Keychain + journal; repair-on-read for C3.
      const { grant, gen, service, accountName } = this.readAndRepair(accountId);

      // Step 2 — fast path, no lock.
      if (grant.expires - Date.now() > this.expirySkewMs) {
        return grant;
      }

      // Step 3 — acquire lease (or discover stale gen / other holder).
      const me = `${PROCESS_UUID}:${randomUUID()}`;
      const acquired = this.store.acquireRefreshLease(
        accountId,
        me,
        process.pid,
        gen,
        this.leaseTtlMs,
      );
      if (acquired === 'stale_gen') continue; // goto 1
      if (acquired === 'busy') {
        // Step 6 — wait, then ALWAYS goto 1 (never goto 3).
        const waited = await this.waitForRefresh(accountId, gen);
        if (waited === 'timeout') {
          throw new QlbError({
            kind: 'store_unavailable',
            store: 'keychain',
            detail: 'refresh lease timeout',
          });
        }
        continue;
      }

      // Step 4 — HTTP outside any txn, heartbeat + hard timeout abort.
      const ac = new AbortController();
      const hbTimer = setInterval(() => {
        const ok = this.store.heartbeatRefreshLease(
          accountId,
          me,
          gen,
          this.leaseTtlMs,
        );
        if (!ok) {
          ac.abort('lease_lost_or_generation_moved');
        }
      }, this.heartbeatMs);
      const hard = setTimeout(() => {
        ac.abort('refresh_hard_timeout');
      }, this.hardTimeoutMs);

      let gPrime: Grant | undefined;
      let aborted = false;
      let authRevoked = false;
      let otherErr: unknown;

      try {
        const refreshed = await this.adapterRefreshFn(grant, { signal: ac.signal });
        if (ac.signal.aborted) {
          aborted = true;
        } else {
          // Generation/writtenBy are ours, not the adapter's. A naive adapter
          // that only returns {access, refresh, expires} still fences correctly.
          gPrime = {
            ...refreshed,
            generation: gen + 1,
            writtenBy: me,
          };
        }
      } catch (err) {
        if (ac.signal.aborted || isAbortError(err)) {
          aborted = true;
        } else if (isAuthRevoked(err)) {
          authRevoked = true;
        } else {
          otherErr = err;
        }
      } finally {
        clearInterval(hbTimer);
        clearTimeout(hard);
      }

      if (aborted) {
        // on abort → release lease; discard g'; goto 1
        this.store.releaseRefreshLease(accountId, me);
        this.onEvent?.('lease_lost_or_aborted', {
          accountId,
          reason: ac.signal.reason,
        });
        continue;
      }
      if (authRevoked) {
        const lostRace = this.store.handleAuthRevoked(accountId, me, gen);
        if (lostRace) {
          this.onEvent?.('invalid_grant_lost_race', { accountId, gen });
          continue; // LOST RACE, not revoked
        }
        throw new QlbError({
          kind: 'auth_revoked',
          detail: 'invalid_grant with generation unchanged',
        });
      }
      if (otherErr) {
        this.store.releaseRefreshLease(accountId, me);
        throw otherErr;
      }
      if (!gPrime) {
        this.store.releaseRefreshLease(accountId, me);
        throw new Error('refresh returned no grant');
      }
      const toWrite: Grant = gPrime;

      // Step 5 — THE FENCED WRITE. Keychain write is sync, inside the txn.
      const outcome = this.store.runImmediate(() => {
        if (this.store.getGrantGeneration(accountId) !== gen) {
          return 'fenced' as const;
        }
        let k: Grant;
        try {
          k = parseGrant(this.keychain.getSync(service, accountName));
        } catch {
          return 'fenced_keychain' as const;
        }
        if (k.generation !== gen) {
          return 'fenced_keychain' as const;
        }
        this.keychain.setSync(service, accountName, JSON.stringify(toWrite));
        const n = this.store.bumpGrantGeneration(accountId, gen);
        if (n !== 1) return 'fenced' as const;
        this.store.deleteLeaseIfHolder(refreshLeaseName(accountId), me);
        return 'committed' as const;
      });

      if (outcome === 'fenced') {
        this.onEvent?.('refresh_fenced', { accountId, gen });
        continue; // discard g'; goto 1
      }
      if (outcome === 'fenced_keychain') {
        this.onEvent?.('refresh_fenced_keychain', { accountId, gen });
        continue;
      }
      return toWrite;
    }

    throw new QlbError({
      kind: 'store_unavailable',
      store: 'keychain',
      detail: 'refresh retry limit exceeded',
    });
  }

  /**
   * Step 1. If Keychain generation is ahead of the journal (C3: crash after
   * Keychain write, before COMMIT), repair the journal and proceed. If the
   * Keychain is behind, throw — that is a restored-from-backup situation.
   */
  private readAndRepair(accountId: string): {
    grant: Grant;
    gen: number;
    service: string;
    accountName: string;
  } {
    const acct = this.store.getAccount(accountId);
    if (!acct) {
      throw new QlbError({
        kind: 'store_unavailable',
        detail: `unknown account ${accountId}`,
      });
    }
    const { service, account: accountName } = keychainCoords(acct);
    const grant = parseGrant(this.keychain.getSync(service, accountName));
    const kgen = grant.generation;
    let gen = this.store.getGrantGeneration(accountId);
    if (gen === null) {
      throw new QlbError({
        kind: 'store_unavailable',
        detail: `unknown account ${accountId}`,
      });
    }
    if (kgen > gen) {
      this.store.repairGrantGeneration(accountId, gen, kgen);
      this.onEvent?.('repair_on_read', { accountId, from: gen, to: kgen });
      gen = kgen;
    } else if (kgen < gen) {
      throw new QlbError({
        kind: 'store_unavailable',
        store: 'keychain',
        detail: 'keychain older than journal',
      });
    }
    return { grant, gen, service, accountName };
  }

  private bootstrapIfMissing(accountId: string, fallback: Grant): void {
    const acct = this.store.getAccount(accountId);
    if (!acct) {
      throw new QlbError({
        kind: 'store_unavailable',
        detail: `unknown account ${accountId}`,
      });
    }
    const { service, account } = keychainCoords(acct);
    try {
      this.keychain.getSync(service, account);
    } catch {
      this.keychain.setSync(service, account, JSON.stringify(fallback));
    }
  }

  private async waitForRefresh(
    accountId: string,
    gen: number,
  ): Promise<'advanced' | 'expired' | 'timeout'> {
    const start = Date.now();
    while (Date.now() - start < this.waitTimeoutMs) {
      await sleep(this.waitPollMs);
      const current = this.store.getGrantGeneration(accountId);
      if (current != null && current > gen) return 'advanced';
      const lease = this.store.getLease(refreshLeaseName(accountId));
      if (!lease || lease.until <= Date.now()) return 'expired';
    }
    return 'timeout';
  }
}
