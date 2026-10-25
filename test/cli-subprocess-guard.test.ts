import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const cliPath = join(__dirname, '..', '..', 'dist', 'cli.js');

function childEnv(home: string, testMode: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('QLB_')) delete env[key];
  }
  env.HOME = home;
  env.QLB_HOME = home;
  if (testMode) env.QLB_TEST_MODE = '1';
  return env;
}

function runChild(args: string[], testMode: boolean): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), 'qlb-cli-subprocess-'));
  try {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env: childEnv(home, testMode),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('compiled CLI test-mode subprocess guard', () => {
  it('lists commands when the child inherits test mode and an isolated home', () => {
    const result = runChild(['--list-commands', '--json'], true);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Array.isArray(JSON.parse(result.stdout)));
  });

  it('keeps the switch command child inside test mode', () => {
    const result = runChild(['switch', 'anthropic', 'x', '--json'], true);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Usage:/);
  });

  it('refuses an isolated QLB_HOME when test mode is absent before command dispatch', () => {
    const result = runChild(['--list-commands', '--json'], false);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /QLB_HOME requires QLB_TEST_MODE=1/);
  });
});
