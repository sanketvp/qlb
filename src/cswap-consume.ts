// Consume Option B: cache is status-only. Never binds a sequence slot.

import { dirname, join } from 'node:path';
import type { AccountSnapshot } from './types';

export const CSWAP_ANTHROPIC_STORE = 'cswap-anthropic';
export const CSWAP_ACTIVE_ID = 'cswap-active';
export const CONSUME_STATE = 'CONSUMED';

/** `qlb consume enable` writes this beside the QLB database; qlb-pi mirrors it. */
export function consumeMarkerPathFor(dbPath: string): string {
  return join(dirname(dbPath), 'consume-anthropic.json');
}

export function isConsumedState(state: string | undefined | null): boolean {
  return state === CONSUME_STATE;
}

export function syntheticCswapActiveSnapshot(
  extra: Partial<AccountSnapshot> = {},
): AccountSnapshot {
  return {
    accountId: CSWAP_ACTIVE_ID,
    provider: 'anthropic',
    label: CSWAP_ACTIVE_ID,
    buckets: {},
    ...extra,
  };
}

/**
 * Provider-level consume arm: replace every Anthropic row with one synthetic
 * `cswap-active` snapshot. Cross-provider rows are unchanged so
 * `resolveFromSnapshots` keeps pin + fallback traversal.
 */
export function prepareConsumeSnapshots(
  snapshots: AccountSnapshot[],
  consumed: boolean,
): AccountSnapshot[] {
  if (!consumed) return snapshots;
  const others = snapshots.filter((s) => s.provider !== 'anthropic');
  return [syntheticCswapActiveSnapshot(), ...others];
}
