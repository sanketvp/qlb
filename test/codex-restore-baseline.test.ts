import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { checkRestorePrecondition, comparedSetDigest, recordRestoreBaseline } from '../src/codex-restore-baseline';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { openStore } from '../src/store';

function fixture(): { db: DatabaseSync; path: string; close: () => void } {
  const path = join(mkdtempSync(join(tmpdir(), 'qlb-restore-baseline-')), 'qlb.db');
  const store = openStore(path);
  return { db: (store as unknown as { db: DatabaseSync }).db, path, close: () => store.close() };
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function seedComparedRows(db: DatabaseSync): void {
  db.prepare(`INSERT INTO migrations (store, state, updated_at, detail_json) VALUES ('pi-xai', 'MIRRORED', 1, '{}')`).run();
  db.prepare(`INSERT INTO lifecycle (state, began_at) VALUES ('cutover', 1)`).run();
  db.prepare(`INSERT INTO codex_slots (account_id, chatgpt_user_id, chatgpt_account_id, fingerprint, added_at)
    VALUES ('user:codex', 'user', 'codex', 'fp', 1)`).run();
  db.prepare(`INSERT INTO claude_slots (account_id, slot_num, config_json, fingerprint, added_at)
    VALUES ('claude-1', 1, '{}', 'fp', 1)`).run();
  db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, to_fp, cause, by) VALUES (1, 'openai-codex', 'user:codex', 'fp', 'test', 'test')`).run();
  db.prepare(`INSERT INTO active_login (provider, account_id, since, set_by) VALUES ('openai-codex', 'user:codex', 1, 'test')`).run();
  db.prepare(`INSERT INTO pi_export_targets (provider, target, slot_account_id, lineage_fp, recorded_at)
    VALUES ('openai-codex', 'pi', 'user:codex', 'fp', 1)`).run();
  db.prepare(`INSERT INTO accounts (id, provider, label, status, created_at, grant_generation)
    VALUES ('xai-default', 'xai', 'Grok (xAI)', 'active', 1, 0)`).run();
  db.prepare(`INSERT INTO config (key, value) VALUES ('pi.xai.state', 'ready')`).run();
}

function writeBaseline(
  db: DatabaseSync,
  path: string,
  keychain: MockKeychain,
  saveKind: 'import-new' | 'add' | 'add-replace' | 'existing-mark' | 'existing-adopt' = 'add',
): string {
  const backupPath = join(mkdtempSync(join(tmpdir(), 'qlb-restore-copy-')), 'backup.sqlite');
  transaction(db, () => {
    db.prepare(`INSERT INTO config (key, value) VALUES ('codex.rekey.backupPath', ?)`)
      .run(backupPath);
    recordRestoreBaseline(db, { saveKind, backupPath, keychain });
  });
  db.close();
  copyFileSync(path, backupPath);
  return backupPath;
}

function insertRequiredKeychainItems(db: DatabaseSync, keychain: MockKeychain): void {
  const slots = db.prepare('SELECT account_id FROM codex_slots ORDER BY account_id').all() as Array<{ account_id: string }>;
  for (const slot of slots) keychain.setSync(qlbKeychainService('openai-codex', slot.account_id), QLB_KEYCHAIN_ACCOUNT, '{"fixture":"slot"}');
  const grants = db.prepare(`SELECT id, provider, label FROM accounts
    WHERE provider IN ('xai', 'kimi-coding', 'openai-codex', 'anthropic') ORDER BY id`).all() as Array<{ id: string; provider: string; label: string | null }>;
  for (const grant of grants) keychain.setSync(qlbKeychainService(grant.provider, grant.id), grant.label || grant.id, '{"fixture":"grant"}');
}

function baselineFixture(saveKind: 'import-new' | 'add' | 'add-replace' | 'existing-mark' | 'existing-adopt' = 'add') {
  const f = fixture();
  const keychain = new MockKeychain();
  seedComparedRows(f.db);
  insertRequiredKeychainItems(f.db, keychain);
  const backupPath = writeBaseline(f.db, f.path, keychain, saveKind);
  return { ...f, keychain, backupPath };
}

function write(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try { db.exec(sql); } finally { db.close(); }
}

class ReadFailingMockKeychain extends MockKeychain {
  override getSync(): string {
    throw new Error('injected Keychain read failure');
  }
}

describe('Codex restore baseline', () => {
  it('the digest is identical for identical rows and differs per entry', () => {
    const f = fixture();
    try {
      seedComparedRows(f.db);
      const before = comparedSetDigest(f.db);
      assert.deepEqual(before, comparedSetDigest(f.db));
      const mutations: Array<[keyof typeof before, string]> = [
        ['migrations', "UPDATE migrations SET state = 'QLB_OWNED'"],
        ['lifecycle', "UPDATE lifecycle SET state = 'rollback'"],
        ['codex_slots', "UPDATE codex_slots SET dead = 1"],
        ['claude_slots', "UPDATE claude_slots SET dead = 1"],
        ['lineage_log', "INSERT INTO lineage_log (ts, provider, account_id, to_fp, cause, by) VALUES (2, 'xai', 'xai-default', 'f', 'test', 'test')"],
        ['active_login', "UPDATE active_login SET account_id = 'other'"],
        ['pi_export_targets', "UPDATE pi_export_targets SET lineage_fp = 'other'"],
        ['accounts', "UPDATE accounts SET grant_generation = 1"],
        ['config', "UPDATE config SET value = 'changed' WHERE key = 'pi.xai.state'"],
      ];
      for (const [entry, sql] of mutations) {
        const original = comparedSetDigest(f.db);
        f.db.exec(sql);
        assert.notEqual(comparedSetDigest(f.db)[entry], original[entry]);
      }
    } finally { f.close(); }
  });

  it('codex.rekey.* config is outside the digest', () => {
    const f = fixture();
    try {
      seedComparedRows(f.db);
      const before = comparedSetDigest(f.db);
      f.db.prepare(`INSERT INTO config (key, value) VALUES ('codex.rekey.anything', 'changed')`).run();
      assert.equal(comparedSetDigest(f.db).config, before.config);
    } finally { f.close(); }
  });

  it('recordRestoreBaseline refuses outside a transaction', () => {
    const f = fixture();
    try {
      assert.throws(() => recordRestoreBaseline(f.db, { saveKind: 'add', backupPath: 'fixture.sqlite', keychain: new MockKeychain() }), /needs-transaction/);
    } finally { f.close(); }
  });

  it('a second recordRestoreBaseline leaves the first baseline unchanged', () => {
    const f = fixture();
    try {
      const keychain = new MockKeychain();
      transaction(f.db, () => recordRestoreBaseline(f.db, { saveKind: 'add', backupPath: 'first.sqlite', keychain }));
      const first = (f.db.prepare("SELECT value FROM config WHERE key = 'codex.rekey.baseline'").get() as { value: string }).value;
      transaction(f.db, () => recordRestoreBaseline(f.db, { saveKind: 'import-new', backupPath: 'second.sqlite', keychain }));
      assert.equal((f.db.prepare("SELECT value FROM config WHERE key = 'codex.rekey.baseline'").get() as { value: string }).value, first);
    } finally { f.close(); }
  });

  it('checkRestorePrecondition reports no-baseline, backup-path-mismatch, backup-missing, backup-integrity, user-version and backup-save-renewal', () => {
    const empty = fixture();
    try {
      empty.close();
      assert.deepEqual(checkRestorePrecondition(empty.path, { keychain: new MockKeychain() }), { verdict: 'differ', reasons: ['no-baseline'] });
    } finally { /* already closed */ }

    const mismatch = baselineFixture();
    write(mismatch.path, "UPDATE config SET value = 'other.sqlite' WHERE key = 'codex.rekey.backupPath'");
    assert.ok((checkRestorePrecondition(mismatch.path, { keychain: mismatch.keychain }) as { reasons: string[] }).reasons.includes('backup-path-mismatch'));

    const missing = baselineFixture();
    rmSync(missing.backupPath);
    assert.ok((checkRestorePrecondition(missing.path, { keychain: missing.keychain }) as { reasons: string[] }).reasons.includes('backup-missing'));

    const damaged = baselineFixture();
    writeFileSync(damaged.backupPath, 'not a database');
    assert.ok((checkRestorePrecondition(damaged.path, { keychain: damaged.keychain }) as { reasons: string[] }).reasons.includes('backup-integrity'));

    const version = baselineFixture();
    write(version.path, 'PRAGMA user_version = 99');
    assert.ok((checkRestorePrecondition(version.path, { keychain: version.keychain }) as { reasons: string[] }).reasons.includes('user-version'));

    const renewal = baselineFixture('add-replace');
    assert.ok((checkRestorePrecondition(renewal.path, { keychain: renewal.keychain }) as { reasons: string[] }).reasons.includes('backup-save-renewal'));
  });

  it('the check writes nothing to either file', () => {
    const f = baselineFixture();
    const liveBefore = readFileSync(f.path);
    const copyBefore = readFileSync(f.backupPath);
    const liveMtime = statSync(f.path).mtimeMs;
    const copyMtime = statSync(f.backupPath).mtimeMs;
    assert.deepEqual(checkRestorePrecondition(f.path, { keychain: f.keychain }), { verdict: 'same' });
    assert.deepEqual(readFileSync(f.path), liveBefore);
    assert.deepEqual(readFileSync(f.backupPath), copyBefore);
    assert.equal(statSync(f.path).mtimeMs, liveMtime);
    assert.equal(statSync(f.backupPath).mtimeMs, copyMtime);
  });

  it('a gate delivery after the baseline still checks same', () => {
    const f = baselineFixture();
    write(f.path, `INSERT INTO config (key, value) VALUES
      ('pi.xai.lastServedAt', '1'),
      ('pi.xai.lastServedFingerprint', 'fixture'),
      ('pi.anthropic.lastServedBy', 'fixture')`);
    assert.deepEqual(checkRestorePrecondition(f.path, { keychain: f.keychain }), { verdict: 'same' });
  });

  it('a renewal that writes the Keychain successor and crashes before its DB commit checks differ:keychain', () => {
    const f = baselineFixture();
    // refresh-lease.ts writes the successor to Keychain before bumpGrantGeneration.
    f.keychain.setSync(qlbKeychainService('xai', 'xai-default'), 'Grok (xAI)', '{"fixture":"successor"}');
    assert.deepEqual(checkRestorePrecondition(f.path, { keychain: f.keychain }), { verdict: 'differ', reasons: ['keychain'] });
  });

  it('an unreadable Keychain item checks differ:keychain', () => {
    const f = baselineFixture();
    f.keychain.deleteSync(qlbKeychainService('xai', 'xai-default'), 'Grok (xAI)');
    assert.deepEqual(checkRestorePrecondition(f.path, { keychain: f.keychain }), { verdict: 'differ', reasons: ['keychain'] });
  });

  it('baseline records absent items instead of throwing', () => {
    const f = fixture();
    const keychain = new MockKeychain();
    const backupPath = join(mkdtempSync(join(tmpdir(), 'qlb-restore-copy-')), 'backup.sqlite');
    transaction(f.db, () => {
      f.db.prepare(`INSERT INTO codex_slots (account_id, chatgpt_user_id, chatgpt_account_id, fingerprint, added_at)
        VALUES ('user:codex', 'user', 'codex', 'fp', 1)`).run();
      f.db.prepare(`INSERT INTO accounts (id, provider, label, status, created_at, grant_generation)
        VALUES ('user:codex', 'openai-codex', 'user:codex', 'active', 1, 0),
          ('xai-default', 'xai', 'Grok (xAI)', 'active', 1, 0)`).run();
      f.db.prepare(`INSERT INTO config (key, value) VALUES ('codex.rekey.backupPath', ?)`).run(backupPath);
      recordRestoreBaseline(f.db, { saveKind: 'add', backupPath, keychain });
    });
    f.db.close();
    copyFileSync(f.path, backupPath);
    assert.deepEqual(checkRestorePrecondition(f.path, { keychain }), { verdict: 'same' });
  });

  it('an item appearing after the baseline gives differ:keychain', () => {
    const f = baselineFixture();
    f.keychain.setSync(qlbKeychainService('xai', 'default'), QLB_KEYCHAIN_ACCOUNT, '{"fixture":"appeared"}');
    assert.deepEqual(checkRestorePrecondition(f.path, { keychain: f.keychain }), { verdict: 'differ', reasons: ['keychain'] });
  });

  it('a single-mode renewal before its lineage write gives differ:keychain', () => {
    const f = fixture();
    const keychain = new MockKeychain();
    seedComparedRows(f.db);
    insertRequiredKeychainItems(f.db, keychain);
    keychain.setSync(qlbKeychainService('kimi-coding', 'default'), QLB_KEYCHAIN_ACCOUNT, '{"fixture":"predecessor"}');
    writeBaseline(f.db, f.path, keychain);
    keychain.setSync(qlbKeychainService('kimi-coding', 'default'), QLB_KEYCHAIN_ACCOUNT, '{"fixture":"successor"}');
    assert.deepEqual(checkRestorePrecondition(f.path, { keychain }), { verdict: 'differ', reasons: ['keychain'] });
  });

  it('an anthropic generic-grant successor gives differ:keychain', () => {
    const f = fixture();
    const keychain = new MockKeychain();
    seedComparedRows(f.db);
    f.db.prepare(`INSERT INTO accounts (id, provider, label, status, created_at, grant_generation)
      VALUES ('anthropic-id', 'anthropic', 'Anthropic label', 'active', 1, 0)`).run();
    insertRequiredKeychainItems(f.db, keychain);
    writeBaseline(f.db, f.path, keychain);
    keychain.setSync(qlbKeychainService('anthropic', 'anthropic-id'), 'Anthropic label', '{"fixture":"successor"}');
    assert.deepEqual(checkRestorePrecondition(f.path, { keychain }), { verdict: 'differ', reasons: ['keychain'] });
  });

  it('a non-not-found read error during the baseline throws and rolls back the save', () => {
    const f = fixture();
    try {
      seedComparedRows(f.db);
      assert.throws(() => transaction(f.db, () => {
        f.db.prepare(`INSERT INTO config (key, value) VALUES ('codex.rekey.backupPath', 'backup.sqlite')`).run();
        recordRestoreBaseline(f.db, { saveKind: 'add', backupPath: 'backup.sqlite', keychain: new ReadFailingMockKeychain() });
      }), /injected Keychain read failure/);
      assert.equal(f.db.prepare(`SELECT value FROM config WHERE key = 'codex.rekey.backupPath'`).get(), undefined);
      assert.equal(f.db.prepare(`SELECT value FROM config WHERE key = 'codex.rekey.baseline'`).get(), undefined);
    } finally { f.close(); }
  });

  it('a non-not-found read error during the check gives differ:keychain', () => {
    const f = baselineFixture();
    assert.deepEqual(checkRestorePrecondition(f.path, { keychain: new ReadFailingMockKeychain() }), { verdict: 'differ', reasons: ['keychain'] });
  });
});
