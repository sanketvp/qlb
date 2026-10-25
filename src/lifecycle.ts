import { DatabaseSync } from 'node:sqlite';

import type { Store } from './store';

export type LifecycleState = 'pre-cutover' | 'cutting-over' | 'cutover' | 'undoing' | 'rolled-back' | 'retired' | 'aborted';
export type LifecycleOperation =
  | 'gate' | 'switch:manual' | 'switch:auto' | 'auto' | 'auto:dry-run'
  | 'import-cswap' | 'undo-cswap' | 'undo-cswap:resume' | 'retire-cswap'
  | 'pi-migrate' | 'pi-rollback' | 'codex-import-active' | 'codex-add' | 'claude-add'
  | 'cutover-begin' | 'cutover-commit' | 'cutover-abort' | 'keychain-authorize-cswap'
  | 'keychain-check-launchd-live' | 'verify-l13' | 'report-cutover' | 'doctor' | 'status'
  | 'lifecycle-close' | 'lifecycle-drill-done'
  | `${string}:dry-run`;

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_STATES = ['cutting-over', 'cutover', 'undoing', 'rolled-back', 'retired', 'aborted'];
const PI_PROVIDERS = ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter'] as const;
export const CUTOVER_BEGIN_IN_PROGRESS = 'cutover-begin-in-progress';
export const PI_STALE_SESSION_COUNT_KEY = 'pi.staleSessionCount';
export const PI_STALE_SESSIONS_KEY = 'pi.staleSessions';
export const PI_STALE_SESSION_COUNT_CLEAR = '0';

export interface LifecycleRow {
  id: number;
  state: LifecycleState;
  beganAt: number;
  cutoverAt: number | null;
  windowEnd: number | null;
  extendedAt: number | null;
  undoBeganAt: number | null;
  rollbackAt: number | null;
  retiredAt: number | null;
  closedAt: number | null;
  releaseSha: string | null;
  drillDoneAt: number | null;
  note: string | null;
  preFenceState: LifecycleState | null;
}

export interface LifecycleResult {
  ok: boolean;
  code?: string;
  row?: LifecycleRow;
}

function rules(...operations: LifecycleOperation[]): Set<LifecycleOperation> {
  return new Set(operations);
}

/** §4.15's admission table; this is deliberately the sole policy authority. */
export const PHASE_RULES: Record<LifecycleState, Set<LifecycleOperation>> = {
  'pre-cutover': rules('doctor', 'status', 'cutover-begin'),
  'cutting-over': rules(
    'doctor', 'status', 'import-cswap', 'codex-import-active', 'codex-add', 'claude-add',
    'pi-migrate', 'pi-rollback', 'switch:manual', 'gate', 'auto:dry-run', 'cutover-commit',
    'cutover-abort', 'keychain-authorize-cswap', 'keychain-check-launchd-live',
  ),
  cutover: rules(
    'doctor', 'status', 'switch:manual', 'switch:auto', 'auto', 'auto:dry-run', 'gate',
    'codex-import-active', 'codex-add', 'claude-add', 'pi-migrate', 'pi-rollback',
    'verify-l13', 'report-cutover', 'undo-cswap', 'retire-cswap', 'lifecycle-drill-done',
  ),
  undoing: rules('doctor', 'status', 'undo-cswap:resume', 'pi-rollback'),
  'rolled-back': rules('doctor', 'status', 'report-cutover', 'undo-cswap:resume', 'pi-rollback', 'lifecycle-close'),
  retired: rules(
    'doctor', 'status', 'gate', 'switch:manual', 'switch:auto', 'auto', 'auto:dry-run',
    'claude-add', 'codex-add', 'report-cutover', 'lifecycle-close',
  ),
  aborted: rules('doctor', 'status', 'report-cutover', 'undo-cswap:resume', 'pi-rollback', 'lifecycle-close'),
};

