// Phase 4 — native Claude Code / Codex CLI credential-store retirement.
//
// TOOLING ONLY. Real retirement is gated by:
//   1. migration state QLB_OWNED (or later)
//   2. ≥ 7 days since the migration commit timestamp
//   3. ≥ 20 clean proxied decisions and zero unresolved failed/auth_* flags
//   4. opts.confirmRealRetirement === true
//   5. a live native ping immediately before the rename
//
// Spec §4.8.3 / §6 Phase 4: native CC/Codex-CLI stores are renamed to
// `.pre-qlb` + sidecar; they are never deleted. This module must not be
// invoked against real paths until the soak window has actually elapsed.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { CODEX_GATE_CONFIG_KEY } from './codex-gate';
import { config } from './config';
import { atomicWriteFile, preQlbPath, sidecarPath } from './migration';
import type { DecisionRow, MigrationRow, Store } from './store';

const execFileAsync = promisify(execFile);

export type RetireHarness = 'claude-code' | 'codex-cli';

export const RETIRE_HARNESSES: readonly RetireHarness[] = ['claude-code', 'codex-cli'];

export const SOAK_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_OK_DECISIONS = 20;

const OWNED_OR_LATER = new Set(['QLB_OWNED', 'RETIRED']);

const OK_MODES = new Set([
  'proxy',
  'headroom',
  'all-in',
  'fallback',
  'fallback-all-in',
]);

export function isRetireHarness(value: string | undefined): value is RetireHarness {
  return value === 'claude-code' || value === 'codex-cli';
}

export function defaultNativePathForHarness(harness: RetireHarness): string {
  if (harness === 'codex-cli') {
    return config.codexAuthJsonPath;
  }
  // The library API is file-path based so tests can point at a fixture; the
  // configurable CLI default is the conventional Claude Code export path.
  return config.claudeCodeCredentialsPath;
}

/** Proxy records Codex traffic as harness `codex`; the retire CLI uses `codex-cli`. */
export function decisionHarnessNames(harness: RetireHarness): string[] {
  if (harness === 'codex-cli') return ['codex-cli', 'codex'];
  return ['claude-code'];
}

export type PingFn = () => Promise<boolean>;

export interface RetirementEligibility {
  eligible: boolean;
  reasons: string[];
  harness: RetireHarness;
  migrationState: string | null;
  committedAt: number | null;
  okDecisionCount: number;
  failedDecisionCount: number;
  soakMsRequired: number;
  soakMsElapsed: number | null;
}

export interface RetireNativeStoreOpts {
  nativePathToRemove: string;
  confirmRealRetirement: boolean;
  pingFn: PingFn;
  now?: number;
}

export interface RetireNativeStoreResult {
  ok: true;
  harness: RetireHarness;
  state: 'RETIRED';
  nativePathRemoved: string;
  backupPath: string;
  sidecarPath: string;
  retiredAt: number;
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

function committedAtOf(row: MigrationRow | null): number | null {
  if (!row) return null;
  const detail = parseDetail(row.detail_json);
  if (typeof detail.committedAt === 'number' && Number.isFinite(detail.committedAt)) {
    return detail.committedAt;
  }
  if (typeof row.updated_at === 'number' && row.updated_at > 0) {
    return row.updated_at;
  }
  return null;
}

/**
 * The `decisions` table has no `outcome` column. Classify from:
 *   - explicit `snapshot_json.outcome` (`ok` | `failed`) when present
 *   - `auth_*` in mode/reason → failed (spec: zero auth_* errors)
 *   - successful proxy/resolve modes → ok
 */
export function classifyDecisionOutcome(row: Pick<DecisionRow, 'mode' | 'reason' | 'snapshot_json'>):
  | 'ok'
  | 'failed'
  | 'other' {
  let explicit: string | undefined;
  try {
    const parsed: unknown = JSON.parse(row.snapshot_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const outcome = (parsed as { outcome?: unknown }).outcome;
      if (typeof outcome === 'string') explicit = outcome;
    }
  } catch {
    // unreadable snapshot_json — fall through to mode/reason
  }

  const authFlag = /\bauth_[a-z0-9_]+/i.test(row.reason) || /\bauth_[a-z0-9_]+/i.test(row.mode);
  if (explicit === 'failed' || authFlag || row.mode === 'failed') {
    return 'failed';
  }
  if (explicit === 'ok') return 'ok';
  if (OK_MODES.has(row.mode)) return 'ok';
  return 'other';
}

function codexGateBlocks(store: Store): string | null {
  const raw = store.getConfig(CODEX_GATE_CONFIG_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { verdict?: unknown }).verdict === 'NO-GO'
    ) {
      return 'Codex CLI gate returned NO-GO; this harness is excluded from Phase 4 retirement';
    }
  } catch {
    return null;
  }
  return null;
}

