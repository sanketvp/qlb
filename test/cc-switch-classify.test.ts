import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { claudePaths } from '../src/cc-paths';
import { ClaudeSlots, InMemoryClaudeSlotRepository } from '../src/cc-slots';
import { MockKeychain } from '../src/keychain';
import { switchClaude, type ClaudeSwitchDeps } from '../src/cc-switch';

const NOW = 1_000_000;

function credential(tag: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${tag}`, refreshToken: `fixture-refresh-${tag}`, expiresAt: NOW + 3_600_000 } });
}

async function fixture(options: {
  live: string;
  resolveProfile: ClaudeSwitchDeps['resolveProfile'];
  probeVerdict?: boolean;
  injectFailStep?: 7 | 8 | 9;
}) {
  const root = mkdtempSync(join(tmpdir(), 'qlb-k9-classify-'));
  const home = join(root, 'home');
  const env = { QLB_TEST_MODE: '1', HOME: home };
  const paths = claudePaths({ home, env });
  mkdirSync(paths.configHome, { recursive: true });
  const backend = new MockKeychain();
  const slots = new ClaudeSlots({ backend, repository: new InMemoryClaudeSlotRepository(), stashDir: join(root, 'unclaimed'), now: () => NOW });
  const accountA = credential('a');
  const accountB = credential('b');
  await slots.createSlot({ accountId: 'account-a', credential: accountA, email: 'a@example.test', orgUuid: 'org-a', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }), source: 'cswap-import' });
  await slots.createSlot({ accountId: 'account-b', credential: accountB, email: 'b@example.test', orgUuid: 'org-b', configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-b' } }), source: 'cswap-import' });
  await backend.set(paths.keychainService, 'fixture-user', options.live);
  writeFileSync(paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } })}\n`);

  let active = 'account-a';
  const rows: Record<string, unknown>[] = [];
  const deps: ClaudeSwitchDeps = {
    store: {
      getActiveLogin: () => ({ provider: 'anthropic', accountId: active, since: NOW, setBy: 'manual' }),
      getConfig: () => null,
      recordSwitch: (row: Record<string, unknown>) => { rows.push(row); return rows.length; },
      recordRelogin: () => 1,
      recordClaudeSwitchRefusal: (row: Record<string, unknown>) => { rows.push(row); return rows.length; },
      findClaudeSwitchByAttempt: () => null,
      commitClaudeSwitch: (row: { toAccount: string; beforeCommit?: () => void }) => { row.beforeCommit?.(); active = row.toAccount; return rows.length + 1; },
    } as unknown as ClaudeSwitchDeps['store'],
    slots,
    live: { backend, paths, account: 'fixture-user' },
    readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
    resolveProfile: options.resolveProfile,
    consume: { postRefresh: async () => ({ status: 500, body: '' }), withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn() },
    env,
    home,
    now: () => NOW,
    by: 'qlb-cli',
    attempt: 'k9-classify-attempt',
    journalDir: join(root, 'journal'),
    journalOwner: { pid: process.pid, lstart: 'fixture' },
    stashTimestamp: () => 'k9-unclaimed',
    injectFailStep: options.injectFailStep,
  };
  return { backend, slots, paths, deps, accountA, accountB, rows, active: () => active, input: { to: 'account-b', trigger: 'manual', probeVerdict: options.probeVerdict } };
}

async function slotCredentials(subject: Awaited<ReturnType<typeof fixture>>) {
  return {
    a: (await subject.slots.readSlot('account-a', { fresh: true })).credential,
    b: (await subject.slots.readSlot('account-b', { fresh: true })).credential,
  };
}

function unclaimedService(timestamp = 'k9-unclaimed'): string {
  return `qlb:anthropic:unclaimed:${timestamp}`;
}

