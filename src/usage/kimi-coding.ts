import { readFileSync } from 'node:fs';
import type { KeychainBackend } from '../keychain';
import { isPiPlaceholder } from '../pi-migrate';
import { resolve } from '../token/kimi-coding';

export const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';

/** Which credential the probe sends: QLB's managed item (default) or Pi's own auth.json entry. */
export type KimiCredentialSource = 'qlb' | 'pi-auth';

export interface KimiCodingUsageProbeResult {
  status: number | null;
  source: 'kimi-api' | 'unknown';
  keys: string[];
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface KimiCodingUsageProbeOptions {
  credentialSource?: KimiCredentialSource;
}

export interface KimiCodingUsageProbeDeps extends KimiCodingUsageProbeOptions {
  /** Test seam: a fixed access token, used instead of either credential source. */
  access?: string;
  /** Test seam; production uses the platform Keychain. */
  keychain?: KeychainBackend;
  /** Required for `pi-auth`; the CLI supplies config.piAuthJsonPath. */
  authJsonPath?: string;
  fetchFn?: FetchFn;
}

function objectKeys(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed).slice(0, 20).map((key) => key.slice(0, 64))
      : [];
  } catch {
    return [];
  }
}

function parseAuth(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * P5-live: Pi's own kimi-coding access token, read-only (no lock, no write).
 * Pi writes auth.json atomically, so one re-read covers a torn read. The QLB
 * placeholder, a missing entry or an unreadable file throws.
 */
function piAuthAccess(path: string): string {
  let auth: unknown;
  try {
    auth = parseAuth(path);
  } catch {
    auth = parseAuth(path);
  }
  const entry = auth && typeof auth === 'object' && !Array.isArray(auth)
    ? (auth as Record<string, unknown>)['kimi-coding']
    : undefined;
  if (isPiPlaceholder(entry)) throw new Error('kimi-coding entry is the QLB placeholder');
  const access = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).access : undefined;
  if (typeof access !== 'string' || access.length === 0) throw new Error('kimi-coding entry has no access token');
  return access;
}

function selectAccess(deps: KimiCodingUsageProbeDeps): string {
  if (deps.access !== undefined) return deps.access;
  if (deps.credentialSource === 'pi-auth') {
    if (!deps.authJsonPath) throw new Error('Pi auth.json path is required');
    return piAuthAccess(deps.authJsonPath);
  }
  return resolve({ keychain: deps.keychain }).token;
}

/** L18 probe: metadata only, never a response body or credential. */
export async function probeKimiCodingUsage(deps: KimiCodingUsageProbeDeps = {}): Promise<KimiCodingUsageProbeResult> {
  let access: string;
  try {
    access = selectAccess(deps);
  } catch {
    return { status: null, source: 'unknown', keys: [] };
  }

  try {
    const response = await (deps.fetchFn ?? fetch)(KIMI_USAGE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${access}` },
    });
    return { status: response.status, source: 'kimi-api', keys: objectKeys(await response.text()) };
  } catch {
    return { status: null, source: 'unknown', keys: [] };
  }
}

export default { probe: probeKimiCodingUsage };
