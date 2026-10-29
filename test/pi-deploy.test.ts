import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runPiDeployCommand } from '../src/commands/pi-deploy';
import { piExtensionDriftCheck } from '../src/checks/pi-extension-drift';
import { piStaleSessionsCheck } from '../src/checks/pi-stale-sessions';
import { deployPiExtension, piRedactTarget, piSharedSrcDir } from '../src/pi-deploy';
import { openStore } from '../src/store';
import type { CommandContext } from '../src/registry';

function fixture(root: string): { home: string; appDir: string; dbPath: string; extension: string } {
  const home = join(root, 'home');
  const appDir = join(home, 'app');
  const release = join(appDir, 'release-fixture');
  const extension = join(release, 'extensions', 'qlb-pi');
  mkdirSync(extension, { recursive: true });
  mkdirSync(join(release, 'src'), { recursive: true });
  writeFileSync(join(release, 'src', 'redact.ts'), 'export const redact = 1;\n');
  writeFileSync(join(release, 'src', 'pi-owner-document.ts'), 'export const ownerDocument = 1;\n');
  writeFileSync(join(extension, 'index.ts'), 'export const version = 1;\n');
  writeFileSync(join(extension, 'manifest.json'), '{"fixture":true}\n');
  symlinkSync('release-fixture', join(appDir, 'current'));
  return { home, appDir, dbPath: join(home, 'qlb.db'), extension };
}

function context(home: string, dbPath: string, output: string[]): CommandContext {
  return {
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(`ERR:${line}`),
    env: { QLB_TEST_MODE: '1', QLB_HOME: home },
    config: { dbPath } as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); },
    home: join(home, 'wrong-home'),
    registerSecret: () => {},
    deliverSecret: () => {},
    knownSecrets: () => [],
  };
}

