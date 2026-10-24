// QLB's C-swap process detection; process-table failures fail closed per spec S24.

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

const PROCESS_TABLE_MAX_BUFFER = 64 * 1024 * 1024;

function defaultRunPs(platform: NodeJS.Platform): string {
  const args = platform === 'linux'
    ? ['-ww', '-ax', '-o', 'pid=,args=']
    : ['-ax', '-o', 'pid=,args='];
  return execFileSync('/bin/ps', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
    maxBuffer: PROCESS_TABLE_MAX_BUFFER,
  });
}

function pythonArguments(args: string): string | undefined {
  const interpreter = /(^|\/)python(?:\d+(?:\.\d+)*)?(?=\s|$)/i.exec(args);
  if (interpreter === null || interpreter.index === undefined) return undefined;
  return args.slice(interpreter.index + interpreter[0].length).trimStart();
}

function isCswapModuleOption(args: string): boolean {
  const moduleOption = /^-([A-Za-z]*)m\s*claude_swap(\.|\s|$)/.exec(args);
  if (moduleOption === null) return false;

  // CPython's interface options make -W and -X consume the rest of their
  // cluster as their value, so neither can precede -m here.
  // https://docs.python.org/3/using/cmdline.html#interface-options
  return !/[WX]/.test(moduleOption[1]);
}

function hasClusteredCswapModule(args: string): boolean {
  const moduleOption = /(^|\s)-([A-Za-z]+)m\s*claude_swap(\.|\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = moduleOption.exec(args)) !== null) {
    if (!/[WX]/.test(match[2])) return true;
  }
  return false;
}

function firstPythonScriptIsCswap(args: string): boolean {
  let remaining = pythonArguments(args);
  if (remaining === undefined) return false;

  // Avoid tokenizing paths containing spaces. Check -m before the generic
  // option skip; the listed value-taking options consume their value.
  let option: RegExpExecArray | null;
  while (true) {
    if (isCswapModuleOption(remaining)) return true;
    option = /^(?:(?:-W|-X|-Q)\s+\S+|--check-hash-based-pycs(?:=\S+|\s+\S+)|-\S+)\s+/.exec(remaining);
    if (option === null) break;
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
  const hasCswapModule = /(^|\s)-m\s*claude_swap(\.|\s|$)/.test(args)
    || hasClusteredCswapModule(args);
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
    output = opts.runPs ? opts.runPs() : defaultRunPs(platform);
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
