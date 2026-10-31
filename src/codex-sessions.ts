import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { codexIdentityKey, type CodexIdentity } from './codex-auth';
import { readCodexSwitchJournal } from './codex-switch';

const execFileAsync = promisify(execFile);

export interface CodexProcess {
  pid: number;
  /** `ps lstart`, rendered under LC_ALL=C and TZ=UTC. */
  lstart: string;
  /** Executable basename, suitable for operator-facing status text. */
  host: string;
}

/** The `switch_log.outcome` values defined by the Codex switch protocol. */
export type CodexSwitchOutcome =
  | 'ok'
  | 'rolled-back'
  | 'failed'
  | 'refused'
  | 'noop'
  | 'reverted-by-codex'
  | 'in-flight';

export interface CodexSwitchLogRow {
  /** Must be `openai-codex`; callers must not pass shared-log rows from another provider. */
  provider: string;
  /** Stable `switch_log.id`, used to break same-millisecond timestamp ties. */
  id: number;
  /** The attempted switch source. */
  fromAccountId: string | null;
  toAccountId: string;
  outcome: CodexSwitchOutcome;
  /** `switch_log.published_at`, journaled before QLB's atomic publish when present. */
  publishedAt: number | null;
  /** `switch_log.ts`, the row creation/attempt timestamp when no publication exists. */
  attemptedAt: number | null;
  /** Raw switch metadata retained for later switch-history consumers. */
  detail?: string | null;
  published_at?: number | null;
  steps_json?: string | null;
  open_sessions_json?: string | null;
  /** Every account fenced by an unresolved or malformed recovery record. */
  involved?: string[];
}

export interface HolderEra {
  identity: string;
  startsAt: number | null;
  endsAt: number | null;
}

/** A time interval during which each listed identity may be held by a Codex process. */
export interface HolderSet {
  identities: string[];
  startsAt: number | null;
  endsAt: number | null;
  /** True only for time before the first persisted live observation. */
  prehistory: boolean;
}

/** A credential-free observation of the identity Codex had live at a moment. */
export interface CodexLiveObservation {
  ts: number;
  identity: string | null;
  lineageFp: string | null;
  by: string;
}

export interface CodexSwitchHistory {
  rows: CodexSwitchLogRow[];
  observations: CodexLiveObservation[];
}

/** Splits Codex's composite identity at its first separator. */
export function codexIdentityParts(slotId: string): CodexIdentity {
  const separator = slotId.indexOf(':');
  return {
    chatgpt_user_id: slotId.slice(0, separator),
    account_id: slotId.slice(separator + 1),
  };
}

export interface CodexRecoveryFence {
  v: 1;
  switchId: number;
  attempt: string;
  from: string;
  to: string;
  publishedAt: number;
  reason: string;
  involvedAccounts: string[] | '*';
  since: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Recovery fences are deliberately an exact, credential-free config shape. */
export function parseCodexRecoveryFence(value: string | null): CodexRecoveryFence | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)
      || Object.keys(parsed).length !== 9
      || !['v', 'switchId', 'attempt', 'from', 'to', 'publishedAt', 'reason', 'involvedAccounts', 'since']
        .every((key) => Object.hasOwn(parsed, key))
      || parsed.v !== 1
      || !Number.isSafeInteger(parsed.switchId)
      || !nonEmptyString(parsed.attempt)
      || !nonEmptyString(parsed.from)
      || !nonEmptyString(parsed.to)
      || typeof parsed.publishedAt !== 'number' || !Number.isFinite(parsed.publishedAt)
      || !nonEmptyString(parsed.reason)
      || typeof parsed.since !== 'number' || !Number.isFinite(parsed.since)
      || (parsed.involvedAccounts !== '*' && (!Array.isArray(parsed.involvedAccounts)
        || !parsed.involvedAccounts.every(nonEmptyString)))) return null;
    return {
      v: 1, switchId: parsed.switchId as number, attempt: parsed.attempt, from: parsed.from, to: parsed.to,
      publishedAt: parsed.publishedAt, reason: parsed.reason,
      involvedAccounts: parsed.involvedAccounts === '*' ? '*' : [...parsed.involvedAccounts],
      since: parsed.since,
    };
  } catch {
    return null;
  }
}

