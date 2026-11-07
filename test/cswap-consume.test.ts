import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  prepareConsumeSnapshots,
  syntheticCswapActiveSnapshot,
} from '../src/cswap-consume';
import { resolveFromSnapshots } from '../src/resolve';
import { openStore } from '../src/store';
import type { AccountSnapshot } from '../src/types';

describe('cswap consume routing', () => {

  it('no-slot-pick', () => {
    const consumed = prepareConsumeSnapshots(
      [
        {
          accountId: 'cswap-slot-2',
          provider: 'anthropic',
          label: 'better-headroom',
          buckets: {
            '5h': {
              usedPct: 1,
              source: 'provider-poll',
              confidence: 'authoritative',
              fetchedAt: Date.now(),
            },
          },
        },
      ],
      true,
    );
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: consumed,
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.error, 'UNAVAILABLE');
    console.log('SLOT_PICKS=0');
  });

  it('removes Anthropic snapshots without routing a slot', () => {
    const prepared = prepareConsumeSnapshots(
      [
        {
          accountId: 'cswap-slot-2',
          provider: 'anthropic',
          label: 'other',
          buckets: {},
        },
      ],
      true,
    );
    assert.equal(prepared.some((s) => s.accountId === 'cswap-slot-2'), false);
    console.log('NO_HOP=1');
  });

  it('does not route consume mode without a fresh active provider reading', () => {
    const xai: AccountSnapshot = {
      accountId: 'xai-1',
      provider: 'xai',
      label: 'grok',
      buckets: {
        tokens: {
          usedPct: 10,
          source: 'headers',
          confidence: 'authoritative',
          fetchedAt: Date.now(),
        },
      },
    };
    const ok = prepareConsumeSnapshots([xai], true);
    const primary = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      fallback: ['grok-4'],
      snapshots: ok,
    });
    assert.equal(primary.ok, false);
    if (!primary.ok) assert.equal(primary.error, 'UNAVAILABLE');
    const withError = [syntheticCswapActiveSnapshot({ error: 'unavailable' }), xai];
    const fb = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      fallback: ['grok-4'],
      snapshots: withError,
    });
    assert.equal(fb.ok, false);
    if (!fb.ok) assert.equal(fb.error, 'UNAVAILABLE');
  });

  it('non-active-claude-pin', () => {
    const store = openStore(':memory:');
    store.upsertOverride({
      kind: 'pin',
      accountId: 'cswap-slot-2',
      session: 'pin-sess',
      until: Date.now() + 60_000,
    });
    const snapshots = prepareConsumeSnapshots([], true);
    const decision = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      session: 'pin-sess',
      snapshots,
      store,
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.error, 'PINNED_UNAVAILABLE');
    console.log('PINNED_UNAVAILABLE=1');
    store.close();
  });
});
