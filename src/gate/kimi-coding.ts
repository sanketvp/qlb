import { GateFailure, type GateCredential, type GateRefreshContext, type ProviderGate } from '../pi-gate';
import { resolve } from '../token/kimi-coding';
import { getStore } from '../store';
import { defaultPiMigratePaths } from '../pi-migrate';
import { recordRelogin } from '../relogin';

/** P13 §4.5: wait for single-consume's persisted winner; never return busy to Pi. */
export function refresh(current?: GateCredential, context?: GateRefreshContext): Promise<ReturnType<typeof resolve>> {
  // Preserve P5's direct-call refusal: only the Pi gate may supply a current
  // credential to enter P13's consume protocol.
  if (!current) throw new GateFailure('not-implemented');
  const audit = context ?? (() => {
    const store = getStore();
    return {
      onLineage: (row: { provider: 'xai' | 'kimi-coding'; fromFp: string; toFp: string }) => store.recordLineage({
        provider: row.provider, accountId: 'default', fromFp: row.fromFp, toFp: row.toFp,
        cause: 'post', by: 'qlb-gate', evidence: 'post',
      }),
      onDead: (provider: 'xai' | 'kimi-coding') => recordRelogin(store, { ts: Date.now(), provider, accountId: 'default', kind: 'dead' }),
    };
  })();
  return import('../single-consume').then(async ({ consumeKimiCodingCredential }) => {
    const credential = await consumeKimiCodingCredential({ access: current.token, expires: current.expiresAt ?? 0 }, {
      store: getStore(),
      p7aJournalPath: defaultPiMigratePaths().journalPath,
      onLineage: audit.onLineage,
      onDead: audit.onDead,
    });
    return {
      token: credential.access,
      accountId: 'default',
      expiresAt: credential.expires,
      source: 'keychain',
    };
  });
}

const gate: ProviderGate = { read: resolve, refresh };

export default gate;
