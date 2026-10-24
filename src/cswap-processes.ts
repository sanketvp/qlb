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

function isPythonInterpreter(command: string): boolean {
  return /^python(?:\d+(?:\.\d+)*)?$/.test(basename(command));
}

function isCswapCommand(command: string): boolean {
  if (command.includes('/claude-swap/')) return true;

  const argv = command.trim().split(/\s+/);
  const argv0 = argv[0];
  if (argv0 === undefined) return false;
  if (basename(argv0) === 'cswap') return true;
  if (!isPythonInterpreter(argv0)) return false;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) return false;
    if (argument === '-c') return false;
    if (argument === '-m') return argv[index + 1] === 'claude_swap';
    if (argument === '-W' || argument === '-X' || argument === '-Q' || argument === '--check-hash-based-pycs') {
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) continue;
    return basename(argument) === 'cswap';
  }

  return false;
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
