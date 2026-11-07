import type { DatabaseSync } from 'node:sqlite';
import { newerSchemaMessage, readUserVersion, SCHEMA_VERSION } from './schema-version';

/** Refuses a read that would need a migration, without opening a writable store. */
export function readOnlyCodexDiagnosticSchemaRefusal(db: DatabaseSync): 'schema-migration-required' | null {
  const version = readUserVersion(db);
  if (version > SCHEMA_VERSION) throw new Error(newerSchemaMessage(version));
  return version === SCHEMA_VERSION ? null : 'schema-migration-required';
}
