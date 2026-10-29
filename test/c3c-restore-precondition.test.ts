import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { addCodexAccount, productionCodexAddDeps } from '../src/codex-add';
import { runCodexImportActiveCommand, type CodexImportActiveCommandDeps } from '../src/commands/codex-import-active';
import { parseCodexAuth, type CodexAuthDocument } from '../src/codex-auth';
import { checkRestorePrecondition } from '../src/codex-restore-baseline';
import { importActiveCodexSlot, type CodexImportPlan } from '../src/codex-slots';
import { MockKeychain } from '../src/keychain';
import { beginCutover } from '../src/lifecycle';
import type { CommandContext } from '../src/registry';
import { openStore, type Store } from '../src/store';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
}

function document(refresh: string, accountId = 'fixture-account'): CodexAuthDocument {
  const parsed = parseCodexAuth(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: accountId } }),
      access_token: jwt({ exp: 2_000_000_000 }),
      refresh_token: refresh,
      account_id: accountId,
    },
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture document must parse');
  return parsed.doc;
}

interface Fixture {
  root: string;
  path: string;
  store: Store;
  keychain: MockKeychain;
  output: string[];
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qlb-c3c-restore-precondition-'));
  const store = openStore(join(root, 'qlb.db'));
  beginCutover(store, 1);
  return { root, path: store.dbPath, store, keychain: new MockKeychain(), output: [] };
}

function close(f: Fixture): void {
  f.store.close();
  rmSync(f.root, { recursive: true, force: true });
}

function write(f: Fixture, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(f.path);
  try {
    if (params.length > 0) db.prepare(sql).run(...params);
    else db.exec(sql);
  } finally {
    db.close();
  }
}

function value(f: Fixture, key: string): string {
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    assert.ok(row, `missing config ${key}`);
    return row.value;
  } finally {
    db.close();
  }
}

function assertBackupInsideFixture(f: Fixture): string {
  const backupPath = value(f, 'codex.rekey.backupPath');
  const pathFromRoot = relative(f.root, backupPath);
  assert.ok(pathFromRoot.length > 0 && !pathFromRoot.startsWith('..'), `backup outside fixture: ${backupPath}`);
  assert.match(basename(backupPath), /^db-\d+-\d+\.sqlite$/);
  assert.equal(existsSync(backupPath), true);
  return backupPath;
}

function check(f: Fixture) {
  return checkRestorePrecondition(f.path, { keychain: f.keychain });
}

function same(f: Fixture): void {
  assert.deepEqual(check(f), { verdict: 'same' });
}

function differ(f: Fixture, reasons: string[]): void {
  assert.deepEqual(check(f), { verdict: 'differ', reasons });
}

function seedBareRow(f: Fixture, accountId = 'fixture-account'): void {
  write(f, `INSERT INTO accounts (id, provider, label, status, created_at)
    VALUES (?, 'openai-codex', 'legacy bare row', 'active', 1)`, accountId);
}

function importNewWithBackup(f: Fixture, doc = document('new-slot')): CodexImportPlan {
  seedBareRow(f, doc.tokens.account_id!);
  const plan = importActiveCodexSlot(doc, { store: f.store, keychain: f.keychain, now: () => 2 });
  assertBackupInsideFixture(f);
  return plan;
}

function commandContext(f: Fixture): CommandContext {
  return {
    stdout: (line) => f.output.push(`stdout:${line}`),
    stderr: (line) => f.output.push(`stderr:${line}`),
    env: { QLB_TEST_MODE: '1', HOME: f.root, QLB_HOME: join(f.root, 'qlb'), CODEX_HOME: join(f.root, 'codex') },
    config: { dbPath: f.path, piAuthJsonPath: join(f.root, 'pi-auth.json') } as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); },
    home: f.root,
    registerSecret: () => undefined,
    deliverSecret: () => undefined,
    knownSecrets: () => [],
  };
}

function commandDeps(f: Fixture, doc: CodexAuthDocument): CodexImportActiveCommandDeps {
  return {
    keychain: f.keychain,
    readAuth: async () => ({ status: 'ok', doc }),
    writeAuth: async () => 1,
    withAuthLock: async (_options, fn) => fn({ assertNotCompromised: () => undefined }),
  };
}

