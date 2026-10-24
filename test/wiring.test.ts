import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const cliPath = join(__dirname, '..', 'src', 'cli.js');
const commandsDir = join(__dirname, '..', '..', 'test', 'wiring', 'commands.d');
const checksDir = join(__dirname, '..', '..', 'test', 'wiring', 'checks.d');

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' }),
      stderr: '',
    };
  } catch (error) {
    const err = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

function entries(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe('command and diagnostic wiring', () => {
  it('lists exactly the registered command fragments', () => {
    const result = run(['--list-commands', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), entries(commandsDir));
  });

  it('lists exactly the registered diagnostic fragments', () => {
    const result = run(['doctor', '--list-checks', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), entries(checksDir));
  });

  it('runs exactly the registered diagnostics', () => {
    const listed = run(['doctor', '--list-checks', '--json']);
    const report = run(['doctor', '--json']);
    assert.ok(report.status === 0 || report.status === 1, report.stderr);
    const checks = (JSON.parse(report.stdout) as { checks: Array<{ name: string }> }).checks;
    assert.deepEqual(checks.map((check) => check.name), JSON.parse(listed.stdout));
  });

  it('dispatches multi-word commands by their longest prefix', () => {
    const result = run(['codex', 'gate', '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /qlb codex gate/);
  });
});
