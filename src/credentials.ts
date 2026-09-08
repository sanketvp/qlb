// Real `getCredentialForAccount` for qlb-proxy.
//
// Reads the QLB-owned grant from Keychain, but ONLY when that provider's
// migration journal is QLB_OWNED (or RETIRED). If the grant has not been
// migrated, this fails closed with a clear error — it never silently reads
// native `auth.json` or guesses.

import type { KeychainBackend } from './keychain';
import { qlbKeychainService } from './keychain';
import {
  ADAPTER_ACCOUNT_IDS,
  migrationStoreNameFor,
} from './migration';
import { parseGrant } from './refresh-lease';
import type { Store } from './store';

const OWNED_OR_LATER = new Set(['QLB_OWNED', 'RETIRED']);

function providerPretty(provider: string | undefined, accountId: string): string {
  if (provider === 'openai-codex' || accountId === 'codex-default' || accountId.startsWith('codex')) {
    return 'Codex';
  }
  if (provider === 'xai' || accountId === 'xai-default' || accountId.startsWith('xai')) {
    return 'xai';
  }
  if (provider === 'kimi-coding' || accountId === 'kimi-default' || accountId.startsWith('kimi')) {
    return 'kimi-coding';
  }
  if (provider === 'anthropic') return 'Anthropic';
  return provider ?? accountId;
}

function guessProvider(accountId: string): string | undefined {
  if (accountId === ADAPTER_ACCOUNT_IDS.xai || accountId.startsWith('xai')) return 'xai';
  if (accountId === ADAPTER_ACCOUNT_IDS['kimi-coding'] || accountId.startsWith('kimi')) {
    return 'kimi-coding';
  }
  if (accountId === ADAPTER_ACCOUNT_IDS['openai-codex'] || accountId.startsWith('codex')) {
    return 'openai-codex';
  }
  return undefined;
}

export function notOwnedError(accountId: string, provider?: string): Error {
  const pretty = providerPretty(provider, accountId);
  return new Error(`${pretty} credential not yet owned by QLB — run migration first`);
}

export function createOwnedCredentialSource(opts: {
  store: Store;
  keychain: KeychainBackend;
}): (accountId: string) => Promise<string> {
  return async (accountId: string): Promise<string> => {
    const acct = opts.store.getAccount(accountId);
    const provider = acct?.provider ?? guessProvider(accountId);
    const storeName = provider ? migrationStoreNameFor(provider) : undefined;
    const state = storeName ? opts.store.getMigration(storeName)?.state : undefined;
    if (!state || !OWNED_OR_LATER.has(state)) {
      throw notOwnedError(accountId, provider);
    }
    if (!acct) {
      throw notOwnedError(accountId, provider);
    }
    const service = qlbKeychainService(acct.provider, acct.id);
    const account = acct.label || acct.id;
    const grant = parseGrant(opts.keychain.getSync(service, account));
    return grant.access;
  };
}
