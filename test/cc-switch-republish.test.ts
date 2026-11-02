import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

function backendWithHooks(subject: Subject, hooks: {
  get?: (service: string, account: string) => void;
  set?: (service: string, account: string, value: string) => void;
}): ClaudeSwitchDeps['live']['backend'] {
  const backend = subject.backend;
  return {
    kind: 'test-memory',
    get: async (service, account) => { hooks.get?.(service, account); return backend.get(service, account); },
    set: async (service, account, value) => { hooks.set?.(service, account, value); return backend.set(service, account, value); },
    delete: (service, account) => backend.delete(service, account),
    setSync: (service, account, value) => backend.setSync(service, account, value),
    getSync: (service, account) => backend.getSync(service, account),
    deleteSync: (service, account) => backend.deleteSync(service, account),
  };
}

async function stableState(subject: Subject): Promise<object> {
  const db = openStoreConnection(join(subject.root, 'qlb.sqlite'), true);
  try {
    return {
      activeLogin: db.prepare('SELECT * FROM active_login ORDER BY provider').all(),
      slots: db.prepare('SELECT * FROM claude_slots ORDER BY account_id').all(),
      config: db.prepare('SELECT * FROM config ORDER BY key').all(),
      slotCredentials: await Promise.all(['a', 'b', 'c'].map(async (accountId) => [accountId, (await subject.slots.readSlot(accountId, { fresh: true })).credential])),
      live: await subject.backend.get(subject.paths.keychainService, 'fixture-user'),
      configText: readFileSync(subject.paths.globalConfigPath, 'utf8'),
      services: subject.backend.listServices().sort(),
      stash: existsSync(join(subject.root, 'unclaimed')) ? readdirSync(join(subject.root, 'unclaimed')).sort() : [],
      journal: existsSync(join(subject.root, 'journal', 'switch-anthropic.json')),
    };
  } finally { db.close(); }
}

function republishRows(subject: Subject): Array<{ outcome: string; detail: string | null }> {
  const db = openStoreConnection(join(subject.root, 'qlb.sqlite'), true);
  try {
    return (db.prepare('SELECT outcome, detail FROM switch_log ORDER BY id').all() as Array<{ outcome: string; detail: string | null }>)
      .map((row) => ({ outcome: row.outcome, detail: row.detail }));
  } finally { db.close(); }
}

function assertRepublishNeverCounts(subject: Subject): void {
  const db = openStoreConnection(join(subject.root, 'qlb.sqlite'), true);
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM switch_log WHERE provider = 'anthropic' AND (detail IS NULL OR detail NOT LIKE 'republish%')").get() as { count: number };
    assert.equal(row.count, 0);
  } finally { db.close(); }
}

const republish = { to: 'a', trigger: 'manual', republish: true } as const;

