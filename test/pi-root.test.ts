import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';

import { locatePi, piIntegrationChecks, piTypecheckConfig, resolvePiPackageRoot } from '../src/pi-integration';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function fakePiPackage(prefix: string, version: string): string {
  const root = join(prefix, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
  const entry = join(root, 'dist', 'bundle', 'cli.js');
  writeFileSync(entry, '#!/usr/bin/env node\n');
  chmodSync(entry, 0o755);
  return root;
}

function npmSymlinkInstall(prefix: string, version: string): string {
  const root = fakePiPackage(prefix, version);
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  symlinkSync(join(root, 'dist', 'bundle', 'cli.js'), join(prefix, 'bin', 'pi'));
  return root;
}

function executable(path: string, text: string | Buffer): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

describe('locatePi', () => {
  it('follows the first pi on PATH to its package, not a stale install later on PATH', () => {
    const base = tmp('qlb-piroot-');
    const active = npmSymlinkInstall(join(base, 'local'), '1.0.1');
    npmSymlinkInstall(join(base, 'homebrew'), '0.99.2');
    const env = { PATH: [join(base, 'nothing'), join(base, 'local', 'bin'), join(base, 'homebrew', 'bin')].join(':') };
    assert.deepEqual(locatePi(env, join(base, 'home')), { root: active, launcher: join(base, 'local', 'bin', 'pi') });
  });

  it('reads the package path out of a wrapper script shim', () => {
    const base = tmp('qlb-piroot-');
    const root = fakePiPackage(join(base, 'tool'), '1.0.1');
    mkdirSync(join(base, 'shims'));
    executable(join(base, 'shims', 'pi'), `#!/bin/sh\nexec node "${root}/dist/bundle/cli.js" "$@"\n`);
    assert.equal(resolvePiPackageRoot({ PATH: join(base, 'shims') }, base), root);
  });

  it('resolves a Windows npm .cmd shim relative to its directory', () => {
    const base = tmp('qlb-piroot-');
    fakePiPackage(join(base, 'npm'), '1.0.1');
    const bin = join(base, 'npm', 'lib');
    writeFileSync(join(bin, 'pi.cmd'), '@ECHO off\r\n"%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n');
    const env = { PATH: bin, PATHEXT: '.CMD' };
    assert.equal(locatePi(env, base, 'win32').root, join(bin, 'node_modules', '@earendil-works', 'pi-coding-agent'));
  });

  it('reports an untraceable first launcher instead of falling through to a stale install', () => {
    const base = tmp('qlb-piroot-');
    mkdirSync(join(base, 'volta', 'bin'), { recursive: true });
    executable(join(base, 'volta', 'bin', 'pi'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])); // compiled shim
    npmSymlinkInstall(join(base, 'stale'), '0.99.2');
    const env = { PATH: [join(base, 'volta', 'bin'), join(base, 'stale', 'bin')].join(':') };
    assert.deepEqual(locatePi(env, base), { root: null, launcher: join(base, 'volta', 'bin', 'pi'), unresolved: true });
  });

  it('treats an empty PATH entry as the current directory, like a shell', () => {
    const base = tmp('qlb-piroot-');
    const cwdRoot = npmSymlinkInstall(join(base, 'cwd'), '1.0.1');
    npmSymlinkInstall(join(base, 'stale'), '0.99.2');
    const prev = process.cwd();
    process.chdir(join(base, 'cwd', 'bin'));
    try {
      assert.equal(resolvePiPackageRoot({ PATH: `:${join(base, 'stale', 'bin')}` }, base), cwdRoot);
    } finally {
      process.chdir(prev);
    }
  });

  it('an unset PATH searches nothing (no implicit current directory)', () => {
    const base = tmp('qlb-piroot-');
    const cwdRoot = npmSymlinkInstall(join(base, 'cwd'), '1.0.1');
    const prev = process.cwd();
    process.chdir(join(base, 'cwd', 'bin'));
    try {
      const located = locatePi({}, join(base, 'empty-home'));
      // Only well-known prefixes may answer; never the pi sitting in the cwd.
      assert.notEqual(located.root, cwdRoot);
      assert.equal(located.launcher, undefined);
    } finally {
      process.chdir(prev);
    }
  });

  it('on Windows prefers pi.ps1, then PATHEXT order, and ignores an extensionless pi', () => {
    const base = tmp('qlb-piroot-');
    // Earlier PATH dir: only a PowerShell script shim (PATHEXT lacks .PS1, as by default).
    const ps1Root = fakePiPackage(join(base, 'ps'), '1.0.1');
    const psBin = join(base, 'ps', 'lib');
    writeFileSync(join(psBin, 'pi.ps1'), '& "$PSScriptRoot/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" $args\r\n');
    // Later PATH dir: a stale .cmd install plus an extensionless decoy.
    fakePiPackage(join(base, 'old'), '0.99.2');
    const oldBin = join(base, 'old', 'lib');
    writeFileSync(join(oldBin, 'pi'), '#!/bin/sh\nexec node /stale/pi-coding-agent/cli.js\n');
    writeFileSync(join(oldBin, 'pi.cmd'), '@ECHO off\r\n"%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n');
    const env = { PATH: `;${psBin};${oldBin}`, PATHEXT: '.EXE;.CMD' };
    const located = locatePi(env, base, 'win32');
    assert.equal(located.launcher, join(psBin, 'pi.ps1'));
    assert.equal(located.root, ps1Root);

    // Within one directory, PATHEXT order decides: .EXE before .CMD.
    fakePiPackage(join(base, 'both'), '1.0.1');
    const bothBin = join(base, 'both', 'lib');
    writeFileSync(join(bothBin, 'pi.exe'), Buffer.from([0x4d, 0x5a, 0, 0])); // binary: untraceable
    writeFileSync(join(bothBin, 'pi.cmd'), '@ECHO off\r\n"%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n');
    const both = locatePi({ PATH: bothBin, PATHEXT: '.EXE;.CMD' }, base, 'win32');
    assert.deepEqual(both, { root: null, launcher: join(bothBin, 'pi.exe'), unresolved: true });
  });

  it('in one directory, pi.ps1 wins over pi.cmd even when they point at different installs', () => {
    const base = tmp('qlb-piroot-');
    const bin = join(base, 'one');
    const psRoot = fakePiPackage(join(base, 'one-ps'), '1.0.1');
    fakePiPackage(join(base, 'one-cmd'), '0.99.2');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'pi.ps1'), `& "${psRoot}/dist/bundle/cli.js" $args\r\n`);
    writeFileSync(join(bin, 'pi.cmd'), `@"${join(base, 'one-cmd', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent')}\\dist\\bundle\\cli.js" %*\r\n`);
    const located = locatePi({ PATH: bin, PATHEXT: '.EXE;.CMD' }, base, 'win32');
    assert.equal(located.launcher, join(bin, 'pi.ps1'));
    assert.equal(located.root, psRoot);
  });

  it('traces the fleet runtime selector through runtimes/current', () => {
    const home = tmp('qlb-piroot-fleet-');
    const release = fakePiPackage(join(home, 'release'), '1.0.1');
    const runtime = join(home, '.pi', 'agent', 'runtimes', 'global');
    mkdirSync(runtime, { recursive: true });
    symlinkSync(join(home, 'release', 'lib', 'node_modules'), join(runtime, 'node_modules'));
    symlinkSync(runtime, join(home, '.pi', 'agent', 'runtimes', 'current'));
    const binDir = join(home, '.pi', 'agent', 'bin');
    mkdirSync(binDir, { recursive: true });
    executable(join(binDir, 'pi'), [
      '#!/bin/bash',
      'CURRENT="$HOME/.pi/agent/runtimes/current"',
      'RUNTIME_ROOT="$(cd -P "$CURRENT" && pwd)"',
      'CLI="$RUNTIME_ROOT/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"',
      'exec node "$CLI" "$@"',
      '',
    ].join('\n'));
    const located = locatePi({ PATH: binDir }, home);
    assert.equal(located.root, realpathSync(release));
    assert.equal(located.launcher, join(binDir, 'pi'));
  });

  it('reports an absolute launcher for a cwd PATH entry', () => {
    const base = tmp('qlb-piroot-');
    mkdirSync(join(base, 'cwd'), { recursive: true });
    executable(join(base, 'cwd', 'pi'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
    const prev = process.cwd();
    process.chdir(join(base, 'cwd'));
    try {
      assert.equal(locatePi({ PATH: ':' }, base).launcher, join(base, 'cwd', 'pi'));
    } finally {
      process.chdir(prev);
    }
  });

  it('skips a directory named pi on PATH, like a shell', () => {
    const base = tmp('qlb-piroot-');
    mkdirSync(join(base, 'dirs', 'pi'), { recursive: true });
    const active = npmSymlinkInstall(join(base, 'local'), '1.0.1');
    const env = { PATH: [join(base, 'dirs'), join(base, 'local', 'bin')].join(':') };
    assert.equal(resolvePiPackageRoot(env, base), active);
  });

  it('resolves a relative QLB_PI_PACKAGE_ROOT to an absolute path', () => {
    const base = tmp('qlb-piroot-');
    const root = fakePiPackage(join(base, 'rel'), '1.0.1');
    const located = locatePi({ QLB_PI_PACKAGE_ROOT: relative(process.cwd(), root), PATH: '' }, base);
    assert.equal(located.root, root);
  });

  it('honors QLB_PI_PACKAGE_ROOT and flags one that is not Pi', () => {
    const base = tmp('qlb-piroot-');
    const root = fakePiPackage(join(base, 'x'), '1.0.1');
    assert.deepEqual(locatePi({ QLB_PI_PACKAGE_ROOT: root, PATH: '' }, base), { root });
    assert.deepEqual(locatePi({ QLB_PI_PACKAGE_ROOT: base, PATH: '' }, base), { root: null, unresolved: true });
  });

  it('falls back to ~/.local only when no pi is on PATH', () => {
    const home = tmp('qlb-piroot-home-');
    const root = fakePiPackage(join(home, '.local'), '1.0.1');
    assert.equal(resolvePiPackageRoot({}, home), root);
  });
});

describe('doctor with an unresolved Pi launcher', () => {
  it('warns instead of reporting a skip as PASS', () => {
    const extensionDir = tmp('qlb-pi-ext-');
    const checks = piIntegrationChecks({ pi: { root: null, launcher: '/x/pi', unresolved: true }, extensionDir });
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.level, 'WARN');
    assert.match(checks[0]!.message, /could not locate/);
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
