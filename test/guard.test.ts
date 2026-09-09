import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const guard = join(__dirname, '..', '..', 'test', 'support', 'guard.cjs');

function nodeUnderGuard(code: string, extraEnv?: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ['--require', guard, '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('T-GUARD-1 isolation guard', () => {
  it('denies spawn(sh)', () => {
    const r = nodeUnderGuard("require('child_process').exec('true')");
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /ISOLATION_DENIED:spawn:sh/);
  });

  it('denies an external address', () => {
    const r = nodeUnderGuard("require('http').get('http://example.com/', () => {})");
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /ISOLATION_DENIED:net:example.com/);
  });

  it('allows a test-owned loopback fixture', () => {
    const r = nodeUnderGuard(`
      const http = require('http');
      const server = http.createServer((_q, res) => { res.end('ok'); });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        http.get('http://127.0.0.1:' + port + '/', (res) => {
          res.resume();
          res.on('end', () => process.exit(0));
        }).on('error', (e) => { console.error(e); process.exit(1); });
      });
    `);
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });
});
