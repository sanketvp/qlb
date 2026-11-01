import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createSwitchAnthropicCommand } from '../src/commands/switch-anthropic';
import { defaultConfig } from '../src/config';
import { claudePaths } from '../src/cc-paths';
import { withClaudeCredentialLocks } from '../src/cc-locks';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { MockKeychain } from '../src/keychain';
import { assertAdmitted, beginCutover, transition } from '../src/lifecycle';
import type { CommandContext } from '../src/registry';
import { openStore, openStoreConnection } from '../src/store';
import { switchClaude, type ClaudeSwitchDeps, type SwitchClaudeInput } from '../src/cc-switch';

const NOW = 1_000_000;
const credential = (tag: string, expiresAt = NOW + 3_600_000) => JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${tag}`, refreshToken: `fixture-refresh-${tag}`, expiresAt } });

type Subject = Awaited<ReturnType<typeof fixture>>;

async function fixture(): Promise<{
  root: string; home: string; env: NodeJS.ProcessEnv; paths: ReturnType<typeof claudePaths>; backend: MockKeychain; slots: ClaudeSlots;
  store: ReturnType<typeof openStore>; repository: SqliteClaudeSlotRepository; deps: ClaudeSwitchDeps; live: string; profileCalls: () => number; posts: () => number;
}> {
  const root = mkdtempSync(join(tmpdir(), 'qlb-republish-'));
  const home = join(root, 'home');
  const env = { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: join(root, 'qlb') };
  const paths = claudePaths({ home, env });
  mkdirSync(paths.configHome, { recursive: true });
  writeFileSync(paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'a' } })}\n`);
  const backend = new MockKeychain();
  const dbPath = join(root, 'qlb.sqlite');
  const store = openStore(dbPath);
  const repository = SqliteClaudeSlotRepository.open(dbPath);
  const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed'), now: () => NOW });
  const live = credential('a-live');
  await slots.createSlot({ accountId: 'a', credential: credential('a-slot'), email: 'a@example.test', orgUuid: 'org-a', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'a' } }), source: 'cswap-import' });
  await slots.createSlot({ accountId: 'b', credential: credential('b'), email: 'b@example.test', orgUuid: 'org-b', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'b' } }), source: 'cswap-import' });
  await slots.createSlot({ accountId: 'c', credential: credential('c'), email: 'c@example.test', orgUuid: 'org-c', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'c' } }), source: 'cswap-import' });
  await backend.set(paths.keychainService, 'fixture-user', live);
  store.setActiveLogin('anthropic', 'a', 'manual', NOW);
  store.setConfig('cooldown.anthropic', 'unchanged');
  for (const key of ['auto.anthropic.lastSwitchFrom', 'auto.anthropic.lastSwitchTo', 'auto.anthropic.leftHeadroom', 'auto.anthropic.leftRecoveryAt', 'auto.anthropic.leftTrigger']) store.setConfig(key, `unchanged-${key}`);
  let profile = 0;
  let post = 0;
  const deps: ClaudeSwitchDeps = {
    store, slots, live: { backend, paths, account: 'fixture-user' },
    readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
    resolveProfile: async () => { profile += 1; return { uuid: 'a', email: 'a@example.test', organizationUuid: 'org-a' }; },
    consume: { postRefresh: async () => { post += 1; return { status: 500, body: '' }; }, withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn() },
    env, home, now: () => NOW, by: 'qlb-cli', attempt: 'republish-attempt', journalOwner: { pid: process.pid, lstart: '' },
  };
  return { root, home, env, paths, backend, slots, store, repository, deps, live, profileCalls: () => profile, posts: () => post };
}

async function close(subject: Subject): Promise<void> { subject.repository.close(); subject.store.close(); }

function backendWithSet(subject: Subject, set: (service: string, account: string, value: string) => Promise<void>): ClaudeSwitchDeps['live']['backend'] {
  const backend = subject.backend;
  return {
    kind: 'test-memory',
    get: (service, account) => backend.get(service, account),
    set,
    delete: (service, account) => backend.delete(service, account),
    setSync: (service, account, value) => backend.setSync(service, account, value),
    getSync: (service, account) => backend.getSync(service, account),
    deleteSync: (service, account) => backend.deleteSync(service, account),
  };
}

const republish = { to: 'a', trigger: 'manual', republish: true } as const;

