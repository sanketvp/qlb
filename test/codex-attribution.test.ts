import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { attributeLiveDocument } from '../src/codex-attribution';
import { codexFingerprint, parseCodexAuth } from '../src/codex-auth';
import { importActiveCodexSlot } from '../src/codex-slots';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { openStore } from '../src/store';

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
