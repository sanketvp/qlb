// TB-A2 (T-B plan): one fixture recipe for the Pi provider rollback drill.
// TB-A3 reuses these scenarios to run the cutover runbook's `jq` filters on
// the real `status()` objects each rollback branch returns.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beginCutover } from '../../src/lifecycle';
import {
  createSingleGrantMigration,
  createStaticKeyMigration,
  type Migration,
  type MigrationConfig,
  type MigrationStatus,
} from '../../src/migration';
import { piAuthBackupPath } from '../../src/pi-auth-backup';
import { runPiGate } from '../../src/pi-gate';
import { openStore, setStoreForTests, type Store } from '../../src/store';
import { platformKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../../src/keychain';
import { XAI_REFRESH_URL } from '../../src/oauth/xai-refresh';
import { KIMI_CODING_OAUTH_HOST } from '../../src/oauth/kimi-coding-refresh';

export type DrillProvider = 'xai' | 'kimi-coding' | 'openrouter';
export type OAuthProvider = 'xai' | 'kimi-coding';
export const DRILL_PROVIDERS: readonly DrillProvider[] = ['xai', 'kimi-coding', 'openrouter'];

/** The shape of the live Pi Anthropic entry (R1b); every scenario must leave it unchanged. */
export const ANTHROPIC_ENTRY = { mode: 'qlb', since: 1_763_000_000_000 };
export const PLACEHOLDER = { type: 'oauth', access: 'qlb-managed', refresh: '', expires: 4_102_444_800_000 };

const TOKEN_ENDPOINTS: Record<OAuthProvider, string> = {
  xai: XAI_REFRESH_URL,
  'kimi-coding': `${KIMI_CODING_OAUTH_HOST}/api/oauth/token`,
};

export interface DrillFixture {
  agentDir: string;
  authJsonPath: string;
  ownerPath: string;
  dbPath: string;
  store: Store;
  tokenCalls: string[];
  migration(provider: DrillProvider, config?: Omit<MigrationConfig, 'kind' | 'provider' | 'authJsonKey'>): Migration;
  close(): void;
}

export function nativeGrant(provider: OAuthProvider, tag = 'native', expires = Date.now() + 3_600_000) {
  return { type: 'oauth', access: `${provider}-${tag}-access`, refresh: `${provider}-${tag}-refresh`, expires };
}

export function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function anthropicEntryText(fx: DrillFixture): string {
  return JSON.stringify(readJson<{ providers?: Record<string, unknown> }>(fx.ownerPath).providers?.anthropic);
}

export function ownerClaims(fx: DrillFixture): string[] {
  return Object.keys(readJson<{ providers?: Record<string, unknown> }>(fx.ownerPath).providers ?? {}).sort();
}

export function writeAuthEntry(fx: DrillFixture, provider: OAuthProvider, entry: unknown | undefined): void {
  const auth = readJson(fx.authJsonPath);
  if (entry === undefined) delete auth[provider];
  else auth[provider] = entry;
  writeFileSync(fx.authJsonPath, JSON.stringify(auth, null, 2) + '\n');
}

/** Removes every rollback source QLB holds for a single-grant provider: its item and its commit backup. */
export function dropQlbRestoreSources(fx: DrillFixture, provider: OAuthProvider): void {
  try { platformKeychain.deleteSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT); } catch { /* absent */ }
  rmSync(piAuthBackupPath(fx.authJsonPath, provider), { force: true });
}

/** Moves QLB's stored grant to within the gate's 60 s horizon, so the next gate call must refresh. */
export function expireQlbGrant(provider: OAuthProvider): void {
  const service = qlbKeychainService(provider, 'default');
  const stored = JSON.parse(platformKeychain.getSync(service, QLB_KEYCHAIN_ACCOUNT)) as Record<string, unknown>;
  platformKeychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ ...stored, expires: Date.now() + 30_000 }));
}

/**
 * A fresh Pi agent dir with a live-shaped Anthropic claim and native xai/kimi
 * logins, a cutover-phase DB installed as the process-wide store, the
 * QLB_TEST_MODE credential backend cleared, and network stubbed to the two
 * OAuth token endpoints. Call `close()` in `afterEach`.
 */
