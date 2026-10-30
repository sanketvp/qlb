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
// Crash-point analysis — 8 forward (S1, S2, S3, C, H1, H2, H3, H4) + 4 rollback
// (R2/R3, R4, RC, RH1). Every point resolves to "native works" OR "QLB works",
// never neither. `qlb migrate status` reports the filesystem+journal view;
// `qlb migrate resume` converges as stated.
// =============================================================================
//
// FORWARD
//
// S1  Crash after MIRRORED intent journal, before Keychain writes,
//     upsertAccount(), or the staging owner file.
//     Owner file: absent. Native: intact. Journal: MIRRORED (target account
//     IDs already recorded).
//     Pi at next launch: NATIVE WORKS (native file never touched; staging
//     Keychain may be partial or absent).
//     status(): state=MIRRORED, ownerFile=absent.
//     resume(): MIRRORED → rollback (delete any staging Keychain entries
//     named in the journal, journal NATIVE). Native untouched.
//     Concurrent accounts prune: cannot observe "account row exists" without
//     also observing this MIRRORED journal, because the journal lands first.
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

import { createHash } from 'node:crypto';
import { isCredentialNotFound } from './credential-backends';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { config } from './config';
import { codexSlotIdFromAccessToken } from './codex-auth';
import { codexHeaderAccountId } from './codex-slots';
import { fsyncDirSync } from './fsutil';
import { qlbHomeDir } from './home';
import type { KeychainBackend } from './keychain';
import { openRouterMissingKeyMessage, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, readNativeOpenRouterKey } from './keychain';
import { legacyPiAuthBackupPath, piAuthBackupPath, readPiAuthBackup, removePiAuthBackup, restorePiAuthEntryLocked, type PiAuthBackup } from './pi-auth-backup';
import { canonicalDigest, fencedGeneration, handbackVerdict, isValidEntry, keychainDigest, NoSingleGrantRestoreSourceError, rankSingleGrantSource, restoreRecordFor } from './pi-handback-source';
import type { RollbackDecision } from './single-grant-ownership';
import { parseGrant } from './refresh-lease';
import { hasLegacyPiOwnerEntry, isPiPlaceholder, PiOwnerLegacyError, readPiOwnerProviders, withPiAuthLock, writePiOwnerEntry, type AuthLockTiming } from './pi-migrate';
import { OPENROUTER_GATE_KEYCHAIN_SERVICE } from './token/openrouter';
import { refreshLeaseName, type Store } from './store';
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
 *   openrouter — a single static API key in the platform credential store
 *                (macOS Keychain / libsecret / DPAPI file) service
 *                `pi-openrouter`. No OAuth, no refresh token, no expiry,
 *                no refresh-lease. Native source is READ-ONLY;
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
 * working after cutover. `codex-default` is a legacy name, recognised only
 * for old rows.
 */
export const ADAPTER_ACCOUNT_IDS: Record<SingleGrantProvider | StaticKeyProvider, string> = {
  xai: 'xai-default',
  'kimi-coding': 'kimi-default',
  'openai-codex': 'codex-default', // legacy name, recognised only for old rows
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
  if (provider === 'anthropic' || provider === 'openrouter') return DEFAULT_OWNER_FILE;
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
  /** Cleanup-pending hand-back marker, formatted for status output. */
  handback?: Record<string, unknown>;
  nativeStrategy?: NativeStrategy;
  provider?: string;
}

export class OwnerMapPresentError extends Error {
  readonly code = 'owner-map-present';

  constructor() {
    super('owner-map-present: anthropic pool migration waits for P7b8');
    this.name = 'OwnerMapPresentError';
  }
}

/** Named crash points for MigrationConfig.afterStep; later rows add their own. */
export type MigrationCrashPoint = 'S1' | 'S2-reads' | 'S2' | 'S4a' | 'S5' | 'S6c1';

