import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import importActiveCommand, {
  runCodexImportActiveCommand,
  type CodexImportActiveCommandDeps,
} from '../src/commands/codex-import-active';
import { codexAuthLockDir, CodexAuthLockCompromised, withCodexAuthLock } from '../src/cc-locks';
import { attributeLiveDocument } from '../src/codex-attribution';
import { codexFingerprint, parseCodexAuth } from '../src/codex-auth';
import { importActiveCodexSlot } from '../src/codex-slots';
import * as keychainModule from '../src/keychain';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { backupBeforeMigrateSync, openStore } from '../src/store';
import { beginCutover } from '../src/lifecycle';
import type { CommandContext } from '../src/registry';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(refresh: string, accountId = 'fixture-account') {
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
  if (!parsed.ok) throw new Error('fixture must parse');
  return parsed.doc;
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'qlb-codex-attribution-'));
  return { home, store: openStore(join(home, 'qlb.db')), keychain: new MockKeychain() };
}

function commandContext(home: string, codexHome: string, output: string[]): CommandContext {
  return {
    stdout: (line) => output.push(line), stderr: (line) => output.push(`stderr:${line}`),
    env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home, CODEX_HOME: codexHome },
    config: { dbPath: join(home, 'qlb.db'), piAuthJsonPath: join(home, 'pi-auth.json') } as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); }, home,
    registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
  };
}

class PreviousReadErrorKeychain extends MockKeychain {
  constructor(private readonly previousError: Error) { super(); }

  override getSync(service: string, account: string): string {
    if (service.endsWith(':prev')) throw this.previousError;
    return super.getSync(service, account);
  }
}

class CurrentWriteErrorKeychain extends MockKeychain {
  private failCurrentWrite = false;

  failNextCurrentWrite(): void {
    this.failCurrentWrite = true;
  }

  override setSync(service: string, account: string, value: string): void {
    if (this.failCurrentWrite && !service.endsWith(':prev')) {
      this.failCurrentWrite = false;
      throw new Error('fixture current-item write failed before mutation');
    }
    super.setSync(service, account, value);
  }
}

class CurrentWriteTakeoverKeychain extends MockKeychain {
  private replacement: string | undefined;

  replaceNextCurrentWriteWith(value: string): void {
    this.replacement = value;
  }

  override setSync(service: string, account: string, value: string): void {
    super.setSync(service, account, value);
    if (this.replacement !== undefined && !service.endsWith(':prev')) {
      const replacement = this.replacement;
      this.replacement = undefined;
      super.setSync(service, account, replacement);
    }
  }
}

/** Frozen rev4 mistake: it only adopted a live document already proven as a successor. */
function rev4SuccessorGatedRule(slotFp: string, liveFp: string, isSuccessor: boolean): 'noop' | 'republish-slot' | 'leave' {
  if (slotFp === liveFp) return 'noop';
  if (isSuccessor) return 'republish-slot';
  return 'leave';
}

