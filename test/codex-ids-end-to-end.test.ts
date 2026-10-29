import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { createCodexAdapter } from '../src/adapters/codex';
import { parseCodexAuth, type CodexAuthDocument } from '../src/codex-auth';
import { importActiveCodexSlot } from '../src/codex-slots';
import { createOwnedCredentialSource, notOwnedError } from '../src/credentials';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import { beginCutover } from '../src/lifecycle';
import { decodeJournalEvidence } from '../src/migration-health';
import { setPolicy } from '../src/policy';
import { LoopbackProxy } from '../src/proxy';
import { openStore, type Store } from '../src/store';

const MODEL = 'gpt-5.4--qlb-high';
const BARE_ID = 'fixture-bare-account';
const SLOT_ID = 'fixture-user:fixture-bare-account';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
}

function document(): CodexAuthDocument {
  const parsed = parseCodexAuth(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({
        'https://api.openai.com/auth': {
          chatgpt_user_id: 'fixture-user',
          chatgpt_account_id: BARE_ID,
        },
      }),
      access_token: jwt({ exp: 2_000_000_000 }),
      refresh_token: 'fixture-refresh-token',
      account_id: BARE_ID,
    },
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture document must parse');
  return parsed.doc;
}

interface Fixture {
  root: string;
  store: Store;
  keychain: MockKeychain;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-ids-end-to-end-'));
  const store = openStore(join(root, 'qlb.db'));
  beginCutover(store, 1);
  // Fresh-store schema migration has its own fixture-only backup; the import
  // below must be the sole rekey backup being asserted.
  rmSync(join(root, 'backups'), { recursive: true, force: true });
  return { root, store, keychain: new MockKeychain() };
}

function close(f: Fixture): void {
  f.store.close();
  rmSync(f.root, { recursive: true, force: true });
}

