import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { parseCodexAuth } from '../src/codex-auth';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { importActiveCodexSlot, planImportActiveCodex } from '../src/codex-slots';
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

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'qlb-codex-slots-'));
  const store = openStore(join(home, 'qlb.db'));
  return { home, store, keychain: new MockKeychain() };
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

  it('imports the whole document, account rows, active identity, lineage, and a matching Pi baseline', () => {
    const h = fixture();
    try {
      h.store.upsertAccount('codex-default', 'openai-codex', 'legacy synthetic account', 'active');
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
        assert.equal(db.prepare("SELECT 1 FROM accounts WHERE id = 'codex-default'").get(), undefined);
      } finally {
        db.close();
      }
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