function attemptFromSteps(stepsJson: string | null | undefined): string | null {
  if (stepsJson === null || stepsJson === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(stepsJson);
    return isRecord(parsed) && nonEmptyString(parsed.attempt) ? parsed.attempt : null;
  } catch {
    return null;
  }
}

function expandInvolvedAccounts(accounts: string[] | '*', slots: readonly string[]): string[] {
  return accounts === '*' ? [...slots] : [...new Set(accounts)];
}

function syntheticRowId(rows: readonly CodexSwitchLogRow[]): number {
  const used = new Set(rows.map((row) => row.id));
  let id = 0;
  while (used.has(id)) id -= 1;
  return id;
}

/** Reads the credential-free Codex switch history without taking a write lock. */
export function readCodexSwitchHistory(
  dbPath: string,
  options: { journalDir?: string } = {},
): CodexSwitchHistory {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const rows: CodexSwitchLogRow[] = db.prepare(`SELECT id, provider, from_account, to_account, outcome, detail, published_at, steps_json, open_sessions_json, ts
      FROM switch_log WHERE provider = 'openai-codex' ORDER BY published_at, ts, id`).all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        // A stored but malformed publication time stays non-null (NaN): rowTime then
        // refuses it, and it is never read as proof that the switch was not published.
        const publishedAt = r.published_at === null || r.published_at === undefined
          ? null
          : typeof r.published_at === 'number' ? r.published_at : Number.NaN;
        return {
          id: Number(r.id), provider: String(r.provider),
          fromAccountId: typeof r.from_account === 'string' ? r.from_account : null,
          toAccountId: String(r.to_account), outcome: r.outcome as CodexSwitchLogRow['outcome'],
          publishedAt,
          attemptedAt: typeof r.ts === 'number' ? r.ts : null,
          detail: typeof r.detail === 'string' ? r.detail : null,
          published_at: publishedAt,
          steps_json: typeof r.steps_json === 'string' ? r.steps_json : null,
          open_sessions_json: typeof r.open_sessions_json === 'string' ? r.open_sessions_json : null,
        } satisfies CodexSwitchLogRow;
      });
    const slots = db.prepare('SELECT account_id FROM codex_slots ORDER BY account_id').all()
      .map((row) => String((row as { account_id: unknown }).account_id));
    const config = db.prepare("SELECT value FROM config WHERE key = 'codex.recoveryFence'").get() as { value?: unknown } | undefined;
    const fenceValue = config?.value;
    const recoveryFence = typeof fenceValue === 'string' ? parseCodexRecoveryFence(fenceValue) : null;
    // Any stored value that is not the exact fence shape (a non-string or NULL included) fails
    // closed. Clearing a fence deletes the row, so only an absent row means no fence.
    const malformedFence = config !== undefined && recoveryFence === null;
    const journal = readCodexSwitchJournal({ journalDir: options.journalDir });
    // A journal that exists but cannot be parsed is never treated as absent.
    const malformedJournal = journal.state === 'malformed';
    // A not-published row is skipped by the holder sets, so it never stands in
    // for a journal that is still on disk.
    const journalNeedsRow = journal.state === 'ok'
      && !rows.some((row) => !notPublished(row) && attemptFromSteps(row.steps_json) === journal.journal.attemptId);

    // A journal always involves its own endpoints, even when its unresolved set is '*' or omits one.
    const journalInvolved = journalNeedsRow
      ? [...new Set([journal.journal.from, journal.journal.to,
        ...expandInvolvedAccounts(journal.journal.unresolved?.involvedAccounts ?? [], slots)])]
      : [];
    const fenceInvolved = recoveryFence === null ? []
      : [recoveryFence.from, recoveryFence.to, ...expandInvolvedAccounts(recoveryFence.involvedAccounts, slots)];
    let synthetic: Omit<CodexSwitchLogRow, 'id'> | undefined;
    if (malformedFence || malformedJournal) {
      // A malformed durable fence or journal is conservatively active from the
      // epoch: its missing switch metadata cannot justify excluding any slot.
      synthetic = {
        provider: 'openai-codex', fromAccountId: null, toAccountId: slots[0] ?? '',
        outcome: 'in-flight', publishedAt: 0, attemptedAt: 0,
        // '*' never drops an account that a still-valid fence or journal names.
        open_sessions_json: '[]', involved: [...new Set([...slots, ...fenceInvolved, ...journalInvolved])],
      };
    } else if (recoveryFence !== null) {
      const source = rows.find((row) => row.id === recoveryFence.switchId);
      synthetic = {
        provider: 'openai-codex', fromAccountId: recoveryFence.from, toAccountId: recoveryFence.to,
        outcome: 'in-flight', publishedAt: recoveryFence.publishedAt, attemptedAt: recoveryFence.publishedAt,
        open_sessions_json: source?.open_sessions_json ?? '[]',
        // Involved sets are only ever unioned, never shrunk: keep an uncommitted journal's accounts too.
        involved: [...new Set([...fenceInvolved, ...journalInvolved])],
      };
    } else if (journalNeedsRow) {
      synthetic = {
        provider: 'openai-codex', fromAccountId: journal.journal.from, toAccountId: journal.journal.to,
        outcome: 'in-flight', publishedAt: journal.journal.publishedAt, attemptedAt: journal.journal.publishedAt,
        open_sessions_json: JSON.stringify(journal.journal.openSessions), involved: journalInvolved,
      };
    }
    if (synthetic !== undefined) rows.push({ id: syntheticRowId(rows), ...synthetic });

    return {
      rows: rows.sort(compareRows),
      observations: db.prepare('SELECT ts, identity, lineage_fp, by FROM codex_live_observations ORDER BY ts, id').all()
        .map((row) => {
          const r = row as Record<string, unknown>;
          return {
            ts: Number(r.ts), identity: typeof r.identity === 'string' ? r.identity : null,
            lineageFp: typeof r.lineage_fp === 'string' ? r.lineage_fp : null,
            by: String(r.by),
          };
        }),
    };
  } finally {
    db.close();
  }
}

