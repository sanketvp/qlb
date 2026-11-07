import type { DatabaseSync } from 'node:sqlite';
import { newerSchemaMessage, readUserVersion, SCHEMA_VERSION } from './schema-version';

const DIAGNOSTIC_COLUMNS = [
  'codex_diag_class', 'codex_diag_http_status', 'codex_diag_endpoint',
  'codex_diag_fallback_attempted', 'codex_diag_parser_shape', 'codex_diag_entitlement_evidence',
] as const;

/** Refuses a read that would need a migration, without opening a writable store. */
export function readOnlyCodexDiagnosticSchemaRefusal(db: DatabaseSync): 'schema-migration-required' | null {
  const version = readUserVersion(db);
  if (version > SCHEMA_VERSION) throw new Error(newerSchemaMessage(version));
  if (version !== SCHEMA_VERSION) return 'schema-migration-required';
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_polls'").get();
  if (!table) return 'schema-migration-required';
  const columns = new Set((db.prepare('PRAGMA table_info(usage_polls)').all() as Array<{ name: string }>).map((row) => row.name));
  return DIAGNOSTIC_COLUMNS.every((column) => columns.has(column)) ? null : 'schema-migration-required';
}
