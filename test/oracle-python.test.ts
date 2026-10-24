import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(__dirname, '..', '..');

function assertPythonCheck(script: string, successLine: string): void {
  const result = spawnSync('python3', ['-I', '-B', script, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const output = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
  assert.equal(
    result.status,
    0,
    `Python 3.12 or newer must be resolvable to check ${script}; command failed:\n${output}`,
  );
  assert.match(result.stdout, new RegExp(`^${successLine}$`, 'm'), output);
}

describe('oracle Python checks', () => {
  it('checks the manifest', () => {
    assertPythonCheck('scripts/oracle-manifest.py', 'oracle manifest matches');
  });

  it('checks the goldens', () => {
    assertPythonCheck('scripts/oracle-golden.py', 'oracle goldens match');
  });
});
