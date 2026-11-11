import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { projectAnthropicReceipt, readAnthropicReceiptSources } from '../src/anthropic-receipt';
import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
import { PROOF_FRESH_MS, assessAnthropicForwardAdmission } from '../src/anthropic-forward-admission';
import { MockKeychain } from '../src/keychain';
import { Migration, PI_POOL_STORE, projectMigrationStatusDetail, type MigrationConfig } from '../src/migration';
import { openStore, type Store } from '../src/store';
import { seedActiveSlots } from './support/adoption-slots';

const NOW = 1_700_000_000_000;
const EMAIL = 'ada@example.com';
const SLOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN = 'access-token-a';

function poolText(): string {
  return `${JSON.stringify({
    accounts: [{
      id: 'row-a',
      email: EMAIL,
      credentials: { type: 'oauth', access: TOKEN, refresh: 'refresh-token-a', expires: NOW + 3 * 60 * 60 * 1000 },
    }],
  })}\n`;
}

function transport() {
  return {
    async getProfile() {
      return { status: 200, body: { account: { uuid: SLOT, email: EMAIL } } };
    },
    async getUsage() {
      return { status: 200, body: { five_hour: { utilization: 1 }, seven_day: { utilization: 2 } } };
    },
  };
}

interface Live {
  dir: string;
  poolPath: string;
  ownerPath: string;
  store: Store;
  mig: Migration;
  close: () => void;
}

