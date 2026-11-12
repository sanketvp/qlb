import { DatabaseSync } from 'node:sqlite';

import type { Store } from '../../src/store';

export function insertAdoptionSlot(
  dbPath: string,
  slot: { accountId: string; email?: string | null; dead?: boolean; archivedAt?: number | null },
): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT INTO claude_slots (account_id, email, config_json, dead, added_at, archived_at)
    VALUES (?, ?, '{}', ?, ?, ?)`).run(
    slot.accountId,
    slot.email ?? null,
    slot.dead ? 1 : 0,
    1,
    slot.archivedAt ?? null,
  );
  db.close();
}

export function seedActiveSlots(
  store: Store,
  slots: ReadonlyArray<{ accountId: string; email?: string | null; dead?: boolean; archivedAt?: number | null }>,
  activeAccountId: string,
): void {
  for (const slot of slots) insertAdoptionSlot(store.dbPath, slot);
  store.setActiveLogin('anthropic', activeAccountId, 'auto', 1);
}
