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
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { KeychainBackend } from './keychain';
import { qlbKeychainService } from './keychain';
import { parseGrant } from './refresh-lease';
import type { Store } from './store';
import type { Grant } from './types';

export const DEFAULT_POOL_FILE = join(homedir(), '.pi', 'agent', 'anthropic-pool.json');
export const DEFAULT_OWNER_FILE = join(homedir(), '.pi', 'agent', 'qlb-owner.json');
export const PI_POOL_STORE = 'pi-pool';

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
  return resolve(join(homedir(), '.pi', 'agent'));
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
  if (account.provider !== 'anthropic') {
    return { ok: false, error: `no default rehearse implementation for ${account.provider}` };
  }
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${account.grant.access}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, error: `rehearse HTTP ${res.status}` };
    }
    return { ok: true };
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

  constructor(
    store: Store,
    keychain: KeychainBackend,
    poolFilePath: string,
    ownerFilePath: string,
    storeName: string = PI_POOL_STORE,
  ) {
    this.store = store;
    this.keychain = keychain;
    this.poolFilePath = poolFilePath;
    this.ownerFilePath = ownerFilePath;
    this.storeName = storeName;
  }

  status(): MigrationStatus {
    const row = this.store.getMigration(this.storeName);
    const state = asState(row?.state);
    const detail = parseDetail(row?.detail_json);
    const ownerPresent = existsSync(this.ownerFilePath);
    const ownerStaging = existsSync(stagingOwnerPath(this.ownerFilePath));
    const nativePresent = existsSync(this.poolFilePath);
    const prePresent = existsSync(preQlbPath(this.poolFilePath));
    const intent = detail.intent === 'rollback';

    let ownerFile: MigrationStatus['ownerFile'] = 'absent';
    if (ownerPresent) ownerFile = 'present';
    else if (ownerStaging) ownerFile = 'staging';

    let nativeStore: MigrationStatus['nativeStore'] = 'missing';
    if (nativePresent && prePresent) nativeStore = 'both';
    else if (nativePresent) nativeStore = 'intact';
    else if (prePresent) nativeStore = 'pre-qlb';

    let piAtNextLaunch: MigrationStatus['piAtNextLaunch'] = 'unknown';
    if (ownerPresent) piAtNextLaunch = 'QLB works';
    else if (nativePresent) piAtNextLaunch = 'native works';

    let resumeAction: string;
    if (intent) {
      resumeAction = 'continue rollback to VALIDATED (native restored, owner unlinked)';
    } else if (ownerPresent && STATE_RANK[state] < STATE_RANK.QLB_OWNED) {
      resumeAction = 'already committed; finish hygiene (H1–H2) → QLB_OWNED';
    } else if (ownerPresent && nativePresent && !prePresent) {
      resumeAction = 'finish hygiene: rename native → .pre-qlb';
    } else if (ownerPresent) {
      resumeAction = 'noop (already QLB_OWNED)';
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
    };
  }

  /**
   * S2 — copy native pool credentials into the QLB Keychain as a STAGING
   * copy and write qlb-owner.json.staging. Native file is never written.
   */
  stage(): MigrationStatus {
    const current = this.status();
    if (current.ownerFile === 'present' || current.state === 'QLB_OWNED' || current.state === 'RETIRED') {
      throw new Error(
        `cannot stage: migration already ${current.state} (owner file ${current.ownerFile})`,
      );
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
      existsSync(this.poolFilePath)
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
      const grant = parseGrant(this.keychain.getSync(service, account));
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
    unlinkIfExists(sidecarPath(this.poolFilePath));
    unlinkIfExists(preQlbPath(this.poolFilePath));
    this.journal('VALIDATED', {
      intent: undefined,
      rolledBackAt: Date.now(),
      rolledBackFrom: 'post-commit',
    });
    return this.status();
  }
}
