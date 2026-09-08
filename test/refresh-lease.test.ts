import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import {
  RefreshLease,
  parseGrant,
  type AdapterRefreshFn,
} from '../src/refresh-lease';
import { openStore, refreshLeaseName } from '../src/store';
import type { Grant } from '../src/types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const err = new Error(String(signal.reason ?? 'aborted'));
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        const err = new Error(String(signal.reason ?? 'aborted'));
        err.name = 'AbortError';
        reject(err);
      },
      { once: true },
    );
  });
}

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  everyMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await sleep(everyMs);
  }
}

function nearExpiryGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    access: 'access-old',
    refresh: 'refresh-old',
    expires: Date.now() + 10_000, // within 60s skew → needs refresh
    generation: 0,
    writtenBy: 'seed',
    ...overrides,
  };
}

function farExpiryGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    access: 'access-fresh',
    refresh: 'refresh-fresh',
    expires: Date.now() + 3_600_000,
    generation: 1,
    writtenBy: 'other',
    ...overrides,
  };
}

function seedAccount(
  store: ReturnType<typeof openStore>,
  keychain: MockKeychain,
  id: string,
  grant: Grant,
  provider = 'anthropic',
  label = 'Test Account',
): { service: string; account: string } {
  store.upsertAccount(id, provider, label);
  const service = qlbKeychainService(provider, id);
  const account = label;
  keychain.setSync(service, account, JSON.stringify(grant));
  return { service, account };
}

