import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { codexFingerprint, parseCodexAuth } from '../src/codex-auth';
import { createCodexAdapter } from '../src/adapters/codex';
import {
  KeychainBackedOff,
  KeychainReadBackoff,
  MockKeychain,
  QLB_KEYCHAIN_ACCOUNT,
  qlbKeychainService,
} from '../src/keychain';
import { CodexSlots, codexHeaderAccountId, importActiveCodexSlot, planImportActiveCodex } from '../src/codex-slots';
import { snapshotsFromStore } from '../src/resolve';
import { openStore } from '../src/store';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(refresh = 'fixture-refresh-token') {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({
        'https://api.openai.com/auth': {
          chatgpt_user_id: 'fixture-user',
          chatgpt_account_id: 'fixture-account',
        },
      }),
      access_token: jwt({ exp: 2_000_000_000 }),
      refresh_token: refresh,
      account_id: 'fixture-account',
    },
  };
}

function parsedDocument(refresh?: string) {
  const parsed = parseCodexAuth(JSON.stringify(document(refresh)));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture must parse');
  return parsed.doc;
}

function parsedDocumentWithAccountIds(tokensAccountId: string | undefined, claimAccountId: string | undefined) {
  const claims: Record<string, string> = { chatgpt_user_id: 'fixture-user' };
  if (claimAccountId !== undefined) claims.chatgpt_account_id = claimAccountId;
  const doc: { auth_mode: string; tokens: Record<string, unknown> } = document();
  doc.tokens.id_token = jwt({ 'https://api.openai.com/auth': claims });
  if (tokensAccountId === undefined) delete doc.tokens.account_id;
  else doc.tokens.account_id = tokensAccountId;
  const parsed = parseCodexAuth(JSON.stringify(doc));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture must parse');
  return parsed.doc;
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'qlb-codex-slots-'));
  const store = openStore(join(home, 'qlb.db'));
  return { home, store, keychain: new MockKeychain() };
}

class CountingKeychain extends MockKeychain {
  gets = 0;
  unavailable = false;

  override getSync(service: string, account: string): string {
    this.gets += 1;
    if (this.unavailable) throw new Error('fixture unavailable');
    return super.getSync(service, account);
  }
}

function plain(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return row && { ...row };
}

function dbRows(path: string): { slot: Record<string, unknown> | undefined; account: Record<string, unknown> | undefined; active: Record<string, unknown> | undefined; lineage: Record<string, unknown> | undefined; baseline: string | undefined } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      slot: plain(db.prepare('SELECT account_id, chatgpt_user_id, chatgpt_account_id, source FROM codex_slots').get() as Record<string, unknown> | undefined),
      account: plain(db.prepare("SELECT id, provider, status FROM accounts WHERE id = 'fixture-user:fixture-account'").get() as Record<string, unknown> | undefined),
      active: plain(db.prepare("SELECT provider, account_id, set_by FROM active_login WHERE provider = 'openai-codex'").get() as Record<string, unknown> | undefined),
      lineage: plain(db.prepare("SELECT provider, account_id, cause, by, evidence FROM lineage_log WHERE provider = 'openai-codex'").get() as Record<string, unknown> | undefined),
      baseline: (db.prepare("SELECT value FROM config WHERE key = 'pi.openai-codex.baselineConsumedBy'").get() as { value?: string } | undefined)?.value,
    };
  } finally {
    db.close();
  }
}

