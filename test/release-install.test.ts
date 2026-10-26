import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { installRelease as installReleaseForPlatform, readReleaseManifest, releaseDigest } from '../src/release';
import { runReleaseCommand } from '../src/commands/release';
import { releaseCurrentCheck } from '../src/checks/release-current';
import type { CommandContext } from '../src/registry';
import { openStore } from '../src/store';

const QLB_HELPER_SIGNING = {
  authority: 'QLB Keychain Helper', binaryHash: 'a'.repeat(40), identityHash: 'b'.repeat(40),
};
const validHelperVerifier = { verifyHelperSigning: () => QLB_HELPER_SIGNING };

// Fixture releases do not model macOS packaging unless a test opts in explicitly.
const installRelease = (options: Parameters<typeof installReleaseForPlatform>[0]) =>
  installReleaseForPlatform({ platform: 'linux', ...options });

function shippedBuildDigest(source: string): string {
  const paths: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const path = absolute.slice(source.length + 1);
      if (path === join('dist', '.build-sha')) continue;
      paths.push(path);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  for (const output of ['dist', 'extensions']) {
    const absolute = join(source, output);
    if (existsSync(absolute)) visit(absolute);
  }
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const stat = lstatSync(join(source, path));
    hash.update(`${path}\0${stat.isDirectory() ? 'd' : 'f'}\0`);
    if (!stat.isDirectory()) hash.update(readFileSync(join(source, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function buildStamp(sha: string, dirty = false, buildDigest?: string): string {
  return `${JSON.stringify({ sha, dirty, ...(buildDigest ? { buildDigest } : {}) })}\n`;
}

function sourceBuild(dir: string, sha = 'test-sha', dependencies: Record<string, string> = {}): string {
  const source = join(dir, 'source');
  mkdirSync(join(source, 'dist'), { recursive: true });
  writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("fixture build")\n');
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({ name: 'fixture', dependencies })}\n`);
  writeFileSync(join(source, 'dist', '.build-sha'), buildStamp(sha, false, shippedBuildDigest(source)));
  return source;
}

function compiledSource(dir: string, sha: string): string {
  const repo = join(__dirname, '..', '..');
  const source = join(dir, 'source');
  cpSync(join(repo, 'dist'), join(source, 'dist'), { recursive: true });
  cpSync(join(repo, 'package.json'), join(source, 'package.json'));
  cpSync(join(repo, 'extensions'), join(source, 'extensions'), { recursive: true });
  mkdirSync(join(source, 'src'), { recursive: true });
  cpSync(join(repo, 'src', 'redact.ts'), join(source, 'src', 'redact.ts'));
  cpSync(join(repo, 'node_modules', 'yaml'), join(source, 'node_modules', 'yaml'), { recursive: true });
  writeFileSync(join(source, 'dist', '.build-sha'), buildStamp(sha, false, shippedBuildDigest(source)));
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

  it('ships a present Keychain helper byte-for-byte, executable, and attested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-'));
    const sourceDir = sourceBuild(root, 'helper-sha');
    const sourceHelper = join(sourceDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
    mkdirSync(join(sourceDir, 'native', 'keychain-helper', 'build'), { recursive: true });
    writeFileSync(sourceHelper, 'plain fake helper bytes\n');

    const installed = await installRelease({
      sourceDir, appDir: join(root, 'app-with-helper'), sha: 'helper-sha', dbPath: join(root, 'db'), ...validHelperVerifier,
    });
    const installedHelper = join(installed.releaseDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
    assert.deepEqual(readFileSync(installedHelper), readFileSync(sourceHelper));
    assert.equal(statSync(installedHelper).mode & 0o777, 0o755);
    const helperDigest = readReleaseManifest(installed.releaseDir)!.digest;

    unlinkSync(sourceHelper);
    const withoutHelper = await installRelease({
      sourceDir, appDir: join(root, 'app-without-helper'), sha: 'helper-sha', dbPath: join(root, 'db'), platform: 'linux', ...validHelperVerifier,
    });
    assert.equal(existsSync(join(withoutHelper.releaseDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper')), false);
    assert.notEqual(readReleaseManifest(withoutHelper.releaseDir)!.digest, helperDigest);
  });

  it('refuses a missing Keychain helper on darwin before publishing a release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-missing-'));
    const sourceDir = sourceBuild(root, 'missing-helper-sha');
    const appDir = join(root, 'app');

    await assert.rejects(
      installRelease({ sourceDir, appDir, sha: 'missing-helper-sha', dbPath: join(root, 'db'), platform: 'darwin' }),
      /helper missing; run npm run build:helper/,
    );
    assert.equal(existsSync(join(appDir, 'missing-helper-sha')), false);
  });

  it('refuses an unsigned present Keychain helper before publishing a release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-unsigned-'));
    const sourceDir = sourceBuild(root, 'unsigned-helper-sha');
    const helper = join(sourceDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, 'unsigned fake helper bytes\n');
    const appDir = join(root, 'app');

    await assert.rejects(
      installRelease({ sourceDir, appDir, sha: 'unsigned-helper-sha', dbPath: join(root, 'db') }),
      /helper not signed; run npm run build:helper/,
    );
    assert.equal(existsSync(join(appDir, 'unsigned-helper-sha')), false);
  });

  it('refuses a present helper signed by another authority before publishing a release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-authority-'));
    const sourceDir = sourceBuild(root, 'foreign-helper-sha');
    const helper = join(sourceDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, 'foreign fake helper bytes\n');
    const appDir = join(root, 'app');
    const foreignHelperVerifier = {
      verifyHelperSigning: () => ({ ...QLB_HELPER_SIGNING, authority: 'Other Signing Identity' }),
    };

    await assert.rejects(
      installRelease({
        sourceDir, appDir, sha: 'foreign-helper-sha', dbPath: join(root, 'db'), ...foreignHelperVerifier,
      }),
      /helper signed by Other Signing Identity, expected QLB Keychain Helper; run npm run build:helper/,
    );
    assert.equal(existsSync(join(appDir, 'foreign-helper-sha')), false);
  });

  it('refuses a helper that does not match a recorded leaf pin before publishing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-pin-'));
    const sourceDir = sourceBuild(root, 'pinned-helper-sha');
    const helper = join(sourceDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, 'foreign fake helper bytes\n');
    const appDir = join(root, 'app');
    let inspected = false;

    await assert.rejects(
      installRelease({
        sourceDir, appDir, sha: 'pinned-helper-sha', dbPath: join(root, 'db'),
        helperConfigReader: () => QLB_HELPER_SIGNING.identityHash,
        verifyHelperIdentity: () => ({ trusted: false, reason: 'pinned leaf certificate did not verify' }),
        verifyHelperSigning: () => { inspected = true; return QLB_HELPER_SIGNING; },
      }),
      /helper pinned leaf certificate did not verify; run npm run build:helper or qlb keychain check-launchd/,
    );
    assert.equal(inspected, true);
    assert.equal(existsSync(join(appDir, 'pinned-helper-sha')), false);
  });

  it('records the verified helper leaf pin on a fresh release install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-pin-fresh-'));
    const sourceDir = sourceBuild(root, 'pin-fresh-sha');
    const helper = join(sourceDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
    const dbPath = join(root, 'qlb.db');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, 'fake helper bytes\n');

    await installRelease({
      sourceDir, appDir: join(root, 'app'), sha: 'pin-fresh-sha', dbPath, ...validHelperVerifier,
    });

    const store = openStore(dbPath);
    try {
      assert.equal(store.getConfig('keychain.helperCheckIdentityHash'), QLB_HELPER_SIGNING.identityHash);
    } finally { store.close(); }
  });

  it('keeps an equal recorded helper pin unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-pin-equal-'));
    const sourceDir = sourceBuild(root, 'pin-equal-sha');
    const helper = join(sourceDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
    const dbPath = join(root, 'qlb.db');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, 'fake helper bytes\n');
    const before = openStore(dbPath);
    before.setConfig('keychain.helperCheckIdentityHash', QLB_HELPER_SIGNING.identityHash);
    before.close();

    await installRelease({
      sourceDir, appDir: join(root, 'app'), sha: 'pin-equal-sha', dbPath,
      ...validHelperVerifier, verifyHelperIdentity: () => ({ trusted: true }),
    });

    const after = openStore(dbPath);
    try {
      assert.equal(after.getConfig('keychain.helperCheckIdentityHash'), QLB_HELPER_SIGNING.identityHash);
    } finally { after.close(); }
  });

  it('refuses a different recorded helper pin with exit 3 and leaves it unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-pin-changed-'));
    const sourceDir = sourceBuild(root, 'pin-changed-sha');
    const helper = join(sourceDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
    const dbPath = join(root, 'qlb.db');
    const recordedPin = 'c'.repeat(40);
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, 'fake helper bytes\n');
    const before = openStore(dbPath);
    before.setConfig('keychain.helperCheckIdentityHash', recordedPin);
    before.close();
    const errors: string[] = [];
    const ctx: CommandContext = {
      stdout: () => {}, stderr: (line) => errors.push(line), env: { QLB_TEST_MODE: '1', QLB_HOME: root },
      config: { dbPath } as CommandContext['config'], loadConfig: () => { throw new Error('not used'); }, home: root,
      registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    };

    const code = await runReleaseCommand(['install', '--sha', 'pin-changed-sha'], ctx, {
      sourceDir,
      install: (options) => installRelease({ ...options, ...validHelperVerifier }),
      shaForSource: () => 'pin-changed-sha',
    });

    assert.equal(code, 3);
    assert.deepEqual(errors, ['qlb release: helper-identity-changed']);
    const after = openStore(dbPath);
    try {
      assert.equal(after.getConfig('keychain.helperCheckIdentityHash'), recordedPin);
    } finally { after.close(); }
    assert.equal(existsSync(join(root, 'app', 'pin-changed-sha')), false);
  });

  it('refuses an unreadable helper leaf hash without recording a pin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-pin-unreadable-'));
    const sourceDir = sourceBuild(root, 'pin-unreadable-sha');
    const helper = join(sourceDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
    const dbPath = join(root, 'qlb.db');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, 'fake helper bytes\n');
    const store = openStore(dbPath);
    store.close();

    await assert.rejects(
      installRelease({
        sourceDir, appDir: join(root, 'app'), sha: 'pin-unreadable-sha', dbPath,
        verifyHelperSigning: () => ({ ...QLB_HELPER_SIGNING, identityHash: '' }),
      }),
      /helper identity hash is unavailable/,
    );

    const after = openStore(dbPath);
    try {
      assert.equal(after.getConfig('keychain.helperCheckIdentityHash'), null);
    } finally { after.close(); }
    assert.equal(existsSync(join(root, 'app', 'pin-unreadable-sha')), false);
  });

  it('refuses a helper reached through a symlinked ancestor outside the checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-symlink-'));
    const sourceDir = sourceBuild(root, 'symlink-helper-sha');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'qlb-keychain-helper'), 'outside fake helper bytes\n');
    mkdirSync(join(sourceDir, 'native', 'keychain-helper'), { recursive: true });
    symlinkSync(outside, join(sourceDir, 'native', 'keychain-helper', 'build'));
    const appDir = join(root, 'app');

    await assert.rejects(
      installRelease({ sourceDir, appDir, sha: 'symlink-helper-sha', dbPath: join(root, 'db'), ...validHelperVerifier }),
      /symlink .*native\/keychain-helper\/build\/qlb-keychain-helper resolves to .*outside/,
    );
    assert.equal(existsSync(join(appDir, 'symlink-helper-sha')), false);
  });

  it('detects an altered installed Keychain helper through the release digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-helper-altered-'));
    const sourceDir = sourceBuild(root, 'helper-altered-sha');
    const sourceHelper = join(sourceDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper');
    mkdirSync(join(sourceDir, 'native', 'keychain-helper', 'build'), { recursive: true });
    writeFileSync(sourceHelper, 'plain fake helper bytes\n');
    const appDir = join(root, 'app');
    const installed = await installRelease({
      sourceDir, appDir, sha: 'helper-altered-sha', dbPath: join(root, 'db'), ...validHelperVerifier,
    });
    writeFileSync(join(installed.releaseDir, 'native', 'keychain-helper', 'build', 'qlb-keychain-helper'), 'altered fake helper bytes\n');

    const result = releaseCurrentCheck({ appDir, lifecycleReleaseSha: 'helper-altered-sha' });
    assert.equal(result.level, 'WARN');
    assert.match(result.message, /bytes/);
  });

  it('ignores Keychain helper build output', () => {
    const ignore = readFileSync(join(__dirname, '..', '..', '.gitignore'), 'utf8');
    assert.match(ignore, /^native\/keychain-helper\/build\/$/m);
  });

  it('copies production dependencies so an installed CLI starts without the checkout node_modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-cli-'));
    const sha = 'cli-fixture-sha';
    const sourceDir = compiledSource(root, sha);
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
    writeFileSync(join(sourceDir, 'dist', '.build-sha'), buildStamp('old-sha', false, shippedBuildDigest(sourceDir)));
    await assert.rejects(installRelease({ sourceDir, appDir, sha: 'new-sha', dbPath: join(root, 'qlb.db') }), /stamp/);
    assert.equal(readlinkSync(join(appDir, 'current')), 'previous');
    writeFileSync(join(sourceDir, 'dist', '.build-sha'), buildStamp('new-sha', false, shippedBuildDigest(sourceDir)));
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
      loadConfig: () => { throw new Error('not used'); }, home: join(root, 'other-home'), registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
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

  it('records whether the build tree was dirty when it was stamped', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-build-stamp-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    copyFileSync(join(__dirname, '..', '..', 'scripts', 'write-build-stamp.cjs'), join(root, 'scripts', 'write-build-stamp.cjs'));
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'clean\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });

    execFileSync(process.execPath, [join(root, 'scripts', 'write-build-stamp.cjs')]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'dist', '.build-sha'), 'utf8')), {
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: false,
      buildDigest: shippedBuildDigest(root),
    });
    writeFileSync(join(root, 'tracked.txt'), 'dirty\n');
    execFileSync(process.execPath, [join(root, 'scripts', 'write-build-stamp.cjs')]);
    assert.equal(JSON.parse(readFileSync(join(root, 'dist', '.build-sha'), 'utf8')).dirty, true);
  });

  it('refuses dirty or SHA-mismatched build stamps with exit 3, including explicit --sha', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-integrity-'));
    const sourceDir = sourceBuild(root, 'clean-sha');
    const errors: string[] = [];
    const ctx: CommandContext = {
      stdout: () => {}, stderr: (line) => errors.push(line), env: { QLB_TEST_MODE: '1', QLB_HOME: join(root, 'home') },
      config: { dbPath: join(root, 'db') } as CommandContext['config'],
      loadConfig: () => { throw new Error('not used'); }, home: root, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    };
    writeFileSync(join(sourceDir, 'dist', '.build-sha'), buildStamp('clean-sha', true, shippedBuildDigest(sourceDir)));
    assert.equal(await runReleaseCommand(['install', '--sha', 'clean-sha'], ctx, {
      sourceDir, install: installRelease, shaForSource: () => 'clean-sha',
    }), 3);
    assert.match(errors.pop()!, /dirty source tree/);
    writeFileSync(join(sourceDir, 'dist', '.build-sha'), buildStamp('other-sha', false, shippedBuildDigest(sourceDir)));
    assert.equal(await runReleaseCommand(['install', '--sha', 'clean-sha'], ctx, {
      sourceDir, install: installRelease, shaForSource: () => 'clean-sha',
    }), 3);
    assert.match(errors.pop()!, /does not match requested release SHA/);
  });

  it('refuses to reuse a release SHA when its bytes differ from the build being installed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-reuse-'));
    const sourceDir = sourceBuild(root, 'same-sha');
    const appDir = join(root, 'app');
    await installRelease({ sourceDir, appDir, sha: 'same-sha', dbPath: join(root, 'db') });
    writeFileSync(join(sourceDir, 'dist', 'cli.js'), 'console.log("different build")\n');
    await assert.rejects(installRelease({ sourceDir, appDir, sha: 'same-sha', dbPath: join(root, 'db') }), /build output digest/);
  });

  it('refuses a build output changed after it was stamped, while an untouched build installs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-output-digest-'));
    const sourceDir = sourceBuild(root, 'digest-sha');
    const appDir = join(root, 'app');
    await installRelease({ sourceDir, appDir, sha: 'digest-sha', dbPath: join(root, 'db') });

    const changedSource = sourceBuild(root, 'changed-sha');
    writeFileSync(join(changedSource, 'dist', 'cli.js'), 'console.log("changed after stamp")\n');
    const errors: string[] = [];
    const ctx: CommandContext = {
      stdout: () => {}, stderr: (line) => errors.push(line), env: { QLB_TEST_MODE: '1', QLB_HOME: root },
      config: { dbPath: join(root, 'db') } as CommandContext['config'],
      loadConfig: () => { throw new Error('not used'); }, home: root, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    };
    assert.equal(await runReleaseCommand(['install', '--sha', 'changed-sha'], ctx, {
      sourceDir: changedSource, install: installRelease, shaForSource: () => 'changed-sha',
    }), 3);
    assert.match(errors.pop()!, /build output digest.*differs/);
    assert.equal(existsSync(join(appDir, 'changed-sha')), false);
  });

  it('refuses symlinks that leave a shipped source root or package directory, and detects cycles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-unsafe-symlink-'));
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.js'), 'outside\n');

    const sourceWithExternalFile = sourceBuild(join(root, 'external-file'), 'external-file-sha');
    symlinkSync(join(outside, 'secret.js'), join(sourceWithExternalFile, 'dist', 'outside.js'));
    await assert.rejects(
      installRelease({ sourceDir: sourceWithExternalFile, appDir: join(root, 'app-file'), sha: 'external-file-sha', dbPath: join(root, 'db-file') }),
      /outside\.js.*secret\.js/,
    );

    const sourceWithExternalPackage = sourceBuild(join(root, 'external-package'), 'external-package-sha', { linked: '1.0.0' });
    const externalPackage = join(outside, 'linked');
    mkdirSync(externalPackage);
    writeFileSync(join(externalPackage, 'package.json'), JSON.stringify({ name: 'linked', version: '1.0.0' }));
    mkdirSync(join(sourceWithExternalPackage, 'node_modules'), { recursive: true });
    symlinkSync(externalPackage, join(sourceWithExternalPackage, 'node_modules', 'linked'));
    await assert.rejects(
      installRelease({ sourceDir: sourceWithExternalPackage, appDir: join(root, 'app-package'), sha: 'external-package-sha', dbPath: join(root, 'db-package') }),
      /node_modules.*linked.*outside/,
    );

    const sourceWithCycle = sourceBuild(join(root, 'cycle'), 'cycle-sha');
    symlinkSync('.', join(sourceWithCycle, 'dist', 'cycle'));
    await assert.rejects(
      installRelease({ sourceDir: sourceWithCycle, appDir: join(root, 'app-cycle'), sha: 'cycle-sha', dbPath: join(root, 'db-cycle') }),
      /cyclic directory symlink.*cycle/,
    );
  });

  it('ships Pi check sources so doctor from an installed release emits Pi check rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-doctor-'));
    const sha = 'doctor-fixture-sha';
    const sourceDir = compiledSource(root, sha);
    const appDir = join(root, 'qlb-home', 'app');
    const installed = await installRelease({ sourceDir, appDir, sha, dbPath: join(root, 'qlb-home', 'qlb.db') });
    const home = join(root, 'home');
    // In test mode QLB resolves Pi paths under QLB_HOME (R0e), not HOME.
    cpSync(join(installed.releaseDir, 'extensions', 'qlb-pi'), join(root, 'qlb-home', '.pi', 'agent', 'extensions', 'qlb-pi'), { recursive: true });
    const piRoot = join(root, 'pi');
    mkdirSync(piRoot, { recursive: true });
    writeFileSync(join(piRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: 'fixture' }));
    const result = spawnSync(process.execPath, [join(installed.releaseDir, 'dist', 'cli.js'), 'doctor', '--json'], {
      env: { ...process.env, HOME: home, QLB_TEST_MODE: '1', QLB_HOME: join(root, 'qlb-home'), QLB_PI_PACKAGE_ROOT: piRoot }, encoding: 'utf8',
    });
    const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; message: string }> };
    assert.ok(report.checks.some((check) => check.name === 'pi:extension' && !/skipping Pi checks/.test(check.message)));
    assert.ok(report.checks.some((check) => check.name.startsWith('pi:seam:')));
  });

  it('dereferences package symlinks and includes their file bytes in the release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-symlink-'));
    const sourceDir = sourceBuild(root, 'link-sha', { linked: '1.0.0' });
    const pkg = join(sourceDir, 'node_modules', 'linked');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'linked', version: '1.0.0' }));
    writeFileSync(join(pkg, 'real.js'), 'linked bytes\n');
    symlinkSync('real.js', join(pkg, 'alias.js'));
    writeFileSync(join(sourceDir, 'dist', '.build-sha'), buildStamp('link-sha', false, shippedBuildDigest(sourceDir)));

    const installed = await installRelease({ sourceDir, appDir: join(root, 'app'), sha: 'link-sha', dbPath: join(root, 'db') });
    const alias = join(installed.releaseDir, 'node_modules', 'linked', 'alias.js');
    assert.equal(lstatSync(alias).isSymbolicLink(), false);
    assert.equal(readFileSync(alias, 'utf8'), 'linked bytes\n');
    const manifest = readReleaseManifest(installed.releaseDir)!;
    assert.equal(manifest.digest, releaseDigest(installed.releaseDir));
    writeFileSync(alias, 'altered linked bytes\n');
    assert.notEqual(manifest.digest, releaseDigest(installed.releaseDir));
  });

  it('resolves nested and present optional dependencies from their requiring package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-nested-'));
    const sourceDir = sourceBuild(root, 'nested-sha', { parent: '1.0.0' });
    const parent = join(sourceDir, 'node_modules', 'parent');
    const nested = join(parent, 'node_modules');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(parent, 'package.json'), JSON.stringify({
      name: 'parent', version: '1.0.0', dependencies: { child: '1.0.0' }, optionalDependencies: { optional: '1.0.0' },
    }));
    for (const [name, contents] of [['child', 'nested child'], ['optional', 'optional child']] as const) {
      mkdirSync(join(nested, name), { recursive: true });
      writeFileSync(join(nested, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      writeFileSync(join(nested, name, 'index.js'), contents);
    }
    writeFileSync(join(sourceDir, 'dist', '.build-sha'), buildStamp('nested-sha', false, shippedBuildDigest(sourceDir)));

    const installed = await installRelease({ sourceDir, appDir: join(root, 'app'), sha: 'nested-sha', dbPath: join(root, 'db') });
    assert.equal(readFileSync(join(installed.releaseDir, 'node_modules', 'parent', 'node_modules', 'child', 'index.js'), 'utf8'), 'nested child');
    assert.equal(readFileSync(join(installed.releaseDir, 'node_modules', 'parent', 'node_modules', 'optional', 'index.js'), 'utf8'), 'optional child');
  });

  it('copies aliased runtime packages to each Node resolution location', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-aliased-dependency-'));
    const sourceDir = sourceBuild(root, 'aliased-sha', { a: '1.0.0', x: '1.0.0' });
    const nestedX = join(sourceDir, 'node_modules', 'a', 'node_modules', 'x');
    mkdirSync(nestedX, { recursive: true });
    writeFileSync(join(sourceDir, 'node_modules', 'a', 'package.json'), JSON.stringify({
      name: 'a', version: '1.0.0', dependencies: { x: '1.0.0' },
    }));
    writeFileSync(join(nestedX, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    writeFileSync(join(nestedX, 'index.js'), 'module.exports = "nested x";\n');
    symlinkSync(join('a', 'node_modules', 'x'), join(sourceDir, 'node_modules', 'x'));
    writeFileSync(join(sourceDir, 'dist', 'cli.js'), 'console.log(require("x"));\n');
    writeFileSync(join(sourceDir, 'dist', '.build-sha'), buildStamp('aliased-sha', false, shippedBuildDigest(sourceDir)));

    const installed = await installRelease({ sourceDir, appDir: join(root, 'app'), sha: 'aliased-sha', dbPath: join(root, 'db') });
    assert.ok(existsSync(join(installed.releaseDir, 'node_modules', 'x', 'index.js')));
    assert.ok(existsSync(join(installed.releaseDir, 'node_modules', 'a', 'node_modules', 'x', 'index.js')));
    const output = execFileSync(process.execPath, [join(installed.releaseDir, 'dist', 'cli.js')], {
      cwd: installed.releaseDir,
      env: { ...process.env, HOME: join(root, 'home'), QLB_TEST_MODE: '1', QLB_HOME: join(root, 'qlb-home') },
      encoding: 'utf8',
    });
    assert.equal(output, 'nested x\n');
  });

  it('rejects dependency names that can escape node_modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-release-dependency-name-'));
    const sourceDir = sourceBuild(root, 'name-sha', { '../outside': '1.0.0' });
    await assert.rejects(
      installRelease({ sourceDir, appDir: join(root, 'app'), sha: 'name-sha', dbPath: join(root, 'db') }),
      /dependency name.*invalid/,
    );
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
