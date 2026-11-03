import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 5;

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as
    | { user_version?: number }
    | number
    | undefined;
  if (typeof row === 'number') return row;
  if (row && typeof row.user_version === 'number') return row.user_version;
  return 0;
}

export function newerSchemaMessage(version: number): string {
  return `qlb.db schema user_version=${version} is newer than this binary (${SCHEMA_VERSION}); upgrade qlb`;
}
