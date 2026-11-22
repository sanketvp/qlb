import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { doctorQlb, type DoctorCheck } from '../src/diagnostics';

type Runner = (
  command: string,
  args: string[],
  options?: { env: NodeJS.ProcessEnv },
) => string;

type HostsOptions = {
  hostPlatform?: NodeJS.Platform;
  hostShell?: string;
  hostShellExists?: (path: string) => boolean;
  hostLaunchctl?: string;
};

const isLaunchctlProbe = (args: string[]): boolean => args[0] === '-c';

function missingCommand(name: string): Error & { code: string } {
  return Object.assign(new Error(`${name} is not installed`), { code: 'ENOENT' });
}

function fakeRunner(env: string, versions: Record<string, string> = {}): Runner {
  return (command, args) => {
    if (isLaunchctlProbe(args)) return '';
    if (args[0] === '-lic' && args[1] === 'env') return env;
    if (args[0] === '--version') {
      if (!(command in versions)) throw missingCommand(command);
      return versions[command];
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

async function hostsCheck(runner: Runner, options: HostsOptions = {}): Promise<DoctorCheck> {
  const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-hosts-env-'));
  const report = await doctorQlb(defaultConfig(home), {
    command: () => 'ok',
    hostCommand: runner,
    hostShell: '/bin/zsh',
    hostShellExists: (path) => path === '/bin/zsh',
    ...options,
  });
  const check = report.checks.find((candidate) => candidate.name === 'hosts:env');
  assert.ok(check, 'hosts:env check should be registered');
  return check;
}

describe('qlb doctor hosts:env', () => {
  it('passes when no QLB-bypassing variables are set', async () => {
    const check = await hostsCheck(fakeRunner('PATH=/usr/bin\nHOME=/tmp/test\n', {
      herdr: 'herdr 1.2.3\n',
      orca: 'orca 4.5.6\n',
    }));

    assert.equal(check.level, 'PASS');
    assert.deepEqual(check.detail, { herdr: 'herdr 1.2.3', orca: 'orca 4.5.6' });
  });

  it('WARNs with the variable name but never its value', async () => {
    const secret = 'must-not-appear-in-doctor-output';
    const check = await hostsCheck(fakeRunner(`ANTHROPIC_API_KEY=${secret}\nPATH=/usr/bin\n`));

    assert.equal(check.level, 'WARN');
    assert.match(check.message, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(JSON.stringify(check), new RegExp(secret));
  });

  it('WARNs for ANTHROPIC_AUTH_TOKEN without exposing its value', async () => {
    const secret = 'must-not-appear-in-doctor-output';
    const check = await hostsCheck(fakeRunner(`ANTHROPIC_AUTH_TOKEN=${secret}\nPATH=/usr/bin\n`));

    assert.equal(check.level, 'WARN');
    assert.match(check.message, /ANTHROPIC_AUTH_TOKEN/);
    assert.doesNotMatch(JSON.stringify(check), new RegExp(secret));
  });

  it('starts the login shell with only the minimal environment', async () => {
    const inherited = 'QLB_TEST_INHERITED_VARIABLE';
    const previous = process.env[inherited];
    process.env[inherited] = 'set-only-in-calling-process';
    let shell: string | undefined;
    let received: NodeJS.ProcessEnv | undefined;
    try {
      await hostsCheck((command, args, options) => {
        if (args[0] === '--version') throw missingCommand(command);
        if (isLaunchctlProbe(args)) return '';
        shell = command;
        received = options?.env;
        return 'PATH=/usr/bin\n';
      }, {
        hostShell: '/opt/test/bash',
        hostShellExists: (path) => path === '/opt/test/bash',
      });
    } finally {
      if (previous === undefined) delete process.env[inherited];
      else process.env[inherited] = previous;
    }

    assert.equal(shell, '/opt/test/bash');
    assert.ok(received);
    assert.equal(received[inherited], undefined);
    assert.equal(received.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.deepEqual(
      Object.keys(received).sort(),
      ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER']
        .filter((name) => name === 'PATH' || process.env[name] !== undefined)
        .sort(),
    );
  });

  it('uses an absolute bash SHELL when available', async () => {
    let shell: string | undefined;
    await hostsCheck((command, args) => {
      if (args[0] === '--version') throw missingCommand(command);
      if (isLaunchctlProbe(args)) return '';
      shell = command;
      return 'PATH=/usr/bin\n';
    }, {
      hostShell: '/usr/local/bin/bash',
      hostShellExists: (path) => path === '/usr/local/bin/bash',
    });
    assert.equal(shell, '/usr/local/bin/bash');
  });

  it('skips on win32 instead of warning', async () => {
    const check = await hostsCheck(fakeRunner('PATH=/usr/bin\n'), { hostPlatform: 'win32' });
    assert.equal(check.level, 'PASS');
    assert.equal(check.message, 'hosts:env skipped: no POSIX login shell');
  });

  it('skips unsupported fish and tcsh login shells', async () => {
    for (const [hostShell, name] of [
      ['/opt/homebrew/bin/fish', 'fish'],
      ['/bin/tcsh', 'tcsh'],
    ]) {
      const check = await hostsCheck(fakeRunner('PATH=/usr/bin\n'), {
        hostShell,
        hostShellExists: (path) => path === '/bin/zsh',
      });
      assert.equal(check.level, 'PASS');
      assert.equal(check.message, `hosts:env skipped: unsupported login shell ${name}`);
    }
  });

  it('falls back to zsh when SHELL is unset', async () => {
    let shell: string | undefined;
    await hostsCheck((command, args) => {
      if (args[0] === '--version') throw missingCommand(command);
      if (isLaunchctlProbe(args)) return '';
      shell = command;
      return 'PATH=/usr/bin\n';
    }, {
      hostShell: undefined,
      hostShellExists: (path) => path === '/bin/zsh',
    });
    assert.equal(shell, '/bin/zsh');
  });

  it('skips when no usable POSIX shell exists', async () => {
    const check = await hostsCheck(fakeRunner('PATH=/usr/bin\n'), {
      hostShell: '/not/a/bash',
      hostShellExists: () => false,
    });
    assert.equal(check.level, 'PASS');
    assert.equal(check.message, 'hosts:env skipped: no POSIX login shell');
  });

  it('WARNs for CLAUDE_CODE_OAUTH_TOKEN without exposing its value', async () => {
    const secret = 'must-not-appear-in-doctor-output';
    const check = await hostsCheck(fakeRunner(`CLAUDE_CODE_OAUTH_TOKEN=${secret}\nPATH=/usr/bin\n`));

    assert.equal(check.level, 'WARN');
    assert.match(check.message, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.doesNotMatch(JSON.stringify(check), new RegExp(secret));
  });

  it('makes no launchctl call in ordinary test mode without an injected launchctl path', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner('PATH=/usr/bin\n');
    const check = await hostsCheck((command, args, options) => {
      calls.push([command, ...args]);
      return runner(command, args, options);
    }, { hostPlatform: 'darwin' });

    assert.equal(check.level, 'PASS');
    assert.equal(calls.filter((call) => call.includes('-c')).length, 0);
  });

  it('WARNs when the login shell environment cannot be read', async () => {
    const check = await hostsCheck((command, args) => {
      if (args[0] === '-lic' && args[1] === 'env') throw new Error('ETIMEDOUT');
      throw missingCommand(command);
    });

    assert.equal(check.level, 'WARN');
    assert.equal(check.message, 'could not read login shell environment');
  });

  it('distinguishes an absent tool from a version-probe failure', async () => {
    const check = await hostsCheck((command, args) => {
      if (args[0] === '-lic') return 'PATH=/usr/bin\n';
      if (command === 'herdr') throw missingCommand(command);
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    assert.equal(check.level, 'PASS');
    assert.deepEqual(check.detail, {
      herdr: 'not installed',
      orca: 'installed (version probe failed)',
    });
  });
});

describe('qlb doctor hosts:env launchctl probe', () => {
  const sentinel = 'launchctl-sentinel-value-must-stay-in-the-shell';
  const allowedLines = new Set([
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    '!error',
  ]);

  function fixtureLaunchctl(): string {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-hosts-env-launchctl-'));
    const path = join(dir, 'launchctl');
    writeFileSync(path, [
      '#!/bin/sh',
      '[ "$1" = getenv ] || exit 64',
      'case "$2" in',
      `  CLAUDE_CODE_OAUTH_TOKEN) printf '%s\\n' '${sentinel}' ;;`,
      '  ANTHROPIC_API_KEY) exit 1 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(path, 0o755);
    return path;
  }

  it('runs the real loop against launchctl and reports names, never values', async () => {
    const { runHostCommand } = await import('../src/diagnostics');
    const launchctl = fixtureLaunchctl();
    const rawOutputs: string[] = [];
    const check = await hostsCheck((command, args, options) => {
      if (isLaunchctlProbe(args)) {
        assert.equal(command, '/bin/sh');
        const out = runHostCommand(command, args, options);
        rawOutputs.push(out);
        return out;
      }
      return fakeRunner('PATH=/usr/bin\n')(command, args, options);
    }, { hostPlatform: 'darwin', hostLaunchctl: launchctl });

    assert.equal(rawOutputs.length, 1, 'exactly one launchctl probe call');
    const lines = rawOutputs[0].split('\n').filter((line) => line !== '');
    for (const line of lines) assert.ok(allowedLines.has(line), 'launchctl probe stdout is only names and !error');
    assert.ok(lines.includes('CLAUDE_CODE_OAUTH_TOKEN'));
    assert.ok(lines.includes('!error'));
    assert.doesNotMatch(rawOutputs[0], new RegExp(sentinel));

    assert.equal(check.level, 'WARN');
    assert.match(check.message, /launchctl sets CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(check.message, /could not read launchctl environment/);
    assert.doesNotMatch(JSON.stringify(check), new RegExp(sentinel));
  });

  it('WARNs on a launchctl hit when there is no usable login shell', async () => {
    const check = await hostsCheck((command, args) => {
      if (isLaunchctlProbe(args)) return 'CLAUDE_CODE_OAUTH_TOKEN\n';
      throw missingCommand(command);
    }, {
      hostPlatform: 'darwin',
      hostLaunchctl: '/fixture/launchctl',
      hostShell: '/not/a/bash',
      hostShellExists: () => false,
    });

    assert.equal(check.level, 'WARN');
    assert.match(check.message, /launchctl sets CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it('keeps launchctl hits when the login shell read fails', async () => {
    const check = await hostsCheck((command, args) => {
      if (isLaunchctlProbe(args)) return 'OPENAI_API_KEY\n';
      if (args[0] === '-lic') throw new Error('ETIMEDOUT');
      throw missingCommand(command);
    }, { hostPlatform: 'darwin', hostLaunchctl: '/fixture/launchctl' });

    assert.equal(check.level, 'WARN');
    assert.match(check.message, /launchctl sets OPENAI_API_KEY/);
    assert.match(check.message, /could not read login shell environment/);
  });

  it('WARNs when the launchctl probe itself fails', async () => {
    const check = await hostsCheck((command, args, options) => {
      if (isLaunchctlProbe(args)) throw Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return fakeRunner('PATH=/usr/bin\n')(command, args, options);
    }, { hostPlatform: 'darwin', hostLaunchctl: '/fixture/launchctl' });

    assert.equal(check.level, 'WARN');
    assert.equal(check.message, 'could not read launchctl environment');
  });

  it('does not probe launchctl off darwin', async () => {
    const calls: string[][] = [];
    await hostsCheck((command, args, options) => {
      calls.push(args);
      return fakeRunner('PATH=/usr/bin\n')(command, args, options);
    }, { hostPlatform: 'linux', hostLaunchctl: '/fixture/launchctl' });
    assert.equal(calls.filter(isLaunchctlProbe).length, 0);
  });
});

describe('qlb doctor hosts:env default runner', () => {
  const pidfiles: string[] = [];
  after(() => {
    for (const pidfile of pidfiles) {
      if (!existsSync(pidfile)) continue;
      const pid = Number(readFileSync(pidfile, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already exited
      }
    }
  });

  it('kills a SIGTERM-ignoring host command at its 5 s bound', async () => {
    const { runHostCommand } = await import('../src/diagnostics');
    const pidfile = join(mkdtempSync(join(tmpdir(), 'qlb-hosts-env-timeout-')), 'sleep.pid');
    pidfiles.push(pidfile);
    const started = Date.now();
    assert.throws(
      () => runHostCommand('/bin/sh', ['-c', `trap "" TERM; /bin/sleep 30 & echo $! > '${pidfile}'; wait`]),
      (err: NodeJS.ErrnoException) => err.code === 'ETIMEDOUT',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 7_000, `runHostCommand returned after ${elapsed} ms`);
  });

  it('runs host commands in their own session so an interactive login shell cannot take over the caller terminal', async () => {
    const { runHostCommand } = await import('../src/diagnostics');
    // A detached child leads its own process group; an attached one shares the caller's.
    const out = runHostCommand('/bin/sh', ['-c', 'echo "$$ $(ps -o pgid= -p $$)"']).trim().split(/\s+/);
    assert.equal(out.length, 2);
    assert.equal(out[1], out[0], 'host command must run as its own process-group leader');
  });
});
