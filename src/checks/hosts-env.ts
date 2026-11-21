import { basename, isAbsolute } from 'node:path';

import type { DoctorCheck } from '../diagnostics';
import { check } from './_check';

export default check('hosts:env');

export type HostCommandRunner = (
  command: string,
  args: string[],
  options?: { env: NodeJS.ProcessEnv },
) => string;

const HOST_ENVIRONMENT_VARIABLES = [
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

// Runs inside `/bin/sh -c`: $1 is the launchctl path, the rest are the watched names. Each value
// is tested in the shell and never printed; stdout carries only watched names and `!error`.
const LAUNCHCTL_PROBE_SCRIPT = [
  'l=$1; shift',
  'for n in "$@"; do',
  `  v=$("$l" getenv "$n") || { echo '!error'; continue; }`,
  `  [ -n "$v" ] && printf '%s\\n' "$n"`,
  'done',
  'exit 0',
].join('\n');

function probeHostTool(command: HostCommandRunner, name: 'herdr' | 'orca'): string {
  try {
    const version = command(name, ['--version']).trim();
    return version || 'installed (version unavailable)';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'not installed'
      : 'installed (version probe failed)';
  }
}

function minimalLoginShellEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const name of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR'] as const) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function selectLoginShell(
  shell: string | undefined,
  shellExists: (path: string) => boolean,
): { path: string | null; unsupportedShell: string | null } {
  if (!shell) {
    return { path: shellExists('/bin/zsh') ? '/bin/zsh' : null, unsupportedShell: null };
  }
  if (!isAbsolute(shell)) return { path: null, unsupportedShell: null };
  if (!['zsh', 'bash', 'sh'].includes(basename(shell))) {
    return { path: null, unsupportedShell: basename(shell) };
  }
  return { path: shellExists(shell) ? shell : null, unsupportedShell: null };
}

/** Names set in the login shell, or null when its environment could not be read. */
function loginShellVariables(command: HostCommandRunner, shell: string): string[] | null {
  try {
    const lines = command(shell, ['-lic', 'env'], { env: minimalLoginShellEnvironment() }).split(/\r?\n/);
    return HOST_ENVIRONMENT_VARIABLES.filter((name) => lines.some((line) => line.startsWith(`${name}=`)));
  } catch {
    return null;
  }
}

/** Names launchctl reports as set, and whether any read failed. Values never leave the shell. */
function launchctlVariables(
  command: HostCommandRunner,
  launchctl: string,
): { names: string[]; failed: boolean } {
  let lines: string[];
  try {
    lines = command('/bin/sh', ['-c', LAUNCHCTL_PROBE_SCRIPT, 'sh', launchctl, ...HOST_ENVIRONMENT_VARIABLES], {
      env: minimalLoginShellEnvironment(),
    }).split(/\r?\n/).filter((line) => line !== '');
  } catch {
    return { names: [], failed: true };
  }
  const watched: readonly string[] = HOST_ENVIRONMENT_VARIABLES;
  return {
    names: HOST_ENVIRONMENT_VARIABLES.filter((name) => lines.includes(name)),
    // `!error`, or anything else that is not a watched name, is a failed read and is never echoed.
    failed: lines.some((line) => !watched.includes(line)),
  };
}

/** Detect host overrides without retaining, displaying, or serializing their values. */
export function probeHostEnvironment(
  command: HostCommandRunner,
  options: {
    platform: NodeJS.Platform;
    shell: string | undefined;
    shellExists: (path: string) => boolean;
    /** Absolute launchctl path to probe on darwin; null skips the launchctl probe. */
    launchctl: string | null;
  },
): DoctorCheck {
  const detail = {
    herdr: probeHostTool(command, 'herdr'),
    orca: probeHostTool(command, 'orca'),
  };
  const shell = options.platform === 'win32'
    ? { path: null, unsupportedShell: null }
    : selectLoginShell(options.shell, options.shellExists);
  const shellVariables = shell.path ? loginShellVariables(command, shell.path) : [];
  const launchctlPath = options.platform === 'darwin' ? options.launchctl : null;
  const launchctl = launchctlPath !== null
    ? launchctlVariables(command, launchctlPath)
    : { names: [], failed: false };

  const hits: string[] = [];
  if (shellVariables?.length) hits.push(`login shell sets ${shellVariables.join(', ')}`);
  if (launchctl.names.length > 0) hits.push(`launchctl sets ${launchctl.names.join(', ')}`);
  const failures: string[] = [];
  if (shellVariables === null) failures.push('could not read login shell environment');
  if (launchctl.failed) failures.push('could not read launchctl environment');
  if (hits.length > 0 || failures.length > 0) {
    const parts = hits.length > 0
      ? [...hits, ...failures, 'Orca/Herdr-launched tools may bypass QLB-managed logins']
      : failures;
    return { name: 'hosts:env', level: 'WARN', message: parts.join('; '), detail };
  }
  if (!shell.path) {
    return {
      name: 'hosts:env',
      level: 'PASS',
      message: shell.unsupportedShell
        ? `hosts:env skipped: unsupported login shell ${shell.unsupportedShell}`
        : 'hosts:env skipped: no POSIX login shell',
      detail,
    };
  }
  return {
    name: 'hosts:env',
    level: 'PASS',
    message: launchctlPath !== null
      ? 'no QLB-bypassing variables are set in the login shell or launchctl environment'
      : 'no QLB-bypassing variables are set in the login shell environment',
    detail,
  };
}