export function createDrillFixture(): DrillFixture {
  if (process.env.QLB_TEST_MODE !== '1') throw new Error('the drill must run with QLB_TEST_MODE=1');
  const root = mkdtempSync(join(tmpdir(), 'qlb-tb-drill-'));
  const agentDir = join(root, '.pi', 'agent');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const authJsonPath = join(agentDir, 'auth.json');
  const ownerPath = join(agentDir, 'qlb-owner.json');
  writeFileSync(authJsonPath, JSON.stringify({
    anthropic: PLACEHOLDER,
    xai: nativeGrant('xai'),
    'kimi-coding': nativeGrant('kimi-coding'),
  }, null, 2) + '\n');
  writeFileSync(ownerPath, JSON.stringify({ providers: { anthropic: ANTHROPIC_ENTRY } }, null, 2) + '\n');
  const dbPath = join(root, 'qlb.db');
  const store = openStore(dbPath);
  beginCutover(store);
  // The gate's refresh path uses the process-wide store; make it this DB.
  setStoreForTests(store);
  for (const provider of DRILL_PROVIDERS) {
    try { platformKeychain.deleteSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT); } catch { /* absent */ }
  }

  const tokenCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const provider = (Object.keys(TOKEN_ENDPOINTS) as OAuthProvider[]).find((key) => TOKEN_ENDPOINTS[key] === url);
    if (!provider) throw new Error(`drill: unexpected network call to ${url}`);
    tokenCalls.push(provider);
    return new Response(JSON.stringify({
      access_token: `${provider}-qlb-refreshed-access`,
      refresh_token: `${provider}-qlb-refreshed-refresh`,
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  return {
    agentDir, authJsonPath, ownerPath, dbPath, store, tokenCalls,
    migration: (provider, config = {}) => provider === 'openrouter'
      ? createStaticKeyMigration(store, platformKeychain, 'openrouter', ownerPath, () => 'openrouter-native-key')
      : createSingleGrantMigration(store, platformKeychain, provider, authJsonPath, ownerPath, provider, config),
    close: () => {
      globalThis.fetch = realFetch;
      setStoreForTests(null);
      store.close();
    },
  };
}

export async function stageAndRehearse(migration: Migration): Promise<MigrationStatus> {
  migration.stage();
  return migration.rehearse(async () => ({ ok: true }));
}

export async function cutOver(fx: DrillFixture, provider: DrillProvider): Promise<void> {
  const migration = fx.migration(provider);
  await stageAndRehearse(migration);
  if (migration.commit().state !== 'QLB_OWNED') throw new Error(`${provider}: commit did not reach QLB_OWNED`);
}

export async function gate(fx: DrillFixture, provider: DrillProvider): Promise<{ code: number; delivered: Record<string, unknown>[]; stderr: string[] }> {
  const delivered: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const code = await runPiGate(provider, {
    dbPath: fx.dbPath,
    env: { QLB_PI_TOKEN_CALL: '1' },
    deliver: (value) => delivered.push(JSON.parse(value) as Record<string, unknown>),
    stderr: (line) => stderr.push(line),
    guard: () => true,
    piAgentDir: fx.agentDir,
    cswapProcesses: () => [],
  });
  return { code, delivered, stderr };
}

export function refusal(fn: () => unknown): { message: string; exitCode: unknown } {
  try {
    fn();
  } catch (error) {
    return { message: (error as Error).message, exitCode: (error as { exitCode?: unknown }).exitCode };
  }
  throw new Error('expected a refusal');
}

/** The status object exactly as `qlb migrate status --provider <p> --json` prints it. */
export function statusJson(migration: Migration): Record<string, unknown> {
  return JSON.parse(JSON.stringify(migration.status())) as Record<string, unknown>;
}

export interface RollbackScenario {
  name: string;
  provider: DrillProvider;
  /** The runbook branch this end state belongs to. */
  branch: 'post-commit-single-grant' | 'post-commit-openrouter' | 'pre-commit' | 'refusal';
  run(fx: DrillFixture): Promise<Record<string, unknown>>;
}

/** The end states the runbook's rollback checks read, built by the real migration code. */
export const ROLLBACK_SCENARIOS: readonly RollbackScenario[] = [
  ...(['xai', 'kimi-coding'] as const).map((provider): RollbackScenario => ({
    name: `${provider} post-commit rollback`,
    provider,
    branch: 'post-commit-single-grant',
    run: async (fx) => {
      await cutOver(fx, provider);
      const migration = fx.migration(provider);
      migration.rollback();
      return statusJson(migration);
    },
  })),
  {
    name: 'openrouter post-commit rollback',
    provider: 'openrouter',
    branch: 'post-commit-openrouter',
    run: async (fx) => {
      await cutOver(fx, 'openrouter');
      const migration = fx.migration('openrouter');
      migration.rollback();
      return statusJson(migration);
    },
  },
  ...DRILL_PROVIDERS.map((provider): RollbackScenario => ({
    name: `${provider} pre-commit rollback`,
    provider,
    branch: 'pre-commit',
    run: async (fx) => {
      const migration = fx.migration(provider);
      await stageAndRehearse(migration);
      migration.rollback();
      return statusJson(migration);
    },
  })),
  {
    name: 'xai native-entry-missing refusal',
    provider: 'xai',
    branch: 'refusal',
    run: async (fx) => {
      await cutOver(fx, 'xai');
      dropQlbRestoreSources(fx, 'xai');
      writeAuthEntry(fx, 'xai', nativeGrant('xai', 'relogin'));
      const migration = fx.migration('xai', {
        afterStep: (point) => { if (point === 'S2') writeAuthEntry(fx, 'xai', PLACEHOLDER); },
      });
      refusal(() => migration.rollback());
      return statusJson(fx.migration('xai'));
    },
  },
];
