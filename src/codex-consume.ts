import { createHash, randomBytes } from 'node:crypto';
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
type StashedSuccessor = { stashId: string; document: CodexAuthDocument; consumedFp: string };
type SlotStore = Pick<CodexSlots, 'readSlot' | 'writeSlot' | 'stashUnclaimed'> & {
  readPrevious?: (accountId: string, options?: { fresh?: boolean }) => { fingerprint: string };
  stashUnclaimedDurably?: (stashId: string, document: CodexAuthDocument, consumedFp: string, accountId: string) => Promise<{ stashId: string }>;
  findStashedSuccessor?: (accountId: string, consumedFp: string) => Promise<StashedSuccessor | null>;
  removeStashedSuccessor?: (stashId: string) => Promise<void>;
  /** Compatibility seam for older pure consume fixtures. Production uses find/remove above. */
  adoptStashedSuccessor?: (accountId: string, restore: (document: CodexAuthDocument) => void | Promise<void>) => Promise<boolean> | boolean;
};

export type CodexConsumeStatus =
  | 'refreshed'
  | 'fresh'
  | 'held'
  | 'busy'
  | 'active-slot'
  | 'c9-unavailable'
  | 'dead'
  | 'superseded'
  | 'codex-won-inactive'
  | 'transient'
  | 'stashed'
  | 'successor-unpersisted'
  | 'slot-removed'
  | 'slot-split';

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
  /** S47 consumes the C9 receipt in the same metadata transaction as its POST. */
  c9?: boolean;
}