function withDb<T>(store: Pick<Store, 'dbPath'>, fn: (db: DatabaseSync) => T): T {
  // A separate connection cannot see another connection's `:memory:` database.
  // Store intentionally owns its connection; use it only for this test-friendly
  // special case, while file-backed stores keep the normal short-lived handle.
  if (store.dbPath === ':memory:') {
    return fn((store as unknown as { db: DatabaseSync }).db);
  }
  const db = new DatabaseSync(store.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

function rowFromSql(row: Record<string, unknown>): LifecycleRow {
  return {
    id: Number(row.id), state: row.state as LifecycleState, beganAt: Number(row.began_at),
    cutoverAt: numberOrNull(row.cutover_at), windowEnd: numberOrNull(row.window_end),
    extendedAt: numberOrNull(row.extended_at), undoBeganAt: numberOrNull(row.undo_began_at),
    rollbackAt: numberOrNull(row.rollback_at), retiredAt: numberOrNull(row.retired_at),
    closedAt: numberOrNull(row.closed_at), releaseSha: stringOrNull(row.release_sha),
    drillDoneAt: numberOrNull(row.drill_done_at), note: stringOrNull(row.note),
    preFenceState: stringOrNull(row.pre_fence_state) as LifecycleState | null,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function phase(store: Pick<Store, 'dbPath'>): LifecycleRow {
  return withDb(store, (db) => {
    const row = db.prepare(`SELECT * FROM lifecycle WHERE state IN (${OPEN_STATES.map(() => '?').join(', ')})
      ORDER BY id DESC LIMIT 1`).get(...OPEN_STATES) as Record<string, unknown> | undefined;
    return row ? rowFromSql(row) : {
      id: 0, state: 'pre-cutover', beganAt: 0, cutoverAt: null, windowEnd: null, extendedAt: null,
      undoBeganAt: null, rollbackAt: null, retiredAt: null, closedAt: null, releaseSha: null,
      drillDoneAt: null, note: null, preFenceState: null,
    };
  });
}

export function isOperational(state: LifecycleState): boolean {
  return state === 'cutover' || state === 'retired';
}

/** Admission must be called before locks or journal reconciliation (S43/S59). */
export function assertAdmitted(store: Store, operation: LifecycleOperation): LifecycleResult {
  const current = phase(store);
  if (current.state !== 'undoing' && operation.endsWith(':dry-run')) return { ok: true, row: current };
  // cutoverBegin's compensation uses its durable primitives directly. Every
  // separately admitted mutation must wait until that transaction clears this marker.
  if (current.note === CUTOVER_BEGIN_IN_PROGRESS && operation !== 'doctor' && operation !== 'status') {
    return { ok: false, code: CUTOVER_BEGIN_IN_PROGRESS, row: current };
  }
  if (PHASE_RULES[current.state].has(operation)) return { ok: true, row: current };
  return { ok: false, code: current.state === 'undoing' ? 'undo-in-progress' : `phase=${current.state}`, row: current };
}

const TRANSITIONS: Partial<Record<LifecycleState, LifecycleState[]>> = {
  'cutting-over': ['cutover', 'aborted'],
  cutover: ['undoing', 'retired'],
  undoing: ['rolled-back'],
};

/** Durable state transition primitive for K12/X4a; each edge is §4.15-only. */
export function transition(store: Store, to: LifecycleState, now: number = Date.now()): LifecycleResult {
  const current = phase(store);
  if (!TRANSITIONS[current.state]?.includes(to)) {
    return { ok: false, code: `transition=${current.state}->${to}`, row: current };
  }
  const fields: string[] = ['state = ?'];
  const values: Array<string | number | null> = [to];
  if (to === 'undoing') { fields.push('undo_began_at = ?', 'pre_fence_state = ?'); values.push(now, current.state); }
  if (to === 'rolled-back' || to === 'aborted') {
    fields.push('rollback_at = ?');
    values.push(now);
  }
  if (to === 'retired') {
    fields.push('retired_at = ?');
    values.push(now);
  }
  values.push(current.id, current.state);
  const changed = withDb(store, (db) => db.prepare(
    `UPDATE lifecycle SET ${fields.join(', ')} WHERE id = ? AND state = ?`,
  ).run(...values).changes);
  if (changed !== 1) return { ok: false, code: `transition=${current.state}->${to}`, row: phase(store) };
  return { ok: true, row: phase(store) };
}

export function beginCutover(store: Store, now: number = Date.now(), note: string | null = null): LifecycleRow {
  try {
    return withDb(store, (db) => {
      const result = db.prepare('INSERT INTO lifecycle (state, began_at, note) VALUES (?, ?, ?)').run('cutting-over', now, note);
      const row = db.prepare('SELECT * FROM lifecycle WHERE id = ?').get(Number(result.lastInsertRowid)) as Record<string, unknown>;
      return rowFromSql(row);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('lifecycle_one_open')) throw err;
    const constraint = new Error(`SQLITE_CONSTRAINT: ${message}`);
    (constraint as Error & { code?: string }).code = 'SQLITE_CONSTRAINT';
    throw constraint;
  }
}

export function completeCutoverBegin(store: Store, id: number): LifecycleResult {
  const changed = withDb(store, (db) => db.prepare(
    "UPDATE lifecycle SET note = NULL WHERE id = ? AND state = 'cutting-over' AND note = ?",
  ).run(id, CUTOVER_BEGIN_IN_PROGRESS).changes);
  if (changed !== 1) return { ok: false, code: 'cutover-begin-state-lost', row: phase(store) };
  return { ok: true, row: phase(store) };
}

export function abortCutoverBegin(store: Store, id: number, failureCode: string, now: number = Date.now()): LifecycleResult {
  const changed = withDb(store, (db) => db.prepare(
    "UPDATE lifecycle SET state = 'aborted', rollback_at = ?, pre_fence_state = 'cutting-over', note = ? WHERE id = ? AND state = 'cutting-over' AND note = ?",
  ).run(now, `cutover begin failed: ${failureCode}`, id, CUTOVER_BEGIN_IN_PROGRESS).changes);
  if (changed !== 1) return { ok: false, code: 'transition=cutting-over->aborted', row: phase(store) };
  return { ok: true, row: phase(store) };
}

function hasImportedClaudeSlot(db: DatabaseSync): boolean {
  return Boolean(db.prepare('SELECT 1 FROM claude_slots WHERE archived_at IS NULL LIMIT 1').get());
}

function manualRoundTripDone(db: DatabaseSync): boolean {
  const rows = db.prepare(`SELECT from_account, to_account FROM switch_log
    WHERE provider = 'anthropic' AND trigger = 'manual' AND outcome = 'ok' AND injected = 0
      AND from_account IS NOT NULL AND from_account <> to_account ORDER BY id`).all() as Array<{ from_account: string; to_account: string }>;
  return rows.length >= 2 && rows.some((first, index) => rows.slice(index + 1).some((second) =>
    first.from_account === second.to_account && first.to_account === second.from_account));
}

function configValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function hasSharedAnthropicTarget(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM pi_export_targets WHERE provider = 'anthropic' LIMIT 1").get());
}

function stalePiSessions(db: DatabaseSync): 'stale' | 'clear' | 'unknown' {
  // S61's producer writes a canonical decimal count; only its exact zero is
  // evidence that no stale Pi session remains. The legacy boolean key is
  // accepted only in its two exact producer spellings.
  const count = configValue(db, PI_STALE_SESSION_COUNT_KEY);
  if (count != null) {
    if (count === PI_STALE_SESSION_COUNT_CLEAR) return 'clear';
    return /^[1-9]\d*$/.test(count) ? 'stale' : 'unknown';
  }
  const legacy = configValue(db, PI_STALE_SESSIONS_KEY);
  if (legacy === 'false') return 'clear';
  if (legacy === 'true') return 'stale';
  return 'unknown';
}

/** Commit gates from S50, S61, and S63. */
export function commitCutover(store: Store, opts: { now?: number; releaseSha?: string } = {}): LifecycleResult {
  const admission = assertAdmitted(store, 'cutover-commit');
  if (!admission.ok) return admission;
  return withDb(store, (db) => {
    const current = db.prepare('SELECT note FROM lifecycle WHERE id = ? AND state = ?').get(admission.row!.id, 'cutting-over') as { note?: string | null } | undefined;
    if (current?.note === CUTOVER_BEGIN_IN_PROGRESS) return { ok: false, code: CUTOVER_BEGIN_IN_PROGRESS };
    if (!hasImportedClaudeSlot(db)) return { ok: false, code: 'import-not-complete' };
    if (!manualRoundTripDone(db)) return { ok: false, code: 'manual-round-trip-required' };
    if (configValue(db, 'keychain.liveItemsAuthorizedAt') == null) return { ok: false, code: 'keychain-live-items-not-authorized' };
    for (const provider of PI_PROVIDERS) {
      const state = configValue(db, `pi.${provider}.state`);
      if (state !== 'migrated' && state !== 'not-applicable') return { ok: false, code: `pi-state-missing:${provider}` };
    }
    if (hasSharedAnthropicTarget(db)) {
      const sessions = stalePiSessions(db);
      if (sessions === 'stale') return { ok: false, code: 'pi-stale-sessions-shared' };
      if (sessions === 'unknown') return { ok: false, code: 'pi-stale-sessions-unknown' };
    }
    const now = opts.now ?? Date.now();
    const changed = db.prepare(`UPDATE lifecycle SET state = 'cutover', cutover_at = ?, window_end = ?, release_sha = ?
      WHERE id = ? AND state = 'cutting-over'`)
      .run(now, now + 7 * DAY_MS, opts.releaseSha ?? null, admission.row!.id).changes;
    if (changed !== 1) return { ok: false, code: 'transition=cutting-over->cutover' };
    return { ok: true, row: phase(store) };
  });
}

/** S55 permits exactly one extension from the fixed +7d window to +14d. */
export function extendWindow(store: Store, now: number = Date.now()): LifecycleResult {
  const current = phase(store);
  if (current.state !== 'cutover') return { ok: false, code: `phase=${current.state}`, row: current };
  if (current.extendedAt != null) return { ok: false, code: 'window-already-extended', row: current };
  return withDb(store, (db) => {
    db.prepare('UPDATE lifecycle SET window_end = ?, extended_at = ? WHERE id = ?')
      .run((current.cutoverAt ?? now) + 14 * DAY_MS, now, current.id);
    return { ok: true, row: phase(store) };
  });
}

export function markDrillDone(store: Store, now: number = Date.now()): LifecycleResult {
  const current = phase(store);
  if (current.state !== 'cutover') return { ok: false, code: `phase=${current.state}`, row: current };
  withDb(store, (db) => db.prepare('UPDATE lifecycle SET drill_done_at = ? WHERE id = ?').run(now, current.id));
  return { ok: true, row: phase(store) };
}

export function closeLifecycle(store: Store, id: number, note: string, now: number = Date.now()): LifecycleResult {
  const current = phase(store);
  if (!['rolled-back', 'aborted', 'retired'].includes(current.state) || current.id !== id) {
    return { ok: false, code: `phase=${current.state}`, row: current };
  }
  withDb(store, (db) => db.prepare("UPDATE lifecycle SET state = 'closed', closed_at = ?, note = ? WHERE id = ?").run(now, note, id));
  return { ok: true, row: phase(store) };
}

export function lifecycleCheck(store: Pick<Store, 'dbPath'>, kind: 'window' | 'drill', now: number = Date.now()): { level: 'PASS' | 'WARN' | 'FAIL'; message: string } {
  const current = phase(store);
  if (current.state !== 'cutover') return { level: 'PASS', message: `not applicable in ${current.state}` };
  if (kind === 'window') {
    return current.windowEnd != null && now > current.windowEnd
      ? { level: 'WARN', message: 'cutover window has ended; run report cutover' }
      : { level: 'PASS', message: 'cutover window is active' };
  }
  return current.drillDoneAt == null
    ? { level: 'WARN', message: 'cutover fire drill is not recorded' }
    : { level: 'PASS', message: 'cutover fire drill is recorded' };
}
