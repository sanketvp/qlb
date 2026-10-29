import type { DatabaseSync } from 'node:sqlite';

import { inspectAccountSafety } from './accounts-prune';
import { observationConfigKey } from './candidates';
import { failoverConfigKey } from './overrides';
import { refreshLeaseName } from './store';

export type CodexRekeyReason =
  | 'no-provider'
  | 'no-slot'
  | 'ambiguous'
  | 'recovery-pending'
  | 'journal-untrusted'
  | 'journal-named'
  | 'provider-mismatch'
  | 'in-use';

export interface CodexRekeyProspectiveSlot {
  accountId: string;
  chatgptAccountId: string;
}

export interface CodexRekeyMove {
  from: string;
  to: string;
  kind: 'rename' | 'merge' | 'orphan';
}

export interface CodexRekeySkipped {
  id: string;
  reason: CodexRekeyReason;
}

export interface CodexRekeyPlan {
  moves: CodexRekeyMove[];
  skipped: CodexRekeySkipped[];
}

export interface PlanCodexRekeyOptions {
  now: number;
  prospective?: CodexRekeyProspectiveSlot;
}

export interface ApplyCodexRekeyOptions {
  now: number;
  /** Test-only seam for proving a caller transaction rolls back when a dependent remains. */
  testOnlyBeforeMergeCount?: (db: DatabaseSync, move: CodexRekeyMove) => void;
}

type RekeyAuditEntry = {
  to: string;
  kind: CodexRekeyMove['kind'];
  at: number;
};

