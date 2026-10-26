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
type SlotStore = Pick<CodexSlots, 'readSlot' | 'writeSlot' | 'stashUnclaimed'> & {
  stashUnclaimedDurably?: (stashId: string, document: CodexAuthDocument, consumedFp: string, accountId: string) => Promise<{ stashId: string }>;
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
  return `${new Date(now).toISOString()}-${process.pid}-${randomBytes(12).toString('hex')}`;
}

function withDatabase<T>(store: SqlStore, fn: (db: DatabaseSync) => T): T {
  if (store.dbPath === ':memory:') return fn((store as unknown as { db?: DatabaseSync }).db ?? new DatabaseSync(':memory:'));
  const db = new DatabaseSync(store.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Records state only if the whole consumed lineage remains current.  The
 * conditional metadata update is the DB half of C10's CAS; callers restore
 * the Keychain pre-image if it loses.
 */
function recordInStore(store: SqlStore, event: CodexConsumeEvent, now: number): boolean {
  return withDatabase(store, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      let changed = true;
      if (event.kind === 'post') {
        const result = db.prepare(`UPDATE codex_slots SET fingerprint = ?, prev_fingerprint = ?, last_refresh = ?,
          dead = 0, dead_reason = NULL, dead_at = NULL, pending_adopt = 0
          WHERE account_id = ? AND fingerprint = ?`).run(
          event.toFingerprint ?? null, event.fromFingerprint, new Date(now).toISOString(), event.accountId, event.fromFingerprint,
        );
        changed = Number(result.changes) === 1;
        if (changed) {
          db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, from_fp, to_fp, cause, by, evidence)
            VALUES (?, ?, ?, ?, ?, 'post', 'qlb-cli', 'post')`)
            .run(now, PROVIDER, event.accountId, event.fromFingerprint, event.toFingerprint ?? null);
          if (event.c9) {
            const receipt = db.prepare(`INSERT INTO config (key, value) VALUES ('codex.l13VerifiedAt', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE config.value IS NULL`).run(String(now));
            changed = Number(receipt.changes) === 1;
            if (!changed) {
              db.exec('ROLLBACK');
              return false;
            }
          }
        }
      } else if (event.kind === 'stash') {
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
  });
}

function emit(options: CodexConsumeOptions, event: CodexConsumeEvent, now: number): boolean {
  options.record?.(event);
  return options.store ? recordInStore(options.store, event, now) : true;
}

function absentSlot(error: unknown): boolean {
  return error instanceof Error && /item not found|slot not found/i.test(error.message);
}

async function stashSuccessor(
  options: CodexConsumeOptions,
  successor: CodexAuthDocument,
  consumedFp: string,
  successorFp: string,
  now: number,
  reason: string,
): Promise<CodexConsumeResult> {
  const stashId = defaultCodexStashId(now);
  try {
    if (options.slots.stashUnclaimedDurably) {
      await options.slots.stashUnclaimedDurably(stashId, successor, consumedFp, options.accountId);
    } else {
      options.slots.stashUnclaimed(stashId, successor, consumedFp);
    }
    emit(options, { kind: 'stash', accountId: options.accountId, fromFingerprint: consumedFp, toFingerprint: successorFp, reason }, now);
    return { status: 'stashed', document: successor, stashId };
  } catch (error) {
    const stashFailure = error instanceof Error ? error.message : 'unable to persist unclaimed credential';
    return {
      status: 'successor-unpersisted', document: successor, stashId,
      successorFailure: { kind: 'successor-unpersisted', stashFailure },
    };
  }
}

/** C10's inactive-slot consume gate. The caller holds the provider locks. */
async function consumeCodexSlotLocked(options: CodexConsumeOptions): Promise<CodexConsumeResult> {
  const now = options.now?.() ?? Date.now();
  let current: { document: CodexAuthDocument; fingerprint: string; contentFingerprint?: string };
  try {
    current = options.slots.readSlot(options.accountId, { fresh: true });
  } catch (error) {
    return { status: absentSlot(error) ? 'slot-removed' : 'transient' };
  }

  // A recovery successor is adopted before S12/N8 and before any POST.
  if (options.slots.adoptStashedSuccessor) {
    try {
      const adopted = await options.slots.adoptStashedSuccessor(options.accountId, (successor) => {
        options.slots.writeSlot(options.accountId, successor, current.document);
      });
      if (adopted) {
        const adoptedCurrent = options.slots.readSlot(options.accountId, { fresh: true });
        emit(options, { kind: 'post', accountId: options.accountId, fromFingerprint: current.fingerprint, toFingerprint: adoptedCurrent.fingerprint }, now);
        return { status: 'fresh', document: adoptedCurrent.document };
      }
    } catch (error) {
      return { status: absentSlot(error) ? 'slot-removed' : 'transient' };
    }
  }

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
    let latest: { document: CodexAuthDocument; fingerprint: string; contentFingerprint?: string };
    try { latest = options.slots.readSlot(options.accountId, { fresh: true }); } catch (error) {
      return { status: absentSlot(error) ? 'slot-removed' : 'transient' };
    }
    if (latest.fingerprint !== current.fingerprint) return { status: 'superseded', document: latest.document };
    // S47 overrides the normal holder interpretation: a C9 reuse is proof
    // that A was refreshed in memory and the receipt must be refused.
    if (!options.allowHeld && isReuse(classified.reason)) {
      const after = await options.holders?.(current.document) ?? [];
      if (after.length > 0) {
        emit(options, { kind: 'codex-won-inactive', accountId: options.accountId, fromFingerprint: current.fingerprint, reason: classified.reason }, now);
        return { status: 'codex-won-inactive', holders: holderPids(after) };
      }
    }
    const marked = emit(options, { kind: 'dead', accountId: options.accountId, fromFingerprint: current.fingerprint, reason: classified.reason }, now);
    return marked ? { status: 'dead' } : { status: 'superseded', document: latest.document };
  }

  const successor = applyRefresh(current.document as OAuthCodexAuthDocument, classified.tokens, now) as CodexAuthDocument;
  const successorFingerprint = codexFingerprint(successor);
  let latest: { document: CodexAuthDocument; fingerprint: string; contentFingerprint?: string };
  try { latest = options.slots.readSlot(options.accountId, { fresh: true }); } catch (error) {
    return stashSuccessor(options, successor, current.fingerprint, successorFingerprint, now,
      absentSlot(error) ? 'consume-gate-slot-removed' : 'consume-gate-store-unreadable');
  }
  // Whole-document comparison prevents a same-refresh-token writer from being overwritten.
  if (latest.fingerprint !== current.fingerprint ||
    (latest.contentFingerprint ?? fullFingerprint(latest.document)) !== (current.contentFingerprint ?? fullFingerprint(current.document))) {
    const stashed = await stashSuccessor(options, successor, current.fingerprint, successorFingerprint, now, 'consume-gate-cas-conflict');
    return stashed;
  }

  try {
    options.slots.writeSlot(options.accountId, successor, current.document);
  } catch {
    return stashSuccessor(options, successor, current.fingerprint, successorFingerprint, now, 'consume-gate-persist-failed');
  }
  let recorded: boolean;
  try {
    recorded = emit(options, {
      kind: 'post', accountId: options.accountId, fromFingerprint: current.fingerprint, toFingerprint: successorFingerprint, c9: options.allowHeld,
    }, now);
  } catch {
    // The successor is safe in the managed slot, but do not claim a complete
    // consume while its metadata transaction is unavailable.
    return { status: 'transient', document: successor };
  }
  if (!recorded) {
    // The DB CAS lost after the Keychain write. Restore only the exact pre-image
    // observed under the same switch lock; a future C6 writer cannot be clobbered.
    try { options.slots.writeSlot(options.accountId, current.document, successor); } catch { /* best-effort compensation */ }
    return stashSuccessor(options, successor, current.fingerprint, successorFingerprint, now, 'consume-gate-metadata-cas-conflict');
  }
  return { status: 'refreshed', document: successor };
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