describe('refresh lease — §4.8.2', () => {
  it('basic refresh: near-expiry grant → refresh once → generation increments → persisted', async () => {
    const store = openStore(':memory:');
    const kc = new MockKeychain();
    const id = 'acct-1';
    const grant = nearExpiryGrant();
    const { service, account } = seedAccount(store, kc, id, grant);

    let calls = 0;
    const refreshFn: AdapterRefreshFn = async (g, { signal }) => {
      calls += 1;
      assert.equal(signal.aborted, false);
      return {
        access: 'access-new',
        refresh: 'refresh-new',
        expires: Date.now() + 3_600_000,
        generation: 99, // adapter's generation is ignored; we stamp gen+1
      };
    };

    const rl = new RefreshLease(store, kc, refreshFn);
    const result = await rl.refreshIfNeeded(id, grant);

    assert.equal(calls, 1);
    assert.equal(result.access, 'access-new');
    assert.equal(result.refresh, 'refresh-new');
    assert.equal(result.generation, 1);
    assert.equal(store.getGrantGeneration(id), 1);
    const persisted = parseGrant(kc.getSync(service, account));
    assert.equal(persisted.access, 'access-new');
    assert.equal(persisted.generation, 1);
    assert.equal(store.getLease(refreshLeaseName(id)), null, 'lease released');
    store.close();
  });

  it('far-from-expiry grant is returned without calling adapterRefreshFn', async () => {
    const store = openStore(':memory:');
    const kc = new MockKeychain();
    const id = 'acct-fresh';
    const grant = farExpiryGrant({ generation: 0, access: 'still-good' });
    seedAccount(store, kc, id, grant);

    let calls = 0;
    const rl = new RefreshLease(store, kc, async () => {
      calls += 1;
      throw new Error('should not refresh');
    });
    const result = await rl.refreshIfNeeded(id, grant);
    assert.equal(calls, 0);
    assert.equal(result.access, 'still-good');
    assert.equal(store.getGrantGeneration(id), 0);
    store.close();
  });

  it('concurrent refresh: N callers → exactly 1 adapterRefreshFn invocation', async () => {
    const store = openStore(':memory:');
    const kc = new MockKeychain();
    const id = 'acct-conc';
    const grant = nearExpiryGrant();
    seedAccount(store, kc, id, grant);

    let calls = 0;
    const refreshFn: AdapterRefreshFn = async (g, { signal }) => {
      calls += 1;
      await abortableSleep(150, signal);
      return {
        access: 'access-once',
        refresh: 'refresh-once',
        expires: Date.now() + 3_600_000,
        generation: g.generation + 1,
      };
    };

    const a = new RefreshLease(store, kc, refreshFn, { waitPollMs: 20 });
    const b = new RefreshLease(store, kc, refreshFn, { waitPollMs: 20 });
    const c = new RefreshLease(store, kc, refreshFn, { waitPollMs: 20 });

    const results = await Promise.all([
      a.refreshIfNeeded(id, grant),
      b.refreshIfNeeded(id, grant),
      c.refreshIfNeeded(id, grant),
    ]);

    assert.equal(calls, 1, `expected 1 refresh HTTP call, got ${calls}`);
    assert.equal(results.length, 3);
    for (const r of results) {
      assert.equal(r.access, 'access-once');
      assert.equal(r.generation, 1);
    }
    assert.equal(store.getGrantGeneration(id), 1);
    store.close();
  });

  it('stale-write fencing: slow refresher does not overwrite a newer committed grant', async () => {
    const store = openStore(':memory:');
    const kc = new MockKeychain();
    const id = 'acct-fence';
    const grant = nearExpiryGrant();
    const { service, account } = seedAccount(store, kc, id, grant);

    const events: string[] = [];
    let release!: () => void;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = false;

    const slowFn: AdapterRefreshFn = async () => {
      inFlight = true;
      await hang;
      return {
        access: 'access-STALE',
        refresh: 'refresh-STALE',
        expires: Date.now() + 3_600_000,
        generation: 1,
        writtenBy: 'slow',
      };
    };

    // Heartbeat far in the future so we exercise step 5 CAS, not the abort path
    // (T-CONC-5: process paused AFTER HTTP returned).
    const slow = new RefreshLease(store, kc, slowFn, {
      heartbeatMs: 60_000,
      hardTimeoutMs: 10_000,
      onEvent: (e) => events.push(e),
    });

    const pSlow = slow.refreshIfNeeded(id, grant);
    await waitUntil(() => inFlight);

    // Simulate the other process committing g1 while the slow one is on the wire.
    const winner = farExpiryGrant({
      access: 'access-WINNER',
      refresh: 'refresh-WINNER',
      generation: 1,
      writtenBy: 'fast',
    });
    kc.setSync(service, account, JSON.stringify(winner));
    store.repairGrantGeneration(id, 0, 1);
    assert.equal(store.getGrantGeneration(id), 1);

    release();
    const result = await pSlow;

    assert.ok(
      events.includes('refresh_fenced') || events.includes('refresh_fenced_keychain'),
      `expected fence event, got ${events.join(',')}`,
    );
    assert.equal(result.access, 'access-WINNER', 'slow writer must return the winner grant');
    assert.equal(result.generation, 1);
    const persisted = parseGrant(kc.getSync(service, account));
    assert.equal(persisted.access, 'access-WINNER');
    assert.equal(persisted.refresh, 'refresh-WINNER');
    assert.notEqual(persisted.access, 'access-STALE');
    store.close();
  });

  it('lease-loss abort: stolen lease aborts the in-flight adapterRefreshFn via AbortSignal', async () => {
    const store = openStore(':memory:');
    const kc = new MockKeychain();
    const id = 'acct-abort';
    const grant = nearExpiryGrant();
    const { service, account } = seedAccount(store, kc, id, grant);

    let seenSignal: AbortSignal | undefined;
    let resolveStarted!: (s: AbortSignal) => void;
    const startedP = new Promise<AbortSignal>((r) => {
      resolveStarted = r;
    });

    const hangFn: AdapterRefreshFn = async (_g, { signal }) => {
      seenSignal = signal;
      resolveStarted(signal);
      await abortableSleep(10_000, signal);
      return farExpiryGrant();
    };

    const rl = new RefreshLease(store, kc, hangFn, {
      heartbeatMs: 40,
      hardTimeoutMs: 8_000,
      waitPollMs: 20,
      waitTimeoutMs: 5_000,
    });

    const p = rl.refreshIfNeeded(id, grant);
    const signal = await startedP;
    await waitUntil(() => store.getLease(refreshLeaseName(id)) != null);

    store.stealLease(refreshLeaseName(id), 'thief');
    await waitUntil(() => signal.aborted, 2000);
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, 'lease_lost_or_generation_moved');
    assert.equal(seenSignal?.aborted, true);

    // Unblock goto-1: thief "committed" a fresh grant (C3-style Keychain ahead
    // also works; here we write both so step 2 returns immediately).
    const thiefGrant = farExpiryGrant({
      access: 'access-thief',
      generation: 1,
      writtenBy: 'thief',
    });
    kc.setSync(service, account, JSON.stringify(thiefGrant));
    store.repairGrantGeneration(id, 0, 1);

    const result = await p;
    assert.equal(result.access, 'access-thief');
    store.close();
  });

  it('crash-simulated repair-on-read (C3): Keychain gen > SQLite gen is repaired, 0 refresh calls', async () => {
    const store = openStore(':memory:');
    const kc = new MockKeychain();
    const id = 'acct-c3';
    // SQLite defaults to grant_generation=0; Keychain holds gen=1 as if we
    // crashed after the Keychain write and before COMMIT.
    const stale = nearExpiryGrant({ generation: 0, access: 'stale-sqlite' });
    const { service, account } = seedAccount(store, kc, id, stale);
    const keychainAhead = farExpiryGrant({
      access: 'access-repaired',
      refresh: 'refresh-repaired',
      generation: 1,
      writtenBy: 'crashed-writer',
    });
    kc.setSync(service, account, JSON.stringify(keychainAhead));
    assert.equal(store.getGrantGeneration(id), 0);

    let calls = 0;
    const events: string[] = [];
    const rl = new RefreshLease(store, kc, async () => {
      calls += 1;
      throw new Error('must not refresh after C3 repair');
    }, {
      onEvent: (e) => events.push(e),
    });

    const result = await rl.refreshIfNeeded(id, stale);
    assert.equal(calls, 0, 'repair-on-read must not issue a refresh HTTP call');
    assert.ok(events.includes('repair_on_read'), `events=${events.join(',')}`);
    assert.equal(result.access, 'access-repaired');
    assert.equal(result.generation, 1);
    assert.equal(store.getGrantGeneration(id), 1, 'journal catches up to Keychain');
    store.close();
  });
});
