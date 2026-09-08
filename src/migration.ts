// Crash-atomic Pi credential migration state machine (§4.8.3, §4.8.3a).
//
// States (journaled in `migrations`): NATIVE → MIRRORED → VALIDATED → QLB_OWNED → RETIRED
//
// The SINGLE commit point is the atomic rename
//   qlb-owner.json.staging → qlb-owner.json
// Everything before that is reversible staging (native file never touched).
// Everything after that is idempotent hygiene (native → .pre-qlb).
//
// =============================================================================
// Crash-point analysis — 7 forward (S2, S3, C, H1, H2, H3, H4) + 4 rollback
// (R2/R3, R4, RC, RH1). Every point resolves to "native works" OR "QLB works",
// never neither. `qlb migrate status` reports the filesystem+journal view;
// `qlb migrate resume` converges as stated.
// =============================================================================
//
// FORWARD
//
// S2  Crash after stage, before rehearse.
//     Owner file: .staging only. Native: intact. Journal: MIRRORED.
//     Pi at next launch: NATIVE WORKS (staging file is ignored by both
//     extensions). status(): state=MIRRORED, ownerFile=staging.
//     resume(): before-commit + not VALIDATED → rollback (delete staging
//     Keychain entries + .staging file, journal NATIVE). Native untouched.
//
// S3  Crash mid-rehearse (or after a failed rehearse).
//     Owner file: .staging only. Native: intact. Journal: MIRRORED.
//     Pi at next launch: NATIVE WORKS. status(): same as S2.
//     resume(): same as S2 (rollback). Rehearse never refreshes; a failed
//     rehearsal leaves native untouched. User re-runs stage/rehearse.
//
// C   Crash after the owner-file rename, before H1 (journal still VALIDATED
//     or MIRRORED). Owner file: PRESENT. Native: intact (not yet renamed).
//     Pi at next launch: QLB WORKS (owner file wins; native merely unused).
//     status(): ownerFile=present, nativeStore=intact, "hygiene pending".
//     resume(): owner present, no rollback intent → finishHygiene (H1–H2).
//     Does NOT re-run rehearse or duplicate the rename of .staging (already
//     gone). Converges to QLB_OWNED.
//
// H1  Crash after journal = QLB_OWNED, before native rename.
//     Owner file: present. Native: intact. Journal: QLB_OWNED.
//     Pi at next launch: QLB WORKS.
//     resume(): finishHygiene runs H2 (rename native → .pre-qlb + sidecar).
//
// H2  Crash after native renamed to .pre-qlb, before sidecar/auth hygiene.
//     Owner file: present. Native: .pre-qlb. Journal: QLB_OWNED.
//     Pi at next launch: QLB WORKS.
//     resume(): finishHygiene sees .pre-qlb, writes sidecar if missing, noop
//     otherwise. Converges to QLB_OWNED.
//
// H3  auth.json copy + refresh-token-free mirror (§4.8.3a). This Phase 2b
//     slice migrates the Pi pool file only; H3 is a documented no-op. Crash
//     here is indistinguishable from H2. QLB WORKS (qlb-pi never reads
//     auth.json). resume(): noop.
//
// H4  Cosmetic rename of extensions/anthropic-pool → .disabled. Never
//     required — the owner-file guard already makes anthropic-pool inert.
//     Crash: QLB WORKS. resume(): noop.
//
// ROLLBACK (only entered by explicit rollback() or resume() with
// detail.intent='rollback'. resume() never *starts* a post-commit rollback.)
//
// R2/R3  Crash after intent='rollback' is journaled, before native is
//        restored. Owner file: present. Native: .pre-qlb (+ maybe .staging).
//        Pi at next launch: QLB WORKS (owner still present).
//        resume(): sees intent=rollback → continueRollback (restore from
//        .pre-qlb, then unlink owner). Converges to VALIDATED.
//
// R4  Crash after native restored from .pre-qlb, before unlink of owner.
//     Owner file: present. Native: restored. Pi at next launch: QLB WORKS
//     (owner file still wins; native copy is fresh and unused).
//     resume(): intent=rollback && native present → continue at RC (unlink
//     owner). Without intent, a native file next to an owner file is the
//     stale-writer case and is only reported, not mutated.
//
// RC  Crash after unlink(qlb-owner.json), before journal = VALIDATED.
//     Owner file: absent. Native: restored. Journal: still QLB_OWNED.
//     Pi at next launch: NATIVE WORKS.
//     resume(): journal=QLB_OWNED && no owner && native present → RH1
//     (journal VALIDATED, drop intent, remove leftover sidecar).
//
// RH1 Crash after journal = VALIDATED, before leftover .pre-qlb/sidecar
//     cleanup. Owner absent, native restored. Pi at next launch: NATIVE
//     WORKS. resume(): RH2 cleanup if anything remains; otherwise noop.
//
// Invariant: owner file present ⇔ (journal ≥ QLB_OWNED ∨ resume pending
// after C). Owner file absent ⇒ native pool file present and parseable
// (or resume will restore it from .pre-qlb under rollback intent). There
// is NO row where the owner file is absent AND the native store has been
// renamed, because H2 is strictly after C and rollback restores native
// strictly before unlinking the owner file.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { config } from './config';
import type { KeychainBackend } from './keychain';
import { qlbKeychainService } from './keychain';
import { parseGrant } from './refresh-lease';
import type { Store } from './store';
import type { Grant } from './types';

export const DEFAULT_POOL_FILE = config.anthropicPoolPath;
export const DEFAULT_OWNER_FILE = join(dirname(config.piAuthJsonPath), 'qlb-owner.json');
export const DEFAULT_AUTH_JSON = config.piAuthJsonPath;
export const PI_POOL_STORE = 'pi-pool';

