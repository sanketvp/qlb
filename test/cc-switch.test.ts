import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ClaudeConfigFileError } from '../src/cc-credentials';
import { ClaudeCodeLockTimeout, ProperLockfileCompromised, withClaudeConfigPathLock, withClaudeCredentialLocks, withClaudeSwitchLock } from '../src/cc-locks';
import { withClaudeSwitchJournalOwner } from '../src/cc-switch-journal';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import { MockKeychain } from '../src/keychain';
import { claudePaths } from '../src/cc-paths';
import {
  checkClaudeSwitchPreconditions,
  classifySwitchError,
  CrashSignal,
  prepareClaudeSwitch,
  switchClaude,
  type ClaudeSwitchDeps,
} from '../src/cc-switch';

const NOW = 1_000_000;
const HOME = '/fixture/home';
const ENV = { QLB_TEST_MODE: '1', HOME };

function credential(tag: string, expiresAt = NOW + 60 * 60_000): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${tag}`, refreshToken: `fixture-refresh-${tag}`, expiresAt } });
}

type Fixture = {
  backend: MockKeychain;
  slots: ClaudeSlots;
  deps: ClaudeSwitchDeps;
  setActive: (accountId: string | null) => void;
  setBreaker: (value: string | null) => void;
  config: Record<string, unknown>;
  posts: () => number;
  warnings: string[];
};

async function fixture(): Promise<Fixture> {
  const backend = new MockKeychain();
  const repository = new InMemoryClaudeSlotRepository();
  const slots = new ClaudeSlots({ backend, repository, stashDir: '/fixture/unclaimed', now: () => NOW });
  const paths = claudePaths({ home: HOME, env: ENV });
  const a = credential('a');
  await slots.createSlot({ accountId: 'account-a', credential: a, email: 'a@example.test', orgUuid: 'org-a', source: 'cswap-import' });
  await slots.createSlot({ accountId: 'account-b', credential: credential('b'), email: 'b@example.test', orgUuid: 'org-b', source: 'cswap-import' });
  await slots.createSlot({ accountId: 'account-c', credential: credential('c'), email: 'c@example.test', orgUuid: 'org-c', source: 'cswap-import' });
  await backend.set(paths.keychainService, 'fixture-user', a);

  let active: string | null = 'account-a';
  let breaker: string | null = null;
  let postCount = 0;
  const warnings: string[] = [];
  const config: Record<string, unknown> = { oauthAccount: { accountUuid: 'account-a' } };
  const deps: ClaudeSwitchDeps = {
    store: {
      getActiveLogin: () => active === null ? { provider: 'anthropic', accountId: null, since: NOW, setBy: 'manual' } : { provider: 'anthropic', accountId: active, since: NOW, setBy: 'manual' },
      getConfig: (key: string) => key === 'auto.anthropic.suspendedUntil' ? breaker : null,
    } as unknown as ClaudeSwitchDeps['store'],
    slots,
    live: { backend, paths, account: 'fixture-user' },
    readConfig: () => config,
    resolveProfile: async () => null,
    consume: {
      postRefresh: async () => {
        postCount += 1;
        return { status: 200, body: JSON.stringify({ access_token: 'fixture-issued', refresh_token: 'fixture-refresh-issued', expires_in: 3600 }) };
      },
      withConsumeLock: async (fn) => fn(),
      withSwitchLock: async (fn) => fn(),
      stashTimestamp: () => 'fixture-stash',
    },
    env: ENV,
    home: HOME,
    now: () => NOW,
    by: 'qlb-cli',
    attempt: 'phase-a-only',
    warn: (message) => warnings.push(message),
  };
  return {
    backend, slots, deps, config, warnings,
    setActive: (accountId) => { active = accountId; },
    setBreaker: (value) => { breaker = value; },
    posts: () => postCount,
  };
}

const manual = { to: 'account-b', trigger: 'manual' as const };
const automatic = { to: 'account-b', trigger: 'automatic' as const };

function reason(result: Awaited<ReturnType<typeof checkClaudeSwitchPreconditions>> | Awaited<ReturnType<typeof prepareClaudeSwitch>>): string | undefined {
  return 'reason' in result ? result.reason : undefined;
}

describe('Claude switch Phase A (K5-4)', () => {
  it('X1 returns C-swap reasons before any switch lock or write', async () => {
    const live = await fixture();
    live.deps.cswapProcesses = () => [{ pid: 123 }];
    assert.equal(reason(await checkClaudeSwitchPreconditions(live.deps, manual)), 'cswap-process-alive');
    assert.equal(live.backend.listServices().length, 4);

    const unreadable = await fixture();
    unreadable.deps.cswapProcesses = () => { throw new Error('process table unreadable'); };
    assert.equal(reason(await checkClaudeSwitchPreconditions(unreadable.deps, manual)), 'cswap-process-check-failed');
    assert.equal(unreadable.backend.listServices().length, 4);
  });

  it('X2 refuses a busy freshen and a dead target without a POST', async () => {
    const busy = await fixture();
    busy.deps.consume.postRefresh = async () => { throw new Error('must not post'); };
    busy.deps.consume.withConsumeLock = async () => { throw new Error('busy'); };
    // The near-expiry target enters the consume gate; its non-success result is a refusal.
    await busy.slots.writeSlot('account-b', credential('b', NOW + 10 * 60_000), { cause: 'post' });
    assert.equal(reason(await prepareClaudeSwitch(busy.deps, manual)), 'freshen-busy');
    assert.equal(busy.posts(), 0);

    const dead = await fixture();
    const originalGetSlot = dead.slots.getSlot.bind(dead.slots);
    dead.slots.getSlot = (id) => id === 'account-b' ? { ...originalGetSlot(id)!, dead: true } : originalGetSlot(id);
    assert.equal(reason(await checkClaudeSwitchPreconditions(dead.deps, manual)), 'target-dead');
    assert.equal(dead.posts(), 0);

    const missing = await fixture();
    const missingGetSlot = missing.slots.getSlot.bind(missing.slots);
    missing.slots.getSlot = (id) => id === 'account-b' ? null : missingGetSlot(id);
    assert.equal(reason(await checkClaudeSwitchPreconditions(missing.deps, manual)), 'target-missing');

    const archived = await fixture();
    const archivedGetSlot = archived.slots.getSlot.bind(archived.slots);
    archived.slots.getSlot = (id) => id === 'account-b' ? { ...archivedGetSlot(id)!, archivedAt: NOW } : archivedGetSlot(id);
    assert.equal(reason(await checkClaudeSwitchPreconditions(archived.deps, manual)), 'target-archived');
  });

  it('X3 fails a config read without writing a Keychain item', async () => {
    const subject = await fixture();
    subject.deps.readConfig = () => { throw new ClaudeConfigFileError('/fixture/.claude.json', 'invalid JSON'); };
    assert.equal(reason(await prepareClaudeSwitch(subject.deps, manual)), 'claude:config-file');
    assert.equal(subject.backend.listServices().length, 4);
  });

  it('X3b returns live unreadable and target unreadable without a write', async () => {
    const live = await fixture();
    live.deps.live.backend = {
      kind: 'test-memory',
      get: async () => { throw new Error('read failed'); },
      set: (...args) => live.backend.set(...args),
      delete: (...args) => live.backend.delete(...args),
      setSync: (...args) => live.backend.setSync(...args),
      getSync: (...args) => live.backend.getSync(...args),
      deleteSync: (...args) => live.backend.deleteSync(...args),
    };
    assert.equal(reason(await prepareClaudeSwitch(live.deps, manual)), 'live-credential-unreadable');

    const target = await fixture();
    const originalRead = target.slots.readSlot.bind(target.slots);
    target.slots.readSlot = async (id, options) => id === 'account-b' ? Promise.reject(new Error('read failed')) : originalRead(id, options);
    assert.equal(reason(await prepareClaudeSwitch(target.deps, manual)), 'target-unreadable');
  });

  it('X3c refuses an unset or missing active login before Phase A', async () => {
    const unset = await fixture();
    unset.setActive(null);
    assert.equal(reason(await checkClaudeSwitchPreconditions(unset.deps, manual)), 'active-login-unset');

    const missing = await fixture();
    missing.setActive('missing');
    assert.equal(reason(await checkClaudeSwitchPreconditions(missing.deps, manual)), 'active-login-unset');
  });

  it('X3d blocks automatic triggers on future or malformed breakers but not manual', async () => {
    const future = await fixture();
    future.setBreaker(String(NOW + 1));
    assert.equal(reason(await checkClaudeSwitchPreconditions(future.deps, automatic)), 'breaker-open');
    assert.equal(reason(await checkClaudeSwitchPreconditions(future.deps, manual)), undefined);

    const malformed = await fixture();
    malformed.setBreaker('not-a-time');
    assert.equal(reason(await checkClaudeSwitchPreconditions(malformed.deps, automatic)), 'breaker-open');
  });

  it('freshens a near-expiry target through consume then its brief switch lock, both released', async () => {
    const subject = await fixture();
    const events: string[] = [];
    await subject.slots.writeSlot('account-b', credential('b', NOW + 10 * 60_000), { cause: 'post' });
    subject.deps.consume.withConsumeLock = async (fn) => { events.push('consume:start'); try { return await fn(); } finally { events.push('consume:end'); } };
    subject.deps.consume.withSwitchLock = async (fn) => { events.push('switch:start'); try { return await fn(); } finally { events.push('switch:end'); } };
    const result = await prepareClaudeSwitch(subject.deps, manual);
    assert.equal('active' in result, true);
    assert.equal(subject.posts(), 1);
    assert.deepEqual(events, ['consume:start', 'switch:start', 'switch:end', 'switch:start', 'switch:end', 'switch:start', 'switch:end', 'consume:end']);
  });

  it('does not freshen a target with more than ten minutes remaining', async () => {
    const subject = await fixture();
    await subject.slots.writeSlot('account-b', credential('b', NOW + 10 * 60_000 + 1), { cause: 'post' });
    const result = await prepareClaudeSwitch(subject.deps, manual);
    assert.equal('active' in result, true);
    assert.equal(subject.posts(), 0);
  });

  it('skips Phase-A freshening for republish', async () => {
    const subject = await fixture();
    await subject.slots.writeSlot('account-b', credential('b', NOW + 10 * 60_000), { cause: 'post' });
    const result = await prepareClaudeSwitch(subject.deps, { ...manual, republish: true });
    assert.equal('active' in result, true);
    assert.equal(subject.posts(), 0);
  });

  it('continues after a profile error with unresolved provenance', async () => {
    const subject = await fixture();
    const paths = claudePaths({ home: HOME, env: ENV });
    await subject.backend.set(paths.keychainService, 'fixture-user', credential('diverged'));
    subject.deps.resolveProfile = async () => { throw new Error('profile unavailable'); };
    const result = await prepareClaudeSwitch(subject.deps, manual);
    assert.equal('active' in result, true);
    if ('active' in result) assert.equal(result.prefetch.resolved, null);
  });

  it('omits a broken non-target slot with a warning and uses null for an unreadable outgoing slot', async () => {
    const skipped = await fixture();
    const originalRead = skipped.slots.readSlot.bind(skipped.slots);
    skipped.slots.readSlot = async (id, options) => id === 'account-c' ? Promise.reject(new Error('read failed')) : originalRead(id, options);
    const skippedResult = await prepareClaudeSwitch(skipped.deps, manual);
    assert.equal('active' in skippedResult, true);
    if ('active' in skippedResult) assert.deepEqual(skippedResult.slots.map((slot) => slot.accountId).sort(), ['account-a', 'account-b']);
    assert.equal(skipped.warnings.length, 1);

    const outgoing = await fixture();
    const outgoingRead = outgoing.slots.readSlot.bind(outgoing.slots);
    outgoing.slots.readSlot = async (id, options) => id === 'account-a' ? Promise.reject(new Error('read failed')) : outgoingRead(id, options);
    outgoing.deps.resolveProfile = async () => { throw new Error('profile unavailable'); };
    const outgoingResult = await prepareClaudeSwitch(outgoing.deps, manual);
    assert.equal('active' in outgoingResult, true);
    if ('active' in outgoingResult) {
      assert.equal(outgoingResult.slots.find((slot) => slot.accountId === 'account-a')?.credential, null);
      assert.equal(outgoingResult.prefetch.resolved, null);
    }
  });

  it('preconditions and Phase A do not add a Keychain item', async () => {
    const subject = await fixture();
    const before = subject.backend.listServices().sort();
    assert.equal(reason(await checkClaudeSwitchPreconditions(subject.deps, manual)), undefined);
    assert.equal('active' in await prepareClaudeSwitch(subject.deps, manual), true);
    assert.deepEqual(subject.backend.listServices().sort(), before);
  });
});

async function transactionFixture(options: { live?: string; target?: string; targetConfig?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qlb-cc-switch-'));
  const home = join(root, 'home');
  const env = { QLB_TEST_MODE: '1', HOME: home };
  const paths = claudePaths({ home, env });
  mkdirSync(paths.configHome, { recursive: true });
  const backend = new MockKeychain();
  const slots = new ClaudeSlots({ backend, repository: new InMemoryClaudeSlotRepository(), stashDir: join(root, 'unclaimed'), now: () => NOW });
  const outgoing = JSON.stringify({ claudeAiOauth: { accessToken: 'outgoing-access', refreshToken: 'outgoing-refresh', expiresAt: NOW + 60 * 60_000 }, mcpOAuth: { shared: 'live' } });
  const target = options.target ?? credential('b');
  await slots.createSlot({ accountId: 'account-a', credential: outgoing, email: 'a@example.test', orgUuid: 'org-a', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }), source: 'cswap-import' });
  await slots.createSlot({ accountId: 'account-b', credential: target, email: 'b@example.test', orgUuid: 'org-b', configJson: JSON.stringify(options.targetConfig ?? { oauthAccount: { accountUuid: 'account-b' } }), source: 'cswap-import' });
  await backend.set(paths.keychainService, 'fixture-user', options.live ?? outgoing);
  writeFileSync(paths.globalConfigPath, JSON.stringify({ oauthAccount: { accountUuid: 'account-a' }, retained: 'yes' }));
  let active = 'account-a';
  let committed: Record<string, unknown> | null = null;
  const rows: Record<string, unknown>[] = [];
  const refusals: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const deps: ClaudeSwitchDeps = {
    store: {
      getActiveLogin: () => ({ provider: 'anthropic', accountId: active, since: NOW, setBy: 'manual' }),
      getConfig: () => null,
      setActiveLogin: (_provider, accountId) => { active = accountId ?? ''; },
      recordSwitch: (row) => { rows.push(row); return rows.length; },
      recordRelogin: () => 1,
      recordClaudeSwitchRefusal: (row) => { refusals.push(row); rows.push({ ...row, outcome: 'refused' }); return refusals.length; },
      findClaudeSwitchByAttempt: () => null,
      commitClaudeSwitch: (row) => { committed = row; active = row.toAccount; return 42; },
    },
    slots, live: { backend, paths, account: 'fixture-user' },
    readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
    resolveProfile: async () => null,
    consume: { postRefresh: async () => ({ status: 500, body: '' }), withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn() },
    env, home, now: () => NOW, by: 'qlb-cli', attempt: 'attempt-k5-5', journalDir: join(root, 'journal'), journalOwner: { pid: process.pid, lstart: 'fixture' }, warn: (message) => warnings.push(message),
  };
  return { root, home, env, paths, backend, slots, deps, get active() { return active; }, get committed() { return committed; }, rows, refusals, warnings };
}

function seedJournal(subject: { deps: ClaudeSwitchDeps; paths: ReturnType<typeof claudePaths> }, patch: Record<string, unknown> = {}): string {
  const path = join(subject.deps.journalDir!, 'switch-anthropic.json');
  mkdirSync(subject.deps.journalDir!, { recursive: true });
  writeFileSync(path, JSON.stringify({
    v: 1, provider: 'anthropic', attemptId: 'older-attempt', from: 'account-a', to: 'account-b', trigger: 'manual', by: 'qlb-cli', republish: false, injected: false, detail: null,
    decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null }, outgoingKind: 'own-bytes', bindingJson: null, step: 6,
    stagedBlobService: 'qlb:anthropic:staged-rollback:older', stagedAccount: 'qlb', stagedWritten: false, keychainService: subject.paths.keychainService,
    configPath: subject.paths.globalConfigPath, configText: null, configWrittenHash: null, fromOauthAccount: null, credentialsWrittenHash: null,
    credentialsWriteStarted: false, credentialsWritten: false, configWriteStarted: false, configWritten: false, closed: null, startedAt: NOW, owner: { pid: process.pid, lstart: 'old' }, ...patch,
  }));
  return path;
}

describe('Claude switch transaction (K5-5)', () => {
  it('a manual switch A→B with own-bytes outgoing commits ok, writes B\'s blob composed with the live shared fields, replaces only oauthAccount, and sets active_login, last_active_at, cooldown and the S45 keys', async () => {
    const subject = await transactionFixture();
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.outcome, 'ok');
    assert.equal(result.from, 'account-a');
    assert.equal(result.to, 'account-b');
    assert.equal(subject.active, 'account-b');
    assert.equal(result.switchId, 42);
    assert.equal(result.outgoingKind, 'own-bytes');
    const written = JSON.parse(await subject.backend.get(subject.paths.keychainService, 'fixture-user')) as Record<string, unknown>;
    assert.deepEqual(written.mcpOAuth, { shared: 'live' });
    assert.equal((written.claudeAiOauth as { refreshToken: string }).refreshToken, 'fixture-refresh-b');
    const config = JSON.parse(readFileSync(subject.paths.globalConfigPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(config.oauthAccount, { accountUuid: 'account-b' });
    assert.equal(config.retained, 'yes');
    assert.equal((subject.committed as { decision: { leftHeadroom: null } }).decision.leftHeadroom, null);
  });

  it('a manual switch with no decision deletes all three auto.anthropic.left* keys and stores no \'undefined\'', async () => {
    const subject = await transactionFixture();
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.outcome, 'ok');
    assert.deepEqual((subject.committed as { decision: unknown }).decision, {
      leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null,
    });
    assert.equal(JSON.stringify(subject.committed).includes('undefined'), false);
  });

  it('the result carries from (read under the lock) and to', async () => {
    const subject = await transactionFixture();
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ from: result.from, to: result.to }, { from: 'account-a', to: 'account-b' });
  });

  it('an unreadable target slot fails target-unreadable under the lock and records one failed row', async () => {
    const subject = await transactionFixture();
    const original = subject.slots.readSlot.bind(subject.slots);
    subject.deps.locks = { switch: (async (fn: () => Promise<unknown>, options: unknown) => {
      subject.slots.readSlot = async (id, readOptions) => id === 'account-b' ? Promise.reject(new Error('target gone')) : original(id, readOptions);
      return withClaudeSwitchLock(fn, options as never);
    }) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['switch'] };
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason, failedStep: result.steps?.failedStep }, { outcome: 'failed', reason: 'target-unreadable', failedStep: 6 });
    assert.equal((subject.rows.at(-1) as { outcome: string; detail: string }).outcome, 'failed');
    assert.equal((subject.rows.at(-1) as { outcome: string; detail: string }).detail, 'target-unreadable');
  });

  it('an owner lock held by a fixture with no journal file refuses lock-timeout at step 4 with one refused row and no step-5 write (injected owner lock throws ClaudeCodeLockTimeout; Keychain and slot spies see no write)', async () => {
    const subject = await transactionFixture();
    subject.deps.locks = { owner: async () => { throw new ClaudeCodeLockTimeout('/fixture/journal.lock'); } };
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason, exitCode: result.exitCode }, { outcome: 'refused', reason: 'lock-timeout', exitCode: 3 });
    assert.equal(subject.refusals.length, 1);
    assert.equal(subject.backend.listServices().some((service) => service.startsWith('qlb:anthropic:staged-rollback:')), false);
  });

  it('a queued second switch to the same target records noop under the lock', async () => {
    const subject = await transactionFixture();
    const result = await switchClaude(subject.deps, { to: 'account-a', trigger: 'manual' });
    assert.deepEqual({ outcome: result.outcome, from: result.from, to: result.to, exitCode: result.exitCode }, { outcome: 'noop', from: 'account-a', to: 'account-a', exitCode: 0 });
  });

  it('an empty live item refuses before classification and writes nothing', async () => {
    const subject = await transactionFixture();
    await subject.backend.delete(subject.paths.keychainService, 'fixture-user');
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'refused', reason: 'live-credential-empty' });
    assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), false);
  });

  it('republish is unavailable before any transaction write', async () => {
    const subject = await transactionFixture();
    const result = await switchClaude(subject.deps, { ...manual, republish: true });
    assert.deepEqual({ outcome: result.outcome, reason: result.reason, exitCode: result.exitCode }, { outcome: 'refused', reason: 'republish-unavailable', exitCode: 3 });
    assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), false);
  });

  it('a foreign live credential is refused outgoing-unrouted:foreign before any write (K5 interim)', async () => {
    const foreign = credential('foreign');
    const subject = await transactionFixture({ live: foreign });
    subject.deps.resolveProfile = async () => ({ uuid: 'account-b', email: 'b@example.test', organizationUuid: 'org-b' });
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.reason, 'outgoing-unrouted:foreign');
    assert.equal(result.outcome, 'refused');
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), foreign);
  });

  it('a failure at step 7 before K8-2 returns failed step-7 with exit 1, leaves the journal as written and does not throw', async () => {
    const subject = await transactionFixture();
    subject.deps.live.backend = {
      kind: 'test-memory',
      get: (...args) => subject.backend.get(...args),
      delete: (...args) => subject.backend.delete(...args),
      set: async (service, account, value) => {
        if (service === subject.paths.keychainService) throw new Error('keychain write failure');
        return subject.backend.set(service, account, value);
      },
      setSync: (...args) => subject.backend.setSync(...args),
      getSync: (...args) => subject.backend.getSync(...args),
      deleteSync: (...args) => subject.backend.deleteSync(...args),
    };
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason, exitCode: result.exitCode, failedStep: result.steps?.failedStep }, { outcome: 'failed', reason: 'step-7', exitCode: 1, failedStep: 7 });
    assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), true);
  });

  it("crashAt 'before-step-6' leaves no journal and the next switch commits ok", async () => {
    const subject = await transactionFixture();
    subject.deps.crashAt = (checkpoint) => { if (checkpoint === 'before-step-6') throw new CrashSignal(checkpoint); };
    await assert.rejects(() => switchClaude(subject.deps, manual), CrashSignal);
    assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), false);
    subject.deps.crashAt = undefined;
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
  });

  it('.credentials.json is rewritten only when it already exists', async () => {
    const subject = await transactionFixture();
    assert.equal(existsSync(subject.paths.credentialsPath), false);
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
    assert.equal(existsSync(subject.paths.credentialsPath), false);
  });

  it('the staged item is deleted before the journal after a committed switch and both are gone', async () => {
    const subject = await transactionFixture();
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.outcome, 'ok');
    assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), false);
    assert.equal(subject.backend.listServices().some((service) => service.startsWith('qlb:anthropic:staged-rollback:')), false);
  });

  it('the journal exists with step 6, attempt, the commit inputs (decision, outgoingKind, bindingJson, injected, by, republish, detail), fromOauthAccount null and stagedWritten true, and the staged item holds the outgoing blob, before the step-7 write (beforeStep7 hook)', async () => {
    const subject = await transactionFixture();
    subject.deps.hooks = { beforeStep7: () => {
      const journal = JSON.parse(readFileSync(join(subject.deps.journalDir!, 'switch-anthropic.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(journal.step, 6);
      assert.equal(journal.attemptId, 'attempt-k5-5');
      assert.equal(journal.outgoingKind, 'own-bytes');
      assert.equal(journal.stagedWritten, true);
      assert.equal(journal.fromOauthAccount, null);
      assert.equal(journal.republish, false);
      assert.equal(journal.detail, null);
      assert.equal(typeof journal.stagedBlobService, 'string');
    } };
    assert.equal((await switchClaude(subject.deps, { ...manual, bindingJson: '{"safe":true}', injected: true })).outcome, 'ok');
  });

  it("crashAt 'after-journal' leaves a step-6 journal with stagedWritten false and no staged item", async () => {
    const subject = await transactionFixture();
    subject.deps.crashAt = (checkpoint) => { if (checkpoint === 'after-journal') throw new CrashSignal(checkpoint); };
    await assert.rejects(() => switchClaude(subject.deps, manual), CrashSignal);
    const journal = JSON.parse(readFileSync(join(subject.deps.journalDir!, 'switch-anthropic.json'), 'utf8')) as { step: number; stagedWritten: boolean; stagedBlobService: string };
    assert.deepEqual({ step: journal.step, stagedWritten: journal.stagedWritten }, { step: 6, stagedWritten: false });
    assert.equal(subject.backend.listServices().includes(journal.stagedBlobService), false);
  });

  it("crashAt 'after-stage' leaves the journal naming the staged item, live and config untouched", async () => {
    const subject = await transactionFixture();
    const before = await subject.backend.get(subject.paths.keychainService, 'fixture-user');
    const config = readFileSync(subject.paths.globalConfigPath, 'utf8');
    subject.deps.crashAt = (checkpoint) => { if (checkpoint === 'after-stage') throw new CrashSignal(checkpoint); };
    await assert.rejects(() => switchClaude(subject.deps, manual), CrashSignal);
    const journal = JSON.parse(readFileSync(join(subject.deps.journalDir!, 'switch-anthropic.json'), 'utf8')) as { stagedWritten: boolean; stagedBlobService: string };
    assert.equal(journal.stagedWritten, true);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), before);
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), config);
    assert.equal(subject.backend.listServices().includes(journal.stagedBlobService), true);
  });

  it("crashAt 'before-step-7-write' leaves credentialsWriteStarted true and credentialsWritten false", async () => {
    const subject = await transactionFixture();
    subject.deps.crashAt = (checkpoint) => { if (checkpoint === 'before-step-7-write') throw new CrashSignal(checkpoint); };
    await assert.rejects(() => switchClaude(subject.deps, manual), CrashSignal);
    const journal = JSON.parse(readFileSync(join(subject.deps.journalDir!, 'switch-anthropic.json'), 'utf8')) as { credentialsWriteStarted: boolean; credentialsWritten: boolean };
    assert.deepEqual({ credentialsWriteStarted: journal.credentialsWriteStarted, credentialsWritten: journal.credentialsWritten }, { credentialsWriteStarted: true, credentialsWritten: false });
  });

  it("crashAt 'after-step-7' leaves a step-7 journal with credentialsWritten and publishedAt", async () => {
    const subject = await transactionFixture();
    subject.deps.crashAt = (checkpoint) => { if (checkpoint === 'after-step-7') throw new CrashSignal(checkpoint); };
    await assert.rejects(() => switchClaude(subject.deps, manual), CrashSignal);
    const journal = JSON.parse(readFileSync(join(subject.deps.journalDir!, 'switch-anthropic.json'), 'utf8')) as { step: number; credentialsWritten: boolean; publishedAt?: number };
    assert.deepEqual({ step: journal.step, credentialsWritten: journal.credentialsWritten, publishedAt: journal.publishedAt }, { step: 7, credentialsWritten: true, publishedAt: NOW });
  });

  it('configText in the journal equals the bytes read under the config lock, not the Phase-A text (fixture edits the config between Phase A and step 8), fromOauthAccount equals that text\'s oauthAccount, configWrittenHash equals sha256 of the spliced file, and all three are in the journal before the config write lands (writeText spy ordering)', async () => {
    const subject = await transactionFixture();
    const replacement = JSON.stringify({ oauthAccount: { accountUuid: 'account-a', source: 'step-8' }, retained: 'changed' });
    subject.deps.hooks = { afterStep7: () => writeFileSync(subject.paths.globalConfigPath, replacement) };
    subject.deps.crashAt = (checkpoint) => { if (checkpoint === 'after-step-8') throw new CrashSignal(checkpoint); };
    await assert.rejects(() => switchClaude(subject.deps, manual), CrashSignal);
    const journal = JSON.parse(readFileSync(join(subject.deps.journalDir!, 'switch-anthropic.json'), 'utf8')) as { configText: string; fromOauthAccount: unknown; configWrittenHash: string; configWriteStarted: boolean };
    const planned = readFileSync(subject.paths.globalConfigPath, 'utf8');
    assert.equal(journal.configText, replacement);
    assert.deepEqual(journal.fromOauthAccount, { accountUuid: 'account-a', source: 'step-8' });
    assert.equal(journal.configWrittenHash, createHash('sha256').update(planned).digest('hex'));
    assert.equal(journal.configWriteStarted, true);
  });

  it("crashAt 'after-step-8' leaves a step-8 journal whose configText equals the pre-splice bytes and no switch_log row", async () => {
    const subject = await transactionFixture();
    const raw = readFileSync(subject.paths.globalConfigPath, 'utf8');
    subject.deps.crashAt = (checkpoint) => { if (checkpoint === 'after-step-8') throw new CrashSignal(checkpoint); };
    await assert.rejects(() => switchClaude(subject.deps, manual), CrashSignal);
    const journal = JSON.parse(readFileSync(join(subject.deps.journalDir!, 'switch-anthropic.json'), 'utf8')) as { step: number; configText: string };
    assert.deepEqual({ step: journal.step, configText: journal.configText }, { step: 8, configText: raw });
    assert.equal(subject.committed, null);
  });

  it('an unparseable live blob reaches step 7 with no shared fields (?? {}) after its fail-open backup', async () => {
    const subject = await transactionFixture({ live: 'not-json' });
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.outcome, 'ok');
    const written = JSON.parse(await subject.backend.get(subject.paths.keychainService, 'fixture-user')) as Record<string, unknown>;
    assert.equal('mcpOAuth' in written, false);
  });

  it('classifySwitchError maps a security timeout to keychain-timeout, a backend write error to keychain-write-failed, a ClaudeConfigFileError or writeText error at step 8 to config-write-failed, a SQLite error to sqlite-error, a journal I/O error to journal-io-failed and an owner-lock timeout or loss to lock-timeout', () => {
    assert.equal(classifySwitchError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 'keychain-timeout');
    assert.equal(classifySwitchError(new Error('keychain write failed')), 'keychain-write-failed');
    assert.equal(classifySwitchError(new ClaudeConfigFileError('/fixture/config', 'bad')), 'config-write-failed');
    assert.equal(classifySwitchError(new Error('SQLite database unavailable')), 'sqlite-error');
    assert.equal(classifySwitchError(new Error('journal disk failure')), 'journal-io-failed');
    assert.equal(classifySwitchError(new ClaudeCodeLockTimeout('/fixture/lock')), 'lock-timeout');
  });

  it('the config lock is taken only across step 8, the credential locks span steps 4–9, and the journal owner lock is taken right after the credential locks at step 4 and held to the journal delete (lock-order spy)', async () => {
    const subject = await transactionFixture();
    const events: string[] = [];
    const held = { assertHeld: () => undefined };
    subject.deps.locks = {
      switch: (async (fn: () => Promise<unknown>, options: unknown) => { events.push('switch+'); try { return await withClaudeSwitchLock(fn, options as never); } finally { events.push('switch-'); } }) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['switch'],
      credential: (async (options: unknown, fn: (value: unknown) => Promise<unknown>) => { events.push('credential+'); try { return await withClaudeCredentialLocks(options as never, fn as never); } finally { events.push('credential-'); } }) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['credential'],
      owner: (async (options: unknown, fn: (value: unknown) => Promise<unknown>) => { events.push('owner+'); try { return await withClaudeSwitchJournalOwner(options as never, fn as never); } finally { events.push('owner-'); } }) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['owner'],
      configPath: (async (path: string, options: unknown, fn: (value: unknown) => Promise<unknown>) => { events.push('config+'); try { return await withClaudeConfigPathLock(path, options as never, fn as never); } finally { events.push('config-'); } }) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['configPath'],
    };
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
    assert.deepEqual(events, ['switch+', 'credential+', 'owner+', 'config+', 'config-', 'owner-', 'credential-', 'switch-']);
  });

  it('no network call and no consume lock inside the switch lock (spy)', async () => {
    const subject = await transactionFixture();
    let inSwitch = false;
    let profileInside = false;
    let consumeInside = false;
    subject.deps.resolveProfile = async () => { profileInside ||= inSwitch; return null; };
    subject.deps.consume.withConsumeLock = async (fn) => { consumeInside ||= inSwitch; return fn(); };
    subject.deps.locks = { switch: (async (fn: () => Promise<unknown>) => { inSwitch = true; try { return await fn(); } finally { inSwitch = false; } }) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['switch'] };
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
    assert.equal(profileInside, false); assert.equal(consumeInside, false);
  });

  it('the journal is created before the staged item (write-order spy)', async () => {
    const subject = await transactionFixture();
    subject.deps.crashAt = (checkpoint) => { if (checkpoint === 'after-journal') throw new CrashSignal(checkpoint); };
    await assert.rejects(() => switchClaude(subject.deps, manual), CrashSignal);
    assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), true);
    assert.equal(subject.backend.listServices().some((service) => service.startsWith('qlb:anthropic:staged-rollback:')), false);
  });

  it('credentialsWrittenHash equals sha256 of the composed blob and is in the journal before the helper write (write-order spy)', async () => {
    const subject = await transactionFixture();
    const originalSet = subject.backend.set.bind(subject.backend);
    let checked = false;
    subject.deps.live.backend = {
      kind: 'test-memory', get: (...args) => subject.backend.get(...args), delete: (...args) => subject.backend.delete(...args),
      setSync: (...args) => subject.backend.setSync(...args), getSync: (...args) => subject.backend.getSync(...args), deleteSync: (...args) => subject.backend.deleteSync(...args),
      set: async (service, account, value) => {
        if (service === subject.paths.keychainService) {
          const journal = JSON.parse(readFileSync(join(subject.deps.journalDir!, 'switch-anthropic.json'), 'utf8')) as { credentialsWrittenHash: string };
          assert.equal(journal.credentialsWrittenHash, createHash('sha256').update(value).digest('hex')); checked = true;
        }
        return originalSet(service, account, value);
      },
    };
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok'); assert.equal(checked, true);
  });

  it('the capturing spliceOauthAccount call writes nothing and the bytes QLB then writes equal what spliceOauthAccount\'s default writer would have written (byte-compare against a reference splice on a copy)', async () => {
    const subject = await transactionFixture();
    const raw = readFileSync(subject.paths.globalConfigPath, 'utf8');
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
    const expected = `${JSON.stringify({ ...JSON.parse(raw), oauthAccount: { accountUuid: 'account-b' } }, null, 2)}\n`;
    assert.equal(readFileSync(subject.paths.globalConfigPath, 'utf8'), expected);
  });

  it('TestClaudeCodeLockCooperation', async () => {
    const subject = await transactionFixture();
    let credentialsHeld = false;
    subject.deps.locks = { credential: (async (options: unknown, fn: (value: unknown) => Promise<unknown>) => { credentialsHeld = true; try { return await withClaudeCredentialLocks(options as never, fn as never); } finally { credentialsHeld = false; } }) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['credential'] };
    subject.deps.hooks = { beforeStep7: () => assert.equal(credentialsHeld, true) };
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
  });

  it('TestSharedOAuthCredentialPreservation', async () => {
    const subject = await transactionFixture();
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
    const blob = JSON.parse(await subject.backend.get(subject.paths.keychainService, 'fixture-user')) as { mcpOAuth: unknown };
    assert.deepEqual(blob.mcpOAuth, { shared: 'live' });
  });

  it('TestDirectActivationPreservation', async () => {
    const subject = await transactionFixture();
    const original = await subject.slots.readSlot('account-a', { fresh: true });
    const family = JSON.stringify({ claudeAiOauth: { accessToken: 'outgoing-access-successor', refreshToken: 'outgoing-refresh', expiresAt: NOW + 60 * 60_000 } });
    await subject.backend.set(subject.paths.keychainService, 'fixture-user', family);
    assert.equal((await switchClaude(subject.deps, manual)).outgoingKind, 'own-family');
    assert.equal((await subject.slots.readSlot('account-a', { fresh: true })).credential, family);
    assert.notEqual(original.credential, family);
    assert.equal(subject.backend.listServices().some((service) => service.endsWith(':prev')), true);
  });

  it('TestSwitchUnreadableBackup', async () => {
    const live = credential('diverged'); const subject = await transactionFixture({ live });
    const original = subject.slots.readSlot.bind(subject.slots);
    subject.slots.readSlot = async (id, options) => id === 'account-a' ? Promise.reject(new Error('unreadable')) : original(id, options);
    subject.deps.resolveProfile = async () => { throw new Error('profile unavailable'); };
    assert.equal((await switchClaude(subject.deps, manual)).outgoingKind, 'unresolved');
    subject.slots.readSlot = original;
    assert.equal((await subject.slots.readSlot('account-a', { fresh: true })).credential, live);
  });

  it('TestSwitchSkipsBrokenSlots', async () => {
    const subject = await transactionFixture(); const original = subject.slots.readSlot.bind(subject.slots);
    await subject.slots.createSlot({ accountId: 'account-c', credential: credential('c'), email: 'c@example.test', orgUuid: 'org-c', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-c' } }), source: 'cswap-import' });
    subject.slots.readSlot = async (id, options) => id === 'account-c' ? Promise.reject(new Error('broken non-target')) : original(id, options);
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
    assert.equal(subject.warnings.length, 1);
  });

  it('X3b step 4 unreadable live credential is refused before writes', async () => {
    const subject = await transactionFixture();
    subject.deps.live.backend = { kind: 'test-memory', get: async () => { throw new Error('unreadable'); }, set: (...args) => subject.backend.set(...args), delete: (...args) => subject.backend.delete(...args), setSync: (...args) => subject.backend.setSync(...args), getSync: (...args) => subject.backend.getSync(...args), deleteSync: (...args) => subject.backend.deleteSync(...args) };
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'refused', reason: 'live-credential-unreadable' });
  });

  it('an owner lock held by a fixture beside an unfinished journal refuses switch-journal-present with nothing written', async () => {
    const subject = await transactionFixture(); const journalPath = seedJournal(subject);
    const before = await subject.backend.get(subject.paths.keychainService, 'fixture-user');
    subject.deps.probeOwner = () => 'free'; subject.deps.stillTheSameProcess = async () => true;
    subject.deps.locks = { owner: async () => { throw new ClaudeCodeLockTimeout('/fixture/journal.lock'); } };
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason, exitCode: result.exitCode }, { outcome: 'refused', reason: 'switch-journal-present', exitCode: 3 });
    assert.equal(subject.refusals.length, 1);
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), before);
    assert.equal(existsSync(journalPath), true);
    assert.equal(subject.backend.listServices().some((service) => service.startsWith('qlb:anthropic:staged-rollback:')), false);
  });

  it('a target struck dead after Phase A is refused under the lock with nothing written', async () => {
    const subject = await transactionFixture(); const original = subject.slots.getSlot.bind(subject.slots);
    subject.deps.locks = { switch: (async (fn: () => Promise<unknown>, options: unknown) => {
      subject.slots.getSlot = (id) => id === 'account-b' ? { ...original(id)!, dead: true } : original(id);
      return withClaudeSwitchLock(fn, options as never);
    }) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['switch'] };
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'refused', reason: 'target-dead' });
    assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), false);
  });

  it('a live rotation after the prefetch is adopted into the outgoing slot by lineage', async () => {
    const rotated = credential('lineage'); const subject = await transactionFixture({ live: rotated });
    subject.deps.resolveProfile = async () => ({ uuid: 'account-a', email: 'a@example.test', organizationUuid: 'org-a' });
    assert.equal((await switchClaude(subject.deps, manual)).outgoingKind, 'own-rotated');
  });

  it('moved bytes with no lineage link back up fail-open as unresolved', async () => {
    const moved = credential('moved'); const subject = await transactionFixture({ live: moved }); subject.deps.resolveProfile = async () => null;
    assert.equal((await switchClaude(subject.deps, manual)).outgoingKind, 'unresolved');
  });

  it('a failing step-5 adopt fails outgoing-backup-failed and writes nothing else', async () => {
    const subject = await transactionFixture({ live: credential('moved') }); subject.deps.resolveProfile = async () => null;
    subject.slots.writeSlot = async () => { throw new Error('keychain write failed'); };
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'failed', reason: 'outgoing-backup-failed' });
  });

  it('a malformed journal refuses and is left in place', async () => {
    const subject = await transactionFixture(); mkdirSync(subject.deps.journalDir!, { recursive: true }); const path = join(subject.deps.journalDir!, 'switch-anthropic.json'); writeFileSync(path, '{}');
    assert.equal((await switchClaude(subject.deps, manual)).reason, 'switch-journal-malformed'); assert.equal(existsSync(path), true);
  });

  it('an orphaned unfinished journal refuses before Phase A with zero writes', async () => {
    const subject = await transactionFixture(); const path = seedJournal(subject);
    subject.deps.probeOwner = () => 'free'; subject.deps.stillTheSameProcess = async () => false;
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.reason, 'switch-journal-present'); assert.equal(existsSync(path), true);
  });

  it('a journal whose committed attempt row exists is deleted with its staged item under the owner lock and the switch proceeds with one new row', async () => {
    const subject = await transactionFixture(); const path = seedJournal(subject);
    await subject.backend.set('qlb:anthropic:staged-rollback:older', 'qlb', credential('old'));
    subject.deps.store.findClaudeSwitchByAttempt = (attempt) => attempt === 'older-attempt' ? { id: 1, outcome: 'ok', ts: NOW, committedAt: NOW } : null;
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
    assert.equal(existsSync(path), false); assert.equal(subject.backend.listServices().includes('qlb:anthropic:staged-rollback:older'), false);
  });

  it('a journal whose owner process is alive (stillTheSameProcess spy true) is left in place', async () => {
    const subject = await transactionFixture(); const path = seedJournal(subject);
    subject.deps.probeOwner = () => 'free'; subject.deps.stillTheSameProcess = async () => true;
    subject.deps.locks = { owner: async () => { throw new ClaudeCodeLockTimeout('/fixture/owner'); } };
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.reason, 'switch-journal-present'); assert.equal(existsSync(path), true);
  });

  it('a failing staged write at step 6 fails stage-failed, marks the journal closed stage-failed, deletes the staged item by name and the journal, and leaves the live item, config and step-5 adopt in place (write-order spy: marker before the deletes)', async () => {
    const subject = await transactionFixture(); const before = await subject.backend.get(subject.paths.keychainService, 'fixture-user');
    subject.deps.live.backend = { kind: 'test-memory', get: (...args) => subject.backend.get(...args), delete: (...args) => subject.backend.delete(...args), setSync: (...args) => subject.backend.setSync(...args), getSync: (...args) => subject.backend.getSync(...args), deleteSync: (...args) => subject.backend.deleteSync(...args), set: async (service, account, value) => service.startsWith('qlb:anthropic:staged-rollback:') ? Promise.reject(new Error('keychain write failed')) : subject.backend.set(service, account, value) };
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason, failedStep: result.steps?.failedStep }, { outcome: 'failed', reason: 'stage-failed', failedStep: 6 });
    assert.equal(await subject.backend.get(subject.paths.keychainService, 'fixture-user'), before); assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), false);
  });

  it('a step-6 staged delete that fails keeps a journal marked closed stage-failed still naming the item, lists cleanup, and the next switch deletes the item and the journal and commits ok', async () => {
    const subject = await transactionFixture();
    const originalSet = subject.backend.set.bind(subject.backend);
    const originalDelete = subject.backend.delete.bind(subject.backend);
    let failDelete = true;
    subject.deps.live.backend = {
      kind: 'test-memory', get: (...args) => subject.backend.get(...args),
      set: async (service, account, value) => {
        await originalSet(service, account, value);
        if (service.startsWith('qlb:anthropic:staged-rollback:')) throw new Error('staged write timeout');
      },
      delete: async (service, account) => service.startsWith('qlb:anthropic:staged-rollback:') && failDelete ? Promise.reject(new Error('staged delete failed')) : originalDelete(service, account),
      setSync: (...args) => subject.backend.setSync(...args), getSync: (...args) => subject.backend.getSync(...args), deleteSync: (...args) => subject.backend.deleteSync(...args),
    };
    const failed = await switchClaude(subject.deps, manual);
    const journalPath = join(subject.deps.journalDir!, 'switch-anthropic.json');
    assert.equal(failed.reason, 'stage-failed');
    assert.equal(failed.steps?.cleanup.length, 1);
    assert.equal((JSON.parse(readFileSync(journalPath, 'utf8')) as { closed: string }).closed, 'stage-failed');
    assert.equal(subject.backend.listServices().some((service) => service.startsWith('qlb:anthropic:staged-rollback:')), true);
    failDelete = false;
    subject.deps.live.backend = subject.backend;
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
    assert.equal(existsSync(journalPath), false);
  });

  it('a staged write that times out after landing is deleted by name although stagedWritten is false', async () => {
    const subject = await transactionFixture();
    const originalSet = subject.backend.set.bind(subject.backend);
    subject.deps.live.backend = {
      kind: 'test-memory', get: (...args) => subject.backend.get(...args), delete: (...args) => subject.backend.delete(...args),
      set: async (service, account, value) => {
        await originalSet(service, account, value);
        if (service.startsWith('qlb:anthropic:staged-rollback:')) throw new Error('timed out after landing');
      },
      setSync: (...args) => subject.backend.setSync(...args), getSync: (...args) => subject.backend.getSync(...args), deleteSync: (...args) => subject.backend.deleteSync(...args),
    };
    const result = await switchClaude(subject.deps, manual);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'failed', reason: 'stage-failed' });
    assert.equal(subject.backend.listServices().some((service) => service.startsWith('qlb:anthropic:staged-rollback:')), false);
    assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), false);
  });

  it('crashAt \'after-commit\' leaves one ok row and an uncommitted journal that the next switch\'s preflight deletes without a second row', async () => {
    const subject = await transactionFixture(); subject.deps.crashAt = (checkpoint) => { if (checkpoint === 'after-commit') throw new CrashSignal(checkpoint); };
    await assert.rejects(() => switchClaude(subject.deps, manual), CrashSignal);
    assert.equal(subject.committed !== null, true); assert.equal(existsSync(join(subject.deps.journalDir!, 'switch-anthropic.json')), true);
  });

  it('a failing staged-item delete after the commit keeps outcome ok, lists cleanup, leaves the journal in place, and the next preflight (committed row found) deletes the item and then the journal', async () => {
    const subject = await transactionFixture(); const originalDelete = subject.backend.delete.bind(subject.backend);
    subject.deps.live.backend = { kind: 'test-memory', get: (...args) => subject.backend.get(...args), set: (...args) => subject.backend.set(...args), delete: async (service, account) => service.startsWith('qlb:anthropic:staged-rollback:') ? Promise.reject(new Error('journal delete failed')) : originalDelete(service, account), setSync: (...args) => subject.backend.setSync(...args), getSync: (...args) => subject.backend.getSync(...args), deleteSync: (...args) => subject.backend.deleteSync(...args) };
    const result = await switchClaude(subject.deps, manual);
    const path = join(subject.deps.journalDir!, 'switch-anthropic.json');
    assert.equal(result.outcome, 'ok'); assert.equal(result.steps?.cleanup.length, 1); assert.equal(existsSync(path), true);
    subject.deps.live.backend = subject.backend;
    subject.deps.store.setActiveLogin('anthropic', 'account-a', 'manual', NOW);
    const next = await switchClaude(subject.deps, manual);
    assert.equal(next.outcome, 'ok');
    assert.equal(existsSync(path), false);
  });

  it('a second switch that starts while the first holds the journal owner lock does not refuse: it waits on the switch lock and records noop (owner-probe spy returns held)', async () => {
    const subject = await transactionFixture();
    const journalPath = seedJournal(subject);
    let probes = 0;
    subject.deps.probeOwner = () => { probes += 1; return 'held'; };
    subject.deps.locks = { owner: async (options, fn) => {
      unlinkSync(journalPath);
      subject.deps.store.setActiveLogin('anthropic', 'account-b', 'manual', NOW);
      return withClaudeSwitchJournalOwner(options, fn);
    } };
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.outcome, 'noop');
    assert.equal(probes, 1);
    assert.equal((subject.rows.at(-1) as { outcome: string }).outcome, 'noop');
  });

  it('a journal created between the preflight and the lock is refused under the lock before step 5', async () => {
    const subject = await transactionFixture();
    subject.deps.locks = { owner: async (options, fn) => {
      seedJournal(subject);
      return withClaudeSwitchJournalOwner(options, fn);
    } };
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.reason, 'switch-journal-present');
    assert.equal(subject.backend.listServices().some((service) => service.startsWith('qlb:anthropic:staged-rollback:')), false);
  });

  it('a journal marked closed rolled-back whose staged item is already gone is deleted and the switch proceeds', async () => {
    const subject = await transactionFixture(); const path = seedJournal(subject, { closed: 'rolled-back' });
    subject.deps.probeOwner = () => 'free'; subject.deps.stillTheSameProcess = async () => false;
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
    assert.equal(existsSync(path), false);
  });

  it('a journal marked closed stage-failed that still names its staged item is deleted with the item and the switch proceeds', async () => {
    const subject = await transactionFixture(); const path = seedJournal(subject, { closed: 'stage-failed' });
    await subject.backend.set('qlb:anthropic:staged-rollback:older', 'qlb', credential('old'));
    subject.deps.probeOwner = () => 'free'; subject.deps.stillTheSameProcess = async () => false;
    assert.equal((await switchClaude(subject.deps, manual)).outcome, 'ok');
    assert.equal(existsSync(path), false);
    assert.equal(subject.backend.listServices().includes('qlb:anthropic:staged-rollback:older'), false);
  });

  it('a journal whose only row for the attempt is rolled-back or refused and that carries no marker is not finished: the switch refuses switch-journal-present and the staged item survives', async () => {
    const subject = await transactionFixture(); const path = seedJournal(subject);
    await subject.backend.set('qlb:anthropic:staged-rollback:older', 'qlb', credential('old'));
    subject.deps.probeOwner = () => 'free'; subject.deps.stillTheSameProcess = async () => false;
    subject.deps.store.findClaudeSwitchByAttempt = () => null;
    assert.equal((await switchClaude(subject.deps, manual)).reason, 'switch-journal-present');
    assert.equal(existsSync(path), true);
    assert.equal(subject.backend.listServices().includes('qlb:anthropic:staged-rollback:older'), true);
  });

  it('does not freshen an already-active target before returning noop', async () => {
    const subject = await transactionFixture();
    let posts = 0;
    await subject.slots.writeSlot('account-a', credential('a', NOW + 10 * 60_000), { cause: 'post' });
    subject.deps.consume.postRefresh = async () => {
      posts += 1;
      return { status: 200, body: JSON.stringify({ access_token: 'fixture-issued', refresh_token: 'fixture-refresh-issued', expires_in: 3600 }) };
    };
    const result = await switchClaude(subject.deps, { to: 'account-a', trigger: 'manual' });
    assert.equal(result.outcome, 'noop');
    assert.equal(posts, 0);
  });

  it('a queued second switch to the same target records noop under the lock with one switch_log row', async () => {
    const subject = await transactionFixture();
    const result = await switchClaude(subject.deps, { to: 'account-a', trigger: 'manual' });
    assert.equal(result.outcome, 'noop');
    assert.deepEqual(subject.rows, [{
      ts: NOW, provider: 'anthropic', fromAccount: 'account-a', toAccount: 'account-a', trigger: 'manual',
      outcome: 'noop', injected: false, stepsJson: JSON.stringify({ attempt: 'attempt-k5-5' }),
    }]);
  });

  it('a failed step-7 writes one failed switch_log row', async () => {
    const subject = await transactionFixture();
    subject.deps.live.backend = {
      kind: 'test-memory', get: (...args) => subject.backend.get(...args), delete: (...args) => subject.backend.delete(...args),
      set: async (service, account, value) => service === subject.paths.keychainService ? Promise.reject(new Error('keychain write failure')) : subject.backend.set(service, account, value),
      setSync: (...args) => subject.backend.setSync(...args), getSync: (...args) => subject.backend.getSync(...args), deleteSync: (...args) => subject.backend.deleteSync(...args),
    };
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.outcome, 'failed');
    assert.equal(subject.rows.length, 1);
    assert.deepEqual(subject.rows[0], {
      ts: NOW, provider: 'anthropic', fromAccount: 'account-a', toAccount: 'account-b', trigger: 'manual', outcome: 'failed',
      error: 'keychain-write-failed', detail: 'step-7', injected: false, stepsJson: JSON.stringify({ ...result.steps, attempt: 'attempt-k5-5' }),
    });
  });

  it('re-checks breaker-open and C-swap preconditions under the lock before step 5', async () => {
    const subject = await transactionFixture();
    let processCheck = 0;
    let breakerReads = 0;
    subject.deps.cswapProcesses = () => processCheck++ === 0 ? [] : [{ pid: 1 }];
    subject.deps.store.getConfig = () => ++breakerReads === 1 ? null : String(NOW + 1);
    subject.deps.locks = {
      switch: (async (fn: () => Promise<unknown>, options: unknown) => withClaudeSwitchLock(fn, options as never)) as unknown as NonNullable<ClaudeSwitchDeps['locks']>['switch'],
    };
    const result = await switchClaude(subject.deps, automatic);
    assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'refused', reason: 'breaker-open' });
    assert.equal(processCheck, 1);
    assert.equal(breakerReads, 2);

    const cswap = await transactionFixture();
    let cswapChecks = 0;
    cswap.deps.cswapProcesses = () => cswapChecks++ === 0 ? [] : [{ pid: 1 }];
    const cswapResult = await switchClaude(cswap.deps, automatic);
    assert.deepEqual({ outcome: cswapResult.outcome, reason: cswapResult.reason }, { outcome: 'refused', reason: 'cswap-process-alive' });
    assert.equal(cswapChecks, 2);
  });

  it('a post-commit owner-lock compromise keeps the committed ok result and warns', async () => {
    const subject = await transactionFixture();
    const warnings: string[] = [];
    subject.deps.warn = (message) => warnings.push(message);
    subject.deps.locks = {
      owner: async (options, fn) => {
        await withClaudeSwitchJournalOwner(options, fn);
        throw new ProperLockfileCompromised('/fixture/journal.lock');
      },
    };
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.outcome, 'ok', JSON.stringify(result));
    assert.equal(result.switchId, 42);
    assert.deepEqual(result.steps?.cleanup, ['lock-timeout']);
    assert.equal(subject.refusals.length, 0);
    assert.equal(warnings.length, 1);
  });

  it('a Phase-C afterSwitch error is warned and does not replace the committed ok result', async () => {
    const subject = await transactionFixture();
    const warnings: string[] = [];
    subject.deps.afterSwitch = async () => { throw new Error('usage unavailable'); };
    subject.deps.warn = (message) => warnings.push(message);
    const result = await switchClaude(subject.deps, manual);
    assert.equal(result.outcome, 'ok');
    assert.equal(result.switchId, 42);
    assert.equal(warnings.length, 1);
  });

  it('result, rows and errors contain no token value', async () => {
    const subject = await transactionFixture(); const result = await switchClaude(subject.deps, manual);
    const serialised = JSON.stringify({ result, committed: subject.committed, refusals: subject.refusals });
    assert.equal(serialised.includes('outgoing-access'), false); assert.equal(serialised.includes('fixture-access-b'), false);
  });
});
