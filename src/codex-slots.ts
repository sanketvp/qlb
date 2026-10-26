import { DatabaseSync } from 'node:sqlite';

import { codexFingerprint, codexIdentity, parseCodexAuth, type CodexAuthDocument } from './codex-auth';
import { isCredentialNotFound } from './credential-backends';
import {
  KeychainReadBackoff,
  QLB_KEYCHAIN_ACCOUNT,
  qlbKeychainService,
  type KeychainBackend,
} from './keychain';
import type { Store } from './store';

const PROVIDER = 'openai-codex';
const BASELINE_CONSUMED_BY_KEY = 'pi.openai-codex.baselineConsumedBy';

type SqlStore = Pick<Store, 'dbPath'>;
type Keychain = Pick<KeychainBackend, 'getSync' | 'setSync'>;
type SlotKeychain = Keychain & Pick<KeychainBackend, 'deleteSync'>;
type JsonObject = Record<string, unknown>;

const DISPLAY_CACHE_TTL_MS = 60_000;

export interface ReadCodexSlot {
  document: CodexAuthDocument;
  fingerprint: string;
}

export interface ReadUnclaimedCodexSlot extends ReadCodexSlot {
  consumedFp?: string;
}

interface UnclaimedRecord {
  credential: CodexAuthDocument;
  consumedFp?: string;
}

export interface ReadCodexSlotOptions {
  /** Correctness reads (consume/switch/resync/import/add/undo) bypass cache and backoff. */
  fresh?: boolean;
}

export interface CodexSlotsOptions {
  keychain: SlotKeychain;
  now?: () => number;
  readBackoff?: KeychainReadBackoff;
}

type CachedSlot = ReadCodexSlot & { expiresAt: number };

/**
 * Keychain boundary for native Codex documents. Cached reads are exclusively
 * for display paths; every correctness boundary must use `{ fresh: true }`.
 */
export class CodexSlots {
  private readonly now: () => number;
  private readonly backoff: KeychainReadBackoff;
  private readonly cache = new Map<string, CachedSlot>();

  constructor(private readonly options: CodexSlotsOptions) {
    this.now = options.now ?? Date.now;
    this.backoff = options.readBackoff ?? new KeychainReadBackoff({ now: this.now });
  }

  readSlot(accountId: string, options: ReadCodexSlotOptions = {}): ReadCodexSlot {
    const fresh = options.fresh === true;
    const cached = this.cache.get(accountId);
    const now = this.now();
    if (!fresh && cached && cached.expiresAt > now) return this.copy(cached);

    const result = this.readService(this.slotService(accountId), fresh);
    if (!fresh) {
      const cachedResult = this.copy(result);
      this.cache.set(accountId, { ...cachedResult, expiresAt: now + DISPLAY_CACHE_TTL_MS });
      return this.copy(cachedResult);
    }
    return result;
  }

  /** Reads the explicit S46 predecessor without changing the current slot. */
  readPrevious(accountId: string, options: ReadCodexSlotOptions = {}): ReadCodexSlot {
    return this.readService(this.previousService(accountId), options.fresh === true);
  }

  /** S36-shaped safety copy for a native document that cannot be attributed to a managed slot. */
  stashUnclaimed(timestamp: string, document: CodexAuthDocument, consumedFp: string): string {
    if (!consumedFp) throw new Error('unclaimed consumed lineage is required');
    this.options.keychain.setSync(
      this.unclaimedService(timestamp),
      QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify({ credential: document, consumedFp }),
    );
    return timestamp;
  }

  readUnclaimed(timestamp: string, options: ReadCodexSlotOptions = {}): ReadUnclaimedCodexSlot {
    const record = parseUnclaimed(this.readText(this.unclaimedService(timestamp), options.fresh === true));
    return { document: record.credential, fingerprint: codexFingerprint(record.credential), consumedFp: record.consumedFp };
  }

  /**
   * Persists a new managed lineage before the caller records its metadata.
   * The predecessor copy is deliberately written first so a returned refresh
   * successor is never the only recoverable copy after a later DB failure.
   */
  writeSlot(accountId: string, document: CodexAuthDocument, previous?: CodexAuthDocument): void {
    const service = this.slotService(accountId);
    const prior = previous ?? this.readSlot(accountId, { fresh: true }).document;
    this.options.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(prior));
    this.options.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(document));
    this.cache.delete(accountId);
  }

  /**
   * Restores an S36 stash only through the caller's slot transaction and only
   * if it was consumed from that slot's current lineage.
   */
  restoreUnclaimed(
    timestamp: string,
    currentFingerprint: string,
    restore: (document: CodexAuthDocument) => void,
  ): ReadUnclaimedCodexSlot {
    const unclaimed = this.readUnclaimed(timestamp, { fresh: true });
    if (!unclaimed.consumedFp || unclaimed.consumedFp !== currentFingerprint) {
      throw new Error('unclaimed lineage mismatch');
    }
    restore(unclaimed.document);
    this.options.keychain.deleteSync(this.unclaimedService(timestamp), QLB_KEYCHAIN_ACCOUNT);
    this.cache.clear();
    return unclaimed;
  }

  private readService(service: string, fresh: boolean): ReadCodexSlot {
    const text = this.readText(service, fresh);
    const parsed = parseCodexAuth(text);
    if (!parsed.ok) throw new Error('stored Codex document is malformed');
    return { document: parsed.doc, fingerprint: codexFingerprint(parsed.doc) };
  }

  private readText(service: string, fresh: boolean): string {
    this.backoff.read(() => undefined, { fresh });
    try {
      return this.options.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
    } catch (error) {
      // A missing optional :prev/stash is an ordinary absence, not a Keychain outage.
      if (!isCredentialNotFound(error)) {
        try { this.backoff.read(() => { throw error; }, { fresh: true }); } catch { /* rethrow original below */ }
      }
      throw error;
    }
  }

  private copy(slot: ReadCodexSlot): ReadCodexSlot {
    // The returned document may be inspected by callers; never hand out the
    // mutable object held in the display cache.
    return { document: JSON.parse(JSON.stringify(slot.document)) as CodexAuthDocument, fingerprint: slot.fingerprint };
  }

  private slotService(accountId: string): string {
    return qlbKeychainService(PROVIDER, accountId);
  }

  private previousService(accountId: string): string {
    return `${this.slotService(accountId)}:prev`;
  }

  private unclaimedService(timestamp: string): string {
    return qlbKeychainService(PROVIDER, `unclaimed:${timestamp}`);
  }
}

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

