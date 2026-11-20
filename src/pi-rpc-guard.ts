/**
 * S30 parent-process verifier for Pi RPC mode.
 *
 * Pi v1.5.2 sets `process.title` to `pi-rpc` before starting RPC mode. On
 * macOS that title overwrites the argv `ps` prints, so the parent no longer
 * looks like `node .../dist/rpc-entry.js`. A title is never sufficient on
 * its own. The kernel comm, the Node text executable, Pi's env signals, and
 * an RPC entry under the located Pi package must all agree.
 *
 * An argv that was not overwritten is accepted only when its script is that
 * package's `dist/rpc-entry.js` or `dist/bundle/rpc-entry.js` and the command
 * carries no code-injecting Node option.
 *
 * Any uncertainty returns false. This module does not read credentials and
 * does not log.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { locatePi } from './pi-integration';

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const PI_RPC_TITLE = 'pi-rpc';
const RPC_ENTRY_FROM_DIST = ['rpc-entry.js', join('bundle', 'rpc-entry.js')];
const NODE_BASENAME = /^node(?:js)?$/i;
const NODE_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-e', '--eval',
  '-p', '--print', '--input-type', '--conditions', '-C',
]);
const CODE_INJECTING_LONG_OPTIONS = [
  '--require', '--eval', '--print', '--import', '--loader', '--experimental-loader',
];
const EXEC_TIMEOUT_MS = 2_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const MAX_FIELD_CHARS = 4_096;
const MAX_COMMAND_CHARS = 64 * 1024;

/** Parent snapshot. `ucomm` and `textExecutable` are required for the macOS title path. */
export interface PiRpcParent {
  /** `ps -o comm=`. `pi-rpc` after the macOS title overwrite, otherwise `node`. */
  comm: string;
  /** `ps -o ucomm=`. Kernel binary name; `process.title` does not change it. */
  ucomm?: string;
  /** `ps -o command=`. */
  command: string;
  /** Absolute Node text executable from `lsof -a -p <pid> -d txt -Fn`. */
  textExecutable?: string;
}

export interface PiRpcGuardDeps {
  /** Injected snapshot. When set, the live process table is not read. */
  parent?: () => PiRpcParent | null;
  /** Package root of `@earendil-works/pi-coding-agent`. Defaults to `locatePi`. */
  piPackageRoot?: (env: NodeJS.ProcessEnv) => string | null;
  /** Defaults to stdin or stdout being a TTY. */
  isTty?: () => boolean;
  /**
   * Process inspected when `parent` is omitted. Defaults to `process.ppid`.
   * Production leaves this unset; a caller that sets it chooses whom to trust.
   */
  parentPid?: number;
}

