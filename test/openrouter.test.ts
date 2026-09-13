import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createOpenRouterAdapter,
  type OpenRouterAdapterDeps,
} from '../src/adapters/openrouter';
import { resolveFromSnapshots } from '../src/resolve';
import { providerForModel } from '../src/scoring';
import { openStore } from '../src/store';
import type { AccountSnapshot, BucketReading } from '../src/types';

const directFetch: NonNullable<OpenRouterAdapterDeps['fetchAndCacheFn']> = async (
  _accountId: string,
  fetcher: () => Promise<Record<string, BucketReading>>,
) => fetcher();

function adapterWith(
  overrides: OpenRouterAdapterDeps = {},
): ReturnType<typeof createOpenRouterAdapter> {
  return createOpenRouterAdapter({
    readKey: async () => 'test-openrouter-key',
    fetchAndCacheFn: directFetch,
    upsertAccount: () => {},
    now: () => 1_725_000_000_000,
    ...overrides,
  });
}

describe('OpenRouter adapter', () => {
  it('maps the live /credits response shape to an authoritative credit bucket', async () => {
    let authorization: string | null = null;
    const adapter = adapterWith({
      fetchFn: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        return new Response(
          JSON.stringify({
            data: { total_credits: 100, total_usage: 39.866197439 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const snapshots = await adapter.fetchSnapshots();

    assert.equal(authorization, 'Bearer test-openrouter-key');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.accountId, 'openrouter-default');
    assert.equal(snapshots[0]?.provider, 'openrouter');
    assert.equal(snapshots[0]?.error, undefined);
    assert.deepEqual(snapshots[0]?.buckets.credits, {
      usedPct: 39.866197439,
      used: 39.866197439,
      limit: 100,
      remaining: 60.133802561,
      source: 'poll',
      confidence: 'authoritative',
      fetchedAt: 1_725_000_000_000,
      detail:
        'OpenRouter account-wide credit balance from /api/v1/credits; not a rolling request/token rate-limit window',
    });
    assert.equal(providerForModel('z-ai/glm-5.3'), 'openrouter');
    assert.equal(providerForModel('openrouter/anthropic/claude-sonnet-4'), 'openrouter');
  });

  it('returns an empty error snapshot when the Keychain key is missing', async () => {
    let fetched = false;
    const adapter = adapterWith({
      readKey: async () => {
        throw new Error(
          'OpenRouter key not found in macOS Keychain (service pi-openrouter)',
        );
      },
      fetchFn: async () => {
        fetched = true;
        return new Response('{}');
      },
    });

    const snapshots = await adapter.fetchSnapshots();

    assert.equal(fetched, false);
    assert.deepEqual(snapshots, [
      {
        accountId: 'openrouter-default',
        provider: 'openrouter',
        label: 'OpenRouter',
        buckets: {},
        error: 'OpenRouter key not found in macOS Keychain (service pi-openrouter)',
      },
    ]);
  });

  it('returns an empty error snapshot for a malformed credits response', async () => {
    const adapter = adapterWith({
      fetchFn: async () =>
        new Response(JSON.stringify({ data: { total_credits: 100 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const snapshots = await adapter.fetchSnapshots();

    assert.deepEqual(snapshots, [
      {
        accountId: 'openrouter-default',
        provider: 'openrouter',
        label: 'OpenRouter',
        buckets: {},
        error: 'malformed response from credits endpoint',
      },
    ]);
  });

  it('cached-after-failure returning cached buckets still sets snapshot.error', async () => {
    const cached: Record<string, BucketReading> = {
      credits: {
        usedPct: 10,
        used: 10,
        limit: 100,
        remaining: 90,
        source: 'poll',
        confidence: 'authoritative',
        fetchedAt: 1,
      },
    };
    const adapter = adapterWith({
      fetchFn: async () => new Response('denied', { status: 401 }),
      fetchAndCacheFn: async (_accountId, fetcher, opts) => {
        try {
          return await fetcher();
        } catch (err) {
          opts?.onOutcome?.(
            'cached-after-failure',
            err instanceof Error ? err.message : String(err),
          );
          return cached;
        }
      },
    });

    const snapshots = await adapter.fetchSnapshots();
    assert.equal(snapshots.length, 1);
    assert.ok(snapshots[0]?.error);
    assert.match(snapshots[0]?.error ?? '', /credits endpoint returned HTTP 401/);
    assert.equal(snapshots[0]?.probe?.outcome, 'cached-after-failure');
    assert.deepEqual(snapshots[0]?.buckets, {});
  });

  it('cached-after-failure OpenRouter account is not selected when a healthy alternative exists', async () => {
    const store = openStore(':memory:');
    const credits = (usedPct: number): BucketReading => ({
      usedPct,
      source: 'poll',
      confidence: 'authoritative',
      fetchedAt: Date.now(),
    });
    const failed: AccountSnapshot = {
      accountId: 'openrouter-default',
      provider: 'openrouter',
      label: 'OpenRouter',
      buckets: { credits: credits(10) },
      error: 'credits endpoint returned HTTP 401',
      probe: { outcome: 'cached-after-failure', detail: 'credits endpoint returned HTTP 401' },
    };
    const healthy: AccountSnapshot = {
      accountId: 'openrouter-healthy',
      provider: 'openrouter',
      label: 'OpenRouter healthy',
      buckets: { credits: credits(5) },
    };
    const decision = resolveFromSnapshots({
      model: 'openrouter/auto',
      snapshots: [failed, healthy],
      store,
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.accountId, 'openrouter-healthy');
    store.close();
  });
});