export interface MigrationConfig {
  kind?: MigrationKind;
  provider?: string;
  authJsonKey?: string;
  /** S2 test seam; defaults to a real synchronous wall-clock sleep. */
  sleepSync?: (ms: number) => void;
  /** S2 test seam for lease liveness and its bounded wait clock; defaults to Date.now. */
  now?: () => number;
  /** S3 test seam for rollback/resume's Pi auth-lock acquisition timing. */
  authLockTiming?: AuthLockTiming;
  /**
   * Static-key (OpenRouter): injectable native-key reader.
   * Tests MUST pass a function that returns a fake key. The CLI passes
   * `readOpenRouterNativeKey` (read-only platform lookup of `pi-openrouter`).
   * Never writes the native service.
   */
  readNativeKey?: () => string;
  /** Test-only barrier after a pool takes the final owner-map lock. */
  beforePoolCommitLock?: () => void;
  /** Test-only barrier immediately before single-grant stage takes Pi's auth lock. */
  beforeOwnershipLock?: () => void;
  /** Test-only directory durability seam for S6b cleanup. */
  fsyncDirectory?: (path: string) => void;
  /** Test-only crash seam after a named hand-back step (design §6; row 22 adds `S6c1`). */
  afterStep?: (point: MigrationCrashPoint) => void;
  /** P7a's in-progress journal directory; defaults to ~/.qlb/journal. */
  piMigrateJournalDir?: string;
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
 * READ-ONLY lookup of the native OpenRouter API key from the platform
 * credential store (macOS Keychain service `pi-openrouter`, or the Linux/
 * Windows equivalent). Never writes that service or any `qlb:openrouter:*`
 * entry. Automated tests MUST NOT call this — inject a fake `readNativeKey`
 * into `createStaticKeyMigration` instead.
 */
export function readOpenRouterNativeKey(): string {
  return readNativeOpenRouterKey(NATIVE_OPENROUTER_KEYCHAIN_SERVICE);
}

export function stagingOwnerPath(ownerFilePath: string, provider?: string): string {
  return provider ? `${ownerFilePath}.${provider}.staging` : `${ownerFilePath}.staging`;
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
  if (provider === 'openrouter') {
    return { service: OPENROUTER_GATE_KEYCHAIN_SERVICE, account: QLB_KEYCHAIN_ACCOUNT };
  }
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
 *   codex.ts        → S29 slot identity
 */
export function legacyCodexAccountIdForSingleGrant(
  grant: { accountId?: string; access?: string },
): string {
  if (typeof grant.accountId === 'string' && grant.accountId.length > 0) {
    return grant.accountId;
  }
  return chatgptAccountIdFromJwt(grant.access) ?? ADAPTER_ACCOUNT_IDS['openai-codex'];
}

export function accountIdForSingleGrant(
  provider: SingleGrantProvider,
  grant: { accountId?: string; access?: string },
): string {
  if (provider === 'openai-codex') {
    const accountId = codexSlotIdFromAccessToken(grant.access ?? '', grant.accountId);
    if (!accountId) throw new Error('codex-identity-missing');
    return accountId;
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
      const accountId = codexHeaderAccountId(null, account.id);
      if (accountId !== undefined) headers['chatgpt-account-id'] = accountId;
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
  private readonly ownerMapPath: string;
  readonly storeName: string;
  readonly kind: MigrationKind;
  readonly provider: string | undefined;
  readonly authJsonKey: string | undefined;
  private readonly readNativeKey: (() => string) | undefined;
  private readonly beforePoolCommitLock: (() => void) | undefined;
  private readonly beforeOwnershipLock: (() => void) | undefined;
  private readonly afterStep: ((point: MigrationCrashPoint) => void) | undefined;
  private readonly sleepSync: (ms: number) => void;
  /** Keeps Pi's auth.json lock fresh during S2's lease wait; throws lock-lost. */
  private piAuthLockRefresh: (() => void) | undefined;
  private readonly now: () => number;
  private readonly authLockTiming: AuthLockTiming | undefined;
  private readonly fsyncDirectory: (path: string) => void;
  private readonly piMigrateJournalDir: string;

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
    this.ownerMapPath = join(dirname(ownerFilePath), 'qlb-owner.json');
    this.storeName = storeName;
    this.kind = config.kind ?? 'pool';
    this.provider = config.provider;
    this.authJsonKey = config.authJsonKey ?? config.provider;
    this.readNativeKey = config.readNativeKey;
    this.beforePoolCommitLock = config.beforePoolCommitLock;
    this.beforeOwnershipLock = config.beforeOwnershipLock;
    this.afterStep = config.afterStep;
    this.sleepSync = config.sleepSync ?? ((ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    });
    this.now = config.now ?? Date.now;
    this.authLockTiming = config.authLockTiming;
    this.fsyncDirectory = config.fsyncDirectory ?? fsyncDirSync;
    this.piMigrateJournalDir = config.piMigrateJournalDir ?? join(qlbHomeDir(), '.qlb', 'journal');
  }

  private assertNotP7aOwned(): void {
    if (this.kind === 'pool' || !this.provider) return;
    const p7aState = this.store.getConfig(`pi.${this.provider}.state`);
    const p7aJournal = join(this.piMigrateJournalDir, `pi-migrate-${this.provider}.json`);
    if (p7aState !== 'migrated' && !existsSync(p7aJournal)) return;

    const { committed, rollbackInProgress, handbackPending } = this.ownershipFacts();

    // C1 must precede C2: otherwise a generic command could mistake its own
    // durable ownership evidence for a plain P7a-owned provider.
    if (committed || rollbackInProgress || handbackPending) {
      throw Object.assign(
        new Error(`dual-ownership: run \`qlb pi rollback ${this.provider}\` first, then \`qlb migrate rollback --provider ${this.provider}\``),
        { exitCode: 3 },
      );
    }
    throw Object.assign(
      new Error(`owned-by-pi-migrate: run \`qlb pi rollback ${this.provider}\``),
      { exitCode: 3 },
    );
  }

  /** Design §2 S0 `Claim` = `O` ∨ `L` ∨ `Oc` (a custom `--owner-file` v1 document naming this provider). */
  private claimPresent(): boolean {
    const claim = this.ownershipClaim();
    return claim !== null && claim.kind !== 'unreadable';
  }

  private claimPathPresent(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch (error: unknown) {
      // Only a definite absence is safe to classify as no claim. Permission,
      // path-shape, and other lookup errors are ambiguous durable evidence.
      return !isObjectRecord(error) || error.code !== 'ENOENT';
    }
  }

  private unreadableOwnerMapAt(path: string): boolean {
    // Do not rely on readPiOwnerProviders' existsSync() guard: existsSync()
    // reports a dangling symlink as absent. lstat makes only ENOENT absent.
    if (!this.claimPathPresent(path)) return false;
    try {
      readFileSync(path, 'utf8');
      readPiOwnerProviders(path);
      return false;
    } catch (error) {
      // A legacy v1 file is readable and has its own explicit rejection at
      // the static-key commit boundary; it is not an ambiguous O claim.
      return !(error instanceof PiOwnerLegacyError);
    }
  }

  private unreadableLegacySidecarAt(path: string): boolean {
    // As above, lstat detects a dangling L symlink before readFileSync can
    // otherwise be hidden by existsSync()-based callers.
    if (!this.claimPathPresent(path)) return false;
    try {
      JSON.parse(readFileSync(path, 'utf8'));
      return false;
    } catch {
      return true;
    }
  }

  private unreadableCustomOwnerFileAt(path: string): boolean {
    // Oc is a v1 document, so preserve ownershipClaim's read-then-parse probe
    // while making it independently available to the fail-closed assertion.
    if (!this.claimPathPresent(path)) return false;
    try {
      readFileSync(path, 'utf8');
      hasLegacyPiOwnerEntry(path, this.ownerProvider());
      return false;
    } catch {
      return true;
    }
  }

  private ownershipClaim(): { kind: 'O' | 'L' | 'Oc' | 'unreadable'; path: string } | null {
    // The pool path deliberately preserves its pre-P7b claim semantics. C6
    // does not classify it, and its callers still need the committed claim.
    if (this.kind === 'pool') {
      return this.ownerEntryPresent() ? { kind: 'L', path: this.ownerFilePath } : null;
    }

    if (this.ownerEntryPresentAt(this.ownerMapPath)) return { kind: 'O', path: this.ownerMapPath };
    if (this.unreadableOwnerMapAt(this.ownerMapPath)) return { kind: 'unreadable', path: this.ownerMapPath };

    const legacyPath = this.legacySidecarPath();
    if (legacyPath) {
      if (this.legacySidecarOwned()) return { kind: 'L', path: legacyPath };
      if (this.unreadableLegacySidecarAt(legacyPath)) return { kind: 'unreadable', path: legacyPath };
    }

    if (this.ownerFilePath === this.ownerMapPath || this.ownerFilePath === legacyPath) return null;
    // lstat the custom path before its existsSync()-based reader so dangling
    // Oc symlinks are ambiguous evidence, not an absent claim.
    if (!this.claimPathPresent(this.ownerFilePath)) return null;
    if (this.unreadableCustomOwnerFileAt(this.ownerFilePath)) {
      return { kind: 'unreadable', path: this.ownerFilePath };
    }
    if (hasLegacyPiOwnerEntry(this.ownerFilePath, this.ownerProvider())) {
      return { kind: 'Oc', path: this.ownerFilePath };
    }
    return null;
  }

  /** Design §2 S0 facts `Gen`, `Rb` and `Hb`, read from this path's own durable evidence. */
  private ownershipFacts(): { committed: boolean; rollbackInProgress: boolean; handbackPending: boolean } {
    const row = this.store.getMigration(this.storeName);
    const state = asState(row?.state);
    const detail = parseDetail(row?.detail_json);
    const legacySidecar = this.legacySidecarOwned();
    const claim = this.claimPresent();
    const commitGenerationSet = Object.prototype.hasOwnProperty.call(detail, 'commitGeneration');
    const commitStartedSet = Object.prototype.hasOwnProperty.call(detail, 'commitStarted');
    return {
      committed: state === 'QLB_OWNED'
        || state === 'RETIRED'
        || (state === 'VALIDATED' && claim && (legacySidecar || commitGenerationSet || commitStartedSet)),
      rollbackInProgress: detail.intent === 'rollback'
        || Object.prototype.hasOwnProperty.call(detail, 'rollbackDecision'),
      handbackPending: isObjectRecord(detail.handback) && detail.handback.phase === 'cleanup-pending',
    };
  }

  /** C3/C4: only resume/rollback may advance an active hand-back marker. */
  private assertNoActiveHandbackMarker(): void {
    const detail = parseDetail(this.store.getMigration(this.storeName)?.detail_json);
    if (isObjectRecord(detail.handback) && detail.handback.phase === 'cleanup-pending') {
      throw new Error('handback-cleanup-pending: run `qlb migrate resume`');
    }
    if (detail.intent === 'rollback' || Object.prototype.hasOwnProperty.call(detail, 'rollbackDecision')) {
      throw new Error('rollback-in-progress: run `qlb migrate resume`');
    }
  }

  /** Ambiguous O/L/Oc evidence fails closed, regardless of journal state. */
  private assertNoUnreadableOwnershipClaim(): void {
    if (this.kind === 'pool') return;

    // Do not use ownershipClaim() here: it deliberately returns the first
    // valid claim by precedence, but every claim form is durable evidence and
    // any unreadable form must fail closed.
    const legacyPath = this.legacySidecarPath();
    const unreadableOwnerMap = this.unreadableOwnerMapAt(this.ownerMapPath);
    const unreadableLegacySidecar = legacyPath !== null
      && this.unreadableLegacySidecarAt(legacyPath);
    const unreadableCustomOwnerFile = this.ownerFilePath !== this.ownerMapPath
      && this.ownerFilePath !== legacyPath
      && this.unreadableCustomOwnerFileAt(this.ownerFilePath);
    const unreadablePath = unreadableOwnerMap
      ? this.ownerMapPath
      : unreadableLegacySidecar
        ? legacyPath
        : unreadableCustomOwnerFile
          ? this.ownerFilePath
          : null;
    if (!unreadablePath) return;
    throw Object.assign(
      new Error(`owner-file-orphan: ${unreadablePath} could not be read; inspect and repair it before retrying.`),
      { exitCode: 3 },
    );
  }

  /** C6: a claim without this path's durable evidence must never be cleaned up. */
  private assertNoOrphanOwnershipClaim(): void {
    // C6 classifies the generic paths only; the pool's existing C5 recovery
    // owns its v1 commit-point crash window.
    if (this.kind === 'pool') return;
    const facts = this.ownershipFacts();
    const claim = this.ownershipClaim();
    if (!claim || facts.committed || facts.rollbackInProgress || facts.handbackPending) return;
    const message = claim.kind === 'O'
      ? `owner-file-orphan: QLB has no record of committing ${this.ownerProvider()}, but the shared owner map ${claim.path} has a QLB entry for it. Remove only the ${this.ownerProvider()} entry from that file; do not delete the file (other providers' entries live there).`
      : `owner-file-orphan: QLB has no record of committing ${this.ownerProvider()}, but the owner file ${claim.path} has a QLB entry for it. Remove the file ${claim.path} before retrying.`;
    throw Object.assign(new Error(message), { exitCode: 3 });
  }

  private ownerProvider(): MigrateProvider {
    return (this.provider as MigrateProvider | undefined) ?? 'anthropic';
  }

  private stagingPath(): string {
    return stagingOwnerPath(this.ownerMapPath, this.kind === 'pool' ? undefined : this.ownerProvider());
  }

  private legacySidecarPath(): string | null {
    return this.kind === 'pool'
      ? null
      : join(dirname(this.ownerMapPath), `qlb-owner-${this.ownerProvider()}.json`);
  }

  private ownerEntryPresentAt(path: string): boolean {
    try {
      const entry = readPiOwnerProviders(path)[this.ownerProvider()];
      return !!entry && typeof entry === 'object' && !Array.isArray(entry)
        && (entry as Record<string, unknown>).mode === 'qlb';
    } catch {
      return false;
    }
  }

  private legacySidecarOwned(): boolean {
    const path = this.legacySidecarPath();
    if (!path || !existsSync(path)) return false;
    try {
      const owner: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return !!owner && typeof owner === 'object' && !Array.isArray(owner)
        && (owner as Record<string, unknown>).owner === 'qlb';
    } catch {
      return false;
    }
  }

  private ownerEntryPresent(): boolean {
    // Pool migration continues to read its pre-P7b v1 document until P7b8.
    // A shared v2 map is not an Anthropic claim unless it names Anthropic.
    if (this.kind === 'pool') {
      return hasLegacyPiOwnerEntry(this.ownerFilePath, 'anthropic')
        || this.ownerEntryPresentAt(this.ownerMapPath);
    }
    return this.ownerEntryPresentAt(this.ownerMapPath) || this.legacySidecarOwned();
  }

  /** P7b8 alone may convert the pool's v1 document into the shared v2 map. */
  private refusePoolOwnerMap(): void {
    if (this.kind !== 'pool' || !existsSync(this.ownerMapPath)) return;
    try {
      const owner: unknown = JSON.parse(readFileSync(this.ownerMapPath, 'utf8'));
      if (isObjectRecord(owner) && Object.prototype.hasOwnProperty.call(owner, 'providers')) {
        throw new OwnerMapPresentError();
      }
    } catch (error) {
      if (error instanceof OwnerMapPresentError) throw error;
      // Preserve the pool path's existing v1/malformed-file behavior. Only a
      // parseable document declaring `providers` is the P7b8-only v2 map.
    }
  }

  private staticKeychainLocations(): Array<{ service: string; account: string }> {
    if (this.kind !== 'static-key' || this.ownerProvider() !== 'openrouter') return [];
    return [
      keychainCoords('openrouter', ADAPTER_ACCOUNT_IDS.openrouter, ADAPTER_ACCOUNT_LABELS.openrouter),
      {
        service: qlbKeychainService('openrouter', ADAPTER_ACCOUNT_IDS.openrouter),
        account: ADAPTER_ACCOUNT_LABELS.openrouter,
      },
    ];
  }

  /** Gate coordinates supersede the pre-P7b4 OpenRouter Keychain location. */
  private staticKeychainCoords(): { service: string; account: string } | null {
    for (const coords of this.staticKeychainLocations()) {
      try {
        this.keychain.getSync(coords.service, coords.account);
        return coords;
      } catch {
        // Try the pre-P7b4 coordinates after the gate location.
      }
    }
    return null;
  }

  /** Remove every managed OpenRouter copy; only an absent item is idempotent. */
  private deleteStaticKeychain(): void {
    // Keep the gate credential available until the legacy copy is gone. A
    // non-not-found legacy failure therefore leaves the owner claim and the
    // working gate credential intact for a safe rollback retry.
    for (const coords of this.staticKeychainLocations().reverse()) {
      try {
        this.keychain.deleteSync(coords.service, coords.account);
      } catch (error) {
        if (isCredentialNotFound(error)) continue;
        throw new Error(
          `OpenRouter rollback Keychain delete failed at service=${coords.service} account=${coords.account}`,
        );
      }
    }
  }

  private withOwnerMapLock<T>(fn: () => T): T {
    return withPiAuthLock(join(dirname(this.ownerMapPath), 'auth.json'), () => fn());
  }

  private removePoolOwnerEntry(): void {
    if (hasLegacyPiOwnerEntry(this.ownerFilePath, 'anthropic')) {
      unlinkIfExists(this.ownerFilePath);
    } else if (this.ownerEntryPresentAt(this.ownerMapPath)) {
      this.withOwnerMapLock(() => writePiOwnerEntry(this.ownerMapPath, 'anthropic', false));
    }
  }

  /**
   * S4b: remove the generic path's legacy claims after S4a released its v2
   * entry. The caller already holds Pi's auth.json lock; do not take it (or
   * the owner-map lock) again here.
   */
  private unlinkSingleGrantLegacyOwnerFiles(): string[] {
    const syncedDirectories = new Set<string>();
    const rememberDirectory = (path: string): void => {
      syncedDirectories.add(resolve(dirname(path)));
    };
    const legacySidecar = this.legacySidecarPath();
    if (legacySidecar) {
      unlinkIfExists(legacySidecar);
      rememberDirectory(legacySidecar);
    }

    if (this.ownerFilePath !== this.ownerMapPath) {
      // Oc is a v1 claim only. A v2 map, a foreign v1 document, or no file is
      // not this migration's claim and must survive.
      if (hasLegacyPiOwnerEntry(this.ownerFilePath, this.ownerProvider())) {
        unlinkIfExists(this.ownerFilePath);
        rememberDirectory(this.ownerFilePath);
      }
      return [...syncedDirectories];
    }

    // A custom --owner-file may name qlb-owner.json itself. S4a deliberately
    // leaves its v1 shape alone; distinguish that legacy document from a v2
    // map before deciding whether it is safe to unlink the shared pathname.
    try {
      readPiOwnerProviders(this.ownerMapPath);
      return [...syncedDirectories]; // v2 (or absent): S4a owns this map.
    } catch (error) {
      if (!(error instanceof PiOwnerLegacyError)) throw error;
    }

    const owner: unknown = JSON.parse(readFileSync(this.ownerMapPath, 'utf8'));
    const accounts = isObjectRecord(owner) && Array.isArray(owner.accounts) ? owner.accounts : null;
    const namesOnlyThisProvider = accounts !== null
      && accounts.length > 0
      && accounts.every((account) =>
        isObjectRecord(account) && account.provider === this.ownerProvider(),
      );
    if (!hasLegacyPiOwnerEntry(this.ownerMapPath, this.ownerProvider()) || !namesOnlyThisProvider) {
      throw Object.assign(
        new Error(`owner-file-orphan: ${this.ownerMapPath} is a v1 owner file naming another provider; leave it in place and repair it before retrying.`),
        { exitCode: 3 },
      );
    }
    unlinkIfExists(this.ownerMapPath);
    rememberDirectory(this.ownerMapPath);
    return [...syncedDirectories];
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
    const ownerPresent = this.ownerEntryPresent();
    const ownerStaging = existsSync(this.stagingPath());
    const nativePresent =
      this.kind === 'static-key' ? true : existsSync(this.poolFilePath);
    const prePresent =
      this.kind === 'static-key' ? false : existsSync(preQlbPath(this.poolFilePath));
    const intent = detail.intent === 'rollback';
    const rawHandback = isObjectRecord(detail.handback) && detail.handback.phase === 'cleanup-pending'
      ? detail.handback
      : undefined;
    const handback = rawHandback
      ? {
        ...rawHandback,
        fencedGeneration: rawHandback.fencedGeneration === null
          ? 'not fenced'
          : rawHandback.fencedGeneration,
      }
      : undefined;
    const staticCredential = this.staticKeychainCoords();

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
    if (ownerPresent && (this.kind !== 'static-key' || staticCredential)) piAtNextLaunch = 'QLB works';
    else if (nativePresent) piAtNextLaunch = 'native works';

    const retains = this.retainsNative();
    const staticKey = this.kind === 'static-key';
    let resumeAction: string;
    if (rawHandback) {
      resumeAction = 'hand-back complete, cleanup pending — run `qlb migrate resume`';
    } else if (intent) {
      resumeAction = staticKey
        ? 'continue rollback to VALIDATED (owner unlinked; native Keychain was never moved)'
        : retains
          ? 'continue rollback to NATIVE (owner unlinked; auth.json was never moved)'
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
      resumeAction = this.kind === 'single-grant' ? 'nothing to roll back' : 'noop';
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
      handback,
      nativeStrategy: this.strategy(),
      provider: this.provider,
    };
  }

  /**
   * S2 — copy native credentials into the QLB Keychain as a STAGING copy
   * and write qlb-owner.json.staging. Native file is never written.
   *
   * MIRRORED is journaled (with target account IDs) BEFORE Keychain writes
   * and upsertAccount() so a concurrent `accounts prune` cannot observe an
   * unprotected account row (S1). The later staging-file write does not
   * change the journal payload.
   *
   * Pool (Anthropic): N accounts from anthropic-pool.json.
   * Single-grant: 1 account from a named top-level key in auth.json.
   * Static-key (OpenRouter): 1 API key from native Keychain (read-only).
   */
  stage(): MigrationStatus {
    // D-B68 / OD-10: stage's P7a ownership check and first write share
    // Pi's auth.json lock with `qlb pi migrate`'s started journal write.
    if (this.kind === 'single-grant') {
      this.beforeOwnershipLock?.();
      return withPiAuthLock(resolve(this.poolFilePath), () => this.stageSingleGrant());
    }

    this.assertNotP7aOwned();
    this.assertNoActiveHandbackMarker();
    this.assertNoUnreadableOwnershipClaim();
    this.assertNoOrphanOwnershipClaim();
    // P7b8 alone may convert the pool's v1 owner document into the shared
    // v2 map. Refuse before creating staging, Keychain, or journal state.
    this.refusePoolOwnerMap();
    // OpenRouter publishes into the v2 map, so reject a v1 Anthropic
    // document before creating any staged Keychain or filesystem state.
    if (this.kind === 'static-key') readPiOwnerProviders(this.ownerMapPath);
    const current = this.status();
    if (current.ownerFile === 'present' || current.state === 'QLB_OWNED' || current.state === 'RETIRED') {
      throw new Error(
        `cannot stage: migration already ${current.state} (owner file ${current.ownerFile})`,
      );
    }
    if (this.kind === 'static-key') {
      return this.stageStaticKey();
    }
    if (!existsSync(this.poolFilePath)) {
      throw new Error(`pool file not found: ${this.poolFilePath}`);
    }

    const raw = readFileSync(this.poolFilePath, 'utf8');
    const { accounts } = parsePoolFile(raw);
    const mtime = statSync(this.poolFilePath).mtimeMs;

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
    // Intent journal FIRST so a concurrent prune cannot observe the account
    // row without a MIRRORED journal naming it.
    this.journal('MIRRORED', {
      accounts: owner.accounts,
      qlbAccountIds: owner.qlbAccountIds,
      nativeMtime: mtime,
      poolFilePath: this.poolFilePath,
      ownerFilePath: this.ownerFilePath,
      stagedAt: owner.stagedAt,
    });

    for (const acct of accounts) {
      const { service, account } = keychainCoords(acct.provider, acct.id, acct.label);
      this.keychain.setSync(service, account, JSON.stringify(acct.grant));
      this.store.upsertAccount(acct.id, acct.provider, acct.label, 'imported-unvalidated');
    }

    atomicWriteFile(this.stagingPath(), JSON.stringify(owner, null, 2) + '\n');
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
    this.assertNoUnreadableOwnershipClaim();
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
    if (this.kind === 'single-grant') {
      return withPiAuthLock(resolve(this.poolFilePath), () => this.commitUnlocked());
    }
    return this.commitUnlocked();
  }

  private commitUnlocked(): MigrationStatus {
    this.assertNotP7aOwned();
    this.assertNoActiveHandbackMarker();
    this.assertNoUnreadableOwnershipClaim();
    this.assertNoOrphanOwnershipClaim();
    // P7b8 alone may convert the pool's v1 owner document into the shared
    // v2 map. Refuse before any journal or native-pool write.
    this.refusePoolOwnerMap();
    // OpenRouter must fail closed rather than add providers to a v1 Anthropic
    // document. Read before checking or mutating any migration artifact.
    if (this.kind === 'static-key') readPiOwnerProviders(this.ownerMapPath);
    if (this.ownerEntryPresent()) {
      return this.finishHygiene();
    }
    const staging = this.stagingPath();
    if (!existsSync(staging)) {
      throw new Error(`cannot commit: missing ${staging}`);
    }
    const current = this.status();
    if (current.state !== 'VALIDATED' && current.state !== 'QLB_OWNED') {
      throw new Error(
        `cannot commit from state ${current.state} (rehearse must succeed first)`,
      );
    }

    if (this.kind === 'static-key') {
      this.withOwnerMapLock(() => {
        // Write-ahead journal: a crash after O can still be classified as this
        // path's commit rather than P7a-only ownership.
        this.journal(current.state, { commitStarted: true });
        writePiOwnerEntry(this.ownerMapPath, this.ownerProvider(), true);
      });
      unlinkIfExists(staging);
      return this.finishHygiene();
    }

    if (this.kind === 'single-grant') {
      const account = Array.isArray(current.detail.accounts) ? current.detail.accounts[0] : null;
      const id = isObjectRecord(account) && typeof account.id === 'string' ? account.id : null;
      const generation = id ? this.store.getGrantGeneration(id) : null;
      if (generation === null) throw new Error('single-grant commit has no account generation');
      // Persist the baseline before the commit rename. A crash after the
      // rename can therefore never reinterpret a re-staged grant as a refresh.
      this.journal(current.state, { commitGeneration: generation });
    }

    if (this.kind === 'pool') {
      // The map can have appeared after stage(). Hold the same lock as every
      // v2 writer from the final P7b8 boundary check through the v1 rename.
      this.withOwnerMapLock(() => {
        // Test-only interleaving barrier: a v2 writer started here must wait
        // until this final check and rename have completed.
        this.beforePoolCommitLock?.();
        this.refusePoolOwnerMap();
        renameSync(staging, this.ownerFilePath);
      });
    } else {
      // C — THE ONLY COMMIT POINT (atomic rename on APFS/POSIX).
      renameSync(staging, this.ownerFilePath);
    }
    try {
      chmodSync(this.ownerFilePath, 0o600);
    } catch {
      // best-effort
    }
    return this.finishHygiene();
  }

  /** S3 precondition: a lock timeout refuses `pi-auth-locked` (exit 3) with the decision kept. */
  private withSingleGrantRollbackAuthLock<T>(fn: () => T): T {
    let acquired = false;
    try {
      return withPiAuthLock(
        resolve(this.poolFilePath),
        (refresh) => { acquired = true; return this.holdingPiAuthLock(refresh, fn); },
        this.authLockTiming,
      );
    } catch (error: unknown) {
      // Only a failure to acquire the lock wrote nothing; errors from fn pass through unchanged.
      if (!acquired && error && typeof error === 'object' && (error as { code?: unknown }).code === 'pi-auth-locked') {
        throw Object.assign(error, { exitCode: 3 });
      }
      throw error;
    }
  }

  rollback(): MigrationStatus {
    if (this.kind === 'single-grant') return this.withSingleGrantRollbackAuthLock(() => this.rollbackUnlocked());
    return this.rollbackUnlocked();
  }

  private rollbackUnlocked(): MigrationStatus {
    this.assertNotP7aOwned();
    this.assertNoUnreadableOwnershipClaim();
    const current = this.status();
    const handback = current.detail.handback;
    const facts = this.ownershipFacts();
    // C3 precedes C4: a completed hand-back is terminal except for its
    // idempotent cleanup record, which is shared with resume.
    if (facts.handbackPending && isObjectRecord(handback)) {
      return this.finishCleanupPendingHandback(handback);
    }
    // C4 continues the already-journaled rollback directly. In particular,
    // do not re-journal intent through postCommitRollback or re-rank a
    // recorded decision.
    if (facts.rollbackInProgress) {
      return this.continueRollback();
    }
    // C5: a VALIDATED journal with this path's own commit evidence (`Gen`) is
    // a crash after the commit point. Finish the forward journal transition,
    // then take the ordinary post-commit hand-back path. The pool path is not
    // classified.
    if (this.kind !== 'pool' && this.journalState() === 'VALIDATED') {
      if (facts.committed) this.finishHygiene();
    }
    this.assertNoOrphanOwnershipClaim();
    const ownerPresent = this.claimPresent();
    if (ownerPresent || this.journalState() === 'QLB_OWNED') {
      return this.postCommitRollback();
    }
    // C7-C9: only an active pre-commit migration has rollback work. In
    // particular, a finished single-grant hand-back has no claim or staging
    // file but can intentionally retain K_m; deleting it here would destroy
    // the retained copy on a repeated rollback.
    if (
      this.kind === 'single-grant'
      && this.journalState() !== 'MIRRORED'
      && !existsSync(this.stagingPath())
    ) {
      return this.status();
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
    if (this.kind === 'single-grant') return this.withSingleGrantRollbackAuthLock(() => this.resumeUnlocked());
    return this.resumeUnlocked();
  }

  private resumeUnlocked(): MigrationStatus {
    this.assertNotP7aOwned();
    this.assertNoUnreadableOwnershipClaim();
    const current = this.status();
    const handback = current.detail.handback;
    const facts = this.ownershipFacts();
    // C3 precedes C4: a completed hand-back is already terminal, so resume
    // records S7 rather than falling through to commit's marker refusal.
    if (facts.handbackPending && isObjectRecord(handback)) {
      return this.finishCleanupPendingHandback(handback);
    }

    // C4: a durable decision is already past source selection. On this main
    // Pi's retained native entry satisfies S3's guard, so continue the
    // existing post-commit path without re-ranking or invoking commit().
    if (facts.rollbackInProgress) {
      return this.continueRollback();
    }
    this.assertNoOrphanOwnershipClaim();
    // Any claim, including a custom owner file (Oc), is past C: finish forward.
    if (this.claimPresent()) {
      return this.finishHygiene();
    }
    if (
      current.state === 'QLB_OWNED' &&
      (this.kind === 'static-key' || existsSync(this.poolFilePath))
    ) {
      return this.finishRollbackJournal();
    }
    if (current.state === 'VALIDATED' && existsSync(this.stagingPath())) {
      return this.kind === 'single-grant' ? this.commitUnlocked() : this.commit();
    }
    if (current.state === 'MIRRORED' || existsSync(this.stagingPath())) {
      return this.preCommitRollback();
    }
    // C9: native and unstaged VALIDATED single-grant migrations are at rest.
    // Keep K_m, the journal, and all migration files exactly as they are.
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
      throw new Error(openRouterMissingKeyMessage(NATIVE_OPENROUTER_KEYCHAIN_SERVICE));
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
    this.journal('MIRRORED', {
      accounts: owner.accounts,
      qlbAccountIds: owner.qlbAccountIds,
      ownerFilePath: this.ownerFilePath,
      stagedAt: owner.stagedAt,
      nativeStrategy: 'keychain-retain',
      nativeKeychainService: NATIVE_OPENROUTER_KEYCHAIN_SERVICE,
      provider: this.provider,
      commitStarted: undefined,
    });

    this.keychain.setSync(service, account, JSON.stringify(payload));
    this.store.upsertAccount(id, this.provider, label, 'imported-unvalidated');
    atomicWriteFile(this.stagingPath(), JSON.stringify(owner, null, 2) + '\n');
    return this.status();
  }

  /**
   * S2 for a single OAuth grant in auth.json. Writes Keychain + staging
   * owner file. NEVER writes auth.json.
   */
  private stageSingleGrant(): MigrationStatus {
    // This method is called only while stage() holds Pi's auth.json lock.
    // Keep the P7a ownership classifier here so it is adjacent to the
    // single-grant's first durable write (the MIRRORED journal).
    this.assertNotP7aOwned();
    this.assertNoActiveHandbackMarker();
    this.assertNoUnreadableOwnershipClaim();
    this.assertNoOrphanOwnershipClaim();
    const current = this.status();
    if (current.ownerFile === 'present' || current.state === 'QLB_OWNED' || current.state === 'RETIRED') {
      throw new Error(
        `cannot stage: migration already ${current.state} (owner file ${current.ownerFile})`,
      );
    }
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
      commitGeneration: undefined,
      commitStarted: undefined,
      rollbackDecision: undefined,
      handback: undefined,
      lastRollback: undefined,
    });

    this.store.upsertAccount(id, this.provider, label, 'imported-unvalidated');
    this.store.setAccountStatus(id, 'imported-unvalidated');
    grant.generation = this.store.getGrantGeneration(id) ?? 0;
    this.keychain.setSync(service, account, JSON.stringify(grant));
    atomicWriteFile(this.stagingPath(), JSON.stringify(owner, null, 2) + '\n');
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
    const candidates = [this.stagingPath()];
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

  /** S6a + S6b + S7. C3 removes backups and staging before recording cleanup completion. */
  private finishCleanupPendingHandback(handback: Record<string, unknown>): MigrationStatus {
    const syncedDirectories = new Set<string>();
    const fsyncDirectoryIfPresent = (path: string): boolean => {
      try {
        statSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      this.fsyncDirectory(path);
      return true;
    };
    const fsyncDirectoryOnce = (path: string): void => {
      const canonicalPath = resolve(path);
      if (syncedDirectories.has(canonicalPath)) return;
      if (fsyncDirectoryIfPresent(path)) syncedDirectories.add(canonicalPath);
    };
    if (this.kind === 'single-grant') {
      const authKey = this.singleGrantAuthKey();
      const exactBackup = piAuthBackupPath(this.poolFilePath, authKey);
      const legacyBackup = legacyPiAuthBackupPath(this.poolFilePath, authKey);
      // S6a precedes S6b/S7. Any failure leaves the marker durable so the
      // next resume retries backup removal before clearing the hand-back.
      removePiAuthBackup(this.poolFilePath, authKey);
      // A retry must re-sync backup parents: an earlier unlink may not be
      // durable yet. S6a must be durable before S7 clears the retry marker.
      fsyncDirectoryOnce(dirname(exactBackup));
      fsyncDirectoryOnce(dirname(legacyBackup));
    }
    const staging = this.stagingPath();
    unlinkIfExists(staging);
    // S6b must be durable before S7 clears the retry marker.
    fsyncDirectoryIfPresent(dirname(staging));
    // S6c1: the recorded verdict is the sole deletion authority. Read the
    // Keychain coordinates from the durable journal rather than deriving them
    // from the current migration configuration.
    if (this.kind === 'single-grant' && handback.keychainDisposition === 'delete') {
      const detail = parseDetail(this.store.getMigration(this.storeName)?.detail_json);
      const journalAccount = Array.isArray(detail.accounts) ? detail.accounts[0] : undefined;
      if (
        !isObjectRecord(journalAccount)
        || typeof journalAccount.provider !== 'string'
        || typeof journalAccount.id !== 'string'
        || typeof journalAccount.label !== 'string'
      ) {
        throw new Error('cleanup-pending hand-back has no valid journal account coordinates');
      }
      if (journalAccount.provider !== this.provider) {
        throw new Error(`cleanup-pending hand-back journal names ${journalAccount.provider}, not ${this.provider}`);
      }
      const coords = keychainCoords(journalAccount.provider, journalAccount.id, journalAccount.label);
      try {
        this.keychain.deleteSync(coords.service, coords.account);
      } catch (error) {
        if (!isCredentialNotFound(error)) throw error;
      }
      // S6c2 follows S6c1 so a crash leaves the marker and retry observes
      // the same recorded delete verdict (with not-found treated as done).
      this.afterStep?.('S6c1');
      this.store.setAccountStatus(journalAccount.id, 'handed-back');
    }
    const detail = parseDetail(this.store.getMigration(this.storeName)?.detail_json);
    this.journal(this.journalState(), {
      handback: undefined,
      ...(detail.intent === 'rollback' ? { intent: undefined } : {}),
      rollbackDecision: undefined,
      lastRollback: {
        ...handback,
        rolledBackFrom: 'post-commit',
        cleanedAt: Date.now(),
      },
    });
    return this.status();
  }

  /** H1 + H2. Idempotent. Called after C and by resume() when owner is present. */
  private finishHygiene(): MigrationStatus {
    const now = Date.now();
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
      if (meta.provider === 'openrouter') {
        this.deleteStaticKeychain();
        continue;
      }
      const { service, account } = keychainCoords(meta.provider, meta.id, meta.label);
      try {
        this.keychain.deleteSync(service, account);
      } catch (error) {
        if (isCredentialNotFound(error)) continue;
        throw new Error(
          `migration rollback failed to delete staged Keychain credential for provider=${meta.provider} account=${meta.label}`,
        );
      }
    }
  }

  /**
   * The journal owns the Pi auth.json key once staging has recorded it. A
   * rebuilt default migration must therefore use that durable key, while an
   * explicitly supplied non-default key is an assertion that must agree.
   */
  private singleGrantAuthKey(): string {
    const detail = parseDetail(this.store.getMigration(this.storeName)?.detail_json);
    const journalKey = typeof detail.authJsonKey === 'string' ? detail.authJsonKey : undefined;
    if (journalKey) {
      if (this.authJsonKey && this.authJsonKey !== this.provider && this.authJsonKey !== journalKey) {
        throw new Error('single-grant rollback auth.json key mismatch');
      }
      return journalKey;
    }
    const key = this.authJsonKey ?? this.provider;
    if (!key) throw new Error('single-grant rollback has no auth.json key');
    return key;
  }

  private preCommitRollback(): MigrationStatus {
    // Resolve (and validate) the journaled auth key before any cleanup, so a
    // conflicting key refuses with every staged artifact still in place.
    const authKey = this.kind === 'single-grant' ? this.singleGrantAuthKey() : undefined;
    const owner = this.readOwnerPayload();
    this.deleteStagedKeychain(owner?.accounts);
    unlinkIfExists(this.stagingPath());
    if (authKey !== undefined) removePiAuthBackup(this.poolFilePath, authKey);
    this.journal('NATIVE', { intent: undefined, rolledBackAt: Date.now(), rolledBackFrom: 'pre-commit' });
    return this.status();
  }

  private postCommitRollback(): MigrationStatus {
    this.journal(this.journalState(), {
      intent: 'rollback',
    });
    this.afterStep?.('S1');
    return this.continueRollback();
  }

  private continueRollback(): MigrationStatus {
    if (this.retainsNative()) {
      // Native was never moved (auth.json shadow-retained, or Keychain retained).
      if (this.kind === 'static-key') {
        // Delete both QLB coordinate generations before dropping ownership;
        // a non-not-found failure leaves the claim in place for a safe retry.
        this.deleteStaticKeychain();
        if (this.ownerEntryPresentAt(this.ownerMapPath)) {
          this.withOwnerMapLock(() => writePiOwnerEntry(this.ownerMapPath, this.ownerProvider(), false));
        }
        const legacy = this.legacySidecarPath();
        if (legacy) unlinkIfExists(legacy);
      } else {
        // S2 runs after S1's durable intent. It checks a live refresh lease
        // inside its fence transaction, then waits before the existing un-own
        // path. Once it records a decision, C4 resumes here without ranking
        // again; the decision is copied into S5's marker below.
        const journalAccount = this.singleGrantJournalAccount();
        const authKey = this.singleGrantAuthKey();
        this.decideAndFenceSingleGrantRollback(journalAccount, authKey);
        // S3 under the auth lock that rollback()/resume() hold. Guard (a): a
        // valid native entry (a newer login, or Pi's rotation) is kept and
        // nothing is written. Guard (b) restores the recorded source and
        // verifies it (or refuses native-entry-missing for kind:none); guard
        // (c) keeps an intentionally absent key absent; guard (d) refuses a
        // defined, non-placeholder, invalid entry. All of this precedes the
        // un-own below (OD-4).
        this.singleGrantNativeEntryWins(authKey);
        // Validate and check for a live refresh before un-owning, so a refusal
        // leaves the claim intact.
        this.refuseDuringRefresh(journalAccount.id);
        // S4a: atomic and idempotent, under the owner-map lock. rollback()/resume()
        // already hold Pi's auth.json lock, which is that lock when both files share
        // a directory; it is not re-entrant, so only a different one is taken here.
        // A v1 document at the map path has no v2 entry to remove; the owner-file
        // unlink below handles it, as before S4a.
        const unown = () => {
          try {
            writePiOwnerEntry(this.ownerMapPath, this.ownerProvider(), false);
          } catch (error: unknown) {
            if (!(error instanceof PiOwnerLegacyError)) throw error;
          }
        };
        if (resolve(dirname(this.ownerMapPath), 'auth.json') === resolve(this.poolFilePath)) unown();
        else {
          try {
            this.withOwnerMapLock(unown);
          } catch (error: unknown) {
            // A held owner-map lock is the same refusal as a held auth lock (exit 3).
            if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'pi-auth-locked') {
              throw Object.assign(error, { exitCode: 3 });
            }
            throw error;
          }
        }
        this.afterStep?.('S4a');
        // S4b follows S4a under the already-held auth lock. It unlinks L and
        // only this provider's v1 Oc; it never deletes the shared v2 map.
        // The unlink directories must be durable before S5's terminal marker.
        for (const path of this.unlinkSingleGrantLegacyOwnerFiles()) this.fsyncDirectory(path);
        // The un-own must survive power loss before S5 records the hand-back:
        // resume after S5 never revisits the owner claim.
        // rollback()/resume() already hold Pi's auth.json lock for the whole
        // single-grant path. S5 therefore reads A under that existing lock;
        // withPiAuthLock is not re-entrant.
        return this.recordSingleGrantHandbackAndCleanup(journalAccount, authKey);
      }
      unlinkIfExists(this.stagingPath());
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
      this.removePoolOwnerEntry();
      unlinkIfExists(this.stagingPath());
    } else {
      // Cannot yet drop the owner file — native is not restored. Leave it.
      return this.status();
    }

    return this.finishRollbackJournal();
  }

  private singleGrantJournalAccount(): { provider: string; id: string; label: string } {
    const detail = parseDetail(this.store.getMigration(this.storeName)?.detail_json);
    const journalAccount = Array.isArray(detail.accounts) ? detail.accounts[0] : undefined;
    if (
      !isObjectRecord(journalAccount)
      || typeof journalAccount.provider !== 'string'
      || typeof journalAccount.id !== 'string'
      || typeof journalAccount.label !== 'string'
      || journalAccount.provider !== this.provider
    ) {
      throw new Error('single-grant hand-back has no valid journal account coordinates');
    }
    return { provider: journalAccount.provider, id: journalAccount.id, label: journalAccount.label };
  }

  private readSingleGrantRollbackKeychain(service: string, account: string): Grant | null {
    let raw: string;
    try {
      raw = this.keychain.getSync(service, account);
    } catch (error) {
      if (isCredentialNotFound(error)) return null;
      throw Object.assign(new Error('keychain-unavailable', { cause: error }), { exitCode: 3 });
    }
    try {
      return parseGrant(raw);
    } catch {
      throw Object.assign(new Error('rollback-source-malformed'), { exitCode: 3 });
    }
  }

  /**
   * S2: rank outside the transaction, then atomically verify G and K_m, fence
   * them, and persist the full decision. Lease re-checks land in later rows.
   */
  private decideAndFenceSingleGrantRollback(
    journalAccount: { provider: string; id: string; label: string },
    authKey: string,
  ): void {
    const existing = parseDetail(this.store.getMigration(this.storeName)?.detail_json).rollbackDecision;
    if (existing !== undefined && existing !== null) return;

    class RetryS2 extends Error {}
    // Private control-flow signal: runImmediate rolls back before S2 sleeps.
    class LeaseWaitS2 extends Error {}
    const refreshInProgress = () => Object.assign(new Error('refresh-in-progress'), { exitCode: 3 });
    let leaseWaitStartedAt: number | undefined;
    let attempts = 0;
    while (attempts < 8) {
      const g0 = this.store.getGrantGeneration(journalAccount.id);
      if (g0 === null) throw new Error('single-grant rollback has no account generation');

      const coords = keychainCoords(journalAccount.provider, journalAccount.id, journalAccount.label);
      const keychainGrant = this.readSingleGrantRollbackKeychain(coords.service, coords.account);
      const k0 = keychainGrant?.generation ?? -1;

      const backup = readPiAuthBackup(this.poolFilePath, authKey);
      const exactBackup = backup && existsSync(piAuthBackupPath(this.poolFilePath, authKey)) ? backup : null;
      const legacyBackup = backup && !exactBackup ? backup : null;
      let nativeEntry: unknown;
      let nativeEntryPresent = false;
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.poolFilePath, 'utf8'));
        if (isObjectRecord(parsed)) {
          nativeEntryPresent = Object.prototype.hasOwnProperty.call(parsed, authKey);
          nativeEntry = parsed[authKey];
        }
      } catch {
        // S2 only ranks the read-only native entry; later S3 owns its guards.
      }