function commandWords(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(?:"|')|(?:"|')$/g, '')) ?? [];
}

function tidy(value: unknown, max = MAX_FIELD_CHARS): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function isNodeBasename(value: string): boolean {
  return NODE_BASENAME.test(basename(value));
}

function isCodeInjectingNodeOption(arg: string): boolean {
  return arg === '-' || arg === '-i' || arg === '--interactive'
    || ['-r', '-e', '-p'].some((option) => arg === option || arg.startsWith(option))
    || CODE_INJECTING_LONG_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`));
}

function takesSeparateValue(arg: string): boolean {
  if (NODE_OPTIONS_WITH_SEPARATE_VALUE.has(arg)) return true;
  for (const option of NODE_OPTIONS_WITH_SEPARATE_VALUE) {
    if (arg.startsWith(`${option}=`)) return true;
  }
  return false;
}

function nodeOptionsInjectCode(env: NodeJS.ProcessEnv): boolean {
  const raw = env.NODE_OPTIONS;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  if (raw.includes('\0') || raw.length > MAX_COMMAND_CHARS) return true;
  const words = commandWords(raw);
  if (words.length === 0) return true;
  return words.some((word) => isCodeInjectingNodeOption(word) || takesSeparateValue(word));
}

function hasExecutableMagic(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) !== 4) return false;
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    const magic = buf.readUInt32BE(0);
    return magic === 0xfeedface
      || magic === 0xfeedfacf
      || magic === 0xcafebabe
      || magic === 0xcefaedfe
      || magic === 0xcffaedfe
      || magic === 0xbebafeca;
  } finally {
    closeSync(fd);
  }
}

function isNodeExecutable(candidate: string): boolean {
  if (!candidate.startsWith('/')) return false;
  try {
    const resolved = realpathSync(candidate);
    if (!isNodeBasename(resolved)) return false;
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size < 4 || (stat.mode & 0o111) === 0) return false;
    return hasExecutableMagic(resolved);
  } catch {
    return false;
  }
}

function verifiedPiRoot(root: string): string | null {
  try {
    const packageRoot = realpathSync(root);
    const manifest = join(packageRoot, 'package.json');
    const stat = statSync(manifest);
    if (!stat.isFile() || stat.size <= 0 || stat.size > PACKAGE_JSON_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return (parsed as { name?: unknown }).name === PI_PACKAGE_NAME ? packageRoot : null;
  } catch {
    return null;
  }
}

function isRpcEntryFile(packageRoot: string, scriptPath: string): boolean {
  try {
    const resolved = realpathSync(scriptPath);
    if (!statSync(resolved).isFile()) return false;
    const fromDist = relative(join(packageRoot, 'dist'), resolved);
    return RPC_ENTRY_FROM_DIST.some((candidate) => fromDist === candidate);
  } catch {
    return false;
  }
}

function packageHasRpcEntry(packageRoot: string): boolean {
  return RPC_ENTRY_FROM_DIST.some((candidate) => isRpcEntryFile(packageRoot, join(packageRoot, 'dist', candidate)));
}

function hasPiRpcEnv(env: NodeJS.ProcessEnv): boolean {
  return env.PI_CODING_AGENT === 'true' && env.AI_AGENT === 'pi';
}

function textExecutableAgrees(textExecutable: string | undefined, executable: string): boolean {
  if (textExecutable === undefined) return true;
  if (!isNodeExecutable(textExecutable)) return false;
  if (!executable.startsWith('/')) return true;
  try {
    return realpathSync(textExecutable) === realpathSync(executable);
  } catch {
    return false;
  }
}

function scriptFromNodeCommand(command: string): string | null {
  const [executable, ...args] = commandWords(command);
  if (!executable || !isNodeBasename(executable)) return null;
  if (executable !== basename(executable) && !executable.startsWith('/')) return null;
  if (executable.startsWith('/') && !isNodeExecutable(executable)) return null;

  let script: string | undefined;
  let scriptIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (isCodeInjectingNodeOption(arg)) return null;
    if (arg.startsWith('-')) {
      if (takesSeparateValue(arg)) return null;
      continue;
    }
    script = arg;
    scriptIndex = index;
    break;
  }
  if (!script || !script.startsWith('/') || scriptIndex < 0) return null;
  for (const arg of args.slice(scriptIndex + 1)) {
    if (isCodeInjectingNodeOption(arg)) return null;
  }
  return script;
}

/**
 * Node text executable named by `lsof -a -p <pid> -d txt -Fn`.
 * `p` (pid) is always emitted. macOS `txt` can also name mapped libraries;
 * exactly one resolved Node executable must remain.
 */
export function nodeExecutableFromLsof(output: string): string | null {
  if (output.includes('\0') || output.length > EXEC_MAX_BUFFER) return null;
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line === '') continue;
    const kind = line[0];
    if (kind === 'p' || kind === 'f') continue;
    if (kind !== 'n') return null;
    const name = line.slice(1).trim();
    if (!name.startsWith('/')) return null;
    paths.push(name);
  }
  if (paths.length === 0) return null;
  const nodePaths = new Set<string>();
  for (const path of paths) {
    if (!isNodeExecutable(path)) continue;
    try {
      nodePaths.add(realpathSync(path));
    } catch {
      return null;
    }
  }
  if (nodePaths.size !== 1) return null;
  return nodePaths.values().next().value ?? null;
}

/** True when `parent` is a Pi RPC host for `root`. Does not apply the call-marker or TTY checks. */
export function isPiRpcParent(
  parent: PiRpcParent | null,
  root: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    if (!parent || typeof root !== 'string' || root.length === 0) return false;
    const comm = tidy(parent.comm);
    const command = tidy(parent.command, MAX_COMMAND_CHARS);
    const ucomm = tidy(parent.ucomm);
    const textExecutable = tidy(parent.textExecutable);
    if (!comm || !command) return false;
    if (nodeOptionsInjectCode(env)) return false;

    const packageRoot = verifiedPiRoot(root);
    if (!packageRoot) return false;

    if (basename(comm) === PI_RPC_TITLE && command === PI_RPC_TITLE) {
      if (!hasPiRpcEnv(env)) return false;
      if (!ucomm || !isNodeBasename(ucomm)) return false;
      if (!textExecutable || !isNodeExecutable(textExecutable)) return false;
      return packageHasRpcEntry(packageRoot);
    }

    if (!isNodeBasename(comm)) return false;
    if (ucomm !== undefined && !isNodeBasename(ucomm)) return false;
    const executable = commandWords(command)[0];
    if (!executable || !textExecutableAgrees(textExecutable, executable)) return false;
    const script = scriptFromNodeCommand(command);
    return script !== null && isRpcEntryFile(packageRoot, script);
  } catch {
    return false;
  }
}

function defaultIsTty(): boolean {
  return process.stdin.isTTY === true || process.stdout.isTTY === true;
}

function psField(pid: number, field: 'comm=' | 'ucomm=' | 'command='): string | null {
  try {
    const output = execFileSync('/bin/ps', ['-o', field, '-p', String(pid)], {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/bin:/usr/bin' },
      windowsHide: true,
    });
    const value = String(output).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function lsofBinary(): string | null {
  for (const candidate of ['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof']) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // Try the next absolute path. A PATH lookup could select a planted binary.
    }
  }
  return null;
}

function readTextExecutable(pid: number): string | null | undefined {
  const binary = lsofBinary();
  if (!binary) return undefined;
  try {
    const output = execFileSync(binary, ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/bin:/usr/bin' },
      windowsHide: true,
    });
    return nodeExecutableFromLsof(String(output));
  } catch {
    return null;
  }
}

function readPiRpcParent(pid: number): PiRpcParent | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const comm = psField(pid, 'comm=');
  const ucomm = psField(pid, 'ucomm=');
  const command = psField(pid, 'command=');
  if (!comm || !ucomm || !command) return null;
  const textExecutable = readTextExecutable(pid);
  if (textExecutable === null) return null;
  return textExecutable === undefined
    ? { comm, ucomm, command }
    : { comm, ucomm, command, textExecutable };
}

/** S30 call gate for a Pi RPC parent. Any uncertainty is a refusal. */
export function piRpcCallAllowed(
  env: NodeJS.ProcessEnv = process.env,
  deps: PiRpcGuardDeps = {},
): boolean {
  try {
    if (env.QLB_PI_TOKEN_CALL !== '1') return false;
    if ((deps.isTty ?? defaultIsTty)()) return false;
    const parent = deps.parent ? deps.parent() : readPiRpcParent(deps.parentPid ?? process.ppid);
    const located = deps.piPackageRoot ? deps.piPackageRoot(env) : locatePi(env).root;
    const root = typeof located === 'string' ? located : null;
    return isPiRpcParent(parent, root, env);
  } catch {
    return false;
  }
}
