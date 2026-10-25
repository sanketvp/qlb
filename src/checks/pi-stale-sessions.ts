import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { DoctorCheck } from '../diagnostics';
import { check } from './_check';

export default check('pi:stale-sessions');

export interface PiProcess {
  pid: number;
  startedAt: string;
  startedAtMs: number;
}

export interface PiStaleSessionsOptions {
  dbPath: string;
  /** Injectable so checks never inspect the real process table in tests. */
  list?: () => string;
}

function listProcesses(): string {
  return execFileSync('ps', ['-axo', 'pid=,lstart=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  });
}

function isPiCommand(command: string): boolean {
  const argv0 = command.trim().split(/\s+/, 1)[0]?.split(/[\\/]/).pop();
  return argv0 === 'pi' || argv0 === 'pi-rpc'
    || /(?:^|[\\/])node_modules[\\/]@earendil-works[\\/]pi-coding-agent(?:[\\/]|$)|(?:^|[\\/\s])@earendil-works[\\/]pi-coding-agent(?:[\\/\s]|$)/.test(command);
}

function parseProcesses(output: string): { processes: PiProcess[]; malformed: boolean } {
  let malformed = false;
  const processes: PiProcess[] = [];
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return { processes, malformed: true };
  for (const line of lines) {
    const match = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!match) {
      malformed = true;
      continue;
    }
    const startedAtMs = Date.parse(match[2]);
    if (!Number.isFinite(startedAtMs)) {
      malformed = true;
      continue;
    }
    if (isPiCommand(match[3])) {
      processes.push({ pid: Number(match[1]), startedAt: match[2], startedAtMs });
    }
  }
  return { processes, malformed };
}

function deploymentThreshold(dbPath: string): number | null {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const read = (key: string): string | null => {
        const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value?: unknown } | undefined;
        return typeof row?.value === 'string' ? row.value : null;
      };
      const values = ['pi.deployedAt', 'pi.anthropic.migratedAt']
        .map(read)
        .filter((value): value is string => value != null)
        .map(Number)
        .filter((value) => Number.isFinite(value) && value > 0);
      return values.length > 0 ? Math.max(...values) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Finds Pi processes whose loaded extension predates deployment or Anthropic migration. */
export function piStaleSessionsCheck(options: PiStaleSessionsOptions): DoctorCheck {
  const threshold = deploymentThreshold(options.dbPath);
  if (threshold == null) {
    return { name: 'pi:stale-sessions', level: 'WARN', message: 'unknown: Pi deployment or Anthropic migration time is absent' };
  }

  let parsed: ReturnType<typeof parseProcesses>;
  try {
    parsed = parseProcesses((options.list ?? listProcesses)());
  } catch {
    return { name: 'pi:stale-sessions', level: 'WARN', message: 'unknown: unable to list Pi processes' };
  }
  if (parsed.malformed) {
    return { name: 'pi:stale-sessions', level: 'WARN', message: 'unknown: process list contained unparseable data' };
  }

  const stale = parsed.processes.filter((process) => process.startedAtMs < threshold * 1_000);
  if (stale.length === 0) {
    return { name: 'pi:stale-sessions', level: 'PASS', message: 'no stale Pi sessions found' };
  }
  return {
    name: 'pi:stale-sessions', level: 'WARN',
    message: `${stale.length} stale Pi session${stale.length === 1 ? '' : 's'} must be restarted`,
    detail: stale.map(({ pid, startedAt }) => ({ pid, startedAt })),
  };
}
