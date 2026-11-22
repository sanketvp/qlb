// TB-A1a (T-B plan): characterization drill for the live Pi provider cutovers.
// For xai, kimi-coding and openrouter it runs the generic `qlb migrate`
// stage → rehearse → commit path, then the real `qlb gate` core and provider
// module, in process, against the same DB and the same QLB_TEST_MODE backend.
// The live cutover runbook (TB-A3) relies on every assertion here.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { beginCutover, transition } from '../src/lifecycle';
import { createSingleGrantMigration, createStaticKeyMigration, type Migration } from '../src/migration';
import { runPiGate } from '../src/pi-gate';
import { openStore, setStoreForTests, type Store } from '../src/store';
import { platformKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { XAI_REFRESH_URL } from '../src/oauth/xai-refresh';
import { KIMI_CODING_OAUTH_HOST } from '../src/oauth/kimi-coding-refresh';

type Provider = 'xai' | 'kimi-coding' | 'openrouter';
const PROVIDERS: readonly Provider[] = ['xai', 'kimi-coding', 'openrouter'];

/** The shape of the live Pi Anthropic entry (R1b) that every step must leave byte-identical. */
const ANTHROPIC_ENTRY = { mode: 'qlb', since: 1_763_000_000_000 };

const TOKEN_ENDPOINTS: Record<'xai' | 'kimi-coding', string> = {
  xai: XAI_REFRESH_URL,
  'kimi-coding': `${KIMI_CODING_OAUTH_HOST}/api/oauth/token`,
};

interface Fixture {
  root: string;
  agentDir: string;
  authJsonPath: string;
  ownerPath: string;
  dbPath: string;
  expires: number;
  store: Store;
}

let fixture: Fixture;
let realFetch: typeof fetch;
let tokenCalls: string[];
let previousQlbHome: string | undefined;

function anthropicEntryText(ownerPath: string): string {
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { providers?: Record<string, unknown> };
  return JSON.stringify(owner.providers?.anthropic);
}

function anthropicAuthEntryText(authJsonPath: string): string {
  const auth = JSON.parse(readFileSync(authJsonPath, 'utf8')) as Record<string, unknown>;
  return JSON.stringify(auth.anthropic);
}

function nativeGrant(provider: 'xai' | 'kimi-coding', expires: number) {
  return { type: 'oauth', access: `${provider}-native-access`, refresh: `${provider}-native-refresh`, expires };
}

function migrationFor(provider: Provider): Migration {
  return provider === 'openrouter'
    ? createStaticKeyMigration(fixture.store, platformKeychain, 'openrouter', fixture.ownerPath, () => 'openrouter-native-key')
    : createSingleGrantMigration(fixture.store, platformKeychain, provider, fixture.authJsonPath, fixture.ownerPath);
}

async function cutOver(provider: Provider): Promise<void> {
  const migration = migrationFor(provider);
  const anthropic = anthropicEntryText(fixture.ownerPath);
  const anthropicAuth = anthropicAuthEntryText(fixture.authJsonPath);
  assert.equal(migration.stage().state, 'MIRRORED', `${provider} stage`);
  assert.equal(anthropicEntryText(fixture.ownerPath), anthropic, `${provider} stage left Anthropic intact`);
  assert.equal(anthropicAuthEntryText(fixture.authJsonPath), anthropicAuth, `${provider} stage left Pi Anthropic intact`);
  assert.equal((await migration.rehearse(async () => ({ ok: true }))).state, 'VALIDATED', `${provider} rehearse`);
  assert.equal(anthropicEntryText(fixture.ownerPath), anthropic, `${provider} rehearse left Anthropic intact`);
  assert.equal(anthropicAuthEntryText(fixture.authJsonPath), anthropicAuth, `${provider} rehearse left Pi Anthropic intact`);
  assert.equal(migration.commit().state, 'QLB_OWNED', `${provider} commit`);
  assert.equal(anthropicEntryText(fixture.ownerPath), anthropic, `${provider} commit left Anthropic intact`);
  assert.equal(anthropicAuthEntryText(fixture.authJsonPath), anthropicAuth, `${provider} commit left Pi Anthropic intact`);
}

async function gate(provider: Provider): Promise<{ code: number; delivered: Record<string, unknown>[]; stderr: string[] }> {
  const delivered: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const code = await runPiGate(provider, {
    dbPath: fixture.dbPath,
    env: { QLB_PI_TOKEN_CALL: '1' },
    deliver: (value) => delivered.push(JSON.parse(value) as Record<string, unknown>),
    stderr: (line) => stderr.push(line),
    guard: () => true,
    piAgentDir: fixture.agentDir,
    cswapProcesses: () => [],
  });
  return { code, delivered, stderr };
}

function lastServedAt(provider: Provider): number | undefined {
  const value = fixture.store.getConfig(`pi.${provider}.lastServedAt`);
  return value === null || value === undefined ? undefined : Number(value);
}

beforeEach(() => {
  assert.equal(process.env.QLB_TEST_MODE, '1', 'the drill must run on the QLB_TEST_MODE in-process backend');
  const root = mkdtempSync(join(tmpdir(), 'qlb-tb-a1a-'));
  previousQlbHome = process.env.QLB_HOME;
  process.env.QLB_HOME = root;
  const agentDir = join(root, '.pi', 'agent');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const authJsonPath = join(agentDir, 'auth.json');
  const ownerPath = join(agentDir, 'qlb-owner.json');
  const hour = Date.now() + 3_600_000;
  writeFileSync(authJsonPath, JSON.stringify({
    anthropic: { type: 'oauth', access: 'qlb-managed', refresh: '', expires: hour * 10 },
    xai: nativeGrant('xai', hour),
    'kimi-coding': nativeGrant('kimi-coding', hour),
  }, null, 2) + '\n');
  writeFileSync(ownerPath, JSON.stringify({ providers: { anthropic: ANTHROPIC_ENTRY } }, null, 2) + '\n');
  const dbPath = join(root, 'qlb.db');
  const store = openStore(dbPath);
  beginCutover(store);
  assert.equal(transition(store, 'cutover').ok, true);
  // The gate's refresh path uses the process-wide store; make it this DB.
  setStoreForTests(store);
  fixture = { root, agentDir, authJsonPath, ownerPath, dbPath, expires: hour, store };

  for (const provider of PROVIDERS) {
    try { platformKeychain.deleteSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT); } catch { /* absent */ }
  }

  tokenCalls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const provider = (Object.keys(TOKEN_ENDPOINTS) as Array<'xai' | 'kimi-coding'>).find((key) => TOKEN_ENDPOINTS[key] === url);
    if (!provider) throw new Error(`drill: unexpected network call to ${url}`);
    tokenCalls.push(provider);
    return new Response(JSON.stringify({
      access_token: `${provider}-qlb-refreshed-access`,
      refresh_token: `${provider}-qlb-refreshed-refresh`,
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setStoreForTests(null);
  fixture.store.close();
  if (previousQlbHome === undefined) delete process.env.QLB_HOME;
  else process.env.QLB_HOME = previousQlbHome;
});

describe('TB-A1a: Pi provider cutover drill, migrate → gate', () => {
  it('uses one in-process credential backend for migration and the gate resolvers', async () => {
    await cutOver('openrouter');
    // Written by Migration.stage through platformKeychain, read back by the gate's resolver.
    const result = await gate('openrouter');
    assert.equal(result.code, 0, result.stderr.join('\n'));
    assert.equal(result.delivered[0]?.token, 'openrouter-native-key');
  });

  for (const provider of PROVIDERS) {
    it(`${provider}: cuts over and the gate delivers the provider-specific shape with evidence`, async () => {
      const before = Date.now();
      await cutOver(provider);

      const owner = JSON.parse(readFileSync(fixture.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
      assert.ok(owner.providers[provider], `${provider} claimed in the v2 owner document`);
      if (provider !== 'openrouter') {
        const auth = JSON.parse(readFileSync(fixture.authJsonPath, 'utf8')) as Record<string, { access: string; refresh: string }>;
        assert.equal(auth[provider]?.access, 'qlb-managed', `${provider} auth.json holds the placeholder`);
        assert.equal(auth[provider]?.refresh, '');
      }

      const result = await gate(provider);
      assert.equal(result.code, 0, result.stderr.join('\n'));
      assert.equal(result.delivered.length, 1);
      const delivered = result.delivered[0]!;
      if (provider === 'openrouter') {
        assert.deepEqual(Object.keys(delivered).sort(), ['accountId', 'source', 'token']);
        assert.equal(delivered.token, 'openrouter-native-key');
      } else {
        assert.deepEqual(Object.keys(delivered).sort(), ['accountId', 'expiresAt', 'source', 'token']);
        assert.equal(delivered.token, `${provider}-native-access`);
        assert.equal(delivered.expiresAt, fixture.expires);
      }
      assert.equal(delivered.accountId, 'default');
      assert.equal(delivered.source, 'keychain');
      assert.ok((lastServedAt(provider) ?? 0) >= before, `${provider} lastServedAt advanced`);
      assert.deepEqual(tokenCalls, [], 'a fresh grant is served without a refresh');
      assert.equal(anthropicEntryText(fixture.ownerPath), JSON.stringify(ANTHROPIC_ENTRY));
    });
  }

  for (const provider of ['xai', 'kimi-coding'] as const) {
    it(`${provider}: a near-expiry grant refreshes through the token endpoint and records lineage`, async () => {
      await cutOver(provider);
      const service = qlbKeychainService(provider, 'default');
      const stored = JSON.parse(platformKeychain.getSync(service, QLB_KEYCHAIN_ACCOUNT)) as Record<string, unknown>;
      platformKeychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...stored, expires: Date.now() + 30_000 }));

      const result = await gate(provider);
      assert.equal(result.code, 0, result.stderr.join('\n'));
      assert.deepEqual(tokenCalls, [provider]);
      assert.equal(result.delivered[0]?.token, `${provider}-qlb-refreshed-access`);
      assert.ok((result.delivered[0]?.expiresAt as number) - Date.now() > 60_000);
      assert.equal(fixture.store.listLineageTransitions(provider, 'default').length, 1, `${provider} lineage row`);
      const auth = JSON.parse(readFileSync(fixture.authJsonPath, 'utf8')) as Record<string, { access: string }>;
      assert.equal(auth[provider]?.access, 'qlb-managed', 'refresh never writes Pi auth.json');
      assert.equal(anthropicEntryText(fixture.ownerPath), JSON.stringify(ANTHROPIC_ENTRY));
    });
  }

  it('cuts all three over in sequence without touching the Anthropic entry or each other', async () => {
    for (const provider of PROVIDERS) await cutOver(provider);
    const owner = JSON.parse(readFileSync(fixture.ownerPath, 'utf8')) as { providers: Record<string, unknown> };
    assert.deepEqual(Object.keys(owner.providers).sort(), ['anthropic', 'kimi-coding', 'openrouter', 'xai']);
    assert.equal(JSON.stringify(owner.providers.anthropic), JSON.stringify(ANTHROPIC_ENTRY));
    for (const provider of PROVIDERS) {
      const result = await gate(provider);
      assert.equal(result.code, 0, `${provider}: ${result.stderr.join('\n')}`);
      assert.equal(result.delivered[0]?.token, provider === 'openrouter' ? 'openrouter-native-key' : `${provider}-native-access`);
    }
    assert.deepEqual(tokenCalls, [], 'fresh grants are served without refreshes');
  });
});
