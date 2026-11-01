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
  const relogins: Record<string, unknown>[] = [];
  const commits: Record<string, unknown>[] = [];
  const deps: ClaudeSwitchDeps = {
    store: {
      getActiveLogin: () => ({ provider: 'anthropic', accountId: active, since: NOW, setBy: 'manual' }),
      getConfig: () => null,
      recordSwitch: (row: Record<string, unknown>) => { rows.push(row); return rows.length; },
      recordRelogin: (row: Record<string, unknown>) => { relogins.push(row); return relogins.length; },
      recordClaudeSwitchRefusal: (row: Record<string, unknown>) => { rows.push(row); return rows.length; },
      findClaudeSwitchByAttempt: () => null,
      commitClaudeSwitch: (row: { toAccount: string; beforeCommit?: () => void }) => { row.beforeCommit?.(); commits.push(row); active = row.toAccount; return commits.length; },
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
  return { backend, slots, paths, deps, accountA, accountB, rows, relogins, commits, active: () => active, input: { to: 'account-b', trigger: 'manual', probeVerdict: options.probeVerdict } };
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

describe('Claude switch classification routing (K9)', () => {
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

  it('X22: the nine kinds route exactly as §4.1 step 5 (table-driven: expected slot write / stash / relogin / nothing per kind)', async () => {
    const wiped = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: NOW + 3_600_000 } });
    const ownFamily = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-a-rotated', refreshToken: 'fixture-refresh-a', expiresAt: NOW + 3_600_000 } });
    const cases = [
      { kind: 'own-bytes', live: credential('a'), resolveProfile: async () => null, action: 'nothing' },
      { kind: 'own-family', live: ownFamily, resolveProfile: async () => null, action: 'slot' },
      { kind: 'own-rotated', live: credential('own-rotated'), resolveProfile: async () => ({ uuid: 'account-a', email: 'a@example.test', organizationUuid: 'org-a' }), action: 'slot' },
      { kind: 'foreign', live: credential('foreign'), resolveProfile: async () => ({ uuid: 'account-b', email: 'b@example.test', organizationUuid: 'org-b' }), action: 'stash' },
      { kind: 'foreign-synced', live: credential('b'), resolveProfile: async () => ({ uuid: 'account-b', email: 'b@example.test', organizationUuid: 'org-b' }), action: 'nothing' },
      { kind: 'wiped', live: wiped, resolveProfile: async () => null, action: 'relogin' },
      { kind: 'alien', live: credential('alien'), resolveProfile: async () => ({ uuid: 'unmanaged', email: 'unmanaged@example.test', organizationUuid: 'org-unmanaged' }), action: 'stash' },
      { kind: 'known-foreign', live: credential('known-foreign'), resolveProfile: async () => { throw new Error('fixture profile unavailable'); }, probeVerdict: false, action: 'stash' },
      { kind: 'unresolved', live: credential('unresolved'), resolveProfile: async () => null, action: 'slot' },
    ] as const;

    for (const scenario of cases) {
      const subject = await fixture(scenario);
      const slotWrites: Array<{ accountId: string; evidence: string | null | undefined }> = [];
      const stashes: string[] = [];
      const writeSlot = subject.slots.writeSlot.bind(subject.slots);
      const stashUnclaimed = subject.slots.stashUnclaimed.bind(subject.slots);
      subject.slots.writeSlot = async (accountId, value, transition) => {
        slotWrites.push({ accountId, evidence: transition.evidence });
        return writeSlot(accountId, value, transition);
      };
      subject.slots.stashUnclaimed = async (timestamp, value, consumedFp, accountId) => {
        stashes.push(timestamp);
        return stashUnclaimed(timestamp, value, consumedFp, accountId);
      };

      const result = await switchClaude(subject.deps, subject.input);

      assert.equal(result.outcome, 'ok', scenario.kind);
      assert.equal(result.outgoingKind, scenario.kind, scenario.kind);
      assert.equal(slotWrites.length, scenario.action === 'slot' ? 1 : 0, scenario.kind);
      assert.equal(stashes.length, scenario.action === 'stash' ? 1 : 0, scenario.kind);
      assert.equal(subject.relogins.length, scenario.action === 'relogin' ? 1 : 0, scenario.kind);
      if (scenario.action === 'slot') assert.equal(slotWrites[0]?.accountId, 'account-a', scenario.kind);
      if (scenario.action === 'relogin') {
        assert.deepEqual(subject.relogins[0], { ts: NOW, provider: 'anthropic', accountId: 'account-a', kind: 'wiped', detail: null, evidence: 'wiped', userDeniedAt: undefined }, scenario.kind);
      }
    }
  });

  it('own-rotated adopts with evidence oracle, own-family with evidence lineage, unresolved with null evidence', async () => {
    const ownFamily = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-a-rotated', refreshToken: 'fixture-refresh-a', expiresAt: NOW + 3_600_000 } });
    const cases = [
      { kind: 'own-rotated', live: credential('own-rotated'), resolveProfile: async () => ({ uuid: 'account-a', email: 'a@example.test', organizationUuid: 'org-a' }), evidence: 'oracle' },
      { kind: 'own-family', live: ownFamily, resolveProfile: async () => null, evidence: 'lineage' },
      { kind: 'unresolved', live: credential('unresolved'), resolveProfile: async () => null, evidence: null },
    ] as const;

    for (const scenario of cases) {
      const subject = await fixture(scenario);
      const writes: Array<{ evidence: string | null | undefined }> = [];
      const writeSlot = subject.slots.writeSlot.bind(subject.slots);
      subject.slots.writeSlot = async (accountId, value, transition) => {
        writes.push({ evidence: transition.evidence });
        return writeSlot(accountId, value, transition);
      };

      const result = await switchClaude(subject.deps, subject.input);

      assert.equal(result.outgoingKind, scenario.kind);
      assert.deepEqual(writes, [{ evidence: scenario.evidence }], scenario.kind);
    }
  });

  it('an empty live item is refused before classification (AC5)', async () => {
    const subject = await fixture({ live: '', resolveProfile: async () => null });
    const writes: string[] = [];
    const writeSlot = subject.slots.writeSlot.bind(subject.slots);
    subject.slots.writeSlot = async (accountId, value, transition) => {
      writes.push(accountId);
      return writeSlot(accountId, value, transition);
    };

    const result = await switchClaude(subject.deps, subject.input);

    assert.deepEqual({ outcome: result.outcome, reason: result.reason, outgoingKind: result.outgoingKind }, { outcome: 'refused', reason: 'live-credential-empty', outgoingKind: undefined });
    assert.deepEqual(writes, []);
    assert.deepEqual(subject.relogins, []);
    assert.deepEqual(subject.commits, []);
  });

  it('switch_log.outgoing_kind records the kind for every outcome that reaches step 5', async () => {
    const wiped = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: NOW + 3_600_000 } });
    const ownFamily = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-a-rotated', refreshToken: 'fixture-refresh-a', expiresAt: NOW + 3_600_000 } });
    const cases = [
      { kind: 'own-bytes', live: credential('a'), resolveProfile: async () => null },
      { kind: 'own-family', live: ownFamily, resolveProfile: async () => null },
      { kind: 'own-rotated', live: credential('own-rotated'), resolveProfile: async () => ({ uuid: 'account-a', email: 'a@example.test', organizationUuid: 'org-a' }) },
      { kind: 'foreign', live: credential('foreign'), resolveProfile: async () => ({ uuid: 'account-b', email: 'b@example.test', organizationUuid: 'org-b' }) },
      { kind: 'foreign-synced', live: credential('b'), resolveProfile: async () => ({ uuid: 'account-b', email: 'b@example.test', organizationUuid: 'org-b' }) },
      { kind: 'wiped', live: wiped, resolveProfile: async () => null },
      { kind: 'alien', live: credential('alien'), resolveProfile: async () => ({ uuid: 'unmanaged', email: 'unmanaged@example.test', organizationUuid: 'org-unmanaged' }) },
      { kind: 'known-foreign', live: credential('known-foreign'), resolveProfile: async () => { throw new Error('fixture profile unavailable'); }, probeVerdict: false },
      { kind: 'unresolved', live: credential('unresolved'), resolveProfile: async () => null },
    ] as const;

    for (const scenario of cases) {
      const subject = await fixture(scenario);
      const result = await switchClaude(subject.deps, subject.input);
      assert.equal(result.outgoingKind, scenario.kind, scenario.kind);
      assert.equal(subject.commits.length, 1, scenario.kind);
      assert.equal(subject.commits[0]?.outgoingKind, scenario.kind, scenario.kind);
    }
  });
});