describe('Claude self-republish (K5b-1)', () => {
  it('republish writes the active generation back and records from == to, detail republish, cooldown and auto.anthropic.* untouched', async () => {
    const subject = await fixture();
    try {
      const result = await switchClaude(subject.deps, republish);
      assert.equal(result.outcome, 'ok');
      assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.live);
      const row = republishRows(subject)[0]!;
      assert.deepEqual(row, { outcome: 'ok', detail: 'republish' });
      assert.equal(subject.store.getConfig('cooldown.anthropic'), 'unchanged');
      for (const key of ['auto.anthropic.lastSwitchFrom', 'auto.anthropic.lastSwitchTo', 'auto.anthropic.leftHeadroom', 'auto.anthropic.leftRecoveryAt', 'auto.anthropic.leftTrigger']) assert.equal(subject.store.getConfig(key), `unchanged-${key}`);
    } finally { await close(subject); }
  });

  it('X23: a real credential-lock waiter cannot interleave between the step-4 read and step-7 write', async () => {
    const subject = await fixture();
    try {
      let heldBy: number | null = null;
      let holds = 0;
      const events: Array<{ kind: 'get' | 'set'; heldBy: number | null }> = [];
      let waiter: Promise<void> | undefined;
      let waiterEntered = false;
      let waiterSaw: string | undefined;
      subject.deps.live.backend = backendWithHooks(subject, {
        get: (service) => { if (service === subject.paths.keychainService) events.push({ kind: 'get', heldBy }); },
        set: (service) => { if (service === subject.paths.keychainService) events.push({ kind: 'set', heldBy }); },
      });
      subject.deps.locks = {
        credential: async (options, fn) => withClaudeCredentialLocks(options, async (lock) => {
          const hold = ++holds;
          heldBy = hold;
          try { return await fn(lock); } finally { heldBy = null; }
        }),
      };
      subject.deps.hooks = {
        afterStep4: () => {
          waiter = withClaudeCredentialLocks({ configDir: subject.paths.configHome, env: subject.env }, async () => {
            waiterEntered = true;
            waiterSaw = await subject.deps.live.backend!.get(subject.paths.keychainService, 'fixture-user');
          });
        },
      };
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      await waiter;
      const heldEvents = events.filter((event) => event.heldBy !== null);
      assert.equal(holds, 1);
      assert.deepEqual(heldEvents, [{ kind: 'get', heldBy: 1 }, { kind: 'set', heldBy: 1 }]);
      assert.equal(waiterEntered, true);
      assert.equal(waiterSaw, subject.live);
      assert.deepEqual(events.at(-1), { kind: 'get', heldBy: null });
    } finally { await close(subject); }
  });

  it('X24: republish reads exactly one step-4 generation and writes it once even if live bytes move afterwards', async () => {
    const subject = await fixture();
    try {
      const step4Live = credential('a-step4');
      const movedAfterStep4 = credential('a-moved-after-step4');
      let phaseB = false;
      let phaseBReads = 0;
      const writes: string[] = [];
      subject.deps.live.backend = backendWithHooks(subject, {
        get: (service) => { if (phaseB && service === subject.paths.keychainService) phaseBReads += 1; },
        set: (service, _account, value) => { if (service === subject.paths.keychainService) writes.push(value); },
      });
      subject.deps.classifyOutgoing = () => ({ kind: 'own-rotated', foreignSlotId: null });
      subject.deps.locks = {
        credential: async (options, fn) => withClaudeCredentialLocks(options, async (lock) => {
          phaseB = true;
          await subject.backend.set(subject.paths.keychainService, 'fixture-user', step4Live);
          return fn(lock);
        }),
      };
      subject.deps.hooks = {
        afterStep4: async () => { await subject.backend.set(subject.paths.keychainService, 'fixture-user', movedAfterStep4); },
      };
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      assert.equal(phaseBReads, 1);
      assert.deepEqual(writes, [step4Live]);
      assert.equal(writes.includes(subject.live), false);
      assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), step4Live);
    } finally { await close(subject); }
  });

  it('X24b: a foreign live credential under republish is refused with no state write except its refusal row', async () => {
    const subject = await fixture();
    try {
      await subject.backend.set(subject.paths.keychainService, 'fixture-user', credential('c-rotated'));
      subject.deps.resolveProfile = async () => ({ uuid: 'c', email: 'c@example.test', organizationUuid: 'org-c' });
      const before = await stableState(subject);
      const result = await switchClaude(subject.deps, republish);
      assert.deepEqual({ outcome: result.outcome, reason: result.reason, exitCode: result.exitCode }, { outcome: 'refused', reason: 'republish-live-not-own', exitCode: 3 });
      assert.deepEqual(await stableState(subject), before);
      assert.deepEqual(republishRows(subject), [{ outcome: 'refused', detail: 'republish:republish-live-not-own' }]);
    } finally { await close(subject); }
  });

  it('X24b: an unresolved live credential under republish is refused with no state write except its refusal row', async () => {
    const subject = await fixture();
    try {
      await subject.backend.set(subject.paths.keychainService, 'fixture-user', credential('unknown'));
      subject.deps.resolveProfile = async () => null;
      const before = await stableState(subject);
      const result = await switchClaude(subject.deps, republish);
      assert.deepEqual({ outcome: result.outcome, reason: result.reason, exitCode: result.exitCode }, { outcome: 'refused', reason: 'republish-live-not-own', exitCode: 3 });
      assert.deepEqual(await stableState(subject), before);
      assert.deepEqual(republishRows(subject), [{ outcome: 'refused', detail: 'republish:republish-live-not-own' }]);
    } finally { await close(subject); }
  });

  it('republish-not-active is refused with no state write except its refusal row', async () => {
    const subject = await fixture();
    try {
      const before = await stableState(subject);
      const result = await switchClaude(subject.deps, { to: 'b', trigger: 'manual', republish: true });
      assert.deepEqual({ outcome: result.outcome, reason: result.reason, exitCode: result.exitCode }, { outcome: 'refused', reason: 'republish-not-active', exitCode: 3 });
      assert.deepEqual(await stableState(subject), before);
      assert.deepEqual(republishRows(subject), [{ outcome: 'refused', detail: 'republish:republish-not-active' }]);
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

  it('republish succeeds for own-bytes', async () => {
    const subject = await fixture();
    try {
      const own = (await subject.slots.readSlot('a', { fresh: true })).credential;
      await subject.backend.set(subject.paths.keychainService, 'fixture-user', own);
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), own);
    } finally { await close(subject); }
  });

  it('republish succeeds for own-family', async () => {
    const subject = await fixture();
    try {
      const own = JSON.parse((await subject.slots.readSlot('a', { fresh: true })).credential) as { claudeAiOauth: { accessToken: string } };
      own.claudeAiOauth.accessToken = 'fixture-access-a-family';
      const family = JSON.stringify(own);
      await subject.backend.set(subject.paths.keychainService, 'fixture-user', family);
      const result = await switchClaude(subject.deps, republish);
      assert.equal(result.outcome, 'ok');
      assert.equal(result.outgoingKind, 'own-family');
      assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), family);
    } finally { await close(subject); }
  });

  it('a generic helper write failure at step 7 under republish ⇒ rolled-back, marker, error keychain-write-failed, steps.failedStep 7, live item byte-identical, exit 1', async () => {
    const subject = await fixture();
    try {
      let failed = false;
      subject.deps.live.backend = backendWithHooks(subject, {
        set: (service) => {
          if (service === subject.paths.keychainService && !failed) {
            failed = true;
            throw new Error('helper write failed');
          }
        },
      });
      const result = await switchClaude(subject.deps, republish);
      assert.deepEqual({ outcome: result.outcome, error: result.error, failedStep: result.steps?.failedStep, exitCode: result.exitCode }, { outcome: 'rolled-back', error: 'keychain-write-failed', failedStep: 7, exitCode: 1 });
      assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), subject.live);
      assert.deepEqual(republishRows(subject), [{ outcome: 'rolled-back', detail: 'republish:step-7' }]);
      assertRepublishNeverCounts(subject);
    } finally { await close(subject); }
  });

  it('a failed republish row carries a marker and never counts as a switch', async () => {
    const subject = await fixture();
    try {
      const originalReadSlot = subject.slots.readSlot.bind(subject.slots);
      subject.deps.hooks = { afterStep5: () => { subject.slots.readSlot = async (accountId, options) => accountId === 'a' ? Promise.reject(new Error('target unreadable')) : originalReadSlot(accountId, options); } };
      const result = await switchClaude(subject.deps, republish);
      assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'failed', reason: 'target-unreadable' });
      assert.deepEqual(republishRows(subject), [{ outcome: 'failed', detail: 'republish:target-unreadable' }]);
      assertRepublishNeverCounts(subject);
    } finally { await close(subject); }
  });

  it('a refused republish row carries a marker and never counts as a switch', async () => {
    const subject = await fixture();
    try {
      await subject.backend.set(subject.paths.keychainService, 'fixture-user', credential('unknown'));
      subject.deps.resolveProfile = async () => null;
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'refused');
      assert.deepEqual(republishRows(subject), [{ outcome: 'refused', detail: 'republish:republish-live-not-own' }]);
      assertRepublishNeverCounts(subject);
    } finally { await close(subject); }
  });

  it('a successful republish preserves active-login and activation-age metadata', async () => {
    const subject = await fixture();
    try {
      subject.store.setActiveLogin('anthropic', 'a', 'manual', NOW - 10);
      const db = openStoreConnection(join(subject.root, 'qlb.sqlite'));
      try { db.prepare('UPDATE claude_slots SET last_active_at = ? WHERE account_id = ?').run(NOW - 20, 'a'); } finally { db.close(); }
      const before = openStoreConnection(join(subject.root, 'qlb.sqlite'), true);
      const activeBefore = before.prepare("SELECT since, set_by FROM active_login WHERE provider = 'anthropic'").get();
      const ageBefore = before.prepare("SELECT last_active_at FROM claude_slots WHERE account_id = 'a'").get();
      before.close();
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      const after = openStoreConnection(join(subject.root, 'qlb.sqlite'), true);
      try {
        assert.deepEqual(after.prepare("SELECT since, set_by FROM active_login WHERE provider = 'anthropic'").get(), activeBefore);
        assert.deepEqual(after.prepare("SELECT last_active_at FROM claude_slots WHERE account_id = 'a'").get(), ageBefore);
      } finally { after.close(); }
    } finally { await close(subject); }
  });

  it('step 8 republish uses the target slot oauthAccount snapshot as the plan specifies', async () => {
    const subject = await fixture();
    try {
      writeFileSync(subject.paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'a', liveOnly: 'newer' }, retained: true })}\n`);
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      assert.deepEqual(JSON.parse(readFileSync(subject.paths.globalConfigPath, 'utf8')), { oauthAccount: { accountUuid: 'a' }, retained: true });
    } finally { await close(subject); }
  });

  it('Phase C afterSwitch runs after an ok republish and after the credential lock releases', async () => {
    const subject = await fixture();
    try {
      let held = false;
      let afterSwitch = 0;
      subject.deps.locks = { credential: async (options, fn) => withClaudeCredentialLocks(options, async (lock) => { held = true; try { return await fn(lock); } finally { held = false; } }) };
      subject.deps.afterSwitch = async (accountId) => {
        afterSwitch += 1;
        assert.equal(accountId, 'a');
        assert.equal(held, false);
      };
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      assert.equal(afterSwitch, 1);
    } finally { await close(subject); }
  });

  it('--republish is accepted only on the manual command path and rejects other trigger or duplicate flag forms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-republish-command-'));
    const home = join(root, 'home');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), env: { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: join(root, 'qlb') },
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
    assert.equal(await command.execute!(['a', '--trigger', 'proactive', '--republish'], ctx), 2);
    assert.equal(await command.execute!(['a', '--republish', '--republish'], ctx), 2);
    assert.deepEqual(stdout, ['switched anthropic: a → a (ok)']);
    assert.equal(stderr.length, 2);
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

  it('republish never counts: a switch_log query excluding republish-marked rows sees zero rows after it', async () => {
    const subject = await fixture();
    try {
      assert.equal((await switchClaude(subject.deps, republish)).outcome, 'ok');
      assertRepublishNeverCounts(subject);
    } finally { await close(subject); }
  });
});
