import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { locatePi } from '../pi-integration';
import { piRpcCallAllowed } from '../pi-rpc-guard';
import { loadTokenResolver } from '../token';
import type { TokenResolution } from '../token/xai';
import type { CommandContext, CommandDefinition } from '../registry';

const TOKEN_PROVIDERS = new Set(['xai', 'kimi-coding', 'openrouter']);

/**
 * Interactive Pi (`process.title = "pi"`) replaces argv. On macOS, `ps comm`
 * and `ps command` are then both `pi`, while `ps ucomm` stays `node`.
 * The RPC title is not included here; pass it via `retitledProcessTitles`.
 */
export const INTERACTIVE_PI_PROCESS_TITLE = 'pi';

const RETITLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const NODE_EXECUTABLE = /^node(?:js)?(?:\.exe)?$/i;

/** Direct parent of a `qlb token` / `qlb gate` process. Never log `command`. */
export interface ParentProcess {
  /** `ps comm` / `/proc/pid/comm`. Pi's process title replaces this. */
  comm: string;
  /** Visible command line. Pi's process title replaces the whole argv on Unix. */
  command: string;
  /**
   * Original executable name when `comm` is a process title.
   * macOS `ps ucomm`, or the `/proc/pid/exe` basename on Linux.
   */
  ucomm?: string;
}

type Resolver = { resolve(): TokenResolution };

export interface TokenCallGuardDeps {
  parent?: () => ParentProcess | null;
  piPackageRoot?: (env: NodeJS.ProcessEnv) => string | null;
  isTty?: () => boolean;
  /**
   * Extra `process.title` values that replace argv, accepted only with the
   * same Node-executable and Pi-package-root checks as interactive `pi`.
   * The RPC guard passes `pi-rpc` here; it does not replace the interactive title.
   */
  retitledProcessTitles?: readonly string[];
}

export interface TokenCommandDeps {
  guard?: (env: NodeJS.ProcessEnv) => boolean;
  resolve?: (provider: string) => TokenResolution;
}

function psField(pid: number, field: 'comm' | 'ucomm' | 'command'): string | null {
  const args = field === 'command'
    ? ['-ww', '-o', 'command=', '-p', String(pid)]
    : ['-o', `${field}=`, '-p', String(pid)];
  const value = String(execFileSync('/bin/ps', args, { encoding: 'utf8' })).trim();
  return value || null;
}

function commandFromProcCmdline(raw: Buffer): string | null {
  const parts = raw.toString('utf8').split('\0').filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Linux `prctl` renames comm, so the executable is read from `/proc/pid/exe`. */
function linuxParent(pid: number): ParentProcess | null {
  const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  const command = commandFromProcCmdline(readFileSync(`/proc/${pid}/cmdline`));
  const ucomm = basename(realpathSync(`/proc/${pid}/exe`));
  if (!comm || !command || !ucomm) return null;
  return { comm, command, ucomm };
}

/** macOS keeps the exec name in `ucomm` after `uv_set_process_title` overwrites argv. */
function darwinParent(pid: number): ParentProcess | null {
  const comm = psField(pid, 'comm');
  const ucomm = psField(pid, 'ucomm');
  const command = psField(pid, 'command');
  if (!comm || !ucomm || !command) return null;
  return { comm, command, ucomm };
}

function parentProcess(): ParentProcess | null {
  try {
    const pid = process.ppid;
    if (process.platform === 'linux') return linuxParent(pid);
    if (process.platform === 'darwin') return darwinParent(pid);
    const comm = psField(pid, 'comm');
    const command = psField(pid, 'command');
    if (!comm || !command) return null;
    const ucomm = psField(pid, 'ucomm');
    return ucomm ? { comm, command, ucomm } : { comm, command };
  } catch {
    return null;
  }
}

function packageRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  return locatePi(env).root;
}

function commandWords(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(?:"|')|(?:"|')$/g, '')) ?? [];
}

const NODE_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-e', '--eval',
  '-p', '--print', '--input-type', '--conditions', '-C',
]);
const CODE_INJECTING_LONG_OPTIONS = [
  '--require', '--eval', '--print', '--import', '--loader', '--experimental-loader',
];

