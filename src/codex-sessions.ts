import { execFile } from 'node:child_process';
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
 * both sides possibly live until an `ok` row definitely replaces its source.
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
      // An `ok` source is definitely replaced at this instant. The target is
      // possibly live from it; later non-ok rows can re-open the source.
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
  const parsed = Date.parse(`${process.lstart} UTC`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Returns currently listed processes that may renew the supplied identity. */
export function renewers(
  identity: CodexIdentity,
  processes: readonly CodexProcess[],
  switchLogRows: readonly CodexSwitchLogRow[],
): CodexProcess[] {
  const identityKey = codexIdentityKey(identity);
  const identityEras = holderEras(switchLogRows)
    .filter((era) => era.identity === identityKey)
    .sort((a, b) => (a.startsAt ?? Number.NEGATIVE_INFINITY) - (b.startsAt ?? Number.NEGATIVE_INFINITY));
  const lastEra = identityEras.at(-1);

  return processes.filter((process) => {
    const startedAt = processStartedAt(process);
    // An unparseable lstart is ambiguous. Count it as a holder for every
    // queried identity rather than risking a refresh-token rotation.
    if (startedAt === null) return true;
    if (lastEra === undefined) return false;
    // `ps lstart` has one-second resolution, so a start on the second after a
    // definite replacement remains ambiguous. The only safe exclusion is at
    // or after that one-second boundary.
    return lastEra.endsAt === null || startedAt < lastEra.endsAt + 1_000;
  });
}