async function runExistingImport(f: Fixture, doc: CodexAuthDocument): Promise<void> {
  assert.equal(await runCodexImportActiveCommand([], commandContext(f), commandDeps(f, doc)), 0);
}

async function add(f: Fixture, doc: CodexAuthDocument, replace?: string) {
  const nativeAuthPath = join(f.root, 'native-auth.json');
  writeFileSync(nativeAuthPath, '{}', { mode: 0o600 });
  const deps = productionCodexAddDeps(f.store, f.keychain, {
    QLB_TEST_MODE: '1', HOME: f.root, QLB_HOME: join(f.root, 'qlb'),
  });
  deps.login = async (options) => {
    writeFileSync(join(options.cwd, 'auth.json'), JSON.stringify(doc), { mode: 0o600 });
    return 0;
  };
  deps.withAuthLock = async (_options, fn) => fn({ assertNotCompromised: () => undefined });
  deps.installCleanup = () => () => undefined;
  return addCodexAccount({ home: f.root, nativeAuthPath, replace }, deps);
}

function seedExistingSlot(f: Fixture, doc: CodexAuthDocument): CodexImportPlan {
  return importActiveCodexSlot(doc, { store: f.store, keychain: f.keychain, now: () => 2 });
}

function assertBeforeAfter(f: Fixture, mutation: () => void, reasons: string[]): void {
  same(f);
  mutation();
  differ(f, reasons);
}