function openReady(config: MigrationConfig = {}): Live {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-r1b-commit-'));
  const poolPath = join(dir, 'anthropic-pool.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  writeFileSync(poolPath, poolText(), { mode: 0o600 });
  const store = openStore(join(dir, 'qlb.db'));
  seedActiveSlots(store, [{ accountId: SLOT, email: EMAIL }], SLOT);
  const mig = new Migration(store, new MockKeychain(), poolPath, ownerPath, undefined, {
    authJsonPath: join(dir, 'auth.json'),
    now: () => NOW,
    initialActiveAlias: 'member-0001',
    anthropicPoolTransport: transport(),
    ...config,
  });
  mig.stage();
  return {
    dir, poolPath, ownerPath, store, mig,
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function rehearse(live: Live): Promise<void> {
  const status = await live.mig.rehearse(async () => { throw new Error('hook'); });
  assert.equal(status.state, 'VALIDATED');
}

function refuseCommit(live: Live): Error & { exitCode?: number } {
  try {
    live.mig.commit();
  } catch (error) {
    return error as Error & { exitCode?: number };
  }
  assert.fail('commit succeeded');
}

describe('anthropic commit adoption', () => {
  it('commit refuses adoption-mismatch when active login changes between rehearse and commit', async () => {
    const live = openReady({
      beforeFinalPublicationAdmission: () => {
        live.store.setActiveLogin('anthropic', OTHER, 'auto', NOW);
      },
    });
    try {
      await rehearse(live);
      const error = refuseCommit(live);
      assert.equal(error.message, 'adoption-mismatch');
      assert.equal(error.exitCode, 3);
      assert.equal(existsSync(live.ownerPath), false);
      assert.equal(live.mig.status().state, 'VALIDATED');
    } finally {
      live.close();
    }
  });

  it('commit refuses when a mapped slot is struck dead after rehearse', async () => {
    const live = openReady({
      beforeFinalPublicationAdmission: () => {
        const db = new DatabaseSync(live.store.dbPath);
        db.prepare('UPDATE claude_slots SET dead = 1 WHERE account_id = ?').run(SLOT);
        db.close();
      },
    });
    try {
      await rehearse(live);
      const error = refuseCommit(live);
      assert.equal(error.message, 'adoption-mismatch');
      assert.equal(existsSync(live.ownerPath), false);
    } finally {
      live.close();
    }
  });

  it('commit refuses when a second slot with the member email appears after rehearse (ambiguous)', async () => {
    const live = openReady({
      beforeFinalPublicationAdmission: () => {
        const db = new DatabaseSync(live.store.dbPath);
        db.prepare(`INSERT INTO claude_slots (account_id, email, config_json, dead, added_at, archived_at)
          VALUES (?, ?, '{}', 0, 1, NULL)`).run(OTHER, EMAIL);
        db.close();
      },
    });
    try {
      await rehearse(live);
      const error = refuseCommit(live);
      assert.equal(error.message, 'adoption-mismatch');
      assert.equal(existsSync(live.ownerPath), false);
    } finally {
      live.close();
    }
  });

  it('commit refuses an R1a-only VALIDATED cycle without adoptionBinding', async () => {
    const live = openReady();
    try {
      await rehearse(live);
      const row = live.store.getMigration(PI_POOL_STORE);
      const detail = JSON.parse(row?.detail_json ?? '{}') as Record<string, unknown>;
      delete detail.adoptionBinding;
      live.store.upsertMigration(PI_POOL_STORE, 'VALIDATED', JSON.stringify(detail));
      const error = refuseCommit(live);
      assert.equal(error.message, 'adoption-mismatch');
      assert.equal(existsSync(live.ownerPath), false);
    } finally {
      live.close();
    }
  });

  it('status never advertises complete commit when adoption refuses', async () => {
    const live = openReady();
    try {
      await rehearse(live);
      live.store.setActiveLogin('anthropic', OTHER, 'auto', NOW);
      const status = live.mig.status();
      assert.equal(status.resumeAction, 'adoption-mismatch');
      assert.equal(status.resumeAction.includes('complete commit'), false);
    } finally {
      live.close();
    }
  });

  it('commit receipt success requires the adoption marker', async () => {
    const live = openReady();
    try {
      await rehearse(live);
      const committed = live.mig.commit();
      assert.equal(committed.state, 'QLB_OWNED');
      const detail = JSON.parse(live.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as {
        adoption?: { version?: number; cycle?: string };
        postOwnerAdmission?: { cycle?: string };
      };
      assert.equal(detail.adoption?.version, 1);
      assert.equal(detail.adoption?.cycle, detail.postOwnerAdmission?.cycle);
      const sources = readAnthropicReceiptSources(
        live.poolPath,
        live.ownerPath,
        live.store.getMigration(PI_POOL_STORE)?.detail_json,
      );
      sources.adoptionSlots = live.store.listClaudeAdoptionSlots();
      sources.activeAccountId = SLOT;
      sources.now = NOW;
      assert.equal(projectAnthropicReceipt('commit', sources).disposition, 'success');
      const stripped = JSON.parse(live.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as Record<string, unknown>;
      delete stripped.adoption;
      live.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', JSON.stringify(stripped));
      const refused = projectAnthropicReceipt('commit', {
        ...readAnthropicReceiptSources(live.poolPath, live.ownerPath, live.store.getMigration(PI_POOL_STORE)?.detail_json),
        adoptionSlots: live.store.listClaudeAdoptionSlots(),
        activeAccountId: SLOT,
        now: NOW,
      });
      assert.equal(refused.disposition, 'refused');
      assert.equal(refused.disposition === 'refused' && refused.code, 'adoption-mismatch');
    } finally {
      live.close();
    }
  });

  it('crash after owner entry: resume converges only with matching adoption', async () => {
    let crash = true;
    const live = openReady({
      afterWrite: (point) => {
        if (crash && point === 'owner-entry') throw new Error('crash-owner-entry');
      },
    });
    try {
      await rehearse(live);
      assert.throws(() => live.mig.commit(), /crash-owner-entry/);
      assert.equal(existsSync(live.ownerPath), true);
      const resumed = new Migration(live.store, new MockKeychain(), live.poolPath, live.ownerPath, undefined, {
        authJsonPath: join(live.dir, 'auth.json'),
        now: () => NOW,
      });
      assert.equal(resumed.resume().state, 'QLB_OWNED');
    } finally {
      live.close();
    }

    crash = true;
    const drifted = openReady({
      afterWrite: (point) => {
        if (crash && point === 'owner-entry') throw new Error('crash-owner-entry');
      },
    });
    try {
      await rehearse(drifted);
      assert.throws(() => drifted.mig.commit(), /crash-owner-entry/);
      const db = new DatabaseSync(drifted.store.dbPath);
      db.prepare('UPDATE claude_slots SET dead = 1 WHERE account_id = ?').run(SLOT);
      db.close();
      const resumed = new Migration(drifted.store, new MockKeychain(), drifted.poolPath, drifted.ownerPath, undefined, {
        authJsonPath: join(drifted.dir, 'auth.json'),
        now: () => NOW,
      });
      assert.throws(() => resumed.resume(), (error: unknown) => (
        error instanceof Error && error.message === 'adoption-mismatch'
      ));
      assert.equal(existsSync(drifted.ownerPath), true);
    } finally {
      drifted.close();
    }
  });

  it('doctor QLB_OWNED detail keeps the adoption marker and drops slotAccountId', async () => {
    const live = openReady();
    try {
      await rehearse(live);
      live.mig.commit();
      const stored = JSON.parse(live.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as Record<string, unknown>;
      stored.intent = 'rollback';
      const projected = JSON.stringify(projectMigrationStatusDetail(stored, true));
      assert.equal(projected.includes(SLOT), false);
      assert.equal(projected.includes('slotAccountId'), false);
      assert.equal(projected.includes('"adoption"'), true);
      live.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', JSON.stringify(stored));
      const home = mkdtempSync(join(tmpdir(), 'qlb-r1b-doctor-owned-'));
      const report = await doctorQlb({ ...defaultConfig(home), dbPath: live.store.dbPath }, {
        command: () => '',
        hostCommand: () => '',
        keychain: new MockKeychain(),
      });
      const rendered = JSON.stringify(report.checks.find((check) => check.name === 'migrations'));
      assert.equal(rendered.includes(SLOT), false);
      assert.equal(rendered.includes('slotAccountId'), false);
      rmSync(home, { recursive: true, force: true });
    } finally {
      live.close();
    }
  });

  it('300000 ms admits, 300001 ms refuses: unchanged', () => {
    const provedAt = 1_000;
    const base = {
      canonicalOwnerEntry: false,
      postOwnerCycle: null,
      binding: {
        cycle: 'cycle-1',
        memberCount: 1,
        aliases: ['member-0001'],
        identityKinds: ['accountUuid' as const],
        commitmentDigest: 'abcd',
      },
      storedWitness: { version: 1, algorithm: 'sha256', digest: 'abcd' },
      recomputedWitnessDigest: 'abcd',
      recomputedCommitmentDigest: 'abcd',
      sourcePresent: true,
      identityProof: {
        version: 1,
        cycle: 'cycle-1',
        provedAt,
        memberCount: 1,
        aliases: ['member-0001'],
        members: [{
          alias: 'member-0001',
          identityKind: 'accountUuid' as const,
          hasProviderUuid: true as const,
          buckets: { '5h': 1, '7d': 2 },
        }],
      },
      identityMismatch: false,
      adoptionMismatch: false,
      adoptionMarkerCycle: 'cycle-1',
    };
    assert.equal(assessAnthropicForwardAdmission({ ...base, now: provedAt + PROOF_FRESH_MS }, 'pre-owner'), 'ADMIT_PRE_OWNER');
    assert.equal(assessAnthropicForwardAdmission({ ...base, now: provedAt + PROOF_FRESH_MS + 1 }, 'pre-owner'), 'proof-stale');
  });
});
