import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it, mock } from 'node:test';
import { createOwnedCredentialSource } from '../src/credentials';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { OPENROUTER_GATE_KEYCHAIN_SERVICE } from '../src/token/openrouter';
import {
  ADAPTER_ACCOUNT_IDS,
  ADAPTER_ACCOUNT_LABELS,
  Migration,
  NATIVE_OPENROUTER_KEYCHAIN_SERVICE,
  SINGLE_GRANT_PROVIDERS,
  createSingleGrantMigration,
  createStaticKeyMigration,
  parseApiKeyPayload,
  stageGenericGrant,
  stagingOwnerPath,
  type ApiKeyPayload,
  type MigrationConfig,
  type RehearseFn,
  type SingleGrantProvider,
  type StagedAccount,
} from '../src/migration';
import { parseGrant } from '../src/refresh-lease';
import type { RollbackDecision } from '../src/single-grant-ownership';
import { legacyPiAuthBackupPath, piAuthBackupPath, readPiAuthBackup, writePiAuthBackup } from '../src/pi-auth-backup';
import { canonicalDigest, keychainDigest, restoreRecordFor } from '../src/pi-handback-source';
import { openStore } from '../src/store';

const fs = require('node:fs') as typeof import('node:fs');

/**
 * Fixture grants — fake tokens only. This file never points at the live
 * Pi agent directory; every auth.json path is a temp copy.
 *
 * Adapter accountId sources (must stay in lockstep):
 *   src/adapters/xai.ts    snapshot.accountId = 'xai-default'
 *   src/adapters/kimi.ts   claimId            = 'kimi-default'
 *   src/adapters/codex.ts  S29 slot identity
 */
const ROLLBACK_DECISION: RollbackDecision = {
  kind: 'keychain',
  generation: 0,
  fingerprint: 'fixture-fingerprint',
  entryPresent: true,
  sourceDigest: 'fixture-source-digest',
  kd0: 'fixture-kd0',
  decidedAt: 123,
  fencedGeneration: 0,
};

const FAKE_GRANTS: Record<
  SingleGrantProvider,
  { type: 'oauth'; access: string; refresh: string; expires: number; accountId?: string }