export interface PsOptions {
  env: {
    LC_ALL: 'C';
    TZ: 'UTC';
    PATH?: string;
  };
}

export type PsRunner = (
  command: string,
  args: string[],
  options: PsOptions,
) => Promise<string>;

export interface CodexSessionsOptions {
  runPs?: PsRunner;
}

const PS_ENV: PsOptions['env'] = {
  LC_ALL: 'C',
  TZ: 'UTC',
  ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
};

async function runPsDefault(
  command: string,
  args: string[],
  options: PsOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    env: options.env,
  });
  return stdout;
}

function parseProcessLine(line: string): CodexProcess | null {
  const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(line);
  if (!match) return null;

  const pid = Number(match[1]);
  const executable = basename(match[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || executable !== 'codex') return null;
  return { pid, lstart: match[2].replace(/\s+/g, ' '), host: executable };
}

/**
 * Lists running Codex executables. The process list is injectable so callers
 * can test all liveness decisions without reading a live credential store.
 */
export async function list(options: CodexSessionsOptions = {}): Promise<CodexProcess[]> {
  const runPs = options.runPs ?? runPsDefault;
  const output = await runPs('ps', ['-axo', 'pid=,lstart=,comm='], { env: PS_ENV });
  return output
    .split('\n')
    .map(parseProcessLine)
    .filter((process): process is CodexProcess => process !== null);
}

/**
 * A PID can be recycled. `lstart` is therefore part of a process identity.
 * This mirrors the same-account reload guard in Codex's auth manager
 * (rust-v0.164.0: codex-rs/login/src/auth/manager.rs:1932-1938).
 */
export async function stillTheSameProcess(
  recorded: Pick<CodexProcess, 'pid' | 'lstart'>,
  options: CodexSessionsOptions = {},
): Promise<boolean> {
  const currentLstart = await processLstart(recorded.pid, options);
  return currentLstart !== null && currentLstart.length > 0 && currentLstart === recorded.lstart.replace(/\s+/g, ' ');
}

/**
 * A process's `ps lstart` in the exact form stillTheSameProcess compares, so a
 * recorded owner (C6-10) is recognised while it lives. Null when it is absent.
 */
export async function processLstart(pid: number, options: CodexSessionsOptions = {}): Promise<string | null> {
  const runPs = options.runPs ?? runPsDefault;
  try {
    const output = await runPs('ps', ['-p', String(pid), '-o', 'lstart='], {
      env: PS_ENV,
    });
    return output.trim().replace(/\s+/g, ' ');
  } catch (error) {
    // `ps -p <pid>` exits 1 exactly when that PID is absent. Permission,
    // spawn, and other failures leave liveness unknown and must reach callers.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
      return null;
    }
    throw error;
  }
}

