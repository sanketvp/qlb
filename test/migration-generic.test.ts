import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createOwnedCredentialSource } from '../src/credentials';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import {
  ADAPTER_ACCOUNT_IDS,
  ADAPTER_ACCOUNT_LABELS,
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
      assert.ok(readFileSync(stagingOwnerPath(h.ownerPath), 'utf8').length > 0);
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
      qlbKeychainService('openrouter', OPENROUTER_ID),
      OPENROUTER_LABEL,
    );
    return parseApiKeyPayload(raw).access === FAKE_OPENROUTER_KEY;
  } catch {
    return false;
  }
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
  const ownerPath = join(dir, 'qlb-owner-openrouter.json');
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
        qlbKeychainService('openrouter', OPENROUTER_ID),
        OPENROUTER_LABEL,
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
        readFileSync(stagingOwnerPath(h.ownerPath), 'utf8'),
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
        owner: string;
        nativeStrategy?: string;
        qlbAccountIds: string[];
      };
      assert.equal(owner.owner, 'qlb');
      assert.equal(owner.nativeStrategy, 'keychain-retain');
      assert.deepEqual(owner.qlbAccountIds, [OPENROUTER_ID]);
      assert.equal(openrouterKeychainHas(h.kc), true);
      assert.equal(h.store.getMigration('pi-openrouter')?.state, 'QLB_OWNED');
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

  it('createOwnedCredentialSource returns the staged API key when QLB_OWNED', async () => {
    const h = setupOpenRouter();
    try {
      h.mig.stage();
      await h.mig.rehearse(mockOpenRouterRehearse([]));
      h.mig.commit();
      assert.equal(h.mig.status().state, 'QLB_OWNED');

      const getCred = createOwnedCredentialSource({ store: h.store, keychain: h.kc });
      const token = await getCred(OPENROUTER_ID);
      assert.equal(token, FAKE_OPENROUTER_KEY);
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
        join(dir, 'qlb-owner-openrouter.json'),
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
