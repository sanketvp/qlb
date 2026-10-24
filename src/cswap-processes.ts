// QLB's C-swap process detection; rule defined by spec S24.

import { execFileSync } from 'node:child_process';

export interface CswapProcess {
  pid: number;
}

export interface CswapProcessOptions {
  runPs?: () => string;
  platform?: NodeJS.Platform;
}

/** The process table could not be read reliably. */
export class CswapProcessCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CswapProcessCheckError';
  }
}

function defaultRunPs(): string {
  return execFileSync('/bin/ps', ['-ax', '-o', 'pid=,args='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  });
}

function pythonArguments(args: string): string | undefined {
  const interpreter = /(^|\/)python(?:\d+(?:\.\d+)*)?(?=\s|$)/i.exec(args);
  if (interpreter === null || interpreter.index === undefined) return undefined;
  return args.slice(interpreter.index + interpreter[0].length).trimStart();
}

function firstPythonScriptIsCswap(args: string): boolean {
  let remaining = pythonArguments(args);
  if (remaining === undefined) return false;

  // Avoid tokenizing paths containing spaces. These options consume their
  // following value; the remaining short options do not.
  let option: RegExpExecArray | null;
  while ((option = /^(?:(?:-W|-X|-Q)\s+\S+|--check-hash-based-pycs|-\S+)\s+/.exec(remaining)) !== null) {
    remaining = remaining.slice(option[0].length);
  }
  return /^(cswap|claude-swap)(\s|$)/.test(remaining)
    || /(^|\/)(cswap|claude-swap)(\s|$)/.test(remaining);
}

function isCswapCommand(args: string): boolean {
  if (args.includes('/claude-swap/')) return true;

  // ps renders arguments as a space-delimited string, so do not split paths
  // containing spaces. This intentionally over-detects a script argument.
  if (/(^|\/)(cswap|claude-swap)(\s|$)/.test(args)) return true;

  const hasPythonInterpreter = pythonArguments(args) !== undefined;
  const hasCswapModule = /(^|\s)-m\s+claude_swap(\.|\s|$)/.test(args);
  return firstPythonScriptIsCswap(args) || (hasPythonInterpreter && hasCswapModule);
}

/**
 * List running C-swap processes without retaining their command lines.
 * Callers MUST treat a CswapProcessCheckError as "C-swap may be alive" and
 * refuse the guarded operation.
 */
export function listCswapProcesses(opts: CswapProcessOptions = {}): CswapProcess[] {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new CswapProcessCheckError(`cannot inspect C-swap processes on ${platform}`);
  }

  let output: string;
  try {
    output = (opts.runPs ?? defaultRunPs)();
  } catch {
    throw new CswapProcessCheckError('failed to inspect the process table');
  }

  const processes: CswapProcess[] = [];
  let parsedProcessCount = 0;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;

    parsedProcessCount += 1;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0 && isCswapCommand(match[2])) {
      processes.push({ pid });
    }
  }

  if (parsedProcessCount === 0) {
    throw new CswapProcessCheckError('process table was empty');
  }

  return processes;
}
