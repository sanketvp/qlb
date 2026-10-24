import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

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
};

function missingCommand(name: string): Error & { code: string } {
  return Object.assign(new Error(`${name} is not installed`), { code: 'ENOENT' });
}

function fakeRunner(env: string, versions: Record<string, string> = {}): Runner {
  return (command, args) => {
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

  it('skips when no usable POSIX shell exists', async () => {
    const check = await hostsCheck(fakeRunner('PATH=/usr/bin\n'), {
      hostShell: '/not/a/shell',
      hostShellExists: () => false,
    });
    assert.equal(check.level, 'PASS');
    assert.equal(check.message, 'hosts:env skipped: no POSIX login shell');
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
