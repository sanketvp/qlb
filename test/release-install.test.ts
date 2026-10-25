import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { installRelease, readReleaseManifest } from '../src/release';
import { runReleaseCommand } from '../src/commands/release';
import { releaseCurrentCheck } from '../src/checks/release-current';
import type { CommandContext } from '../src/registry';

function sourceBuild(dir: string, sha = 'test-sha', dependencies: Record<string, string> = {}): string {
  const source = join(dir, 'source');
  mkdirSync(join(source, 'dist'), { recursive: true });
  writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("fixture build")\n');
  writeFileSync(join(source, 'dist', '.build-sha'), `${sha}\n`);
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({ name: 'fixture', dependencies })}\n`);
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
    assert.ok(readReleaseManifest(installed.releaseDir));
    const restored = new DatabaseSync(installed.backupPath!, { readOnly: true });
    try {
      assert.equal((restored.prepare('SELECT count(*) AS n FROM rows').get() as { n: number }).n, 1);
    } finally {
      restored.close();
    }
  });

  it('copies production dependencies so an installed CLI starts without the checkout node_modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-cli-'));
    const sourceDir = join(__dirname, '..', '..');
    const sha = readFileSync(join(sourceDir, 'dist', '.build-sha'), 'utf8').trim();
    const appDir = join(root, 'qlb-home', 'app');
    const installed = await installRelease({ sourceDir, appDir, sha, dbPath: join(root, 'qlb-home', 'qlb.db') });

    const output = execFileSync(process.execPath, [join(installed.releaseDir, 'dist', 'cli.js'), '--list-commands', '--json'], {
      cwd: installed.releaseDir,
      env: { ...process.env, HOME: join(root, 'home'), QLB_TEST_MODE: '1', QLB_HOME: join(root, 'qlb-home') },
      encoding: 'utf8',
    });
    assert.match(output, /"release"/);
  });

  it('refuses a missing or stale build stamp before replacing current', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-stamp-'));
    const sourceDir = sourceBuild(root, 'old-sha');
    const appDir = join(root, 'app');
    mkdirSync(join(appDir, 'previous'), { recursive: true });
    symlinkSync('previous', join(appDir, 'current'));

    unlinkSync(join(sourceDir, 'dist', '.build-sha'));
    await assert.rejects(installRelease({ sourceDir, appDir, sha: 'new-sha', dbPath: join(root, 'qlb.db') }), /stamp/);
    assert.equal(readlinkSync(join(appDir, 'current')), 'previous');
    writeFileSync(join(sourceDir, 'dist', '.build-sha'), 'old-sha\n');
    await assert.rejects(installRelease({ sourceDir, appDir, sha: 'new-sha', dbPath: join(root, 'qlb.db') }), /stamp/);
    assert.equal(readlinkSync(join(appDir, 'current')), 'previous');
    writeFileSync(join(sourceDir, 'dist', '.build-sha'), 'new-sha\n');
    await installRelease({ sourceDir, appDir, sha: 'new-sha', dbPath: join(root, 'qlb.db') });
    assert.equal(readlinkSync(join(appDir, 'current')), 'new-sha');
  });

  it('leaves current unchanged when a production dependency cannot be copied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-deps-'));
    const sourceDir = sourceBuild(root, 'new-sha', { yaml: '2.9.1' });
    const appDir = join(root, 'app');
    mkdirSync(join(appDir, 'previous'), { recursive: true });
    symlinkSync('previous', join(appDir, 'current'));

    await assert.rejects(installRelease({ sourceDir, appDir, sha: 'new-sha', dbPath: join(root, 'qlb.db') }), /runtime dependency yaml/);
    assert.equal(readlinkSync(join(appDir, 'current')), 'previous');
    assert.equal(existsSync(join(appDir, 'new-sha')), false);
  });

  it('uses the disposable QLB_HOME when command execution is in test mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-command-'));
    const sourceDir = sourceBuild(root, 'command-sha');
    const configuredDbPath = join(root, 'other-home', 'qlb.db');
    mkdirSync(join(root, 'other-home'), { recursive: true });
    const configuredDb = new DatabaseSync(configuredDbPath);
    configuredDb.exec('CREATE TABLE should_not_be_backed_up (id INTEGER)');
    configuredDb.close();
    const output: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => output.push(line), stderr: (line) => output.push(`ERR:${line}`),
      env: { QLB_TEST_MODE: '1', QLB_HOME: join(root, 'qlb-home') },
      config: { dbPath: configuredDbPath } as CommandContext['config'],
      loadConfig: () => { throw new Error('not used'); }, home: join(root, 'other-home'), registerSecret: () => {},
    };

    const code = await runReleaseCommand(['install', '--sha', 'command-sha'], ctx, {
      sourceDir, install: installRelease, shaForSource: () => 'unused',
    });

    assert.equal(code, 0);
    assert.ok(existsSync(join(root, 'qlb-home', 'app', 'command-sha', 'dist', 'cli.js')));
    assert.equal(existsSync(join(root, 'other-home', '.qlb', 'app', 'command-sha')), false);
    assert.equal(existsSync(join(root, 'other-home', 'backups')), false);
    assert.match(output[0], /command-sha/);
  });

  it('warns when the installed release digest is altered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-current-'));
    const sourceDir = sourceBuild(root, 'current-sha');
    const appDir = join(root, 'app');
    await installRelease({ sourceDir, appDir, sha: 'current-sha', dbPath: join(root, 'qlb.db') });
    const lifecycleMismatch = releaseCurrentCheck({
      appDir, lifecycleReleaseSha: 'current-sha', lifecycleReleaseDigest: '0'.repeat(64),
    });
    assert.equal(lifecycleMismatch.level, 'WARN');
    assert.match(lifecycleMismatch.message, /digest/);
    writeFileSync(join(appDir, 'current-sha', 'dist', 'cli.js'), 'altered\n');

    const result = releaseCurrentCheck({ appDir, lifecycleReleaseSha: 'current-sha' });
    assert.equal(result.level, 'WARN');
    assert.match(result.message, /bytes/);
  });
});