function isCodeInjectingNodeOption(arg: string): boolean {
  return arg === '-i' || arg === '--interactive'
    || ['-r', '-e', '-p'].some((option) => arg === option || arg.startsWith(option))
    || CODE_INJECTING_LONG_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`));
}

function scriptIsInsidePiDist(command: string, root: string): boolean {
  const [executable, ...args] = commandWords(command);
  if (!executable || !/^node(?:js)?$/i.test(basename(executable))) return false;

  let scriptWord: string | undefined;
  for (const arg of args) {
    if (arg.startsWith('-')) {
      if (isCodeInjectingNodeOption(arg) || NODE_OPTIONS_WITH_SEPARATE_VALUE.has(arg)) return false;
      continue;
    }
    scriptWord = arg;
    break;
  }
  if (!scriptWord || !scriptWord.startsWith('/')) return false;

  let packageRoot: string;
  try {
    packageRoot = realpathSync(root);
    const script = realpathSync(scriptWord);
    const pathFromDist = relative(join(packageRoot, 'dist'), script);
    return Boolean(pathFromDist) && !pathFromDist.startsWith('..') && !pathFromDist.includes('../');
  } catch {
    return false;
  }
}

function isSafeRetitle(title: string): boolean {
  return RETITLE_PATTERN.test(title) && !NODE_EXECUTABLE.test(title);
}

/**
 * True when `title` is the entire visible command line and the executable is
 * still Node. Used for Pi's `process.title`, which overwrites argv, and for
 * extra titles such as `pi-rpc`.
 */
export function isNodeProcessTitle(parent: ParentProcess, title: string): boolean {
  if (!isSafeRetitle(title)) return false;
  if (parent.comm.trim() !== title || parent.command.trim() !== title) return false;
  return NODE_EXECUTABLE.test(basename(parent.ucomm?.trim() ?? ''));
}

function retitleNames(extra: readonly string[] | undefined): string[] {
  const names = [INTERACTIVE_PI_PROCESS_TITLE];
  for (const title of extra ?? []) {
    if (isSafeRetitle(title) && !names.includes(title)) names.push(title);
  }
  return names;
}

/** S30's accidental-secret-disclosure guard. Any uncertainty is a refusal. */
export function tokenCallAllowed(
  env: NodeJS.ProcessEnv = process.env,
  deps: TokenCallGuardDeps = {},
): boolean {
  if (env.QLB_PI_TOKEN_CALL !== '1') return false;
  if ((deps.isTty ?? (() => process.stdin.isTTY === true || process.stdout.isTTY === true))()) return false;
  // Pi RPC (`process.title = "pi-rpc"`) overwrites argv, so this runs before the
  // node-comm checks. Production omits `parent`: `parentProcess()` has no lsof
  // text executable, and that incomplete snapshot fails closed. An injected
  // parent is forwarded as-is and still has to satisfy the RPC guard.
  if (piRpcCallAllowed(env, {
    isTty: deps.isTty,
    piPackageRoot: deps.piPackageRoot,
    ...(deps.parent ? { parent: deps.parent } : {}),
  })) return true;
  const parent = (deps.parent ?? parentProcess)();
  if (!parent) return false;
  const root = deps.piPackageRoot ? deps.piPackageRoot(env) : packageRoot(env);
  if (typeof root !== 'string') return false;
  // Intact argv still has to be Node running a script inside this Pi dist,
  // with no code-injecting option. A retitle is accepted only when that argv
  // is gone and the executable name is still Node.
  if (scriptIsInsidePiDist(parent.command, root)) return true;
  return retitleNames(deps.retitledProcessTitles).some((title) => isNodeProcessTitle(parent, title));
}

function resolveToken(provider: string): TokenResolution {
  const module = loadTokenResolver(provider) as Partial<Resolver>;
  if (typeof module.resolve !== 'function') throw new Error('credential unavailable');
  return module.resolve();
}

/** Prints a credential only to the verified Pi extension-host parent (S30). */
export async function executeToken(
  args: string[],
  ctx: CommandContext,
  deps: TokenCommandDeps = {},
): Promise<number> {
  const provider = args.length === 1 ? args[0] : undefined;
  if (!provider || !TOKEN_PROVIDERS.has(provider) || !(deps.guard ?? tokenCallAllowed)(ctx.env)) return 3;

  let resolved: TokenResolution;
  try {
    resolved = (deps.resolve ?? resolveToken)(provider);
  } catch {
    return 1;
  }
  ctx.deliverSecret(resolved.token);
  return 0;
}

const command: CommandDefinition = {
  name: 'token',
  execute: executeToken,
};

export default command;
