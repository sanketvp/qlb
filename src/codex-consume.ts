import { DatabaseSync } from 'node:sqlite';

import {
  applyRefresh,
  buildRefreshRequest,
  classifyRefreshResponse,
  refreshReasonFor,
  type RefreshTrigger,
  type RequestDescription,
  type CodexAuthDocument as OAuthCodexAuthDocument,
} from './codex-oauth';
import { codexFingerprint, codexIdentity, needsRefresh, type CodexAuthDocument } from './codex-auth';
import type { CodexProcess } from './codex-sessions';
import type { CodexSlots } from './codex-slots';
import type { Store } from './store';

const PROVIDER = 'openai-codex';

type SqlStore = Pick<Store, 'dbPath'>;
type SlotStore = Pick<CodexSlots, 'readSlot' | 'writeSlot' | 'stashUnclaimed'>;

export type CodexConsumeStatus =
  | 'refreshed'
  | 'fresh'
  | 'held'
  | 'dead'
  | 'codex-won-inactive'
  | 'transient'
  | 'stashed'
  | 'slot-removed';

export interface CodexRefreshResponse {
  status: number;
  /** The raw provider response is consumed immediately and never persisted or emitted. */
  body: string;
}

export interface CodexConsumeEvent {
  kind: 'post' | 'dead' | 'codex-won-inactive' | 'transient' | 'stash';
  accountId: string;
  fromFingerprint: string;
  toFingerprint?: string;
  reason?: string;
}

export interface CodexConsumeResult {
  status: CodexConsumeStatus;
  document?: CodexAuthDocument;
  holders?: number[];
}

export interface CodexConsumeOptions {
  accountId: string;
  /** Caller snapshot is used only for N8's already-refreshed comparison. */
  snapshot: CodexAuthDocument;
  trigger: RefreshTrigger;
  /** An explicit force suppresses N8 but not the normal holder rule. */
  force?: boolean;
  /** S47's narrowly scoped C9 receipt may bypass the holder rule. */
  allowHeld?: boolean;
  slots: SlotStore;
  now?: () => number;
  /** All network activity is injected. */
  transport: (request: RequestDescription) => Promise<CodexRefreshResponse>;
  /** All process inspection is injected; production callers provide S12 renewers. */
  holders?: (document: CodexAuthDocument) => Promise<readonly CodexProcess[]>;
  /** Metadata storage is optional for pure tests; production supplies the QLB store. */
  store?: SqlStore;
  /** Test seam for metadata observation, never receives credential values. */
  record?: (event: CodexConsumeEvent) => void;
}

function accessToken(document: CodexAuthDocument): string {
  const value = document.tokens.access_token;
  return typeof value === 'string' ? value : '';
}

function holderPids(holders: readonly CodexProcess[]): number[] {
  return holders.map(({ pid }) => pid).sort((a, b) => a - b);
}

function isReuse(reason: string): boolean {
  return reason === 'refresh_token_reused' || reason === 'refresh_token_invalidated';
}

