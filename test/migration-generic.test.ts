import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

interface Harness {
  dir: string;
  authPath: string;
  ownerPath: string;
  originalBytes: Buffer;
  store: ReturnType<typeof openStore>;
  kc: MockKeychain;
  cleanup: () => void;
}

function setup(provider: SingleGrantProvider): Harness & {
  mig: ReturnType<typeof createSingleGrantMigration>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-generic-mig-'));
  const authPath = join(dir, 'auth.json');
  const ownerPath = join(dir, `qlb-owner-${provider}.json`);
  const original = fixtureAuthJson();
  writeFileSync(authPath, original, { encoding: 'utf8', mode: 0o600 });
  const originalBytes = readFileSync(authPath);
  const store = openStore(join(dir, 'qlb.db'));
  const kc = new MockKeychain();
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
            rollbackDecision: { kind: 'keychain' },
            handback: { phase: 'cleanup-pending' },
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

  it('T-S0b every command refuses an orphan O, L, Oc, or unreadable Oc claim without changing durable state', () => {
    for (const claim of ['O', 'L', 'Oc', 'unreadable-Oc'] as const) {
      for (const command of ['stage', 'commit', 'rollback', 'resume'] as const) {
        const h = setup('xai');
        try {
          const customPath = join(h.dir, 'custom-owner.json');
          const migration = claim === 'O' || claim === 'L'
            ? h.mig
            : createSingleGrantMigration(h.store, h.kc, 'xai', h.authPath, customPath);
          const ownerPath = claim === 'O' ? join(h.dir, 'qlb-owner.json')
            : claim === 'L' ? h.ownerPath
              : customPath;
          const ownerBytes = claim === 'O'
            ? JSON.stringify({ providers: { xai: { mode: 'qlb' } } }) + '\n'
            : JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'xai' }] }) + '\n';
          writeFileSync(ownerPath, ownerBytes);
          if (claim === 'unreadable-Oc') chmodSync(ownerPath, 0o000);

          const service = qlbKeychainService('xai', expectedId('xai'));
          const keychainBytes = JSON.stringify({ preserved: `${claim}-${command}` });
          h.kc.setSync(service, expectedLabel('xai'), keychainBytes);
          const journalBefore = h.store.getMigration('pi-xai');

          assert.throws(
            () => migration[command](),
            (error: Error & { exitCode?: unknown }) => {
              assert.match(error.message, /owner-file-orphan/);
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
          if (claim === 'unreadable-Oc') chmodSync(ownerPath, 0o600);
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
