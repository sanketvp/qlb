import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  CODEX_SWITCH_LOCK_STALE_MS,
  codexLockPaths,
  consumeCodexSlot,
  withCodexConsumeThenSwitchLocks,
  withCodexSwitchLock,
} from '../src/codex-consume';
import { ClaudeCodeLockTimeout } from '../src/cc-locks';
import { runCodexRefreshCommand } from '../src/commands/codex-refresh';
import { codexFingerprint, type CodexAuthDocument } from '../src/codex-auth';
import type { CodexProcess } from '../src/codex-sessions';
import { CodexSlots, importActiveCodexSlot } from '../src/codex-slots';
import { MockKeychain } from '../src/keychain';
import { openStore } from '../src/store';
import { listStashes } from '../src/unclaimed-index';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(refresh = 'refresh-a', access = 'access-a'): CodexAuthDocument {
  return {
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-a', chatgpt_account_id: 'account-a' } }),
      access_token: jwt({ exp: 2_000_000_000, sub: access }),
      refresh_token: refresh,
      account_id: 'account-a',
    },
    last_refresh: '2026-10-24T12:00:00.000Z',
  };
}

function slots(initial: CodexAuthDocument) {
  let current = initial;
  const writes: CodexAuthDocument[] = [];
  return {
    slots: {
      readSlot: () => ({ document: current, fingerprint: codexFingerprint(current) }),
      writeSlot: (_accountId: string, next: CodexAuthDocument) => { current = next; writes.push(next); },
      stashUnclaimed: () => 'fixture-stash',
    },
    writes,
    current: () => current,
  };
}

const holder: CodexProcess = { pid: 741, lstart: 'Fri Oct 24 12:00:00 2026', host: 'codex' };

const ownerToken = /^\.qlb-owner-\d+-[0-9a-f]+$/;

function managedFixture() {
  const home = mkdtempSync(join(tmpdir(), 'qlb-codex-consume-'));
  const store = openStore(join(home, 'qlb.db'));
  const keychain = new MockKeychain();
  const initial = document('refresh-a', 'access-a');
  const plan = importActiveCodexSlot(initial, { store, keychain, now: () => 1 });
  return {
    home, store, keychain, plan, initial,
    slots: new CodexSlots({ keychain, stashDir: join(home, 'unclaimed'), now: () => 1 }),
  };
}