/**
 * Single-grant providers live as named top-level keys in Pi's shared
 * `auth.json` (one OAuth grant each). This is a DELIBERATE design difference
 * from Anthropic:
 *
 *   Anthropic  — dedicated multi-account file (`anthropic-pool.json`).
 *                Commit hygiene RENAMES it to `.pre-qlb`.
 *   xai / kimi-coding / openai-codex — one shared multi-provider file.
 *                Commit must NOT rename or delete `auth.json`, because Pi
 *                still needs it for every provider that has not been
 *                migrated yet. The native entry is shadow-retained on disk;
 *                QLB records ownership in a per-provider owner file
 *                (`qlb-owner-<provider>.json`) and in the migration journal.
 *                Once QLB-owned, qlb-pi / qlb-proxy MUST prefer the
 *                Keychain copy over reading `auth.json` for that provider.
 *
 * Static-key providers (OpenRouter) are a third shape, NOT stuffed into Grant:
 *
 *   openrouter — a single static API key in macOS Keychain service
 *                `pi-openrouter`. No OAuth, no refresh token, no expiry,
 *                no refresh-lease. Native source is Keychain (READ-ONLY);
 *                QLB never writes `pi-openrouter`. Ownership is recorded in
 *                `qlb-owner-openrouter.json` + journal store `pi-openrouter`.
 *                The QLB Keychain payload is `{ type: 'api-key', access }`
 *                rather than an OAuth Grant (which requires refresh/expires).
 *                Native strategy is `keychain-retain`.
 *
 * Crash-safety is the same state machine (stage → rehearse → commit via
 * atomic owner-file rename → rollback / resume). Hygiene is simply simpler:
 * there is no native rename, so H1–H4 are journal/owner-file only.
 */
export const SINGLE_GRANT_PROVIDERS = ['xai', 'kimi-coding', 'openai-codex'] as const;
export type SingleGrantProvider = (typeof SINGLE_GRANT_PROVIDERS)[number];

/**
 * Static API-key providers. Distinct from SINGLE_GRANT_PROVIDERS because
 * `Grant` is OAuth-shaped (`access` + `refresh` + `expires`) and OpenRouter
 * has none of those fields except the key itself. Do not force a dummy
 * refresh token into Grant — persist `ApiKeyPayload` instead.
 */
export const STATIC_KEY_PROVIDERS = ['openrouter'] as const;
export type StaticKeyProvider = (typeof STATIC_KEY_PROVIDERS)[number];

export type MigrateProvider = 'anthropic' | SingleGrantProvider | StaticKeyProvider;
export type MigrationKind = 'pool' | 'single-grant' | 'static-key';
export type NativeStrategy = 'rename' | 'shadow-retain' | 'keychain-retain';

export const NATIVE_OPENROUTER_KEYCHAIN_SERVICE = config.openrouterKeychainService;

export function isSingleGrantProvider(value: string | undefined): value is SingleGrantProvider {
  return (
    value === 'xai' || value === 'kimi-coding' || value === 'openai-codex'
  );
}

export function isStaticKeyProvider(value: string | undefined): value is StaticKeyProvider {
  return value === 'openrouter';
}

export function isMigrateProvider(value: string | undefined): value is MigrateProvider {
  return value === 'anthropic' || isSingleGrantProvider(value) || isStaticKeyProvider(value);
}

/**
 * Phase 0 adapter accountId conventions. MUST stay in lockstep with
 * `src/adapters/{xai,kimi,codex,openrouter}.ts` so resolve/scoring keep
 * working after cutover. Codex falls back to `codex-default` when the grant
 * has no chatgpt_account_id (the adapter does the same).
 */
export const ADAPTER_ACCOUNT_IDS: Record<SingleGrantProvider | StaticKeyProvider, string> = {
  xai: 'xai-default',
  'kimi-coding': 'kimi-default',
  'openai-codex': 'codex-default',
  openrouter: 'openrouter-default',
};

export const ADAPTER_ACCOUNT_LABELS: Record<SingleGrantProvider | StaticKeyProvider, string> = {
  xai: 'Grok (xAI)',
  'kimi-coding': 'Kimi K3',
  'openai-codex': 'codex-default',
  openrouter: 'OpenRouter',
};

export function migrationStoreNameFor(provider: string): string {
  if (provider === 'anthropic') return PI_POOL_STORE;
  return `pi-${provider}`;
}

export function defaultOwnerFileFor(provider: MigrateProvider): string {
  if (provider === 'anthropic') return DEFAULT_OWNER_FILE;
  return join(dirname(config.piAuthJsonPath), `qlb-owner-${provider}.json`);
}

export function defaultNativePathFor(provider: MigrateProvider): string {
  if (provider === 'anthropic') return DEFAULT_POOL_FILE;
  if (provider === 'openrouter') return '';
  return DEFAULT_AUTH_JSON;
}

export type MigrationState =
  | 'NATIVE'
  | 'MIRRORED'
  | 'VALIDATED'
  | 'QLB_OWNED'
  | 'RETIRED';

export interface StagedAccount {
  id: string;
  provider: string;
  label: string;
  fingerprint: string;
  grant: Grant;
}