describe('Codex slots and import-active', () => {
  it('codex-default yields no header even with no slot row', () => {
    let lookups = 0;
    assert.equal(codexHeaderAccountId(() => {
      lookups += 1;
      return undefined;
    }, 'codex-default'), undefined);
    assert.equal(lookups, 0);
  });

  it('a null lookup falls through to the suffix/bare header rule', () => {
    assert.equal(codexHeaderAccountId(null, 'user:legacy-account'), 'legacy-account');
    assert.equal(codexHeaderAccountId(null, 'bare-legacy-account'), 'bare-legacy-account');
  });

  it("header value is the slot's chatgpt_account_id, else the slot-id suffix, else a bare id", () => {
    const slot = {
      accountId: 'user:slot-account',
      chatgptUserId: 'user',
      chatgptAccountId: 'stored-account',
      fingerprint: null,
      prevFingerprint: null,
      dead: false,
    };
    assert.equal(codexHeaderAccountId((id) => id === slot.accountId ? slot : undefined, slot.accountId), 'stored-account');
    assert.equal(codexHeaderAccountId(() => undefined, 'user:legacy-account:extra'), 'legacy-account:extra');
    assert.equal(codexHeaderAccountId(() => undefined, 'bare-legacy-account'), 'bare-legacy-account');
  });

  it('plans an S29 slot without writing credentials or the store', () => {
    const h = fixture();
    try {
      const plan = planImportActiveCodex(parsedDocument());
      assert.deepEqual(plan, {
        chatgptUserId: 'fixture-user',
        accountId: 'fixture-account',
        slotId: 'fixture-user:fixture-account',
      });
      assert.throws(() => h.keychain.getSync(qlbKeychainService('openai-codex', plan.slotId), QLB_KEYCHAIN_ACCOUNT));
      assert.deepEqual(dbRows(h.store.dbPath), { slot: undefined, account: undefined, active: undefined, lineage: undefined, baseline: undefined });
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('import-active renames the bare row to the slot id with readings, pins, lease and failover pointer (file-backed)', () => {
    const h = fixture();
    try {
      // This is an adapter-era bare-id row. Import moves it and its dependents to the S29 slot id.
      h.store.upsertAccount('fixture-account', 'openai-codex', 'adapter-owned label', 'active');
      const seed = (h.store as unknown as { db: DatabaseSync }).db;
      seed.prepare(`INSERT INTO snapshots (account_id, bucket, used_pct, fetched_at)
        VALUES ('fixture-account', 'primary', 12, 1)`).run();
      seed.prepare(`INSERT INTO overrides (kind, account_id, session, until)
        VALUES ('pin', 'fixture-account', 'fixture-session', 2)`).run();
      seed.prepare(`INSERT INTO leases (name, holder_pid, holder_id, until, generation)
        VALUES ('refresh:fixture-account', 1, 'fixture-holder', 1699999999999, 0)`).run();
      seed.prepare(`INSERT INTO config (key, value)
        VALUES ('failover:openai-codex', 'fixture-account')`).run();
      const result = importActiveCodexSlot(parsedDocument(), {
        store: h.store,
        keychain: h.keychain,
        now: () => 1_700_000_000_000,
        piBaseline: { type: 'oauth', refresh: 'fixture-refresh-token' },
      });
      assert.equal(result.slotId, 'fixture-user:fixture-account');
      assert.doesNotThrow(() => h.keychain.getSync(qlbKeychainService('openai-codex', result.slotId), QLB_KEYCHAIN_ACCOUNT));
      assert.deepEqual(dbRows(h.store.dbPath), {
        slot: { account_id: 'fixture-user:fixture-account', chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account', source: 'import-active' },
        account: { id: 'fixture-user:fixture-account', provider: 'openai-codex', status: 'active' },
        active: { provider: 'openai-codex', account_id: 'fixture-user:fixture-account', set_by: 'import' },
        lineage: { provider: 'openai-codex', account_id: 'fixture-user:fixture-account', cause: 'import', by: 'qlb-cli', evidence: 'import' },
        baseline: 'fixture-user:fixture-account',
      });
      const db = new DatabaseSync(h.store.dbPath, { readOnly: true });
      try {
        const slotId = 'fixture-user:fixture-account';
        assert.equal((db.prepare("SELECT count(*) AS count FROM accounts WHERE provider = 'openai-codex'").get() as { count: number }).count, 1);
        assert.equal((db.prepare('SELECT id FROM accounts WHERE id = ?').get(slotId) as { id: string }).id, slotId);
        assert.equal((db.prepare('SELECT account_id FROM snapshots WHERE bucket = ?').get('primary') as { account_id: string }).account_id, slotId);
        assert.equal((db.prepare('SELECT account_id FROM overrides WHERE kind = ?').get('pin') as { account_id: string }).account_id, slotId);
        assert.equal((db.prepare('SELECT name FROM leases').get() as { name: string }).name, `refresh:${slotId}`);
        assert.equal((db.prepare('SELECT value FROM config WHERE key = ?').get('failover:openai-codex') as { value: string }).value, slotId);
        assert.equal((db.prepare(`SELECT count(*) AS count FROM accounts WHERE id = 'fixture-account'`).get() as { count: number }).count, 0);
        assert.equal((db.prepare(`SELECT count(*) AS count FROM snapshots WHERE account_id = 'fixture-account'`).get() as { count: number }).count, 0);
        assert.equal((db.prepare(`SELECT count(*) AS count FROM overrides WHERE account_id = 'fixture-account'`).get() as { count: number }).count, 0);
        assert.equal((db.prepare(`SELECT count(*) AS count FROM leases WHERE name = 'refresh:fixture-account'`).get() as { count: number }).count, 0);
        assert.equal((db.prepare(`SELECT count(*) AS count FROM config WHERE key = 'failover:openai-codex' AND value = 'fixture-account'`).get() as { count: number }).count, 0);
        assert.deepEqual(snapshotsFromStore(h.store, 'openai-codex').map((snapshot) => snapshot.accountId), [slotId]);
      } finally {
        db.close();
      }
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('uses the token account id for import-active while the adapter writes no account row', async () => {
    const h = fixture();
    try {
      const doc = parsedDocumentWithAccountIds('token-account', undefined);
      const plan = importActiveCodexSlot(doc, { store: h.store, keychain: h.keychain });
      const adapter = createCodexAdapter({
        authPath: join(h.home, 'auth.json'),
        readAuth: async () => JSON.stringify(doc),
      });

      const [snapshot] = await adapter.fetchSnapshots();
      assert.equal(plan.accountId, 'token-account');
      assert.equal(snapshot?.accountId, plan.slotId);
      const db = new DatabaseSync(h.store.dbPath, { readOnly: true });
      try {
        assert.deepEqual(
          (db.prepare("SELECT id FROM accounts WHERE provider = 'openai-codex' ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id),
          ['fixture-user:token-account'],
        );
      } finally {
        db.close();
      }
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('prefers the token account id over a differing id-token claim in both paths', async () => {
    const h = fixture();
    try {
      const doc = parsedDocumentWithAccountIds('token-account', 'claim-account');
      const adapter = createCodexAdapter({
        authPath: join(h.home, 'auth.json'),
        readAuth: async () => JSON.stringify(doc),
      });

      assert.equal(planImportActiveCodex(doc).accountId, 'token-account');
      assert.equal((await adapter.fetchSnapshots())[0]?.accountId, 'fixture-user:token-account');
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('keeps the id-token account claim fallback when tokens.account_id is absent', async () => {
    const h = fixture();
    try {
      const doc = parsedDocumentWithAccountIds(undefined, 'claim-account');
      const adapter = createCodexAdapter({
        authPath: join(h.home, 'auth.json'),
        readAuth: async () => JSON.stringify(doc),
      });

      assert.equal(planImportActiveCodex(doc).accountId, 'claim-account');
      assert.equal((await adapter.fetchSnapshots())[0]?.accountId, 'fixture-user:claim-account');
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('preserves a prior managed document as :prev when re-importing a successor', () => {
    const h = fixture();
    try {
      const first = importActiveCodexSlot(parsedDocument('first-refresh'), { store: h.store, keychain: h.keychain, now: () => 1 });
      importActiveCodexSlot(parsedDocument('second-refresh'), { store: h.store, keychain: h.keychain, now: () => 2 });
      const service = qlbKeychainService('openai-codex', first.slotId);
      assert.notEqual(
        h.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT),
        h.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT),
      );
      const db = new DatabaseSync(h.store.dbPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT prev_fingerprint FROM codex_slots WHERE account_id = ?').get(first.slotId) as { prev_fingerprint: string | null };
        assert.notEqual(row.prev_fingerprint, null);
        const transitions = db.prepare('SELECT count(*) AS count FROM lineage_log').get() as { count: number };
        assert.equal(transitions.count, 2);
      } finally {
        db.close();
      }
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('uses a sixty-second display cache, backs off failures, and lets fresh Codex reads bypass it', () => {
    let now = 1_000;
    const keychain = new CountingKeychain();
    const plan = planImportActiveCodex(parsedDocument());
    const service = qlbKeychainService('openai-codex', plan.slotId);
    keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(parsedDocument()));
    const slots = new CodexSlots({
      keychain,
      now: () => now,
      readBackoff: new KeychainReadBackoff({ now: () => now }),
    });

    assert.equal(slots.readSlot(plan.slotId).fingerprint, slots.readSlot(plan.slotId).fingerprint);
    assert.equal(keychain.gets, 1);
    now += 60_001;
    slots.readSlot(plan.slotId);
    assert.equal(keychain.gets, 2);

    keychain.unavailable = true;
    now += 60_001;
    assert.throws(() => slots.readSlot(plan.slotId), /fixture unavailable/);
    assert.throws(() => slots.readSlot(plan.slotId), KeychainBackedOff);
    keychain.unavailable = false;
    assert.equal(slots.readSlot(plan.slotId, { fresh: true }).fingerprint.length > 0, true);
    assert.equal(keychain.gets, 4);
  });

  it('does not arm the shared read backoff when an optional predecessor is absent', () => {
    const keychain = new CountingKeychain();
    const plan = planImportActiveCodex(parsedDocument());
    keychain.setSync(qlbKeychainService('openai-codex', plan.slotId), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(parsedDocument()));
    const slots = new CodexSlots({ keychain });

    assert.throws(() => slots.readPrevious(plan.slotId), /item not found/);
    assert.doesNotThrow(() => slots.readSlot(plan.slotId));
  });

  it('does not expose its cache-fill document for caller mutation', () => {
    const keychain = new MockKeychain();
    const plan = planImportActiveCodex(parsedDocument());
    keychain.setSync(qlbKeychainService('openai-codex', plan.slotId), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(parsedDocument('original-refresh')));
    const slots = new CodexSlots({ keychain });

    const first = slots.readSlot(plan.slotId);
    first.document.tokens.refresh_token = 'mutated-fixture-refresh';
    assert.equal(slots.readSlot(plan.slotId).document.tokens.refresh_token, 'original-refresh');
  });

  it('stores unclaimed native documents and restores the saved predecessor', () => {
    const keychain = new MockKeychain();
    const plan = planImportActiveCodex(parsedDocument());
    const service = qlbKeychainService('openai-codex', plan.slotId);
    const first = parsedDocument('first-refresh');
    const second = parsedDocument('second-refresh');
    const unclaimed = parsedDocument('unclaimed-refresh');
    keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(second));
    keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(first));
    const slots = new CodexSlots({ keychain });

    assert.equal(slots.readUnclaimed(slots.stashUnclaimed('fixture-time', unclaimed, codexFingerprint(second))).fingerprint, codexFingerprint(unclaimed));
    const restored = slots.restoreUnclaimed('fixture-time', codexFingerprint(second), (document) => {
      keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify(document));
    });
    assert.equal(restored.fingerprint, slots.readSlot(plan.slotId, { fresh: true }).fingerprint);
    assert.throws(() => slots.readUnclaimed('fixture-time', { fresh: true }), /item not found/);
    assert.equal(slots.readPrevious(plan.slotId, { fresh: true }).fingerprint, codexFingerprint(first));
  });

  it('refuses an unclaimed restore when its consumed lineage is absent or mismatched', () => {
    const keychain = new MockKeychain();
    const slots = new CodexSlots({ keychain });
    const current = parsedDocument('current-refresh');
    const unclaimed = parsedDocument('unclaimed-refresh');

    keychain.setSync(qlbKeychainService('openai-codex', 'unclaimed:legacy'), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(unclaimed));
    assert.throws(() => slots.restoreUnclaimed('legacy', codexFingerprint(current), () => {}), /unclaimed lineage mismatch/);

    slots.stashUnclaimed('mismatched', unclaimed, codexFingerprint(parsedDocument('other-refresh')));
    assert.throws(() => slots.restoreUnclaimed('mismatched', codexFingerprint(current), () => {}), /unclaimed lineage mismatch/);
  });

  it('unarchives an active re-import while preserving same-lineage death evidence and slot source', () => {
    const h = fixture();
    try {
      const first = parsedDocument('first-refresh');
      const next = parsedDocument('next-refresh');
      const plan = importActiveCodexSlot(first, { store: h.store, keychain: h.keychain });
      (h.store as unknown as { db: DatabaseSync }).db.prepare(`UPDATE codex_slots
        SET archived_at = 1, dead = 1, dead_reason = 'fixture-dead', dead_at = 2, healed_at = 3, source = 'qlb-add'
        WHERE account_id = ?`).run(plan.slotId);

      importActiveCodexSlot(first, { store: h.store, keychain: h.keychain });
      const sameLineage = { ...((h.store as unknown as { db: DatabaseSync }).db.prepare(`SELECT archived_at, dead, source
        FROM codex_slots WHERE account_id = ?`).get(plan.slotId) as { archived_at: number | null; dead: number; source: string }) };
      assert.deepEqual(sameLineage, { archived_at: null, dead: 1, source: 'qlb-add' });

      importActiveCodexSlot(next, { store: h.store, keychain: h.keychain });
      const successor = { ...((h.store as unknown as { db: DatabaseSync }).db.prepare(`SELECT dead, dead_reason, dead_at, healed_at, source
        FROM codex_slots WHERE account_id = ?`).get(plan.slotId) as { dead: number; dead_reason: string | null; dead_at: number | null; healed_at: number | null; source: string }) };
      assert.deepEqual(successor, { dead: 0, dead_reason: null, dead_at: null, healed_at: null, source: 'qlb-add' });
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('does not overwrite the predecessor after a failed database commit is retried', () => {
    const h = fixture();
    try {
      const first = parsedDocument('first-refresh');
      const second = parsedDocument('second-refresh');
      const plan = importActiveCodexSlot(first, { store: h.store, keychain: h.keychain });
      let rejectCommit = true;
      const withFailingCommit = <T>(_store: unknown, fn: (db: DatabaseSync) => T): T => {
        const db = (h.store as unknown as { db: DatabaseSync }).db;
        const proxy = new Proxy(db, {
          get(target, property, receiver) {
            if (property === 'exec') return (sql: string) => {
              if (sql === 'COMMIT' && rejectCommit) {
                rejectCommit = false;
                throw new Error('fixture commit failure');
              }
              return target.exec(sql);
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return fn(proxy);
      };
      assert.throws(() => importActiveCodexSlot(second, { store: h.store, keychain: h.keychain, withDb: withFailingCommit }), /fixture commit failure/);
      importActiveCodexSlot(second, { store: h.store, keychain: h.keychain });

      const service = qlbKeychainService('openai-codex', plan.slotId);
      const slots = new CodexSlots({ keychain: h.keychain });
      assert.equal(slots.readPrevious(plan.slotId).fingerprint, codexFingerprint(first));
      assert.equal(slots.readSlot(plan.slotId, { fresh: true }).fingerprint, codexFingerprint(second));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('rejects an auth document without the S29 identity before any write', () => {
    const h = fixture();
    try {
      const doc = parsedDocument();
      doc.tokens.id_token = jwt({ sub: 'not-an-S29-identity' });
      assert.throws(() => importActiveCodexSlot(doc, { store: h.store, keychain: h.keychain }), /S29 identity/);
      assert.deepEqual(dbRows(h.store.dbPath), { slot: undefined, account: undefined, active: undefined, lineage: undefined, baseline: undefined });
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('an emergency stash paused after the body and before the index is found by a concurrent locked consume, which adopts it and sends no POST', async () => {
    const h = fixture();
    let bodyWritten!: () => void;
    const bodyReady = new Promise<void>((resolve) => { bodyWritten = resolve; });
    let continueIndex!: () => void;
    const indexMayContinue = new Promise<void>((resolve) => { continueIndex = resolve; });
    try {
      const accountId = planImportActiveCodex(parsedDocument()).slotId;
      const successor = parsedDocument('emergency-successor');
      const slots = new CodexSlots({
        keychain: h.keychain,
        stashDir: join(h.home, 'stash'),
        emergencyStashAfterBody: async () => { bodyWritten(); await indexMayContinue; },
      });
      const write = slots.stashSuccessorEmergency(accountId, successor, codexFingerprint(parsedDocument('predecessor')), 1);
      await bodyReady;

      // findStashedSuccessor is the consume-path operation that skips its POST.
      const found = await slots.findStashedSuccessor(accountId, codexFingerprint(parsedDocument('predecessor')));
      assert.equal(found?.document.tokens.refresh_token, 'emergency-successor');
      continueIndex();
      await write;
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('an emergency stash killed before the index is discovered from its file and adopted', async () => {
    const h = fixture();
    let bodyWritten!: () => void;
    const bodyReady = new Promise<void>((resolve) => { bodyWritten = resolve; });
    let continueIndex!: () => void;
    const indexMayContinue = new Promise<void>((resolve) => { continueIndex = resolve; });
    try {
      const accountId = planImportActiveCodex(parsedDocument()).slotId;
      const predecessor = codexFingerprint(parsedDocument('predecessor'));
      const slots = new CodexSlots({
        keychain: h.keychain,
        stashDir: join(h.home, 'stash'),
        emergencyStashAfterBody: async () => { bodyWritten(); await indexMayContinue; },
      });
      const interruptedOwner = slots.stashSuccessorEmergency(accountId, parsedDocument('emergency-successor'), predecessor, 1);
      await bodyReady;

      const recovered = await new CodexSlots({ keychain: h.keychain, stashDir: join(h.home, 'stash') })
        .findStashedSuccessor(accountId, predecessor);
      assert.equal(recovered?.document.tokens.refresh_token, 'emergency-successor');
      continueIndex();
      await interruptedOwner;
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it("the owner's later index write after a concurrent adoption is harmless (EEXIST is success; no second body)", async () => {
    const h = fixture();
    let bodyWritten!: () => void;
    const bodyReady = new Promise<void>((resolve) => { bodyWritten = resolve; });
    let continueIndex!: () => void;
    const indexMayContinue = new Promise<void>((resolve) => { continueIndex = resolve; });
    try {
      const accountId = planImportActiveCodex(parsedDocument()).slotId;
      const predecessor = codexFingerprint(parsedDocument('predecessor'));
      const stashDir = join(h.home, 'stash');
      const slots = new CodexSlots({
        keychain: h.keychain,
        stashDir,
        emergencyStashAfterBody: async () => { bodyWritten(); await indexMayContinue; },
      });
      const owner = slots.stashSuccessorEmergency(accountId, parsedDocument('emergency-successor'), predecessor, 1);
      await bodyReady;
      const adopted = await slots.findStashedSuccessor(accountId, predecessor);
      assert.ok(adopted);
      continueIndex();
      await owner;
      assert.equal(readdirSync(stashDir).filter((name) => name.endsWith('.json')).length, 1);
      assert.equal(readdirSync(join(stashDir, 'index', 'openai-codex')).length, 1);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a -lost- reservation is never deleted as bodyless', async () => {
    const h = fixture();
    try {
      const accountId = planImportActiveCodex(parsedDocument()).slotId;
      const stashDir = join(h.home, 'stash');
      const slots = new CodexSlots({ keychain: h.keychain, stashDir });
      const { stashId } = await slots.stashSuccessorEmergency(
        accountId, parsedDocument('emergency-successor'), codexFingerprint(parsedDocument('predecessor')), 1,
      );
      rmSync(join(stashDir, `${stashId}.json`));

      assert.equal(await slots.findStashedSuccessor(accountId, codexFingerprint(parsedDocument('predecessor'))), null);
      assert.equal(existsSync(join(stashDir, 'index', 'openai-codex', `${stashId}.json`)), true);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a partial temp file is never read as a stash', async () => {
    const h = fixture();
    try {
      const accountId = planImportActiveCodex(parsedDocument()).slotId;
      const stashDir = join(h.home, 'stash');
      mkdirSync(stashDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(stashDir, 'anything-lost-deadbeef.json.tmp'), '{', { mode: 0o600 });

      const slots = new CodexSlots({ keychain: h.keychain, stashDir });
      assert.equal(await slots.findStashedSuccessor(accountId, codexFingerprint(parsedDocument('predecessor'))), null);
      assert.equal(existsSync(join(stashDir, 'index')), false);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('an unparseable orphan -lost- stash is neither adopted nor deleted', async () => {
    const h = fixture();
    try {
      const accountId = planImportActiveCodex(parsedDocument()).slotId;
      const stashDir = join(h.home, 'stash');
      const orphan = join(stashDir, 'corrupt-lost-deadbeef.json');
      mkdirSync(stashDir, { recursive: true, mode: 0o700 });
      writeFileSync(orphan, '{', { mode: 0o600 });

      const slots = new CodexSlots({ keychain: h.keychain, stashDir });
      assert.equal(await slots.findStashedSuccessor(accountId, codexFingerprint(parsedDocument('predecessor'))), null);
      assert.equal(existsSync(orphan), true);
      assert.equal(existsSync(join(stashDir, 'index')), false);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('an orphan -lost- stash for another account is neither adopted nor deleted', async () => {
    const h = fixture();
    let bodyWritten!: () => void;
    const bodyReady = new Promise<void>((resolve) => { bodyWritten = resolve; });
    let continueIndex!: () => void;
    const indexMayContinue = new Promise<void>((resolve) => { continueIndex = resolve; });
    try {
      const accountId = planImportActiveCodex(parsedDocument()).slotId;
      const otherAccountId = planImportActiveCodex(parsedDocumentWithAccountIds('other-account', 'other-account')).slotId;
      const stashDir = join(h.home, 'stash');
      const slots = new CodexSlots({
        keychain: h.keychain,
        stashDir,
        emergencyStashAfterBody: async () => { bodyWritten(); await indexMayContinue; },
      });
      const owner = slots.stashSuccessorEmergency(
        otherAccountId, parsedDocumentWithAccountIds('other-account', 'other-account'), codexFingerprint(parsedDocument('predecessor')), 1,
      );
      await bodyReady;

      assert.equal(await slots.findStashedSuccessor(accountId, codexFingerprint(parsedDocument('predecessor'))), null);
      assert.equal(readdirSync(stashDir).filter((name) => name.endsWith('.json')).length, 1);
      assert.equal(existsSync(join(stashDir, 'index')), false);
      continueIndex();
      await owner;
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('runs codex import-active --dry-run from CODEX_HOME without creating QLB state', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-import-home-'));
    const codexHome = mkdtempSync(join(tmpdir(), 'qlb-codex-import-auth-'));
    try {
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(document()), { mode: 0o600 });
      const result = spawnSync(process.execPath, [join(__dirname, '..', 'src', 'cli.js'), 'codex', 'import-active', '--dry-run', '--json'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          QLB_TEST_MODE: '1',
          QLB_HOME: home,
          HOME: home,
          CODEX_HOME: codexHome,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        chatgptUserId: 'fixture-user',
        accountId: 'fixture-account',
        slotId: 'fixture-user:fixture-account',
        dryRun: true,
      });
      assert.equal(existsSync(join(home, '.qlb')), false, 'dry run must not create QLB state');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