export interface CodexConsumeResult {
  status: CodexConsumeStatus;
  document?: CodexAuthDocument;
  holders?: number[];
  stashId?: string;
  successorFailure?: { kind: 'successor-unpersisted'; stashFailure: string };
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

interface CurrentSlot {
  document: CodexAuthDocument;
  fingerprint: string;
  contentFingerprint?: string;
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

function fullFingerprint(document: CodexAuthDocument): string {
  return `sha256-full:${createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex')}`;
}

/** Collision-free across processes; never derived from a clock value alone. */
export function defaultCodexStashId(now: number): string {
  return `${new Date(now).toISOString().replace(/:/g, '-')}-${process.pid}-${randomBytes(12).toString('hex')}`;
}

function openDatabase(store: SqlStore): { db: DatabaseSync; close: boolean } {
  if (store.dbPath === ':memory:') {
    return { db: (store as unknown as { db?: DatabaseSync }).db ?? new DatabaseSync(':memory:'), close: false };
  }
  const db = new DatabaseSync(store.dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  return { db, close: true };
}

function closeDatabase(connection: { db: DatabaseSync; close: boolean }): void {
  if (connection.close) connection.db.close();
}

/** Metadata-only outcomes that do not publish a new slot document. */
function recordInStore(store: SqlStore, event: CodexConsumeEvent, now: number): boolean {
  const connection = openDatabase(store);
  const { db } = connection;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      let changed = true;
      if (event.kind === 'stash') {
        db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, from_fp, to_fp, cause, by, evidence)
          VALUES (?, ?, ?, ?, ?, 'stash', 'qlb-cli', 'post')`)
          .run(now, PROVIDER, event.accountId, event.fromFingerprint, event.toFingerprint ?? null);
      } else if (event.kind === 'codex-won-inactive') {
        const result = db.prepare('UPDATE codex_slots SET pending_adopt = 1 WHERE account_id = ? AND fingerprint = ?')
          .run(event.accountId, event.fromFingerprint);
        changed = Number(result.changes) === 1;
      } else if (event.kind === 'dead') {
        const result = db.prepare(`UPDATE codex_slots SET dead = 1, dead_reason = ?, dead_at = ?
          WHERE account_id = ? AND fingerprint = ?`).run(event.reason ?? null, now, event.accountId, event.fromFingerprint);
        changed = Number(result.changes) === 1;
        if (changed) {
          db.prepare(`INSERT INTO relogin_events (ts, provider, account_id, kind, detail, evidence)
            VALUES (?, ?, ?, 'dead', NULL, 'dead')`).run(now, PROVIDER, event.accountId);
        }
      }
      db.exec('COMMIT');
      return changed;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    }
  } finally {
    closeDatabase(connection);
  }
}

function emit(options: CodexConsumeOptions, event: CodexConsumeEvent, now: number): boolean {
  options.record?.(event);
  return options.store ? recordInStore(options.store, event, now) : true;
}

function absentSlot(error: unknown): boolean {
  return error instanceof Error && /item not found|slot not found/i.test(error.message);
}

/**
 * Repairs only a provable Keychain-ahead record. An unrelated document is a
 * split brain, not a refresh candidate: issuing another successor would spend
 * a grant while the metadata cannot prove which lineage it belongs to.
 */
function repairDrift(options: CodexConsumeOptions, current: CurrentSlot, now: number): 'ok' | 'slot-split' | 'transient' {
  if (!options.store) return 'ok';
  const connection = openDatabase(options.store);
  const { db } = connection;
  try {
    try {
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT fingerprint, prev_fingerprint FROM codex_slots WHERE account_id = ?').get(options.accountId) as
        | { fingerprint: string | null; prev_fingerprint: string | null }
        | undefined;
      if (!row?.fingerprint) {
        db.exec('ROLLBACK');
        return 'slot-split';
      }
      if (row.fingerprint === current.fingerprint) {
        db.exec('COMMIT');
        return 'ok';
      }
      let previousMatches = false;
      try { previousMatches = options.slots.readPrevious?.(options.accountId, { fresh: true }).fingerprint === row.fingerprint; } catch { /* not a predecessor proof */ }
      const knownEdge = db.prepare(`SELECT 1 AS found FROM lineage_log
        WHERE provider = ? AND account_id = ? AND from_fp = ? AND to_fp = ? LIMIT 1`)
        .get(PROVIDER, options.accountId, row.fingerprint, current.fingerprint) as { found?: number } | undefined;
      if (!previousMatches && !knownEdge) {
        db.exec('ROLLBACK');
        return 'slot-split';
      }
      const repaired = db.prepare(`UPDATE codex_slots SET fingerprint = ?, prev_fingerprint = ?, last_refresh = ?
        WHERE account_id = ? AND fingerprint = ?`).run(
        current.fingerprint, previousMatches ? row.fingerprint : row.prev_fingerprint, current.document.last_refresh ?? null,
        options.accountId, row.fingerprint,
      );
      if (Number(repaired.changes) !== 1) {
        db.exec('ROLLBACK');
        return 'slot-split';
      }
      if (!knownEdge) {
        db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, from_fp, to_fp, cause, by, evidence)
          VALUES (?, ?, ?, ?, ?, 'repair', 'qlb-cli', 'lineage')`)
          .run(now, PROVIDER, options.accountId, row.fingerprint, current.fingerprint);
      }
      db.exec('COMMIT');
      return 'ok';
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* preserve typed transient */ }
      return 'transient';
    }
  } finally {
    closeDatabase(connection);
  }
}

async function persistStash(
  options: CodexConsumeOptions,
  successor: CodexAuthDocument,
  consumedFp: string,
  now: number,
): Promise<CodexConsumeResult> {
  const stashId = defaultCodexStashId(now);
  try {
    if (options.slots.stashUnclaimedDurably) {
      await options.slots.stashUnclaimedDurably(stashId, successor, consumedFp, options.accountId);
    } else {
      options.slots.stashUnclaimed(stashId, successor, consumedFp);
    }
    return { status: 'stashed', document: successor, stashId };
  } catch (error) {
    const stashFailure = error instanceof Error ? error.message : 'unable to persist unclaimed credential';
    return {
      status: 'successor-unpersisted', document: successor, stashId,
      successorFailure: { kind: 'successor-unpersisted', stashFailure },
    };
  }
}

