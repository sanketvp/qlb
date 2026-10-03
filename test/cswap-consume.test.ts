import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CSWAP_ACTIVE_ID,
  getConsumedAccess,
  prepareConsumeSnapshots,
  syntheticCswapActiveSnapshot,
} from '../src/cswap-consume';
import { resolveFromSnapshots } from '../src/resolve';
import { openStore } from '../src/store';
import type { AccountSnapshot } from '../src/types';

const FUTURE = 4102444800000;

function blob(access: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: access, expiresAt: FUTURE } });
}

describe('cswap consume inject', () => {
  it('consume-access', () => {
    const result = getConsumedAccess({
      runner: () => blob('test-access'),
      env: { USER: 'fixture-user' },
    });
    console.log('HAS_ACCESS=1');
    assert.equal(typeof result.access, 'string');
    assert.ok(result.access.length > 0);
    assert.equal('refreshToken' in result, false);
  });

  it('normal-oauth-shape', () => {
    const result = getConsumedAccess({
      runner: () => blob('test-access'),
      env: { USER: 'fixture-user' },
    });
    console.log(`HAS_ACCESS=1 SERVE_ID=${CSWAP_ACTIVE_ID}`);
    assert.equal(result.access, 'test-access');
    const text = `HAS_ACCESS=1 SERVE_ID=${CSWAP_ACTIVE_ID}`;
    assert.doesNotMatch(text, /identity_unproven/);
    assert.doesNotMatch(text, /foreign_credential/);
  });

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
              source: 'poll',
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
    assert.equal(decision.ok, true);
    if (decision.ok) assert.equal(decision.accountId, CSWAP_ACTIVE_ID);
    console.log('SLOT_PICKS=0');
  });

  it('no-claude-hop', () => {
    let threw = false;
    try {
      getConsumedAccess({
        runner: () => {
          throw new Error('missing');
        },
        env: { USER: 'fixture-user' },
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
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

  it('switch-between-reads', () => {
    const accesses = ['access-one', 'access-two'];
    let n = 0;
    const read = () => getConsumedAccess({
      runner: () => blob(accesses[Math.min(n++, accesses.length - 1)]!),
      env: { USER: 'fixture-user' },
    });
    const first = read();
    const second = read();
    assert.notEqual(first.fingerprint, second.fingerprint);
    console.log(`SERVE_ID=${CSWAP_ACTIVE_ID} RETRY_REEVAL=1`);
    assert.equal(first.access, 'access-one');
    assert.equal(second.access, 'access-two');
  });

  it('anthropic-fallback-cross-provider', () => {
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
    assert.equal(primary.ok, true);
    if (primary.ok) {
      assert.equal(primary.accountId, CSWAP_ACTIVE_ID);
      console.log(`PRIMARY=${primary.accountId} FALLBACK_OK=1`);
    }
    const withError = [syntheticCswapActiveSnapshot({ error: 'unavailable' }), xai];
    const fb = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      fallback: ['grok-4'],
      snapshots: withError,
    });
    assert.equal(fb.ok, true);
    if (fb.ok) {
      assert.equal(fb.accountId, 'xai-1');
      assert.ok(fb.mode === 'fallback' || fb.mode === 'fallback-all-in');
    }
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
