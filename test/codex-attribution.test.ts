import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import importActiveCommand from '../src/commands/codex-import-active';
import { attributeLiveDocument } from '../src/codex-attribution';
import { codexFingerprint, parseCodexAuth } from '../src/codex-auth';
import { importActiveCodexSlot } from '../src/codex-slots';
import * as keychainModule from '../src/keychain';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { openStore } from '../src/store';
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
