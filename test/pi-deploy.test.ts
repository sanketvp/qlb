import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runPiDeployCommand } from '../src/commands/pi-deploy';
import { piExtensionDriftCheck } from '../src/checks/pi-extension-drift';
import { piStaleSessionsCheck } from '../src/checks/pi-stale-sessions';
import { deployPiExtension } from '../src/pi-deploy';
import { openStore } from '../src/store';
import type { CommandContext } from '../src/registry';

function fixture(root: string): { home: string; appDir: string; dbPath: string; extension: string } {
  const home = join(root, 'home');
  const appDir = join(home, 'app');
  const release = join(appDir, 'release-fixture');
  const extension = join(release, 'extensions', 'qlb-pi');
  mkdirSync(extension, { recursive: true });
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
        '  103 Sat Oct 25 11:00:00 2025 node ordinary-app.js',
      ].join('\n'),
    });
    assert.equal(check.level, 'WARN');
    assert.deepEqual(check.detail, [{ pid: 101, startedAt: 'Sat Oct 25 11:59:59 2025' }]);
    assert.doesNotMatch(check.message, /cli\.js|ordinary-app/);

    const malformed = piStaleSessionsCheck({ dbPath: f.dbPath, list: () => 'not a ps record' });
    assert.equal(malformed.level, 'WARN');
    assert.match(malformed.message, /unknown/);
  });
});