function notPublished(row: CodexSwitchLogRow): boolean {
  return row.outcome === 'failed' && row.detail === 'not-published' && row.publishedAt === null;
}

function isWritingRow(outcome: CodexSwitchOutcome): boolean {
  return outcome !== 'refused' && outcome !== 'noop';
}

function rowTime(row: CodexSwitchLogRow): number {
  // A non-null but malformed publication time is not allowed to silently fall
  // back to `ts`: `published_at` is authoritative whenever the writer supplied it.
  const time = row.publishedAt === null ? row.attemptedAt : row.publishedAt;
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new Error('Invalid Codex switch-log row time');
  }
  return time;
}

function compareRows(a: CodexSwitchLogRow, b: CodexSwitchLogRow): number {
  return rowTime(a) - rowTime(b) || a.id - b.id;
}

/**
 * Reconstructs conservative, possibly-live holder eras for Codex. This is an
 * interim conservative rule; replaced by S12 holder sets in slice C5b; may
 * over-count holders (safe), never under-count. Every input row must be for
 * `openai-codex`. A writing row (anything except `refused` or `noop`) makes
 * both sides possibly live from its row time, except the Q1 marker (I11:
 * `failed`, `not-published`, no `published_at`), which opens and closes
 * nothing and so is not the first row either; an `ok` row then definitely
 * replaces its source at that same instant.
 */
export function holderEras(switchLogRows: readonly CodexSwitchLogRow[]): HolderEra[] {
  if (switchLogRows.length === 0) return [];

  for (const row of switchLogRows) {
    if (row.provider !== 'openai-codex') {
      throw new Error('Non-Codex provider in Codex switch-log rows');
    }
    if (!Number.isSafeInteger(row.id)) {
      throw new Error('Invalid Codex switch-log row id');
    }
    // The first-row rule also needs a deterministic timestamp. In the schema
    // this is `switch_log.ts`, which is non-null for every attempted switch.
    rowTime(row);
  }

  const rows = switchLogRows.filter((row) => !notPublished(row)).sort(compareRows);
  if (rows.length === 0) return [];

  const eras: HolderEra[] = [];
  const live = new Map<string, number | null>();
  const first = rows[0];
  if (first.fromAccountId !== null) live.set(first.fromAccountId, null);
  const fenced = fencedIdentities(rows);

  const start = (identity: string | null, startsAt: number): void => {
    if (identity !== null && identity.length > 0 && !live.has(identity)) live.set(identity, startsAt);
  };
  const end = (identity: string | null, endsAt: number): void => {
    // While a recovery fence stands, nothing ends an involved account's era (I12).
    if (identity === null || fenced.has(identity)) return;
    const startsAt = live.get(identity);
    if (startsAt !== undefined || live.has(identity)) {
      eras.push({ identity, startsAt: startsAt!, endsAt });
      live.delete(identity);
    }
  };

  for (const row of rows) {
    if (!isWritingRow(row.outcome)) continue;
    const time = rowTime(row);
    if (row.outcome === 'ok') {
      // Every writing row makes both sides possibly live. Re-starting the
      // source before its definite replacement records even a zero-length era.
      start(row.fromAccountId, time);
      end(row.fromAccountId, time);
      start(row.toAccountId, time);
    } else {
      start(row.fromAccountId, time);
      start(row.toAccountId, time);
      if (row.outcome === 'in-flight') {
        for (const accountId of row.involved ?? []) start(accountId, time);
      }
    }
  }

  for (const [identity, startsAt] of live) {
    eras.push({ identity, startsAt, endsAt: null });
  }
  return eras.sort((a, b) =>
    (a.startsAt ?? Number.NEGATIVE_INFINITY) - (b.startsAt ?? Number.NEGATIVE_INFINITY)
      || (a.endsAt ?? Number.POSITIVE_INFINITY) - (b.endsAt ?? Number.POSITIVE_INFINITY)
      || a.identity.localeCompare(b.identity),
  );
}

/**
 * Every account a standing recovery fence keeps live. Only the synthetic row
 * from readCodexSwitchHistory carries `involved`; a stored row never does.
 */
function fencedIdentities(rows: readonly CodexSwitchLogRow[]): Set<string> {
  const fenced = new Set<string>();
  for (const row of rows) {
    if (row.outcome !== 'in-flight' || row.involved === undefined) continue;
    for (const identity of [row.fromAccountId, row.toAccountId, ...(row.involved ?? [])]) {
      if (identity) fenced.add(identity);
    }
  }
  return fenced;
}

