import { DatabaseSync } from 'node:sqlite';

import { codexFingerprint, codexIdentity, type CodexAuthDocument } from './codex-auth';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from './keychain';
import type { Store } from './store';

const PROVIDER = 'openai-codex';
const BASELINE_CONSUMED_BY_KEY = 'pi.openai-codex.baselineConsumedBy';

type SqlStore = Pick<Store, 'dbPath'>;
type Keychain = Pick<KeychainBackend, 'getSync' | 'setSync'>;
type JsonObject = Record<string, unknown>;

export interface CodexImportPlan {
  chatgptUserId: string;
  accountId: string;
  slotId: string;
}

export interface ImportActiveCodexDeps {
  store: SqlStore;
  keychain: Keychain;
  /** The Pi entry observed before openai-codex migration, if it is available. */
  piBaseline?: unknown;
  now?: () => number;
  /** Test seam for the SQLite transaction; production opens a short-lived connection. */
  withDb?: <T>(store: SqlStore, fn: (db: DatabaseSync) => T) => T;
}

interface ExistingSlot {
  fingerprint: string | null;
  prev_fingerprint: string | null;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function idTokenAuthClaims(doc: CodexAuthDocument): JsonObject | null {
  try {
    const payload = doc.tokens.id_token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    const claims = object(decoded)?.['https://api.openai.com/auth'];
    return object(claims);
  } catch {
    return null;
  }
}

/** Extracts the S29 identity fields without retaining any token values. */
export function planImportActiveCodex(doc: CodexAuthDocument): CodexImportPlan {
  const claims = idTokenAuthClaims(doc);
  const chatgptUserId = claims?.chatgpt_user_id;
  const accountId = doc.tokens.account_id || claims?.chatgpt_account_id;
  const slotId = codexIdentity(doc);
  if (!nonEmpty(chatgptUserId) || !nonEmpty(accountId) || !slotId) {
    throw new Error('Codex auth.json has no S29 identity');
  }
  const expected = `${chatgptUserId}:${accountId}`;
  if (slotId !== expected) throw new Error('Codex auth.json has an invalid S29 identity');
  return { chatgptUserId, accountId, slotId };
}

function withDatabase<T>(store: SqlStore, fn: (db: DatabaseSync) => T): T {
  // A Store intentionally owns its in-memory connection. File-backed stores
  // use a short-lived connection so this module does not reach into Store.
  if (store.dbPath === ':memory:') return fn((store as unknown as { db: DatabaseSync }).db);
  const db = new DatabaseSync(store.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

function piBaselineMatches(doc: CodexAuthDocument, baseline: unknown): boolean {
  const entry = object(baseline);
  return nonEmpty(entry?.refresh) && entry.refresh === doc.tokens.refresh_token;
}

function existingSlot(db: DatabaseSync, slotId: string): ExistingSlot | undefined {
  return db.prepare('SELECT fingerprint, prev_fingerprint FROM codex_slots WHERE account_id = ?')
    .get(slotId) as ExistingSlot | undefined;
}

/**
 * S29/S46 import primitive. It stores the complete native auth document in
 * the injected credential backend, then commits the slot, status account,
 * active identity, and lineage graph in one SQLite transaction.
 */
export function importActiveCodexSlot(doc: CodexAuthDocument, deps: ImportActiveCodexDeps): CodexImportPlan {
  const plan = planImportActiveCodex(doc);
  const now = deps.now ?? Date.now;
  const fingerprint = codexFingerprint(doc);
  const storeDb = deps.withDb ?? withDatabase;
  const previous = storeDb(deps.store, (db) => existingSlot(db, plan.slotId));
  const service = qlbKeychainService(PROVIDER, plan.slotId);

  // A prior managed slot gets an explicit predecessor copy before its current
  // document changes. A new import never probes unrelated Keychain items.
  if (previous?.fingerprint && previous.fingerprint !== fingerprint) {
    const oldDocument = deps.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
    deps.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, oldDocument);
  }
  deps.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(doc));

  storeDb(deps.store, (db) => {
    const timestamp = now();
    const previousFingerprint = previous?.fingerprint && previous.fingerprint !== fingerprint
      ? previous.fingerprint
      : previous?.prev_fingerprint ?? null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO codex_slots (
        account_id, chatgpt_user_id, chatgpt_account_id, fingerprint, prev_fingerprint,
        last_refresh, dead, pending_adopt, added_at, last_active_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'import-active')
      ON CONFLICT(account_id) DO UPDATE SET
        chatgpt_user_id = excluded.chatgpt_user_id,
        chatgpt_account_id = excluded.chatgpt_account_id,
        fingerprint = excluded.fingerprint,
        prev_fingerprint = excluded.prev_fingerprint,
        last_refresh = excluded.last_refresh,
        dead = 0, dead_reason = NULL, dead_at = NULL, healed_at = NULL,
        pending_adopt = 0, last_active_at = excluded.last_active_at,
        source = excluded.source`).run(
        plan.slotId, plan.chatgptUserId, plan.accountId, fingerprint, previousFingerprint,
        doc.last_refresh ?? null, timestamp, timestamp,
      );
      db.prepare(`INSERT INTO accounts (id, provider, label, status, created_at)
        VALUES (?, ?, ?, 'active', ?)
        ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, label = excluded.label, status = excluded.status`)
        .run(plan.slotId, PROVIDER, plan.slotId, timestamp);
      db.prepare(`INSERT INTO active_login (provider, account_id, since, set_by) VALUES (?, ?, ?, 'import')
        ON CONFLICT(provider) DO UPDATE SET account_id = excluded.account_id, since = excluded.since, set_by = excluded.set_by`)
        .run(PROVIDER, plan.slotId, timestamp);
      db.prepare("DELETE FROM accounts WHERE id = 'codex-default'").run();
      if (!previous || previous.fingerprint !== fingerprint) {
        db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, from_fp, to_fp, cause, by, evidence)
          VALUES (?, ?, ?, ?, ?, 'import', 'qlb-cli', 'import')`)
          .run(timestamp, PROVIDER, plan.slotId, previous?.fingerprint ?? null, fingerprint);
      }
      if (piBaselineMatches(doc, deps.piBaseline)) {
        db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(BASELINE_CONSUMED_BY_KEY, plan.slotId);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  });
  return plan;
}