export type RehearseFn = (
  account: StagedAccount,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export interface OwnerFile {
  owner: 'qlb';
  stagedAt: number;
  committedAt: number | null;
  exportSeq: number;
  qlbAccountIds: string[];
  stores: string[];
  accounts: Array<{
    id: string;
    provider: string;
    label: string;
    fingerprint: string;
  }>;
  /**
   * `rename` (Anthropic pool): native file is moved to `.pre-qlb` after commit.
   * `shadow-retain` (single-grant): `auth.json` is left in place; ownership is
   * recorded only in this file + the journal.
   * `keychain-retain` (static-key / OpenRouter): native Keychain service
   * `pi-openrouter` is never written; ownership is this file + the journal.
   */
  nativeStrategy?: NativeStrategy;
  authJsonKey?: string;
  nativeKeychainService?: string;
}

export interface MigrationStatus {
  store: string;
  state: MigrationState;
  updatedAt: number | null;
  ownerFile: 'absent' | 'staging' | 'present';
  nativeStore: 'intact' | 'pre-qlb' | 'missing' | 'both';
  piAtNextLaunch: 'native works' | 'QLB works' | 'unknown';
  resumeAction: string;
  detail: Record<string, unknown>;
  nativeStrategy?: NativeStrategy;
  provider?: string;
}

export interface MigrationConfig {
  kind?: MigrationKind;
  provider?: string;
  authJsonKey?: string;
  /**
   * Static-key (OpenRouter): injectable native-key reader.
   * Tests MUST pass a function that returns a fake key. The CLI passes
   * `readOpenRouterNativeKey` (read-only `security find-generic-password
   * -s pi-openrouter -w`). Never writes the native service.
   */
  readNativeKey?: () => string;
}

/**
 * QLB Keychain payload for static API keys. Deliberately NOT a `Grant`:
 * Grant requires `refresh` + `expires` (OAuth). OpenRouter has neither.
 */
export interface ApiKeyPayload {
  type: 'api-key';
  access: string;
  writtenBy?: string;
}

export interface AuthJsonGrantInput {
  type?: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface PoolAccountInput {
  id?: string;
  name?: string;
  email?: string;
  credentials?: {
    type?: string;
    access?: string;
    refresh?: string;
    expires?: number;
  };
}

export interface PoolFileInput {
  version?: number;
  accounts?: PoolAccountInput[];
  [key: string]: unknown;
}

const STATE_RANK: Record<MigrationState, number> = {
  NATIVE: 0,
  MIRRORED: 1,
  VALIDATED: 2,
  QLB_OWNED: 3,
  RETIRED: 4,
};

export function realPiAgentDir(): string {
  return resolve(dirname(config.piAuthJsonPath));
}

/** True if `p` is the live Pi agent dir or a file inside it. */
export function isRealPiAgentPath(p: string): boolean {
  const resolved = resolve(p);
  const root = realPiAgentDir();
  return resolved === root || resolved.startsWith(root + sep);
}

export function fingerprintRefresh(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'utf8').digest('hex');
}

/** SHA-256 of a static API key. Same hash as fingerprintRefresh; named for callers. */
export function fingerprintApiKey(key: string): string {
  return fingerprintRefresh(key);
}

export function parseApiKeyPayload(raw: string): ApiKeyPayload {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid api-key payload');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'api-key' || typeof obj.access !== 'string' || obj.access.length === 0) {
    throw new Error('invalid api-key payload: type/access required');
  }
  const out: ApiKeyPayload = { type: 'api-key', access: obj.access };
  if (typeof obj.writtenBy === 'string') out.writtenBy = obj.writtenBy;
  return out;
}

/**
 * In-memory Grant *view* of an ApiKeyPayload so RehearseFn can keep using
 * `account.grant.access`. This is NOT how the key is persisted — Keychain
 * stores ApiKeyPayload (no refresh/expires). `refresh` is '' and `expires`
 * is 0 (never expires / skip the OAuth expiry gate).
 */
export function grantViewFromApiKeyPayload(raw: string): Grant {
  const payload = parseApiKeyPayload(raw);
  const grant: Grant = {
    access: payload.access,
    refresh: '',
    expires: 0,
    generation: 0,
    extra: { type: 'api-key' },
  };
  if (payload.writtenBy) grant.writtenBy = payload.writtenBy;
  return grant;
}

/**
 * READ-ONLY lookup of the native OpenRouter API key from macOS Keychain
 * service `pi-openrouter`. Never writes that service or any `qlb:openrouter:*`
 * entry. Automated tests MUST NOT call this — inject a fake `readNativeKey`
 * into `createStaticKeyMigration` instead.
 */
export function readOpenRouterNativeKey(): string {
  try {
    const stdout = execFileSync(
      'security',
      ['find-generic-password', '-s', NATIVE_OPENROUTER_KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8' },
    );
    const key = String(stdout).replace(/\n$/, '').trim();
    if (key.length > 0) return key;
  } catch {
    // Normalize Keychain lookup failures without exposing command output.
  }
  throw new Error(
    `OpenRouter key not found in macOS Keychain (service ${NATIVE_OPENROUTER_KEYCHAIN_SERVICE})`,
  );
}

export function stagingOwnerPath(ownerFilePath: string): string {
  return `${ownerFilePath}.staging`;
}

export function preQlbPath(poolFilePath: string): string {
  return `${poolFilePath}.pre-qlb`;
}

export function sidecarPath(poolFilePath: string): string {
  return `${poolFilePath}.pre-qlb.sidecar.json`;
}

function keychainCoords(provider: string, id: string, label: string): {
  service: string;
  account: string;
} {
  return {
    service: qlbKeychainService(provider, id),
    account: label || id,
  };
}

function parseDetail(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed journal detail
  }
  return {};
}

function asState(raw: string | null | undefined): MigrationState {
  if (
    raw === 'NATIVE' ||
    raw === 'MIRRORED' ||
    raw === 'VALIDATED' ||
    raw === 'QLB_OWNED' ||
    raw === 'RETIRED'
  ) {
    return raw;
  }
  return 'NATIVE';
}

/**
 * tmp + fsync + rename. Used for the staging owner file (S2) so a crash
 * mid-write cannot leave a truncated qlb-owner.json.staging.
 */
