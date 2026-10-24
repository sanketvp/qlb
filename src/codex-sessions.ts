import { execFile } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { codexIdentityKey, type CodexIdentity } from './codex-auth';

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
  | 'reverted-by-codex';

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
  const runPs = options.runPs ?? runPsDefault;
  try {
    const output = await runPs('ps', ['-p', String(recorded.pid), '-o', 'lstart='], {
      env: PS_ENV,
    });
    const currentLstart = output.trim().replace(/\s+/g, ' ');
    return currentLstart.length > 0 && currentLstart === recorded.lstart.replace(/\s+/g, ' ');
  } catch (error) {
    // `ps -p <pid>` exits 1 exactly when that PID is absent. Permission,
    // spawn, and other failures leave liveness unknown and must reach callers.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
      return false;
    }
    throw error;
  }
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
 * both sides possibly live from its row time; an `ok` row then definitely
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

  const rows = [...switchLogRows].sort(compareRows);
  const eras: HolderEra[] = [];
  const live = new Map<string, number | null>();
  const first = rows[0];
  if (first.fromAccountId !== null) live.set(first.fromAccountId, null);

  const start = (identity: string | null, startsAt: number): void => {
    if (identity !== null && !live.has(identity)) live.set(identity, startsAt);
  };
  const end = (identity: string | null, endsAt: number): void => {
    if (identity === null) return;
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
  const rows = [...switchLogRows].sort(compareRows);

  // `published_at`, not `committed_at` or the row timestamp, is the publish
  // boundary. Intervals are half-open, so T + 1 s is conclusively the target.
  for (const row of rows) {
    if (row.outcome !== 'ok' || row.publishedAt === null) continue;
    const publishedAt = row.publishedAt;
    for (const era of switchEras) {
      if (era.identity === row.fromAccountId && era.endsAt === publishedAt) {
        era.endsAt = publishedAt + 1_000;
      }
      if (era.identity === row.toAccountId && era.startsAt === publishedAt) {
        era.startsAt = publishedAt - 1_000;
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

  const sortedObservations = [...observations].sort((a, b) => a.ts - b.ts);
  for (const observation of sortedObservations) {
    if (!Number.isFinite(observation.ts)) throw new Error('Invalid Codex live observation time');
    if (observation.identity !== null && observation.identity.length === 0) {
      throw new Error('Invalid Codex live observation identity');
    }
  }
  // With observations A@T0 then B@T1, a process before T0 is A/prehistory;
  // T0..T1 could have read either document; from T1 onward it is B.
  for (let index = 0; index < sortedObservations.length; index += 1) {
    const observation = sortedObservations[index];
    if (observation.identity === null) continue;
    const previous = sortedObservations[index - 1];
    const next = sortedObservations[index + 1];
    switchEras.push({
      identity: observation.identity,
      startsAt: index === 0 ? null : previous.ts,
      endsAt: next?.ts ?? null,
    });
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
