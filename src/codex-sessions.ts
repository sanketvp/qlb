import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CodexProcess {
  pid: number;
  /** `ps lstart`, rendered under LC_ALL=C and TZ=UTC. */
  lstart: string;
  /** Executable basename, suitable for operator-facing status text. */
  host: string;
}

export interface CodexSwitchLogRow {
  fromAccountId: string | null;
  toAccountId: string;
  publishedAt: number;
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
  } catch {
    return false;
  }
}

/**
 * Reconstructs the C5 point-in-time holder eras. C5b deliberately replaces
 * these instants with transition intervals; do not use this as a boundary
 * ambiguity policy.
 */
export function holderEras(switchLogRows: readonly CodexSwitchLogRow[]): HolderEra[] {
  if (switchLogRows.length === 0) return [];

  const rows = [...switchLogRows].sort((a, b) => a.publishedAt - b.publishedAt);
  const first = rows[0];
  const eras: HolderEra[] = [];
  let identity = first.fromAccountId;
  let startsAt: number | null = null;

  for (const row of rows) {
    if (identity !== null) eras.push({ identity, startsAt, endsAt: row.publishedAt });
    identity = row.toAccountId;
    startsAt = row.publishedAt;
  }
  if (identity !== null) eras.push({ identity, startsAt, endsAt: null });
  return eras;
}

function processStartedAt(process: CodexProcess): number | null {
  const parsed = Date.parse(`${process.lstart} UTC`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Returns currently listed processes that may renew the supplied identity. */
export function renewers(
  identity: string,
  processes: readonly CodexProcess[],
  switchLogRows: readonly CodexSwitchLogRow[],
): CodexProcess[] {
  const eras = holderEras(switchLogRows);
  return processes.filter((process) => {
    const startedAt = processStartedAt(process);
    if (startedAt === null) return false;
    return eras.some(
      (era) =>
        era.identity === identity &&
        (era.startsAt === null || startedAt >= era.startsAt) &&
        (era.endsAt === null || startedAt < era.endsAt),
    );
  });
}
