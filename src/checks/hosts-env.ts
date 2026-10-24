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
] as const;

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

/** Detect host overrides without retaining, displaying, or serializing their values. */
export function probeHostEnvironment(
  command: HostCommandRunner,
  options: {
    platform: NodeJS.Platform;
    shell: string | undefined;
    shellExists: (path: string) => boolean;
  },
): DoctorCheck {
  const detail = {
    herdr: probeHostTool(command, 'herdr'),
    orca: probeHostTool(command, 'orca'),
  };
  const shell = options.platform === 'win32'
    ? { path: null, unsupportedShell: null }
    : selectLoginShell(options.shell, options.shellExists);
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
  try {
    const environment = command(shell.path, ['-lic', 'env'], { env: minimalLoginShellEnvironment() });
    const setVariables = HOST_ENVIRONMENT_VARIABLES.filter((name) =>
      environment.split(/\r?\n/).some((line) => line.startsWith(`${name}=`)),
    );
    if (setVariables.length > 0) {
      return {
        name: 'hosts:env',
        level: 'WARN',
        message: `login shell sets ${setVariables.join(', ')}; Orca/Herdr-launched tools may bypass QLB-managed logins`,
        detail,
      };
    }
    return {
      name: 'hosts:env',
      level: 'PASS',
      message: 'no QLB-bypassing variables are set in the login shell environment',
      detail,
    };
  } catch {
    return { name: 'hosts:env', level: 'WARN', message: 'could not read login shell environment', detail };
  }
}
