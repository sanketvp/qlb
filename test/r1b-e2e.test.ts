import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  formatAnthropicPreflight,
  runAnthropicPreflight,
} from '../src/anthropic-preflight';
import {
  formatAnthropicReceipt,
  formatAnthropicSmoke,
  projectAnthropicReceipt,
  projectAnthropicSmoke,
  readAnthropicReceiptSources,
} from '../src/anthropic-receipt';
import { InMemoryCredentialBackend } from '../src/cc-credentials';
import { claudePaths } from '../src/cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { createAnthropicGate } from '../src/gate/anthropic';
import { beginCutover } from '../src/lifecycle';
import { MockKeychain } from '../src/keychain';
import { Migration, PI_POOL_STORE, type MigrationConfig } from '../src/migration';
import { runPiGate } from '../src/pi-gate';
import { openStore, type Store } from '../src/store';
import { credential as claudeCredential } from './support/claude-fixtures';

const NOW = 1_700_000_000_000;
const SLOT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SLOT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EMAIL_A = 'a@example.test';
const EMAIL_B = 'b@example.test';
const TOKEN_A = 'pool-access-a';
const TOKEN_B = 'pool-access-b';
const LIVE_TOKEN = 'claude-live-access-b';

function oauth(access: string, expires = NOW + 3 * 60 * 60 * 1000) {
  return { type: 'oauth', access, refresh: `refresh-${access}`, expires };
}

function pool(accounts: unknown[]): string {
  return `${JSON.stringify({ accounts })}\n`;
}

function uuidMember(id: string, accountUuid: string, access: string, expires?: number) {
  return { id, accountUuid, credentials: oauth(access, expires) };
}

interface World {
  home: string;
  dir: string;
  dbPath: string;
  poolPath: string;
  ownerPath: string;
  src: string;
  dst: string;
  store: Store;
  log: string[];
  mig: Migration;
  close: () => void;
}

