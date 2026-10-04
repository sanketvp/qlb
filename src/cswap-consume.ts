// Consume Option B: serve the request-time active Claude Code access as
// unattributed `cswap-active`. Cache is status-only. Never binds a sequence slot.
// Never submits a refresh token. Never writes Keychain.

import { dirname, join } from 'node:path';
import type { AccountSnapshot } from './types';
import {
  fingerprintAccess,
  getActiveClaudeCodeAccess,
  type ConsumedAccess,
  type SecurityRunner,
} from './cswap-native-read';

export const CSWAP_ANTHROPIC_STORE = 'cswap-anthropic';
export const CSWAP_ACTIVE_ID = 'cswap-active';
export const CONSUME_STATE = 'CONSUMED';

export { fingerprintAccess };
export type { ConsumedAccess };

export interface ConsumeReadOpts {
  runner?: SecurityRunner;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}

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

export function getConsumedAccess(opts: ConsumeReadOpts = {}): ConsumedAccess {
  return getActiveClaudeCodeAccess(opts);
}

export function consumedAccessString(opts: ConsumeReadOpts = {}): string {
  return getConsumedAccess(opts).access;
}

export function resyncConsumedAccess(
  previousFingerprint: string,
  opts: ConsumeReadOpts = {},
): { resynced: boolean; reason: string } {
  try {
    const next = getConsumedAccess(opts);
    if (next.fingerprint !== previousFingerprint) {
      return { resynced: true, reason: 'cswap-active access fingerprint changed' };
    }
    return { resynced: false, reason: 'cswap-active access fingerprint unchanged' };
  } catch {
    return { resynced: false, reason: 'cswap-active re-get failed' };
  }
}