export function checkRetirementEligibility(
  store: Store,
  harness: RetireHarness,
  now: number = Date.now(),
): RetirementEligibility {
  const reasons: string[] = [];
  const row = store.getMigration(harness);
  const migrationState = row?.state ?? null;
  const committedAt = committedAtOf(row);

  if (!row) {
    reasons.push(`no migration recorded for harness '${harness}'`);
    reasons.push('migration state is not QLB_OWNED');
  } else if (!OWNED_OR_LATER.has(row.state)) {
    reasons.push(`migration state is ${row.state}, not QLB_OWNED or later`);
  }

  let soakMsElapsed: number | null = null;
  if (committedAt == null) {
    reasons.push('soak period not met: no migration commit timestamp (need 7 days)');
  } else {
    soakMsElapsed = now - committedAt;
    if (soakMsElapsed < SOAK_MS) {
      const days = soakMsElapsed / (24 * 60 * 60 * 1000);
      reasons.push(
        `soak period not met: ${days.toFixed(1)} of 7 days have elapsed since migration commit`,
      );
    }
  }

  const sinceTs = committedAt ?? 0;
  const decisions = store.listDecisions({
    harnesses: decisionHarnessNames(harness),
    sinceTs,
  });
  let okDecisionCount = 0;
  let failedDecisionCount = 0;
  for (const d of decisions) {
    const outcome = classifyDecisionOutcome(d);
    if (outcome === 'ok') okDecisionCount += 1;
    else if (outcome === 'failed') failedDecisionCount += 1;
  }

  if (okDecisionCount < MIN_OK_DECISIONS) {
    reasons.push(
      `only ${okDecisionCount} of ${MIN_OK_DECISIONS} clean (outcome=ok) decisions recorded for harness '${harness}'`,
    );
  }
  if (failedDecisionCount > 0) {
    reasons.push(
      `${failedDecisionCount} unresolved failed decision(s) in the soak window (outcome=failed / auth_* rollback flag)`,
    );
  }

  if (harness === 'codex-cli') {
    const blocked = codexGateBlocks(store);
    if (blocked) reasons.push(blocked);
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    harness,
    migrationState,
    committedAt,
    okDecisionCount,
    failedDecisionCount,
    soakMsRequired: SOAK_MS,
    soakMsElapsed,
  };
}

function refuse(message: string): never {
  throw new Error(message);
}

function assertSafeFilePath(nativePath: string): string {
  if (!nativePath || typeof nativePath !== 'string') {
    refuse('REFUSED: nativePathToRemove is required');
  }
  const resolved = resolve(nativePath);
  if (resolved === '/' || resolved === homedir() || resolved === dirname(homedir())) {
    refuse(`REFUSED: nativePathToRemove is not a credential file: ${resolved}`);
  }
  if (resolved.endsWith(sep)) {
    refuse(`REFUSED: nativePathToRemove must be a file, not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Live ping used by the CLI. Tests inject a mock and never take this path.
 * `claude -p ping` / `codex exec ping` — returns false on any failure.
 */
export async function defaultPingFn(harness: RetireHarness): Promise<boolean> {
  try {
    if (harness === 'claude-code') {
      await execFileAsync('claude', ['-p', 'ping'], { timeout: 15_000 });
    } else {
      await execFileAsync('codex', ['exec', 'ping'], { timeout: 15_000 });
    }
    return true;
  } catch {
    return false;
  }
}

export async function retireNativeStore(
  store: Store,
  harness: RetireHarness,
  opts: RetireNativeStoreOpts,
): Promise<RetireNativeStoreResult> {
  const now = opts.now ?? Date.now();
  const eligibility = checkRetirementEligibility(store, harness, now);
  if (!eligibility.eligible) {
    refuse(
      `REFUSED: harness '${harness}' is not eligible for native-store retirement:\n` +
        eligibility.reasons.map((r) => `  - ${r}`).join('\n'),
    );
  }
  if (opts.confirmRealRetirement !== true) {
    refuse(
      'REFUSED: confirmRealRetirement is required to retire a native credential store ' +
        '(pass --confirm-real-retirement)',
    );
  }

  const pingOk = await opts.pingFn();
  if (!pingOk) {
    refuse('REFUSED: live native ping failed; native access is not confirmed working');
  }

  const nativePath = assertSafeFilePath(opts.nativePathToRemove);
  if (!existsSync(nativePath)) {
    refuse(`REFUSED: native path does not exist: ${nativePath}`);
  }
  try {
    if (statSync(nativePath).isDirectory()) {
      refuse(`REFUSED: nativePathToRemove is a directory: ${nativePath}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    refuse(`REFUSED: cannot stat native path ${nativePath}: ${msg}`);
  }

  const backup = preQlbPath(nativePath);
  const sidecar = sidecarPath(nativePath);
  if (existsSync(backup)) {
    refuse(`REFUSED: backup already exists at ${backup}; will not overwrite`);
  }

  const bytes = readFileSync(nativePath);
  const fingerprint = createHash('sha256').update(bytes).digest('hex');

  // Rename is the retirement commit point (mirrors Phase 2 H2). Original
  // path is gone afterwards; contents live at `.pre-qlb`.
  renameSync(nativePath, backup);
  atomicWriteFile(
    sidecar,
    JSON.stringify(
      {
        retiredAt: now,
        harness,
        nativePath,
        backupPath: backup,
        fingerprint,
        qlbAccountIds: [],
      },
      null,
      2,
    ) + '\n',
  );

  const prev = store.getMigration(harness);
  const detail = {
    ...parseDetail(prev?.detail_json),
    retiredAt: now,
    retiredPath: nativePath,
    backupPath: backup,
    sidecarPath: sidecar,
    fingerprint,
  };
  store.upsertMigration(harness, 'RETIRED', JSON.stringify(detail), now);

  return {
    ok: true,
    harness,
    state: 'RETIRED',
    nativePathRemoved: nativePath,
    backupPath: backup,
    sidecarPath: sidecar,
    retiredAt: now,
  };
}
