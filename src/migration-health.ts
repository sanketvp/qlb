// Shared migration-health helpers used by `qlb doctor` and `accounts prune`.
// The VALIDATED state is overloaded: in-flight (rehearsal succeeded, not yet
// committed — owner file present or staging) vs terminal (post-commit rollback
// completed — owner file absent). Both callers must use this same distinction.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { QlbConfig } from './config';

export function parseMigrationDetail(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

export function ownerPathForMigrationStore(
  store: string,
  config: QlbConfig,
  detail: Record<string, unknown>,
): string {
  if (typeof detail.ownerFilePath === 'string' && detail.ownerFilePath.length > 0) {
    return detail.ownerFilePath;
  }
  const dir = dirname(config.piAuthJsonPath);
  if (store === 'pi-pool') return join(dir, 'qlb-owner.json');
  const provider = store.startsWith('pi-') ? store.slice(3) : store;
  return join(dir, `qlb-owner-${provider}.json`);
}

export function ownerFilePresence(ownerPath: string): 'absent' | 'staging' | 'present' {
  if (existsSync(ownerPath)) return 'present';
  if (existsSync(`${ownerPath}.staging`)) return 'staging';
  return 'absent';
}

/**
 * Incomplete / mid-flight migrations WARN. Terminal states PASS:
 * NATIVE, QLB_OWNED, RETIRED, and post-rollback VALIDATED with ownerFile absent.
 */
export function isStuckMigration(
  migration: { store: string; state: string; detail_json?: string },
  config: QlbConfig,
): boolean {
  if (migration.state === 'NATIVE' || migration.state === 'QLB_OWNED' || migration.state === 'RETIRED') {
    return false;
  }
  if (migration.state === 'VALIDATED') {
    const detail = parseMigrationDetail(migration.detail_json);
    const ownerPath = ownerPathForMigrationStore(migration.store, config, detail);
    return ownerFilePresence(ownerPath) !== 'absent';
  }
  return true;
}