describe('Codex live-document attribution (AC57)', () => {
  it('is red against the rev4 successor-gated rule, then adopts an empty-graph live rotation and records it', async () => {
    const h = fixture();
    try {
      const slot = document('slot-a0');
      const live = document('live-a1');
      const plan = importActiveCodexSlot(slot, { store: h.store, keychain: h.keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      const db = new DatabaseSync(join(h.home, 'qlb.db'));
      db.prepare('DELETE FROM lineage_log WHERE provider = ? AND account_id = ?').run('openai-codex', plan.slotId);
      db.close();

      assert.equal(rev4SuccessorGatedRule(codexFingerprint(slot), codexFingerprint(live), false), 'leave');

      const result = await attributeLiveDocument({
        store: h.store,
        keychain: h.keychain,
        slot: { accountId: plan.slotId, document: slot },
        live,
        now: () => 2,
      });

      assert.equal(result.action, 'adopt');
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(live));
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(slot));
      const readDb = new DatabaseSync(join(h.home, 'qlb.db'), { readOnly: true });
      const row = readDb.prepare(
        "SELECT from_fp, to_fp, cause, by, evidence FROM lineage_log WHERE provider = 'openai-codex' ORDER BY id DESC LIMIT 1",
      ).get() as { from_fp: string; to_fp: string; cause: string; by: string; evidence: string };
      const relogin = readDb.prepare(
        "SELECT provider, account_id, kind, detail, evidence FROM relogin_events WHERE provider = 'openai-codex'",
      ).get() as { provider: string; account_id: string; kind: string; detail: string; evidence: string };
      readDb.close();
      assert.deepEqual({ ...row }, {
        from_fp: codexFingerprint(slot), to_fp: codexFingerprint(live), cause: 'adopt', by: 'tool', evidence: 'identity',
      });
      assert.deepEqual({ ...relogin }, {
        provider: 'openai-codex', account_id: plan.slotId, kind: 'external-login',
        detail: 'unattributed-rotation', evidence: 'unattributed-rotation',
      });
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('routes through the active_login slot and restores the live slot after importing A, then B, then observing A again', async () => {
    const h = fixture();
    try {
      const a = document('a-refresh', 'account-a');
      const b = document('b-refresh', 'account-b');
      const slotA = importActiveCodexSlot(a, { store: h.store, keychain: h.keychain, now: () => 1 });
      importActiveCodexSlot(b, { store: h.store, keychain: h.keychain, now: () => 2 });
      (h.store as unknown as { db: DatabaseSync }).db.prepare(`UPDATE codex_slots
        SET archived_at = 4, pending_adopt = 1 WHERE account_id = ?`).run(slotA.slotId);

      const result = await attributeLiveDocument({
        store: h.store,
        keychain: h.keychain,
        slot: { accountId: 'fixture-user:account-b', document: b, fingerprint: codexFingerprint(b) },
        live: a,
        now: () => 3,
      });

      assert.equal(result.action, 'drift');
      assert.equal(result.disposition, 'noop');
      const db = new DatabaseSync(join(h.home, 'qlb.db'), { readOnly: true });
      const active = db.prepare("SELECT account_id, set_by FROM active_login WHERE provider = 'openai-codex'").get() as { account_id: string; set_by: string };
      const slot = db.prepare('SELECT archived_at, pending_adopt, last_active_at FROM codex_slots WHERE account_id = ?').get(slotA.slotId) as {
        archived_at: number | null; pending_adopt: number; last_active_at: number;
      };
      db.close();
      assert.deepEqual({ ...active }, { account_id: slotA.slotId, set_by: 'import' });
      assert.deepEqual({ ...slot }, { archived_at: null, pending_adopt: 0, last_active_at: 3 });
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('repairs a database/keychain split instead of treating the already-live Keychain document as a noop', async () => {
    const h = fixture();
    try {
      const old = document('split-old');
      const live = document('split-live');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      h.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(old));
      h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(live));

      const result = await attributeLiveDocument({
        store: h.store,
        keychain: h.keychain,
        slot: { accountId: plan.slotId, document: live, fingerprint: codexFingerprint(old) },
        live,
        now: () => 2,
      });

      assert.equal(result.action, 'adopt');
      assert.equal(h.store.getCodexSlot(plan.slotId)?.fingerprint, codexFingerprint(live));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('restores Keychain writes when the database fails after the CAS, then retries the adoption', async () => {
    const h = fixture();
    try {
      const old = document('failure-old');
      const live = document('failure-live');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      const raw = (h.store as unknown as { db: DatabaseSync }).db;
      let failOnce = true;
      (h.store as unknown as { db: DatabaseSync }).db = new Proxy(raw, {
        get(target, property, receiver) {
          if (property === 'prepare') return (sql: string) => {
            if (failOnce && sql.includes('INSERT INTO lineage_log')) {
              failOnce = false;
              throw new Error('fixture database failure after CAS');
            }
            return target.prepare(sql);
          };
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      await assert.rejects(attributeLiveDocument({
        store: h.store,
        keychain: h.keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) },
        live,
        now: () => 2,
      }), /fixture database failure after CAS/);
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(old));
      assert.throws(() => h.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT), /item not found/);

      const retry = await attributeLiveDocument({
        store: h.store,
        keychain: h.keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) },
        live,
        now: () => 3,
      });
      assert.equal(retry.action, 'adopt');
      assert.equal(h.store.getCodexSlot(plan.slotId)?.fingerprint, codexFingerprint(live));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a takeover after the Keychain writes in adoption restores current and :prev and leaves DB and Keychain consistent', async () => {
    const h = fixture();
    try {
      const old = document('takeover-adopt-old');
      const live = document('takeover-adopt-live');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      let assertions = 0;

      await assert.rejects(attributeLiveDocument({
        store: h.store,
        keychain: h.keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) },
        live,
        now: () => 2,
        assertNotCompromised: () => {
          assertions += 1;
          if (assertions >= 5) throw new CodexAuthLockCompromised();
        },
      }), (error: unknown) => error instanceof CodexAuthLockCompromised && error.retryable);

      assert.equal(h.store.getCodexSlot(plan.slotId)?.fingerprint, codexFingerprint(old));
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(old));
      assert.throws(() => h.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT), /item not found/);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a current-item write that throws before mutating still restores :prev', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-current-write-error-'));
    const keychain = new CurrentWriteErrorKeychain();
    const store = openStore(join(home, 'qlb.db'));
    try {
      const old = document('current-write-error-old');
      const previous = document('current-write-error-previous');
      const live = document('current-write-error-live');
      const plan = importActiveCodexSlot(old, { store, keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(previous));
      keychain.failNextCurrentWrite();

      await assert.rejects(attributeLiveDocument({
        store,
        keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) },
        live,
        now: () => 2,
      }), /fixture current-item write failed before mutation/);

      assert.equal(codexFingerprint(JSON.parse(keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(old));
      assert.equal(codexFingerprint(JSON.parse(keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(previous));
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('compensation failure keeps the original error as cause and its retryable flag', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-compensation-cause-'));
    const keychain = new CurrentWriteTakeoverKeychain();
    const store = openStore(join(home, 'qlb.db'));
    try {
      const old = document('compensation-cause-old');
      const live = document('compensation-cause-live');
      const foreign = document('compensation-cause-foreign');
      const plan = importActiveCodexSlot(old, { store, keychain, now: () => 1 });
      keychain.replaceNextCurrentWriteWith(JSON.stringify(foreign));
      let assertions = 0;

      await assert.rejects(attributeLiveDocument({
        store,
        keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) },
        live,
        now: () => 2,
        assertNotCompromised: () => {
          assertions += 1;
          if (assertions >= 5) throw new CodexAuthLockCompromised();
        },
      }), (error: unknown) => error instanceof Error &&
        /Codex Keychain compensation compare-and-set failed/.test(error.message) &&
        error.cause instanceof CodexAuthLockCompromised && error.cause.retryable);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not let a CAS loser write either Keychain item', async () => {
    const h = fixture();
    try {
      const old = document('race-old');
      const first = document('race-first');
      const loser = document('race-loser');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      await attributeLiveDocument({
        store: h.store,
        keychain: h.keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) },
        live: first,
        now: () => 2,
      });
      await assert.rejects(attributeLiveDocument({
        store: h.store,
        keychain: h.keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) },
        live: loser,
        now: () => 3,
      }), /Codex slot changed before adoption/);
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(first));
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(old));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('imports a new live identity even when active_login names another slot, then returns to the known slot as drift', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-import-command-'));
    const codexHome = mkdtempSync(join(tmpdir(), 'qlb-codex-import-command-auth-'));
    const originalPlatformKeychain = keychainModule.platformKeychain;
    try {
      (keychainModule as unknown as { platformKeychain: MockKeychain }).platformKeychain = new MockKeychain();
      const output: string[] = [];
      const ctx = commandContext(home, codexHome, output);
      const admitted = openStore(join(home, 'qlb.db'));
      beginCutover(admitted, 1);
      admitted.close();
      const a = document('command-a', 'account-a');
      const b = document('command-b', 'account-b');
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(a), { mode: 0o600 });
      assert.equal(await importActiveCommand.execute!([], ctx), 0);
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(b), { mode: 0o600 });
      assert.equal(await importActiveCommand.execute!([], ctx), 0);
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(a), { mode: 0o600 });
      assert.equal(await importActiveCommand.execute!([], ctx), 0);

      const store = openStore(join(home, 'qlb.db'));
      try {
        assert.ok(store.getCodexSlot('fixture-user:account-b'));
        assert.equal(store.getCodexActiveLogin(), 'fixture-user:account-a');
      } finally {
        store.close();
      }
      assert.deepEqual(output, [
        'imported fixture-user:account-a', 'imported fixture-user:account-b', 'drift fixture-user:account-a',
      ]);
    } finally {
      (keychainModule as unknown as { platformKeychain: typeof originalPlatformKeychain }).platformKeychain = originalPlatformKeychain;
      rmSync(home, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('treats a platform not-found :prev error as absent but fails closed for another backend error', async () => {
    for (const error of [
      new Error('item could not be found in the keychain'),
      new Error('fixture backend unavailable'),
    ]) {
      const home = mkdtempSync(join(tmpdir(), 'qlb-codex-prev-error-'));
      const store = openStore(join(home, 'qlb.db'));
      const keychain = new PreviousReadErrorKeychain(error);
      try {
        const old = document('prev-old');
        const live = document('prev-live');
        const plan = importActiveCodexSlot(old, { store, keychain, now: () => 1 });
        const adoption = attributeLiveDocument({
          store, keychain, slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) }, live, now: () => 2,
        });
        if (/could not be found/.test(error.message)) {
          assert.equal((await adoption).action, 'adopt');
        } else {
          await assert.rejects(adoption, /fixture backend unavailable/);
        }
      } finally {
        store.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('repairs a stale Keychain document from a matching native successor before reporting noop', async () => {
    const h = fixture();
    try {
      const old = document('repair-old');
      const live = document('repair-live');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      h.store.adoptCodexSlot({
        accountId: plan.slotId, previousFingerprint: codexFingerprint(old), fingerprint: codexFingerprint(live), ts: 2, evidence: 'identity',
      });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      const result = await attributeLiveDocument({
        store: h.store, keychain: h.keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(live) }, live, now: () => 3,
      });
      assert.equal(result.action, 'noop');
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(live));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('refuses a DB/Keychain split when native is the predecessor and no DB-matching document is available', async () => {
    const h = fixture();
    try {
      const old = document('split-refuse-old');
      const successor = document('split-refuse-successor');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      h.store.adoptCodexSlot({
        accountId: plan.slotId, previousFingerprint: codexFingerprint(old), fingerprint: codexFingerprint(successor), ts: 2, evidence: 'identity',
      });
      const published: string[] = [];
      const result = await attributeLiveDocument({
        store: h.store, keychain: h.keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(successor) }, live: old,
        republish: (doc) => { published.push(codexFingerprint(doc)); },
      });
      assert.equal(result.action, 'slot-split');
      assert.deepEqual(published, []);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('keeps a newer adoption when a failed attempt restores while holding the database write lock', async () => {
    const h = fixture();
    try {
      const old = document('restore-old');
      const failed = document('restore-failed');
      const newer = document('restore-newer');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      const raw = (h.store as unknown as { db: DatabaseSync }).db;
      let failOnce = true;
      let newerCommitted = false;
      (h.store as unknown as { db: DatabaseSync }).db = new Proxy(raw, {
        get(target, property, receiver) {
          if (property === 'prepare') return (sql: string) => {
            if (failOnce && sql.includes('INSERT INTO lineage_log')) {
              failOnce = false;
              throw new Error('fixture failure after Keychain write');
            }
            return target.prepare(sql);
          };
          if (property === 'exec') return (sql: string) => {
            const result = target.exec(sql);
            if (sql === 'ROLLBACK' && !newerCommitted) {
              newerCommitted = true;
              target.prepare('UPDATE codex_slots SET fingerprint = ?, prev_fingerprint = ? WHERE account_id = ?')
                .run(codexFingerprint(newer), codexFingerprint(old), plan.slotId);
              h.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(old));
              h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(newer));
            }
            return result;
          };
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      await assert.rejects(attributeLiveDocument({
        store: h.store, keychain: h.keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) }, live: failed, now: () => 2,
      }), /fixture failure after Keychain write/);
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(newer));
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(old));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('does not overwrite a newer adoption committed after the caller read the split slot', async () => {
    const h = fixture();
    try {
      const old = document('split-race-old');
      const stale = document('split-race-stale');
      const newer = document('split-race-newer');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(stale));
      const raw = (h.store as unknown as { db: DatabaseSync }).db;
      let injectNewerAdoption = true;
      (h.store as unknown as { db: DatabaseSync }).db = new Proxy(raw, {
        get(target, property, receiver) {
          if (property === 'exec') return (sql: string) => {
            if (sql === 'BEGIN IMMEDIATE' && injectNewerAdoption) {
              injectNewerAdoption = false;
              target.prepare('UPDATE codex_slots SET fingerprint = ?, prev_fingerprint = ? WHERE account_id = ?')
                .run(codexFingerprint(newer), codexFingerprint(old), plan.slotId);
              h.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(old));
              h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(newer));
            }
            return target.exec(sql);
          };
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const result = await attributeLiveDocument({
        store: h.store, keychain: h.keychain,
        slot: { accountId: plan.slotId, document: stale, fingerprint: codexFingerprint(old) }, live: old, now: () => 2,
      });

      assert.equal(result.action, 'slot-split');
      assert.equal(h.store.getCodexSlot(plan.slotId)?.fingerprint, codexFingerprint(newer));
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(newer));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('rejects an adoption committed after split repair and before re-validation', async () => {
    const h = fixture();
    try {
      const old = document('repair-commit-old');
      const repaired = document('repair-commit-repaired');
      const newer = document('repair-commit-newer');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      h.store.adoptCodexSlot({
        accountId: plan.slotId, previousFingerprint: codexFingerprint(old), fingerprint: codexFingerprint(repaired),
        ts: 2, evidence: 'identity',
      });
      h.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(repaired));
      const raw = (h.store as unknown as { db: DatabaseSync }).db;
      let injectAfterRepairCommit = true;
      (h.store as unknown as { db: DatabaseSync }).db = new Proxy(raw, {
        get(target, property, receiver) {
          if (property === 'exec') return (sql: string) => {
            const result = target.exec(sql);
            if (sql === 'COMMIT' && injectAfterRepairCommit) {
              injectAfterRepairCommit = false;
              target.prepare('UPDATE codex_slots SET fingerprint = ?, prev_fingerprint = ? WHERE account_id = ?')
                .run(codexFingerprint(newer), codexFingerprint(repaired), plan.slotId);
              h.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(repaired));
              h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(newer));
            }
            return result;
          };
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const published: string[] = [];

      const result = await attributeLiveDocument({
        store: h.store, keychain: h.keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(repaired) }, live: old,
        republish: (doc) => { published.push(codexFingerprint(doc)); },
      });

      assert.equal(result.action, 'slot-split');
      assert.deepEqual(published, []);
      assert.equal(h.store.getCodexSlot(plan.slotId)?.fingerprint, codexFingerprint(newer));
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(newer));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a holder whose Codex auth lock was taken over aborts before writing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-import-compromised-home-'));
    const codexHome = mkdtempSync(join(tmpdir(), 'qlb-codex-import-compromised-auth-'));
    const originalPlatformKeychain = keychainModule.platformKeychain;
    try {
      const keychain = new MockKeychain();
      (keychainModule as unknown as { platformKeychain: MockKeychain }).platformKeychain = keychain;
      const output: string[] = [];
      const ctx = commandContext(home, codexHome, output);
      const old = document('compromised-old');
      const newer = document('compromised-newer');
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(old), { mode: 0o600 });
      const admitted = openStore(join(home, 'qlb.db'));
      beginCutover(admitted, 1);
      const plan = importActiveCodexSlot(old, { store: admitted, keychain, now: () => 1 });
      importActiveCodexSlot(newer, { store: admitted, keychain, now: () => 2 });
      admitted.close();

      let writes = 0;
      await assert.rejects(
        runCodexImportActiveCommand([], ctx, {
          withAuthLock: withCodexAuthLock,
          readAuth: async () => {
            // Model a stale-lock successor replacing the directory after the
            // holder's read but before its only auth.json publication.
            const lock = codexAuthLockDir({ home });
            rmSync(lock, { recursive: true });
            mkdirSync(lock);
            return { status: 'ok', doc: old };
          },
          writeAuth: async () => { writes += 1; return 1; },
        }),
        (error: unknown) => error instanceof CodexAuthLockCompromised && error.retryable,
      );
      assert.equal(writes, 0);
      const slot = openStore(join(home, 'qlb.db'));
      try {
        assert.equal(slot.getCodexSlot(plan.slotId)?.fingerprint, codexFingerprint(newer));
      } finally { slot.close(); }
    } finally {
      (keychainModule as unknown as { platformKeychain: typeof originalPlatformKeychain }).platformKeychain = originalPlatformKeychain;
      rmSync(home, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('a stalled import-active that lost the lock cannot overwrite active_login after the successor completes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-import-lost-active-home-'));
    const codexHome = mkdtempSync(join(tmpdir(), 'qlb-codex-import-lost-active-auth-'));
    const originalPlatformKeychain = keychainModule.platformKeychain;
    try {
      const keychain = new MockKeychain();
      (keychainModule as unknown as { platformKeychain: MockKeychain }).platformKeychain = keychain;
      const output: string[] = [];
      const ctx = commandContext(home, codexHome, output);
      const a = document('lost-active-a', 'account-a');
      const b = document('lost-active-b', 'account-b');
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(a), { mode: 0o600 });
      const store = openStore(join(home, 'qlb.db'));
      beginCutover(store, 1);
      const aPlan = importActiveCodexSlot(a, { store, keychain, now: () => 1 });
      importActiveCodexSlot(b, { store, keychain, now: () => 2 });
      store.close();

      await assert.rejects(
        runCodexImportActiveCommand([], ctx, {
          readAuth: async () => ({ status: 'ok', doc: a }),
          writeAuth: async () => 1,
          withAuthLock: async (_options, fn) => fn({
            assertNotCompromised: () => { throw new CodexAuthLockCompromised(); },
          }),
        }),
        (error: unknown) => error instanceof CodexAuthLockCompromised && error.retryable,
      );
      const result = openStore(join(home, 'qlb.db'));
      try {
        assert.equal(result.getCodexActiveLogin(), 'fixture-user:account-b');
        assert.equal(result.getCodexSlot(aPlan.slotId)?.fingerprint, codexFingerprint(a));
      } finally { result.close(); }
    } finally {
      (keychainModule as unknown as { platformKeychain: typeof originalPlatformKeychain }).platformKeychain = originalPlatformKeychain;
      rmSync(home, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('serializes a second import after re-validation until repaired-slot publication completes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-import-lock-home-'));
    const codexHome = mkdtempSync(join(tmpdir(), 'qlb-codex-import-lock-auth-'));
    const originalPlatformKeychain = keychainModule.platformKeychain;
    let releasePublication: (() => void) | undefined;
    const publicationReached = new Promise<void>((resolve) => { releasePublication = resolve; });
    let allowPublication: (() => void) | undefined;
    const publicationAllowed = new Promise<void>((resolve) => { allowPublication = resolve; });
    try {
      const keychain = new MockKeychain();
      (keychainModule as unknown as { platformKeychain: MockKeychain }).platformKeychain = keychain;
      const output: string[] = [];
      const ctx = commandContext(home, codexHome, output);
      const old = document('lock-old');
      const repaired = document('lock-repaired');
      const newer = document('lock-newer');
      const authPath = join(codexHome, 'auth.json');
      writeFileSync(authPath, JSON.stringify(old), { mode: 0o600 });
      const admitted = openStore(join(home, 'qlb.db'));
      beginCutover(admitted, 1);
      const plan = importActiveCodexSlot(old, { store: admitted, keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      admitted.adoptCodexSlot({
        accountId: plan.slotId,
        previousFingerprint: codexFingerprint(old),
        fingerprint: codexFingerprint(repaired),
        ts: 2,
        evidence: 'identity',
      });
      keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(repaired));
      admitted.close();

      const withAuthLock: CodexImportActiveCommandDeps['withAuthLock'] = async <T,>(
        options: import('../src/cc-locks').CodexAuthLockOptions,
        fn: (held: import('../src/cc-locks').HeldCodexAuthLock) => Promise<T> | T,
      ): Promise<T> => withCodexAuthLock({ ...options, retryMinMs: 1, retryJitterMs: 0 }, fn);
      let reads = 0;
      let republished = false;
      const writes: string[] = [];
      const deps: CodexImportActiveCommandDeps = {
        withAuthLock,
        readAuth: async () => {
          reads += 1;
          if (reads === 1) return { status: 'ok', doc: old };
          // The second flow cannot make its newer adoption until the first has
          // released the QLB lock. This represents its fresh native observation.
          assert.equal(republished, true);
          writeFileSync(authPath, JSON.stringify(newer), { mode: 0o600 });
          return { status: 'ok', doc: newer };
        },
        writeAuth: async (_path, doc) => {
          writes.push(codexFingerprint(doc));
          assert.equal(codexFingerprint(doc), codexFingerprint(repaired));
          releasePublication?.();
          await publicationAllowed;
          republished = true;
          writeFileSync(authPath, JSON.stringify(doc), { mode: 0o600 });
          return 1;
        },
      };

      const first = runCodexImportActiveCommand([], ctx, deps);
      await publicationReached;
      // This starts after re-validation but cannot read/adopt until the first
      // flow's protected publish and mark-imported-active have completed.
      const second = runCodexImportActiveCommand([], ctx, deps);
      await Promise.resolve();
      assert.equal(reads, 1);
      allowPublication?.();
      assert.equal(await first, 0);
      assert.equal(await second, 0);

      const finalStore = openStore(join(home, 'qlb.db'));
      try {
        assert.equal(finalStore.getCodexSlot(plan.slotId)?.fingerprint, codexFingerprint(newer));
      } finally {
        finalStore.close();
      }
      assert.equal(codexFingerprint(JSON.parse(readFileSync(authPath, 'utf8'))), codexFingerprint(newer));
      assert.deepEqual(writes, [codexFingerprint(repaired)]);
    } finally {
      (keychainModule as unknown as { platformKeychain: typeof originalPlatformKeychain }).platformKeychain = originalPlatformKeychain;
      rmSync(home, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('restores a split repair when its database verification fails after the Keychain write', async () => {
    const h = fixture();
    try {
      const old = document('split-repair-old');
      const stale = document('split-repair-stale');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      h.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(stale));
      const raw = (h.store as unknown as { db: DatabaseSync }).db;
      let fingerprintReads = 0;
      (h.store as unknown as { db: DatabaseSync }).db = new Proxy(raw, {
        get(target, property, receiver) {
          if (property === 'prepare') return (sql: string) => {
            if (sql === 'SELECT fingerprint FROM codex_slots WHERE account_id = ?') {
              fingerprintReads += 1;
              if (fingerprintReads === 3) throw new Error('fixture repair database failure after Keychain write');
            }
            return target.prepare(sql);
          };
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      await assert.rejects(attributeLiveDocument({
        store: h.store, keychain: h.keychain,
        slot: { accountId: plan.slotId, document: stale, fingerprint: codexFingerprint(old) }, live: old, now: () => 2,
      }), /fixture repair database failure after Keychain write/);
      assert.equal(h.store.getCodexSlot(plan.slotId)?.fingerprint, codexFingerprint(old));
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(stale));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('republishes the managed slot, without copying the older live document back, when the slot is newer', async () => {
    const h = fixture();
    try {
      const oldLive = document('live-a0');
      const slot = document('slot-a1');
      const plan = importActiveCodexSlot(oldLive, { store: h.store, keychain: h.keychain, now: () => 1 });
      importActiveCodexSlot(slot, { store: h.store, keychain: h.keychain, now: () => 2 });
      h.store.setCodexActiveLogin('fixture-user:other-account', 3);
      const published: string[] = [];

      const result = await attributeLiveDocument({
        store: h.store,
        keychain: h.keychain,
        slot: { accountId: plan.slotId, document: slot },
        live: oldLive,
        republish: (doc: ReturnType<typeof document>) => { published.push(codexFingerprint(doc)); },
      });

      assert.equal(result.action, 'republish-slot');
      assert.deepEqual(published, [codexFingerprint(slot)]);
      const db = new DatabaseSync(join(h.home, 'qlb.db'), { readOnly: true });
      const active = db.prepare("SELECT account_id, set_by FROM active_login WHERE provider = 'openai-codex'").get() as { account_id: string; set_by: string };
      db.close();
      assert.deepEqual({ ...active }, { account_id: plan.slotId, set_by: 'import' });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(slot));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });
});

type SaveHooks = {
  beforeSave?: (db: DatabaseSync, dbPath: string, slotId: string) => undefined;
  beforeSaveCommit?: (db: DatabaseSync, kind: 'existing-mark' | 'existing-adopt') => undefined;
};

// @ts-expect-error async save hooks return Promise<undefined>, not undefined.
const rejectedAsyncBeforeSave: NonNullable<SaveHooks['beforeSave']> = async () => undefined;
void rejectedAsyncBeforeSave;

function withSaveHooks<T>(input: T, hooks: SaveHooks): T & SaveHooks {
  return { ...input, ...hooks };
}

describe('Codex attribution final save hooks (C3c-S9)', () => {
  it('beforeSave runs inside the final save before its first write (a backup taken in it verifies)', async () => {
    const h = fixture();
    try {
      const saved = document('before-save-backup');
      const plan = importActiveCodexSlot(saved, { store: h.store, keychain: h.keychain, now: () => 1 });
      let backupPath: string | undefined;
      const result = await attributeLiveDocument(withSaveHooks({
        store: h.store, keychain: h.keychain, slot: { accountId: plan.slotId, document: saved }, live: saved, now: () => 2,
      }, {
        beforeSave: (db, dbPath, slotId) => {
          assert.equal(slotId, plan.slotId);
          assert.equal(db.isTransaction, true);
          backupPath = backupBeforeMigrateSync(dbPath, db);
        },
      }));
      assert.equal(result.action, 'noop');
      assert.ok(backupPath);
      assert.equal(existsSync(backupPath), true);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a beforeSave throw on noop leaves slot and active_login unchanged', async () => {
    const h = fixture();
    try {
      const saved = document('before-save-noop');
      const plan = importActiveCodexSlot(saved, { store: h.store, keychain: h.keychain, now: () => 1 });
      const db = (h.store as unknown as { db: DatabaseSync }).db;
      db.prepare('UPDATE codex_slots SET pending_adopt = 1, archived_at = ? WHERE account_id = ?').run(9, plan.slotId);
      db.prepare("DELETE FROM active_login WHERE provider = 'openai-codex'").run();
      await assert.rejects(attributeLiveDocument(withSaveHooks({
        store: h.store, keychain: h.keychain, slot: { accountId: plan.slotId, document: saved }, live: saved, now: () => 2,
      }, { beforeSave: () => { throw new Error('fixture before-save noop failure'); } })), /fixture before-save noop failure/);
      assert.deepEqual({ ...db.prepare('SELECT pending_adopt, archived_at FROM codex_slots WHERE account_id = ?').get(plan.slotId) }, { pending_adopt: 1, archived_at: 9 });
      assert.equal(db.prepare("SELECT 1 FROM active_login WHERE provider = 'openai-codex'").get(), undefined);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a beforeSave throw on adopt writes no Keychain item and no slot change', async () => {
    const h = fixture();
    try {
      const old = document('before-save-adopt-old');
      const live = document('before-save-adopt-live');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      const service = qlbKeychainService('openai-codex', plan.slotId);
      await assert.rejects(attributeLiveDocument(withSaveHooks({
        store: h.store, keychain: h.keychain,
        slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) }, live, now: () => 2,
      }, { beforeSave: () => { throw new Error('fixture before-save adopt failure'); } })), /fixture before-save adopt failure/);
      assert.equal(h.store.getCodexSlot(plan.slotId)?.fingerprint, codexFingerprint(old));
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(old));
      assert.throws(() => h.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT), /item not found/);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a compare-and-set miss never calls beforeSave', async () => {
    const h = fixture();
    try {
      const saved = document('before-save-cas');
      const plan = importActiveCodexSlot(saved, { store: h.store, keychain: h.keychain, now: () => 1 });
      (h.store as unknown as { db: DatabaseSync }).db.prepare('UPDATE codex_slots SET fingerprint = ? WHERE account_id = ?')
        .run('different-fingerprint', plan.slotId);
      let calls = 0;
      await assert.rejects(attributeLiveDocument(withSaveHooks({
        store: h.store, keychain: h.keychain,
        slot: { accountId: plan.slotId, document: saved, fingerprint: codexFingerprint(saved) }, live: saved, now: () => 2,
      }, { beforeSave: () => { calls += 1; } })), CodexAuthLockCompromised);
      assert.equal(calls, 0);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('drift passes the drift slot id', async () => {
    const h = fixture();
    try {
      const a = document('before-save-drift-a', 'account-a');
      const b = document('before-save-drift-b', 'account-b');
      const aPlan = importActiveCodexSlot(a, { store: h.store, keychain: h.keychain, now: () => 1 });
      const bPlan = importActiveCodexSlot(b, { store: h.store, keychain: h.keychain, now: () => 2 });
      const ids: string[] = [];
      const result = await attributeLiveDocument(withSaveHooks({
        store: h.store, keychain: h.keychain,
        slot: { accountId: bPlan.slotId, document: b, fingerprint: codexFingerprint(b) }, live: a, now: () => 3,
      }, { beforeSave: (_db, _dbPath, slotId) => { ids.push(slotId); } }));
      assert.equal(result.action, 'drift');
      assert.deepEqual(ids, [aPlan.slotId]);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('the repair transaction never calls beforeSave', async () => {
    const h = fixture();
    try {
      const old = document('before-save-repair-old');
      const stale = document('before-save-repair-stale');
      const live = document('before-save-repair-live');
      const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
      let calls = 0;
      const result = await attributeLiveDocument(withSaveHooks({
        store: h.store, keychain: h.keychain,
        slot: { accountId: plan.slotId, document: stale, fingerprint: codexFingerprint(old) }, live,
      }, { beforeSave: () => { calls += 1; } }));
      assert.equal(result.action, 'slot-split');
      assert.equal(calls, 0);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('beforeSaveCommit runs after the save\'s last write in the same transaction with kind existing-mark or existing-adopt', async () => {
    const h = fixture();
    try {
      const mark = document('before-commit-mark');
      const markPlan = importActiveCodexSlot(mark, { store: h.store, keychain: h.keychain, now: () => 1 });
      const markKinds: string[] = [];
      await attributeLiveDocument(withSaveHooks({
        store: h.store, keychain: h.keychain, slot: { accountId: markPlan.slotId, document: mark }, live: mark, now: () => 2,
      }, { beforeSaveCommit: (db, kind) => {
        markKinds.push(kind);
        assert.equal(db.isTransaction, true);
        assert.notEqual(db.prepare("SELECT account_id FROM active_login WHERE provider = 'openai-codex'").get(), undefined);
      } }));
      const old = document('before-commit-adopt-old', 'account-adopt');
      const live = document('before-commit-adopt-live', 'account-adopt');
      const adoptPlan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 3 });
      const adoptKinds: string[] = [];
      await attributeLiveDocument(withSaveHooks({
        store: h.store, keychain: h.keychain,
        slot: { accountId: adoptPlan.slotId, document: old, fingerprint: codexFingerprint(old) }, live, now: () => 4,
      }, { beforeSaveCommit: (db, kind) => {
        adoptKinds.push(kind);
        assert.equal(db.isTransaction, true);
        assert.notEqual(db.prepare('SELECT 1 FROM lineage_log WHERE account_id = ? AND to_fp = ?').get(adoptPlan.slotId, codexFingerprint(live)), undefined);
      } }));
      assert.deepEqual(markKinds, ['existing-mark']);
      assert.deepEqual(adoptKinds, ['existing-adopt']);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a beforeSaveCommit throw rolls the whole save back', async () => {
    const h = fixture();
    try {
      const saved = document('before-commit-rollback');
      const plan = importActiveCodexSlot(saved, { store: h.store, keychain: h.keychain, now: () => 1 });
      const db = (h.store as unknown as { db: DatabaseSync }).db;
      db.prepare('UPDATE codex_slots SET pending_adopt = 1, archived_at = ? WHERE account_id = ?').run(9, plan.slotId);
      db.prepare("DELETE FROM active_login WHERE provider = 'openai-codex'").run();
      await assert.rejects(attributeLiveDocument(withSaveHooks({
        store: h.store, keychain: h.keychain, slot: { accountId: plan.slotId, document: saved }, live: saved, now: () => 2,
      }, { beforeSaveCommit: () => { throw new Error('fixture before-commit failure'); } })), /fixture before-commit failure/);
      assert.deepEqual({ ...db.prepare('SELECT pending_adopt, archived_at FROM codex_slots WHERE account_id = ?').get(plan.slotId) }, { pending_adopt: 1, archived_at: 9 });
      assert.equal(db.prepare("SELECT 1 FROM active_login WHERE provider = 'openai-codex'").get(), undefined);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('lock loss during beforeSave aborts the save before its first write', async () => {
    for (const action of ['mark', 'adopt'] as const) {
      const h = fixture();
      try {
        const old = document(`lock-before-save-${action}-old`);
        const live = document(`lock-before-save-${action}-live`);
        const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
        const service = qlbKeychainService('openai-codex', plan.slotId);
        const db = (h.store as unknown as { db: DatabaseSync }).db;
        let slotWrites = 0;
        (h.store as unknown as { db: DatabaseSync }).db = new Proxy(db, {
          get(target, property, receiver) {
            if (property === 'prepare') return (sql: string) => {
              if (sql.startsWith('UPDATE codex_slots')) slotWrites += 1;
              return target.prepare(sql);
            };
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        let compromised = false;
        const assertNotCompromised = () => {
          if (compromised) {
            assert.equal(slotWrites, 0, 'a compromised lock must be checked before the first slot write');
            throw new CodexAuthLockCompromised();
          }
        };
        const initialSlot = h.store.getCodexSlot(plan.slotId);
        const initialActive = h.store.getCodexActiveLogin();
        await assert.rejects(attributeLiveDocument(withSaveHooks({
          store: h.store, keychain: h.keychain,
          slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) },
          live: action === 'mark' ? old : live, now: () => 2, assertNotCompromised,
        }, { beforeSave: () => { compromised = true; } })), CodexAuthLockCompromised);
        assert.deepEqual(h.store.getCodexSlot(plan.slotId), initialSlot);
        assert.equal(h.store.getCodexActiveLogin(), initialActive);
        if (action === 'adopt') {
          assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(old));
          assert.throws(() => h.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT), /item not found/);
        }
      } finally {
        h.store.close();
        rmSync(h.home, { recursive: true, force: true });
      }
    }
  });

  it('lock loss during beforeSaveCommit rolls the whole save back', async () => {
    for (const action of ['mark', 'adopt'] as const) {
      const h = fixture();
      try {
        const old = document(`lock-before-commit-${action}-old`);
        const live = document(`lock-before-commit-${action}-live`);
        const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
        const service = qlbKeychainService('openai-codex', plan.slotId);
        const initialSlot = h.store.getCodexSlot(plan.slotId);
        const initialActive = h.store.getCodexActiveLogin();
        let compromised = false;
        const assertNotCompromised = () => {
          if (compromised) throw new CodexAuthLockCompromised();
        };
        await assert.rejects(attributeLiveDocument(withSaveHooks({
          store: h.store, keychain: h.keychain,
          slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) },
          live: action === 'mark' ? old : live, now: () => 2, assertNotCompromised,
        }, { beforeSaveCommit: () => { compromised = true; } })), CodexAuthLockCompromised);
        assert.deepEqual(h.store.getCodexSlot(plan.slotId), initialSlot);
        assert.equal(h.store.getCodexActiveLogin(), initialActive);
        if (action === 'adopt') {
          assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(old));
          assert.throws(() => h.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT), /item not found/);
        }
      } finally {
        h.store.close();
        rmSync(h.home, { recursive: true, force: true });
      }
    }
  });

  it('an async beforeSave is refused and nothing is saved', async () => {
    for (const action of ['mark', 'adopt'] as const) {
      const h = fixture();
      try {
        const old = document(`async-before-save-${action}-old`);
        const live = document(`async-before-save-${action}-live`);
        const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
        const initialSlot = h.store.getCodexSlot(plan.slotId);
        const initialActive = h.store.getCodexActiveLogin();
        await assert.rejects(attributeLiveDocument(withSaveHooks({
          store: h.store, keychain: h.keychain,
          slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) }, live: action === 'mark' ? old : live, now: () => 2,
        }, { beforeSave: (async () => undefined) as unknown as NonNullable<SaveHooks['beforeSave']> })), /Codex save hooks must be synchronous/);
        assert.deepEqual(h.store.getCodexSlot(plan.slotId), initialSlot);
        assert.equal(h.store.getCodexActiveLogin(), initialActive);
      } finally {
        h.store.close();
        rmSync(h.home, { recursive: true, force: true });
      }
    }
  });

  it('an async beforeSaveCommit is refused and nothing is saved', async () => {
    for (const action of ['mark', 'adopt'] as const) {
      const h = fixture();
      try {
        const old = document(`async-before-save-commit-${action}-old`);
        const live = document(`async-before-save-commit-${action}-live`);
        const plan = importActiveCodexSlot(old, { store: h.store, keychain: h.keychain, now: () => 1 });
        const initialSlot = h.store.getCodexSlot(plan.slotId);
        const initialActive = h.store.getCodexActiveLogin();
        await assert.rejects(attributeLiveDocument(withSaveHooks({
          store: h.store, keychain: h.keychain,
          slot: { accountId: plan.slotId, document: old, fingerprint: codexFingerprint(old) }, live: action === 'mark' ? old : live, now: () => 2,
        }, { beforeSaveCommit: (async () => undefined) as unknown as NonNullable<SaveHooks['beforeSaveCommit']> })), /Codex save hooks must be synchronous/);
        assert.deepEqual(h.store.getCodexSlot(plan.slotId), initialSlot);
        assert.equal(h.store.getCodexActiveLogin(), initialActive);
      } finally {
        h.store.close();
        rmSync(h.home, { recursive: true, force: true });
      }
    }
  });

  it('a refused async hook whose promise later rejects has no unhandled rejection', async () => {
    const h = fixture();
    let unhandled: unknown;
    const onUnhandledRejection = (reason: unknown) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const saved = document('async-before-save-later-rejection');
      const plan = importActiveCodexSlot(saved, { store: h.store, keychain: h.keychain, now: () => 1 });
      await assert.rejects(attributeLiveDocument(withSaveHooks({
        store: h.store, keychain: h.keychain, slot: { accountId: plan.slotId, document: saved }, live: saved, now: () => 2,
      }, {
        beforeSave: (async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          throw new Error('fixture rejected after refusal');
        }) as unknown as NonNullable<SaveHooks['beforeSave']>,
      })), /Codex save hooks must be synchronous/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(unhandled, undefined);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });
});
