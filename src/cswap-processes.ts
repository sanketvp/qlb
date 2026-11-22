// QLB's C-swap process detection; process-table failures fail closed per spec S24.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

export interface CswapProcess {
  pid: number;
}

export interface CswapProcessOptions {
  runPs?: () => string;
  platform?: NodeJS.Platform;
}

export interface CswapProcessAsyncOptions {
  runPs?: () => Promise<string>;
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
const execFileAsync = promisify(execFile);

function psArgs(platform: NodeJS.Platform): string[] {
  return platform === 'linux'
    ? ['-ww', '-ax', '-o', 'pid=,args=']
    : ['-ax', '-o', 'pid=,args='];
}

function defaultRunPs(platform: NodeJS.Platform): string {
  return execFileSync('/bin/ps', psArgs(platform), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
    maxBuffer: PROCESS_TABLE_MAX_BUFFER,
  });
}

async function defaultRunPsAsync(platform: NodeJS.Platform): Promise<string> {
  const result = await execFileAsync('/bin/ps', psArgs(platform), {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: PROCESS_TABLE_MAX_BUFFER,
  });
  return result.stdout;
}

function pythonArguments(args: string): string | undefined {
  const interpreter = /(^|\/)python(?:\d+(?:\.\d+)*)?(?=\s|$)/i.exec(args);
  if (interpreter === null || interpreter.index === undefined) return undefined;
  return args.slice(interpreter.index + interpreter[0].length).trimStart();
}

function isCswapModule(module: string): boolean {
  return /^claude_swap(\.|$)/.test(module);
}

function hasClusteredCswapModule(args: string): boolean {
  const moduleOption = /(^|\s)-([A-Za-z]+)m\s*claude_swap(\.|\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = moduleOption.exec(args)) !== null) {
    // -c, -m, -W and -X take the rest of their cluster as their value, so
    // none of them can precede the m that names the module.
    if (!/[cmWX]/.test(match[2])) return true;
  }
  return false;
}

type PythonLaunch =
  | { kind: 'module'; module: string }
  | { kind: 'script'; rest: string }
  | { kind: 'not-cswap' };

/**
 * Scan CPython interpreter options relevant to C-swap detection.
 * https://docs.python.org/3/using/cmdline.html#interface-options
 *
 * In a cluster, c ends the scan (the rest is code), m takes the rest of the
 * cluster or the next token as the module, and W/X take the rest of the
 * cluster or the next token as their value. ps text is flattened, so where a
 * clustered W/X would take the next token (-IW <value>) the value may hold
 * spaces; the strict scan stops there with "not C-swap" rather than guess.
 * A standalone -W/-X/-Q skips exactly one token. ps flattening also hides
 * argument boundaries in general, which this text scan cannot recover.
 */
function scanPythonLaunch(args: string, strict: boolean): PythonLaunch {
  let rest = args.trimStart();
  const takeToken = (): string | undefined => {
    const token = /^(\S+)\s*/.exec(rest);
    if (token === null) return undefined;
    rest = rest.slice(token[0].length);
    return token[1];
  };

  tokens: while (true) {
    const token = /^\S+/.exec(rest)?.[0];
    if (token === undefined || token === '-' || !token.startsWith('-')) return { kind: 'script', rest };
    takeToken();
    // Keep scanning after '--' so SIGTERM targets remain no wider than main.
    if (token.startsWith('--')) {
      if (token === '--check-hash-based-pycs') takeToken();
      continue;
    }
    if (token === '-W' || token === '-X' || token === '-Q') {
      takeToken();
      continue;
    }

    const cluster = token.slice(1);
    for (let index = 0; index < cluster.length; index += 1) {
      const option = cluster[index];
      const value = cluster.slice(index + 1);
      if (option === 'c') return { kind: 'not-cswap' };
      if (option === 'm') {
        const module = value || takeToken();
        return module === undefined ? { kind: 'not-cswap' } : { kind: 'module', module };
      }
      if (option === 'W' || option === 'X') {
        if (value) continue tokens;
        if (strict) return { kind: 'not-cswap' };
        takeToken();
        continue tokens;
      }
      // Not an option letter: skip the whole token unread.
      if (!/[A-Za-z]/.test(option)) continue tokens;
    }
  }
}