function reportStash(options: CodexConsumeOptions, consumedFp: string, successorFp: string, now: number, reason: string): void {
  // A stash is already durable. Its audit row is diagnostic only and must not
  // turn a safely retained successor into successor-unpersisted.
  try { emit(options, { kind: 'stash', accountId: options.accountId, fromFingerprint: consumedFp, toFingerprint: successorFp, reason }, now); } catch { /* retryable audit gap */ }
}

async function stashSuccessor(
  options: CodexConsumeOptions,
  successor: CodexAuthDocument,
  consumedFp: string,
  successorFp: string,
  now: number,
  reason: string,
): Promise<CodexConsumeResult> {
  const result = await persistStash(options, successor, consumedFp, now);
  if (result.status === 'stashed') reportStash(options, consumedFp, successorFp, now, reason);
  return result;
}

function holdsAttempt(current: CurrentSlot, attempt: CodexAuthDocument): boolean {
  return current.fingerprint === codexFingerprint(attempt)
    && (current.contentFingerprint ?? fullFingerprint(current.document)) === fullFingerprint(attempt);
}

/** Restore only when the slot still holds this attempt's successor. */
function compensateSlot(options: CodexConsumeOptions, predecessor: CodexAuthDocument, successor: CodexAuthDocument): void {
  try {
    const latest = options.slots.readSlot(options.accountId, { fresh: true });
    if (holdsAttempt(latest, successor)) options.slots.writeSlot(options.accountId, predecessor, successor);
  } catch { /* a racing or unavailable Keychain is never overwritten blindly */ }
}

/** Preserve an issued successor if durable stash recovery itself has failed. */
function retainSuccessorInSlot(options: CodexConsumeOptions, predecessor: CodexAuthDocument, successor: CodexAuthDocument): void {
  try {
    const latest = options.slots.readSlot(options.accountId, { fresh: true });
    if (holdsAttempt(latest, predecessor)) options.slots.writeSlot(options.accountId, successor, predecessor);
  } catch { /* an unavailable or raced slot cannot be overwritten blindly */ }
}

type PersistResult = 'committed' | 'cas-lost' | 'stashed' | 'successor-unpersisted';

/**
 * The single C10 write order: DB CAS check, Keychain write, metadata + lineage
 * update (and C9 receipt), then COMMIT. On every post-write error the issued
 * successor is durably stashed before conditional compensation.
 */
