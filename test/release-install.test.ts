import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { installRelease } from '../src/release';
import { runReleaseCommand } from '../src/commands/release';
import { releaseCurrentCheck } from '../src/checks/release-current';
import type { CommandContext } from '../src/registry';

function sourceBuild(dir: string): string {
  const source = join(dir, 'source');
  mkdirSync(join(source, 'dist'), { recursive: true });
  writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("fixture build")\n');
  writeFileSync(join(source, 'package.json'), '{"name":"fixture"}\n');
  return source;
}

describe('release install (AC45)', () => {
  it('backs up an existing database, publishes the build, and atomically repoints current', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-install-'));
    const sourceDir = sourceBuild(root);
    const qlbHome = join(root, 'qlb-home');
    const appDir = join(qlbHome, 'app');
    const dbPath = join(qlbHome, 'qlb.db');
    mkdirSync(qlbHome, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE rows (id INTEGER); INSERT INTO rows VALUES (1)');
    db.close();

    const installed = await installRelease({ sourceDir, appDir, sha: 'test-sha', dbPath });

    assert.equal(installed.releaseDir, join(appDir, 'test-sha'));
    assert.ok(existsSync(join(installed.releaseDir, 'dist', 'cli.js')));
    assert.equal(readFileSync(join(installed.releaseDir, 'dist', 'cli.js'), 'utf8'), 'console.log("fixture build")\n');
    assert.ok(lstatSync(installed.currentPath).isSymbolicLink());
    assert.equal(readlinkSync(installed.currentPath), 'test-sha');
    assert.ok(installed.backupPath && existsSync(installed.backupPath));
    const restored = new DatabaseSync(installed.backupPath!, { readOnly: true });
    try {
      assert.equal((restored.prepare('SELECT count(*) AS n FROM rows').get() as { n: number }).n, 1);
    } finally {
      restored.close();
    }
  });

  it('uses the disposable QLB_HOME when command execution is in test mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-command-'));
    const sourceDir = sourceBuild(root);
    const configuredDbPath = join(root, 'other-home', 'qlb.db');
    mkdirSync(join(root, 'other-home'), { recursive: true });
    const configuredDb = new DatabaseSync(configuredDbPath);
    configuredDb.exec('CREATE TABLE should_not_be_backed_up (id INTEGER)');
    configuredDb.close();
    const output: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(`ERR:${line}`),
      env: { QLB_TEST_MODE: '1', QLB_HOME: join(root, 'qlb-home') },
      config: { dbPath: configuredDbPath } as CommandContext['config'],
      loadConfig: () => { throw new Error('not used'); },
      home: join(root, 'other-home'),
      registerSecret: () => {},
    };

    const code = await runReleaseCommand(['install', '--sha', 'command-sha'], ctx, {
      sourceDir,
      install: installRelease,
      shaForSource: () => 'unused',
    });

    assert.equal(code, 0);
    assert.ok(existsSync(join(root, 'qlb-home', 'app', 'command-sha', 'dist', 'cli.js')));
    assert.equal(existsSync(join(root, 'other-home', '.qlb', 'app', 'command-sha')), false);
    assert.equal(existsSync(join(root, 'other-home', 'backups')), false);
    assert.match(output[0], /command-sha/);
  });

  it('warns when the deployed current release differs from the lifecycle release SHA', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-current-'));
    mkdirSync(join(root, 'old-sha'), { recursive: true });
    require('node:fs').symlinkSync('old-sha', join(root, 'current'));

    const result = releaseCurrentCheck({ appDir: root, lifecycleReleaseSha: 'new-sha' });

    assert.equal(result.level, 'WARN');
    assert.match(result.message, /new-sha/);
    assert.match(result.message, /old-sha/);
  });
});
