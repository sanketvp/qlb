import { consumeKimiCodingCredential } from '../single-consume';
import { resolve } from '../token/kimi-coding';
import type { GateCredential } from '../pi-gate';
import { SINGLE_ACCOUNT_FRESHEN_MS } from './xai';
import { getStore, type Store } from '../store';
import { recordRelogin } from '../relogin';

export interface KimiCodingAutoDeps {
  now?: () => number;
  read?: () => GateCredential;
  refresh?: () => Promise<GateCredential>;
  store?: Pick<Store, 'recordLineage' | 'recordRelogin'>;
}

/** P13 §4.5: pre-refresh Kimi Coding only at or inside the ten-minute horizon. */
export async function refreshKimiCodingIfDue(deps: KimiCodingAutoDeps = {}): Promise<{ refreshed: boolean; credential: GateCredential }> {
  const credential = (deps.read ?? resolve)();
  const now = (deps.now ?? Date.now)();
  // D-B55: an unknown expiry is immediately due, matching single-consume.
  if (credential.expiresAt !== undefined && credential.expiresAt - now > SINGLE_ACCOUNT_FRESHEN_MS) {
    return { refreshed: false, credential };
  }
  const refreshed = await (deps.refresh ?? (async () => {
    const store = deps.store ?? getStore();
    const current = await consumeKimiCodingCredential({ access: credential.token, expires: credential.expiresAt ?? 0 }, {
      dueWithinMs: SINGLE_ACCOUNT_FRESHEN_MS,
      onLineage: (row) => store.recordLineage({
        provider: row.provider, accountId: 'default', fromFp: row.fromFp, toFp: row.toFp,
        cause: 'post', by: 'qlb-auto', evidence: 'post',
      }),
      onDead: (provider) => recordRelogin(store, { ts: now, provider, accountId: 'default', kind: 'dead' }),
    });
    return { token: current.access, accountId: 'default', expiresAt: current.expires, source: 'keychain' };
  }))();
  return { refreshed: true, credential: refreshed };
}

export default { refreshIfDue: refreshKimiCodingIfDue };
