import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { doctorQlb, type DoctorCheck } from '../src/diagnostics';

type Runner = (command: string, args: string[]) => string;

function fakeRunner(env: string, versions: Record<string, string> = {}): Runner {
  return (command, args) => {
    if (command === 'zsh' && args[0] === '-lic' && args[1] === 'env') return env;
    if (args[0] === '--version') {
      if (!(command in versions)) throw new Error(`${command} is not installed`);
      return versions[command];
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

async function hostsCheck(runner: Runner): Promise<DoctorCheck> {
  const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-hosts-env-'));
  const report = await doctorQlb(defaultConfig(home), {
    command: () => 'ok',
    hostCommand: runner,
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

  it('WARNs when the login shell environment cannot be read', async () => {
    const check = await hostsCheck((command, args) => {
      if (command === 'zsh' && args[0] === '-lic' && args[1] === 'env') {
        throw new Error('ETIMEDOUT');
      }
      throw new Error(`${command} is not installed`);
    });

    assert.equal(check.level, 'WARN');
    assert.equal(check.message, 'could not read login shell environment');
  });

  it('does not fail when herdr is not installed', async () => {
    const check = await hostsCheck(fakeRunner('PATH=/usr/bin\n', { orca: 'orca 4.5.6\n' }));

    assert.equal(check.level, 'PASS');
    assert.deepEqual(check.detail, { herdr: 'not installed', orca: 'orca 4.5.6' });
  });
});