describe('Claude self-republish (K5b-1)', () => {
  it('republish writes the active generation back and records from == to, detail republish, cooldown and auto.anthropic.* untouched', async () => {
    const subject = await fixture();
    try {
      const result = await switchClaude(subject.deps, republish);
      assert.equal(result.outcome, 'ok');
      assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.live);
      const row = openStoreConnection(join(subject.root, 'qlb.sqlite'), true).prepare("SELECT from_account, to_account, detail FROM switch_log").get() as Record<string, string>;
      assert.deepEqual({ ...row }, { from_account: 'a', to_account: 'a', detail: 'republish' });
      assert.equal(subject.store.getConfig('cooldown.anthropic'), 'unchanged');
      for (const key of ['auto.anthropic.lastSwitchFrom', 'auto.anthropic.lastSwitchTo', 'auto.anthropic.leftHeadroom', 'auto.anthropic.leftRecoveryAt', 'auto.anthropic.leftTrigger']) assert.equal(subject.store.getConfig(key), `unchanged-${key}`);
    } finally { await close(subject); }
  });

  it('X23: a fixture waiter on the credential locks cannot interleave between the republish read and write', async () => {
    const subject = await fixture();
    try {
      let held = false;
      const liveWritesWhileHeld: boolean[] = [];
      const originalSet = subject.backend.set.bind(subject.backend);
      subject.deps.live.backend = backendWithSet(subject, async (service, account, value) => {
        if (service === subject.paths.keychainService) liveWritesWhileHeld.push(held);
        return originalSet(service, account, value);
      });
      subject.deps.locks = { credential: async (options, fn) => withClaudeCredentialLocks(options, async (lock) => { held = true; try { return await fn(lock); } finally { held = false; } }) };
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      assert.deepEqual(liveWritesWhileHeld, [true]);
    } finally { await close(subject); }
  });

  it('X24: republish writes the generation it read at step 4 exactly once', async () => {
    const subject = await fixture();
    try {
      const writes: string[] = [];
      const originalSet = subject.backend.set.bind(subject.backend);
      subject.deps.live.backend = backendWithSet(subject, async (service, account, value) => {
        if (service === subject.paths.keychainService) writes.push(value);
        return originalSet(service, account, value);
      });
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      assert.deepEqual(writes, [subject.live]);
    } finally { await close(subject); }
  });

  it('X24b: a foreign live credential under republish is refused republish-live-not-own with zero live or slot writes', async () => {
    const subject = await fixture();
    try {
      const foreign = credential('c-rotated');
      await subject.backend.set(subject.paths.keychainService, 'fixture-user', foreign);
      subject.deps.resolveProfile = async () => ({ uuid: 'c', email: 'c@example.test', organizationUuid: 'org-c' });
      const before = await subject.slots.readSlot('a', { fresh: true });
      let liveWrites = 0;
      let slotWrites = 0;
      const originalSet = subject.backend.set.bind(subject.backend);
      const originalWriteSlot = subject.slots.writeSlot.bind(subject.slots);
      subject.deps.live.backend = backendWithSet(subject, async (service, account, value) => {
        if (service === subject.paths.keychainService) liveWrites += 1;
        return originalSet(service, account, value);
      });
      subject.slots.writeSlot = async (...args) => {
        slotWrites += 1;
        return originalWriteSlot(...args);
      };
      const result = await switchClaude(subject.deps, republish);
      assert.deepEqual({ outcome: result.outcome, reason: result.reason, exitCode: result.exitCode }, { outcome: 'refused', reason: 'republish-live-not-own', exitCode: 3 });
      assert.equal(liveWrites, 0);
      assert.equal(slotWrites, 0);
      assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), foreign);
      assert.equal((await subject.slots.readSlot('a', { fresh: true })).credential, before.credential);
    } finally { await close(subject); }
  });

  it('X24b: an unresolved live credential under republish is refused, not adopted', async () => {
    const subject = await fixture();
    try {
      const unknown = credential('unknown');
      await subject.backend.set(subject.paths.keychainService, 'fixture-user', unknown);
      subject.deps.resolveProfile = async () => null;
      const before = await subject.slots.readSlot('a', { fresh: true });
      const result = await switchClaude(subject.deps, republish);
      assert.equal(result.reason, 'republish-live-not-own');
      assert.equal((await subject.slots.readSlot('a', { fresh: true })).credential, before.credential);
      assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), unknown);
    } finally { await close(subject); }
  });

  it('republish runs the Phase-A prefetch (profile call spy) and no freshen (0 POSTs)', async () => {
    const subject = await fixture();
    try {
      await subject.slots.writeSlot('a', credential('a-slot', NOW), { cause: 'post' });
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      assert.equal(subject.profileCalls(), 1);
      assert.equal(subject.posts(), 0);
    } finally { await close(subject); }
  });

  it('a generic helper write failure at step 7 under republish ⇒ rolled-back, error keychain-write-failed, steps.failedStep 7, live item byte-identical, exit 1', async () => {
    const subject = await fixture();
    try {
      let failed = false;
      const originalSet = subject.backend.set.bind(subject.backend);
      subject.deps.live.backend = backendWithSet(subject, async (service, account, value) => {
        if (service === subject.paths.keychainService && !failed) { failed = true; throw new Error('helper write failed'); }
        return originalSet(service, account, value);
      });
      const result = await switchClaude(subject.deps, republish);
      assert.deepEqual({ outcome: result.outcome, error: result.error, failedStep: result.steps?.failedStep, exitCode: result.exitCode }, { outcome: 'rolled-back', error: 'keychain-write-failed', failedStep: 7, exitCode: 1 });
      assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.live);
    } finally { await close(subject); }
  });

  it('republish of a non-active slot is refused republish-not-active', async () => {
    const subject = await fixture();
    try {
      const result = await switchClaude(subject.deps, { to: 'b', trigger: 'manual', republish: true });
      assert.deepEqual({ outcome: result.outcome, reason: result.reason, exitCode: result.exitCode }, { outcome: 'refused', reason: 'republish-not-active', exitCode: 3 });
    } finally { await close(subject); }
  });

  it('--republish is accepted only on the manual command path and reaches switchClaude', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-republish-command-'));
    const home = join(root, 'home');
    const stdout: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: () => {}, env: { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: join(root, 'qlb') },
      config: defaultConfig(home), loadConfig: () => defaultConfig(home), home, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    };
    let received: SwitchClaudeInput | undefined;
    const command = createSwitchAnthropicCommand({
      openStore: () => ({ close: () => {} }) as never,
      bootstrap: async (hooks) => { await hooks?.assertAdmitted?.(); },
      assertAdmitted: () => ({ ok: true }),
      makeSwitchDeps: async () => ({ store: {} as never, slots: {} as never, live: {} as never, readConfig: () => ({}), resolveProfile: async () => null, consume: {} as never, env: ctx.env, now: () => NOW, by: 'qlb-cli', attempt: 'command-republish' }),
      switchClaude: async (_deps, input) => { received = input; return { outcome: 'ok', from: 'a', to: 'a', attempt: 'command-republish', exitCode: 0 }; },
    });
    assert.equal(await command.execute!(['a', '--republish'], ctx), 0);
    assert.deepEqual(received, { to: 'a', trigger: 'manual', republish: true });
    assert.deepEqual(stdout, ['switched anthropic: a → a (ok)']);
  });

  it('republish is admitted in cutting-over, cutover and retired (AC43 row)', async () => {
    for (const state of ['cutting-over', 'cutover', 'retired'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'qlb-republish-lifecycle-'));
      const home = join(root, 'home');
      const store = openStore(join(root, 'qlb.sqlite'));
      beginCutover(store, NOW);
      if (state === 'cutover' || state === 'retired') assert.equal(transition(store, 'cutover', NOW).ok, true);
      if (state === 'retired') assert.equal(transition(store, 'retired', NOW).ok, true);
      const ctx: CommandContext = {
        stdout: () => {}, stderr: () => {}, env: { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: join(root, 'qlb') },
        config: defaultConfig(home), loadConfig: () => defaultConfig(home), home, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
      };
      let received: SwitchClaudeInput | undefined;
      const command = createSwitchAnthropicCommand({
        openStore: () => store,
        bootstrap: async (hooks) => { await hooks?.assertAdmitted?.(); },
        makeSwitchDeps: async () => ({ store: {} as never, slots: {} as never, live: {} as never, readConfig: () => ({}), resolveProfile: async () => null, consume: {} as never, env: ctx.env, now: () => NOW, by: 'qlb-cli', attempt: `lifecycle-${state}` }),
        switchClaude: async (_deps, input) => { received = input; return { outcome: 'ok', from: 'a', to: 'a', attempt: `lifecycle-${state}`, exitCode: 0 }; },
      });
      assert.equal(await command.execute!(['a', '--republish'], ctx), 0, state);
      assert.deepEqual(received, { to: 'a', trigger: 'manual', republish: true }, state);
    }
  });

  it('republish never counts: a switch_log query excluding detail=republish sees zero rows after it', async () => {
    const subject = await fixture();
    try {
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      const db = openStoreConnection(join(subject.root, 'qlb.sqlite'), true);
      try { assert.equal((db.prepare("SELECT COUNT(*) AS count FROM switch_log WHERE provider = 'anthropic' AND (detail IS NULL OR detail != 'republish')").get() as { count: number }).count, 0); }
      finally { db.close(); }
    } finally { await close(subject); }
  });
});
