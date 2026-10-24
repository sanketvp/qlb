import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { backupBeforeMigrate, verifyBackup } from '../src/store';

describe('store backup before migration (AC45)', () => {
  it('backs up committed WAL rows and the copy has equal table row counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-backup-wal-'));
    const path = join(dir, 'qlb.db');
    const source = new DatabaseSync(path);
    source.exec('PRAGMA journal_mode = WAL; CREATE TABLE rows (id INTEGER); INSERT INTO rows VALUES (1), (2)');
    const target = join(dir, 'backup.sqlite');
    const written = await backupBeforeMigrate(path, target);
    assert.equal(written, target);
    const restored = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal((restored.prepare('SELECT count(*) AS n FROM rows').get() as { n: number }).n, 2);
    } finally { restored.close(); source.close(); }
  });

  it('rejects equal-count copies whose row content differs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-backup-content-'));
    const source = new DatabaseSync(join(dir, 'source.db'));
    const copy = new DatabaseSync(join(dir, 'copy.db'));
    try {
      source.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO rows VALUES (1, 'before')");
      copy.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO rows VALUES (1, 'after')");
      assert.equal(verifyBackup(source, copy), false);
    } finally { copy.close(); source.close(); }
  });

  it('aborts on backup verification failure and leaves the source untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-backup-fail-'));
    const path = join(dir, 'qlb.db');
    const source = new DatabaseSync(path);
    source.exec('CREATE TABLE rows (id INTEGER); INSERT INTO rows VALUES (1); PRAGMA user_version = 4');
    source.close();
    const target = join(dir, 'backup.sqlite');
    await assert.rejects(() => backupBeforeMigrate(path, target, () => false), /backup verification failed/);
    assert.ok(!existsSync(target));
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
      assert.equal((check.prepare('SELECT count(*) AS n FROM rows').get() as { n: number }).n, 1);
    } finally { check.close(); }
  });
});