function withDatabase<T>(store: SqlStore, fn: (db: DatabaseSync) => T): T {
  // Consume commands use the on-disk QLB store. In-memory stores are purposely
  // left to injected `record` seams so this module never reaches a Store field.
  if (store.dbPath === ':memory:') return fn(new DatabaseSync(':memory:'));
  const db = new DatabaseSync(store.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

function recordInStore(store: SqlStore, event: CodexConsumeEvent, now: number): void {
  withDatabase(store, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (event.kind === 'post') {
        db.prepare(`UPDATE codex_slots SET fingerprint = ?, prev_fingerprint = ?, last_refresh = ?,
          dead = 0, dead_reason = NULL, dead_at = NULL, pending_adopt = 0
          WHERE account_id = ?`).run(event.toFingerprint ?? null, event.fromFingerprint, new Date(now).toISOString(), event.accountId);
        db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, from_fp, to_fp, cause, by, evidence)
          VALUES (?, ?, ?, ?, ?, 'post', 'qlb-cli', 'refresh')`)
          .run(now, PROVIDER, event.accountId, event.fromFingerprint, event.toFingerprint ?? null);
      } else if (event.kind === 'codex-won-inactive') {
        db.prepare('UPDATE codex_slots SET pending_adopt = 1 WHERE account_id = ?').run(event.accountId);
      } else if (event.kind === 'dead') {
        db.prepare('UPDATE codex_slots SET dead = 1, dead_reason = ?, dead_at = ? WHERE account_id = ?')
          .run(event.reason ?? null, now, event.accountId);
        db.prepare(`INSERT INTO relogin_events (ts, provider, account_id, kind, detail, evidence)
          VALUES (?, ?, ?, 'dead', ?, 'refresh')`).run(now, PROVIDER, event.accountId, event.reason ?? null);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    }
  });
}

function emit(options: CodexConsumeOptions, event: CodexConsumeEvent, now: number): void {
  options.record?.(event);
  if (options.store) recordInStore(options.store, event, now);
}

/**
 * C10's inactive-slot consume gate (§4.2.2 as applied by §4.4.2). Locking is
 * deliberately supplied by its caller: the module is pure with respect to
 * process coordination, which lets every external effect stay injectable.
 * The command's default path serializes one invocation at a time; C6's active
 * path owns the cross-process lock/publish protocol.
 */
async function consumeCodexSlotLocked(options: CodexConsumeOptions): Promise<CodexConsumeResult> {
  const now = options.now?.() ?? Date.now();
  let current: { document: CodexAuthDocument; fingerprint: string };
  try {
    current = options.slots.readSlot(options.accountId, { fresh: true });
  } catch {
    return { status: 'slot-removed' };
  }

  const holders = await options.holders?.(current.document) ?? [];
  if (!options.allowHeld && holders.length > 0) {
    return { status: 'held', holders: holderPids(holders) };
  }

  // N8: another refresher's usable access token wins. A forced C9 receipt is
  // intentionally excluded so it proves an actual refresh request occurred.
  if (!options.force && accessToken(current.document) !== accessToken(options.snapshot)
    && !needsRefresh(current.document, now)) {
    return { status: 'fresh', document: current.document };
  }

  const refreshToken = current.document.tokens.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    const event: CodexConsumeEvent = { kind: 'dead', accountId: options.accountId, fromFingerprint: current.fingerprint, reason: 'no_refresh_token' };
    emit(options, event, now);
    return { status: 'dead' };
  }

  let response: CodexRefreshResponse;
  try {
    response = await options.transport(buildRefreshRequest(refreshToken, refreshReasonFor(options.trigger)));
  } catch {
    emit(options, { kind: 'transient', accountId: options.accountId, fromFingerprint: current.fingerprint }, now);
    return { status: 'transient' };
  }
  const classified = classifyRefreshResponse(response.status, response.body);
  if (classified.kind === 'transient') {
    emit(options, { kind: 'transient', accountId: options.accountId, fromFingerprint: current.fingerprint, reason: classified.reason }, now);
    return { status: 'transient' };
  }
  if (classified.kind === 'dead') {
    const after = await options.holders?.(current.document) ?? [];
    if (isReuse(classified.reason) && after.length > 0) {
      emit(options, { kind: 'codex-won-inactive', accountId: options.accountId, fromFingerprint: current.fingerprint, reason: classified.reason }, now);
      return { status: 'codex-won-inactive', holders: holderPids(after) };
    }
    emit(options, { kind: 'dead', accountId: options.accountId, fromFingerprint: current.fingerprint, reason: classified.reason }, now);
    return { status: 'dead' };
  }

  const successor = applyRefresh(current.document as OAuthCodexAuthDocument, classified.tokens, now) as CodexAuthDocument;
  const successorFingerprint = codexFingerprint(successor);
  let latest: { document: CodexAuthDocument; fingerprint: string };
  try {
    latest = options.slots.readSlot(options.accountId, { fresh: true });
  } catch {
    options.slots.stashUnclaimed(String(now), successor, current.fingerprint);
    emit(options, { kind: 'stash', accountId: options.accountId, fromFingerprint: current.fingerprint, toFingerprint: successorFingerprint, reason: 'consume-gate-slot-removed' }, now);
    return { status: 'stashed' };
  }
  if (latest.fingerprint !== current.fingerprint) {
    options.slots.stashUnclaimed(String(now), successor, current.fingerprint);
    emit(options, { kind: 'stash', accountId: options.accountId, fromFingerprint: current.fingerprint, toFingerprint: successorFingerprint, reason: 'consume-gate-cas-conflict' }, now);
    return { status: 'fresh', document: latest.document };
  }

  try {
    // Persist-first: a single-use grant's successor reaches a managed slot
    // before metadata can claim that its predecessor was consumed.
    options.slots.writeSlot(options.accountId, successor, current.document);
  } catch {
    try {
      options.slots.stashUnclaimed(String(now), successor, current.fingerprint);
      emit(options, { kind: 'stash', accountId: options.accountId, fromFingerprint: current.fingerprint, toFingerprint: successorFingerprint, reason: 'consume-gate-persist-failed' }, now);
      return { status: 'stashed' };
    } catch {
      emit(options, { kind: 'stash', accountId: options.accountId, fromFingerprint: current.fingerprint, toFingerprint: successorFingerprint, reason: 'consume-gate-unpersisted' }, now);
      return { status: 'stashed' };
    }
  }
  emit(options, { kind: 'post', accountId: options.accountId, fromFingerprint: current.fingerprint, toFingerprint: successorFingerprint }, now);
  return { status: 'refreshed', document: successor };
}

const consumeQueues = new Map<string, Promise<void>>();

/**
 * Serializes same-process consumers of one slot. Cross-process coordination is
 * supplied by C6's native-store switch lock; the queue makes the C10 gate's
 * normal inactive refresh path deterministic for concurrent in-process calls.
 */
export async function consumeCodexSlot(options: CodexConsumeOptions): Promise<CodexConsumeResult> {
  const predecessor = consumeQueues.get(options.accountId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  consumeQueues.set(options.accountId, turn);
  await predecessor;
  try {
    return await consumeCodexSlotLocked(options);
  } finally {
    release();
    if (consumeQueues.get(options.accountId) === turn) consumeQueues.delete(options.accountId);
  }
}

/** Conservative guard shared by command adapters before they construct refresh work. */
export function hasCodexSlotIdentity(document: CodexAuthDocument, accountId: string): boolean {
  return codexIdentity(document) === accountId;
}
