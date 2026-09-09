import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const support = join(__dirname, '..', '..', 'test', 'support');
const guard = join(support, 'guard.cjs');
const inert = join(support, 'guard-inert-selftest.cjs');

describe('T-GUARD-1 isolation guard', () => {
  it('inert capture proofs deny bypass shapes without live I/O', () => {
    const r = spawnSync(process.execPath, [inert], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const report = JSON.parse(r.stdout) as { ok: boolean; failures: string[] };
    assert.equal(report.ok, true);
    assert.deepEqual(report.failures, []);
  });

  it('denies spawn(sh) in a guarded child', () => {
    const r = spawnSync(process.execPath, ['--require', guard, '-e', "require('child_process').exec('true')"], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /ISOLATION_DENIED:spawn:sh/);
  });

  it('allows a test-owned loopback fixture in one process', () => {
    const r = spawnSync(process.execPath, ['--require', guard, '-e', `
      const http = require('http');
      const server = http.createServer((_q, res) => { res.end('ok'); });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        http.get('http://127.0.0.1:' + port + '/', (res) => {
          res.resume();
          res.on('end', () => process.exit(0));
        }).on('error', (e) => { console.error(e); process.exit(1); });
      });
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });
});