      let ranked;
      try {
        ranked = rankSingleGrantSource({
          keychainGrant,
          storeGeneration: g0,
          commitGeneration: (() => {
            const value = parseDetail(this.store.getMigration(this.storeName)?.detail_json).commitGeneration;
            return typeof value === 'number' ? value : undefined;
          })(),
          exactBackup,
          legacyBackup,
          nativeEntryPresent,
          nativeEntry,
        });
      } catch (error) {
        if (error instanceof NoSingleGrantRestoreSourceError) {
          throw Object.assign(
            new Error(`no-restore-source: log in to Pi natively, then run \`qlb migrate resume --provider ${this.provider}\``),
            { exitCode: 3 },
          );
        }
        throw error;
      }
      const decidedAt = this.now();
      const sourceBackup = ranked.kind === 'exact-backup'
        ? exactBackup
        : ranked.kind === 'legacy-backup'
          ? legacyBackup
          : null;
      const record = ranked.kind === 'keychain'
        ? restoreRecordFor({
          authPath: this.poolFilePath,
          key: authKey,
          decidedAt,
          filePresent: true,
          entryPresent: true,
          entry: this.piEntryFromGrant(ranked.grant, backup),
        })
        : ranked.kind === 'none'
          ? null
          // Design §2 S3: a backup kind's record is the normalised backup as
          // readPiAuthBackup returns it, with its own cycleId.
          : sourceBackup;
      const decision: Omit<RollbackDecision, 'fencedGeneration'> = {
        kind: ranked.kind,
        generation: ranked.kind === 'none' ? null : ranked.generation,
        fingerprint: ranked.kind === 'none' ? null : ranked.fingerprint,
        entryPresent: record?.entryPresent ?? nativeEntryPresent,
        sourceDigest: record ? canonicalDigest(record) : null,
        kd0: keychainDigest(keychainGrant),
        decidedAt,
      };
      this.afterStep?.('S2-reads');