type Candidate = { id: string; kind: 'account' | 'orphan' };
type Slot = { account_id: string; chatgpt_account_id: string };

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Builds the Codex legacy-id conversion work list without changing the store. */
export function planCodexRekey(db: DatabaseSync, options: PlanCodexRekeyOptions): CodexRekeyPlan {
  const slots = new Map<string, string>();
  for (const slot of db.prepare('SELECT account_id, chatgpt_account_id FROM codex_slots').all() as Slot[]) {
    slots.set(slot.account_id, slot.chatgpt_account_id);
  }
  if (options.prospective) {
    slots.set(options.prospective.accountId, options.prospective.chatgptAccountId);
  }

  const slotBares = new Map<string, string[]>();
  for (const [accountId, chatgptAccountId] of slots) {
    const matches = slotBares.get(chatgptAccountId) ?? [];
    matches.push(accountId);
    slotBares.set(chatgptAccountId, matches);
  }

  const accountRows = db.prepare('SELECT id, provider FROM accounts').all() as Array<{
    id: string;
    provider: string | null;
  }>;
  const accountIds = new Set(accountRows.map((row) => row.id));
  const accountsById = new Map(accountRows.map((row) => [row.id, row]));
  const candidates = new Map<string, Candidate>();
  const skipped = new Map<string, CodexRekeyReason>();

  for (const row of accountRows) {
    if (row.provider === 'openai-codex' && (row.id === 'codex-default' || !row.id.includes(':'))) {
      candidates.set(row.id, { id: row.id, kind: 'account' });
    }
    if (row.provider === null && (row.id === 'codex-default' || slotBares.has(row.id))) {
      skipped.set(row.id, 'no-provider');
    }
  }

  const dependentIds = new Set<string>();
  const addDependentIds = (sql: string, ...parameters: string[]) => {
    const rows = db.prepare(sql).all(...parameters) as Array<{ id: unknown }>;
    for (const row of rows) {
      if (typeof row.id === 'string') dependentIds.add(row.id);
    }
  };
  addDependentIds('SELECT account_id AS id FROM snapshots');
  addDependentIds('SELECT account_id AS id FROM overrides');
  addDependentIds('SELECT account_id AS id FROM poll_claims');
  addDependentIds('SELECT account_id AS id FROM usage_polls WHERE provider = ?', 'openai-codex');
  const refreshPrefix = refreshLeaseName('');
  addDependentIds(
    'SELECT substr(name, ?) AS id FROM leases WHERE substr(name, 1, ?) = ?',
    String(refreshPrefix.length + 1),
    String(refreshPrefix.length),
    refreshPrefix,
  );

  const codexUsagePollIds = new Set(
    (db.prepare("SELECT account_id FROM usage_polls WHERE provider = 'openai-codex'").all() as Array<{ account_id: string }>)
      .map((row) => row.account_id),
  );
  for (const id of dependentIds) {
    if (accountIds.has(id)) continue;
    const provablyCodex = id === 'codex-default'
      || slotBares.has(id)
      || (!id.includes(':') && codexUsagePollIds.has(id));
    if (provablyCodex) candidates.set(id, { id, kind: 'orphan' });
  }

  const orderedCandidates = [...candidates.values()]
    .filter((candidate) => {
      const targets = candidate.id === 'codex-default'
        ? [...slots.keys()]
        : slotBares.get(candidate.id) ?? [];
      return targets.length !== 1 || targets[0] !== candidate.id;
    })
    .sort((a, b) => byteOrder(a.id, b.id));
  const result = (): CodexRekeyPlan => ({
    moves: [],
    skipped: [...skipped.entries()]
      .sort(([a], [b]) => byteOrder(a, b))
      .map(([id, reason]) => ({ id, reason })),
  });
  const skipEveryCandidate = (reason: Extract<CodexRekeyReason, 'recovery-pending' | 'journal-untrusted'>): CodexRekeyPlan => {
    for (const candidate of orderedCandidates) skipped.set(candidate.id, reason);
    return result();
  };

  if (db.prepare("SELECT 1 FROM config WHERE key = 'migrations.recovery_pending'").get()) {
    return skipEveryCandidate('recovery-pending');
  }

  const migrations = db.prepare('SELECT store, state, detail_json FROM migrations').all() as Array<{
    store: string;
    state: string;
    detail_json: string | null;
  }>;
  const lookupProvider = (id: string) => {
    const row = accountsById.get(id);
    return row
      ? { present: true as const, provider: row.provider }
      : { present: false as const };
  };
  if (inspectAccountSafety(migrations, '', lookupProvider).unsafe) {
    return skipEveryCandidate('journal-untrusted');
  }

  const liveLeaseNames = new Set(
    (db.prepare('SELECT name FROM leases WHERE until > ?').all(options.now) as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const livePollClaimIds = new Set(
    (db.prepare('SELECT account_id FROM poll_claims WHERE until IS NULL OR until > ?').all(options.now) as Array<{ account_id: string }>)
      .map((row) => row.account_id),
  );
  const inUse = (id: string): boolean =>
    liveLeaseNames.has(refreshLeaseName(id)) || livePollClaimIds.has(id);
  const candidatesWithTargets: Array<Candidate & { to: string }> = [];
  for (const candidate of orderedCandidates) {
    if (skipped.has(candidate.id)) continue;
    const targets = candidate.id === 'codex-default'
      ? [...slots.keys()]
      : slotBares.get(candidate.id) ?? [];
    if (targets.length === 0) {
      skipped.set(candidate.id, 'no-slot');
      continue;
    }
    if (targets.length > 1) {
      skipped.set(candidate.id, 'ambiguous');
      continue;
    }
    if (candidate.id === targets[0]) continue;
    candidatesWithTargets.push({ ...candidate, to: targets[0]! });
  }

  const busyTargets = new Set(
    candidatesWithTargets
      .filter((candidate) => inUse(candidate.id) || inUse(candidate.to))
      .map((candidate) => candidate.to),
  );
  const eligible: Array<Candidate & { to: string }> = [];
  for (const candidate of candidatesWithTargets) {
    if (busyTargets.has(candidate.to)) {
      skipped.set(candidate.id, 'in-use');
      continue;
    }
    const safety = inspectAccountSafety(migrations, candidate.id, lookupProvider);
    if (safety.unsafe) {
      skipped.set(candidate.id, safety.reason === 'untrusted' ? 'journal-untrusted' : 'journal-named');
      continue;
    }
    const target = accountsById.get(candidate.to);
    if (target && target.provider !== 'openai-codex') {
      skipped.set(candidate.id, 'provider-mismatch');
      continue;
    }
    eligible.push(candidate);
  }

  const targetIds = new Set(accountIds);
  const moves: CodexRekeyMove[] = [];
  for (const candidate of eligible) {
    moves.push({
      from: candidate.id,
      to: candidate.to,
      kind: candidate.kind === 'orphan' ? 'orphan' : targetIds.has(candidate.to) ? 'merge' : 'rename',
    });
    targetIds.add(candidate.to);
  }

  return {
    moves,
    skipped: [...skipped.entries()]
      .sort(([a], [b]) => byteOrder(a, b))
      .map(([id, reason]) => ({ id, reason })),
  };
}

/** Ensures an orphan destination is visible as an active Codex account. */
export function ensureCodexSlotAccount(db: DatabaseSync, id: string, ts: number): void {
  db.prepare(`INSERT INTO accounts (id, provider, label, status, created_at)
    VALUES (?, 'openai-codex', ?, 'active', ?)
    ON CONFLICT(id) DO NOTHING`).run(id, id, ts);
}

function emptyRekeyAudit(): Record<string, RekeyAuditEntry> {
  return Object.create(null) as Record<string, RekeyAuditEntry>;
}

function readRekeyAudit(db: DatabaseSync): Record<string, RekeyAuditEntry> {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('codex.rekey.v1') as { value: string } | undefined;
  if (!row) return emptyRekeyAudit();
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyRekeyAudit();
    const audit = emptyRekeyAudit();
    for (const [id, entry] of Object.entries(parsed)) audit[id] = entry as RekeyAuditEntry;
    return audit;
  } catch {
    return emptyRekeyAudit();
  }
}

function moveSnapshots(db: DatabaseSync, from: string, to: string): void {
  const sourceRows = db.prepare('SELECT rowid, bucket, fetched_at FROM snapshots WHERE account_id = ?').all(from) as Array<{
    rowid: number;
    bucket: string | null;
    fetched_at: number | null;
  }>;
  const findTarget = db.prepare('SELECT rowid, fetched_at FROM snapshots WHERE account_id = ? AND bucket = ?');
  const moveSource = db.prepare('UPDATE snapshots SET account_id = ? WHERE rowid = ?');
  const deleteSnapshot = db.prepare('DELETE FROM snapshots WHERE rowid = ?');

  for (const source of sourceRows) {
    if (source.bucket === null) {
      moveSource.run(to, source.rowid);
      continue;
    }
    const target = findTarget.get(to, source.bucket) as { rowid: number; fetched_at: number | null } | undefined;
    if (!target) {
      moveSource.run(to, source.rowid);
      continue;
    }
    const sourceWins = source.fetched_at !== null
      && (target.fetched_at === null || source.fetched_at > target.fetched_at);
    if (sourceWins) {
      deleteSnapshot.run(target.rowid);
      moveSource.run(to, source.rowid);
    } else {
      deleteSnapshot.run(source.rowid);
    }
  }
}

function moveOverrides(db: DatabaseSync, from: string, to: string): void {
  db.prepare('UPDATE overrides SET account_id = ? WHERE account_id = ?').run(to, from);
  db.prepare(`DELETE FROM overrides AS duplicate
    WHERE duplicate.account_id = ? AND EXISTS (
      SELECT 1 FROM overrides AS kept
      WHERE kept.account_id = duplicate.account_id
        AND kept.kind IS duplicate.kind
        AND kept.session IS duplicate.session
        AND kept.until IS duplicate.until
        AND kept.rowid < duplicate.rowid
    )`).run(to);
}

function movePollClaim(db: DatabaseSync, from: string, to: string, now: number): void {
  const source = db.prepare('SELECT 1 FROM poll_claims WHERE account_id = ?').get(from);
  if (!source) return;
  const target = db.prepare('SELECT 1 FROM poll_claims WHERE account_id = ?').get(to);
  if (target) {
    db.prepare('DELETE FROM poll_claims WHERE account_id = ? AND until IS NOT NULL AND until <= ?').run(from, now);
  } else {
    db.prepare('UPDATE poll_claims SET account_id = ? WHERE account_id = ?').run(to, from);
  }
}

type UsagePollSchedule = {
  last_fetch_at: number | null;
  last_attempt_at: number | null;
  next_due_at: number | null;
  poll_interval_s: number | null;
  last_status: string | null;
  consecutive_failures: number | null;
  backoff_until: number | null;
  last_429_at: number | null;
  held_until: number | null;
};

function maximumIgnoringNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function statusFromNewerPoll(source: UsagePollSchedule, target: UsagePollSchedule): string | null {
  if (source.last_attempt_at !== null
    && (target.last_attempt_at === null || source.last_attempt_at > target.last_attempt_at)) {
    return source.last_status;
  }
  if (target.last_attempt_at !== null
    && (source.last_attempt_at === null || target.last_attempt_at > source.last_attempt_at)) {
    return target.last_status;
  }
  if (source.last_fetch_at !== null
    && (target.last_fetch_at === null || source.last_fetch_at > target.last_fetch_at)) {
    return source.last_status;
  }
  return target.last_status;
}

function moveUsagePoll(db: DatabaseSync, from: string, to: string): void {
  const findPoll = db.prepare(`SELECT last_fetch_at, last_attempt_at, next_due_at, poll_interval_s,
    last_status, consecutive_failures, backoff_until, last_429_at, held_until
    FROM usage_polls WHERE provider = 'openai-codex' AND account_id = ?`);
  const source = findPoll.get(from) as UsagePollSchedule | undefined;
  if (!source) return;
  const target = findPoll.get(to) as UsagePollSchedule | undefined;
  if (!target) {
    db.prepare(`UPDATE usage_polls SET account_id = ?
      WHERE provider = 'openai-codex' AND account_id = ?`).run(to, from);
    return;
  }

  db.prepare(`UPDATE usage_polls SET
    next_due_at = ?, held_until = ?, backoff_until = ?, last_429_at = ?, poll_interval_s = ?,
    consecutive_failures = ?, last_attempt_at = ?, last_fetch_at = ?, last_status = ?
    WHERE provider = 'openai-codex' AND account_id = ?`).run(
    maximumIgnoringNull(source.next_due_at, target.next_due_at),
    maximumIgnoringNull(source.held_until, target.held_until),
    maximumIgnoringNull(source.backoff_until, target.backoff_until),
    maximumIgnoringNull(source.last_429_at, target.last_429_at),
    maximumIgnoringNull(source.poll_interval_s, target.poll_interval_s),
    maximumIgnoringNull(source.consecutive_failures, target.consecutive_failures),
    maximumIgnoringNull(source.last_attempt_at, target.last_attempt_at),
    maximumIgnoringNull(source.last_fetch_at, target.last_fetch_at),
    statusFromNewerPoll(source, target),
    to,
  );
  db.prepare(`DELETE FROM usage_polls
    WHERE provider = 'openai-codex' AND account_id = ?`).run(from);
}

function moveLease(db: DatabaseSync, from: string, to: string, now: number): void {
  const sourceName = refreshLeaseName(from);
  const targetName = refreshLeaseName(to);
  const source = db.prepare('SELECT 1 FROM leases WHERE name = ?').get(sourceName);
  if (!source) return;
  const target = db.prepare('SELECT 1 FROM leases WHERE name = ?').get(targetName);
  if (target) {
    db.prepare('DELETE FROM leases WHERE name = ? AND until IS NOT NULL AND until <= ?').run(sourceName, now);
  } else {
    db.prepare('UPDATE leases SET name = ? WHERE name = ?').run(targetName, sourceName);
  }
}

function remainingDependents(db: DatabaseSync, id: string): number {
  const row = db.prepare(`SELECT
    (SELECT count(*) FROM snapshots WHERE account_id = ?) +
    (SELECT count(*) FROM overrides WHERE account_id = ?) +
    (SELECT count(*) FROM poll_claims WHERE account_id = ?) +
    (SELECT count(*) FROM usage_polls WHERE provider = 'openai-codex' AND account_id = ?) +
    (SELECT count(*) FROM leases WHERE name = ?) AS count`)
    .get(id, id, id, id, refreshLeaseName(id)) as { count: number };
  return row.count;
}

/** Applies a previously classified plan inside its caller-owned transaction. */
export function applyCodexRekey(
  db: DatabaseSync,
  plan: CodexRekeyPlan,
  options: ApplyCodexRekeyOptions,
): void {
  if (!db.isTransaction) throw new Error('rekey-needs-transaction');
  if (plan.moves.some((move) => move.from === move.to)) throw new Error('rekey-self-move');
  if (plan.moves.length === 0) return;

  const audit = readRekeyAudit(db);
  const renameAccount = db.prepare('UPDATE accounts SET id = ? WHERE id = ?');
  const deleteAccount = db.prepare('DELETE FROM accounts WHERE id = ?');
  const updateFailover = db.prepare(`UPDATE config SET value = ?
    WHERE key = ? AND value = ?`);
  const failoverKey = failoverConfigKey('openai-codex');
  const observationKey = observationConfigKey('openai-codex');

  for (const move of plan.moves) {
    moveSnapshots(db, move.from, move.to);
    moveOverrides(db, move.from, move.to);
    movePollClaim(db, move.from, move.to, options.now);
    moveUsagePoll(db, move.from, move.to);
    moveLease(db, move.from, move.to, options.now);
    if (move.kind === 'rename') renameAccount.run(move.to, move.from);
    if (move.kind === 'merge') {
      options.testOnlyBeforeMergeCount?.(db, move);
      if (remainingDependents(db, move.from) !== 0) throw new Error('rekey-dependents-remain');
      deleteAccount.run(move.from);
    }
    if (move.kind === 'orphan') ensureCodexSlotAccount(db, move.to, options.now);
    updateFailover.run(move.to, failoverKey, move.from);
    audit[move.from] = {
      to: move.to,
      kind: move.kind,
      at: options.now,
    };
  }

  db.prepare('DELETE FROM config WHERE key = ?').run(observationKey);
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run('codex.rekey.v1', JSON.stringify(audit));
}
