// Shared migration-health classifier used by `qlb doctor` and `accounts prune`.
//
// Three-way result, never coerced:
//   terminal — proven complete (NATIVE, well-formed QLB_OWNED/RETIRED, or a
//              completed post-commit rollback VALIDATED)
//   active   — proven in-flight (MIRRORED, or VALIDATED with owner/staging present)
//   unknown  — malformed/ambiguous; prune refuses, doctor warns
//
// Terminal VALIDATED requires affirmative evidence matching the actual
// rollback writer (`Migration.finishRollbackJournal`):
//   state VALIDATED, rolledBackFrom === 'post-commit', strictly valid ID
//   metadata, an explicit non-empty string ownerFilePath (never a guessed
//   default), and both owner + staging files absent. Filesystem errors are
//   unknown, not absent.

import { statSync } from 'node:fs';
import type { QlbConfig } from './config';

export type ParseAccountIdsResult =
  | { ok: true; ids: Set<string> }
  | { ok: false };

export type MigrationHealth = 'terminal' | 'active' | 'unknown';

export type OwnerPresence = 'present' | 'staging' | 'absent' | 'unknown';

/**
 * Parse a migration `detail_json` into the set of account IDs it names.
 * Returns `{ ok: false }` on ANY parse failure or wrong-shaped payload —
 * callers must treat that as untrusted, not as "no owned accounts".
 * Every `qlbAccountIds` entry and every `accounts[].id` must be a non-empty
 * string; empty strings fail the whole row.
 */
export function parseAccountIds(detailJson: string | null | undefined): ParseAccountIdsResult {
  if (detailJson == null || detailJson === '') return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(detailJson);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }
  const detail = parsed as { qlbAccountIds?: unknown; accounts?: unknown };
  const hasQlb = Object.prototype.hasOwnProperty.call(detail, 'qlbAccountIds');
  const hasAccounts = Object.prototype.hasOwnProperty.call(detail, 'accounts');
  if (!hasQlb && !hasAccounts) return { ok: false };

  const ids = new Set<string>();
  if (hasQlb) {
    if (!Array.isArray(detail.qlbAccountIds)) return { ok: false };
    for (const id of detail.qlbAccountIds) {
      if (typeof id !== 'string' || id.length === 0) return { ok: false };
      ids.add(id);
    }
  }
  if (hasAccounts) {
    if (!Array.isArray(detail.accounts)) return { ok: false };
    for (const account of detail.accounts) {
      if (!account || typeof account !== 'object' || Array.isArray(account)) {
        return { ok: false };
      }
      const id = (account as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0) return { ok: false };
      ids.add(id);
    }
  }
  return { ok: true, ids };
}

function parseDetailStrict(
  raw: string | null | undefined,
): { ok: true; detail: Record<string, unknown> } | { ok: false } {
  if (raw == null || raw === '') return { ok: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, detail: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function explicitOwnerPath(detail: Record<string, unknown>): string | null {
  const path = detail.ownerFilePath;
  if (typeof path !== 'string' || path.length === 0) return null;
  return path;
}

function pathPresence(path: string): 'present' | 'absent' | 'unknown' {
  try {
    statSync(path);
    return 'present';
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err
      ? (err as { code: unknown }).code
      : undefined;
    if (code === 'ENOENT') return 'absent';
    return 'unknown';
  }
}

/** Owner file, staging file, both absent, or unreadable. Never guesses a path. */
export function inspectOwnerPresence(ownerPath: string): OwnerPresence {
  const owner = pathPresence(ownerPath);
  if (owner === 'unknown') return 'unknown';
  if (owner === 'present') return 'present';
  const staging = pathPresence(`${ownerPath}.staging`);
  if (staging === 'unknown') return 'unknown';
  if (staging === 'present') return 'staging';
  return 'absent';
}

function classifyValidated(detailJson: string | null | undefined): MigrationHealth {
  const ids = parseAccountIds(detailJson);
  if (!ids.ok) return 'unknown';
  const parsed = parseDetailStrict(detailJson);
  if (!parsed.ok) return 'unknown';
  const ownerPath = explicitOwnerPath(parsed.detail);
  if (!ownerPath) return 'unknown';
  const presence = inspectOwnerPresence(ownerPath);
  if (presence === 'unknown') return 'unknown';
  if (presence === 'present' || presence === 'staging') return 'active';
  if (parsed.detail.rolledBackFrom === 'post-commit') return 'terminal';
  return 'unknown';
}

/**
 * Classify a journal row. Does not guess default owner paths and does not
 * treat parse failure as `{}` / absent.
 */
export function classifyMigration(migration: {
  store: string;
  state: string;
  detail_json?: string;
}): MigrationHealth {
  if (migration.state === 'NATIVE') return 'terminal';
  if (migration.state === 'QLB_OWNED' || migration.state === 'RETIRED') {
    return parseAccountIds(migration.detail_json).ok ? 'terminal' : 'unknown';
  }
  if (migration.state === 'MIRRORED') {
    return parseAccountIds(migration.detail_json).ok ? 'active' : 'unknown';
  }
  if (migration.state === 'VALIDATED') {
    return classifyValidated(migration.detail_json);
  }
  return 'unknown';
}

/**
 * Doctor WARN predicate: anything that is not a proven terminal state.
 * Optional `config` is accepted for call-site compatibility but is not used
 * to guess owner paths.
 */
export function isStuckMigration(
  migration: { store: string; state: string; detail_json?: string },
  _config?: QlbConfig,
): boolean {
  return classifyMigration(migration) !== 'terminal';
}
