import type { DatabaseSync } from 'node:sqlite';

import { inspectAccountSafety } from './accounts-prune';
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

  const orderedCandidates = [...candidates.values()].sort((a, b) => byteOrder(a.id, b.id));
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
