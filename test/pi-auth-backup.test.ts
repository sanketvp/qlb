import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  legacyPiAuthBackupPath,
  piAuthBackupPath,
  readPiAuthBackup,
  removePiAuthBackup,
  restorePiAuthEntry,
  writePiAuthBackup,
} from '../src/pi-auth-backup';

const testHome = mkdtempSync(join(tmpdir(), 'qlb-pi-auth-backup-'));
process.env.QLB_TEST_MODE = '1';
process.env.QLB_HOME = testHome;
process.env.HOME = testHome;
after(() => rmSync(testHome, { recursive: true, force: true }));

function authPath(name: string): string {
  const dir = mkdtempSync(join(testHome, `${name}-`));
  return join(dir, 'auth.json');
}

function writeAuth(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readAuth(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

async function lockedOtherProviderWriter(path: string, provider: string, value: unknown): Promise<ChildProcess> {
  const piMigrate = join(process.cwd(), 'dist-test', 'src', 'pi-migrate.js');
  const script = [
    "const { withPiAuthLock } = require(process.argv[1]);",
    "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
    'const [path, provider, value] = process.argv.slice(2);',
    'withPiAuthLock(path, () => {',
    "  const auth = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};",
    '  auth[provider] = JSON.parse(value);',
    "  writeFileSync(path, `${JSON.stringify(auth)}\\n`, { mode: 0o600 });",
    "  process.send?.('written');",
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);',
    '});',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script, piMigrate, path, provider, JSON.stringify(value)], {
    env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: testHome, HOME: testHome },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`locked writer exited before writing (${code})`)));
  });
  return child;
}

async function assertChildSucceeded(child: ChildProcess): Promise<void> {
  const [code] = await once(child, 'exit') as [number | null];
  assert.equal(code, 0);
}

describe('per-auth.json Pi backups', () => {
  it('two auth.json paths get two backup files and neither write touches the other', () => {
    const first = authPath('first');
    const second = authPath('second');
    try {
      writeAuth(first, { xai: { refresh: 'first' } });
      writeAuth(second, { xai: { refresh: 'second' } });
      writePiAuthBackup(first, 'xai', 'cycle-first');
      writePiAuthBackup(second, 'xai', 'cycle-second');

      assert.notEqual(piAuthBackupPath(first, 'xai'), piAuthBackupPath(second, 'xai'));
      assert.deepEqual(readPiAuthBackup(first, 'xai')?.entry, { refresh: 'first' });
      assert.deepEqual(readPiAuthBackup(second, 'xai')?.entry, { refresh: 'second' });
    } finally {
      rmSync(dirname(first), { recursive: true, force: true });
      rmSync(dirname(second), { recursive: true, force: true });
    }
  });

  it('a second write for the same key overwrites with the current entry', () => {
    const path = authPath('overwrite');
    try {
      writeAuth(path, { xai: { refresh: 'first' } });
      writePiAuthBackup(path, 'xai', 'same-cycle');
      writeAuth(path, { xai: { refresh: 'second' } });
      writePiAuthBackup(path, 'xai', 'same-cycle');

      assert.deepEqual(readPiAuthBackup(path, 'xai')?.entry, { refresh: 'second' });
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it('reads the legacy sibling baseline when the new path is absent', () => {
    const path = authPath('legacy');
    try {
      writeFileSync(legacyPiAuthBackupPath(path, 'xai'), JSON.stringify({ filePresent: true, entryPresent: true, entry: { refresh: 'legacy' } }), { mode: 0o600 });

      const backup = readPiAuthBackup(path, 'xai');
      assert.equal(backup?.cycleId, 'legacy');
      assert.equal(backup?.authPath, path);
      assert.deepEqual(backup?.entry, { refresh: 'legacy' });
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it('restore recreates a deleted auth.json from a filePresent backup', () => {
    const path = authPath('recreate');
    try {
      writeAuth(path, { xai: { refresh: 'native' } });
      writePiAuthBackup(path, 'xai', 'cycle');
      unlinkSync(path);

      const restored = restorePiAuthEntry(path, 'xai', readPiAuthBackup(path, 'xai')!);
      assert.deepEqual(restored, { refresh: 'native' });
      assert.deepEqual(readAuth(path), { xai: { refresh: 'native' } });
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it('restore of entryPresent:false deletes only that key', () => {
    const path = authPath('delete-key');
    try {
      writeAuth(path, { kimi: { refresh: 'keep' } });
      writePiAuthBackup(path, 'xai', 'cycle');
      writeAuth(path, { kimi: { refresh: 'keep' }, xai: { refresh: 'remove' } });

      restorePiAuthEntry(path, 'xai', readPiAuthBackup(path, 'xai')!);
      assert.deepEqual(readAuth(path), { kimi: { refresh: 'keep' } });
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it('restore waits for a locked writer and preserves its other-provider update', async () => {
    const path = authPath('restore-lock');
    try {
      writeAuth(path, { xai: { refresh: 'backup' } });
      const backup = writePiAuthBackup(path, 'xai', 'cycle');
      writeAuth(path, { xai: { refresh: 'managed' } });
      const writer = await lockedOtherProviderWriter(path, 'kimi', { refresh: 'updated' });

      const started = Date.now();
      const restored = restorePiAuthEntry(path, 'xai', backup);
      const elapsed = Date.now() - started;
      await assertChildSucceeded(writer);

      assert.ok(elapsed >= 300, `restore did not wait for the auth lock (${elapsed}ms)`);
      assert.deepEqual(restored, { refresh: 'backup' });
      assert.deepEqual(readAuth(path), { xai: { refresh: 'backup' }, kimi: { refresh: 'updated' } });
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it('restore does not delete an auth.json created by a locked writer', async () => {
    const path = authPath('restore-delete-lock');
    try {
      const backup = writePiAuthBackup(path, 'xai', 'cycle');
      const writer = await lockedOtherProviderWriter(path, 'kimi', { refresh: 'created' });

      const started = Date.now();
      const restored = restorePiAuthEntry(path, 'xai', backup);
      const elapsed = Date.now() - started;
      await assertChildSucceeded(writer);

      assert.ok(elapsed >= 300, `restore did not wait for the auth lock (${elapsed}ms)`);
      assert.equal(restored, undefined);
      assert.equal(existsSync(path), true);
      assert.deepEqual(readAuth(path), { kimi: { refresh: 'created' } });
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it('remove deletes the new and the legacy backup', () => {
    const path = authPath('remove');
    try {
      writeAuth(path, { xai: { refresh: 'native' } });
      writePiAuthBackup(path, 'xai', 'cycle');
      writeFileSync(legacyPiAuthBackupPath(path, 'xai'), JSON.stringify({ filePresent: true, entryPresent: true, entry: { refresh: 'legacy' } }), { mode: 0o600 });

      removePiAuthBackup(path, 'xai');
      assert.equal(existsSync(piAuthBackupPath(path, 'xai')), false);
      assert.equal(existsSync(legacyPiAuthBackupPath(path, 'xai')), false);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it('backup file mode is 0600', () => {
    const path = authPath('mode');
    try {
      writeAuth(path, { xai: { refresh: 'native' } });
      writePiAuthBackup(path, 'xai', 'cycle');

      assert.equal(statSync(piAuthBackupPath(path, 'xai')).mode & 0o777, 0o600);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});