describe('C3c restore precondition on real save paths', () => {
  it('new-slot import with a bare row ⇒ same right after the save', () => {
    const f = fixture();
    try {
      importNewWithBackup(f);
      same(f);
    } finally { close(f); }
  });

  it('codex add ⇒ same', async () => {
    const f = fixture();
    try {
      seedBareRow(f);
      const result = await add(f, document('add'));
      assert.ok(result.rekey.backupTaken);
      assertBackupInsideFixture(f);
      same(f);
    } finally { close(f); }
  });

  it('codex add --replace that took the backup ⇒ differ:backup-save-renewal', async () => {
    const f = fixture();
    try {
      const first = await add(f, document('first-add'));
      seedBareRow(f);
      const result = await add(f, document('replacement-add'), first.slotId);
      assert.ok(result.rekey.backupTaken);
      assertBackupInsideFixture(f);
      differ(f, ['backup-save-renewal']);
    } finally { close(f); }
  });

  it('existing-slot noop import that took the backup ⇒ same', async () => {
    const f = fixture();
    try {
      const doc = document('existing-noop');
      seedExistingSlot(f, doc);
      seedBareRow(f);
      await runExistingImport(f, doc);
      assertBackupInsideFixture(f);
      same(f);
    } finally { close(f); }
  });

  it('existing-slot adopt that took the backup ⇒ differ:backup-save-renewal', async () => {
    const f = fixture();
    try {
      const prior = document('existing-prior');
      seedExistingSlot(f, prior);
      seedBareRow(f);
      await runExistingImport(f, document('existing-adopt'));
      assertBackupInsideFixture(f);
      differ(f, ['backup-save-renewal']);
    } finally { close(f); }
  });

  it('later readings, pins, usage schedules and decisions ⇒ same', () => {
    const f = fixture();
    try {
      const plan = importNewWithBackup(f);
      same(f);
      write(f, `INSERT INTO snapshots (account_id, bucket, fetched_at) VALUES (?, 'five-hour', 10)`, plan.slotId);
      write(f, `INSERT INTO overrides (kind, account_id, session, until) VALUES ('pin', ?, 'fixture', 20)`, plan.slotId);
      write(f, `INSERT INTO usage_polls (provider, account_id, next_due_at) VALUES ('openai-codex', ?, 30)`, plan.slotId);
      write(f, `INSERT INTO decisions (ts, account_id) VALUES (40, ?)`, plan.slotId);
      same(f);
    } finally { close(f); }
  });

  it('a later pi-openai-codex MIRRORED row ⇒ differ:migrations', () => {
    const f = fixture();
    try {
      importNewWithBackup(f);
      assertBeforeAfter(f, () => write(f, `INSERT INTO migrations (store, state, updated_at, detail_json)
        VALUES ('pi-openai-codex', 'MIRRORED', 3, '{"qlbAccountIds":[]}')`), ['migrations']);
    } finally { close(f); }
  });

  it('a later hand-back (QLB_OWNED → NATIVE) ⇒ differ:migrations', () => {
    const f = fixture();
    try {
      write(f, `INSERT INTO migrations (store, state, updated_at, detail_json)
        VALUES ('pi-xai', 'QLB_OWNED', 1, '{"qlbAccountIds":["xai-fixture"]}')`);
      importNewWithBackup(f);
      assertBeforeAfter(f, () => write(f, `UPDATE migrations SET state = 'NATIVE', updated_at = 4 WHERE store = 'pi-xai'`), ['migrations']);
    } finally { close(f); }
  });

  it('a later Codex slot renewal ⇒ differ:codex_slots,lineage_log', () => {
    const f = fixture();
    try {
      const plan = importNewWithBackup(f);
      assertBeforeAfter(f, () => {
        write(f, `UPDATE codex_slots SET fingerprint = 'fixture-renewed' WHERE account_id = ?`, plan.slotId);
        write(f, `INSERT INTO lineage_log (ts, provider, account_id, to_fp, cause, by)
          VALUES (5, 'openai-codex', ?, 'fixture-renewed', 'renew', 'fixture')`, plan.slotId);
      }, ['codex_slots', 'lineage_log']);
    } finally { close(f); }
  });

  it('a later lifecycle phase change ⇒ differ:lifecycle', () => {
    const f = fixture();
    try {
      importNewWithBackup(f);
      assertBeforeAfter(f, () => write(f, `UPDATE lifecycle SET state = 'retiring'`), ['lifecycle']);
    } finally { close(f); }
  });

  it('a later anthropic grant_generation change ⇒ differ:accounts', () => {
    const f = fixture();
    try {
      write(f, `INSERT INTO accounts (id, provider, label, status, created_at, grant_generation)
        VALUES ('anthropic-fixture', 'anthropic', 'anthropic-fixture', 'active', 1, 0)`);
      importNewWithBackup(f);
      assertBeforeAfter(f, () => write(f, `UPDATE accounts SET grant_generation = grant_generation + 1 WHERE id = 'anthropic-fixture'`), ['accounts']);
    } finally { close(f); }
  });

  it('a later pi.<p>.state change ⇒ differ:config', () => {
    const f = fixture();
    try {
      importNewWithBackup(f);
      assertBeforeAfter(f, () => write(f, `INSERT INTO config (key, value) VALUES ('pi.fixture.state', 'changed')`), ['config']);
    } finally { close(f); }
  });

  it('a pre-existing generic-owned S29 merge target (trusted QLB_OWNED journal, slot, active login) with an unowned bare shadow, merged by an existing-slot noop import ⇒ same', async () => {
    const f = fixture();
    try {
      const doc = document('merge-target');
      const plan = seedExistingSlot(f, doc);
      write(f, `INSERT INTO migrations (store, state, updated_at, detail_json)
        VALUES ('pi-openai-codex', 'QLB_OWNED', 1, ?)`, JSON.stringify({ qlbAccountIds: [plan.slotId] }));
      seedBareRow(f);
      await runExistingImport(f, doc);
      assertBackupInsideFixture(f);
      same(f);
    } finally { close(f); }
  });

  it('its grant_generation + 1 ⇒ differ:accounts', async () => {
    const f = fixture();
    try {
      const doc = document('merge-target-generation');
      const plan = seedExistingSlot(f, doc);
      write(f, `INSERT INTO migrations (store, state, updated_at, detail_json)
        VALUES ('pi-openai-codex', 'QLB_OWNED', 1, ?)`, JSON.stringify({ qlbAccountIds: [plan.slotId] }));
      seedBareRow(f);
      await runExistingImport(f, doc);
      assertBeforeAfter(f, () => write(f, `UPDATE accounts SET grant_generation = grant_generation + 1 WHERE id = ?`, plan.slotId), ['accounts']);
    } finally { close(f); }
  });

  it('a deleted backup file ⇒ differ:backup-missing', () => {
    const f = fixture();
    try {
      importNewWithBackup(f);
      const backupPath = assertBackupInsideFixture(f);
      rmSync(backupPath);
      differ(f, ['backup-missing']);
    } finally { close(f); }
  });

  it('no baseline ⇒ differ:no-baseline', () => {
    const f = fixture();
    try {
      differ(f, ['no-baseline']);
    } finally { close(f); }
  });
});
