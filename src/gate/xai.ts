import { resolve, type TokenResolution } from '../token/xai';
import type { GateCredential, GateRefreshContext, ProviderGate } from '../pi-gate';
import { getStore } from '../store';
import { defaultPiMigratePaths } from '../pi-migrate';
import { recordRelogin } from '../relogin';

export interface XaiGateDeps {
  /** Injectable for tests; production resolves through P6's Keychain-backed resolver. */
  resolve?: () => TokenResolution;
}

/**
 * Read the current xAI access token. Refresh ownership moves to P13's
 * single-consume gate; this module intentionally does no direct refresh.
 */
export function read(deps: XaiGateDeps = {}): GateCredential {
  const credential = (deps.resolve ?? resolve)();
  return {
    token: credential.token,
    accountId: credential.accountId,
    ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    source: credential.source,
  };
}

/** P13 §4.5: wait for single-consume's persisted winner; never return busy to Pi. */
export async function refresh(current?: GateCredential, context?: GateRefreshContext): Promise<GateCredential> {
  if (!current) throw new Error('credential-unavailable');
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
  const { consumeXaiCredential } = await import('../single-consume');
  const credential = await consumeXaiCredential({ access: current.token, expires: current.expiresAt ?? 0 }, {
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
}

const gate: ProviderGate = { read, refresh };
export default gate;
