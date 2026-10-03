import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { piTypecheckConfig, resolvePiPackageRoot } from '../src/pi-integration';

function fakePiInstall(prefix: string, version: string): string {
  const root = join(prefix, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
  const entry = join(root, 'dist', 'bundle', 'cli.js');
  writeFileSync(entry, '#!/usr/bin/env node\n');
  chmodSync(entry, 0o755);
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  symlinkSync(entry, join(prefix, 'bin', 'pi'));
  return realpathSync(root);
}

describe('resolvePiPackageRoot', () => {
  it('follows the first pi on PATH to its package, not a stale install elsewhere', () => {
    const base = mkdtempSync(join(tmpdir(), 'qlb-piroot-'));
    const active = fakePiInstall(join(base, 'local'), '1.0.1');
    fakePiInstall(join(base, 'homebrew'), '0.99.2');
    const env = { PATH: [join(base, 'nothing'), join(base, 'local', 'bin'), join(base, 'homebrew', 'bin')].join(':') };
    assert.equal(resolvePiPackageRoot(env, join(base, 'home')), active);
  });

  it('honors QLB_PI_PACKAGE_ROOT and rejects a directory that is not Pi', () => {
    const base = mkdtempSync(join(tmpdir(), 'qlb-piroot-'));
    const root = fakePiInstall(join(base, 'x'), '1.0.1');
    assert.equal(resolvePiPackageRoot({ QLB_PI_PACKAGE_ROOT: root, PATH: '' }, base), root);
    assert.equal(resolvePiPackageRoot({ QLB_PI_PACKAGE_ROOT: base, PATH: '' }, base), null);
  });

  it('falls back to ~/.local when no pi is on PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-piroot-home-'));
    fakePiInstall(join(home, '.local'), '1.0.1');
    assert.equal(
      resolvePiPackageRoot({ PATH: '' }, home),
      join(home, '.local', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'),
    );
  });
});

describe('piTypecheckConfig', () => {
  it('points every Pi path at the resolved install and keeps compiler options', () => {
    const ext = join(__dirname, '..', '..', 'extensions', 'qlb-pi');
    const cfg = piTypecheckConfig(ext, '/pi/root') as {
      compilerOptions: { strict?: boolean; noEmit?: boolean; typeRoots: string[]; paths: Record<string, string[]> };
      include: string[];
    };
    assert.equal(cfg.compilerOptions.strict, true);
    assert.equal(cfg.compilerOptions.noEmit, true);
    assert.deepEqual(cfg.compilerOptions.typeRoots, ['/pi/root/node_modules/@types']);
    for (const target of Object.values(cfg.compilerOptions.paths).flat()) {
      assert.ok(target.startsWith('/pi/root/'), target);
    }
    assert.deepEqual(cfg.include, [join(ext, '*.ts')]);
  });
});