function processStartedAt(process: CodexProcess): number | null {
  // Match the upstream process-start source and its UTC `lstart` contract;
  // its parser establishes the five-field format at process_detection.py:128-155.
  const parsed = Date.parse(`${process.lstart} UTC`);
  return Number.isFinite(parsed) ? parsed : null;
}

interface MutableHolderEra extends HolderEra {}

function isInInterval(era: HolderEra, time: number): boolean {
  return (era.startsAt === null || time >= era.startsAt)
    && (era.endsAt === null || time < era.endsAt);
}

function sameIdentities(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((identity, index) => identity === right[index]);
}

/**
 * Reconstructs S12's conservative holder sets. A successful atomic publish is
 * ambiguous for one `ps lstart` second on either side of `published_at`; a
 * drift with only two live observations remains ambiguous for the interval
 * bounded by those observations. This policy is QLB-specific: the upstream
 * oracle only supplies the process-start reading above, not Codex identity
 * transitions.
 */
export function holderSets(
  switchLogRows: readonly CodexSwitchLogRow[],
  observations: readonly CodexLiveObservation[],
): HolderSet[] {
  const switchEras: MutableHolderEra[] = holderEras(switchLogRows).map((era) => ({ ...era }));
  const rows = switchLogRows.filter((row) => !notPublished(row)).sort(compareRows);
  const fenced = fencedIdentities(rows);

  // `published_at`, when present, is the publish boundary; migrated v4 rows
  // use their attempted-at fallback. Intervals are half-open, so T + 1 s is
  // conclusively the target even though `ps lstart` has only second precision.
  for (const row of rows) {
    if (row.outcome !== 'ok') continue;
    const boundary = rowTime(row);
    for (const era of switchEras) {
      if (era.identity === row.fromAccountId && era.endsAt === boundary) {
        era.endsAt = boundary + 1_000;
      }
      if (era.identity === row.toAccountId && era.startsAt === boundary) {
        era.startsAt = boundary - 1_000;
      }
    }
  }

  // A later switch whose source is not the prior successful target proves a
  // missing/drifted transition. Retain both possibilities between the rows;
  // this keeps the C5 conservative behaviour without widening normal eras.
  let priorTarget: string | null = null;
  let priorTime: number | null = null;
  for (const row of rows) {
    if (!isWritingRow(row.outcome)) continue;
    const time = rowTime(row);
    if (priorTime !== null && row.fromAccountId !== null && row.fromAccountId !== priorTarget) {
      switchEras.push({ identity: row.fromAccountId, startsAt: priorTime, endsAt: time + 1_000 });
    }
    if (row.outcome === 'ok') {
      priorTarget = row.toAccountId;
      priorTime = time;
    }
  }

  const sortedObservations = [...observations].sort((a, b) => a.ts - b.ts
    || (a.identity ?? '').localeCompare(b.identity ?? '')
    || (a.lineageFp ?? '').localeCompare(b.lineageFp ?? '')
    || a.by.localeCompare(b.by));
  for (const observation of sortedObservations) {
    if (!Number.isFinite(observation.ts)) throw new Error('Invalid Codex live observation time');
    if (observation.identity !== null && observation.identity.length === 0) {
      throw new Error('Invalid Codex live observation identity');
    }
  }

  const observationGroups: Array<{ ts: number; identities: string[] }> = [];
  for (const observation of sortedObservations) {
    if (observation.identity === null) continue;
    const group = observationGroups.at(-1);
    if (group?.ts === observation.ts) {
      if (!group.identities.includes(observation.identity)) group.identities.push(observation.identity);
    } else {
      observationGroups.push({ ts: observation.ts, identities: [observation.identity] });
    }
  }
  for (const group of observationGroups) group.identities.sort();

  const explainingSwitch = (
    from: readonly string[],
    to: readonly string[],
    startsAt: number,
    endsAt: number,
  ): CodexSwitchLogRow | undefined => rows.find((row) => row.outcome === 'ok'
    && row.fromAccountId !== null
    && from.includes(row.fromAccountId)
    && to.includes(row.toAccountId)
    && rowTime(row) >= startsAt
    && rowTime(row) <= endsAt);
  const latestSwitchBoundary = (before: number): number | null => {
    const prior = rows.filter((row) => isWritingRow(row.outcome) && rowTime(row) <= before).at(-1);
    return prior === undefined ? null : rowTime(prior) - 1_000;
  };

  // Only transitions QLB did not create are drift intervals. A QLB `ok` row
  // already contributes its precise publish interval, so observations merely
  // confirm it instead of extending both holders to the observation times.
  for (let index = 0; index < observationGroups.length; index += 1) {
    const group = observationGroups[index];
    const previous = observationGroups[index - 1];
    const next = observationGroups[index + 1];
    const incoming = previous === undefined
      ? undefined
      : explainingSwitch(previous.identities, group.identities, previous.ts, group.ts);
    const outgoing = next === undefined
      ? undefined
      : explainingSwitch(group.identities, next.identities, group.ts, next.ts);
    const startsAt = previous === undefined
      ? latestSwitchBoundary(group.ts)
      : (incoming === undefined ? previous.ts - 1_000 : rowTime(incoming) - 1_000);
    const endsAt = next === undefined
      ? null
      : (outgoing === undefined ? next.ts + 1_000 : rowTime(outgoing) + 1_000);
    for (const identity of group.identities) {
      switchEras.push({ identity, startsAt, endsAt });
    }

    // A later observed identity bounds an otherwise open switch-log era. Keep
    // one lstart second after the observation ambiguous, never indefinitely.
    // An era that starts within the observation's ambiguity window may instead
    // be the later switch target, so it must remain open.
    for (const era of switchEras) {
      if (era.endsAt === null && !fenced.has(era.identity)
        && (era.startsAt === null || era.startsAt + 1_000 < group.ts)
        && !group.identities.includes(era.identity)) {
        era.endsAt = group.ts + 1_000;
      }
    }
  }

  const boundaries = [...new Set(switchEras.flatMap((era) => [era.startsAt, era.endsAt]).filter((time): time is number => time !== null))]
    .sort((left, right) => left - right);
  const starts = [null, ...boundaries];
  const ends = [...boundaries, null];
  const sets: HolderSet[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const startsAt = starts[index];
    const endsAt = ends[index];
    const probe = startsAt ?? Number.NEGATIVE_INFINITY;
    const identities = [...new Set(switchEras
      .filter((era) => isInInterval(era, probe))
      .map((era) => era.identity))].sort();
    if (identities.length === 0) continue;
    const prehistory = startsAt === null && sortedObservations.length > 0;
    const prior = sets.at(-1);
    if (prior && prior.endsAt === startsAt && prior.prehistory === prehistory && sameIdentities(prior.identities, identities)) {
      prior.endsAt = endsAt;
    } else {
      sets.push({ identities, startsAt, endsAt, prehistory });
    }
  }
  return sets;
}