describe('Codex consume lock helpers — C6-2', () => {
  it('codexLockPaths encodes the slot id and matches the codex refresh lock paths', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-lock-paths-'));
    const dbPath = join(home, 'state', 'qlb.db');
    const accountId = 'user:a/account';
    const paths = codexLockPaths(dbPath, accountId);
    try {
      assert.deepEqual(paths, {
        consume: join(dirname(dbPath), 'locks', 'consume-openai-codex-user%3Aa%2Faccount.lock'),
        switch: join(dirname(dbPath), 'locks', 'switch-openai-codex.lock'),
      });
      await withCodexConsumeThenSwitchLocks(dbPath, accountId, async () => {
        assert.equal(existsSync(paths.consume), true);
        assert.equal(existsSync(paths.switch), true);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('codex refresh takes consume then switch with owner tokens (lock-order spy)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-lock-order-'));
    const dbPath = join(home, 'qlb.db');
    const paths = codexLockPaths(dbPath, 'user:account');
    const fsPromises = require('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
    const originalMkdir = fsPromises.mkdir;
    const acquired: string[] = [];
    try {
      fsPromises.mkdir = async (...args: any[]) => {
        if (args[0] === paths.consume || args[0] === paths.switch) acquired.push(args[0]);
        return originalMkdir(...args);
      };
      await withCodexConsumeThenSwitchLocks(dbPath, 'user:account', async () => {
        assert.ok(readdirSync(paths.consume).some((entry) => ownerToken.test(entry)));
        assert.ok(readdirSync(paths.switch).some((entry) => ownerToken.test(entry)));
      });
      assert.deepEqual(acquired, [paths.consume, paths.switch]);
    } finally {
      fsPromises.mkdir = originalMkdir;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a switch lock younger than five minutes is not taken over', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-lock-stale-'));
    const dbPath = join(home, 'qlb.db');
    const { switch: lock } = codexLockPaths(dbPath, 'user:account');
    try {
      mkdirSync(lock, { recursive: true });
      const fourMinutesAgo = new Date(Date.now() - 4 * 60_000);
      utimesSync(lock, fourMinutesAgo, fourMinutesAgo);
      await assert.rejects(
        withCodexSwitchLock(dbPath, async () => assert.fail('a young lock must not be acquired'), { timeoutMs: 20 }),
        ClaudeCodeLockTimeout,
      );
      assert.equal(existsSync(lock), true);

      const sixMinutesAgo = new Date(Date.now() - CODEX_SWITCH_LOCK_STALE_MS - 60_000);
      utimesSync(lock, sixMinutesAgo, sixMinutesAgo);
      await withCodexSwitchLock(dbPath, async () => {
        assert.ok(readdirSync(lock).some((entry) => ownerToken.test(entry)));
      }, { timeoutMs: 1_000 });
      assert.equal(existsSync(lock), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("releasing a lock that was taken over leaves the new owner's lock directory", async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-lock-release-'));
    const dbPath = join(home, 'qlb.db');
    const { switch: lock } = codexLockPaths(dbPath, 'user:account');
    const replacementToken = '.qlb-owner-999-deadbeef';
    try {
      await assert.rejects(withCodexSwitchLock(dbPath, async () => {
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        writeFileSync(join(lock, replacementToken), '', { flag: 'wx', mode: 0o600 });
      }), /Lock ownership was lost/);
      assert.equal(existsSync(lock), true);
      assert.deepEqual(readdirSync(lock), [replacementToken]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Codex consume gate — AC34', () => {
  it('does not POST when an S12 holder may renew the inactive slot', async () => {
    const fixture = slots(document());
    let posts = 0;

    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a',
      snapshot: fixture.current(),
      trigger: 'scheduled',
      slots: fixture.slots,
      holders: async () => [holder],
      transport: async () => { posts += 1; return { status: 200, body: '{}' }; },
      now: () => Date.parse('2026-10-24T12:01:00.000Z'),
    });

    assert.deepEqual(result, { status: 'held', holders: [741] });
    assert.equal(posts, 0);
    assert.equal(fixture.writes.length, 0);
  });

  it('serializes concurrent inactive consumers so one POST produces the winner', async () => {
    const fixture = slots(document());
    let posts = 0;
    let release!: () => void;
    const sent = new Promise<void>((resolve) => { release = resolve; });
    const input = () => consumeCodexSlot({
      accountId: 'user-a:account-a',
      snapshot: document(),
      trigger: 'scheduled',
      slots: fixture.slots,
      holders: async () => [],
      transport: async () => {
        posts += 1;
        await sent;
        return { status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: jwt({ exp: 2_000_000_000, sub: 'access-b' }) }) };
      },
      now: () => Date.parse('2026-10-24T12:01:00.000Z'),
    });

    const first = input();
    const second = input();
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      assert.equal(posts, 1);
    } finally {
      release();
    }
    assert.equal((await first).status, 'refreshed');
    assert.equal((await second).status, 'fresh');
    assert.equal(posts, 1);
  });

  it('uses forced refresh_reason, persists its successor first, and records post lineage', async () => {
    const fixture = slots(document());
    const events: string[] = [];
    let body = '';

    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a',
      snapshot: fixture.current(),
      trigger: 'force',
      force: true,
      slots: fixture.slots,
      holders: async () => [],
      transport: async (request) => {
        body = request.body ?? '';
        return { status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: 'access-b' }) };
      },
      record: (event) => events.push(event.kind),
      now: () => Date.parse('2026-10-24T12:01:00.000Z'),
    });

    assert.equal(result.status, 'refreshed');
    assert.equal(JSON.parse(body).refresh_reason, 'forced');
    assert.equal(fixture.writes.length, 1);
    assert.deepEqual(events, ['post']);
  });

  it('uses N8 to return a peer successor without POSTing it again', async () => {
    const fixture = slots(document('refresh-b', 'access-b'));
    let posts = 0;

    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a',
      snapshot: document('refresh-a', 'access-a'),
      trigger: 'scheduled',
      slots: fixture.slots,
      holders: async () => [],
      transport: async () => { posts += 1; return { status: 200, body: '{}' }; },
      now: () => Date.parse('2026-10-24T12:01:00.000Z'),
    });

    assert.equal(result.status, 'fresh');
    assert.equal(posts, 0);
  });

  it('returns a typed unpersisted-successor outcome when every post-POST persistence path fails', async () => {
    const fixture = slots(document());
    fixture.slots.writeSlot = () => { throw new Error('fixture keychain unavailable'); };
    (fixture.slots as unknown as { stashUnclaimed: () => never }).stashUnclaimed = () => { throw new Error('fixture stash unavailable'); };

    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a', snapshot: fixture.current(), trigger: 'force', force: true,
      slots: fixture.slots, holders: async () => [], now: () => 1,
      transport: async () => ({ status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: 'access-b' }) }),
    });

    assert.equal(result.status, 'successor-unpersisted');
    assert.equal(result.successorFailure?.kind, 'successor-unpersisted');
  });

  it('adopts a matching stashed successor before it can POST the spent predecessor', async () => {
    const fixture = slots(document());
    let posts = 0;
    (fixture.slots as typeof fixture.slots & { adoptStashedSuccessor: (accountId: string, restore: (next: CodexAuthDocument) => void) => Promise<boolean> }).adoptStashedSuccessor = async (_accountId: string, restore: (next: CodexAuthDocument) => void) => {
      restore(document('refresh-b', 'access-b'));
      return true;
    };

    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a', snapshot: fixture.current(), trigger: 'scheduled',
      slots: fixture.slots, holders: async () => [], now: () => 1,
      transport: async () => { posts += 1; return { status: 500, body: '{}' }; },
    });

    assert.equal(result.status, 'fresh');
    assert.equal(posts, 0);
  });

  it('treats a C9 reuse response as dead evidence even while a holder exists', async () => {
    const fixture = slots(document());
    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a', snapshot: fixture.current(), trigger: 'force', force: true, allowHeld: true,
      slots: fixture.slots, holders: async () => [holder], now: () => 1,
      transport: async () => ({ status: 400, body: JSON.stringify({ error: 'refresh_token_reused' }) }),
    });
    assert.equal(result.status, 'dead');
  });

  it('repairs a Keychain successor that descends from the recorded row before its next POST', async () => {
    const h = managedFixture();
    try {
      const successor = document('refresh-b', 'access-b');
      h.slots.writeSlot(h.plan.slotId, successor, h.initial);
      let posts = 0;
      const result = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: successor, trigger: 'force', force: true,
        slots: h.slots, store: h.store, holders: async () => [], now: () => 2,
        transport: async () => {
          posts += 1;
          return { status: 200, body: JSON.stringify({ refresh_token: 'refresh-c', access_token: 'access-c' }) };
        },
      });
      assert.equal(result.status, 'refreshed');
      assert.equal(posts, 1);
      const db = new DatabaseSync(h.store.dbPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT fingerprint FROM codex_slots WHERE account_id = ?').get(h.plan.slotId) as { fingerprint: string };
        assert.equal(row.fingerprint, codexFingerprint(h.slots.readSlot(h.plan.slotId, { fresh: true }).document));
      } finally { db.close(); }
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('keeps an adoption stash when its metadata CAS cannot commit', async () => {
    const h = managedFixture();
    try {
      const successor = document('refresh-b', 'access-b');
      await h.slots.stashUnclaimedDurably('adoption-stash', successor, codexFingerprint(h.initial), h.plan.slotId);
      (h.store as unknown as { db: DatabaseSync }).db.exec(`CREATE TRIGGER reject_adoption
        BEFORE UPDATE OF fingerprint ON codex_slots WHEN NEW.fingerprint = '${codexFingerprint(successor)}'
        BEGIN SELECT RAISE(FAIL, 'fixture metadata failure'); END;`);
      const result = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.initial, trigger: 'scheduled', slots: h.slots, store: h.store,
        holders: async () => [], now: () => 2,
        transport: async () => { throw new Error('must not POST while adoption is unresolved'); },
      });
      assert.equal(result.status, 'stashed');
      assert.equal((await listStashes(join(h.home, 'unclaimed'), 'openai-codex', h.plan.slotId)).length, 1);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('refuses an unrelated Keychain/metadata split without POSTing', async () => {
    const h = managedFixture();
    try {
      h.slots.writeSlot(h.plan.slotId, document('refresh-foreign', 'access-foreign'), document('refresh-unrelated', 'access-unrelated'));
      let posts = 0;
      const result = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.initial, trigger: 'force', force: true,
        slots: h.slots, store: h.store, holders: async () => [], now: () => 2,
        transport: async () => { posts += 1; return { status: 500, body: '{}' }; },
      });
      assert.equal(result.status, 'slot-split');
      assert.equal(posts, 0);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('adopts a stashed successor after one metadata failure, then refreshes again without wedging', async () => {
    const h = managedFixture();
    try {
      (h.store as unknown as { db: DatabaseSync }).db.exec(`CREATE TRIGGER reject_post_once
        BEFORE UPDATE OF fingerprint ON codex_slots WHEN NEW.fingerprint != OLD.fingerprint
        BEGIN SELECT RAISE(FAIL, 'fixture metadata failure'); END;`);
      let posts = 0;
      const refresh = async () => consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.slots.readSlot(h.plan.slotId, { fresh: true }).document,
        trigger: 'force', force: true, slots: h.slots, store: h.store, holders: async () => [], now: () => 2,
        transport: async () => {
          posts += 1;
          return { status: 200, body: JSON.stringify({ refresh_token: `refresh-${String.fromCharCode(97 + posts)}`, access_token: `access-${posts}` }) };
        },
      });
      assert.equal((await refresh()).status, 'stashed');
      (h.store as unknown as { db: DatabaseSync }).db.exec('DROP TRIGGER reject_post_once');
      assert.equal((await refresh()).status, 'fresh');
      assert.equal((await refresh()).status, 'refreshed');
      assert.equal(posts, 2);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('stashes a successor when opening the transition database fails after its POST, then adopts it', async () => {
    const h = managedFixture();
    try {
      let dbPath = h.store.dbPath;
      const store = { get dbPath(): string { return dbPath; } };
      let posts = 0;
      const result = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.initial, trigger: 'force', force: true,
        slots: h.slots, store, holders: async () => [], now: () => 2,
        transport: async () => {
          posts += 1;
          dbPath = join(h.home, 'missing', 'qlb.db');
          return { status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: 'access-b' }) };
        },
      });
      assert.equal(result.status, 'stashed');
      assert.equal(posts, 1);
      assert.equal((await listStashes(join(h.home, 'unclaimed'), 'openai-codex', h.plan.slotId)).length, 1);

      dbPath = h.store.dbPath;
      const adopted = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.initial, trigger: 'scheduled',
        slots: h.slots, store, holders: async () => [], now: () => 3,
        transport: async () => { assert.fail('must adopt the stashed successor before POSTing'); },
      });
      assert.equal(adopted.status, 'fresh');
      assert.equal(codexFingerprint(h.slots.readSlot(h.plan.slotId, { fresh: true }).document), codexFingerprint(document('refresh-b', 'access-b')));
      assert.equal((await listStashes(join(h.home, 'unclaimed'), 'openai-codex', h.plan.slotId)).length, 0);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('keeps the issued successor in the managed slot when transition DB open and stash recovery both fail', async () => {
    const h = managedFixture();
    try {
      let dbPath = h.store.dbPath;
      const store = { get dbPath(): string { return dbPath; } };
      const failingSlots = {
        readSlot: h.slots.readSlot.bind(h.slots),
        writeSlot: h.slots.writeSlot.bind(h.slots),
        stashUnclaimed: h.slots.stashUnclaimed.bind(h.slots),
        stashUnclaimedDurably: async () => { throw new Error('fixture stash failure'); },
      };
      const result = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.initial, trigger: 'force', force: true,
        slots: failingSlots, store, holders: async () => [], now: () => 2,
        transport: async () => {
          dbPath = join(h.home, 'missing', 'qlb.db');
          return { status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: 'access-b' }) };
        },
      });
      assert.equal(result.status, 'successor-unpersisted');
      assert.equal(codexFingerprint(h.slots.readSlot(h.plan.slotId, { fresh: true }).document), codexFingerprint(document('refresh-b', 'access-b')));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('rolls back the C9 receipt with a failed post metadata transaction', async () => {
    const h = managedFixture();
    try {
      (h.store as unknown as { db: DatabaseSync }).db.exec(`CREATE TRIGGER reject_c9
        BEFORE UPDATE OF fingerprint ON codex_slots WHEN NEW.fingerprint != OLD.fingerprint
        BEGIN SELECT RAISE(FAIL, 'fixture metadata failure'); END;`);
      const result = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.initial, trigger: 'force', force: true, allowHeld: true,
        slots: h.slots, store: h.store, holders: async () => [], now: () => 2,
        transport: async () => ({ status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: 'access-b' }) }),
      });
      assert.equal(result.status, 'stashed');
      assert.equal(h.store.getConfig('codex.l13VerifiedAt'), null);
      assert.equal(codexFingerprint(h.slots.readSlot(h.plan.slotId, { fresh: true }).document), codexFingerprint(h.initial));
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a C10 consume whose lock was taken over before the POST sends nothing and writes nothing', async () => {
    const fixture = slots(document());
    let posts = 0;
    const input = {
      accountId: 'user-a:account-a', snapshot: fixture.current(), trigger: 'force' as const, force: true,
      slots: fixture.slots, holders: async () => [], now: () => 1,
      assertHeld: () => { throw new Error('owner token replaced'); },
      transport: async () => { posts += 1; return { status: 200, body: '{}' }; },
    };

    const result = await consumeCodexSlot(input);
    assert.equal(result.status, 'transient');
    assert.equal(posts, 0);
    assert.equal(fixture.writes.length, 0);
  });

  it("a C10 consume that loses its lock after a successful POST stashes the successor, mutates no slot or row, leaves the new owner's lock, and the next refresh adopts it with no second POST", async () => {
    const h = managedFixture();
    try {
      const original = codexFingerprint(h.initial);
      let posted = false;
      let posts = 0;
      const first = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.initial, trigger: 'force', force: true, slots: h.slots, store: h.store,
        holders: async () => [], now: () => 2,
        assertHeld: () => { if (posted) throw new Error('new owner holds the lock'); },
        transport: async () => {
          posts += 1;
          posted = true;
          return { status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: 'access-b' }) };
        },
      });
      assert.equal(first.status, 'stashed-lock-lost');
      assert.ok(first.stashId);
      assert.equal(posts, 1);
      assert.equal(codexFingerprint(h.slots.readSlot(h.plan.slotId, { fresh: true }).document), original);
      const db = new DatabaseSync(h.store.dbPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT fingerprint FROM codex_slots WHERE account_id = ?').get(h.plan.slotId) as { fingerprint: string };
        assert.equal(row.fingerprint, original);
      } finally { db.close(); }

      const next = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.initial, trigger: 'scheduled', slots: h.slots, store: h.store,
        holders: async () => [], now: () => 3,
        transport: async () => { posts += 1; throw new Error('must adopt instead of POSTing'); },
      });
      assert.equal(next.status, 'fresh');
      assert.equal(posts, 1);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it("a new owner consuming while the old owner's emergency stash is between body and index adopts it and sends no POST", async () => {
    const h = managedFixture();
    let bodyWritten!: () => void;
    const bodyReady = new Promise<void>((resolve) => { bodyWritten = resolve; });
    let continueIndex!: () => void;
    const indexMayContinue = new Promise<void>((resolve) => { continueIndex = resolve; });
    try {
      const slotsWithBarrier = new CodexSlots({
        keychain: h.keychain,
        stashDir: join(h.home, 'unclaimed'),
        emergencyStashAfterBody: async () => { bodyWritten(); await indexMayContinue; },
      });
      const owner = slotsWithBarrier.stashSuccessorEmergency(
        h.plan.slotId, document('refresh-b', 'access-b'), codexFingerprint(h.initial), 2,
      );
      await bodyReady;
      let posts = 0;
      const adopted = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.initial, trigger: 'scheduled', slots: slotsWithBarrier, store: h.store,
        holders: async () => [], now: () => 3,
        transport: async () => { posts += 1; throw new Error('must adopt orphan before POSTing'); },
      });
      assert.equal(adopted.status, 'fresh');
      assert.equal(posts, 0);
      continueIndex();
      await owner;
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('the store-backed path asserts before the :344 slot write and the metadata transaction', async () => {
    const h = managedFixture();
    try {
      let assertions = 0;
      const originalWrite = h.slots.writeSlot.bind(h.slots);
      h.slots.writeSlot = (accountId, successor, predecessor) => {
        assert.ok(assertions >= 3, 'the authority fences run before the slot write');
        originalWrite(accountId, successor, predecessor);
      };
      const result = await consumeCodexSlot({
        accountId: h.plan.slotId, snapshot: h.initial, trigger: 'force', force: true, slots: h.slots, store: h.store,
        holders: async () => [], now: () => 2,
        assertHeld: () => { assertions += 1; },
        transport: async () => ({ status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: 'access-b' }) }),
      });
      assert.equal(result.status, 'refreshed');
      assert.ok(assertions >= 3);
    } finally {
      h.store.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it('a consume whose locks stay held writes as before', async () => {
    const fixture = slots(document());
    let assertions = 0;
    const result = await consumeCodexSlot({
      accountId: 'user-a:account-a', snapshot: fixture.current(), trigger: 'force', force: true,
      slots: fixture.slots, holders: async () => [], now: () => 1,
      assertHeld: () => { assertions += 1; },
      transport: async () => ({ status: 200, body: JSON.stringify({ refresh_token: 'refresh-b', access_token: 'access-b' }) }),
    });
    assert.equal(result.status, 'refreshed');
    assert.equal(fixture.writes.length, 1);
    assert.ok(assertions > 0);
  });

  it('refuses a forced refresh of the active Codex slot', async () => {
    let called = 0;
    const errors: string[] = [];
    const code = await runCodexRefreshCommand(['user-a:account-a', '--force'], {
      getConfig: () => null,
      isActive: () => true,
      consume: async () => { called += 1; return { status: 'refreshed' }; },
      write: () => assert.fail('must not report success'),
      error: (line) => errors.push(line),
    });
    assert.equal(code, 3);
    assert.equal(called, 0);
    assert.match(errors[0] ?? '', /active-slot/);
  });

  it('allows --c9 only for an unverified recorded A JWT and only then bypasses holders', async () => {
    const fixture = slots(document());
    let posts = 0;
    const consume = async (input: { allowHeld: boolean }) => {
      posts += 1;
      assert.equal(input.allowHeld, true);
      return { status: 'refreshed' as const };
    };
    const output: string[] = [];

    const code = await runCodexRefreshCommand(['user-a:account-a', '--force', '--c9', '--json'], {
      getConfig: (key) => key === 'codex.l13.aJwtExp' ? '1700000000000' : null,
      consume,
      write: (line) => output.push(line),
      error: () => assert.fail('unexpected command error'),
    });
    assert.equal(code, 0);
    assert.equal(posts, 1);
    assert.deepEqual(JSON.parse(output[0]), { accountId: 'user-a:account-a', status: 'refreshed' });

    const rejected = await runCodexRefreshCommand(['user-a:account-a', '--force', '--c9'], {
      getConfig: () => null,
      consume,
      write: () => assert.fail('must not write success'),
      error: (line) => output.push(line),
    });
    assert.equal(rejected, 3);
    assert.equal(posts, 1);
    assert.match(output.at(-1) ?? '', /c9-unavailable/);
  });
});
