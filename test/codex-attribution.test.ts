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

function document(refresh: string) {
  const parsed = parseCodexAuth(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account' } }),
      access_token: jwt({ exp: 2_000_000_000 }),
      refresh_token: refresh,
      account_id: 'fixture-account',
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

  it('republishes the managed slot, without copying the older live document back, when the slot is newer', async () => {
    const h = fixture();
    try {
      const oldLive = document('live-a0');
      const slot = document('slot-a1');
      const plan = importActiveCodexSlot(oldLive, { store: h.store, keychain: h.keychain, now: () => 1 });
      importActiveCodexSlot(slot, { store: h.store, keychain: h.keychain, now: () => 2 });
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
      const service = qlbKeychainService('openai-codex', plan.slotId);
      assert.equal(codexFingerprint(JSON.parse(h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT))), codexFingerprint(slot));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });
});
