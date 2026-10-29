import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
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
  type RehearseFn,
  type SingleGrantProvider,
  type StagedAccount,
} from '../src/migration';
import { parseGrant } from '../src/refresh-lease';
import type { RollbackDecision } from '../src/single-grant-ownership';
import { piAuthBackupPath, writePiAuthBackup } from '../src/pi-auth-backup';
import { openStore } from '../src/store';

/**
 * Fixture grants — fake tokens only. This file never points at the live
 * Pi agent directory; every auth.json path is a temp copy.
 *
 * Adapter accountId sources (must stay in lockstep):
 *   src/adapters/xai.ts    snapshot.accountId = 'xai-default'
 *   src/adapters/kimi.ts   claimId            = 'kimi-default'
 *   src/adapters/codex.ts  chatgpt_account_id ?? 'codex-default'
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
  { type: 'oauth'; access: string; refresh: string; expires: number }
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
    access: 'codex-access-fake',
    refresh: 'codex-refresh-fake',
    expires: Date.now() + 7 * 24 * 3600 * 1000,
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
  return ADAPTER_ACCOUNT_IDS[provider];
}

function expectedLabel(provider: SingleGrantProvider): string {
  return ADAPTER_ACCOUNT_LABELS[provider];
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

function setup(provider: SingleGrantProvider, kc: MockKeychain = new MockKeychain()): Harness & {
  mig: ReturnType<typeof createSingleGrantMigration>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
  const authPath = join(dir, 'auth.json');
  const ownerPath = join(dir, `qlb-owner-${provider}.json`);
  const original = fixtureAuthJson();
  writeFileSync(authPath, original, { encoding: 'utf8', mode: 0o600 });
  const originalBytes = readFileSync(authPath);
  const store = openStore(join(dir, 'qlb.db'));
  const mig = createSingleGrantMigration(store, kc, provider, authPath, ownerPath);
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
        assert.equal(rolled.state, 'VALIDATED');
        assert.equal(rolled.detail.intent, undefined);
        assert.equal(rolled.detail.rolledBackFrom, 'post-commit');
      } finally {
        h.cleanup();
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
      assert.equal(rolled.detail.rolledBackFrom, 'post-commit');
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

      assert.equal(states.includes('NATIVE'), false, 'rollback never takes the pre-commit path');
      assert.equal(existsSync(customPath), false, 'the post-commit hand-back removes the custom owner file');
      assert.equal(rolled.detail.rolledBackFrom, 'post-commit');
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

  it('T-S6b resume with the marker and staging present unlinks staging and reaches the terminal state without committing', () => {
    const h = setup('xai');
    try {
      const staging = stagingOwnerPath(join(h.dir, 'qlb-owner.json'), 'xai');
      writeFileSync(staging, JSON.stringify({ fixture: 'staging' }), { mode: 0o600 });
      h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        handback: {
          phase: 'cleanup-pending',
          keychainDisposition: 'keep',
          piFingerprint: null,
          decision: null,
          fencedGeneration: null,
          rolledBackAt: 123,
        },
      }));

      const settled = h.mig.resume();

      assert.equal(settled.state, 'NATIVE');
      assert.equal(existsSync(staging), false, 'S6b removes the staging file under the marker');
      assert.equal(existsSync(h.ownerPath), false, 'C3 cleanup does not commit the staging file');
      assert.equal(settled.detail.handback, undefined, 'S7 clears the marker after hygiene');
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
        h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({ intent: 'rollback' }));

        assert.doesNotThrow(() => h.mig.rollback(), 'intent-only C4 rollback must not demand resume');
        const afterFirst = h.store.getMigration('pi-xai');
        assert.equal(afterFirst?.state, 'VALIDATED', 'intent-only C4 reaches the terminal journal');
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
        assert.equal(afterFirst?.state, 'VALIDATED', 'C4 finishes through the same rollback journal path as resume');
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
          .filter(([key]) => key !== 'rolledBackAt' && key !== 'cleanedAt')
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
          h.store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({ intent: 'rollback' }));
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
        } else {
          h.store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify(
            marker === 'intent' ? { intent: 'rollback' } : { handback: cleanupPending },
          ));
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
