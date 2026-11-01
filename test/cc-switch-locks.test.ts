import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import { claudePaths } from '../src/cc-paths';
import { claudeLockPaths, withClaudeCredentialLocks, TAKEOVER_SUFFIX } from '../src/cc-locks';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import { switchClaude, type ClaudeSwitchDeps } from '../src/cc-switch';
import { MockKeychain } from '../src/keychain';
import { openStore } from '../src/store';

const SLOT_NOW = 1_000_000;
const ACCOUNT = 'fixture-user';

function credential(tag: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${tag}`, refreshToken: `fixture-refresh-${tag}`, expiresAt: Date.now() + 60 * 60_000 } });
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function switchFixture() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-cc-switch-locks-'));
  const home = join(root, 'home');
  const env = { QLB_TEST_MODE: '1', HOME: home };
  const paths = claudePaths({ home, env });
  mkdirSync(paths.configHome, { recursive: true });
  const backend = new MockKeychain();
  const slots = new ClaudeSlots({
    backend,
    repository: new InMemoryClaudeSlotRepository(),
    stashDir: join(root, 'unclaimed'),
    now: () => SLOT_NOW,
  });
  const outgoing = credential('a');
  await slots.createSlot({ accountId: 'account-a', credential: outgoing, email: 'a@example.test', orgUuid: 'org-a', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }), source: 'cswap-import' });
  await slots.createSlot({ accountId: 'account-b', credential: credential('b'), email: 'b@example.test', orgUuid: 'org-b', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-b' } }), source: 'cswap-import' });
  await backend.set(paths.keychainService, ACCOUNT, outgoing);
  writeFileSync(paths.globalConfigPath, JSON.stringify({ oauthAccount: { accountUuid: 'account-a' }, retained: 'yes' }));

  const store = openStore(join(root, 'qlb.db'));
  const db = (store as unknown as { db: { prepare: (sql: string) => { run: () => void } } }).db;
  db.prepare(`INSERT INTO claude_slots (account_id, slot_num, config_json, added_at)
    VALUES ('account-a', 1, '{}', 1), ('account-b', 2, '{}', 1)`).run();
  store.setActiveLogin('anthropic', 'account-a', 'manual', Date.now());

  const deps: ClaudeSwitchDeps = {
    store,
    slots,
    live: { backend, paths, account: ACCOUNT },
    readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
    resolveProfile: async () => null,
    consume: {
      postRefresh: async () => ({ status: 500, body: '' }),
      withConsumeLock: async (fn) => fn(),
      withSwitchLock: async (fn) => fn(),
    },
    env,
    home,
    now: Date.now,
    by: 'qlb-cli',
    attempt: 'lock-fixture-attempt',
    journalDir: join(root, 'journal'),
    journalOwner: { pid: process.pid, lstart: 'fixture' },
  };

  return { root, env, paths, lockPaths: claudeLockPaths({ configDir: paths.configHome, env }), backend, store, deps };
}

function stale(path: string, ageMs: number): void {
  mkdirSync(path, { recursive: true });
  const timestamp = new Date(Date.now() - ageMs);
  utimesSync(path, timestamp, timestamp);
}

function switchLogRows(store: ReturnType<typeof openStore>): Array<{ outcome: string; detail: string | null }> {
  const db = (store as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ outcome: string; detail: string | null }> } } }).db;
  return db.prepare('SELECT outcome, detail FROM switch_log ORDER BY id').all();
}

describe('Claude switch credential lock timing (K5-7 / AC3)', () => {
  it('X4: a credential lock aged 30 s refuses at 9 s ± 1 s with nothing written', async () => {
    const subject = await switchFixture();
    try {
      stale(subject.lockPaths.oauthRefreshLockDir, 30_000);
      const liveBefore = fingerprint(await subject.backend.get(subject.paths.keychainService, ACCOUNT));
      const configBefore = fingerprint(readFileSync(subject.paths.globalConfigPath, 'utf8'));
      const started = performance.now();
      const result = await switchClaude(subject.deps, { to: 'account-b', trigger: 'manual' });
      const elapsed = performance.now() - started;

      assert.deepEqual({ outcome: result.outcome, reason: result.reason, exitCode: result.exitCode }, { outcome: 'refused', reason: 'lock-timeout', exitCode: 3 });
      assert.ok(elapsed >= 8_000 && elapsed <= 10_000, `credential-lock wait was ${elapsed.toFixed(0)}ms, expected 9 s ± 1 s`);
      assert.equal(fingerprint(await subject.backend.get(subject.paths.keychainService, ACCOUNT)), liveBefore);
      assert.equal(fingerprint(readFileSync(subject.paths.globalConfigPath, 'utf8')), configBefore);
      assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), false);
      assert.deepEqual(switchLogRows(subject.store).map(({ outcome, detail }) => ({ outcome, detail })), [{ outcome: 'refused', detail: 'lock-timeout' }]);
    } finally {
      subject.store.close();
      rmSync(subject.root, { recursive: true, force: true });
    }
  });

  it('X5: a credential lock aged 61 s is taken over and the switch commits ok', async () => {
    const subject = await switchFixture();
    try {
      stale(subject.lockPaths.oauthRefreshLockDir, 61_000);
      const result = await switchClaude(subject.deps, { to: 'account-b', trigger: 'manual' });

      assert.equal(result.outcome, 'ok');
      assert.equal(existsSync(`${subject.lockPaths.oauthRefreshLockDir}${TAKEOVER_SUFFIX}`), false);
    } finally {
      subject.store.close();
      rmSync(subject.root, { recursive: true, force: true });
    }
  });

  it('X5b: one switch and one fixture waiter on a stale .oauth_refresh.lock take over exactly once, then both acquire', async () => {
    const subject = await switchFixture();
    const fsPromises = require('node:fs/promises') as { mkdir: (...args: any[]) => Promise<unknown> };
    const originalMkdir = fsPromises.mkdir;
    let takeovers = 0;
    let waiterAcquired = false;
    try {
      stale(subject.lockPaths.oauthRefreshLockDir, 61_000);
      fsPromises.mkdir = async (...args: any[]) => {
        const result = await originalMkdir(...args);
        if (String(args[0]) === `${subject.lockPaths.oauthRefreshLockDir}${TAKEOVER_SUFFIX}`) takeovers += 1;
        return result;
      };
      const [result] = await Promise.all([
        switchClaude(subject.deps, { to: 'account-b', trigger: 'manual' }),
        withClaudeCredentialLocks({ configDir: subject.paths.configHome, env: subject.env }, async () => { waiterAcquired = true; }),
      ]);

      assert.equal(result.outcome, 'ok');
      assert.equal(waiterAcquired, true);
      assert.equal(takeovers, 1);
      assert.equal(existsSync(`${subject.lockPaths.oauthRefreshLockDir}${TAKEOVER_SUFFIX}`), false);
    } finally {
      fsPromises.mkdir = originalMkdir;
      subject.store.close();
      rmSync(subject.root, { recursive: true, force: true });
    }
  });

  it('X5b: a .takeover dir older than 5 s does not block the stale-lock switch', async () => {
    const subject = await switchFixture();
    try {
      stale(subject.lockPaths.oauthRefreshLockDir, 61_000);
      stale(`${subject.lockPaths.oauthRefreshLockDir}${TAKEOVER_SUFFIX}`, 5_001);
      const result = await switchClaude(subject.deps, { to: 'account-b', trigger: 'manual' });

      assert.equal(result.outcome, 'ok');
      assert.equal(existsSync(`${subject.lockPaths.oauthRefreshLockDir}${TAKEOVER_SUFFIX}`), false);
    } finally {
      subject.store.close();
      rmSync(subject.root, { recursive: true, force: true });
    }
  });
});