function openWorld(raw: string, config: MigrationConfig = {}): World {
  const home = mkdtempSync(join(tmpdir(), 'qlb-r1b-e2e-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'qlb-r1b-e2e-pi-'));
  const dbPath = join(home, 'qlb.db');
  const poolPath = join(dir, 'anthropic-pool.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  writeFileSync(poolPath, raw, { mode: 0o600 });
  const store = openStore(dbPath);
  const log: string[] = [];
  const mig = new Migration(store, new MockKeychain(), poolPath, ownerPath, undefined, {
    authJsonPath: join(dir, 'auth.json'),
    now: () => NOW,
    anthropicPoolTransport: {
      async getProfile(access) {
        log.push(`profile:${access}`);
        const uuid = access === TOKEN_A ? SLOT_A : access === TOKEN_B ? SLOT_B : 'duplicate-uuid';
        return { status: 200, body: { account: { uuid } } };
      },
      async getUsage(access) {
        log.push(`usage:${access}`);
        return { status: 200, body: { five_hour: { utilization: 1 }, seven_day: { utilization: 2 } } };
      },
    },
    ...config,
  });
  return {
    home, dir, dbPath, poolPath, ownerPath,
    src: join(dir, 'extensions', 'anthropic-pool'),
    dst: join(dir, 'extensions-disabled-by-qlb', 'anthropic-pool'),
    store, log, mig,
    close: () => {
      store.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedSlots(store: Store, active: string | null, slots = [SLOT_A, SLOT_B]): void {
  const repository = SqliteClaudeSlotRepository.open(store.dbPath);
  repository.commitCswapImport({
    runId: 'r1b-e2e',
    startedAt: NOW,
    committedAt: NOW,
    activeAccountId: active,
    slots: slots.map((accountId) => ({
      slot: {
        accountId,
        email: accountId === SLOT_A ? EMAIL_A : EMAIL_B,
        orgUuid: accountId === SLOT_A ? 'org-a' : 'org-b',
        fingerprint: `sha256:${accountId.slice(0, 8)}`,
        prevFingerprint: null,
        addedAt: NOW,
        configJson: '{}',
      },
      lineageFrom: null,
    })),
  });
  repository.close();
}

function plantExtension(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, 'index.js'), 'extension\n', { mode: 0o600 });
}

async function rehearse(world: World, alias: string): Promise<void> {
  world.mig.stage();
  await world.mig.rehearse(async () => { throw new Error('hook'); }, undefined, alias);
}

function assertNoOwner(world: World): void {
  assert.equal(existsSync(world.ownerPath), false);
  assert.notEqual(world.mig.status().state, 'QLB_OWNED');
}

function assertClean(text: string, secrets: string[]): void {
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
}

const SECRETS = [SLOT_A, SLOT_B, EMAIL_A, EMAIL_B, TOKEN_A, TOKEN_B, LIVE_TOKEN, 'refresh-pool-access-a'];

describe('R1b empty-store end to end', () => {
  it('seeds two Stage-1 slots and the first owned gate returns the initial-active account', async () => {
    const world = openWorld(pool([
      uuidMember('row-a', SLOT_A, TOKEN_A),
      uuidMember('row-b', SLOT_B, TOKEN_B),
    ]));
    plantExtension(world.src);
    seedSlots(world.store, SLOT_B);
    const env = { QLB_TEST_MODE: '1', HOME: world.home, USER: 'fixture-user' };
    const paths = claudePaths({ home: world.home, env });
    writeFileSync(paths.globalConfigPath, JSON.stringify({
      oauthAccount: { accountUuid: SLOT_B, emailAddress: EMAIL_B, organizationUuid: 'org-b' },
    }));
    const backend = new InMemoryCredentialBackend();
    const liveBlob = claudeCredential('b', { accessToken: LIVE_TOKEN, expiresAt: NOW + 3 * 60 * 60 * 1000 });
    await backend.set(paths.keychainService, 'fixture-user', liveBlob);
    try {
      world.mig.stage();
      const preflight = await runAnthropicPreflight({
        dbPath: world.dbPath, poolFile: world.poolPath, backend, now: NOW,
        account: 'fixture-user', env, paths,
      });
      assert.equal(preflight.disposition, 'go');
      assert.equal(preflight.members?.find((member) => member.alias === 'member-0002')?.active, true);
      await world.mig.rehearse(async () => { throw new Error('hook'); }, undefined, 'member-0002');
      const rehearseText = formatAnthropicReceipt(projectAnthropicReceipt('rehearse', readAnthropicReceiptSources(
        world.poolPath, world.ownerPath, world.store.getMigration(PI_POOL_STORE)?.detail_json,
      )), true);
      assert.equal(JSON.parse(rehearseText).disposition, 'success');
      assert.equal(JSON.parse(rehearseText).initialActive, 'member-0002');
      assert.equal(world.mig.commit().state, 'QLB_OWNED');
      const commitText = formatAnthropicReceipt(projectAnthropicReceipt('commit', readAnthropicReceiptSources(
        world.poolPath, world.ownerPath, world.store.getMigration(PI_POOL_STORE)?.detail_json,
      )), true);
      assert.equal(JSON.parse(commitText).disposition, 'success');
      assert.equal(existsSync(world.src), false);
      assert.equal(existsSync(join(world.dst, 'index.js')), true);
      assert.equal(existsSync(`${world.poolPath}.pre-qlb`), true);
      beginCutover(world.store);
      const repository = SqliteClaudeSlotRepository.open(world.dbPath);
      const slots = new ClaudeSlots({
        backend, repository, stashDir: join(world.home, 'unclaimed'), now: () => NOW,
      });
      const stdout: string[] = [];
      const code = await runPiGate('anthropic', {
        dbPath: world.dbPath,
        env: { ...env, QLB_PI_TOKEN_CALL: '1' },
        piAgentDir: world.dir,
        guard: () => true,
        admitted: () => ({ ok: true }),
        cswapProcesses: () => [],
        noRefresh: true,
        deliver: (line) => stdout.push(line),
        provider: createAnthropicGate({
          store: world.store,
          slots,
          live: { backend, paths, account: 'fixture-user', home: world.home, env },
          env,
          now: () => NOW,
        }),
      });
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout[0] ?? '{}').accountId, SLOT_B);
      const smoke = projectAnthropicSmoke({
        journalDetail: JSON.parse(world.store.getMigration(PI_POOL_STORE)?.detail_json ?? 'null') as unknown,
        servedAccountId: world.store.getConfig('pi.anthropic.lastServedAccountId'),
        state: world.store.getMigration(PI_POOL_STORE)?.state ?? null,
      });
      const smokeText = formatAnthropicSmoke(smoke, true);
      assert.equal(JSON.parse(smokeText).matchesInitialActive, true);
      assert.equal(JSON.parse(smokeText).servedAlias, 'member-0002');
      assert.deepEqual(world.log, [
        `profile:${TOKEN_A}`, `usage:${TOKEN_A}`, `profile:${TOKEN_B}`, `usage:${TOKEN_B}`,
      ]);
      const statusText = JSON.stringify(world.mig.status());
      assertClean([preflight && formatAnthropicPreflight(preflight, true), rehearseText, commitText, smokeText, statusText].join('\n'), SECRETS);
      repository.close();
    } finally {
      world.close();
    }
  });

  it('zero slots refuse adoption-slot-missing with no owner', async () => {
    const world = openWorld(pool([uuidMember('row-a', SLOT_A, TOKEN_A)]));
    try {
      world.mig.stage();
      await assert.rejects(
        () => world.mig.rehearse(async () => { throw new Error('hook'); }, undefined, 'member-0001'),
        (error: unknown) => error instanceof Error && error.message === 'adoption-slot-missing',
      );
      assert.deepEqual(world.log, []);
      assertNoOwner(world);
    } finally {
      world.close();
    }
  });

  it('a third pool member without a slot refuses with no owner', async () => {
    const world = openWorld(pool([
      uuidMember('row-a', SLOT_A, TOKEN_A),
      uuidMember('row-b', SLOT_B, TOKEN_B),
      uuidMember('row-c', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'pool-access-c'),
    ]));
    seedSlots(world.store, SLOT_B);
    try {
      world.mig.stage();
      await assert.rejects(
        () => world.mig.rehearse(async () => { throw new Error('hook'); }, undefined, 'member-0002'),
        (error: unknown) => error instanceof Error && error.message === 'adoption-slot-missing',
      );
      assertNoOwner(world);
    } finally {
      world.close();
    }
  });

  it('a duplicate provider UUID refuses with no owner', async () => {
    const world = openWorld(pool([
      uuidMember('row-a', SLOT_A, TOKEN_A),
      uuidMember('row-b', SLOT_B, 'pool-access-same'),
    ]));
    seedSlots(world.store, SLOT_A);
    try {
      world.mig.stage();
      await assert.rejects(
        () => world.mig.rehearse(async () => { throw new Error('hook'); }, undefined, 'member-0001'),
        (error: unknown) => error instanceof Error && error.message === 'identity-mismatch',
      );
      assertNoOwner(world);
    } finally {
      world.close();
    }
  });

  it('two members mapped to one slot and one email member matching two slots both refuse', async () => {
    const shared = openWorld(pool([
      { id: 'row-a', accountUuid: SLOT_A, credentials: oauth(TOKEN_A) },
      { id: 'row-b', email: EMAIL_A, credentials: oauth(TOKEN_B) },
    ]));
    seedSlots(shared.store, SLOT_A, [SLOT_A]);
    const repository = SqliteClaudeSlotRepository.open(shared.store.dbPath);
    const existing = repository.getSlot(SLOT_A);
    repository.close();
    const dbSlots = SqliteClaudeSlotRepository.open(shared.store.dbPath);
    dbSlots.commitCswapImport({
      runId: 'r1b-e2e-email',
      startedAt: NOW,
      committedAt: NOW,
      activeAccountId: SLOT_A,
      slots: [{
        slot: {
          accountId: SLOT_A,
          email: EMAIL_A,
          orgUuid: 'org-a',
          fingerprint: 'sha256:shared',
          prevFingerprint: null,
          addedAt: NOW,
          configJson: '{}',
        },
        lineageFrom: existing?.fingerprint ?? null,
      }],
    });
    dbSlots.close();
    try {
      shared.mig.stage();
      await assert.rejects(
        () => shared.mig.rehearse(async () => { throw new Error('hook'); }, undefined, 'member-0001'),
        (error: unknown) => error instanceof Error && error.message === 'adoption-ambiguous',
      );
      assert.deepEqual(shared.log, []);
      assertNoOwner(shared);
    } finally {
      shared.close();
    }

    const email = openWorld(pool([{ id: 'row-a', email: EMAIL_A, credentials: oauth(TOKEN_A) }]));
    seedSlots(email.store, SLOT_A);
    const extra = SqliteClaudeSlotRepository.open(email.store.dbPath);
    extra.commitCswapImport({
      runId: 'r1b-e2e-extra',
      startedAt: NOW,
      committedAt: NOW,
      activeAccountId: SLOT_A,
      slots: [{
        slot: {
          accountId: SLOT_B, email: EMAIL_A, orgUuid: 'org-b', fingerprint: 'sha256:extra',
          prevFingerprint: null, addedAt: NOW, configJson: '{}',
        },
        lineageFrom: null,
      }],
    });
    extra.close();
    try {
      email.mig.stage();
      await assert.rejects(
        () => email.mig.rehearse(async () => { throw new Error('hook'); }, undefined, 'member-0001'),
        (error: unknown) => error instanceof Error && error.message === 'adoption-ambiguous',
      );
      assertNoOwner(email);
    } finally {
      email.close();
    }
  });

  it('an expired staged token refuses with no GET and no owner', async () => {
    const world = openWorld(pool([uuidMember('row-a', SLOT_A, TOKEN_A, NOW)]));
    seedSlots(world.store, SLOT_A, [SLOT_A]);
    try {
      world.mig.stage();
      await assert.rejects(
        () => world.mig.rehearse(async () => { throw new Error('hook'); }, undefined, 'member-0001'),
        (error: unknown) => error instanceof Error && error.message === 'token-expired',
      );
      assert.deepEqual(world.log, []);
      assertNoOwner(world);
    } finally {
      world.close();
    }
  });

  it('--initial-active other than the active login refuses with no owner', async () => {
    const world = openWorld(pool([
      uuidMember('row-a', SLOT_A, TOKEN_A),
      uuidMember('row-b', SLOT_B, TOKEN_B),
    ]));
    seedSlots(world.store, SLOT_B);
    try {
      world.mig.stage();
      await assert.rejects(
        () => world.mig.rehearse(async () => { throw new Error('hook'); }, undefined, 'member-0001'),
        (error: unknown) => error instanceof Error && error.message === 'initial-active-invalid',
      );
      assert.deepEqual(world.log, []);
      assertNoOwner(world);
    } finally {
      world.close();
    }
  });

  it('an active-login change during admission refuses with no owner', async () => {
    const world = openWorld(pool([uuidMember('row-a', SLOT_A, TOKEN_A)]), {
      beforeFinalPublicationAdmission: () => {
        world.store.setActiveLogin('anthropic', SLOT_B, 'auto', NOW);
      },
    });
    seedSlots(world.store, SLOT_A, [SLOT_A]);
    try {
      await rehearse(world, 'member-0001');
      assert.throws(() => world.mig.commit(), (error: unknown) => (
        error instanceof Error && error.message === 'adoption-mismatch'
      ));
      assertNoOwner(world);
    } finally {
      world.close();
    }
  });

  it('a dead slot refuses with no owner', async () => {
    const world = openWorld(pool([uuidMember('row-a', SLOT_A, TOKEN_A)]), {
      beforeFinalPublicationAdmission: () => {
        const db = new DatabaseSync(world.store.dbPath);
        db.prepare('UPDATE claude_slots SET dead = 1 WHERE account_id = ?').run(SLOT_A);
        db.close();
      },
    });
    seedSlots(world.store, SLOT_A, [SLOT_A]);
    try {
      await rehearse(world, 'member-0001');
      assert.throws(() => world.mig.commit(), (error: unknown) => (
        error instanceof Error && error.message === 'adoption-mismatch'
      ));
      assertNoOwner(world);
    } finally {
      world.close();
    }
  });

  it('both extension directories present refuse with no owner', async () => {
    const world = openWorld(pool([uuidMember('row-a', SLOT_A, TOKEN_A)]));
    seedSlots(world.store, SLOT_A, [SLOT_A]);
    plantExtension(world.src);
    plantExtension(world.dst);
    try {
      await rehearse(world, 'member-0001');
      assert.throws(() => world.mig.commit(), (error: unknown) => (
        error instanceof Error && error.message === 'anthropic-pool-dir-ambiguous'
      ));
      assertNoOwner(world);
    } finally {
      world.close();
    }
  });
});
