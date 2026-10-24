// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — process_detection.py

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export interface CswapProcess {
  pid: number;
}

export interface CswapProcessOptions {
  runPs?: () => string;
}

function defaultRunPs(): string {
  return execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function isCswapCommand(command: string): boolean {
  if (command.includes('/claude-swap/')) return true;
  const argv0 = command.trim().split(/\s+/, 1)[0];
  return argv0 !== undefined && basename(argv0) === 'cswap';
}

/** List running C-swap processes without retaining their command lines. */
export function listCswapProcesses(opts: CswapProcessOptions = {}): CswapProcess[] {
  const output = (opts.runPs ?? defaultRunPs)();
  const processes: CswapProcess[] = [];

  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0 && isCswapCommand(match[2])) {
      processes.push({ pid });
    }
  }

  return processes;
}
