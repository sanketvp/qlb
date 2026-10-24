import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadProviderStub } from '../src/provider-loader';
import { builtInAdapters } from '../src/adapters';
import { KNOWN_PROVIDER_NAMES, discoverChecks } from '../src/registry';

describe('registries', () => {
  it('loads source modules when discovery is explicitly given the ts-node extension', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qlb-registry-ts-'));
    writeFileSync(join(directory, 'source-check.ts'), 'export default null\n');
    writeFileSync(join(directory, 'compiled-check.js'), 'module.exports = null\n');
    const loaded: string[] = [];

    const checks = discoverChecks(directory, ['.ts'], (path) => {
      loaded.push(path);
      return { default: { name: 'source:check' } };
    });

    assert.deepEqual(checks, [{ name: 'source:check' }]);
    assert.deepEqual(loaded, [join(directory, 'source-check.ts')]);
  });

  it('refuses invalid provider stub names before path construction or require', () => {
    for (const name of ['../x', 'a/b', 'A']) {
      let joined = false;
      let required = false;
      assert.throws(() => loadProviderStub(name, '/provider-modules', {
        joinPath: () => { joined = true; return '/unexpected'; },
        requireModule: () => { required = true; return {}; },
      }), /unknown provider/);
      assert.equal(joined, false, `${name} reached join()`);
      assert.equal(required, false, `${name} reached require()`);
    }
  });

  it('allows only registry-owned provider names', () => {
    const loaded = loadProviderStub('anthropic', '/provider-modules', {
      joinPath: (...parts) => parts.join('/'),
      requireModule: (path) => ({ path }),
    });
    assert.deepEqual(loaded, { path: '/provider-modules/anthropic' });
    assert.throws(() => loadProviderStub('unknown', '/provider-modules'), /unknown provider/);
  });

  it('keeps provider stub names aligned with built-in adapter ids', () => {
    assert.deepEqual(
      [...KNOWN_PROVIDER_NAMES].sort(),
      builtInAdapters.map((adapter) => adapter.id).sort(),
    );
  });

  it('cleans dist-test registry output before compiling tests', () => {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      scripts: { test: string };
    };
    assert.match(packageJson.scripts.test, /clean-registry-output\.cjs dist-test\/src/);
  });

  it('removes stale registry output before a build', () => {
    const dist = mkdtempSync(join(tmpdir(), 'qlb-registry-dist-'));
    const stale = join(dist, 'commands', 'stale.js');
    mkdirSync(join(dist, 'commands'), { recursive: true });
    mkdirSync(join(dist, 'checks'), { recursive: true });
    writeFileSync(stale, 'stale');
    writeFileSync(join(dist, 'checks', 'stale.js'), 'stale');

    execFileSync(process.execPath, ['scripts/clean-registry-output.cjs', dist], { cwd: join(__dirname, '..', '..') });

    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(join(dist, 'checks', 'stale.js')), false);
  });
});
