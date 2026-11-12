import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { formatAnthropicReceipt, projectAnthropicReceipt, readAnthropicReceiptSources } from '../src/anthropic-receipt';
import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
import { MockKeychain } from '../src/keychain';
import { Migration, PI_POOL_STORE } from '../src/migration';
import { openStore, type Store } from '../src/store';
import { insertAdoptionSlot, seedActiveSlots } from './support/adoption-slots';
import { uuidPoolTransport } from './support/anthropic-pool-rehearse';

const NOW = 1_700_000_000_000;
const FRESH = NOW + 3 * 60 * 60 * 1000;
const EMAIL = 'ada@example.com';
const SLOT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SLOT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_A = 'access-token-a';
const TOKEN_B = 'access-token-b';

function oauth(access: string, expires = FRESH) {
  return { type: 'oauth', access, refresh: `refresh-${access}`, expires };
}

function pool(accounts: unknown[]): string {
  return `${JSON.stringify({ accounts })}\n`;
}

interface Live {
  dir: string;
  poolPath: string;
  ownerPath: string;
  store: Store;
  mig: Migration;
  log: string[];
  close: () => void;
}

function openLive(raw: string, pairs: ReadonlyArray<{ access: string; uuid: string }>, active: string): Live {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-r1b-rehearse-'));
  const poolPath = join(dir, 'anthropic-pool.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  writeFileSync(poolPath, raw, { mode: 0o600 });
  const store = openStore(join(dir, 'qlb.db'));
  const log: string[] = [];
  const mig = new Migration(store, new MockKeychain(), poolPath, ownerPath, undefined, {
    authJsonPath: join(dir, 'auth.json'),
    now: () => NOW,
    anthropicPoolTransport: uuidPoolTransport(pairs, log),
  });
  mig.stage();
  return {
    dir, poolPath, ownerPath, store, mig, log,
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function refuse(live: Live, alias = 'member-0001'): Promise<Error & { exitCode?: number }> {
  try {
    await live.mig.rehearse(async () => { throw new Error('hook'); }, undefined, alias);
  } catch (error) {
    return error as Error & { exitCode?: number };
  }
  assert.fail('rehearse succeeded');
}

function detail(live: Live): Record<string, unknown> {
  return JSON.parse(live.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as Record<string, unknown>;
}

describe('anthropic rehearse adoption', () => {
  it('rehearse refuses before any GET when a member has no slot', async () => {
    const live = openLive(pool([{ accountUuid: SLOT_A, credentials: oauth(TOKEN_A) }]), [{ access: TOKEN_A, uuid: SLOT_A }], SLOT_A);
    try {
      const error = await refuse(live);
      assert.equal(error.message, 'adoption-slot-missing');
      assert.equal(error.exitCode, 3);
      assert.deepEqual(live.log, []);
      assert.equal(live.mig.status().state, 'MIRRORED');
    } finally {
      live.close();
    }
  });

  it('rehearse refuses before any GET: two members, one slot (adoption-ambiguous)', async () => {
    const live = openLive(pool([
      { id: 'row-a', accountUuid: SLOT_A, credentials: oauth(TOKEN_A) },
      { id: 'row-b', email: EMAIL, credentials: oauth(TOKEN_B) },
    ]), [{ access: TOKEN_A, uuid: SLOT_A }, { access: TOKEN_B, uuid: SLOT_B }], SLOT_A);
    insertAdoptionSlot(live.store.dbPath, { accountId: SLOT_A, email: EMAIL });
    live.store.setActiveLogin('anthropic', SLOT_A, 'auto', NOW);
    try {
      const error = await refuse(live);
      assert.equal(error.message, 'adoption-ambiguous');
      assert.deepEqual(live.log, []);
      assert.equal(Object.hasOwn(detail(live), 'adoptionBinding'), false);
    } finally {
      live.close();
    }
  });

  it('rehearse refuses before any GET: one email member, two slots (adoption-ambiguous)', async () => {
    const live = openLive(pool([{ id: 'row-a', email: EMAIL, credentials: oauth(TOKEN_A) }]), [{ access: TOKEN_A, uuid: SLOT_A }], SLOT_A);
    insertAdoptionSlot(live.store.dbPath, { accountId: SLOT_A, email: EMAIL });
    insertAdoptionSlot(live.store.dbPath, { accountId: SLOT_B, email: EMAIL });
    live.store.setActiveLogin('anthropic', SLOT_A, 'auto', NOW);
    try {
      const error = await refuse(live);
      assert.equal(error.message, 'adoption-ambiguous');
      assert.deepEqual(live.log, []);
    } finally {
      live.close();
    }
  });

  it('rehearse refuses before any GET when --initial-active is not the active login', async () => {
    const live = openLive(pool([
      { id: 'row-a', accountUuid: SLOT_A, credentials: oauth(TOKEN_A) },
      { id: 'row-b', accountUuid: SLOT_B, credentials: oauth(TOKEN_B) },
    ]), [{ access: TOKEN_A, uuid: SLOT_A }, { access: TOKEN_B, uuid: SLOT_B }], SLOT_B);
    seedActiveSlots(live.store, [{ accountId: SLOT_A }, { accountId: SLOT_B }], SLOT_B);
    try {
      const error = await refuse(live, 'member-0001');
      assert.equal(error.message, 'initial-active-invalid');
      assert.deepEqual(live.log, []);
      assert.equal(live.mig.status().state, 'MIRRORED');
    } finally {
      live.close();
    }
  });

  it('rehearse refuses token-expired as a fixed code; journal stays MIRRORED; receipt shows token-expired', async () => {
    const live = openLive(pool([{ id: 'row-a', accountUuid: SLOT_A, credentials: oauth(TOKEN_A, NOW) }]), [{ access: TOKEN_A, uuid: SLOT_A }], SLOT_A);
    seedActiveSlots(live.store, [{ accountId: SLOT_A }], SLOT_A);
    try {
      const error = await refuse(live);
      assert.equal(error.message, 'token-expired');
      assert.deepEqual(live.log, []);
      assert.equal(live.mig.status().state, 'MIRRORED');
      assert.deepEqual(detail(live).rehearseRefusal, { code: 'token-expired' });
      const receipt = projectAnthropicReceipt('rehearse', readAnthropicReceiptSources(
        live.poolPath, live.ownerPath, live.store.getMigration(PI_POOL_STORE)?.detail_json,
      ));
      assert.deepEqual(receipt, {
        schemaVersion: 1, phase: 'rehearse', disposition: 'refused', code: 'token-expired',
      });
    } finally {
      live.close();
    }
  });

  it('rehearse refuses on provider UUID ≠ mapped slot and persists no proof or binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-r1b-uuid-'));
    const poolPath = join(dir, 'anthropic-pool.json');
    const ownerPath = join(dir, 'qlb-owner.json');
    writeFileSync(poolPath, pool([{ id: 'row-a', email: EMAIL, credentials: oauth(TOKEN_A) }]), { mode: 0o600 });
    const store = openStore(join(dir, 'qlb.db'));
    seedActiveSlots(store, [{ accountId: SLOT_A, email: EMAIL }], SLOT_A);
    const log: string[] = [];
    const mig = new Migration(store, new MockKeychain(), poolPath, ownerPath, undefined, {
      authJsonPath: join(dir, 'auth.json'),
      now: () => NOW,
      anthropicPoolTransport: {
        async getProfile() {
          log.push('profile');
          return { status: 200, body: { account: { uuid: SLOT_B, email: EMAIL } } };
        },
        async getUsage() {
          log.push('usage');
          return { status: 200, body: { five_hour: { utilization: 1 }, seven_day: { utilization: 2 } } };
        },
      },
    });
    mig.stage();
    try {
      await mig.rehearse(async () => { throw new Error('hook'); }, undefined, 'member-0001');
      assert.fail('rehearse succeeded');
    } catch (error) {
      const refused = error as Error & { exitCode?: number };
      assert.equal(refused.message, 'identity-mismatch');
      assert.equal(refused.exitCode, 3);
      assert.deepEqual(log, ['profile']);
      const journal = JSON.parse(store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as Record<string, unknown>;
      assert.equal(Object.hasOwn(journal, 'identityProof'), false);
      assert.equal(Object.hasOwn(journal, 'adoptionBinding'), false);
      assert.equal(mig.status().state, 'MIRRORED');
      assert.equal(store.getAccount('row-a')?.status, 'imported-unvalidated');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('second-member mismatch leaves no adoptionBinding, no validated rows, MIRRORED', async () => {
    const live = openLive(pool([
      { id: 'row-a', accountUuid: SLOT_A, credentials: oauth(TOKEN_A) },
      { id: 'row-b', accountUuid: SLOT_B, credentials: oauth(TOKEN_B) },
    ]), [{ access: TOKEN_A, uuid: SLOT_A }, { access: TOKEN_B, uuid: SLOT_A }], SLOT_A);
    seedActiveSlots(live.store, [{ accountId: SLOT_A }, { accountId: SLOT_B }], SLOT_A);
    try {
      const error = await refuse(live);
      assert.equal(error.message, 'identity-mismatch');
      assert.deepEqual(live.log, ['profile:access-token-a', 'usage:access-token-a', 'profile:access-token-b']);
      assert.equal(Object.hasOwn(detail(live), 'adoptionBinding'), false);
      assert.equal(live.store.getAccount('row-a')?.status, 'imported-unvalidated');
      assert.equal(live.store.getAccount('row-b')?.status, 'imported-unvalidated');
      assert.equal(live.mig.status().state, 'MIRRORED');
    } finally {
      live.close();
    }
  });

  it('in-transaction failure leaves no adoptionBinding', async () => {
    const live = openLive(pool([{ id: 'row-a', accountUuid: SLOT_A, credentials: oauth(TOKEN_A) }]), [{ access: TOKEN_A, uuid: SLOT_A }], SLOT_A);
    seedActiveSlots(live.store, [{ accountId: SLOT_A }], SLOT_A);
    live.store.setAccountStatus = () => { throw new Error('fixture-db'); };
    try {
      const error = await refuse(live);
      assert.equal(error.message, 'rehearse failed');
      assert.equal(Object.hasOwn(detail(live), 'adoptionBinding'), false);
      assert.equal(live.mig.status().state, 'MIRRORED');
      assert.equal(live.store.getAccount('row-a')?.status, 'imported-unvalidated');
    } finally {
      live.close();
    }
  });

  it('restage and rollback clear adoptionBinding', async () => {
    const raw = pool([{ id: 'row-a', accountUuid: SLOT_A, credentials: oauth(TOKEN_A) }]);
    const restaged = openLive(raw, [{ access: TOKEN_A, uuid: SLOT_A }], SLOT_A);
    seedActiveSlots(restaged.store, [{ accountId: SLOT_A }], SLOT_A);
    try {
      await restaged.mig.rehearse(async () => ({ ok: true }), undefined, 'member-0001');
      assert.equal(Object.hasOwn(detail(restaged), 'adoptionBinding'), true);
      restaged.mig.stage();
      assert.equal(Object.hasOwn(detail(restaged), 'adoptionBinding'), false);
      assert.equal(restaged.mig.status().state, 'MIRRORED');
    } finally {
      restaged.close();
    }
    const rolled = openLive(raw, [{ access: TOKEN_A, uuid: SLOT_A }], SLOT_A);
    seedActiveSlots(rolled.store, [{ accountId: SLOT_A }], SLOT_A);
    try {
      await rolled.mig.rehearse(async () => ({ ok: true }), undefined, 'member-0001');
      const status = rolled.mig.rollback();
      assert.equal(status.state, 'NATIVE');
      assert.equal(Object.hasOwn(detail(rolled), 'adoptionBinding'), false);
    } finally {
      rolled.close();
    }
  });

  it('status --json and doctor migrations detail never contain slotAccountId', async () => {
    const live = openLive(pool([{ id: 'pool-row', accountUuid: SLOT_A, credentials: oauth(TOKEN_A) }]), [{ access: TOKEN_A, uuid: SLOT_A }], SLOT_A);
    seedActiveSlots(live.store, [{ accountId: SLOT_A }], SLOT_A);
    try {
      await live.mig.rehearse(async () => ({ ok: true }), undefined, 'member-0001');
      const status = JSON.stringify(live.mig.status());
      assert.equal(status.includes(SLOT_A), false);
      assert.equal(status.includes('slotAccountId'), false);
      assert.equal(status.includes('member-0001'), true);
      const home = mkdtempSync(join(tmpdir(), 'qlb-r1b-doctor-'));
      const config = { ...defaultConfig(home), dbPath: live.store.dbPath };
      const report = await doctorQlb(config, {
        command: () => '',
        hostCommand: () => '',
        keychain: new MockKeychain(),
      });
      const migrations = report.checks.find((check) => check.name === 'migrations');
      const rendered = JSON.stringify(migrations);
      assert.equal(rendered.includes(SLOT_A), false);
      assert.equal(rendered.includes('slotAccountId'), false);
      assert.equal(rendered.includes('member-0001'), true);
      rmSync(home, { recursive: true, force: true });
    } finally {
      live.close();
    }
  });

  it('rehearse receipt shows only adoption and initialActive alias', async () => {
    const live = openLive(pool([{ id: 'pool-row', accountUuid: SLOT_A, credentials: oauth(TOKEN_A) }]), [{ access: TOKEN_A, uuid: SLOT_A }], SLOT_A);
    seedActiveSlots(live.store, [{ accountId: SLOT_A }], SLOT_A);
    try {
      await live.mig.rehearse(async () => ({ ok: true }), undefined, 'member-0001');
      const receipt = projectAnthropicReceipt('rehearse', readAnthropicReceiptSources(
        live.poolPath, live.ownerPath, live.store.getMigration(PI_POOL_STORE)?.detail_json,
      ));
      const text = formatAnthropicReceipt(receipt, true);
      assert.equal(JSON.parse(text).adoption, 'verified');
      assert.equal(JSON.parse(text).initialActive, 'member-0001');
      for (const secret of [SLOT_A, TOKEN_A, EMAIL, 'pool-row', `refresh-${TOKEN_A}`]) {
        assert.equal(text.includes(secret), false, secret);
      }
    } finally {
      live.close();
    }
  });

  it('--initial-active rejected on stage, commit and non-anthropic', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-r1b-flag-'));
    const poolPath = join(root, 'anthropic-pool.json');
    const ownerPath = join(root, 'qlb-owner.json');
    const dbPath = join(root, 'qlb.db');
    const env = { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: root, HOME: root, QLB_DB_PATH: dbPath };
    const run = (args: string[]) => {
      try {
        const stdout = execFileSync(process.execPath, [join(__dirname, '..', 'src', 'cli.js'), ...args], {
          encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, stdout, stderr: '' };
      } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { status: failed.status ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
      }
    };
    try {
      for (const sub of ['stage', 'commit']) {
        const result = run(['migrate', sub, '--initial-active', 'member-0001', '--pool-file', poolPath, '--owner-file', ownerPath, '--db', dbPath]);
        assert.equal(result.status, 1, sub);
        assert.match(result.stderr, /--initial-active is only valid with rehearse --provider anthropic/);
      }
      const other = run(['migrate', 'rehearse', '--provider', 'xai', '--initial-active', 'member-0001', '--auth-json', join(root, 'auth.json'), '--owner-file', ownerPath, '--db', dbPath]);
      assert.equal(other.status, 1);
      assert.match(other.stderr, /--initial-active is only valid with rehearse --provider anthropic/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exact call scope unchanged: profile then usage once per member, no refresh or retry', async () => {
    const live = openLive(pool([
      { id: 'row-a', accountUuid: SLOT_A, credentials: oauth(TOKEN_A) },
      { id: 'row-b', accountUuid: SLOT_B, credentials: oauth(TOKEN_B) },
    ]), [{ access: TOKEN_A, uuid: SLOT_A }, { access: TOKEN_B, uuid: SLOT_B }], SLOT_A);
    seedActiveSlots(live.store, [{ accountId: SLOT_A }, { accountId: SLOT_B }], SLOT_A);
    try {
      const status = await live.mig.rehearse(async () => { throw new Error('hook'); }, undefined, 'member-0001');
      assert.equal(status.state, 'VALIDATED');
      assert.deepEqual(live.log, [
        `profile:${TOKEN_A}`, `usage:${TOKEN_A}`, `profile:${TOKEN_B}`, `usage:${TOKEN_B}`,
      ]);
    } finally {
      live.close();
    }
  });
});