function write(f: Fixture, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(f.store.dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function readRows(f: Fixture, sql: string, ...params: string[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(f.store.dbPath, { readOnly: true });
  try {
    return (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function canonicalDependents(f: Fixture): string {
  return JSON.stringify({
    snapshots: readRows(f, `SELECT account_id, bucket, used_pct, used, limit_val, remaining, reset_at, fetched_at, source, confidence
      FROM snapshots ORDER BY account_id, bucket`),
    overrides: readRows(f, 'SELECT kind, account_id, session, until FROM overrides ORDER BY kind, account_id, session, until'),
    leases: readRows(f, 'SELECT name, holder_pid, holder_id, until, generation FROM leases ORDER BY name'),
    failover: readRows(f, "SELECT key, value FROM config WHERE key = 'failover:openai-codex' ORDER BY key"),
  });
}

async function listenMock(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function post(proxy: LoopbackProxy): Promise<number> {
  const body = Buffer.from(JSON.stringify({ model: MODEL, input: 'fixture request' }));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxy.proxyInfo.port,
      path: '/backend-api/codex/responses',
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.proxyInfo.token}`,
        'content-type': 'application/json',
        'content-length': body.length,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end(body);
  });
}

describe('Codex S29 ids end to end', () => {
  it('bare adapter-era Codex data ends on one slot-id row; the proxy sends the bare header; a second import changes nothing', async () => {
    const f = fixture();
    try {
      const doc = document();
      f.store.upsertAccount(BARE_ID, 'openai-codex', 'legacy fixture');
      write(f, `INSERT INTO snapshots (account_id, bucket, used_pct, fetched_at, source, confidence)
        VALUES (?, 'five-hour', 10, 10, 'fixture', 'high')`, BARE_ID);
      write(f, `INSERT INTO snapshots (account_id, bucket, used_pct, fetched_at, source, confidence)
        VALUES (?, 'seven-day', 20, 20, 'fixture', 'high')`, BARE_ID);
      write(f, "INSERT INTO overrides (kind, account_id, session, until) VALUES ('pin', ?, 'fixture', 99)", BARE_ID);
      write(f, 'INSERT INTO leases (name, holder_pid, holder_id, until, generation) VALUES (?, 1, \'fixture\', 0, 1)', `refresh:${BARE_ID}`);
      write(f, "INSERT INTO config (key, value) VALUES ('failover:openai-codex', ?)", BARE_ID);

      const imported = importActiveCodexSlot(doc, { store: f.store, keychain: f.keychain, now: () => 2 });
      assert.equal(imported.slotId, SLOT_ID);
      assert.deepEqual(readRows(f, `SELECT id, provider FROM accounts WHERE provider = 'openai-codex' ORDER BY id`), [
        { id: SLOT_ID, provider: 'openai-codex' },
      ]);
      assert.deepEqual(readRows(f, 'SELECT account_id, bucket FROM snapshots ORDER BY bucket'), [
        { account_id: SLOT_ID, bucket: 'five-hour' },
        { account_id: SLOT_ID, bucket: 'seven-day' },
      ]);
      assert.deepEqual(readRows(f, 'SELECT account_id FROM overrides'), [{ account_id: SLOT_ID }]);
      assert.deepEqual(readRows(f, 'SELECT name FROM leases'), [{ name: `refresh:${SLOT_ID}` }]);
      assert.deepEqual(readRows(f, "SELECT value FROM config WHERE key = 'failover:openai-codex'"), [{ value: SLOT_ID }]);

      const backups = readdirSync(join(f.root, 'backups')).filter((name) => name.endsWith('.sqlite'));
      assert.equal(backups.length, 1);
      const backupPath = join(f.root, 'backups', backups[0]!);
      assert.equal(existsSync(backupPath), true);
      assert.ok(!relative(f.root, backupPath).startsWith('..'));

      const beforeAdapter = readRows(f, 'SELECT id, provider, label FROM accounts ORDER BY id');
      const adapter = createCodexAdapter({ readAuth: async () => JSON.stringify(doc) });
      assert.equal((await adapter.fetchSnapshots())[0]?.accountId, SLOT_ID);
      assert.deepEqual(readRows(f, 'SELECT id, provider, label FROM accounts ORDER BY id'), beforeAdapter);

      setPolicy(f.store, { harness: 'codex', virtualModel: MODEL, realModel: 'gpt-5.4', effort: 'high' });
      let receivedHeader: string | string[] | undefined;
      const upstream = await listenMock((request, response) => {
        receivedHeader = request.headers['chatgpt-account-id'];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
      const proxy = new LoopbackProxy({
        store: f.store,
        infoPath: join(f.root, 'proxy.json'),
        getCredentialForAccount: async () => 'fixture-proxy-credential',
        upstreams: { anthropicBase: upstream.url, codexBase: upstream.url },
      });
      try {
        await proxy.start();
        assert.equal(await post(proxy), 200);
        assert.equal(receivedHeader, BARE_ID);
      } finally {
        await proxy.stop();
        await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
      }

      const beforeSecondImport = canonicalDependents(f);
      importActiveCodexSlot(doc, { store: f.store, keychain: f.keychain, now: () => 3 });
      assert.equal(canonicalDependents(f), beforeSecondImport);
    } finally {
      close(f);
    }
  });

  it('an imported slot with no journal is not owned (Q7)', async () => {
    const f = fixture();
    try {
      const plan = importActiveCodexSlot(document(), { store: f.store, keychain: f.keychain, now: () => 2 });
      const lookup = createOwnedCredentialSource({ store: f.store, keychain: f.keychain });
      await assert.rejects(lookup(plan.slotId), notOwnedError(plan.slotId, 'openai-codex'));
    } finally {
      close(f);
    }
  });

  it('a generic-owned S29 row returns the access token through the real lookup', async () => {
    const f = fixture();
    try {
      const detail = JSON.stringify({ qlbAccountIds: [SLOT_ID] });
      const evidence = decodeJournalEvidence({
        store: 'pi-openai-codex', state: 'QLB_OWNED', detail_json: detail,
      });
      assert.equal(evidence.trusted, true);
      f.store.upsertMigration('pi-openai-codex', 'QLB_OWNED', detail, 1);
      f.store.upsertAccount(SLOT_ID, 'openai-codex', SLOT_ID);
      const access = 'fixture-generic-owned-access';
      f.keychain.setSync(qlbKeychainService('openai-codex', SLOT_ID), SLOT_ID, JSON.stringify({
        access,
        refresh: 'fixture-generic-owned-refresh',
        expires: 2_000_000_000_000,
        generation: 0,
      }));

      const lookup = createOwnedCredentialSource({ store: f.store, keychain: f.keychain });
      assert.equal(await lookup(SLOT_ID), access);
    } finally {
      close(f);
    }
  });
});