function parseUnclaimed(text: string): UnclaimedRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('unclaimed stash is malformed'); }
  const record = object(value);
  // Pre-S36 stashes were the document itself. They remain readable only so
  // restoreUnclaimed can reject them for their absent lineage rather than
  // mistaking an upgrade for Keychain corruption.
  const credential = record?.credential ?? value;
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new Error('unclaimed stash is malformed');
  }
  const parsed = parseCodexAuth(JSON.stringify(credential));
  if (!parsed.ok) throw new Error('unclaimed stash is malformed');
  if (record?.consumedFp != null && typeof record.consumedFp !== 'string') {
    throw new Error('unclaimed stash is malformed');
  }
  return record?.consumedFp
    ? { credential: parsed.doc, consumedFp: record.consumedFp }
    : { credential: parsed.doc };
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type CodexAccountTokens = { id_token?: unknown; account_id?: unknown };

function idTokenAuthClaims(doc: { tokens: CodexAccountTokens }): JsonObject | null {
  try {
    if (typeof doc.tokens.id_token !== 'string') return null;
    const payload = doc.tokens.id_token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    const claims = object(decoded)?.['https://api.openai.com/auth'];
    return object(claims);
  } catch {
    return null;
  }
}

/** Bare account row identity shared by the Codex adapter and import-active. */
export function codexBareAccountId(doc: { tokens: CodexAccountTokens }): string | undefined {
  const accountId = doc.tokens.account_id;
  if (typeof accountId === 'string' && accountId.length > 0) return accountId;
  const claim = idTokenAuthClaims(doc)?.chatgpt_account_id;
  return typeof claim === 'string' && claim.length > 0 ? claim : undefined;
}

/** Extracts the S29 identity fields without retaining any token values. */
export function planImportActiveCodex(doc: CodexAuthDocument): CodexImportPlan {
  const claims = idTokenAuthClaims(doc);
  const chatgptUserId = claims?.chatgpt_user_id;
  const accountId = codexBareAccountId(doc);
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

function currentDocumentMatches(document: string, fingerprint: string): boolean {
  const parsed = parseCodexAuth(document);
  return parsed.ok && codexFingerprint(parsed.doc) === fingerprint;
}

/**
 * S29/S46 import primitive. The database write lock spans both Keychain
 * writes and metadata, so concurrent imports cannot interleave credentials
 * and lineage. A failed commit is made retry-safe by copying `:prev` only
 * when the current item still matches the recorded predecessor fingerprint.
 */
export function importActiveCodexSlot(doc: CodexAuthDocument, deps: ImportActiveCodexDeps): CodexImportPlan {
  const plan = planImportActiveCodex(doc);
  const now = deps.now ?? Date.now;
  const fingerprint = codexFingerprint(doc);
  const storeDb = deps.withDb ?? withDatabase;
  const service = qlbKeychainService(PROVIDER, plan.slotId);

  storeDb(deps.store, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = existingSlot(db, plan.slotId);
      const previousFingerprint = previous?.fingerprint && previous.fingerprint !== fingerprint
        ? previous.fingerprint
        : previous?.prev_fingerprint ?? null;

      // A prior managed slot gets an explicit predecessor copy before its
      // current document changes. After an uncommitted attempt, the current
      // item is already the successor, so never overwrite the real :prev.
      if (previous?.fingerprint && previous.fingerprint !== fingerprint) {
        const oldDocument = deps.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
        if (currentDocumentMatches(oldDocument, previous.fingerprint)) {
          deps.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, oldDocument);
        }
      }
      deps.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(doc));

      const timestamp = now();
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
        dead = CASE WHEN codex_slots.fingerprint IS NOT excluded.fingerprint THEN 0 ELSE codex_slots.dead END,
        dead_reason = CASE WHEN codex_slots.fingerprint IS NOT excluded.fingerprint THEN NULL ELSE codex_slots.dead_reason END,
        dead_at = CASE WHEN codex_slots.fingerprint IS NOT excluded.fingerprint THEN NULL ELSE codex_slots.dead_at END,
        healed_at = CASE WHEN codex_slots.fingerprint IS NOT excluded.fingerprint THEN NULL ELSE codex_slots.healed_at END,
        pending_adopt = 0, archived_at = NULL, last_active_at = excluded.last_active_at,
        source = COALESCE(codex_slots.source, excluded.source)`).run(
        plan.slotId, plan.chatgptUserId, plan.accountId, fingerprint, previousFingerprint,
        doc.last_refresh ?? null, timestamp, timestamp,
      );
      db.prepare(`INSERT INTO accounts (id, provider, label, status, created_at)
        VALUES (?, ?, ?, 'active', ?)
        ON CONFLICT(id) DO UPDATE SET provider = excluded.provider`)
        .run(plan.accountId, PROVIDER, plan.accountId, timestamp);
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