describe('qlb pi deploy (P12)', () => {
  it('deploys from the current release, records its hash, and atomically replaces a prior extension', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-deploy-'));
    const f = fixture(root);

    const first = deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath, now: () => 1_700_000_000_000 });
    const target = join(f.home, '.pi', 'agent', 'extensions', 'qlb-pi');
    assert.equal(first.target, target);
    assert.equal(readFileSync(join(target, 'index.ts'), 'utf8'), 'export const version = 1;\n');
    const redact = join(f.home, '.pi', 'agent', 'src', 'redact.ts');
    assert.equal(readFileSync(redact, 'utf8'), 'export const redact = 1;\n');
    const ownerDocument = join(f.home, '.pi', 'agent', 'src', 'pi-owner-document.ts');
    assert.equal(readFileSync(ownerDocument, 'utf8'), 'export const ownerDocument = 1;\n');
    assert.equal(existsSync(join(target, '..', '..', 'src', 'redact.ts')), true);
    const store = openStore(f.dbPath);
    assert.equal(store.getConfig('pi.deployedAt'), '1700000000');
    assert.equal(store.getConfig('pi.extensionHash'), first.hash);
    store.close();

    writeFileSync(join(f.extension, 'index.ts'), 'export const version = 2;\n');
    const second = deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath, now: () => 1_700_000_010_000 });
    assert.notEqual(second.hash, first.hash);
    assert.equal(readFileSync(join(target, 'index.ts'), 'utf8'), 'export const version = 2;\n');
    assert.equal(existsSync(join(target, 'manifest.json')), true);
  });

  it('deploy with a symlinked extensions dir writes shared sources beside its real path and detects drift there', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-symlink-'));
    const f = fixture(root);
    const vaultExtensions = join(root, 'vault', 'pi-config', 'extensions');
    mkdirSync(vaultExtensions, { recursive: true });
    mkdirSync(join(f.home, '.pi', 'agent'), { recursive: true });
    symlinkSync(vaultExtensions, join(f.home, '.pi', 'agent', 'extensions'));

    deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath });

    const vaultSrc = join(root, 'vault', 'pi-config', 'src');
    assert.equal(readFileSync(join(vaultSrc, 'redact.ts'), 'utf8'), 'export const redact = 1;\n');
    assert.equal(readFileSync(join(vaultSrc, 'pi-owner-document.ts'), 'utf8'), 'export const ownerDocument = 1;\n');
    assert.equal(existsSync(join(f.home, '.pi', 'agent', 'src')), false);
    assert.equal(existsSync(join(root, 'vault', 'pi-config', '.qlb-pi-staging')), false);
    assert.equal(piExtensionDriftCheck({ home: f.home, appDir: f.appDir, dbPath: f.dbPath }).level, 'PASS');

    writeFileSync(join(vaultSrc, 'redact.ts'), 'export const redact = 1;\nchanged\n');
    assert.equal(piExtensionDriftCheck({ home: f.home, appDir: f.appDir, dbPath: f.dbPath }).level, 'FAIL');
  });

  it('returns FAIL instead of throwing when the extensions path cannot be resolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-drift-loop-'));
    const f = fixture(root);
    deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath });
    const extensions = join(f.home, '.pi', 'agent', 'extensions');
    rmSync(extensions, { recursive: true });
    symlinkSync('extensions', extensions);

    const check = piExtensionDriftCheck({ home: f.home, appDir: f.appDir, dbPath: f.dbPath });
    assert.equal(check.level, 'FAIL');
    assert.match(check.message, /ELOOP/);
  });

  it('falls back to the unresolved agent src directory while extensions is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-missing-extensions-'));
    const home = join(root, 'home');

    assert.equal(piSharedSrcDir(home), join(home, '.pi', 'agent', 'src'));
  });

  it('dry-run reports source, target, and hash without writing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-deploy-dry-'));
    const f = fixture(root);
    const output: string[] = [];
    const code = await runPiDeployCommand(['--dry-run', '--json'], context(f.home, f.dbPath, output), {
      deploy: deployPiExtension,
      appDirFor: () => f.appDir,
    });

    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output[0]), {
      source: join(f.appDir, 'release-fixture', 'extensions', 'qlb-pi'),
      target: join(f.home, '.pi', 'agent', 'extensions', 'qlb-pi'),
      hash: JSON.parse(output[0]).hash,
      dryRun: true,
    });
    assert.equal(existsSync(join(f.home, '.pi')), false);
    assert.equal(existsSync(f.dbPath), false);
  });

  it('reports extension drift after an installed file is edited', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-drift-'));
    const f = fixture(root);
    deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath });

    assert.equal(piExtensionDriftCheck({ home: f.home, appDir: f.appDir, dbPath: f.dbPath }).level, 'PASS');
    writeFileSync(join(f.home, '.pi', 'agent', 'extensions', 'qlb-pi', 'index.ts'), 'changed\n');
    assert.equal(piExtensionDriftCheck({ home: f.home, appDir: f.appDir, dbPath: f.dbPath }).level, 'FAIL');
    deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath });
    const redact = join(f.home, '.pi', 'agent', 'src', 'redact.ts');
    writeFileSync(redact, 'stale\n');
    assert.equal(piExtensionDriftCheck({ home: f.home, appDir: f.appDir, dbPath: f.dbPath }).level, 'FAIL');
    deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath });
    const ownerDocument = join(f.home, '.pi', 'agent', 'src', 'pi-owner-document.ts');
    writeFileSync(ownerDocument, 'stale\n');
    assert.equal(piExtensionDriftCheck({ home: f.home, appDir: f.appDir, dbPath: f.dbPath }).level, 'FAIL');
    deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath });
    rmSync(redact);
    assert.equal(piExtensionDriftCheck({ home: f.home, appDir: f.appDir, dbPath: f.dbPath }).level, 'FAIL');
    deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath });
    mkdirSync(join(f.home, '.pi', 'agent', 'extensions', '.qlb-pi-old.previous'));
    assert.equal(piExtensionDriftCheck({ home: f.home, appDir: f.appDir, dbPath: f.dbPath }).level, 'FAIL');
  });

  it('restores the old extension and redactor when publishing fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-restore-'));
    const f = fixture(root);
    deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath });
    const target = join(f.home, '.pi', 'agent', 'extensions', 'qlb-pi');
    const redact = join(f.home, '.pi', 'agent', 'src', 'redact.ts');
    writeFileSync(join(f.extension, 'index.ts'), 'export const version = 2;\n');
    writeFileSync(join(f.appDir, 'release-fixture', 'src', 'redact.ts'), 'export const redact = 2;\n');
    assert.throws(() => deployPiExtension({
      home: f.home,
      appDir: f.appDir,
      dbPath: f.dbPath,
      rename: (from, to) => {
        if (to === target && String(from).includes('.tmp')) throw new Error('simulated publish failure');
        renameSync(from, to);
      },
    }), /simulated publish failure/);
    assert.equal(readFileSync(join(target, 'index.ts'), 'utf8'), 'export const version = 1;\n');
    assert.equal(readFileSync(redact, 'utf8'), 'export const redact = 1;\n');
  });

  it('restores both previous files and preserves the record when redactor publication fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-redact-restore-'));
    const f = fixture(root);
    const first = deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath, now: () => 1_700_000_000_000 });
    const target = join(f.home, '.pi', 'agent', 'extensions', 'qlb-pi');
    const redact = piRedactTarget(f.home);
    writeFileSync(join(f.extension, 'index.ts'), 'export const version = 2;\n');
    writeFileSync(join(f.appDir, 'release-fixture', 'src', 'redact.ts'), 'export const redact = 2;\n');
    const output: string[] = [];

    const code = runPiDeployCommand([], context(f.home, f.dbPath, output), {
      deploy: (options) => deployPiExtension({
        ...options,
        rename: (from, to) => {
          if (to === redact && String(from).includes('.redact-') && String(from).includes('.tmp')) {
            throw new Error('simulated redact publish failure');
          }
          renameSync(from, to);
        },
      }),
      appDirFor: () => f.appDir,
    });

    assert.equal(code, 1);
    assert.equal(readFileSync(join(target, 'index.ts'), 'utf8'), 'export const version = 1;\n');
    assert.equal(readFileSync(redact, 'utf8'), 'export const redact = 1;\n');
    const store = openStore(f.dbPath);
    assert.equal(store.getConfig('pi.deployedAt'), '1700000000');
    assert.equal(store.getConfig('pi.extensionHash'), first.hash);
    store.close();
  });

  it('removes both new files when redactor publication fails on a first deploy', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-redact-first-'));
    const f = fixture(root);
    const target = join(f.home, '.pi', 'agent', 'extensions', 'qlb-pi');
    const redact = join(f.home, '.pi', 'agent', 'src', 'redact.ts');

    assert.throws(() => deployPiExtension({
      home: f.home,
      appDir: f.appDir,
      dbPath: f.dbPath,
      rename: (from, to) => {
        if (to === redact && String(from).includes('.redact-') && String(from).includes('.tmp')) {
          throw new Error('simulated redact publish failure');
        }
        renameSync(from, to);
      },
    }), /simulated redact publish failure/);

    assert.equal(existsSync(target), false);
    assert.equal(existsSync(redact), false);
    assert.equal(existsSync(f.dbPath), false);
  });

  it('sweeps legacy extension and redactor staging siblings before deploying', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-sweep-'));
    const f = fixture(root);
    const legacy = join(f.home, '.pi', 'agent', 'extensions', '.qlb-pi-old.previous');
    const legacyRedact = join(f.home, '.pi', 'agent', '.qlb-pi-staging', '.redact-x.tmp');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(join(f.home, '.pi', 'agent', '.qlb-pi-staging'), { recursive: true });
    writeFileSync(join(legacy, 'index.ts'), 'old\n');
    writeFileSync(legacyRedact, 'old\n');
    const foreign = join(f.home, '.pi', 'agent', 'extensions', '.redact-custom');
    writeFileSync(foreign, 'not ours\n');
    deployPiExtension({ home: f.home, appDir: f.appDir, dbPath: f.dbPath });
    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(legacyRedact), false);
    assert.equal(readFileSync(foreign, 'utf8'), 'not ours\n');
  });

  it('lists only Pi sessions that predate deployment and WARNs on malformed ps output', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-stale-'));
    const f = fixture(root);
    const store = openStore(f.dbPath);
    store.setConfig('pi.deployedAt', String(Math.floor(Date.parse('Sat Oct 25 12:00:00 2025') / 1_000)));
    store.setConfig('pi.anthropic.migratedAt', String(Math.floor(Date.parse('Sat Oct 25 11:58:00 2025') / 1_000)));
    store.close();

    const check = piStaleSessionsCheck({
      dbPath: f.dbPath,
      list: () => [
        '  101 Sat Oct 25 11:59:59 2025 /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
        '  102 Sat Oct 25 12:00:01 2025 /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
        '  104 Sat Oct 25 11:00:00 2025 pi',
        '  105 Sat Oct 25 11:00:00 2025 pip install foo',
        '  106 Sat Oct 25 11:00:00 2025 grep pi',
        '  103 Sat Oct 25 11:00:00 2025 node ordinary-app.js',
      ].join('\n'),
    });
    assert.equal(check.level, 'WARN');
    assert.deepEqual(check.detail, [
      { pid: 101, startedAt: 'Sat Oct 25 11:59:59 2025' },
      { pid: 104, startedAt: 'Sat Oct 25 11:00:00 2025' },
    ]);
    assert.doesNotMatch(check.message, /cli\.js|ordinary-app/);

    const msStore = openStore(f.dbPath);
    msStore.setConfig('pi.anthropic.migratedAt', String(Date.parse('Sat Oct 25 12:00:00 2025')));
    msStore.close();
    const msCheck = piStaleSessionsCheck({
      dbPath: f.dbPath,
      list: () => [
        '  201 Sat Oct 25 13:00:00 2025 pi',
        '  202 Sat Oct 25 11:59:00 2025 pi',
      ].join('\n'),
    });
    assert.equal(msCheck.level, 'WARN');
    assert.deepEqual(msCheck.detail, [{ pid: 202, startedAt: 'Sat Oct 25 11:59:00 2025' }]);

    const malformed = piStaleSessionsCheck({ dbPath: f.dbPath, list: () => 'not a ps record' });
    assert.equal(malformed.level, 'WARN');
    assert.match(malformed.message, /unknown/);
  });
});
