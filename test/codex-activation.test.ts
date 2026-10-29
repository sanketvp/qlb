import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, mock } from 'node:test';

import { createCodexAdapter } from '../src/adapters/codex';
import { parseCodexAuth } from '../src/codex-auth';
import { importActiveCodexSlot } from '../src/codex-slots';
import { MockKeychain } from '../src/keychain';
import { accountIdForSingleGrant, defaultRehearseFn } from '../src/migration';
import { openStore } from '../src/store';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(withUser = true) {
  const claims: Record<string, string> = { chatgpt_account_id: 'fixture-account' };
  if (withUser) claims.chatgpt_user_id = 'fixture-user';
  const parsed = parseCodexAuth(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': claims }),
      access_token: jwt({ 'https://api.openai.com/auth': claims }),
      refresh_token: 'fixture-refresh',
      account_id: 'fixture-account',
    },
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture must parse');
  return parsed.doc;
}

describe('Codex S29 activation', () => {
  it('the adapter reports the slot id and writes no accounts row', async () => {
    const adapter = createCodexAdapter({ readAuth: async () => JSON.stringify(document()) });
    assert.deepEqual(await adapter.fetchSnapshots(), [{
      accountId: 'fixture-user:fixture-account',
      provider: 'openai-codex',
      label: 'fixture-user:fixture-account',
      buckets: {},
    }]);
  });

  it('a login without chatgpt_user_id gives the adapter error and import writes nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-activation-'));
    const store = openStore(join(home, 'qlb.db'));
    const keychain = new MockKeychain();
    try {
      const missing = document(false);
      const adapter = createCodexAdapter({ readAuth: async () => JSON.stringify(missing) });
      const [snapshot] = await adapter.fetchSnapshots();
      assert.equal(snapshot?.accountId, 'codex-default');
      assert.equal(snapshot?.error, 'Codex login has no S29 identity');
      assert.throws(() => importActiveCodexSlot(missing, { store, keychain }), /S29 identity/);
      const db = (store as unknown as { db: DatabaseSync }).db;
      assert.equal((db.prepare('SELECT count(*) AS count FROM accounts').get() as { count: number }).count, 0);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('openai-codex stage keys journal, account and Keychain item by the slot id', () => {
    const access = document().tokens.access_token;
    assert.equal(accountIdForSingleGrant('openai-codex', { access, accountId: 'fixture-account' }), 'fixture-user:fixture-account');
  });

  it('openai-codex stage refuses codex-identity-missing and writes nothing', () => {
    assert.throws(
      () => accountIdForSingleGrant('openai-codex', { access: 'not-a-jwt', accountId: 'fixture-account' }),
      /codex-identity-missing/,
    );
  });

  it('rehearse sends the bare id header for a slot id', async () => {
    const calls: RequestInit[] = [];
    const fetchMock = mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response('{}', { status: 200 });
    });
    try {
      const result = await defaultRehearseFn({
        id: 'fixture-user:fixture-account',
        provider: 'openai-codex',
        label: 'fixture-user:fixture-account',
        fingerprint: 'fixture',
        grant: { access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 60_000, generation: 0, writtenBy: 'fixture' },
      });
      assert.deepEqual(result, { ok: true });
      assert.equal(new Headers(calls[0]?.headers).get('chatgpt-account-id'), 'fixture-account');
    } finally {
      fetchMock.mock.restore();
    }
  });
});
