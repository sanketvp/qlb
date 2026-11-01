import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isCredentialNotFound } from '../credential-backends';
import type { DoctorCheck } from '../diagnostics';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from '../keychain';
import { listStashes } from '../unclaimed-index';
import { check } from './_check';

export default check('stash:libsecret', 'stash:libsecret');

const SINGLE_STASH_PROVIDERS = ['xai', 'kimi-coding'] as const;

type FallbackBodyStatus = 'absent' | 'readable' | 'unreadable';

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Match single-stash's file read and record validation without reporting bytes. */
async function fallbackBodyStatus(root: string, provider: string, stashId: string): Promise<FallbackBodyStatus> {
  try {
    const value = JSON.parse(await readFile(join(root, provider, `${stashId}.json`), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unreadable';
    const record = value as { credential?: unknown; consumedFp?: unknown };
    if (typeof record.consumedFp !== 'string' || !record.credential ||
      typeof record.credential !== 'object' || Array.isArray(record.credential)) return 'unreadable';
    const credential = record.credential as { access?: unknown; refresh?: unknown; expires?: unknown };
    return typeof credential.access === 'string' && credential.access.length > 0 &&
      typeof credential.refresh === 'string' && credential.refresh.length > 0 &&
      (credential.expires === undefined || (typeof credential.expires === 'number' && Number.isFinite(credential.expires)))
      ? 'readable'
      : 'unreadable';
  } catch (error) {
    return isMissingFile(error) ? 'absent' : 'unreadable';
  }
}

/**
 * libsecret's secret-tool reports both a locked keyring and an absent item as
 * operational errors. Match single-stash's fail-closed read order without
 * retaining or reporting any credential bytes.
 */
export async function libsecretStashChecks(keychain: KeychainBackend, root: string): Promise<DoctorCheck[]> {
  if (keychain.kind !== 'linux-libsecret') return [];
  const checks: DoctorCheck[] = [];
  for (const provider of SINGLE_STASH_PROVIDERS) {
    let entries: Awaited<ReturnType<typeof listStashes>>;
    try {
      entries = await listStashes(root, provider, 'default');
    } catch {
      checks.push({
        name: `stash:libsecret:${provider}`,
        level: 'WARN',
        message: `stash index could not be read for provider ${provider}; run qlb doctor again; if this warning persists, report the provider.`,
      });
      continue;
    }
    for (const entry of entries) {
      try {
        keychain.getSync(qlbKeychainService(provider, `unclaimed:${entry.stashId}`), QLB_KEYCHAIN_ACCOUNT);
        continue;
      } catch (error) {
        const fallback = await fallbackBodyStatus(root, provider, entry.stashId);
        if (fallback === 'readable' || (fallback === 'absent' && isCredentialNotFound(error))) continue;
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