      try {
        const fenced = this.store.runImmediate(() => {
          if (this.store.getGrantGeneration(journalAccount.id) !== g0) throw new RetryS2();
          const transactionKeychainGrant = this.readSingleGrantRollbackKeychain(coords.service, coords.account);
          if (keychainDigest(transactionKeychainGrant) !== decision.kd0) throw new RetryS2();
          // S2 (iii): roll back, then wait outside the transaction for a live
          // lease. Expired leases are ignored, like acquireRefreshLease.
          const lease = this.store.getLease(refreshLeaseName(journalAccount.id));
          if (lease && lease.until > this.now()) throw new LeaseWaitS2();
          const fence = fencedGeneration(g0, k0);
          if (this.store.casGrantGeneration(journalAccount.id, g0, fence) !== 1) {
            throw new RetryS2();
          }
          this.journal(this.journalState(), {
            rollbackDecision: { ...decision, fencedGeneration: fence },
          });
          return fence;
        });
        if (fenced >= 0) {
          this.afterStep?.('S2');
          return;
        }
      } catch (error) {
        if (error instanceof LeaseWaitS2) {
          const waitedAt = this.now();
          if (leaseWaitStartedAt === undefined) leaseWaitStartedAt = waitedAt;
          if (waitedAt - leaseWaitStartedAt >= 30_000) throw refreshInProgress();
          // Pi treats auth.json.lock as stale after 10 s of an unchanged mtime.
          this.piAuthLockRefresh?.();
          this.sleepSync(100);
          this.piAuthLockRefresh?.();
          // Re-enter at the outside reads; lease waits do not spend RETRY attempts.
          continue;
        }
        if (error instanceof RetryS2) {
          attempts += 1;
          continue;
        }
        throw error;
      }
    }
    throw refreshInProgress();
  }

  private holdingPiAuthLock<T>(refresh: () => void, fn: () => T): T {
    this.piAuthLockRefresh = refresh;
    try { return fn(); } finally { this.piAuthLockRefresh = undefined; }
  }

  /** S3 guards: retain a valid native entry; otherwise restore the recorded non-none source under the held auth lock. */
  private singleGrantNativeEntryWins(authKey: string): boolean {
    let auth: Record<string, unknown>;
    try {
      auth = this.readSingleGrantAuth();
    } catch {
      // An unreadable or non-object auth.json retains main's existing path.
      return false;
    }

    const entryPresent = Object.prototype.hasOwnProperty.call(auth, authKey);
    const entry = auth[authKey];
    if (entryPresent && this.isValidSingleGrantRestoreEntry(entry, true)) return true;

    const recordedDecision = parseDetail(this.store.getMigration(this.storeName)?.detail_json).rollbackDecision;
    const decision = isObjectRecord(recordedDecision) ? recordedDecision as unknown as RollbackDecision : null;
    // Guard (b): preserve the fenced decision; do not rank again when Pi's
    // formerly valid entry disappears or becomes the P7a placeholder.
    // S2 ranks kind:none only when A was valid, so kind:none itself proves A was
    // present; that also covers decisions recorded before entryPresent was kept.
    if (isPiPlaceholder(entry) || (!entryPresent && (decision?.kind === 'none' || decision?.entryPresent))) {
      if (decision?.kind === 'none') {
        throw Object.assign(new Error('native-entry-missing'), { exitCode: 3 });
      }
      this.restoreRecordedSingleGrantEntry(authKey, decision);
      return true;
    }
    // Guard (c): a recorded absent source is already satisfied and must never
    // resurrect the key on a retry.
    if (!entryPresent && decision?.entryPresent === false) return true;

    // Guard (d): a defined, non-placeholder, invalid entry is never replaced.
    throw Object.assign(new Error('native-entry-invalid'), { exitCode: 3 });
  }

  private restoreRecordedSingleGrantEntry(authKey: string, decision: RollbackDecision | null): void {
    if (!decision || decision.kind === 'none') {
      throw Object.assign(new Error('native-entry-missing'), { exitCode: 3 });
    }

    // Design §2 S3 Materialise: any difference from what S2 recorded,
    // including a source that is now absent or unreadable, is tampering.
    const tampered = () => Object.assign(new Error('rollback-source-tampered'), { exitCode: 3 });
    const readRecordedBackup = (): PiAuthBackup | null => {
      try {
        return readPiAuthBackup(this.poolFilePath, authKey);
      } catch {
        throw tampered();
      }
    };
    let record: PiAuthBackup | null;
    if (decision.kind === 'keychain') {
      const journalAccount = this.singleGrantJournalAccount();
      const coords = keychainCoords(journalAccount.provider, journalAccount.id, journalAccount.label);
      const grant = this.readSingleGrantRollbackKeychain(coords.service, coords.account);
      if (!grant || keychainDigest(grant) !== decision.kd0) throw tampered();
      record = restoreRecordFor({
        authPath: this.poolFilePath,
        key: authKey,
        decidedAt: decision.decidedAt,
        filePresent: true,
        entryPresent: true,
        entry: this.piEntryFromGrant(grant, readRecordedBackup()),
      });
    } else {
      record = readRecordedBackup();
    }
    if (!record || canonicalDigest(record) !== decision.sourceDigest) throw tampered();

    // Check the source before writing: a retry's guard (a) must never find an
    // entry here that the strict verify below would have rejected.
    if (record.entryPresent && !isValidEntry(record.entry)) {
      throw Object.assign(new Error('rollback-source-malformed'), { exitCode: 3 });
    }
    this.restoreSingleGrantPiAuthEntry(authKey, record);
    const restored = this.readSingleGrantAuth();
    const restoredPresent = Object.prototype.hasOwnProperty.call(restored, authKey);
    const restoredEntry = restored[authKey];
    if (
      restoredPresent !== record.entryPresent
      || (record.entryPresent && (!isDeepStrictEqual(restoredEntry, record.entry) || !isValidEntry(restoredEntry)))
    ) {
      throw Object.assign(new Error('restore verification failed'), { exitCode: 3 });
    }
  }

  /** Test seam; callers already hold withPiAuthLock, which is deliberately not re-entrant. */
  private restoreSingleGrantPiAuthEntry(authKey: string, record: PiAuthBackup): unknown {
    return restorePiAuthEntryLocked(this.poolFilePath, authKey, record);
  }

  private isValidSingleGrantRestoreEntry(entry: unknown, entryPresent: boolean): boolean {
    if (!entryPresent) return true;
    return isObjectRecord(entry)
      && !isPiPlaceholder(entry)
      && typeof entry.refresh === 'string'
      && entry.refresh.length > 0;
  }

  private readSingleGrantAuth(): Record<string, unknown> {
    // A directory at auth.json is treated as an unwritable absent file so a
    // later restore (row 37) fails before ownership can be released.
    if (!existsSync(this.poolFilePath) || !statSync(this.poolFilePath).isFile()) return {};
    const parsed: unknown = JSON.parse(readFileSync(this.poolFilePath, 'utf8'));
    if (!isObjectRecord(parsed)) throw new Error('auth.json is not a JSON object');
    return parsed;
  }

  /** Pi's entry for a Keychain grant, keeping the backup entry's other fields (design §2 S3). */
  private piEntryFromGrant(grant: Grant, backup: PiAuthBackup | null): Record<string, unknown> {
    const previous = isObjectRecord(backup?.entry) ? backup.entry : {};
    const type = typeof grant.extra?.type === 'string'
      ? grant.extra.type
      : typeof previous.type === 'string' ? previous.type : 'oauth';
    const accountId = grant.extra?.accountId;
    return {
      ...previous,
      type,
      access: grant.access,
      refresh: grant.refresh,
      expires: grant.expires,
      ...(typeof accountId === 'string' ? { accountId } : {}),
    };
  }

  /**
   * S5's existing post-fence check for a live refresh lease. S2 now checks
   * its lease in the fence transaction and waits in a bounded loop before
   * fencing.
   */
  private refuseDuringRefresh(accountId: string): void {
    const lease = this.store.getLease(refreshLeaseName(accountId));
    if (lease && lease.until > this.now()) throw new Error('refresh-in-progress');
  }

  /** S5, followed by the existing C3 path (S6 → S7). Caller holds Pi's auth lock. */
  private recordSingleGrantHandbackAndCleanup(
    journalAccount: { provider: string; id: string; label: string },
    authKey: string,
  ): MigrationStatus {
    let piEntry: unknown = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.poolFilePath, 'utf8'));
      if (isObjectRecord(parsed)) piEntry = parsed[authKey];
    } catch {
      // An unreadable or malformed Pi entry is invalid for the S5 verdict.
      piEntry = null;
    }

    const coords = keychainCoords(journalAccount.provider, journalAccount.id, journalAccount.label);
    let kmRead: unknown = null;
    try {
      const raw = this.keychain.getSync(coords.service, coords.account);
      try {
        kmRead = JSON.parse(raw);
      } catch {
        // S5 treats a malformed payload as a non-match, never as delete.
        kmRead = null;
      }
    } catch (error) {
      if (!isCredentialNotFound(error)) {
        // The pre-existing rollback intent remains durable because S5 has not
        // written its terminal row yet.
        throw new Error('keychain-unavailable', { cause: error });
      }
    }

    // A refresh that took its lease after the pre-unlink check may still be
    // live around the K_m read above.
    this.refuseDuringRefresh(journalAccount.id);

    const verdict = handbackVerdict(kmRead, piEntry);
    const recordedDecision = parseDetail(this.store.getMigration(this.storeName)?.detail_json).rollbackDecision;
    const decision = isObjectRecord(recordedDecision) ? recordedDecision as unknown as RollbackDecision : null;
    const handback = {
      phase: 'cleanup-pending' as const,
      keychainDisposition: verdict.keychainDisposition,
      piFingerprint: verdict.piFingerprint,
      decision,
      fencedGeneration: decision?.fencedGeneration ?? null,
      rolledBackAt: Date.now(),
    };
    // This is S5's sole durable write. Its full marker shape is complete from
    // the first write, before the C3 cleanup can delete any artifacts.
    this.journal('NATIVE', {
      intent: undefined,
      rollbackDecision: undefined,
      commitGeneration: undefined,
      handback,
    });
    this.afterStep?.('S5');
    return this.finishCleanupPendingHandback(handback);
  }

  /** RH1 + RH2 */
  private finishRollbackJournal(): MigrationStatus {
    if (this.kind !== 'static-key' && this.poolFilePath) {
      unlinkIfExists(sidecarPath(this.poolFilePath));
      unlinkIfExists(preQlbPath(this.poolFilePath));
    }
    this.journal('VALIDATED', {
      intent: undefined,
      commitGeneration: undefined,
      commitStarted: undefined,
      rollbackDecision: undefined,
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
  config: Omit<MigrationConfig, 'kind' | 'provider' | 'authJsonKey'> = {},
): Migration {
  return new Migration(
    store,
    keychain,
    authJsonPath,
    ownerFilePath,
    migrationStoreNameFor(provider),
    { ...config, kind: 'single-grant', provider, authJsonKey: keyName },
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
