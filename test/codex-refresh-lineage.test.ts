import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { refreshActiveCodexLogin, type CodexActiveDeps } from '../src/codex-active';
import { readCodexAuthStableWithStat, type CodexAuthDocument } from '../src/codex-auth';
import { consumeCodexSlot } from '../src/codex-consume';
import { CodexSlots, importActiveCodexSlot } from '../src/codex-slots';
import { freshenCodexTarget, type CodexSwitchDeps } from '../src/codex-switch';
import { MockKeychain } from '../src/keychain';
import { openStore } from '../src/store';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const A = 'user-a:account-a';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(expiresAt: number, access: string, refresh = `fixture-refresh-${access}`): CodexAuthDocument {
  return {
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-a', chatgpt_account_id: 'account-a' } }),
      access_token: jwt({ exp: Math.floor(expiresAt / 1_000), tag: access }),
      refresh_token: refresh,
      account_id: 'account-a',
    },
    last_refresh: '2026-11-01T11:00:00.000Z',
  };
}

const granted = (tag: string) => async () => ({
  status: 200,
  body: JSON.stringify({ refresh_token: `fixture-refresh-${tag}`, access_token: document(NOW + 3_600_000, tag).tokens.access_token }),
});

/** A store with account A imported as the active Codex login, expiring in one minute. */
function harness() {
  const root = mkdtempSync('/tmp/qlb-codex-lineage-');
  const journalDir = join(root, 'journal');
  mkdirSync(journalDir);
  const store = openStore(join(root, 'qlb.db'));
  const keychain = new MockKeychain();
  const authPath = join(root, 'auth.json');
  const a0 = document(NOW + 60_000, 'fixture-access-a0');
  importActiveCodexSlot(a0, { store, keychain, now: () => NOW - 1 });
  store.setActiveLogin('openai-codex', A, 'import', NOW);
  writeFileSync(authPath, JSON.stringify(a0));
  const codexSlots = new CodexSlots({ keychain, stashDir: join(root, 'unclaimed'), now: () => NOW });
  const slots = {
    readSlot: codexSlots.readSlot.bind(codexSlots),
    writeSlot: codexSlots.writeSlot.bind(codexSlots),
    ensureUnclaimedStash: codexSlots.ensureUnclaimedStash.bind(codexSlots),
    stashUnclaimed: codexSlots.stashUnclaimed.bind(codexSlots),
    stashUnclaimedDurably: codexSlots.stashUnclaimedDurably.bind(codexSlots),
    stashSuccessorEmergency: codexSlots.stashSuccessorEmergency.bind(codexSlots),
    findStashedSuccessor: codexSlots.findStashedSuccessor.bind(codexSlots),
    removeStashedSuccessor: codexSlots.removeStashedSuccessor.bind(codexSlots),
  };
  const lineage = (): Array<{ cause: string; by: string }> => {
    const db = new DatabaseSync(store.dbPath, { readOnly: true });
    try {
      return (db.prepare("SELECT cause, by FROM lineage_log WHERE provider = 'openai-codex' AND cause IN ('post', 'stash-adopt') ORDER BY id")
        .all() as Array<{ cause: string; by: string }>).map(({ cause, by }) => ({ cause, by }));
    } finally {
      db.close();
    }
  };
  return {
    store, slots, a0, authPath, journalDir, lineage,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe('qlb-auto refresh lineage', () => {
  it('tags a refresh of the active login, which only the auto tick starts, qlb-auto', async () => {
    const h = harness();
    try {
      const deps: CodexActiveDeps = {
        store: h.store, dbPath: h.store.dbPath, journalDir: h.journalDir, authPath: h.authPath,
        keychain: new MockKeychain(), slots: h.slots as never,
        readLive: () => readCodexAuthStableWithStat(h.authPath, { delayMs: 0 }),
        cswapProcesses: () => [], now: () => NOW, attempt: 'lineage-fixture', list: async () => [],
        transport: granted('fixture-access-a1'),
        withLocks: async (_accountId, fn) => fn(() => undefined),
      };
      assert.equal((await refreshActiveCodexLogin(deps, { trigger: 'scheduled' })).status, 'posted');
      assert.deepEqual(h.lineage(), [{ cause: 'post', by: 'qlb-auto' }]);
    } finally {
      h.close();
    }
  });

  for (const [trigger, by] of [['auto', 'qlb-auto'], ['manual', 'qlb-cli']] as const) {
    it(`tags a ${trigger} switch's pre-switch refresh ${by}`, async () => {
      const h = harness();
      try {
        h.store.setActiveLogin('openai-codex', 'user-z:account-z', 'import', NOW);
        const deps = {
          store: h.store, dbPath: h.store.dbPath, journalDir: h.journalDir, slots: h.slots,
          list: async () => [], transport: granted('fixture-access-a2'), now: () => NOW,
        } as unknown as CodexSwitchDeps;
        assert.deepEqual(await freshenCodexTarget(deps, { target: A, now: NOW, trigger }), { kind: 'go' });
        assert.deepEqual(h.lineage(), [{ cause: 'post', by }]);
      } finally {
        h.close();
      }
    });
  }

  it('keeps qlb-cli for a consume that does not name its caller, as codex refresh --force does', async () => {
    const h = harness();
    try {
      const result = await consumeCodexSlot({
        accountId: A, snapshot: h.a0, trigger: 'force', force: true, slots: h.slots as never,
        store: { dbPath: h.store.dbPath }, transport: granted('fixture-access-a3'), now: () => NOW,
        holders: async () => [],
      });
      assert.equal(result.status, 'refreshed');
      assert.deepEqual(h.lineage(), [{ cause: 'post', by: 'qlb-cli' }]);
    } finally {
      h.close();
    }
  });

  it('writes no post row when an automatic consume adopts a stashed successor without a refresh request', async () => {
    const h = harness();
    try {
      let sent = 0;
      const successor = document(NOW + 3_600_000, 'fixture-access-a5', 'fixture-refresh-a5');
      const result = await consumeCodexSlot({
        accountId: A, snapshot: h.a0, trigger: 'scheduled',
        slots: { ...h.slots, findStashedSuccessor: async () => ({ document: successor, stashId: 'fixture-stash' }) } as never,
        store: { dbPath: h.store.dbPath }, now: () => NOW, holders: async () => [], by: 'qlb-auto',
        transport: async () => { sent += 1; throw new Error('adoption must not send a refresh request'); },
      });
      assert.equal(result.status, 'fresh');
      assert.equal(sent, 0);
      assert.deepEqual(h.lineage(), [{ cause: 'stash-adopt', by: 'qlb-auto' }]);
    } finally {
      h.close();
    }
  });

  it('returns the same lineage chains whichever caller wrote the row', async () => {
    const chains: unknown[] = [];
    for (const by of ['qlb-auto', undefined] as const) {
      const h = harness();
      try {
        await consumeCodexSlot({
          accountId: A, snapshot: h.a0, trigger: 'scheduled', slots: h.slots as never,
          store: { dbPath: h.store.dbPath }, transport: granted('fixture-access-a4'), now: () => NOW,
          holders: async () => [], ...(by ? { by } : {}),
        });
        chains.push(h.store.listCodexSlotLineageChains());
      } finally {
        h.close();
      }
    }
    assert.deepEqual(chains[0], chains[1]);
  });
});