function firstPythonScriptIsCswap(args: string): boolean {
  const remaining = pythonArguments(args);
  if (remaining === undefined) return false;

  // Avoid tokenizing paths containing spaces: check the rest of the text.
  const launch = scanPythonLaunch(remaining, false);
  if (launch.kind === 'module') return isCswapModule(launch.module);
  if (launch.kind === 'not-cswap') return false;
  return /^(cswap|claude-swap)(\s|$)/.test(launch.rest)
    || /(^|\/)(cswap|claude-swap)(\s|$)/.test(launch.rest);
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

function strictFirstPythonScriptIsCswap(args: string): boolean {
  const remaining = pythonArguments(args);
  if (remaining === undefined) return false;

  // Inspect only the first script token. A later argument named cswap is
  // never a signal target.
  const launch = scanPythonLaunch(remaining, true);
  if (launch.kind === 'module') return isCswapModule(launch.module);
  if (launch.kind === 'not-cswap') return false;
  const script = /^(\S+)/.exec(launch.rest)?.[1];
  return script !== undefined && /(^|\/)(cswap|claude-swap)$/.test(script);
}

function executableToken(args: string): string {
  const separator = args.indexOf(' ');
  return separator === -1 ? args : args.slice(0, separator);
}

/** A positive, argv-position-aware classifier for processes safe to signal. */
export function isCswapCommandToSignal(args: string): boolean {
  const executable = executableToken(args);
  // Exact basename only: a /claude-swap/ install directory can hold other
  // executables (its venv python, helpers) that must never be signalled.
  if (/(^|\/)(cswap|claude-swap)$/.test(executable)) return true;

  // pythonArguments is deliberately also used here so interpreter recognition
  // stays consistent with the liveness guard. Requiring it on argv[0] avoids
  // mistaking a later argument or script path for the interpreter.
  return pythonArguments(executable) !== undefined && strictFirstPythonScriptIsCswap(args);
}

function parseProcesses(output: string, matches: (args: string) => boolean): CswapProcess[] {
  const processes: CswapProcess[] = [];
  let parsedProcessCount = 0;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    parsedProcessCount += 1;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0 && matches(match[2])) processes.push({ pid });
  }
  if (parsedProcessCount === 0) throw new CswapProcessCheckError('process table was empty');
  return processes;
}

function platformFor(opts: { platform?: NodeJS.Platform }): NodeJS.Platform {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new CswapProcessCheckError(`cannot inspect C-swap processes on ${platform}`);
  }
  return platform;
}

function listCswapProcessesMatching(opts: CswapProcessOptions, matches: (args: string) => boolean): CswapProcess[] {
  const platform = platformFor(opts);
  try {
    return parseProcesses(opts.runPs ? opts.runPs() : defaultRunPs(platform), matches);
  } catch (error) {
    if (error instanceof CswapProcessCheckError) throw error;
    throw new CswapProcessCheckError('failed to inspect the process table');
  }
}

async function listCswapProcessesMatchingAsync(opts: CswapProcessAsyncOptions, matches: (args: string) => boolean): Promise<CswapProcess[]> {
  const platform = platformFor(opts);
  try {
    return parseProcesses(await (opts.runPs ? opts.runPs() : defaultRunPsAsync(platform)), matches);
  } catch (error) {
    if (error instanceof CswapProcessCheckError) throw error;
    throw new CswapProcessCheckError('failed to inspect the process table');
  }
}

/**
 * List running C-swap processes without retaining their command lines.
 * Callers MUST treat a CswapProcessCheckError as "C-swap may be alive" and
 * refuse the guarded operation.
 */
export function listCswapProcesses(opts: CswapProcessOptions = {}): CswapProcess[] {
  return listCswapProcessesMatching(opts, isCswapCommand);
}

/**
 * Async equivalent of listCswapProcesses, with the same classifiers and errors.
 * Callers MUST treat a CswapProcessCheckError as "C-swap may be alive" and
 * refuse the guarded operation.
 */
export function listCswapProcessesAsync(opts: CswapProcessAsyncOptions = {}): Promise<CswapProcess[]> {
  return listCswapProcessesMatchingAsync(opts, isCswapCommand);
}

/** List only C-swap processes positively identified as safe SIGTERM targets. */
export function listCswapProcessesToSignal(opts: CswapProcessOptions = {}): CswapProcess[] {
  return listCswapProcessesMatching(opts, isCswapCommandToSignal);
}

/**
 * Async equivalent of listCswapProcessesToSignal, with the same classifiers and errors.
 * Callers MUST treat a CswapProcessCheckError as "C-swap may be alive" and
 * refuse the guarded operation.
 */
export function listCswapProcessesToSignalAsync(opts: CswapProcessAsyncOptions = {}): Promise<CswapProcess[]> {
  return listCswapProcessesMatchingAsync(opts, isCswapCommandToSignal);
}
