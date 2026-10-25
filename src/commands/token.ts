import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { locatePi } from '../pi-integration';
import { loadTokenResolver } from '../token';
import type { TokenResolution } from '../token/xai';
import type { CommandContext, CommandDefinition } from '../registry';

const TOKEN_PROVIDERS = new Set(['xai', 'kimi-coding', 'openrouter']);

type ParentProcess = { comm: string; command: string };
type Resolver = { resolve(): TokenResolution };

export interface TokenCallGuardDeps {
  parent?: () => ParentProcess | null;
  piPackageRoot?: (env: NodeJS.ProcessEnv) => string | null;
  isTty?: () => boolean;
}

export interface TokenCommandDeps {
  guard?: (env: NodeJS.ProcessEnv) => boolean;
  resolve?: (provider: string) => TokenResolution;
}

function parentProcess(): ParentProcess | null {
  try {
    const comm = String(execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8' })).trim();
    const command = String(execFileSync('/bin/ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' })).trim();
    return comm && command ? { comm, command } : null;
  } catch {
    return null;
  }
}

function packageRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const piEnv = env.QLB_TEST_MODE === '1'
    ? env
    : { ...env, QLB_PI_PACKAGE_ROOT: undefined };
  return locatePi(piEnv).root;
}

function commandWords(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(?:"|')|(?:"|')$/g, '')) ?? [];
}

const NODE_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-e', '--eval',
  '-p', '--print', '--input-type', '--conditions', '-C',
]);

function scriptIsInsidePiDist(command: string, root: string): boolean {
  const [executable, ...args] = commandWords(command);
  if (!executable || !/^node(?:js)?$/i.test(basename(executable))) return false;

  let scriptWord: string | undefined;
  for (const arg of args) {
    if (arg.startsWith('-')) {
      if (NODE_OPTIONS_WITH_SEPARATE_VALUE.has(arg)) return false;
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

/** S30's accidental-secret-disclosure guard. Any uncertainty is a refusal. */
export function tokenCallAllowed(
  env: NodeJS.ProcessEnv = process.env,
  deps: TokenCallGuardDeps = {},
): boolean {
  if (env.QLB_PI_TOKEN_CALL !== '1') return false;
  if ((deps.isTty ?? (() => process.stdin.isTTY === true || process.stdout.isTTY === true))()) return false;
  const parent = (deps.parent ?? parentProcess)();
  if (!parent || !/^node(?:js)?$/i.test(basename(parent.comm))) return false;
  const piEnv = env.QLB_TEST_MODE === '1'
    ? env
    : { ...env, QLB_PI_PACKAGE_ROOT: undefined };
  const root = deps.piPackageRoot ? deps.piPackageRoot(piEnv) : packageRoot(piEnv);
  return typeof root === 'string' && scriptIsInsidePiDist(parent.command, root);
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
  ctx.registerSecret(resolved.token);
  ctx.stdout(resolved.token);
  return 0;
}

const command: CommandDefinition = {
  name: 'token',
  execute: executeToken,
};

export default command;