/** Appends a credential-free live-identity observation to the v5 store. */
export function appendObservation(
  db: Pick<DatabaseSync, 'prepare'>,
  observation: CodexLiveObservation,
): number {
  if (!Number.isFinite(observation.ts) || observation.by.trim() === '') {
    throw new Error('Invalid Codex live observation');
  }
  if (observation.identity !== null && observation.identity.length === 0) {
    throw new Error('Invalid Codex live observation identity');
  }
  const result = db.prepare(
    'INSERT INTO codex_live_observations (ts, identity, lineage_fp, by) VALUES (?, ?, ?, ?)',
  ).run(observation.ts, observation.identity, observation.lineageFp, observation.by);
  return Number(result.lastInsertRowid);
}

/** Returns currently listed processes that may renew the supplied identity. */
export function renewers(
  identity: CodexIdentity,
  processes: readonly CodexProcess[],
  switchLogRows: readonly CodexSwitchLogRow[],
  observations: readonly CodexLiveObservation[] = [],
): CodexProcess[] {
  const identityKey = codexIdentityKey(identity);
  const sets = holderSets(switchLogRows, observations);

  return processes.filter((process) => {
    const startedAt = processStartedAt(process);
    // An unparseable lstart is ambiguous. Count it as a holder for every
    // queried identity rather than risking a refresh-token rotation.
    if (startedAt === null) return true;
    return sets.some((set) => set.identities.includes(identityKey)
      && (set.startsAt === null || startedAt >= set.startsAt)
      && (set.endsAt === null || startedAt < set.endsAt));
  });
}