> = {
  xai: {
    type: 'oauth',
    access: 'xai-access-fake',
    refresh: 'xai-refresh-fake',
    expires: Date.now() + 7 * 24 * 3600 * 1000,
  },
  'kimi-coding': {
    type: 'oauth',
    access: 'kimi-access-fake',
    refresh: 'kimi-refresh-fake',
    expires: Date.now() + 7 * 24 * 3600 * 1000,
  },
  'openai-codex': {
    type: 'oauth',
    access: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account' },
    })).toString('base64url')}.sig`,
    refresh: 'codex-refresh-fake',
    expires: Date.now() + 7 * 24 * 3600 * 1000,
    accountId: 'fixture-account',
  },
};

function fixtureAuthJson(): string {
  return JSON.stringify(FAKE_GRANTS, null, 2) + '\n';
}

function mockRehearse(calls: StagedAccount[]): RehearseFn {
  return async (account) => {
    calls.push(account);
    assert.ok(account.grant.access, 'rehearse received staged access token');
    assert.ok(account.grant.refresh, 'rehearse received staged refresh token');
    return { ok: true };
  };
}

function expectedId(provider: SingleGrantProvider): string {
  return provider === 'openai-codex' ? 'fixture-user:fixture-account' : ADAPTER_ACCOUNT_IDS[provider];
}

function expectedLabel(provider: SingleGrantProvider): string {
  return provider === 'openai-codex' ? expectedId(provider) : ADAPTER_ACCOUNT_LABELS[provider];
}

class RollbackDeleteKeychain extends MockKeychain {
  mode: 'succeed' | 'denied' | 'not-found' = 'succeed';

  override deleteSync(service: string, account: string): void {
    if (this.mode === 'denied') throw new Error('fixture Keychain access denied');
    if (this.mode === 'not-found') throw new Error('fixture Keychain item not found');
    super.deleteSync(service, account);
  }
}

function keychainHas(
  kc: MockKeychain,
  provider: SingleGrantProvider,
): boolean {
  try {
    const raw = kc.getSync(
      qlbKeychainService(provider, expectedId(provider)),
      expectedLabel(provider),
    );
    const grant = parseGrant(raw);
    return grant.access === FAKE_GRANTS[provider].access;
  } catch {
    return false;
  }
}

function fileSnapshot(dir: string, prefix = ''): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [nestedPath, bytes] of fileSnapshot(path, relative)) files.set(nestedPath, bytes);
    } else if (entry.isFile()) {
      files.set(relative, readFileSync(path));
    }
  }
  return files;
}

interface Harness {
  dir: string;
  authPath: string;
  ownerPath: string;
  originalBytes: Buffer;
  store: ReturnType<typeof openStore>;
  kc: MockKeychain;
  cleanup: () => void;
}

function setup(
  provider: SingleGrantProvider,
  kc: MockKeychain = new MockKeychain(),
  config: Pick<MigrationConfig, 'fsyncDirectory' | 'afterStep' | 'sleepSync' | 'now'> = {},
): Harness & {
  mig: Migration;
} {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
  const authPath = join(dir, 'auth.json');
  const ownerPath = join(dir, `qlb-owner-${provider}.json`);
  const original = fixtureAuthJson();
  writeFileSync(authPath, original, { encoding: 'utf8', mode: 0o600 });
  const originalBytes = readFileSync(authPath);
  const store = openStore(join(dir, 'qlb.db'));
  const mig = createSingleGrantMigration(
    store,
    kc,
    provider,
    authPath,
    ownerPath,
    provider,
    config,
  );
  return {
    dir,
    authPath,
    ownerPath,
    originalBytes,
    store,
    kc,
    mig,
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('generic single-grant migration — xai / kimi-coding / openai-codex', () => {
  for (const provider of SINGLE_GRANT_PROVIDERS) {
    it(`happy path ${provider}: stage → rehearse → commit; accountId matches adapter; auth.json shadow-retained`, async () => {
      const h = setup(provider);
      try {
        const before = readFileSync(h.authPath);
        const id = expectedId(provider);

        const staged = h.mig.stage();
        assert.equal(staged.state, 'MIRRORED');
        assert.equal(staged.ownerFile, 'staging');
        assert.equal(staged.nativeStore, 'intact');
        assert.equal(staged.piAtNextLaunch, 'native works');
        assert.equal(staged.nativeStrategy, 'shadow-retain');
        assert.equal(staged.provider, provider);
        assert.deepEqual(readFileSync(h.authPath), before, 'stage must not touch auth.json');
        assert.equal(keychainHas(h.kc, provider), true);
        assert.equal(h.store.getAccount(id)?.id, id);
        assert.equal(h.store.getAccount(id)?.provider, provider);

        const rehearseCalls: StagedAccount[] = [];
        const rehearsed = await h.mig.rehearse(mockRehearse(rehearseCalls));
        assert.equal(rehearsed.state, 'VALIDATED');
        assert.equal(rehearseCalls.length, 1);
        assert.equal(rehearseCalls[0]?.id, id);
        assert.equal(rehearseCalls[0]?.provider, provider);
        assert.equal(rehearseCalls[0]?.grant.access, FAKE_GRANTS[provider].access);
        assert.deepEqual(readFileSync(h.authPath), before, 'rehearse must not touch auth.json');

        const committed = h.mig.commit();
        assert.equal(committed.state, 'QLB_OWNED');
        assert.equal(committed.ownerFile, 'present');
        assert.equal(committed.nativeStore, 'intact', 'auth.json stays in place');
        assert.equal(committed.piAtNextLaunch, 'QLB works');
        assert.equal(committed.nativeStrategy, 'shadow-retain');
        assert.deepEqual(
          readFileSync(h.authPath),
          h.originalBytes,
          'commit must shadow-retain auth.json byte-identical',
        );
        const parsed = JSON.parse(readFileSync(h.authPath, 'utf8')) as Record<string, unknown>;
        assert.ok(parsed.xai, 'other providers remain in the shared file');
        assert.ok(parsed['kimi-coding']);
        assert.ok(parsed['openai-codex']);
        const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as {
          owner: string;
          nativeStrategy?: string;
          qlbAccountIds: string[];
        };
        assert.equal(owner.owner, 'qlb');
        assert.equal(owner.nativeStrategy, 'shadow-retain');
        assert.deepEqual(owner.qlbAccountIds, [id]);
        assert.equal(keychainHas(h.kc, provider), true);
      } finally {
        h.cleanup();
      }
    });
  }

  it('T-RS re-stages xai and kimi-coding at the store generation, resets status, and clears prior hand-back detail', async () => {
    for (const provider of ['xai', 'kimi-coding'] as const) {
      for (const lifecycle of ['MIRRORED', 'VALIDATED', 'NATIVE'] as const) {
        const h = setup(provider);
        try {
          const id = expectedId(provider);
          h.mig.stage();
          if (lifecycle === 'VALIDATED') {
            await h.mig.rehearse(mockRehearse([]));
          } else if (lifecycle === 'NATIVE') {
            h.mig.rollback();
            assert.equal(keychainHas(h.kc, provider), false, 'precondition: rollback deleted the staged grant');
          }

          assert.equal(h.store.casGrantGeneration(id, 0, 7), 1);
          h.store.setAccountStatus(id, 'handed-back');
          h.store.upsertMigration(`pi-${provider}`, lifecycle, JSON.stringify({
            commitGeneration: 3,
            lastRollback: { cleanedAt: 1 },
          }));

          const staged = h.mig.stage();
          const detail = JSON.parse(h.store.getMigration(`pi-${provider}`)!.detail_json) as Record<string, unknown>;
          const grant = parseGrant(h.kc.getSync(
            qlbKeychainService(provider, id),
            expectedLabel(provider),
          ));

          assert.equal(staged.state, 'MIRRORED', `${provider} re-stages from ${lifecycle}`);
          assert.equal(h.store.getAccount(id)?.status, 'imported-unvalidated');
          assert.equal(grant.generation, 7);
          assert.equal(detail.commitGeneration, undefined);
          assert.equal(detail.rollbackDecision, undefined);
          assert.equal(detail.handback, undefined);
          assert.equal(detail.lastRollback, undefined);
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-E1 stage and commit refuse while a hand-back marker is set', async () => {
    const markers: Array<{
      name: 'intent' | 'decision' | 'cleanup-pending';
      detail: Record<string, unknown>;
      code: 'rollback-in-progress' | 'handback-cleanup-pending';
    }> = [
      { name: 'intent', detail: { intent: 'rollback' }, code: 'rollback-in-progress' },
      { name: 'decision', detail: { rollbackDecision: { kind: 'keychain' } }, code: 'rollback-in-progress' },
      {
        name: 'cleanup-pending',
        detail: {
          handback: {
            phase: 'cleanup-pending',
            keychainDisposition: 'keep',
            piFingerprint: null,
            decision: null,
            fencedGeneration: null,
            rolledBackAt: 1,
          },
        },
        code: 'handback-cleanup-pending',
      },
    ];

    for (const command of ['stage', 'commit'] as const) {
      for (const marker of markers) {
        const h = setup('xai');
        try {
          if (command === 'commit') {
            h.mig.stage();
            await h.mig.rehearse(mockRehearse([]));
          }
          const row = h.store.getMigration('pi-xai');
          const state = command === 'stage' ? 'NATIVE' : row!.state;
          const detail = command === 'stage'
            ? marker.detail
            : { ...JSON.parse(row!.detail_json), ...marker.detail };
          h.store.upsertMigration('pi-xai', state, JSON.stringify(detail));
          const rowBefore = h.store.getMigration('pi-xai');
          const filesBefore = fileSnapshot(h.dir);
          const service = qlbKeychainService('xai', expectedId('xai'));
          const account = expectedLabel('xai');
          const keychainBefore = command === 'commit' ? h.kc.getSync(service, account) : null;

          assert.throws(
            () => h.mig[command](),
            (error: Error) => {
              assert.match(error.message, new RegExp(marker.code));
              return true;
            },
            `${command}/${marker.name} refuses its active hand-back marker`,
          );
          assert.deepEqual(h.store.getMigration('pi-xai'), rowBefore, `${command}/${marker.name} preserves the journal`);
          assert.deepEqual(fileSnapshot(h.dir), filesBefore, `${command}/${marker.name} preserves files`);
          if (keychainBefore !== null) {
            assert.equal(h.kc.getSync(service, account), keychainBefore, `${command}/${marker.name} preserves Keychain`);
          }
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-CG commit journals commitGeneration before the owner write', async () => {
    const h = setup('xai');
    try {
      const id = expectedId('xai');
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      assert.equal(h.store.casGrantGeneration(id, 0, 7), 1);
      const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
      let journaledBeforeClaim = false;
      h.store.upsertMigration = (store, state, detail) => {
        const recorded = JSON.parse(detail ?? '{}') as { commitGeneration?: number };
        if (store === 'pi-xai' && state === 'VALIDATED' && recorded.commitGeneration === 7) {
          assert.equal(existsSync(h.ownerPath), false, 'the claim does not precede its baseline journal');
          journaledBeforeClaim = true;
        }
        return originalUpsertMigration(store, state, detail);
      };

      h.mig.commit();

      assert.equal(journaledBeforeClaim, true);
      const committed = h.store.getMigration('pi-xai');
      assert.equal(committed?.state, 'QLB_OWNED');
      assert.equal(
        JSON.parse(committed!.detail_json).commitGeneration,
        7,
        'the pre-claim journal records the store generation used as the commit baseline',
      );
      assert.equal(existsSync(h.ownerPath), true, 'the owner claim is written after the baseline journal');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0a every generic entry point refuses a provider P7a owns', () => {
    for (const ownershipFact of ['state', 'journal'] as const) {
      for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
        const h = setup('xai');
        try {
          const journalDir = join(h.dir, 'pi-migrate-journal');
          if (ownershipFact === 'state') {
            h.store.setConfig('pi.xai.state', 'migrated');
          } else {
            mkdirSync(journalDir, { recursive: true });
            writeFileSync(join(journalDir, 'pi-migrate-xai.json'), '{}\n');
          }
          const migration = new Migration(h.store, h.kc, h.authPath, h.ownerPath, 'pi-xai', {
            kind: 'single-grant',
            provider: 'xai',
            authJsonKey: 'xai',
            piMigrateJournalDir: journalDir,
          });

          let error: Error & { exitCode?: unknown };
          try {
            migration[command]();
            assert.fail('expected P7a ownership refusal');
          } catch (caught) {
            error = caught as Error & { exitCode?: unknown };
          }
          assert.match(error.message, /owned-by-pi-migrate: run `qlb pi rollback xai`/);
          assert.equal(error.exitCode, 3, `${ownershipFact}/${command} is an operator refusal`);
          assert.equal(h.store.getMigration('pi-xai'), null, `${ownershipFact}/${command} leaves no generic journal`);
          assert.equal(existsSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai')), false);
          assert.equal(keychainHas(h.kc, 'xai'), false);
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-S0e every generic entry point refuses a provider both paths own', async () => {
    for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        h.store.setConfig('pi.xai.state', 'migrated');

        let error: Error & { exitCode?: unknown };
        try {
          h.mig[command]();
          assert.fail('expected dual ownership refusal');
        } catch (caught) {
          error = caught as Error & { exitCode?: unknown };
        }
        assert.match(
          error.message,
          /dual-ownership: run `qlb pi rollback xai` first, then `qlb migrate rollback --provider xai`/,
        );
        assert.equal(error.exitCode, 3, `${command} is an operator refusal`);
        assert.equal(h.store.getMigration('pi-xai')?.state, 'QLB_OWNED');
        assert.equal(existsSync(h.ownerPath), true, `${command} leaves the generic claim intact`);
        assert.equal(keychainHas(h.kc, 'xai'), true, `${command} leaves the generic credential intact`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-OW2 a pi migrate journal written while stage waits for the auth lock makes stage refuse owned-by-pi-migrate with nothing written', () => {
    const h = setup('xai');
    try {
      const journalDir = join(h.dir, 'pi-migrate-journal');
      const p7aJournal = join(journalDir, 'pi-migrate-xai.json');
      let seamCalls = 0;
      const migration = new Migration(h.store, h.kc, h.authPath, h.ownerPath, 'pi-xai', {
        kind: 'single-grant',
        provider: 'xai',
        authJsonKey: 'xai',
        piMigrateJournalDir: journalDir,
        beforeOwnershipLock: () => {
          seamCalls += 1;
          mkdirSync(journalDir, { recursive: true });
          writeFileSync(p7aJournal, '{}\n');
        },
      });

      assert.throws(
        () => migration.stage(),
        (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owned-by-pi-migrate: run `qlb pi rollback xai`/);
          assert.equal(error.exitCode, 3);
          return true;
        },
      );
      assert.equal(seamCalls, 1, 'the P7a publication races immediately before the shared lock');
      assert.equal(h.store.getMigration('pi-xai'), null, 'stage writes no generic journal');
      assert.equal(existsSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai')), false);
      assert.equal(keychainHas(h.kc, 'xai'), false, 'stage writes no managed credential');
      assert.deepEqual(readFileSync(h.authPath), h.originalBytes, 'stage leaves auth.json unchanged');
    } finally {
      h.cleanup();
    }
  });

  it('T-OW2 stage classifies ownership and makes its first writes while holding the auth lock pi migrate takes', () => {
    const h = setup('xai');
    try {
      const lockDir = `${resolve(h.authPath)}.lock`;
      assert.equal(existsSync(lockDir), false);
      const heldAt: string[] = [];
      const store = h.store as unknown as Record<string, (...args: unknown[]) => unknown>;
      const originalUpsert = store.upsertMigration.bind(h.store);
      store.upsertMigration = (...args: unknown[]) => { heldAt.push(`journal:${existsSync(lockDir)}`); return originalUpsert(...args); };
      const originalSet = h.kc.setSync.bind(h.kc);
      h.kc.setSync = (service: string, account: string, value: string) => { heldAt.push(`keychain:${existsSync(lockDir)}`); originalSet(service, account, value); };
      h.mig.stage();
      assert.ok(heldAt.length > 0, 'stage wrote something');
      assert.ok(heldAt.every((entry) => entry.endsWith(':true')), `every stage write ran under ${lockDir}: ${heldAt.join(', ')}`);
      assert.equal(existsSync(lockDir), false, 'the auth lock is released after stage');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0d rebuilt default migration uses the journaled auth key', () => {
    const h = setup('xai');
    try {
      h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({ authJsonKey: 'grok' }));
      const rebuilt = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, h.ownerPath);

      const key = (rebuilt as unknown as { singleGrantAuthKey: () => string }).singleGrantAuthKey();

      assert.equal(key, 'grok');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0d conflicting explicit auth key is refused with auth-key-mismatch', () => {
    const h = setup('xai');
    try {
      const detail = JSON.stringify({ authJsonKey: 'grok' });
      h.store.upsertMigration('pi-xai', 'QLB_OWNED', detail);
      const conflicting = createSingleGrantMigration(
        h.store,
        h.kc,
        'xai',
        h.authPath,
        h.ownerPath,
        'other-alias',
      );

      assert.throws(
        () => (conflicting as unknown as { singleGrantAuthKey: () => string }).singleGrantAuthKey(),
        /auth\.json key mismatch/,
      );
      assert.equal(h.store.getMigration('pi-xai')?.detail_json, detail, 'refusal leaves the journal unchanged');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0f rollback after a crash between the commit point and QLB_OWNED finishes the commit and hands back', async () => {
    for (const claim of ['legacy-sidecar', 'owner-map'] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        const row = h.store.getMigration('pi-xai');
        assert.ok(row, 'staging records the generic migration');
        const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
        h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({
          ...detail,
          commitGeneration: h.store.getGrantGeneration(expectedId('xai')),
        }));

        const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
        if (claim === 'legacy-sidecar') {
          renameSync(staging, h.ownerPath);
        } else {
          rmSync(staging);
          writeFileSync(join(h.dir, 'qlb-owner.json'), JSON.stringify({
            providers: { xai: { mode: 'qlb' } },
          }) + '\n');
        }

        const transitions: Array<{ state: string; intent?: unknown }> = [];
        const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
        h.store.upsertMigration = (store, state, nextDetail) => {
          if (store === 'pi-xai') {
            transitions.push({
              state,
              intent: (JSON.parse(nextDetail ?? '{}') as Record<string, unknown>).intent,
            });
          }
          return originalUpsertMigration(store, state, nextDetail);
        };

        const rolled = h.mig.rollback();

        const finishedForward = transitions.findIndex((entry) => entry.state === 'QLB_OWNED');
        const beganHandback = transitions.findIndex(
          (entry, index) => index > finishedForward && entry.intent === 'rollback',
        );
        assert.ok(finishedForward >= 0, `${claim}: finishHygiene completes the interrupted commit`);
        assert.ok(beganHandback > finishedForward, `${claim}: rollback starts only after the forward finish`);
        assert.equal(rolled.state, 'NATIVE');
        assert.equal(rolled.detail.intent, undefined);
        assert.equal((rolled.detail.lastRollback as { rolledBackFrom: unknown }).rolledBackFrom, 'post-commit');
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S1 rollback journals intent before any other write and keeps the journal state', async () => {
    {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        const writes: Array<{ state: string; detail: Record<string, unknown> }> = [];
        const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
        h.store.upsertMigration = (store, state, detail) => {
          if (store === 'pi-xai') writes.push({ state, detail: JSON.parse(detail ?? '{}') as Record<string, unknown> });
          return originalUpsertMigration(store, state, detail);
        };

        h.mig.rollback();

        assert.equal(writes[0]?.detail.intent, 'rollback', 'S1 is the first rollback write');
        assert.equal(writes[0]?.state, 'QLB_OWNED', 'S1 preserves a QLB_OWNED journal state');
      } finally {
        h.cleanup();
      }
    }

    {
      const dir = mkdtempSync(join(tmpdir(), 'qlb-s1-native-'));
      const poolPath = join(dir, 'anthropic-pool.json');
      const ownerPath = join(dir, 'qlb-owner.json');
      const store = openStore(join(dir, 'qlb.db'));
      const kc = new MockKeychain();
      const mig = new Migration(store, kc, poolPath, ownerPath);
      writeFileSync(poolPath, JSON.stringify({
        version: 1,
        accounts: [{
          id: 'fixture-account',
          name: 'Fixture Account',
          credentials: {
            type: 'oauth',
            access: 'pool-access-fake',
            refresh: 'pool-refresh-fake',
            expires: Date.now() + 7 * 24 * 3600 * 1000,
          },
        }],
      }) + '\n');
      try {
        mig.stage();
        await mig.rehearse(mockRehearse([]));
        mig.commit();
        const committed = store.getMigration('pi-pool');
        assert.ok(committed);
        store.upsertMigration('pi-pool', 'NATIVE', committed.detail_json);

        const writes: Array<{ state: string; detail: Record<string, unknown> }> = [];
        const originalUpsertMigration = store.upsertMigration.bind(store);
        let crashAfterS1 = true;
        store.upsertMigration = (storeName, state, detail) => {
          if (storeName === 'pi-pool') {
            const write = { state, detail: JSON.parse(detail ?? '{}') as Record<string, unknown> };
            writes.push(write);
            const result = originalUpsertMigration(storeName, state, detail);
            if (crashAfterS1 && write.detail.intent === 'rollback') throw new Error('fixture crash after S1');
            return result;
          }
          return originalUpsertMigration(storeName, state, detail);
        };

        assert.throws(() => mig.rollback(), /fixture crash after S1/);
        assert.equal(writes[0]?.detail.intent, 'rollback', 'S1 is the first rollback write');
        assert.equal(writes[0]?.state, 'NATIVE', 'S1 preserves a NATIVE journal state');
        assert.equal(mig.status().detail.intent, 'rollback', 'status reports the interrupted C4 hand-back');
        assert.match(mig.status().resumeAction, /continue rollback/, 'status directs C4 recovery');

        crashAfterS1 = false;
        assert.equal(mig.resume().state, 'VALIDATED', 'resume routes the NATIVE intent through C4 continuation');
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('T-S0b every command refuses an orphan or unreadable O, L, or Oc claim without changing durable state', () => {
    for (const claim of ['O', 'L', 'Oc', 'unreadable-O', 'unreadable-L', 'unreadable-Oc'] as const) {
      for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
        const h = setup('xai');
        try {
          const customPath = join(h.dir, 'custom-owner.json');
          const useDefaultPath = claim === 'O' || claim === 'L' || claim === 'unreadable-O' || claim === 'unreadable-L';
          const migration = useDefaultPath
            ? h.mig
            : createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
          const ownerPath = claim === 'O' || claim === 'unreadable-O' ? join(h.dir, 'qlb-owner.json')
            : claim === 'L' || claim === 'unreadable-L' ? h.ownerPath
              : customPath;
          const unreadable = claim.startsWith('unreadable-');
          const ownerBytes = unreadable
            ? '{not valid JSON\n'
            : claim === 'O'
              ? JSON.stringify({ providers: { xai: { mode: 'qlb' } } }) + '\n'
              : JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n';
          writeFileSync(ownerPath, ownerBytes);

          const service = qlbKeychainService('xai', expectedId('xai'));
          const keychainBytes = JSON.stringify({ preserved: `${claim}-${command}` });
          h.kc.setSync(service, expectedLabel('xai'), keychainBytes);
          const journalBefore = h.store.getMigration('pi-xai');

          assert.throws(
            () => migration[command](),
            (error: Error & { exitCode?: unknown }) => {
              assert.match(error.message, /owner-file-orphan/);
              assert.match(error.message, new RegExp(ownerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
              if (unreadable) {
                assert.match(error.message, /could not be read/);
              } else if (claim === 'O') {
                assert.match(error.message, /Remove only the xai entry.*do not delete the file/);
              } else {
                assert.match(error.message, /Remove the file/);
              }
              assert.equal(error.exitCode, 3);
              return true;
            },
            `${claim}/${command} is refused`,
          );

          assert.equal(
            h.kc.getSync(service, expectedLabel('xai')),
            keychainBytes,
            `${claim}/${command} leaves the Keychain bytes unchanged`,
          );
          assert.deepEqual(
            readFileSync(ownerPath),
            Buffer.from(ownerBytes),
            `${claim}/${command} leaves the owner file bytes unchanged`,
          );
          assert.deepEqual(
            h.store.getMigration('pi-xai'),
            journalBefore,
            `${claim}/${command} leaves the journal unchanged`,
          );
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-S0h refuses a later unreadable O/L/Oc claim even when an earlier claim is valid', async () => {
    const cases = [
      { name: 'valid O + dangling L', valid: 'O', unreadable: 'L' },
      { name: 'valid O + malformed L', valid: 'O', unreadable: 'L-malformed' },
      { name: 'valid L + unreadable Oc', valid: 'L', unreadable: 'Oc' },
    ] as const;

    for (const testCase of cases) {
      for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
        const h = setup('xai');
        try {
          const customPath = join(h.dir, 'custom-owner.json');
          const migration = testCase.unreadable === 'Oc'
            ? createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath)
            : h.mig;
          if (command !== 'stage') {
            migration.stage();
            await migration.rehearse(mockRehearse([]));
          }

          const mapPath = join(h.dir, 'qlb-owner.json');
          const validPath = testCase.valid === 'O' ? mapPath : h.ownerPath;
          writeFileSync(validPath, testCase.valid === 'O'
            ? JSON.stringify({ providers: { xai: { mode: 'qlb' } } }) + '\n'
            : JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');
          const unreadablePath = testCase.unreadable.startsWith('L') ? h.ownerPath : customPath;
          if (testCase.unreadable === 'L') {
            const target = join(h.dir, `missing-${command}`);
            symlinkSync(target, unreadablePath);
          } else {
            writeFileSync(unreadablePath, '{not valid JSON\n');
          }

          const stagingPath = stagingOwnerPath(mapPath, 'xai');
          const service = qlbKeychainService('xai', expectedId('xai'));
          if (command === 'stage') {
            h.kc.setSync(service, expectedLabel('xai'), JSON.stringify({ preserved: testCase.name }));
          }
          const journalBefore = h.store.getMigration('pi-xai');
          const keychainBefore = h.kc.getSync(service, expectedLabel('xai'));
          const stagingBefore = existsSync(stagingPath) ? readFileSync(stagingPath) : null;
          const validBefore = readFileSync(validPath);
          const unreadableBefore = testCase.unreadable === 'L'
            ? readlinkSync(unreadablePath)
            : readFileSync(unreadablePath);

          assert.throws(() => migration[command](), (error: Error & { exitCode?: unknown }) => {
            assert.match(error.message, new RegExp(`owner-file-orphan: ${unreadablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could not be read`));
            assert.equal(error.exitCode, 3);
            return true;
          }, `${testCase.name}/${command} refuses the later unreadable claim`);
          assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, `${testCase.name}/${command} preserves the journal`);
          assert.equal(h.kc.getSync(qlbKeychainService('xai', expectedId('xai')), expectedLabel('xai')), keychainBefore, `${testCase.name}/${command} preserves Keychain`);
          assert.deepEqual(existsSync(stagingPath) ? readFileSync(stagingPath) : null, stagingBefore, `${testCase.name}/${command} preserves staging`);
          assert.deepEqual(readFileSync(validPath), validBefore, `${testCase.name}/${command} preserves the valid claim`);
          if (testCase.unreadable === 'L') {
            assert.equal(readlinkSync(unreadablePath), unreadableBefore, `${testCase.name}/${command} keeps the dangling link`);
          } else {
            assert.deepEqual(readFileSync(unreadablePath), unreadableBefore, `${testCase.name}/${command} preserves the unreadable claim`);
          }
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-S0i rehearse refuses an unreadable L before validating the journal', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      writeFileSync(h.ownerPath, '{not valid JSON\n');
      const journalBefore = h.store.getMigration('pi-xai');
      const stagingPath = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      const stagingBefore = readFileSync(stagingPath);
      const keychainBefore = h.kc.getSync(qlbKeychainService('xai', expectedId('xai')), expectedLabel('xai'));
      const ownerBefore = readFileSync(h.ownerPath);

      await assert.rejects(
        () => h.mig.rehearse(mockRehearse([])),
        (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, new RegExp(`owner-file-orphan: ${h.ownerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could not be read`));
          assert.equal(error.exitCode, 3);
          return true;
        },
      );
      assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore);
      assert.deepEqual(readFileSync(stagingPath), stagingBefore);
      assert.equal(h.kc.getSync(qlbKeychainService('xai', expectedId('xai')), expectedLabel('xai')), keychainBefore);
      assert.deepEqual(readFileSync(h.ownerPath), ownerBefore);
    } finally {
      h.cleanup();
    }
  });

  it('T-S0g refuses unreadable claims with write-ahead commit evidence without changing recovery artifacts', async () => {
    for (const command of ['commit', 'rollback', 'resume'] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({
          ...detail,
          commitGeneration: h.store.getGrantGeneration(expectedId('xai')),
        }));
        const mapPath = join(h.dir, 'qlb-owner.json');
        const stagingPath = stagingOwnerPath(mapPath, 'xai');
        writeFileSync(mapPath, '{not valid JSON\n');

        const journalBefore = h.store.getMigration('pi-xai');
        const keychainBefore = h.kc.getSync(qlbKeychainService('xai', expectedId('xai')), expectedLabel('xai'));
        const stagingBefore = readFileSync(stagingPath);
        const mapBefore = readFileSync(mapPath);

        assert.throws(() => h.mig[command](), (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owner-file-orphan: .*qlb-owner\.json could not be read/);
          assert.equal(error.exitCode, 3);
          return true;
        }, `${command} refuses ambiguous C evidence`);
        assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, `${command} preserves the journal`);
        assert.equal(h.kc.getSync(qlbKeychainService('xai', expectedId('xai')), expectedLabel('xai')), keychainBefore, `${command} preserves the Keychain payload`);
        assert.deepEqual(readFileSync(stagingPath), stagingBefore, `${command} preserves staging`);
        assert.deepEqual(readFileSync(mapPath), mapBefore, `${command} preserves O`);
        assert.equal(existsSync(h.ownerPath), false, `${command} does not create L`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S0g refuses dangling O, L, and Oc symlinks before stage or commit writes', async () => {
    for (const claim of ['O', 'L', 'Oc'] as const) {
      for (const command of ['stage', 'commit'] as const) {
        const h = setup('xai');
        try {
          const customPath = join(h.dir, 'custom-owner.json');
          const migration = claim === 'Oc'
            ? createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath)
            : h.mig;
          if (command === 'commit') {
            migration.stage();
            await migration.rehearse(mockRehearse([]));
          }
          const claimPath = claim === 'O' ? join(h.dir, 'qlb-owner.json')
            : claim === 'L' ? h.ownerPath
              : customPath;
          const target = join(h.dir, `missing-${claim.toLowerCase()}-${command}`);
          symlinkSync(target, claimPath);
          const stagingPath = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
          const journalBefore = h.store.getMigration('pi-xai');
          const keychainBefore = command === 'commit'
            ? h.kc.getSync(qlbKeychainService('xai', expectedId('xai')), expectedLabel('xai'))
            : null;
          const stagingBefore = existsSync(stagingPath) ? readFileSync(stagingPath) : null;

          assert.throws(() => migration[command](), (error: Error & { exitCode?: unknown }) => {
            assert.match(error.message, /owner-file-orphan: .*could not be read/);
            assert.equal(error.exitCode, 3);
            return true;
          }, `${claim}/${command} refuses the dangling link`);
          assert.equal(readlinkSync(claimPath), target, `${claim}/${command} keeps the symlink`);
          assert.equal(existsSync(target), false, `${claim}/${command} does not create the target`);
          assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore, `${claim}/${command} preserves the journal`);
          if (keychainBefore === null) {
            assert.throws(() => h.kc.getSync(qlbKeychainService('xai', expectedId('xai')), expectedLabel('xai')));
          } else {
            assert.equal(h.kc.getSync(qlbKeychainService('xai', expectedId('xai')), expectedLabel('xai')), keychainBefore, `${claim}/${command} preserves the Keychain payload`);
          }
          assert.deepEqual(existsSync(stagingPath) ? readFileSync(stagingPath) : null, stagingBefore, `${claim}/${command} preserves staging`);
        } finally {
          h.cleanup();
        }
      }
    }
  });

  it('T-S0b treats an ENOTDIR claim lookup as present before stage writes anything', () => {
    const h = setup('xai');
    try {
      const blockedParent = join(h.dir, 'not-a-directory');
      writeFileSync(blockedParent, 'not a directory');
      const customPath = join(blockedParent, 'custom-owner.json');
      const migration = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
      const journalBefore = h.store.getMigration('pi-xai');
      const service = qlbKeychainService('xai', expectedId('xai'));
      const keychainBytes = JSON.stringify({ preserved: 'ENOTDIR' });
      h.kc.setSync(service, expectedLabel('xai'), keychainBytes);

      assert.throws(
        () => migration.stage(),
        (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owner-file-orphan/);
          assert.match(error.message, /could not be read/);
          assert.equal(error.exitCode, 3);
          return true;
        },
      );
      assert.deepEqual(h.store.getMigration('pi-xai'), journalBefore);
      assert.equal(h.kc.getSync(service, expectedLabel('xai')), keychainBytes);
    } finally {
      h.cleanup();
    }
  });

  it('T-S0f a crash-commit under a custom owner file (Oc) finishes forward and hands back', async () => {
    const h = setup('xai');
    try {
      const customPath = join(h.dir, 'custom-owner.json');
      const mig = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({
        ...detail,
        commitGeneration: h.store.getGrantGeneration(expectedId('xai')),
      }));
      rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'), { force: true });
      writeFileSync(customPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');

      const states: string[] = [];
      const original = h.store.upsertMigration.bind(h.store);
      h.store.upsertMigration = (store, state, next) => {
        if (store === 'pi-xai') states.push(state);
        return original(store, state, next);
      };
      const rolled = mig.rollback();
      assert.ok(states.includes('QLB_OWNED'), 'the Oc claim with own evidence is finished forward');
      assert.equal((rolled.detail.lastRollback as { rolledBackFrom: unknown }).rolledBackFrom, 'post-commit');
      assert.equal(existsSync(customPath), false, 'the hand-back removes the custom owner file');
    } finally {
      h.cleanup();
    }
  });

  it('rollback with a journaled intent over an Oc claim takes the post-commit path', async () => {
    const h = setup('xai');
    try {
      const customPath = join(h.dir, 'custom-owner.json');
      const mig = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({
        ...detail,
        commitGeneration: h.store.getGrantGeneration(expectedId('xai')),
        intent: 'rollback',
      }));
      rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'), { force: true });
      writeFileSync(customPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');

      const states: string[] = [];
      const original = h.store.upsertMigration.bind(h.store);
      h.store.upsertMigration = (store, state, next) => {
        if (store === 'pi-xai') states.push(state);
        return original(store, state, next);
      };
      const rolled = mig.rollback();

      assert.equal(states.includes('NATIVE'), true, 'S5 writes the OD-7 post-commit terminal state');
      assert.equal(existsSync(customPath), false, 'the post-commit hand-back removes the custom owner file');
      assert.equal((rolled.detail.lastRollback as { rolledBackFrom: unknown }).rolledBackFrom, 'post-commit');
    } finally {
      h.cleanup();
    }
  });

  it('resume after a crash between the C5 forward finish and the rollback intent keeps an Oc claim owned', async () => {
    const h = setup('xai');
    try {
      const customPath = join(h.dir, 'custom-owner.json');
      const mig = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
      mig.stage();
      await mig.rehearse(mockRehearse([]));
      const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      rmSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'), { force: true });
      writeFileSync(customPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n');
      // State right after C5's finishHygiene, before postCommitRollback journals its intent.
      h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({ ...detail, committedAt: Date.now() }));

      const resumed = mig.resume();
      assert.equal(resumed.state, 'QLB_OWNED', 'resume must not report a hand-back while the Oc claim remains');
      assert.equal(existsSync(customPath), true);
    } finally {
      h.cleanup();
    }
  });

  it('C5 never finishes forward without own evidence or over a journaled rollback', async () => {
    for (const fixture of ['orphan-owner-map', 'rollback-intent'] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
        if (fixture === 'orphan-owner-map') {
          // O alone, with no L and no commitGeneration, is not this path's commit.
          rmSync(staging);
          writeFileSync(join(h.dir, 'qlb-owner.json'), JSON.stringify({ providers: { xai: { mode: 'qlb' } } }) + '\n');
        } else {
          renameSync(staging, h.ownerPath);
          h.store.upsertMigration('pi-xai', 'VALIDATED', JSON.stringify({
            ...detail,
            commitGeneration: h.store.getGrantGeneration(expectedId('xai')),
            intent: 'rollback',
          }));
        }

        const states: string[] = [];
        const original = h.store.upsertMigration.bind(h.store);
        h.store.upsertMigration = (store, state, next) => {
          if (store === 'pi-xai') states.push(state);
          return original(store, state, next);
        };
        try {
          h.mig.rollback();
        } catch {
          // Refusing is acceptable here; journaling QLB_OWNED is not.
        }
        assert.equal(states.includes('QLB_OWNED'), false, `${fixture}: C5 must not journal QLB_OWNED`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-E3 rollback and resume route C7-C9 without touching at-rest migration state', async () => {
    for (const command of ['rollback', 'resume'] as const) {
      const c7 = setup('xai');
      try {
        c7.mig.stage();
        await c7.mig.rehearse(mockRehearse([]));
        const result = c7.mig[command]();
        assert.equal(result.state, command === 'rollback' ? 'NATIVE' : 'QLB_OWNED', `C7/${command}`);
        assert.equal(
          keychainHas(c7.kc, 'xai'),
          command === 'resume',
          `C7/${command} ${command === 'rollback' ? 'removes' : 'keeps'} the staged grant`,
        );
      } finally {
        c7.cleanup();
      }

      const c8 = setup('xai');
      try {
        c8.mig.stage();
        const result = c8.mig[command]();
        assert.equal(result.state, 'NATIVE', `C8/${command}`);
        assert.equal(keychainHas(c8.kc, 'xai'), false, `C8/${command} removes the staged grant`);
      } finally {
        c8.cleanup();
      }

      for (const state of ['NATIVE', 'VALIDATED'] as const) {
        const c9 = setup('xai');
        try {
          c9.mig.stage();
          rmSync(stagingOwnerPath(join(c9.dir, 'qlb-owner.json'), 'xai'));
          const row = c9.store.getMigration('pi-xai');
          assert.ok(row, 'fixture has a generic journal');
          c9.store.upsertMigration('pi-xai', state, row.detail_json);
          const keychainBefore = c9.kc.getSync(
            qlbKeychainService('xai', expectedId('xai')),
            expectedLabel('xai'),
          );
          const journalBefore = c9.store.getMigration('pi-xai');
          const filesBefore = fileSnapshot(c9.dir);

          const result = c9.mig[command]();

          assert.equal(result.state, state, `C9 ${state}/${command} is a no-op`);
          assert.equal(result.resumeAction, 'nothing to roll back', `C9 ${state}/${command} reports the no-op`);
          assert.equal(
            c9.kc.getSync(qlbKeychainService('xai', expectedId('xai')), expectedLabel('xai')),
            keychainBefore,
            `C9 ${state}/${command} keeps K_m byte-for-byte`,
          );
          assert.deepEqual(c9.store.getMigration('pi-xai'), journalBefore, `C9 ${state}/${command} keeps the journal`);
          assert.deepEqual(fileSnapshot(c9.dir), filesBefore, `C9 ${state}/${command} keeps every file byte-for-byte`);
        } finally {
          c9.cleanup();
        }
      }
    }
  });

  it('a post-commit hand-back writes the full marker shape and ends through it', async () => {
    for (const [name, disposition] of [
      ['matching Pi entry', 'delete'],
      ['non-matching Pi entry', 'keep'],
    ] as const) {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        if (disposition === 'keep') {
          const auth = JSON.parse(readFileSync(h.authPath, 'utf8')) as typeof FAKE_GRANTS;
          auth.xai = { ...auth.xai, refresh: 'xai-refresh-nonmatching-fake' };
          writeFileSync(h.authPath, JSON.stringify(auth, null, 2) + '\n');
        }

        let marker: Record<string, unknown> | undefined;
        const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
        h.store.upsertMigration = (store, state, detail) => {
          const parsed = JSON.parse(detail ?? '{}') as Record<string, unknown>;
          if (store === 'pi-xai' && state === 'NATIVE' && parsed.handback) {
            marker = parsed.handback as Record<string, unknown>;
          }
          return originalUpsertMigration(store, state, detail);
        };

        const rolled = h.mig.rollback();
        assert.equal(rolled.state, 'NATIVE', `${name}: OD-7 terminal state`);
        assert.ok(marker, `${name}: S5 writes its cleanup-pending marker`);
        assert.deepEqual(Object.keys(marker!).sort(), [
          'decision',
          'fencedGeneration',
          'keychainDisposition',
          'phase',
          'piFingerprint',
          'rolledBackAt',
        ]);
        assert.equal(marker!.phase, 'cleanup-pending');
        assert.equal(marker!.keychainDisposition, disposition);
        assert.equal(typeof marker!.piFingerprint, 'string');
        assert.ok(marker!.decision, `${name}: S5 copies the recorded S2 decision`);
        assert.equal(
          marker!.fencedGeneration,
          (marker!.decision as RollbackDecision).fencedGeneration,
          `${name}: S5 copies the S2 fence`,
        );
        assert.equal(typeof marker!.rolledBackAt, 'number');
        const lastRollback = rolled.detail.lastRollback as Record<string, unknown>;
        const { rolledBackFrom, cleanedAt, ...lastMarker } = lastRollback;
        assert.deepEqual(lastMarker, marker, `${name}: S7 copies every H field verbatim`);
        assert.equal(rolledBackFrom, 'post-commit');
        assert.equal(typeof cleanedAt, 'number');
        assert.equal(rolled.detail.commitGeneration, undefined, `${name}: S5 clears commitGeneration`);
        assert.equal(rolled.detail.handback, undefined, `${name}: S7 clears the marker`);
        assert.equal(keychainHas(h.kc, 'xai'), disposition === 'keep', `${name}: recorded disposition controls K_m`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('a crash right after the S5 write resumes to the same terminal state and disposition', async () => {
    for (const disposition of ['delete', 'keep'] as const) {
      const h = setup('xai', new MockKeychain(), {
        afterStep: (point) => {
          if ((point as string) === 'S5') throw new Error('fixture crash after S5');
        },
      });
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        if (disposition === 'keep') {
          const auth = JSON.parse(readFileSync(h.authPath, 'utf8')) as typeof FAKE_GRANTS;
          auth.xai = { ...auth.xai, refresh: 'xai-refresh-nonmatching-fake' };
          writeFileSync(h.authPath, JSON.stringify(auth, null, 2) + '\n');
        }

        assert.throws(() => h.mig.rollback(), /fixture crash after S5/);
        const crashed = h.store.getMigration('pi-xai');
        assert.equal(crashed?.state, 'NATIVE');
        assert.equal((JSON.parse(crashed!.detail_json).handback as { keychainDisposition: unknown }).keychainDisposition, disposition);

        const resumed = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, h.ownerPath);
        const settled = resumed.resume();
        assert.equal(settled.state, 'NATIVE');
        assert.equal(
          (settled.detail.lastRollback as { keychainDisposition: unknown }).keychainDisposition,
          disposition,
          'resume uses the recorded S5 verdict rather than re-ranking',
        );
        assert.equal(keychainHas(h.kc, 'xai'), disposition === 'keep');
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-I4 a live lease makes S2 wait without spending retry attempts and a released lease lets it fence', async () => {
    const waits = 9;
    let now = 1_000_000;
    let sleeps = 0;
    let outsideReads = 0;
    const h = setup('xai', new MockKeychain(), {
      now: () => now,
      sleepSync: (ms) => {
        assert.equal(ms, 100);
        sleeps += 1;
        now += ms;
      },
      afterStep: (point) => {
        if (point === 'S2-reads') outsideReads += 1;
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const accountId = (JSON.parse(h.store.getMigration('pi-xai')!.detail_json).accounts as Array<{ id: string }>)[0].id;
      const originalGetLease = h.store.getLease.bind(h.store);
      h.store.getLease = (name) => name === `refresh:${accountId}` && sleeps < waits
        ? { name, holder_pid: 1, holder_id: 'fixture-refresher', until: now + 1_000, generation: 1 }
        : originalGetLease(name);

      const rolled = h.mig.rollback();

      assert.equal(rolled.state, 'NATIVE');
      assert.equal(sleeps, waits, 'the live lease is waited out');
      assert.equal(outsideReads, waits + 1, 'every wait re-runs outside reads without consuming a RETRY attempt');
      assert.equal(h.store.getGrantGeneration(accountId), 1, 'S2 fences after the lease is released');
    } finally {
      h.cleanup();
    }
  });

  it('T-I4 cap: a lease live past 30 s refuses refresh-in-progress with exit code 3 and keeps only the intent', async () => {
    let now = 2_000_000;
    let sleeps = 0;
    let outsideReads = 0;
    const h = setup('xai', new MockKeychain(), {
      now: () => now,
      sleepSync: (ms) => {
        assert.equal(ms, 100);
        sleeps += 1;
        now += ms;
      },
      afterStep: (point) => {
        if (point === 'S2-reads') outsideReads += 1;
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const accountId = (JSON.parse(h.store.getMigration('pi-xai')!.detail_json).accounts as Array<{ id: string }>)[0].id;
      const generationBefore = h.store.getGrantGeneration(accountId);
      const keychainPresentBefore = keychainHas(h.kc, 'xai');
      const originalGetLease = h.store.getLease.bind(h.store);
      h.store.getLease = (name) => name === `refresh:${accountId}`
        ? { name, holder_pid: 1, holder_id: 'fixture-refresher', until: now + 1_000, generation: 1 }
        : originalGetLease(name);

      assert.throws(
        () => h.mig.rollback(),
        (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /refresh-in-progress/);
          assert.equal(error.exitCode, 3);
          return true;
        },
      );
      const refused = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      assert.equal(sleeps, 300, 'the wait cap is 30 seconds at 100 ms intervals');
      assert.equal(outsideReads, 301, 'the last live-lease check also re-runs outside reads');
      assert.equal(refused.intent, 'rollback', 'the rollback intent stays durable');
      assert.equal(refused.rollbackDecision, undefined, 'S2 records no decision after the wait cap');
      assert.equal(h.store.getGrantGeneration(accountId), generationBefore, 'S2 does not fence under a live lease');
      assert.equal(keychainHas(h.kc, 'xai'), keychainPresentBefore, 'the Keychain copy is unchanged');
    } finally {
      h.cleanup();
    }
  });

  it('T-I5 a refresher whose lease expired before the fence is fenced at its write', async () => {
    let now = 3_000_000;
    let sleeps = 0;
    const h = setup('xai', new MockKeychain(), {
      now: () => now,
      sleepSync: () => { sleeps += 1; },
      afterStep: (point) => {
        if (point === 'S2') throw new Error('fixture crash after S2');
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const accountId = (JSON.parse(h.store.getMigration('pi-xai')!.detail_json).accounts as Array<{ id: string }>)[0].id;
      const originalGetLease = h.store.getLease.bind(h.store);
      h.store.getLease = (name) => name === `refresh:${accountId}`
        ? { name, holder_pid: 1, holder_id: 'fixture-refresher', until: now, generation: 0 }
        : originalGetLease(name);

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(sleeps, 0, 'an expired lease is not waited for');
      assert.equal(h.store.getGrantGeneration(accountId), 1, 'S2 fences despite the expired lease');
      let refresherWrote = false;
      const writeAtOldGeneration = (): number => {
        if (h.store.casGrantGeneration(accountId, 0, 1) !== 1) return 0;
        refresherWrote = true;
        return 1;
      };
      assert.equal(writeAtOldGeneration(), 0, 'the refresher\'s stale generation CAS is refused');
      assert.equal(refresherWrote, false, 'the refused stale CAS prevents the refresher write');
    } finally {
      h.cleanup();
    }
  });

  it('a refresh lease live at the S5 Keychain read refuses the hand-back and keeps the Keychain copy', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const accountId = (JSON.parse(h.store.getMigration('pi-xai')!.detail_json).accounts as Array<{ id: string }>)[0].id;
      const service = qlbKeychainService('xai', accountId);
      const account = expectedLabel('xai');
      let reads = 0;
      const originalGetLease = h.store.getLease.bind(h.store);
      const originalGetSync = h.kc.getSync.bind(h.kc);
      h.store.getLease = (name) => reads >= 3 && name === `refresh:${accountId}`
        ? { name, holder_pid: 1, holder_id: 'fixture-refresher', until: Date.now() + 60_000, generation: 1 }
        : originalGetLease(name);
      h.kc.getSync = (readService, readAccount) => {
        const raw = originalGetSync(readService, readAccount);
        if (readService === service && readAccount === account) reads += 1;
        return raw;
      };

      assert.throws(() => h.mig.rollback(), /refresh-in-progress/);
      assert.ok(reads >= 3, 'the refusal comes from the S5 read, after S2 fenced');
      const refused = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
      assert.notEqual(refused.rollbackDecision, undefined, 'S2 already recorded its decision');
      assert.equal(refused.handback, undefined, 'no hand-back marker is recorded');
      assert.equal(keychainHas(h.kc, 'xai'), true, 'the Keychain copy is not deleted');

      h.store.getLease = originalGetLease;
      h.kc.getSync = originalGetSync;
      assert.equal(h.mig.resume().state, 'NATIVE', 'resume completes once the lease is gone');
    } finally {
      h.cleanup();
    }
  });

  it('S2 keychain sourceDigest is the S3 restore record built from the grant and the backup entry', async () => {
    let decision: RollbackDecision | undefined;
    const h = setup('openai-codex', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2') {
          decision = JSON.parse(h.store.getMigration('pi-openai-codex')!.detail_json).rollbackDecision as RollbackDecision;
          throw new Error('fixture crash after S2');
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const grant = parseGrant(h.kc.getSync(qlbKeychainService('openai-codex', expectedId('openai-codex')), expectedLabel('openai-codex')))!;
      assert.equal(typeof grant.extra?.accountId, 'string', 'the fixture grant carries an accountId');
      const backup = readPiAuthBackup(h.authPath, 'openai-codex');

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(decision?.kind, 'keychain');
      const previous = backup?.entry && typeof backup.entry === 'object' ? backup.entry as Record<string, unknown> : {};
      const expected = restoreRecordFor({
        authPath: h.authPath,
        key: 'openai-codex',
        decidedAt: decision!.decidedAt,
        filePresent: true,
        entryPresent: true,
        entry: {
          ...previous,
          type: grant.extra?.type ?? previous.type ?? 'oauth',
          access: grant.access,
          refresh: grant.refresh,
          expires: grant.expires,
          accountId: grant.extra?.accountId,
        },
      });
      assert.equal(decision?.sourceDigest, canonicalDigest(expected));
    } finally {
      h.cleanup();
    }
  });

  it('T-I2 a refresh that commits between the outside reads and the fence forces re-selection', async () => {
    let reads = 0;
    let observedFence: number | undefined;
    let observedDecision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2-reads' && reads++ === 0) {
          const id = expectedId('xai');
          const service = qlbKeychainService('xai', id);
          const raw = h.kc.getSync(service, expectedLabel('xai'));
          h.kc.setSync(service, expectedLabel('xai'), JSON.stringify({
            ...JSON.parse(raw), generation: 1, refresh: 'xai-refresh-rotated-fake',
          }));
          assert.equal(h.store.casGrantGeneration(id, 0, 1), 1, 'fake refresher commits generation one');
        }
        if (point === 'S2') {
          observedDecision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
          observedFence = observedDecision.fencedGeneration;
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      h.mig.rollback();

      assert.equal(reads, 2, 'a generation mismatch re-runs the outside reads');
      assert.equal(observedFence, 2, 'the retry ranks and fences the committed refresher generation');
      assert.equal(observedDecision?.generation, 1, 'the retry re-ranked onto the refresher grant');
      assert.equal(observedDecision?.fingerprint, createHash('sha256').update('xai-refresh-rotated-fake', 'utf8').digest('hex'));
    } finally {
      h.cleanup();
    }
  });

  it('T-I3 a C3 Keychain write between the reads and a backup decision forces re-selection', async () => {
    let reads = 0;
    let observedDecision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2-reads' && reads++ === 0) {
          const service = qlbKeychainService('xai', expectedId('xai'));
          const raw = h.kc.getSync(service, expectedLabel('xai'));
          h.kc.setSync(service, expectedLabel('xai'), JSON.stringify({
            ...JSON.parse(raw), generation: 1, refresh: 'xai-refresh-c3-fake',
          }));
        }
        if (point === 'S2') {
          observedDecision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      writePiAuthBackup(h.authPath, 'xai', 'fixture');

      h.mig.rollback();

      const service = qlbKeychainService('xai', expectedId('xai'));
      const rewritten = parseGrant(h.kc.getSync(service, expectedLabel('xai')));
      assert.equal(reads, 2, 'a Keychain digest mismatch re-runs the outside reads');
      assert.equal(observedDecision?.kind, 'keychain', 'the new C3 grant outranks the backup');
      assert.equal(observedDecision?.kd0, keychainDigest(rewritten), 'the committed decision records the rewritten Keychain digest');
    } finally {
      h.cleanup();
    }
  });

  it('T-I6 a native-resync copy between the reads and the fence is excluded by ranking', async () => {
    let reads = 0;
    let observedDecision: RollbackDecision | undefined;
    let resynced: string | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2-reads' && reads++ === 0) {
          const service = qlbKeychainService('xai', expectedId('xai'));
          const raw = h.kc.getSync(service, expectedLabel('xai'));
          resynced = JSON.stringify({ ...JSON.parse(raw), generation: 1, writtenBy: 'native-resync' });
          h.kc.setSync(service, expectedLabel('xai'), resynced);
        }
        if (point === 'S2') {
          observedDecision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      writePiAuthBackup(h.authPath, 'xai', 'fixture');

      h.mig.rollback();

      assert.equal(reads, 2, 'a native-resync Keychain write re-runs the outside reads');
      assert.equal(observedDecision?.kind, 'exact-backup', 'ranking excludes the native-resync copy');
      assert.equal(observedDecision?.kd0, keychainDigest(parseGrant(resynced!)), 'the decision records the re-read Keychain digest');
      assert.equal(observedDecision?.fencedGeneration, 2, 'the fence is max(g0, k0) + 1 from the re-read k0 = 1');
    } finally {
      h.cleanup();
    }
  });

  it('T-S2a decision and fence commit in one transaction', async () => {
    let committedDecision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point !== 'S2') return;
        const row = h.store.getMigration('pi-xai')!;
        committedDecision = JSON.parse(row.detail_json).rollbackDecision as RollbackDecision;
        assert.equal(h.store.getGrantGeneration(expectedId('xai')), committedDecision.fencedGeneration);
        assert.equal(existsSync(h.ownerPath), true, 'S2 commits before the existing un-own path');
        throw new Error('fixture crash after S2');
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const runImmediate = h.store.runImmediate.bind(h.store);
      let inS2Transaction = false;
      let casInsideTransaction = false;
      let journalInsideTransaction = false;
      const cas = h.store.casGrantGeneration.bind(h.store);
      const journal = h.store.upsertMigration.bind(h.store);
      h.store.runImmediate = (<T>(fn: () => T): T => runImmediate(() => {
        inS2Transaction = true;
        try {
          return fn();
        } finally {
          inS2Transaction = false;
        }
      })) as typeof h.store.runImmediate;
      h.store.casGrantGeneration = (id, from, to) => {
        casInsideTransaction ||= inS2Transaction;
        return cas(id, from, to);
      };
      h.store.upsertMigration = (store, state, detail, updatedAt) => {
        if (store === 'pi-xai' && JSON.parse(detail ?? '{}').rollbackDecision) {
          journalInsideTransaction ||= inS2Transaction;
        }
        return journal(store, state, detail, updatedAt);
      };

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(casInsideTransaction, true, 'the fence CAS runs in S2\'s immediate transaction');
      assert.equal(journalInsideTransaction, true, 'the decision journal write runs in that transaction');
      assert.equal(committedDecision?.kind, 'keychain');
      assert.equal(committedDecision?.fencedGeneration, 1);
      assert.equal(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).intent, 'rollback');
    } finally {
      h.cleanup();
    }
  });

  it('T-S2b fence lands above a C3 Keychain generation', async () => {
    let decision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2') {
          decision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
          throw new Error('fixture crash after S2');
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const service = qlbKeychainService('xai', expectedId('xai'));
      const raw = h.kc.getSync(service, expectedLabel('xai'));
      h.kc.setSync(service, expectedLabel('xai'), JSON.stringify({ ...JSON.parse(raw), generation: 1 }));

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(decision?.generation, 1);
      assert.equal(decision?.fencedGeneration, 2);
      assert.equal(h.store.getGrantGeneration(expectedId('xai')), 2);
    } finally {
      h.cleanup();
    }
  });

  it('T-S2h backup-only rollback fences at g0+1', async () => {
    let decision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2') {
          decision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
          throw new Error('fixture crash after S2');
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      const service = qlbKeychainService('xai', expectedId('xai'));
      const raw = h.kc.getSync(service, expectedLabel('xai'));
      h.kc.setSync(service, expectedLabel('xai'), JSON.stringify({ ...JSON.parse(raw), writtenBy: 'native-resync' }));

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(decision?.kind, 'exact-backup');
      assert.equal(decision?.sourceDigest, canonicalDigest(readPiAuthBackup(h.authPath, 'xai')), 'a backup kind digests the normalised backup');
      assert.equal(decision?.fencedGeneration, 1);
      assert.equal(h.store.getGrantGeneration(expectedId('xai')), 1);
    } finally {
      h.cleanup();
    }
  });

  it('T-I1 a refresh that commits before S2 is ranked first', async () => {
    let decision: RollbackDecision | undefined;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S1') {
          const id = expectedId('xai');
          const service = qlbKeychainService('xai', id);
          const raw = h.kc.getSync(service, expectedLabel('xai'));
          h.kc.setSync(service, expectedLabel('xai'), JSON.stringify({
            ...JSON.parse(raw), generation: 1, refresh: 'xai-refresh-refreshed-fake',
          }));
          assert.equal(h.store.casGrantGeneration(id, 0, 1), 1, 'fake refresher commits before S2 reads');
        }
        if (point === 'S2') {
          decision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
          throw new Error('fixture crash after S2');
        }
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();

      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      assert.equal(decision?.kind, 'keychain');
      assert.equal(decision?.generation, 1);
      assert.equal(decision?.fencedGeneration, 2);
    } finally {
      h.cleanup();
    }
  });

  it('T-RR resume with a recorded decision never re-ranks', async () => {
    let reads = 0;
    const h = setup('xai', new MockKeychain(), {
      afterStep: (point) => {
        if (point === 'S2-reads') reads += 1;
        if (point === 'S2') throw new Error('fixture crash after S2');
      },
    });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      assert.throws(() => h.mig.rollback(), /fixture crash after S2/);
      const decision = JSON.parse(h.store.getMigration('pi-xai')!.detail_json).rollbackDecision as RollbackDecision;
      const service = qlbKeychainService('xai', expectedId('xai'));
      const raw = h.kc.getSync(service, expectedLabel('xai'));
      h.kc.setSync(service, expectedLabel('xai'), JSON.stringify({ ...JSON.parse(raw), generation: 99 }));

      const resumed = h.mig.resume();
      assert.equal(reads, 1, 'resume uses the durable decision instead of taking S2 reads');
      assert.deepEqual((resumed.detail.lastRollback as { decision: RollbackDecision }).decision, decision);
    } finally {
      h.cleanup();
    }
  });

  it('the owner claim is unlinked durably before S5 records the hand-back', async () => {
    const synced: string[] = [];
    const h = setup('xai', new MockKeychain(), { fsyncDirectory: (path) => { synced.push(path); } });
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      let syncedBeforeMarker = false;
      const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
      h.store.upsertMigration = (store, state, detail) => {
        if (JSON.parse(detail ?? '{}').handback) syncedBeforeMarker ||= synced.includes(dirname(h.ownerPath));
        return originalUpsertMigration(store, state, detail);
      };

      h.mig.rollback();
      assert.equal(syncedBeforeMarker, true, 'the owner directory is fsynced before the S5 write');
    } finally {
      h.cleanup();
    }
  });

  it('a bad journal account refuses the hand-back with the owner claim intact', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const row = h.store.getMigration('pi-xai')!;
      const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
      h.store.upsertMigration('pi-xai', row.state, JSON.stringify({ ...detail, accounts: [] }));

      assert.throws(() => h.mig.rollback(), /no valid journal account coordinates/);
      assert.equal(existsSync(h.ownerPath), true, 'the claim is not dropped before validation');
    } finally {
      h.cleanup();
    }
  });

  it('T-S5s status reports cleanup-pending, shows a null fence as not fenced, and writes nothing', () => {
    const h = setup('xai');
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'keep',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const service = qlbKeychainService('xai', expectedId('xai'));
      const account = expectedLabel('xai');
      h.kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));
      const rowBefore = h.store.getMigration('pi-xai');
      const filesBefore = fileSnapshot(h.dir);
      const keychainBefore = h.kc.getSync(service, account);

      const status = h.mig.status();

      assert.equal(status.resumeAction, 'hand-back complete, cleanup pending — run `qlb migrate resume`');
      assert.deepEqual(status.detail.handback, marker, 'status keeps the durable marker fields intact');
      assert.deepEqual(status.handback, { ...marker, fencedGeneration: 'not fenced' });
      assert.deepEqual(h.store.getMigration('pi-xai'), rowBefore, 'status does not write the journal');
      assert.deepEqual(fileSnapshot(h.dir), filesBefore, 'status does not write files');
      assert.equal(h.kc.getSync(service, account), keychainBefore, 'status does not write Keychain');
    } finally {
      h.cleanup();
    }
  });

  it('T-S7 resume with a cleanup-pending marker clears it into lastRollback, and a second resume is a no-op', () => {
    const h = setup('xai');
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'keep',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const service = qlbKeychainService('xai', expectedId('xai'));
      const account = expectedLabel('xai');
      h.kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        handback: marker,
        intent: 'rollback',
        rollbackDecision: ROLLBACK_DECISION,
      }));

      const resumed = h.mig.resume();
      const detail = resumed.detail;
      assert.equal(resumed.state, 'NATIVE');
      assert.equal(detail.handback, undefined, 'S7 clears the cleanup-pending marker');
      assert.equal(detail.intent, undefined, 'S7 clears leftover rollback intent');
      assert.equal(detail.rollbackDecision, undefined, 'S7 clears leftover rollback decision');
      assert.deepEqual(
        detail.lastRollback,
        { ...marker, rolledBackFrom: 'post-commit', cleanedAt: (detail.lastRollback as { cleanedAt: unknown }).cleanedAt },
        'S7 preserves the complete marker as the rollback record',
      );
      assert.equal(typeof (detail.lastRollback as { cleanedAt: unknown }).cleanedAt, 'number');
      const journalAfterFirstResume = h.store.getMigration('pi-xai');
      const keychainAfterFirstResume = h.kc.getSync(service, account);

      const repeated = h.mig.resume();
      assert.deepEqual(repeated.detail, detail, 'a terminal second resume is a no-op');
      assert.deepEqual(h.store.getMigration('pi-xai'), journalAfterFirstResume, 'the second resume does not rewrite the journal');
      assert.equal(h.kc.getSync(service, account), keychainAfterFirstResume, 'the second resume keeps K_m');
    } finally {
      h.cleanup();
    }
  });

  it('T-S6a backups are removed only under the cleanup-pending marker', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const h = setup('xai');
    try {
      const exact = piAuthBackupPath(h.authPath, 'xai');
      const legacy = `${h.authPath}.qlb-xai.baseline.json`;
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      writeFileSync(legacy, JSON.stringify({ filePresent: true, entryPresent: true, entry: FAKE_GRANTS.xai }) + '\n');

      h.mig.resume();
      assert.equal(existsSync(exact), true, 'an at-rest resume does not remove the exact backup');
      assert.equal(existsSync(legacy), true, 'an at-rest resume does not remove the legacy backup');

      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));
      h.mig.resume();
      assert.equal(existsSync(exact), false, 'S6a removes the exact backup under the marker');
      assert.equal(existsSync(legacy), false, 'S6a removes the legacy backup under the marker');

      mkdirSync(exact, { recursive: true });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));
      assert.throws(() => h.mig.resume(), /EISDIR|directory/i, 'an S6a failure surfaces before S7');
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback,
        marker,
        'a failed S6a keeps the marker for retry',
      );

      rmSync(exact, { recursive: true, force: true });
      const settled = h.mig.resume();
      assert.equal(settled.detail.handback, undefined, 'the next resume retries S6a then clears S7');
    } finally {
      h.cleanup();
    }
  });

  it('a recorded delete removes the Keychain copy and a recorded keep, or any other value, leaves it untouched', () => {
    for (const fixture of [
      { disposition: 'delete', itemPresent: true, shouldRemain: false },
      { disposition: 'delete', itemPresent: false, shouldRemain: false },
      { disposition: 'keep', itemPresent: true, shouldRemain: true },
      { disposition: 'unknown', itemPresent: true, shouldRemain: true },
    ]) {
      const h = setup('xai');
      try {
        const marker = {
          phase: 'cleanup-pending',
          keychainDisposition: fixture.disposition,
          piFingerprint: null,
          decision: null,
          fencedGeneration: null,
          rolledBackAt: 123,
        };
        const service = qlbKeychainService('xai', expectedId('xai'));
        const account = expectedLabel('xai');
        if (fixture.itemPresent) {
          h.kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
        }
        h.store.upsertAccount(expectedId('xai'), 'xai', expectedLabel('xai'), 'active');
        h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
          accounts: [{
            id: expectedId('xai'),
            provider: 'xai',
            label: expectedLabel('xai'),
            fingerprint: 'fixture-fingerprint',
          }],
          handback: marker,
        }));

        const resumed = h.mig.resume();

        assert.equal(
          keychainHas(h.kc, 'xai'),
          fixture.shouldRemain,
          `${fixture.disposition} applies only the recorded disposition to J.accounts[0]`,
        );
        assert.equal(resumed.detail.handback, undefined, `${fixture.disposition} completes S7`);
        assert.equal(
          h.store.getAccount(expectedId('xai'))?.status,
          fixture.disposition === 'delete' ? 'handed-back' : 'active',
          `${fixture.disposition} writes account status only for the recorded delete verdict`,
        );
      } finally {
        h.cleanup();
      }
    }
  });

  it('crash between the Keychain delete and the status write resumes to the same disposition', () => {
    const h = setup('xai');
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'delete',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const id = expectedId('xai');
      const service = qlbKeychainService('xai', id);
      const account = expectedLabel('xai');
      h.kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      h.store.upsertAccount(id, 'xai', account, 'active');
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        accounts: [{ id, provider: 'xai', label: account, fingerprint: 'fixture-fingerprint' }],
        handback: marker,
      }));
      const crashing = createSingleGrantMigration(
        h.store,
        h.kc,
        'xai',
        h.authPath,
        h.ownerPath,
        'xai',
        { afterStep: (point) => { if (point === 'S6c1') throw new Error('fixture crash after S6c1'); } },
      );

      assert.throws(() => crashing.resume(), /fixture crash after S6c1/);
      assert.equal(keychainHas(h.kc, 'xai'), false, 'S6c1 deleted K_m before the crash');
      assert.equal(h.store.getAccount(id)?.status, 'active', 'S6c2 has not written the status');
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback,
        marker,
        'the marker remains set for retry',
      );

      const resumed = h.mig.resume();
      assert.equal(h.store.getAccount(id)?.status, 'handed-back', 'S6c2 writes on the recorded delete verdict');
      assert.equal(resumed.detail.handback, undefined, 'S7 clears the marker after S6c2');
      assert.equal(
        (resumed.detail.lastRollback as { keychainDisposition: unknown }).keychainDisposition,
        'delete',
        'the recorded disposition is retained through recovery',
      );
    } finally {
      h.cleanup();
    }
  });

  it('a Keychain delete error during S6c1 leaves the cleanup-pending marker', () => {
    const kc = new RollbackDeleteKeychain();
    const h = setup('xai', kc);
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'delete',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const service = qlbKeychainService('xai', expectedId('xai'));
      const account = expectedLabel('xai');
      kc.setSync(service, account, JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        accounts: [{
          id: expectedId('xai'),
          provider: 'xai',
          label: expectedLabel('xai'),
          fingerprint: 'fixture-fingerprint',
        }],
        handback: marker,
      }));
      kc.mode = 'denied';

      assert.throws(() => h.mig.resume(), /fixture Keychain access denied/);
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback,
        marker,
        'S6c1 errors before S7 clears the marker',
      );
      assert.equal(keychainHas(kc, 'xai'), true, 'failed delete retains the Keychain item');
    } finally {
      h.cleanup();
    }
  });

  it('S6c1 refuses a journal account from another provider and leaves the marker and both Keychain items', () => {
    const kc = new MockKeychain();
    const h = setup('xai', kc);
    try {
      const marker = {
        phase: 'cleanup-pending',
        keychainDisposition: 'delete',
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      const ownService = qlbKeychainService('xai', expectedId('xai'));
      kc.setSync(ownService, expectedLabel('xai'), JSON.stringify({ ...FAKE_GRANTS.xai, generation: 0 }));
      const otherService = qlbKeychainService('kimi-coding', expectedId('kimi-coding'));
      kc.setSync(otherService, expectedLabel('kimi-coding'), JSON.stringify({ ...FAKE_GRANTS['kimi-coding'], generation: 0 }));
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        accounts: [{
          id: expectedId('kimi-coding'),
          provider: 'kimi-coding',
          label: expectedLabel('kimi-coding'),
          fingerprint: 'fixture-fingerprint',
        }],
        handback: marker,
      }));

      assert.throws(() => h.mig.resume(), /journal names kimi-coding, not xai/);
      assert.deepEqual(JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback, marker);
      assert.equal(keychainHas(kc, 'xai'), true, 'own item untouched');
      assert.equal(keychainHas(kc, 'kimi-coding'), true, 'other provider item untouched');
    } finally {
      h.cleanup();
    }
  });

  it('T-S6a backup removal is made durable before the marker is cleared', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const calls: string[] = [];
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: (path) => {
        calls.push(path);
        assert.equal(existsSync(piAuthBackupPath(h.authPath, 'xai')), false, 'S6a removes the exact backup before its directory sync');
        assert.equal(existsSync(legacyPiAuthBackupPath(h.authPath, 'xai')), false, 'S6a removes the legacy backup before its directory sync');
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.deepEqual(detail.handback, marker, 'S6a directory sync runs before S7 clears the durable marker');
      },
    });
    try {
      const exact = piAuthBackupPath(h.authPath, 'xai');
      const legacy = legacyPiAuthBackupPath(h.authPath, 'xai');
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      writeFileSync(legacy, JSON.stringify({ filePresent: true, entryPresent: true, entry: FAKE_GRANTS.xai }) + '\n');
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      const settled = h.mig.resume();

      assert.deepEqual(
        calls,
        [dirname(exact), dirname(legacy), dirname(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'))],
        'S6a syncs both backup parents before S6b re-syncs the staging directory',
      );
      assert.equal(settled.detail.handback, undefined, 'S7 clears the marker after durable S6a cleanup');
    } finally {
      h.cleanup();
    }
  });

  it('T-S6a a failed backup-directory sync leaves the marker for the next resume', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    let failSync = true;
    const retrySyncCalls: string[] = [];
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: (path) => {
        if (failSync && path === dirname(piAuthBackupPath(h.authPath, 'xai'))) {
          throw new Error('injected backup directory sync failure');
        }
        if (!failSync) {
          retrySyncCalls.push(path);
          const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
          assert.deepEqual(detail.handback, marker, 'retry sync runs before S7 clears the durable marker');
        }
      },
    });
    try {
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      assert.throws(() => h.mig.resume(), /injected backup directory sync failure/);
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback,
        marker,
        'a failed S6a directory sync keeps the marker for retry',
      );

      failSync = false;
      const settled = h.mig.resume();
      const exactBackupDirectory = dirname(piAuthBackupPath(h.authPath, 'xai'));
      const legacyBackupDirectory = dirname(legacyPiAuthBackupPath(h.authPath, 'xai'));
      assert.ok(retrySyncCalls.includes(exactBackupDirectory), 'a retry re-syncs the exact backup parent');
      if (existsSync(legacyBackupDirectory)) {
        assert.ok(retrySyncCalls.includes(legacyBackupDirectory), 'a retry syncs the legacy backup parent when it exists');
      }
      assert.equal(settled.detail.handback, undefined, 'a working retry completes S6a before S7');
    } finally {
      h.cleanup();
    }
  });

  it('T-S6a a crash between unlink and sync still syncs on the next resume', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const calls: string[] = [];
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: (path) => {
        calls.push(path);
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.deepEqual(detail.handback, marker, 'backup-parent sync runs before S7 clears the durable marker');
      },
    });
    try {
      const exact = piAuthBackupPath(h.authPath, 'xai');
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      rmSync(exact, { force: true });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      const settled = h.mig.resume();

      assert.ok(calls.includes(dirname(exact)), 'resume syncs the exact backup parent after an unlink-before-sync crash');
      assert.equal(settled.detail.handback, undefined, 'S7 clears the marker after the retry sync');
    } finally {
      h.cleanup();
    }
  });

  it('the staging-directory sync runs after the staging unlink even when the legacy backup parent is the same directory', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const events: string[] = [];
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: (path) => {
        const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
        if (path === dirname(staging)) {
          const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
          assert.deepEqual(detail.handback, marker, 'each directory sync runs before S7 clears the durable marker');
          events.push(existsSync(staging) ? 'sync-before-staging-unlink' : 'sync-after-staging-unlink');
        }
      },
    });
    try {
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      writePiAuthBackup(h.authPath, 'xai', 'fixture');
      writeFileSync(legacyPiAuthBackupPath(h.authPath, 'xai'), JSON.stringify({ filePresent: true }) + '\n');
      writeFileSync(staging, JSON.stringify({ fixture: 'staging' }), { mode: 0o600 });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      const settled = h.mig.resume();

      assert.deepEqual(
        events,
        ['sync-before-staging-unlink', 'sync-after-staging-unlink'],
        'the same staging directory is synced again after S6b unlinks staging',
      );
      assert.equal(settled.detail.handback, undefined, 'S7 clears the marker only after the post-unlink sync');
    } finally {
      h.cleanup();
    }
  });

  it('a non-ENOENT stat error on a sync directory propagates and leaves the marker', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const h = setupOpenRouter();
    const staging = stagingOwnerPath(h.ownerPath, 'openrouter');
    const originalStatSync = fs.statSync;
    const statMock = mock.method(fs, 'statSync', ((path: string | Buffer | URL) => {
      if (path === dirname(staging)) {
        throw Object.assign(new Error('injected sync-directory stat failure'), { code: 'EACCES' });
      }
      return originalStatSync(path);
    }) as typeof fs.statSync);
    try {
      h.store.upsertMigration('pi-openrouter', 'NATIVE', JSON.stringify({ handback: marker }));

      assert.throws(
        () => h.mig.resume(),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES',
        'only ENOENT may be skipped before the S7 marker write',
      );
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-openrouter')!.detail_json).handback,
        marker,
        'a non-ENOENT stat failure leaves the durable marker for retry',
      );
    } finally {
      statMock.mock.restore();
      h.cleanup();
    }
  });

  it('T-S6b staging unlink is made durable before the marker is cleared', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    const calls: string[] = [];
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: (path) => {
        calls.push(path);
        const detail = JSON.parse(h.store.getMigration('pi-xai')!.detail_json) as Record<string, unknown>;
        assert.deepEqual(detail.handback, marker, 'S6b sync runs before S7 clears the durable marker');
      },
    });
    try {
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      writeFileSync(staging, JSON.stringify({ fixture: 'staging' }), { mode: 0o600 });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      const settled = h.mig.resume();

      assert.deepEqual(calls, [dirname(staging), dirname(staging)], 'S6b re-syncs the staging directory after its unlink');
      assert.equal(settled.state, 'NATIVE');
      assert.equal(existsSync(staging), false, 'S6b removes the staging file under the marker');
      assert.equal(existsSync(h.ownerPath), false, 'C3 cleanup does not commit the staging file');
      assert.equal(settled.detail.handback, undefined, 'S7 clears the marker after durable hygiene');
    } finally {
      h.cleanup();
    }
  });

  it('T-S6b a failed directory sync leaves the marker for the next resume', () => {
    const marker = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    let failSync = true;
    let syncCalls = 0;
    const h = setup('xai', new MockKeychain(), {
      fsyncDirectory: () => {
        syncCalls += 1;
        if (failSync) throw new Error('injected directory sync failure');
      },
    });
    try {
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      writeFileSync(staging, JSON.stringify({ fixture: 'staging' }), { mode: 0o600 });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: marker }));

      assert.throws(() => h.mig.resume(), /injected directory sync failure/);
      assert.deepEqual(
        JSON.parse(h.store.getMigration('pi-xai')!.detail_json).handback,
        marker,
        'a failed S6b sync leaves the durable marker for retry',
      );

      failSync = false;
      const settled = h.mig.resume();
      assert.equal(syncCalls, 3, 'the next resume retries S6a and then syncs S6b after its unlink');
      assert.equal(settled.detail.handback, undefined, 'the working retry clears S7');
    } finally {
      h.cleanup();
    }
  });

  it('decision-only resume settles: second resume is a no-op and stage works again', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      const row = h.store.getMigration('pi-xai')!;
      h.store.upsertMigration('pi-xai', row.state, JSON.stringify({
        ...JSON.parse(row.detail_json),
        rollbackDecision: ROLLBACK_DECISION,
      }));

      const resumed = h.mig.resume();
      assert.equal(resumed.detail.rollbackDecision, undefined, 'terminal rollback clears the decision');
      const rolledBackAt = resumed.detail.rolledBackAt;
      const journalAfterFirstResume = h.store.getMigration('pi-xai');

      const repeated = h.mig.resume();
      assert.equal(repeated.detail.rolledBackAt, rolledBackAt, 'second resume does not rewrite rolledBackAt');
      assert.deepEqual(h.store.getMigration('pi-xai'), journalAfterFirstResume, 'second resume does not rewrite the journal');
      assert.doesNotThrow(() => h.mig.stage(), 'stage is no longer refused by the settled journal');
    } finally {
      h.cleanup();
    }
  });

  it('T-E2 rollback with a marker set routes exactly as resume', async () => {
    const handback = {
      phase: 'cleanup-pending' as const,
      keychainDisposition: 'keep' as const,
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };

    // C3 takes precedence over C4, clears the cleanup marker, and makes the
    // terminal rollback repeat-safe just as resume does.
    {
      const h = setup('xai');
      try {
        h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
          handback,
          intent: 'rollback',
          rollbackDecision: ROLLBACK_DECISION,
        }));

        assert.doesNotThrow(() => h.mig.rollback(), 'cleanup-pending rollback must not demand resume');
        const afterFirst = h.store.getMigration('pi-xai');
        assert.equal(JSON.parse(afterFirst!.detail_json).handback, undefined, 'C3 clears the hand-back marker');
        assert.equal(JSON.parse(afterFirst!.detail_json).rollbackDecision, undefined, 'C3 clears the recorded decision');
        assert.ok(JSON.parse(afterFirst!.detail_json).lastRollback, 'C3 records the completed hand-back');

        assert.doesNotThrow(() => h.mig.rollback(), 'a second terminal rollback is a no-op, never a resume refusal');
        assert.deepEqual(h.store.getMigration('pi-xai'), afterFirst, 'a second rollback does not rewrite the terminal journal');
      } finally {
        h.cleanup();
      }
    }

    // A crash inside continueRollback can leave intent without a decision.
    // C4 must settle it directly rather than refusing with the resume hint.
    {
      const h = setup('xai');
      try {
        h.mig.stage();
        const staged = h.store.getMigration('pi-xai')!;
        h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({
          ...JSON.parse(staged.detail_json),
          intent: 'rollback',
        }));

        assert.doesNotThrow(() => h.mig.rollback(), 'intent-only C4 rollback must not demand resume');
        const afterFirst = h.store.getMigration('pi-xai');
        assert.equal(afterFirst?.state, 'NATIVE', 'intent-only C4 ends through S5/S7 at the OD-7 terminal state');
        assert.equal(JSON.parse(afterFirst!.detail_json).intent, undefined, 'intent-only C4 clears intent');

        assert.doesNotThrow(() => h.mig.rollback(), 'a settled intent-only C4 fixture is never refused with the resume hint');
        assert.deepEqual(h.store.getMigration('pi-xai'), afterFirst, 'a second intent-only C4 rollback is a no-op');
      } finally {
        h.cleanup();
      }
    }

    // C4 must continue the existing rollback directly, without re-journaling
    // intent through postCommitRollback. Use the complete eight-field decision
    // shape required for a committed QLB_OWNED fixture.
    {
      const h = setup('xai');
      try {
        h.mig.stage();
        await h.mig.rehearse(mockRehearse([]));
        h.mig.commit();
        const row = h.store.getMigration('pi-xai')!;
        h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({
          ...JSON.parse(row.detail_json),
          rollbackDecision: ROLLBACK_DECISION,
        }));

        const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
        const writes: Array<{ state: string; detail: Record<string, unknown> }> = [];
        h.store.upsertMigration = (store, state, detail) => {
          if (store === 'pi-xai') writes.push({ state, detail: JSON.parse(detail ?? '{}') as Record<string, unknown> });
          return originalUpsertMigration(store, state, detail);
        };

        assert.doesNotThrow(() => h.mig.rollback(), 'rollback-decision must not demand resume');
        assert.equal(writes.some((write) => write.state === 'QLB_OWNED' && write.detail.intent === 'rollback'), false,
          'C4 continues directly instead of re-journaling intent');
        const afterFirst = h.store.getMigration('pi-xai');
        assert.equal(afterFirst?.state, 'NATIVE', 'C4 finishes through S5/S7 at the OD-7 terminal state');
        assert.equal(JSON.parse(afterFirst!.detail_json).rollbackDecision, undefined, 'terminal path clears the recorded decision');

        assert.doesNotThrow(() => h.mig.rollback(), 'a second C4-completed rollback is a no-op, never a resume refusal');
        assert.deepEqual(h.store.getMigration('pi-xai'), afterFirst, 'a second C4-completed rollback does not rewrite the journal');
      } finally {
        h.cleanup();
      }
    }

    // C3 and C4 use the same terminal journal path regardless of whether the
    // caller chose resume or rollback. Timestamps are deliberately ignored.
    const stripTimestamps = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripTimestamps);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !['rolledBackAt', 'cleanedAt', 'decidedAt', 'sourceDigest', 'nativeMtime', 'poolFilePath', 'ownerFilePath', 'stagedAt'].includes(key))
          .map(([key, child]) => [key, stripTimestamps(child)]));
      }
      return value;
    };
    const finish = (fixture: 'C3' | 'C4', command: 'resume' | 'rollback') => {
      const h = setup('xai');
      try {
        if (fixture === 'C3') {
          h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
            handback,
            intent: 'rollback',
            rollbackDecision: ROLLBACK_DECISION,
          }));
        } else {
          h.mig.stage();
          const staged = h.store.getMigration('pi-xai')!;
          h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({
            ...JSON.parse(staged.detail_json),
            intent: 'rollback',
          }));
        }
        h.mig[command]();
        return JSON.parse(h.store.getMigration('pi-xai')!.detail_json);
      } finally {
        h.cleanup();
      }
    };
    for (const fixture of ['C3', 'C4'] as const) {
      assert.deepEqual(
        stripTimestamps(finish(fixture, 'resume')),
        stripTimestamps(finish(fixture, 'rollback')),
        `${fixture} resume and rollback have matching terminal journal detail`,
      );
    }
  });

  it('cleanup-pending with leftover rollback intent and decision settles in one resume', () => {
    const h = setup('xai');
    try {
      const handback = {
        phase: 'cleanup-pending' as const,
        keychainDisposition: 'keep' as const,
        piFingerprint: null,
        decision: null,
        fencedGeneration: null,
        rolledBackAt: 123,
      };
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        handback,
        intent: 'rollback',
        rollbackDecision: ROLLBACK_DECISION,
      }));

      const resumed = h.mig.resume();
      assert.equal(resumed.detail.handback, undefined);
      assert.equal(resumed.detail.intent, undefined);
      assert.equal(resumed.detail.rollbackDecision, undefined);
      assert.ok(resumed.detail.lastRollback);
      const journalAfterFirstResume = h.store.getMigration('pi-xai');

      const repeated = h.mig.resume();
      assert.deepEqual(repeated.detail, resumed.detail, 'second resume is a no-op');
      assert.deepEqual(h.store.getMigration('pi-xai'), journalAfterFirstResume, 'second resume does not rewrite the journal');
    } finally {
      h.cleanup();
    }
  });

  it('resume is never refused with a resume hint', async () => {
    const cleanupPending = {
      phase: 'cleanup-pending',
      keychainDisposition: 'keep',
      piFingerprint: null,
      decision: null,
      fencedGeneration: null,
      rolledBackAt: 123,
    };
    for (const marker of ['intent', 'decision', 'cleanup-pending'] as const) {
      const h = setup('xai');
      try {
        if (marker === 'decision') {
          h.mig.stage();
          await h.mig.rehearse(mockRehearse([]));
          h.mig.commit();
          const row = h.store.getMigration('pi-xai')!;
          h.store.upsertMigration('pi-xai', row.state, JSON.stringify({
            ...JSON.parse(row.detail_json),
            rollbackDecision: ROLLBACK_DECISION,
          }));
        } else if (marker === 'intent') {
          h.mig.stage();
          const staged = h.store.getMigration('pi-xai')!;
          h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
            ...JSON.parse(staged.detail_json),
            intent: 'rollback',
          }));
        } else {
          h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({ handback: cleanupPending }));
        }

        assert.doesNotThrow(() => h.mig.resume(), `${marker} routes through resume instead of refusing with a resume hint`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('rollback before commit: auth.json untouched; staged Keychain entries cleaned up', async () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      assert.equal(keychainHas(h.kc, 'xai'), true);
      assert.equal(h.mig.status().state, 'MIRRORED');

      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'NATIVE');
      assert.equal(rolled.ownerFile, 'absent');
      assert.equal(rolled.nativeStore, 'intact');
      assert.equal(rolled.piAtNextLaunch, 'native works');
      assert.deepEqual(readFileSync(h.authPath), h.originalBytes);
      assert.equal(keychainHas(h.kc, 'xai'), false, 'staging Keychain deleted on rollback');
      const parsed = JSON.parse(readFileSync(h.authPath, 'utf8')) as {
        xai?: { access?: string };
      };
      assert.equal(parsed.xai?.access, FAKE_GRANTS.xai.access);
    } finally {
      h.cleanup();
    }
  });

  it('pre-commit rollback keeps a staged migration retryable when its Keychain delete fails', () => {
    const kc = new RollbackDeleteKeychain();
    const h = setup('xai', kc);
    try {
      h.mig.stage();
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      assert.equal(existsSync(staging), true, 'precondition: staging file exists');
      assert.equal(keychainHas(kc, 'xai'), true, 'precondition: staged Keychain item exists');

      kc.mode = 'denied';
      assert.throws(
        () => h.mig.rollback(),
        /migration rollback failed to delete staged Keychain credential for provider=xai account=Grok \(xAI\)/,
      );
      assert.equal(h.store.getMigration('pi-xai')?.state, 'MIRRORED', 'failed delete keeps journal retryable');
      assert.equal(existsSync(staging), true, 'failed delete keeps staging file');
      assert.equal(keychainHas(kc, 'xai'), true, 'failed delete keeps staged Keychain item');

      kc.mode = 'succeed';
      assert.equal(h.mig.rollback().state, 'NATIVE', 'retry succeeds after Keychain recovers');
      assert.equal(keychainHas(kc, 'xai'), false, 'retry removes staged Keychain item');

      h.mig.stage();
      kc.deleteSync(qlbKeychainService('xai', expectedId('xai')), expectedLabel('xai'));
      kc.mode = 'not-found';
      assert.equal(h.mig.rollback().state, 'NATIVE', 'not-found remains idempotent');
      assert.equal(existsSync(staging), false, 'not-found cleanup removes staging file');
    } finally {
      h.cleanup();
    }
  });

  it('T-PRE pre-commit rollback removes a leftover backup', () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      writePiAuthBackup(h.authPath, 'xai', 'crashed-before-owner');
      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'xai')), true, 'fixture backup exists');

      h.mig.rollback();

      assert.equal(existsSync(piAuthBackupPath(h.authPath, 'xai')), false);
    } finally {
      h.cleanup();
    }
  });

  it('T-PRE a conflicting auth key refuses pre-commit rollback before any cleanup', () => {
    const h = setup('xai');
    try {
      h.mig.stage();
      const row = h.store.getMigration('pi-xai');
      const detail = { ...(JSON.parse(row?.detail_json ?? '{}') as Record<string, unknown>), authJsonKey: 'grok' };
      h.store.upsertMigration('pi-xai', row!.state, JSON.stringify(detail));
      const conflicting = createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, h.ownerPath, 'other-alias');

      assert.throws(() => conflicting.rollback(), /auth\.json key mismatch/);

      assert.equal(keychainHas(h.kc, 'xai'), true, 'staged Keychain item kept');
      assert.equal(h.store.getMigration('pi-xai')?.state, row!.state, 'journal state unchanged');
    } finally {
      h.cleanup();
    }
  });

  it('createOwnedCredentialSource returns Keychain access token when QLB_OWNED', async () => {
    const h = setup('openai-codex');
    try {
      h.mig.stage();
      await h.mig.rehearse(mockRehearse([]));
      h.mig.commit();
      assert.equal(h.mig.status().state, 'QLB_OWNED');

      const getCred = createOwnedCredentialSource({ store: h.store, keychain: h.kc });
      const token = await getCred(expectedId('openai-codex'));
      assert.equal(token, FAKE_GRANTS['openai-codex'].access);
    } finally {
      h.cleanup();
    }
  });

  it('createOwnedCredentialSource errors clearly when Codex is not yet migrated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    const kc = new MockKeychain();
    try {
      const getCred = createOwnedCredentialSource({ store, keychain: kc });
      await assert.rejects(
        () => getCred('codex-default'),
        /Codex credential not yet owned by QLB — run migration first/,
      );
    } finally {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no stage can create a bare-id Codex takeover after activation', () => {
    const h = setup('openai-codex');
    try {
      const staged = stageGenericGrant(h.store, h.kc, 'openai-codex', h.authPath, 'openai-codex', h.ownerPath);
      const db = (h.store as unknown as { db: import('node:sqlite').DatabaseSync }).db;
      assert.equal(staged.state, 'MIRRORED');
      assert.equal(db.prepare("SELECT 1 FROM accounts WHERE id = 'fixture-account'").get(), undefined);
      assert.equal(db.prepare("SELECT 1 FROM migrations WHERE store = 'pi-openai-codex' AND detail_json LIKE '%fixture-account%'").get() !== undefined, true);
      assert.equal(db.prepare("SELECT 1 FROM migrations WHERE store = 'pi-openai-codex' AND detail_json LIKE '%\"fixture-account\"%'").get(), undefined);
      assert.doesNotThrow(() => h.kc.getSync(
        qlbKeychainService('openai-codex', 'fixture-user:fixture-account'),
        'fixture-user:fixture-account',
      ));
      assert.throws(() => h.kc.getSync(qlbKeychainService('openai-codex', 'fixture-account'), 'fixture-account'));
    } finally { h.cleanup(); }
  });

  it('stageGenericGrant helper stages xai without modifying the fixture file', () => {
    const h = setup('xai');
    try {
      const before = readFileSync(h.authPath);
      const staged = stageGenericGrant(
        h.store,
        h.kc,
        'xai',
        h.authPath,
        'xai',
        h.ownerPath,
      );
      assert.equal(staged.state, 'MIRRORED');
      assert.ok(readFileSync(stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai'), 'utf8').length > 0);
      assert.deepEqual(readFileSync(h.authPath), before);
      assert.equal(keychainHas(h.kc, 'xai'), true);
    } finally {
      h.cleanup();
    }
  });
});

/**
 * OpenRouter is a static API key (no OAuth Grant). Tests inject a fake key
 * and use MockKeychain — the real `pi-openrouter` service and any real
 * `qlb:openrouter:*` entry are never touched.
 */
const FAKE_OPENROUTER_KEY = 'sk-or-fake-test-key-not-real';
const OPENROUTER_ID = ADAPTER_ACCOUNT_IDS.openrouter;
const OPENROUTER_LABEL = ADAPTER_ACCOUNT_LABELS.openrouter;

function mockOpenRouterRehearse(calls: StagedAccount[]): RehearseFn {
  return async (account) => {
    calls.push(account);
    assert.equal(account.provider, 'openrouter');
    assert.equal(account.id, OPENROUTER_ID);
    assert.equal(account.grant.access, FAKE_OPENROUTER_KEY);
    assert.equal(account.grant.expires, 0);
    return { ok: true };
  };
}

function openrouterKeychainHas(kc: MockKeychain): boolean {
  try {
    const raw = kc.getSync(
      OPENROUTER_GATE_KEYCHAIN_SERVICE,
      QLB_KEYCHAIN_ACCOUNT,
    );
    return parseApiKeyPayload(raw).access === FAKE_OPENROUTER_KEY;
  } catch {
    return false;
  }
}

function runMapWriterChild(root: string, dir: string, provider: 'openrouter' | 'xai'): Promise<void> {
  const script = `
    const path = require('node:path');
    const src = process.argv[1];
    const dir = process.argv[2];
    const provider = process.argv[3];
    const { openStore } = require(path.join(src, 'store.js'));
    const { MockKeychain } = require(path.join(src, 'keychain.js'));
    if (provider === 'openrouter') {
      const { createStaticKeyMigration } = require(path.join(src, 'migration.js'));
      const store = openStore(path.join(dir, 'openrouter.db'));
      const migration = createStaticKeyMigration(store, new MockKeychain(), 'openrouter', path.join(dir, '.pi', 'agent', 'qlb-owner.json'), () => 'test-openrouter-key');
      migration.stage();
      migration.rehearse(async () => ({ ok: true })).then(() => migration.commit()).then(() => store.close());
    } else {
      const { migratePiSingleProvider } = require(path.join(src, 'pi-migrate.js'));
      const agent = path.join(dir, '.pi', 'agent');
      migratePiSingleProvider('xai', {
        authJsonPath: path.join(agent, 'auth.json'),
        ownerPath: path.join(agent, 'qlb-owner.json'),
        journalPath: path.join(dir, '.qlb', 'journal'),
        baselineDir: path.join(dir, '.qlb', 'backups', 'pi-auth'),
      }, { keychain: new MockKeychain() });
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, root, dir, provider], {
      env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: dir, HOME: dir },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer child exited ${code}`)));
  });
}

function setupOpenRouter(): {
  dir: string;
  ownerPath: string;
  store: ReturnType<typeof openStore>;
  kc: MockKeychain;
  mig: ReturnType<typeof createStaticKeyMigration>;
  nativeReads: number;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-openrouter-mig-'));
  const ownerPath = join(dir, 'qlb-owner.json');
  const store = openStore(join(dir, 'qlb.db'));
  const kc = new MockKeychain();
  let nativeReads = 0;
  const mig = createStaticKeyMigration(store, kc, 'openrouter', ownerPath, () => {
    nativeReads += 1;
    return FAKE_OPENROUTER_KEY;
  });
  return {
    dir,
    ownerPath,
    store,
    kc,
    mig,
    get nativeReads() {
      return nativeReads;
    },
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('static-key migration — openrouter (single API key, no OAuth)', () => {
  it('happy path: stage → rehearse → commit; accountId matches adapter; native Keychain retained', async () => {
    const h = setupOpenRouter();
    try {
      const before = h.mig.status();
      assert.equal(before.state, 'NATIVE');
      assert.equal(before.ownerFile, 'absent');
      assert.equal(before.nativeStore, 'intact');
      assert.equal(before.piAtNextLaunch, 'native works');
      assert.equal(before.nativeStrategy, 'keychain-retain');
      assert.equal(before.provider, 'openrouter');
      assert.equal(before.store, 'pi-openrouter');

      const staged = h.mig.stage();
      assert.equal(staged.state, 'MIRRORED');
      assert.equal(staged.ownerFile, 'staging');
      assert.equal(staged.nativeStore, 'intact');
      assert.equal(staged.piAtNextLaunch, 'native works');
      assert.equal(staged.nativeStrategy, 'keychain-retain');
      assert.equal(h.nativeReads, 1, 'stage reads the injected key once');
      assert.equal(openrouterKeychainHas(h.kc), true);
      assert.equal(h.store.getAccount(OPENROUTER_ID)?.id, OPENROUTER_ID);
      assert.equal(h.store.getAccount(OPENROUTER_ID)?.provider, 'openrouter');

      const rawPayload = h.kc.getSync(
        OPENROUTER_GATE_KEYCHAIN_SERVICE,
        QLB_KEYCHAIN_ACCOUNT,
      );
      const payload: ApiKeyPayload = parseApiKeyPayload(rawPayload);
      assert.equal(payload.type, 'api-key');
      assert.equal(payload.access, FAKE_OPENROUTER_KEY);
      assert.equal(
        'refresh' in JSON.parse(rawPayload),
        false,
        'persisted payload must not be an OAuth Grant',
      );

      const ownerStaging = JSON.parse(
        readFileSync(stagingOwnerPath(h.ownerPath, 'openrouter'), 'utf8'),
      ) as {
        nativeStrategy?: string;
        nativeKeychainService?: string;
        qlbAccountIds: string[];
      };
      assert.equal(ownerStaging.nativeStrategy, 'keychain-retain');
      assert.equal(ownerStaging.nativeKeychainService, NATIVE_OPENROUTER_KEYCHAIN_SERVICE);
      assert.deepEqual(ownerStaging.qlbAccountIds, [OPENROUTER_ID]);

      const rehearseCalls: StagedAccount[] = [];
      const rehearsed = await h.mig.rehearse(mockOpenRouterRehearse(rehearseCalls));
      assert.equal(rehearsed.state, 'VALIDATED');
      assert.equal(rehearseCalls.length, 1);
      assert.equal(rehearseCalls[0]?.id, OPENROUTER_ID);
      assert.equal(rehearseCalls[0]?.provider, 'openrouter');
      assert.equal(rehearseCalls[0]?.grant.access, FAKE_OPENROUTER_KEY);

      const committed = h.mig.commit();
      assert.equal(committed.state, 'QLB_OWNED');
      assert.equal(committed.ownerFile, 'present');
      assert.equal(committed.nativeStore, 'intact');
      assert.equal(committed.piAtNextLaunch, 'QLB works');
      assert.equal(committed.nativeStrategy, 'keychain-retain');
      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as {
        providers: Record<string, { mode?: string }>;
      };
      assert.equal(owner.providers.openrouter?.mode, 'qlb');
      assert.equal(existsSync(join(h.dir, 'qlb-owner-openrouter.json')), false);
      assert.equal(openrouterKeychainHas(h.kc), true);
      assert.equal(h.store.getMigration('pi-openrouter')?.state, 'QLB_OWNED');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0e recognizes an OpenRouter crash-commit as dual ownership, finishes it without P7a, and clears commitStarted on re-stage and hand-back', async () => {
    for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
      const h = setupOpenRouter();
      try {
        h.mig.stage();
        await h.mig.rehearse(mockOpenRouterRehearse([]));
        const row = h.store.getMigration('pi-openrouter');
        assert.ok(row, 'stage recorded the OpenRouter migration');
        h.store.upsertMigration('pi-openrouter', 'VALIDATED', JSON.stringify({
          ...JSON.parse(row.detail_json),
          commitStarted: true,
        }));
        writeFileSync(h.ownerPath, JSON.stringify({
          providers: { openrouter: { mode: 'qlb' } },
        }) + '\n');
        h.store.setConfig('pi.openrouter.state', 'migrated');
        const before = h.store.getMigration('pi-openrouter')!;
        const ownerBefore = readFileSync(h.ownerPath);
        const credentialBefore = h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT);

        assert.throws(
          () => h.mig[command](),
          (error: Error & { exitCode?: unknown }) => {
            assert.match(error.message, /dual-ownership: run `qlb pi rollback openrouter` first, then `qlb migrate rollback --provider openrouter`/);
            assert.equal(error.exitCode, 3);
            return true;
          },
        );
        assert.deepEqual(h.store.getMigration('pi-openrouter'), before, `${command} leaves the crash journal unchanged`);
        assert.deepEqual(readFileSync(h.ownerPath), ownerBefore, `${command} leaves O unchanged`);
        assert.equal(h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT), credentialBefore, `${command} leaves the managed key unchanged`);
      } finally {
        h.cleanup();
      }
    }

    for (const command of ['resume', 'commit'] as const) {
      const h = setupOpenRouter();
      try {
        h.mig.stage();
        await h.mig.rehearse(mockOpenRouterRehearse([]));
        const row = h.store.getMigration('pi-openrouter');
        assert.ok(row);
        h.store.upsertMigration('pi-openrouter', 'VALIDATED', JSON.stringify({
          ...JSON.parse(row.detail_json),
          commitStarted: true,
        }));
        writeFileSync(h.ownerPath, JSON.stringify({
          providers: { openrouter: { mode: 'qlb' } },
        }) + '\n');

        const completed = h.mig[command]();
        assert.equal(completed.state, 'QLB_OWNED', `${command} completes C5 without P7a ownership`);
      } finally {
        h.cleanup();
      }
    }

    const h = setupOpenRouter();
    try {
      h.mig.stage();
      const staged = h.store.getMigration('pi-openrouter')!;
      h.store.upsertMigration('pi-openrouter', 'MIRRORED', JSON.stringify({
        ...JSON.parse(staged.detail_json),
        commitStarted: true,
      }));
      h.mig.stage();
      assert.equal(JSON.parse(h.store.getMigration('pi-openrouter')!.detail_json).commitStarted, undefined, 're-stage clears commitStarted');

      await h.mig.rehearse(mockOpenRouterRehearse([]));
      const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
      let journaledBeforeOwner = false;
      h.store.upsertMigration = (store, state, detail) => {
        const recorded = JSON.parse(detail ?? '{}') as { commitStarted?: boolean };
        if (store === 'pi-openrouter' && state === 'VALIDATED' && recorded.commitStarted === true) {
          assert.equal(existsSync(`${join(h.dir, 'auth.json')}.lock`), true, 'commitStarted is journaled while the owner-map lock is held');
          assert.equal(existsSync(h.ownerPath), false, 'commitStarted is journaled before O exists');
          journaledBeforeOwner = true;
        }
        return originalUpsertMigration(store, state, detail);
      };

      h.mig.commit();

      assert.equal(journaledBeforeOwner, true, 'normal OpenRouter commit journals before writing O');
      assert.equal(JSON.parse(h.store.getMigration('pi-openrouter')!.detail_json).commitStarted, true);
      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(rolled.detail.commitStarted, undefined, 'hand-back terminal write clears commitStarted');
    } finally {
      h.cleanup();
    }
  });

  it('T-S0g refuses an unreadable static-key O with commitStarted without changing recovery artifacts', async () => {
    for (const command of ['commit', 'rollback', 'resume'] as const) {
      const h = setupOpenRouter();
      try {
        h.mig.stage();
        await h.mig.rehearse(mockOpenRouterRehearse([]));
        const detail = JSON.parse(h.store.getMigration('pi-openrouter')!.detail_json) as Record<string, unknown>;
        h.store.upsertMigration('pi-openrouter', 'VALIDATED', JSON.stringify({ ...detail, commitStarted: true }));
        const stagingPath = stagingOwnerPath(h.ownerPath, 'openrouter');
        writeFileSync(h.ownerPath, '{not valid JSON\n');

        const journalBefore = h.store.getMigration('pi-openrouter');
        const keychainBefore = h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT);
        const stagingBefore = readFileSync(stagingPath);
        const ownerBefore = readFileSync(h.ownerPath);

        assert.throws(() => h.mig[command](), (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owner-file-orphan: .*qlb-owner\.json could not be read/);
          assert.equal(error.exitCode, 3);
          return true;
        }, `${command} refuses ambiguous O evidence`);
        assert.deepEqual(h.store.getMigration('pi-openrouter'), journalBefore, `${command} preserves the journal`);
        assert.equal(h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT), keychainBefore, `${command} preserves the Keychain payload`);
        assert.deepEqual(readFileSync(stagingPath), stagingBefore, `${command} preserves staging`);
        assert.deepEqual(readFileSync(h.ownerPath), ownerBefore, `${command} preserves O`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S0g refuses a dangling OpenRouter O symlink before stage or commit writes', async () => {
    for (const command of ['stage', 'commit'] as const) {
      const h = setupOpenRouter();
      try {
        if (command === 'commit') {
          h.mig.stage();
          await h.mig.rehearse(mockOpenRouterRehearse([]));
        }
        const target = join(h.dir, `missing-openrouter-o-${command}`);
        symlinkSync(target, h.ownerPath);
        const stagingPath = stagingOwnerPath(h.ownerPath, 'openrouter');
        const journalBefore = h.store.getMigration('pi-openrouter');
        const keychainBefore = command === 'commit'
          ? h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT)
          : null;
        const stagingBefore = existsSync(stagingPath) ? readFileSync(stagingPath) : null;

        assert.throws(() => h.mig[command](), (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owner-file-orphan: .*could not be read/);
          assert.equal(error.exitCode, 3);
          return true;
        }, `${command} refuses the dangling O link`);
        assert.equal(readlinkSync(h.ownerPath), target, `${command} keeps the symlink`);
        assert.equal(existsSync(target), false, `${command} does not create the target`);
        assert.deepEqual(h.store.getMigration('pi-openrouter'), journalBefore, `${command} preserves the journal`);
        if (keychainBefore === null) {
          assert.throws(() => h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT));
        } else {
          assert.equal(h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT), keychainBefore, `${command} preserves the Keychain payload`);
        }
        assert.deepEqual(existsSync(stagingPath) ? readFileSync(stagingPath) : null, stagingBefore, `${command} preserves staging`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('T-S0e resumes or re-enters a static-key commit that crashes after the O write without classifying it as an orphan', async () => {
    for (const recovery of ['resume', 'commit'] as const) {
      const h = setupOpenRouter();
      try {
        h.mig.stage();
        await h.mig.rehearse(mockOpenRouterRehearse([]));
        const originalUpsertMigration = h.store.upsertMigration.bind(h.store);
        let crashed = false;
        h.store.upsertMigration = (store, state, detail) => {
          if (!crashed && store === 'pi-openrouter' && state === 'QLB_OWNED') {
            crashed = true;
            throw new Error('simulated crash after O');
          }
          return originalUpsertMigration(store, state, detail);
        };

        assert.throws(() => h.mig.commit(), /simulated crash after O/);
        assert.equal(crashed, true, 'the simulated crash follows the O write');
        assert.equal(
          JSON.parse(h.store.getMigration('pi-openrouter')!.detail_json).commitStarted,
          true,
          'the static-key commit journals commitStarted before O',
        );
        assert.equal(
          JSON.parse(readFileSync(h.ownerPath, 'utf8')).providers.openrouter.mode,
          'qlb',
          'O was written before the crash',
        );

        h.store.upsertMigration = originalUpsertMigration;
        const completed = h.mig[recovery]();
        assert.equal(completed.state, 'QLB_OWNED', `${recovery} finishes C5 forward`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('openrouter commit refuses into a legacy v1 Anthropic owner document, leaving staging, Keychain and the document byte-identical', async () => {
    const h = setupOpenRouter();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockOpenRouterRehearse([]));
      writeFileSync(h.ownerPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }) + '\n');
      const documentBefore = readFileSync(h.ownerPath);
      const stagingPath = stagingOwnerPath(h.ownerPath, 'openrouter');
      const stagingBefore = readFileSync(stagingPath);
      const managedBefore = h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT);

      assert.throws(() => h.mig.commit(), /owner-file-legacy-v1/);

      assert.deepEqual(readFileSync(h.ownerPath), documentBefore);
      assert.deepEqual(readFileSync(stagingPath), stagingBefore);
      assert.equal(h.kc.getSync(OPENROUTER_GATE_KEYCHAIN_SERVICE, QLB_KEYCHAIN_ACCOUNT), managedBefore);
    } finally {
      h.cleanup();
    }
  });

  it('rolls back OpenRouter credentials at both gate and legacy coordinates', () => {
    const h = setupOpenRouter();
    try {
      const legacyPath = join(h.dir, 'qlb-owner-openrouter.json');
      const legacyService = qlbKeychainService('openrouter', OPENROUTER_ID);
      writeFileSync(legacyPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'openrouter' }] }) + '\n');
      h.kc.setSync(
        OPENROUTER_GATE_KEYCHAIN_SERVICE,
        QLB_KEYCHAIN_ACCOUNT,
        JSON.stringify({ type: 'api-key', access: FAKE_OPENROUTER_KEY }),
      );
      h.kc.setSync(
        legacyService,
        OPENROUTER_LABEL,
        JSON.stringify({ type: 'api-key', access: FAKE_OPENROUTER_KEY }),
      );
      h.store.upsertMigration('pi-openrouter', 'QLB_OWNED', '{}');

      assert.equal(h.mig.status().piAtNextLaunch, 'QLB works', 'status recognizes the legacy credential');
      const rolled = h.mig.rollback();

      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(rolled.ownerFile, 'absent');
      assert.equal(existsSync(legacyPath), false);
      assert.equal(openrouterKeychainHas(h.kc), false, 'gate credential removed');
      assert.throws(() => h.kc.getSync(legacyService, OPENROUTER_LABEL), /not found/i);
    } finally {
      h.cleanup();
    }
  });

  it('fails rollback on a non-not-found OpenRouter Keychain delete error and names its coordinates', async () => {
    const h = setupOpenRouter();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockOpenRouterRehearse([]));
      h.mig.commit();
      const originalDelete = h.kc.deleteSync.bind(h.kc);
      h.kc.deleteSync = (service, account) => {
        if (service === OPENROUTER_GATE_KEYCHAIN_SERVICE && account === QLB_KEYCHAIN_ACCOUNT) {
          throw new Error('fixture Keychain access denied');
        }
        originalDelete(service, account);
      };

      assert.throws(
        () => h.mig.rollback(),
        new RegExp(`service=${OPENROUTER_GATE_KEYCHAIN_SERVICE} account=${QLB_KEYCHAIN_ACCOUNT}`),
      );
      assert.equal(h.mig.status().ownerFile, 'present', 'failed rollback retains QLB ownership for retry');
    } finally {
      h.cleanup();
    }
  });

  it('keeps the gate credential and owner entry when the legacy delete fails, then retries safely', async () => {
    const h = setupOpenRouter();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockOpenRouterRehearse([]));
      h.mig.commit();
      const legacyService = qlbKeychainService('openrouter', OPENROUTER_ID);
      h.kc.setSync(
        legacyService,
        OPENROUTER_LABEL,
        JSON.stringify({ type: 'api-key', access: FAKE_OPENROUTER_KEY }),
      );
      const originalDelete = h.kc.deleteSync.bind(h.kc);
      h.kc.deleteSync = (service, account) => {
        if (service === legacyService && account === OPENROUTER_LABEL) {
          throw new Error('fixture Keychain access denied');
        }
        originalDelete(service, account);
      };

      assert.throws(
        () => h.mig.rollback(),
        new RegExp(`service=${legacyService} account=${OPENROUTER_LABEL}`),
      );
      assert.equal(openrouterKeychainHas(h.kc), true, 'legacy failure leaves the working gate credential readable');
      const ownerBeforeRetry = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as {
        providers: Record<string, { mode?: string }>;
      };
      assert.equal(ownerBeforeRetry.providers.openrouter?.mode, 'qlb', 'legacy failure leaves the owner entry present');

      h.kc.deleteSync = originalDelete;
      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'VALIDATED');
      assert.equal(openrouterKeychainHas(h.kc), false, 'retry removes the gate credential');
      assert.throws(() => h.kc.getSync(legacyService, OPENROUTER_LABEL), /not found/i);
      assert.equal(existsSync(h.ownerPath), false, 'retry removes the final owner entry');
    } finally {
      h.cleanup();
    }
  });

  it("openrouter rollback removes only its entry and keeps xai's", () => {
    const h = setupOpenRouter();
    try {
      writeFileSync(h.ownerPath, JSON.stringify({ providers: {
        openrouter: { mode: 'qlb', since: 1 },
        xai: { mode: 'qlb', since: 2 },
      } }) + '\n');
      h.store.upsertMigration('pi-openrouter', 'QLB_OWNED', '{}');

      h.mig.rollback();

      const owner = JSON.parse(readFileSync(h.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.equal(owner.providers.openrouter, undefined);
      assert.deepEqual(owner.providers.xai, { mode: 'qlb', since: 2 });
    } finally {
      h.cleanup();
    }
  });

  it('serializes concurrent openrouter and xai map writers so both entries survive', async () => {
    const h = setupOpenRouter();
    try {
      const agentDir = join(h.dir, '.pi', 'agent');
      const ownerPath = join(agentDir, 'qlb-owner.json');
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ xai: FAKE_GRANTS.xai }) + '\n', { mode: 0o600 });
      await Promise.all([
        runMapWriterChild(join(process.cwd(), 'dist-test', 'src'), h.dir, 'openrouter'),
        runMapWriterChild(join(process.cwd(), 'dist-test', 'src'), h.dir, 'xai'),
      ]);

      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { providers: Record<string, { mode?: string }> };
      assert.equal(owner.providers.openrouter?.mode, 'qlb');
      assert.equal(owner.providers.xai?.mode, 'qlb');
    } finally {
      h.cleanup();
    }
  });

  it('stage refuses an orphan legacy sidecar claim for the provider', () => {
    const h = setupOpenRouter();
    try {
      const legacyPath = join(h.dir, 'qlb-owner-openrouter.json');
      writeFileSync(legacyPath, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'openrouter' }] }) + '\n');

      assert.throws(
        () => h.mig.stage(),
        (error: Error & { exitCode?: unknown }) => {
          assert.match(error.message, /owner-file-orphan/);
          assert.equal(error.exitCode, 3);
          return true;
        },
      );
      assert.equal(openrouterKeychainHas(h.kc), false);
    } finally {
      h.cleanup();
    }
  });

  it('rollback before commit: staged Keychain entries cleaned up; native never written', () => {
    const h = setupOpenRouter();
    try {
      h.mig.stage();
      assert.equal(openrouterKeychainHas(h.kc), true);
      assert.equal(h.mig.status().state, 'MIRRORED');

      const rolled = h.mig.rollback();
      assert.equal(rolled.state, 'NATIVE');
      assert.equal(rolled.ownerFile, 'absent');
      assert.equal(rolled.nativeStore, 'intact');
      assert.equal(rolled.piAtNextLaunch, 'native works');
      assert.equal(rolled.nativeStrategy, 'keychain-retain');
      assert.equal(
        openrouterKeychainHas(h.kc),
        false,
        'staging Keychain deleted on rollback',
      );
    } finally {
      h.cleanup();
    }
  });

  it('createOwnedCredentialSource errors clearly when OpenRouter is not yet migrated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-openrouter-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    const kc = new MockKeychain();
    try {
      const getCred = createOwnedCredentialSource({ store, keychain: kc });
      await assert.rejects(
        () => getCred('openrouter-default'),
        /OpenRouter credential not yet owned by QLB — run migration first/,
      );
    } finally {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stage without readNativeKey fails closed (never calls real Keychain)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-openrouter-mig-'));
    const store = openStore(join(dir, 'qlb.db'));
    const kc = new MockKeychain();
    try {
      const mig = createStaticKeyMigration(
        store,
        kc,
        'openrouter',
        join(dir, 'qlb-owner.json'),
        () => {
          throw new Error('injected reader must not be the real security CLI');
        },
      );
      // Replace-path coverage: a reader that throws must not leave Keychain entries.
      assert.throws(() => mig.stage(), /injected reader must not be the real security CLI/);
      assert.equal(openrouterKeychainHas(kc), false);
    } finally {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