describe('Claude switch classification routing (K9-1)', () => {
  it('foreign ⇒ unclaimed:* written, both slots unchanged, switch commits ok', async () => {
    const live = credential('foreign');
    const subject = await fixture({ live, resolveProfile: async () => ({ uuid: 'account-b', email: 'b@example.test', organizationUuid: 'org-b' }) });
    const before = await slotCredentials(subject);

    const result = await switchClaude(subject.deps, subject.input);

    assert.equal(result.outcome, 'ok');
    assert.equal(result.outgoingKind, 'foreign');
    assert.equal(result.steps?.unclaimed, 'k9-unclaimed');
    assert.deepEqual(await slotCredentials(subject), before);
    const stored = JSON.parse(await subject.backend.get(unclaimedService(), 'qlb')) as { accountId?: string; credential: string };
    assert.equal(stored.accountId, 'account-b');
    assert.equal(stored.credential, live);
    assert.equal(subject.active(), 'account-b');
  });

  it('alien ⇒ unclaimed written with no accountId', async () => {
    const live = credential('alien');
    const subject = await fixture({ live, resolveProfile: async () => ({ uuid: 'other-account', email: 'other@example.test', organizationUuid: 'org-other' }) });

    const result = await switchClaude(subject.deps, subject.input);

    assert.equal(result.outcome, 'ok');
    assert.equal(result.outgoingKind, 'alien');
    const stored = JSON.parse(await subject.backend.get(unclaimedService(), 'qlb')) as { accountId?: string; credential: string };
    assert.equal(Object.hasOwn(stored, 'accountId'), false);
    assert.equal(stored.credential, live);
  });

  it('known-foreign (input.probeVerdict false and the prefetch unresolved) ⇒ unclaimed written', async () => {
    const live = credential('known-foreign');
    const subject = await fixture({ live, resolveProfile: async () => { throw new Error('fixture profile unavailable'); }, probeVerdict: false });

    const result = await switchClaude(subject.deps, subject.input);

    assert.equal(result.outcome, 'ok');
    assert.equal(result.outgoingKind, 'known-foreign');
    const stored = JSON.parse(await subject.backend.get(unclaimedService(), 'qlb')) as { credential: string };
    assert.equal(stored.credential, live);
  });

  it('foreign-synced with byte-identical live bytes ⇒ nothing stashed', async () => {
    const subject = await fixture({ live: credential('b'), resolveProfile: async () => ({ uuid: 'account-b', email: 'b@example.test', organizationUuid: 'org-b' }) });
    const beforeServices = subject.backend.listServices().sort();

    const result = await switchClaude(subject.deps, subject.input);

    assert.equal(result.outcome, 'ok');
    assert.equal(result.outgoingKind, 'foreign-synced');
    assert.deepEqual(subject.backend.listServices().sort(), beforeServices);
    await assert.rejects(() => subject.backend.get(unclaimedService(), 'qlb'));
  });

  it('foreign-synced with different access-token bytes ⇒ stashes live bytes and commits without a slot write', async () => {
    const live = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-b-rotated', refreshToken: 'fixture-refresh-b', expiresAt: NOW + 3_600_001 } });
    const subject = await fixture({ live, resolveProfile: async () => ({ uuid: 'account-b', email: 'b@example.test', organizationUuid: 'org-b' }) });
    const before = await slotCredentials(subject);

    const result = await switchClaude(subject.deps, subject.input);

    assert.equal(result.outcome, 'ok');
    assert.equal(result.outgoingKind, 'foreign-synced');
    assert.equal(result.steps?.unclaimed, 'k9-unclaimed');
    assert.deepEqual(await slotCredentials(subject), before);
    const stored = JSON.parse(await subject.backend.get(unclaimedService(), 'qlb')) as { credential: string };
    assert.equal(stored.credential, live);
    assert.equal(subject.active(), 'account-b');
  });

  it('X21: the unclaimed stash written at step 5 survives an injected step-8 rollback', async () => {
    const live = credential('foreign');
    const subject = await fixture({ live, resolveProfile: async () => ({ uuid: 'account-b', email: 'b@example.test', organizationUuid: 'org-b' }), injectFailStep: 8 });
    const before = await slotCredentials(subject);

    const result = await switchClaude(subject.deps, { ...subject.input, injected: true });

    assert.equal(result.outcome, 'rolled-back');
    assert.equal(result.outgoingKind, undefined);
    assert.deepEqual(await slotCredentials(subject), before);
    const stored = JSON.parse(await subject.backend.get(unclaimedService(), 'qlb')) as { credential: string };
    assert.equal(stored.credential, live);
  });

  it('wiped is still refused outgoing-unrouted:wiped (until K9-2)', async () => {
    const wiped = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: NOW + 3_600_000 } });
    const subject = await fixture({ live: wiped, resolveProfile: async () => null });

    const result = await switchClaude(subject.deps, subject.input);

    assert.equal(result.outcome, 'refused');
    assert.equal(result.reason, 'outgoing-unrouted:wiped');
  });
});
