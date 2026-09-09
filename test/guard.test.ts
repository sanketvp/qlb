import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const support = join(__dirname, '..', '..', 'test', 'support');
const guard = join(support, 'guard.cjs');

describe('T-GUARD-1 isolation guard', () => {
  // The stub-first inert bypass matrix is intentionally executed as a
  // separate preflight (`node test/support/guard-inert-selftest.cjs`) before
  // this guarded suite. Running it as a child here would correctly propagate
  // the already-loaded guard before the script can install inert stubs.
  it('denies spawn(sh) in a guarded child', () => {
    const r = spawnSync(process.execPath, ['--require', guard, '-e', "require('child_process').exec('true')"], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /ISOLATION_DENIED:spawn:sh/);
  });

  it('explicitly mocks the production native-resync reader by default', () => {
    const nativeResync = join(__dirname, '..', 'src', 'native-resync.js');
    const r = spawnSync(process.execPath, ['--require', guard, '-e', `
      const { createNativeCredentialReader } = require(${JSON.stringify(nativeResync)});
      createNativeCredentialReader({
        poolFilePath: '/qlb-inert-native-pool',
        authJsonPath: '/qlb-inert-native-auth',
      });
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /ISOLATION_DENIED:native:default-native-reader/);
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
