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

  it('loads the guard when application argv contains a fake late preload', () => {
    const parent = `
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const cp = require('child_process');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlb-guard-child-'));
      const script = path.join(dir, 'fixture.js');
      fs.writeFileSync(script, "process.stdout.write(JSON.stringify({loaded:!!globalThis.__qlbIsolationGuard}))");
      const afterScript = cp.spawnSync(process.execPath, [script, '--require', ${JSON.stringify(guard)}], {encoding:'utf8'});
      const code = "process.stdout.write(JSON.stringify({loaded:!!globalThis.__qlbIsolationGuard}))";
      const afterTerminator = cp.spawnSync(process.execPath, ['-e', code, '--', '--require', ${JSON.stringify(guard)}], {encoding:'utf8'});
      fs.rmSync(dir, {recursive:true, force:true});
      process.stdout.write(JSON.stringify({
        afterScript: {status: afterScript.status, report: JSON.parse(afterScript.stdout)},
        afterTerminator: {status: afterTerminator.status, report: JSON.parse(afterTerminator.stdout)},
      }));
    `;
    const r = spawnSync(process.execPath, ['--require', guard, '-e', parent], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const report = JSON.parse(r.stdout) as {
      afterScript: { status: number; report: { loaded: boolean } };
      afterTerminator: { status: number; report: { loaded: boolean } };
    };
    assert.deepEqual(report.afterScript, { status: 0, report: { loaded: true } });
    assert.deepEqual(report.afterTerminator, { status: 0, report: { loaded: true } });
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