async function persistTransition(
  options: CodexConsumeOptions,
  current: CurrentSlot,
  successor: CodexAuthDocument,
  now: number,
  cause: 'post' | 'stash-adopt',
  c9: boolean,
  successorAlreadyStashed: boolean,
): Promise<PersistResult> {
  const successorFp = codexFingerprint(successor);
  if (!options.store) {
    try {
      options.slots.writeSlot(options.accountId, successor, current.document);
      options.record?.({ kind: 'post', accountId: options.accountId, fromFingerprint: current.fingerprint, toFingerprint: successorFp, c9 });
      return 'committed';
    } catch {
      const stashed = successorAlreadyStashed
        ? { status: 'stashed' as const }
        : await persistStash(options, successor, current.fingerprint, now);
      if (stashed.status === 'stashed') compensateSlot(options, current.document, successor);
      return stashed.status === 'successor-unpersisted' ? 'successor-unpersisted' : 'stashed';
    }
  }

  let connection: { db: DatabaseSync; close: boolean } | undefined;
  let wroteSlot = false;
  try {
    connection = openDatabase(options.store);
    const { db } = connection;
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT fingerprint FROM codex_slots WHERE account_id = ?').get(options.accountId) as { fingerprint: string | null } | undefined;
    if (!row || row.fingerprint !== current.fingerprint) {
      db.exec('ROLLBACK');
      if (successorAlreadyStashed) return 'stashed';
      const stashed = await persistStash(options, successor, current.fingerprint, now);
      if (stashed.status === 'stashed') reportStash(options, current.fingerprint, successorFp, now, 'consume-gate-metadata-cas-conflict');
      return stashed.status === 'successor-unpersisted' ? 'successor-unpersisted' : 'stashed';
    }

    options.slots.writeSlot(options.accountId, successor, current.document);
    wroteSlot = true;
    const update = db.prepare(`UPDATE codex_slots SET fingerprint = ?, prev_fingerprint = ?, last_refresh = ?,
      dead = 0, dead_reason = NULL, dead_at = NULL, pending_adopt = 0
      WHERE account_id = ? AND fingerprint = ?`).run(
      successorFp, current.fingerprint, successor.last_refresh ?? new Date(now).toISOString(), options.accountId, current.fingerprint,
    );
    if (Number(update.changes) !== 1) throw new Error('codex slot metadata CAS lost');
    db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, from_fp, to_fp, cause, by, evidence)
      VALUES (?, ?, ?, ?, ?, ?, 'qlb-cli', 'post')`)
      .run(now, PROVIDER, options.accountId, current.fingerprint, successorFp, cause);
    if (c9) {
      const receipt = db.prepare(`INSERT INTO config (key, value) VALUES ('codex.l13VerifiedAt', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE config.value IS NULL`).run(String(now));
      if (Number(receipt.changes) !== 1) throw new Error('C9 receipt is no longer available');
    }
    db.exec('COMMIT');
    options.record?.({ kind: 'post', accountId: options.accountId, fromFingerprint: current.fingerprint, toFingerprint: successorFp, c9 });
    return 'committed';
  } catch {
    // This await deliberately remains before ROLLBACK: the SQLite writer lock
    // prevents a metadata observer from advancing while the recovery copy is
    // being made. Never restore a spent predecessor until that copy exists.
    const stashed = successorAlreadyStashed
      ? { status: 'stashed' as const }
      : await persistStash(options, successor, current.fingerprint, now);
    if (stashed.status === 'stashed' && wroteSlot) compensateSlot(options, current.document, successor);
    if (stashed.status === 'successor-unpersisted' && !wroteSlot) {
      retainSuccessorInSlot(options, current.document, successor);
    }
    try { connection?.db.exec('ROLLBACK'); } catch { /* preserve the typed recovery result */ }
    if (stashed.status === 'stashed' && !successorAlreadyStashed) {
      reportStash(options, current.fingerprint, successorFp, now, 'consume-gate-persist-failed');
    }
    return stashed.status === 'successor-unpersisted' ? 'successor-unpersisted' : 'stashed';
  } finally {
    try { if (connection) closeDatabase(connection); } catch { /* preserve the typed recovery result */ }
  }
}

async function adoptSuccessor(options: CodexConsumeOptions, current: CurrentSlot, now: number): Promise<CodexConsumeResult | null> {
  if (options.slots.findStashedSuccessor) {
    let stashed: StashedSuccessor | null;
    try { stashed = await options.slots.findStashedSuccessor(options.accountId, current.fingerprint); } catch { return { status: 'transient' }; }
    if (!stashed) return null;
    const persisted = await persistTransition(options, current, stashed.document, now, 'stash-adopt', false, true);
    if (persisted !== 'committed') return { status: 'stashed', document: stashed.document, stashId: stashed.stashId };
    // The recovery body remains until the metadata transaction commits. Cleanup
    // failure retains a harmless safety copy whose consumed fingerprint is old.
    try { await options.slots.removeStashedSuccessor?.(stashed.stashId); } catch { /* later sweep */ }
    return { status: 'fresh', document: stashed.document };
  }
  // Compatibility for the original injected pure-test helper.
  if (!options.slots.adoptStashedSuccessor) return null;
  try {
    const adopted = await options.slots.adoptStashedSuccessor(options.accountId, (successor) => {
      options.slots.writeSlot(options.accountId, successor, current.document);
    });
    if (!adopted) return null;
    const adoptedCurrent = options.slots.readSlot(options.accountId, { fresh: true });
    return { status: 'fresh', document: adoptedCurrent.document };
  } catch (error) {
    return { status: absentSlot(error) ? 'slot-removed' : 'transient' };
  }
}

/** C10's inactive-slot consume gate. The caller holds the provider locks. */
async function consumeCodexSlotLocked(options: CodexConsumeOptions): Promise<CodexConsumeResult> {
  const now = options.now?.() ?? Date.now();
  let current: CurrentSlot;
  try { current = options.slots.readSlot(options.accountId, { fresh: true }); } catch (error) {
    return { status: absentSlot(error) ? 'slot-removed' : 'transient' };
  }

  const repaired = repairDrift(options, current, now);
  if (repaired !== 'ok') return { status: repaired };

  const adopted = await adoptSuccessor(options, current, now);
  if (adopted) return adopted;

  const holders = await options.holders?.(current.document) ?? [];
  if (!options.allowHeld && holders.length > 0) return { status: 'held', holders: holderPids(holders) };

  if (!options.force && accessToken(current.document) !== accessToken(options.snapshot) && !needsRefresh(current.document, now)) {
    return { status: 'fresh', document: current.document };
  }

  const refreshToken = current.document.tokens.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    emit(options, { kind: 'dead', accountId: options.accountId, fromFingerprint: current.fingerprint, reason: 'no_refresh_token' }, now);
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
    let latest: CurrentSlot;
    try { latest = options.slots.readSlot(options.accountId, { fresh: true }); } catch (error) {
      return { status: absentSlot(error) ? 'slot-removed' : 'transient' };
    }
    if (latest.fingerprint !== current.fingerprint || !holdsAttempt(latest, current.document)) return { status: 'superseded', document: latest.document };
    if (!options.allowHeld && isReuse(classified.reason)) {
      const after = await options.holders?.(current.document) ?? [];
      if (after.length > 0) {
        const marked = emit(options, { kind: 'codex-won-inactive', accountId: options.accountId, fromFingerprint: current.fingerprint, reason: classified.reason }, now);
        return marked ? { status: 'codex-won-inactive', holders: holderPids(after) } : { status: 'superseded', document: latest.document };
      }
    }
    const marked = emit(options, { kind: 'dead', accountId: options.accountId, fromFingerprint: current.fingerprint, reason: classified.reason }, now);
    return marked ? { status: 'dead' } : { status: 'superseded', document: latest.document };
  }

  const successor = applyRefresh(current.document as OAuthCodexAuthDocument, classified.tokens, now) as CodexAuthDocument;
  let latest: CurrentSlot;
  try { latest = options.slots.readSlot(options.accountId, { fresh: true }); } catch (error) {
    return stashSuccessor(options, successor, current.fingerprint, codexFingerprint(successor), now,
      absentSlot(error) ? 'consume-gate-slot-removed' : 'consume-gate-store-unreadable');
  }
  if (!holdsAttempt(latest, current.document)) {
    return stashSuccessor(options, successor, current.fingerprint, codexFingerprint(successor), now, 'consume-gate-cas-conflict');
  }

  const persisted = await persistTransition(options, current, successor, now, 'post', options.allowHeld === true, false);
  if (persisted === 'committed') return { status: 'refreshed', document: successor };
  if (persisted === 'cas-lost') {
    return stashSuccessor(options, successor, current.fingerprint, codexFingerprint(successor), now, 'consume-gate-metadata-cas-conflict');
  }
  if (persisted === 'successor-unpersisted') {
    return {
      status: 'successor-unpersisted', document: successor,
      successorFailure: { kind: 'successor-unpersisted', stashFailure: 'unable to persist unclaimed credential' },
    };
  }
  return { status: 'stashed', document: successor };
}

const consumeQueues = new Map<string, Promise<void>>();

/** Serializes same-process consumers; command adapters add the cross-process C6 locks. */
export async function consumeCodexSlot(options: CodexConsumeOptions): Promise<CodexConsumeResult> {
  const predecessor = consumeQueues.get(options.accountId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  consumeQueues.set(options.accountId, turn);
  await predecessor;
  try { return await consumeCodexSlotLocked(options); } finally {
    release();
    if (consumeQueues.get(options.accountId) === turn) consumeQueues.delete(options.accountId);
  }
}

/** Conservative guard shared by command adapters before they construct refresh work. */
export function hasCodexSlotIdentity(document: CodexAuthDocument, accountId: string): boolean {
  return codexIdentity(document) === accountId;
}