export function atomicWriteFile(targetPath: string, contents: string, mode = 0o600): void {
  const dir = dirname(targetPath);
  const tmp = join(dir, `.${targetPath.split(sep).pop()}.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, contents, undefined, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode);
  } catch {
    // best-effort
  }
  renameSync(tmp, targetPath);
  try {
    chmodSync(targetPath, mode);
  } catch {
    // best-effort
  }
}

function unlinkIfExists(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path);
}

export function parsePoolFile(raw: string): {
  parsed: PoolFileInput;
  accounts: Array<{
    id: string;
    provider: 'anthropic';
    label: string;
    grant: Grant;
    fingerprint: string;
  }>;
} {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('pool file is not a JSON object');
  }
  const file = parsed as PoolFileInput;
  if (!Array.isArray(file.accounts)) {
    throw new Error('pool file missing accounts[]');
  }
  const accounts: Array<{
    id: string;
    provider: 'anthropic';
    label: string;
    grant: Grant;
    fingerprint: string;
  }> = [];
  for (let i = 0; i < file.accounts.length; i++) {
    const a = file.accounts[i] ?? {};
    const creds = a.credentials;
    if (!creds || typeof creds.access !== 'string' || typeof creds.refresh !== 'string') {
      continue;
    }
    const id = a.id || a.email || a.name || `account-${i + 1}`;
    const label = a.email || a.name || id;
    const grant: Grant = {
      access: creds.access,
      refresh: creds.refresh,
      expires: Number(creds.expires) || 0,
      generation: 0,
      writtenBy: 'migrate-stage',
      extra: { type: creds.type ?? 'oauth' },
    };
    accounts.push({
      id,
      provider: 'anthropic',
      label,
      grant,
      fingerprint: fingerprintRefresh(grant.refresh),
    });
  }
  if (accounts.length === 0) {
    throw new Error('pool file has no importable OAuth accounts');
  }
  return { parsed: file, accounts };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function chatgptAccountIdFromJwt(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!isObjectRecord(payload)) return undefined;
    const direct = payload.chatgpt_account_id;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    for (const value of Object.values(payload)) {
      if (!isObjectRecord(value)) continue;
      const nested = value.chatgpt_account_id;
      if (typeof nested === 'string' && nested.length > 0) return nested;
    }
  } catch {
    // not a JWT — expected for test fixtures
  }
  return undefined;
}

/**
 * AccountId used for Keychain + journal. Must match Phase 0 adapters:
 *   xai.ts          → 'xai-default'
 *   kimi.ts         → 'kimi-default'
 *   codex.ts        → JWT chatgpt_account_id ?? 'codex-default'
 */
export function accountIdForSingleGrant(
  provider: SingleGrantProvider,
  grant: { accountId?: string; access?: string },
): string {
  if (provider === 'openai-codex') {
    if (typeof grant.accountId === 'string' && grant.accountId.length > 0) {
      return grant.accountId;
    }
    return chatgptAccountIdFromJwt(grant.access) ?? ADAPTER_ACCOUNT_IDS[provider];
  }
  return ADAPTER_ACCOUNT_IDS[provider];
}

export function labelForSingleGrant(
  provider: SingleGrantProvider,
  grant: { accountId?: string; access?: string },
): string {
  if (provider === 'openai-codex') {
    return accountIdForSingleGrant(provider, grant);
  }
  return ADAPTER_ACCOUNT_LABELS[provider];
}

export function parseAuthJsonGrant(raw: string, keyName: string): AuthJsonGrantInput {
  const parsed: unknown = JSON.parse(raw);
  if (!isObjectRecord(parsed)) {
    throw new Error('auth.json is not a JSON object');
  }
  const entry = parsed[keyName];
  if (!isObjectRecord(entry)) {
    throw new Error(`auth.json missing importable OAuth grant under key '${keyName}'`);
  }
  if (typeof entry.access !== 'string' || typeof entry.refresh !== 'string') {
    throw new Error(`auth.json key '${keyName}' is missing access/refresh`);
  }
  const out: AuthJsonGrantInput = {
    access: entry.access,
    refresh: entry.refresh,
    expires: Number(entry.expires) || 0,
  };
  if (typeof entry.type === 'string') out.type = entry.type;
  if (typeof entry.accountId === 'string' && entry.accountId.length > 0) {
    out.accountId = entry.accountId;
  }
  return out;
}

/**
 * Default rehearsal: one live Anthropic usage GET with the staged access
 * token. NEVER used by tests — they inject a mock. NEVER refreshes.
 * Expired grants fail closed (QLB must not refresh a grant it does not own).
 */
export async function defaultRehearseFn(
  account: StagedAccount,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (account.grant.expires > 0 && account.grant.expires <= Date.now()) {
    return {
      ok: false,
      error:
        'staged access token expired — use the native harness once so IT refreshes, then re-run. QLB will not refresh a grant it does not own',
    };
  }
  try {
    if (account.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${account.grant.access}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `rehearse HTTP ${res.status}` };
      return { ok: true };
    }
    if (account.provider === 'xai') {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${account.grant.access}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'grok-4.6',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `rehearse HTTP ${res.status}` };
      return { ok: true };
    }
    if (account.provider === 'kimi-coding') {
      const res = await fetch('https://api.kimi.com/coding/v1/usages', {
        headers: { Authorization: `Bearer ${account.grant.access}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `rehearse HTTP ${res.status}` };
      return { ok: true };
    }
    if (account.provider === 'openai-codex') {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${account.grant.access}`,
        'Content-Type': 'application/json',
        originator: 'codex_cli_rs',
      };
      if (account.id !== 'codex-default') {
        headers['chatgpt-account-id'] = account.id;
      }
      const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'gpt-5.4',
          input: 'ping',
          store: false,
          stream: false,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `rehearse HTTP ${res.status}` };
      }
      return { ok: true };
    }
    if (account.provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { Authorization: `Bearer ${account.grant.access}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `rehearse HTTP ${res.status}` };
      return { ok: true };
    }
    return { ok: false, error: `no default rehearse implementation for ${account.provider}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export class Migration {
  private readonly store: Store;
  private readonly keychain: KeychainBackend;
  private readonly poolFilePath: string;
  private readonly ownerFilePath: string;
  readonly storeName: string;
  readonly kind: MigrationKind;
  readonly provider: string | undefined;
  readonly authJsonKey: string | undefined;
  private readonly readNativeKey: (() => string) | undefined;

  constructor(
    store: Store,
    keychain: KeychainBackend,
    poolFilePath: string,
    ownerFilePath: string,
    storeName: string = PI_POOL_STORE,
    config: MigrationConfig = {},
  ) {
    this.store = store;
    this.keychain = keychain;
    this.poolFilePath = poolFilePath;
    this.ownerFilePath = ownerFilePath;
    this.storeName = storeName;
    this.kind = config.kind ?? 'pool';
    this.provider = config.provider;
    this.authJsonKey = config.authJsonKey ?? config.provider;
    this.readNativeKey = config.readNativeKey;
  }

  /** True when commit must not rename/delete the native store. */
  private retainsNative(): boolean {
    return this.kind === 'single-grant' || this.kind === 'static-key';
  }

  private strategy(): NativeStrategy {
    if (this.kind === 'static-key') return 'keychain-retain';
    if (this.kind === 'single-grant') return 'shadow-retain';
    return 'rename';
  }

  status(): MigrationStatus {
    const row = this.store.getMigration(this.storeName);
    const state = asState(row?.state);
    const detail = parseDetail(row?.detail_json);
    const ownerPresent = existsSync(this.ownerFilePath);
    const ownerStaging = existsSync(stagingOwnerPath(this.ownerFilePath));
    const nativePresent =
      this.kind === 'static-key' ? true : existsSync(this.poolFilePath);
    const prePresent =
      this.kind === 'static-key' ? false : existsSync(preQlbPath(this.poolFilePath));
    const intent = detail.intent === 'rollback';

    let ownerFile: MigrationStatus['ownerFile'] = 'absent';
    if (ownerPresent) ownerFile = 'present';
    else if (ownerStaging) ownerFile = 'staging';

    let nativeStore: MigrationStatus['nativeStore'] = 'missing';
    if (this.kind === 'static-key') {
      // Native Keychain service is never mutated by QLB.
      nativeStore = 'intact';
    } else if (nativePresent && prePresent) nativeStore = 'both';
    else if (nativePresent) nativeStore = 'intact';
    else if (prePresent) nativeStore = 'pre-qlb';

    let piAtNextLaunch: MigrationStatus['piAtNextLaunch'] = 'unknown';
    if (ownerPresent) piAtNextLaunch = 'QLB works';
    else if (nativePresent) piAtNextLaunch = 'native works';

    const retains = this.retainsNative();
    const staticKey = this.kind === 'static-key';
    let resumeAction: string;
    if (intent) {
      resumeAction = staticKey
        ? 'continue rollback to VALIDATED (owner unlinked; native Keychain was never moved)'
        : retains
          ? 'continue rollback to VALIDATED (owner unlinked; auth.json was never moved)'
          : 'continue rollback to VALIDATED (native restored, owner unlinked)';
    } else if (ownerPresent && STATE_RANK[state] < STATE_RANK.QLB_OWNED) {
      resumeAction = staticKey
        ? 'already committed; finish hygiene (journal only; native Keychain retained) → QLB_OWNED'
        : retains
          ? 'already committed; finish hygiene (journal only; auth.json shadow-retained) → QLB_OWNED'
          : 'already committed; finish hygiene (H1–H2) → QLB_OWNED';
    } else if (ownerPresent && nativePresent && !prePresent && !retains) {
      resumeAction = 'finish hygiene: rename native → .pre-qlb';
    } else if (ownerPresent) {
      resumeAction = staticKey
        ? 'noop (already QLB_OWNED; native Keychain retained)'
        : retains
          ? 'noop (already QLB_OWNED; native auth.json shadow-retained)'
          : 'noop (already QLB_OWNED)';
    } else if (state === 'QLB_OWNED' && !ownerPresent && nativePresent) {
      resumeAction = 'post-RC hygiene: journal VALIDATED';
    } else if (state === 'VALIDATED' && ownerStaging) {
      resumeAction = 'rehearsal succeeded; complete commit';
    } else if (state === 'MIRRORED' || ownerStaging) {
      resumeAction = 'before commit: roll back staging (native untouched)';
    } else {
      resumeAction = 'noop';
    }

    return {
      store: this.storeName,
      state,
      updatedAt: row?.updated_at ?? null,
      ownerFile,
      nativeStore,
      piAtNextLaunch,
      resumeAction,
      detail,
      nativeStrategy: this.strategy(),
      provider: this.provider,
    };
  }

  /**
   * S2 — copy native credentials into the QLB Keychain as a STAGING copy
   * and write qlb-owner.json.staging. Native file is never written.
   *
   * Pool (Anthropic): N accounts from anthropic-pool.json.
   * Single-grant: 1 account from a named top-level key in auth.json.
   * Static-key (OpenRouter): 1 API key from native Keychain (read-only).
   */
  stage(): MigrationStatus {
    const current = this.status();
    if (current.ownerFile === 'present' || current.state === 'QLB_OWNED' || current.state === 'RETIRED') {
      throw new Error(
        `cannot stage: migration already ${current.state} (owner file ${current.ownerFile})`,
      );
    }
    if (this.kind === 'static-key') {
      return this.stageStaticKey();
    }
    if (this.kind === 'single-grant') {
      return this.stageSingleGrant();
    }
    if (!existsSync(this.poolFilePath)) {
      throw new Error(`pool file not found: ${this.poolFilePath}`);
    }

    const raw = readFileSync(this.poolFilePath, 'utf8');
    const { accounts } = parsePoolFile(raw);
    const mtime = statSync(this.poolFilePath).mtimeMs;

    for (const acct of accounts) {
      const { service, account } = keychainCoords(acct.provider, acct.id, acct.label);
      this.keychain.setSync(service, account, JSON.stringify(acct.grant));
      this.store.upsertAccount(acct.id, acct.provider, acct.label, 'imported-unvalidated');
    }

    const owner: OwnerFile = {
      owner: 'qlb',
      stagedAt: Date.now(),
      committedAt: null,
      exportSeq: 0,
      qlbAccountIds: accounts.map((a) => a.id),
      stores: [this.storeName],
      accounts: accounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        label: a.label,
        fingerprint: a.fingerprint,
      })),
    };
    atomicWriteFile(stagingOwnerPath(this.ownerFilePath), JSON.stringify(owner, null, 2) + '\n');

    this.journal('MIRRORED', {
      accounts: owner.accounts,
      qlbAccountIds: owner.qlbAccountIds,
      nativeMtime: mtime,
      poolFilePath: this.poolFilePath,
      ownerFilePath: this.ownerFilePath,
      stagedAt: owner.stagedAt,
    });
    return this.status();
  }

  /**
   * S3 — one live authenticated call per staged account via `rehearseFn`.
   * MUST NOT refresh. Injected (like adapterRefreshFn on RefreshLease) so
   * tests can mock; the CLI passes defaultRehearseFn for real cutovers.
   */
  async rehearse(rehearseFn: RehearseFn): Promise<MigrationStatus> {
    const current = this.status();
    if (current.state !== 'MIRRORED' && current.state !== 'VALIDATED') {
      throw new Error(`cannot rehearse from state ${current.state}`);
    }
    const staged = this.readStagedAccounts();
    if (staged.length === 0) {
      throw new Error('no staged Keychain credentials to rehearse');
    }

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const acct of staged) {
      if (acct.grant.expires > 0 && acct.grant.expires <= Date.now()) {
        throw new Error(
          `account ${acct.id}: staged access token expired — use the native harness once so IT refreshes, then re-run. QLB will not refresh a grant it does not own`,
        );
      }
      const result = await rehearseFn(acct);
      results.push({
        id: acct.id,
        ok: result.ok,
        error: result.ok ? undefined : result.error,
      });
      if (!result.ok) {
        this.journal('MIRRORED', {
          rehearse: { ok: false, results, failedAt: Date.now() },
        });
        throw new Error(`rehearse failed for ${acct.id}: ${result.error}`);
      }
      this.store.setAccountStatus(acct.id, 'validated');
    }

    this.journal('VALIDATED', {
      rehearse: { ok: true, results, validatedAt: Date.now() },
    });
    return this.status();
  }

  /**
   * C + H1 + H2. The rename of .staging → owner IS the commit; native
   * rename is hygiene afterwards.
   */
  commit(): MigrationStatus {
    if (existsSync(this.ownerFilePath)) {
      return this.finishHygiene();
    }
    const staging = stagingOwnerPath(this.ownerFilePath);
    if (!existsSync(staging)) {
      throw new Error(`cannot commit: missing ${staging}`);
    }
    const current = this.status();
    if (current.state !== 'VALIDATED' && current.state !== 'QLB_OWNED') {
      throw new Error(
        `cannot commit from state ${current.state} (rehearse must succeed first)`,
      );
    }

    // C — THE ONLY COMMIT POINT (atomic rename on APFS/POSIX).
    renameSync(staging, this.ownerFilePath);
    try {
      chmodSync(this.ownerFilePath, 0o600);
    } catch {
      // best-effort
    }
    return this.finishHygiene();
  }

  rollback(): MigrationStatus {
    if (existsSync(this.ownerFilePath) || this.journalState() === 'QLB_OWNED') {
      return this.postCommitRollback();
    }
    return this.preCommitRollback();
  }

  /**
   * Deterministic resume:
   *   - rollback intent journaled            → continueRollback
   *   - owner file present (past C)          → finishHygiene (forward)
   *   - QLB_OWNED, owner gone, native back   → RH1 (journal VALIDATED)
   *   - VALIDATED + staging present          → commit (rehearsal proved it)
   *   - MIRRORED / staging leftovers         → preCommitRollback
   */
  resume(): MigrationStatus {
    const current = this.status();
    const intent = current.detail.intent === 'rollback';

    if (intent) {
      return this.continueRollback();
    }
    if (existsSync(this.ownerFilePath)) {
      return this.finishHygiene();
    }
    if (
      current.state === 'QLB_OWNED' &&
      !existsSync(this.ownerFilePath) &&
      (this.kind === 'static-key' || existsSync(this.poolFilePath))
    ) {
      return this.finishRollbackJournal();
    }
    if (current.state === 'VALIDATED' && existsSync(stagingOwnerPath(this.ownerFilePath))) {
      return this.commit();
    }
    if (current.state === 'MIRRORED' || existsSync(stagingOwnerPath(this.ownerFilePath))) {
      return this.preCommitRollback();
    }
    return current;
  }

  // --- internals -----------------------------------------------------------

  /**
   * S2 for a static API key (OpenRouter). Reads native Keychain via the
   * injected `readNativeKey` (tests: fake key; CLI: read-only `pi-openrouter`).
   * Writes QLB Keychain `qlb:openrouter:openrouter-default` as ApiKeyPayload.
   * NEVER writes the native `pi-openrouter` service.
   */
  private stageStaticKey(): MigrationStatus {
    if (!this.provider || !isStaticKeyProvider(this.provider)) {
      throw new Error('static-key migration requires provider openrouter');
    }
    if (!this.readNativeKey) {
      throw new Error(
        'static-key migration requires readNativeKey (tests must inject a fake key; never call the real Keychain from automated tests)',
      );
    }
    const key = this.readNativeKey().trim();
    if (!key) {
      throw new Error(
        `OpenRouter key not found in macOS Keychain (service ${NATIVE_OPENROUTER_KEYCHAIN_SERVICE})`,
      );
    }
    const id = ADAPTER_ACCOUNT_IDS[this.provider];
    const label = ADAPTER_ACCOUNT_LABELS[this.provider];
    const payload: ApiKeyPayload = {
      type: 'api-key',
      access: key,
      writtenBy: 'migrate-stage',
    };
    const fingerprint = fingerprintApiKey(key);
    const { service, account } = keychainCoords(this.provider, id, label);
    this.keychain.setSync(service, account, JSON.stringify(payload));
    this.store.upsertAccount(id, this.provider, label, 'imported-unvalidated');

    const owner: OwnerFile = {
      owner: 'qlb',
      stagedAt: Date.now(),
      committedAt: null,
      exportSeq: 0,
      qlbAccountIds: [id],
      stores: [this.storeName],
      accounts: [{ id, provider: this.provider, label, fingerprint }],
      nativeStrategy: 'keychain-retain',
      nativeKeychainService: NATIVE_OPENROUTER_KEYCHAIN_SERVICE,
    };
    atomicWriteFile(stagingOwnerPath(this.ownerFilePath), JSON.stringify(owner, null, 2) + '\n');

    this.journal('MIRRORED', {
      accounts: owner.accounts,
      qlbAccountIds: owner.qlbAccountIds,
      ownerFilePath: this.ownerFilePath,
      stagedAt: owner.stagedAt,
      nativeStrategy: 'keychain-retain',
      nativeKeychainService: NATIVE_OPENROUTER_KEYCHAIN_SERVICE,
      provider: this.provider,
    });
    return this.status();
  }

  /**
   * S2 for a single OAuth grant in auth.json. Writes Keychain + staging
   * owner file. NEVER writes auth.json.
   */
  private stageSingleGrant(): MigrationStatus {
    if (!this.provider || !isSingleGrantProvider(this.provider)) {
      throw new Error('single-grant migration requires provider xai|kimi-coding|openai-codex');
    }
    const keyName = this.authJsonKey ?? this.provider;
    if (!existsSync(this.poolFilePath)) {
      throw new Error(`auth.json not found: ${this.poolFilePath}`);
    }

    const raw = readFileSync(this.poolFilePath, 'utf8');
    const parsed = parseAuthJsonGrant(raw, keyName);
    const mtime = statSync(this.poolFilePath).mtimeMs;
    const id = accountIdForSingleGrant(this.provider, parsed);
    const label = labelForSingleGrant(this.provider, parsed);
    const extra: Record<string, unknown> = { type: parsed.type ?? 'oauth', authJsonKey: keyName };
    if (parsed.accountId) extra.accountId = parsed.accountId;
    const grant: Grant = {
      access: parsed.access,
      refresh: parsed.refresh,
      expires: parsed.expires,
      generation: 0,
      writtenBy: 'migrate-stage',
      extra,
    };
    const fingerprint = fingerprintRefresh(grant.refresh);
    const { service, account } = keychainCoords(this.provider, id, label);
    this.keychain.setSync(service, account, JSON.stringify(grant));
    this.store.upsertAccount(id, this.provider, label, 'imported-unvalidated');

    const owner: OwnerFile = {
      owner: 'qlb',
      stagedAt: Date.now(),
      committedAt: null,
      exportSeq: 0,
      qlbAccountIds: [id],
      stores: [this.storeName],
      accounts: [{ id, provider: this.provider, label, fingerprint }],
      nativeStrategy: 'shadow-retain',
      authJsonKey: keyName,
    };
    atomicWriteFile(stagingOwnerPath(this.ownerFilePath), JSON.stringify(owner, null, 2) + '\n');

    this.journal('MIRRORED', {
      accounts: owner.accounts,
      qlbAccountIds: owner.qlbAccountIds,
      nativeMtime: mtime,
      poolFilePath: this.poolFilePath,
      ownerFilePath: this.ownerFilePath,
      stagedAt: owner.stagedAt,
      nativeStrategy: 'shadow-retain',
      authJsonKey: keyName,
      provider: this.provider,
    });
    return this.status();
  }

  private journalState(): MigrationState {
    return asState(this.store.getMigration(this.storeName)?.state);
  }

  private journal(state: MigrationState, extra: Record<string, unknown> = {}): void {
    const prev = this.store.getMigration(this.storeName);
    const detail = { ...parseDetail(prev?.detail_json), ...extra };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete detail[key];
    }
    this.store.upsertMigration(this.storeName, state, JSON.stringify(detail));
  }

  private readOwnerPayload(): OwnerFile | null {
    const candidates = [this.ownerFilePath, stagingOwnerPath(this.ownerFilePath)];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
        if (parsed && typeof parsed === 'object' && (parsed as OwnerFile).owner === 'qlb') {
          return parsed as OwnerFile;
        }
      } catch {
        // unreadable; try the other candidate
      }
    }
    const detail = parseDetail(this.store.getMigration(this.storeName)?.detail_json);
    const accounts = Array.isArray(detail.accounts)
      ? (detail.accounts as OwnerFile['accounts'])
      : [];
    if (accounts.length === 0) return null;
    return {
      owner: 'qlb',
      stagedAt: Number(detail.stagedAt) || 0,
      committedAt: null,
      exportSeq: 0,
      qlbAccountIds: accounts.map((a) => a.id),
      stores: [this.storeName],
      accounts,
    };
  }

  private readStagedAccounts(): StagedAccount[] {
    const owner = this.readOwnerPayload();
    if (!owner) return [];
    const out: StagedAccount[] = [];
    for (const meta of owner.accounts) {
      const { service, account } = keychainCoords(meta.provider, meta.id, meta.label);
      const raw = this.keychain.getSync(service, account);
      const grant =
        this.kind === 'static-key'
          ? grantViewFromApiKeyPayload(raw)
          : parseGrant(raw);
      out.push({
        id: meta.id,
        provider: meta.provider,
        label: meta.label,
        fingerprint: meta.fingerprint,
        grant,
      });
    }
    return out;
  }

  /** H1 + H2. Idempotent. Called after C and by resume() when owner is present. */
  private finishHygiene(): MigrationStatus {
    const now = Date.now();
    if (existsSync(this.ownerFilePath)) {
      try {
        const raw = readFileSync(this.ownerFilePath, 'utf8');
        const owner = JSON.parse(raw) as OwnerFile;
        if (owner && owner.committedAt == null) {
          owner.committedAt = now;
          atomicWriteFile(this.ownerFilePath, JSON.stringify(owner, null, 2) + '\n');
        }
      } catch {
        // owner file present but unreadable — still journal; doctor will flag
      }
    }

    this.journal('QLB_OWNED', { committedAt: now, intent: undefined });

    if (this.retainsNative()) {
      // single-grant: auth.json is a shared multi-provider file. Renaming it
      // would steal every unmigrated provider's grant.
      // static-key: native Keychain service `pi-openrouter` is never written.
      // Ownership is the owner file + journal in both cases.
      return this.status();
    }

    const native = this.poolFilePath;
    const retired = preQlbPath(native);
    if (existsSync(native) && !existsSync(retired)) {
      renameSync(native, retired);
    }
    if (existsSync(retired) && !existsSync(sidecarPath(native))) {
      const owner = this.readOwnerPayload();
      const fingerprints: Record<string, string> = {};
      for (const a of owner?.accounts ?? []) {
        fingerprints[a.id] = a.fingerprint;
      }
      atomicWriteFile(
        sidecarPath(native),
        JSON.stringify(
          {
            retiredAt: now,
            fingerprint: fingerprints,
            qlbAccountIds: owner?.qlbAccountIds ?? [],
          },
          null,
          2,
        ) + '\n',
      );
    }
    return this.status();
  }

  private deleteStagedKeychain(accounts: OwnerFile['accounts'] | undefined): void {
    if (!accounts) return;
    for (const meta of accounts) {
      const { service, account } = keychainCoords(meta.provider, meta.id, meta.label);
      try {
        this.keychain.deleteSync(service, account);
      } catch {
        // already gone — rollback is idempotent
      }
    }
  }

  private preCommitRollback(): MigrationStatus {
    const owner = this.readOwnerPayload();
    this.deleteStagedKeychain(owner?.accounts);
    unlinkIfExists(stagingOwnerPath(this.ownerFilePath));
    this.journal('NATIVE', { intent: undefined, rolledBackAt: Date.now(), rolledBackFrom: 'pre-commit' });
    return this.status();
  }

  private postCommitRollback(): MigrationStatus {
    this.journal(this.journalState() === 'NATIVE' ? 'QLB_OWNED' : this.journalState(), {
      intent: 'rollback',
    });
    return this.continueRollback();
  }

  private continueRollback(): MigrationStatus {
    if (this.retainsNative()) {
      // Native was never moved (auth.json shadow-retained, or Keychain retained).
      unlinkIfExists(this.ownerFilePath);
      unlinkIfExists(stagingOwnerPath(this.ownerFilePath));
      return this.finishRollbackJournal();
    }

    const native = this.poolFilePath;
    const retired = preQlbPath(native);

    // R4 — restore native from .pre-qlb while the owner file is STILL present.
    if (!existsSync(native) && existsSync(retired)) {
      renameSync(retired, native);
    }

    // RC — unlink owner only after native is present again.
    if (existsSync(native)) {
      unlinkIfExists(this.ownerFilePath);
      unlinkIfExists(stagingOwnerPath(this.ownerFilePath));
    } else {
      // Cannot yet drop the owner file — native is not restored. Leave it.
      return this.status();
    }

    return this.finishRollbackJournal();
  }

  /** RH1 + RH2 */
  private finishRollbackJournal(): MigrationStatus {
    if (this.kind !== 'static-key' && this.poolFilePath) {
      unlinkIfExists(sidecarPath(this.poolFilePath));
      unlinkIfExists(preQlbPath(this.poolFilePath));
    }
    this.journal('VALIDATED', {
      intent: undefined,
      rolledBackAt: Date.now(),
      rolledBackFrom: 'post-commit',
    });
    return this.status();
  }
}

export function createSingleGrantMigration(
  store: Store,
  keychain: KeychainBackend,
  provider: SingleGrantProvider,
  authJsonPath: string,
  ownerFilePath: string,
  keyName: string = provider,
): Migration {
  return new Migration(
    store,
    keychain,
    authJsonPath,
    ownerFilePath,
    migrationStoreNameFor(provider),
    { kind: 'single-grant', provider, authJsonKey: keyName },
  );
}

/**
 * OpenRouter (and future static-key providers): no auth.json, no OAuth Grant.
 * `readNativeKey` is required so tests inject a fake and never touch the real
 * `pi-openrouter` Keychain service. The CLI passes `readOpenRouterNativeKey`.
 */
export function createStaticKeyMigration(
  store: Store,
  keychain: KeychainBackend,
  provider: StaticKeyProvider,
  ownerFilePath: string,
  readNativeKey: () => string,
): Migration {
  return new Migration(
    store,
    keychain,
    '',
    ownerFilePath,
    migrationStoreNameFor(provider),
    { kind: 'static-key', provider, readNativeKey },
  );
}

/**
 * Stage one OAuth grant from a named top-level key in auth.json into the
 * QLB Keychain. Native auth.json is never written. Same crash-safe S2 as
 * the Anthropic pool path.
 */
export function stageGenericGrant(
  store: Store,
  keychain: KeychainBackend,
  provider: SingleGrantProvider,
  authJsonPath: string,
  keyName: string,
  ownerFilePath: string,
): MigrationStatus {
  return createSingleGrantMigration(
    store,
    keychain,
    provider,
    authJsonPath,
    ownerFilePath,
    keyName,
  ).stage();
}
