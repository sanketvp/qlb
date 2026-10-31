import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { isCredentialNotFound } from '../credential-backends';
import type { DoctorCheck } from '../diagnostics';
import { qlbHomeDir } from '../home';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from '../keychain';
import { listStashes } from '../unclaimed-index';
import { check } from './_check';

export default check('stash:libsecret', 'stash:libsecret');

const SINGLE_STASH_PROVIDERS = ['xai', 'kimi-coding'] as const;

async function fallbackBodyIsReadable(root: string, provider: string, stashId: string): Promise<boolean> {
  try {
    const handle = await open(join(root, provider, `${stashId}.json`), 'r');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * libsecret's secret-tool reports both a locked keyring and an absent item as
 * operational errors. Match single-stash's fail-closed read order without
 * retaining or reporting any credential bytes.
 */
export async function libsecretStashChecks(keychain: KeychainBackend): Promise<DoctorCheck[]> {
  if (keychain.kind !== 'linux-libsecret') return [];

  const root = join(qlbHomeDir(), '.qlb', 'unclaimed');
  const checks: DoctorCheck[] = [];
  for (const provider of SINGLE_STASH_PROVIDERS) {
    let entries: Awaited<ReturnType<typeof listStashes>>;
    try {
      entries = await listStashes(root, provider, 'default');
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        keychain.getSync(qlbKeychainService(provider, `unclaimed:${entry.stashId}`), QLB_KEYCHAIN_ACCOUNT);
        continue;
      } catch (error) {
        if (isCredentialNotFound(error) || await fallbackBodyIsReadable(root, provider, entry.stashId)) continue;
      }
      checks.push({
        name: `stash:libsecret:${provider}:${entry.stashId}`,
        level: 'WARN',
        message: `libsecret cannot read stash reservation for provider ${provider}, stash id ${entry.stashId}; unlock your login keyring (GNOME Keyring / KWallet), then run qlb doctor again; if this warning persists, the item is gone — report the stash id.`,
      });
    }
  }
  return checks;
}
