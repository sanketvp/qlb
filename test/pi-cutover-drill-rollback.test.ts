// TB-A2 (T-B plan): characterization drill for every rollback branch the live
// Pi provider cutover runbook relies on. Each case runs the real generic
// migration, owner map and gate code on its own fixture (see
// test/support/pi-rollback-scenarios.ts) and asserts the runbook-visible state.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { piAuthBackupPath, writePiAuthBackup } from '../src/pi-auth-backup';
import { platformKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import {
  ANTHROPIC_ENTRY,
  PLACEHOLDER,
  ROLLBACK_SCENARIOS,
  anthropicEntryText,
  createDrillFixture,
  cutOver,
  dropQlbRestoreSources,
  expireQlbGrant,
  gate,
  nativeGrant,
  ownerClaims,
  readJson,
  refusal,
  stageAndRehearse,
  statusJson,
  writeAuthEntry,
  type DrillFixture,
} from './support/pi-rollback-scenarios';

let fx: DrillFixture;

function authEntry(provider: string): unknown {
  return readJson(fx.authJsonPath)[provider];
}

function detail(status: Record<string, unknown>): Record<string, unknown> {
  return status.detail as Record<string, unknown>;
}

function assertPlaceholder(provider: string): void {
  const entry = authEntry(provider) as { access?: unknown; refresh?: unknown };
  assert.equal(entry?.access, 'qlb-managed', `${provider} keeps the placeholder`);
  assert.equal(entry?.refresh, '');
}

function assertAnthropicUntouched(): void {
  assert.equal(anthropicEntryText(fx), JSON.stringify(ANTHROPIC_ENTRY), 'the Anthropic owner entry is unchanged');
  assert.deepEqual(authEntry('anthropic'), PLACEHOLDER, 'the Anthropic auth.json entry is unchanged');
}

beforeEach(() => { fx = createDrillFixture(); });
afterEach(() => { fx.close(); });

describe('TB-A2: Pi provider rollback drill', () => {
  it('(a) xai post-commit after a QLB refresh: Pi gets QLB\'s current grant, NATIVE, cleaned, unclaimed', async () => {
    await cutOver(fx, 'xai');
    expireQlbGrant('xai');
    const served = await gate(fx, 'xai');
    assert.equal(served.code, 0, served.stderr.join('\n'));
    assert.deepEqual(fx.tokenCalls, ['xai']);

    const migration = fx.migration('xai');
    migration.rollback();
    const status = statusJson(migration);

    assert.equal((authEntry('xai') as { access: string }).access, 'xai-qlb-refreshed-access');
    assert.equal((authEntry('xai') as { refresh: string }).refresh, 'xai-qlb-refreshed-refresh');
    assert.equal(status.state, 'NATIVE');
    assert.equal(status.resumeAction, 'nothing to roll back');
    assert.equal(typeof (detail(status).lastRollback as { cleanedAt?: unknown })?.cleanedAt, 'number');
    assert.equal(detail(status).handback, undefined);
    assert.deepEqual(ownerClaims(fx), ['anthropic']);
    assertAnthropicUntouched();
  });

  it('(b) kimi with a newer valid native login keeps it and drops the claim', async () => {
    await cutOver(fx, 'kimi-coding');
    const relogin = nativeGrant('kimi-coding', 'relogin');
    writeAuthEntry(fx, 'kimi-coding', relogin);

    const migration = fx.migration('kimi-coding');
    migration.rollback();

    assert.deepEqual(authEntry('kimi-coding'), relogin);
    assert.equal(statusJson(migration).state, 'NATIVE');
    assert.deepEqual(ownerClaims(fx), ['anthropic']);
    assertAnthropicUntouched();
  });

  it('(c1) xai, first rollback with no usable source: no-restore-source, claim kept, intent journaled; recovery hands back', async () => {
    await cutOver(fx, 'xai');
    const service = qlbKeychainService('xai', 'default');
    const qlbItem = platformKeychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
    dropQlbRestoreSources(fx, 'xai');

    const refused = refusal(() => fx.migration('xai').rollback());
    assert.match(refused.message, /^no-restore-source: /);
    assert.equal(refused.exitCode, 3);
    assert.deepEqual(ownerClaims(fx), ['anthropic', 'xai'], 'the claim is kept');
    assertPlaceholder('xai');
    const after = statusJson(fx.migration('xai'));
    assert.equal(detail(after).intent, 'rollback', 'S1 journaled the intent before refusing');

    platformKeychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, qlbItem);
    expireQlbGrant('xai');
    const served = await gate(fx, 'xai');
    assert.equal(served.code, 1);
    assert.deepEqual(served.stderr, ['credential-unavailable']);
    assert.deepEqual(fx.tokenCalls, [], 'no refresh request is sent');
    dropQlbRestoreSources(fx, 'xai');

    // Runbook recovery: a native Pi /login, then resume.
    const relogin = nativeGrant('xai', 'relogin');
    writeAuthEntry(fx, 'xai', relogin);
    const migration = fx.migration('xai');
    migration.resume();
    const status = statusJson(migration);
    assert.equal(status.state, 'NATIVE');
    assert.equal(typeof (detail(status).lastRollback as { cleanedAt?: unknown })?.cleanedAt, 'number');
    assert.deepEqual(authEntry('xai'), relogin, 'the new native login is kept');
    assert.deepEqual(ownerClaims(fx), ['anthropic']);
    assertAnthropicUntouched();
  });

  it('(c2) xai, S3 with no source: native-entry-missing, markers journaled, gate refresh refused; recovery hands back', async () => {
    await cutOver(fx, 'xai');
    const service = qlbKeychainService('xai', 'default');
    const qlbItem = platformKeychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
    dropQlbRestoreSources(fx, 'xai');
    writeAuthEntry(fx, 'xai', nativeGrant('xai', 'relogin'));
    const migration = fx.migration('xai', {
      // The valid native login that S2 ranked disappears before S3.
      afterStep: (point) => { if (point === 'S2') writeAuthEntry(fx, 'xai', PLACEHOLDER); },
    });

    const refused = refusal(() => migration.rollback());
    assert.equal(refused.message, 'native-entry-missing');
    assert.equal(refused.exitCode, 3);
    assert.deepEqual(ownerClaims(fx), ['anthropic', 'xai'], 'the claim is kept');
    assertPlaceholder('xai');
    const after = detail(statusJson(fx.migration('xai')));
    assert.equal(after.intent, 'rollback');
    assert.ok(after.rollbackDecision, 'S2 journaled its decision');

    // S2's generation fence and the rollback markers prevent a refresh even
    // with QLB's item restored. TB-A1a shows the same near-expiry grant
    // refreshes when no marker or fence is present.
    platformKeychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, qlbItem);
    expireQlbGrant('xai');
    const served = await gate(fx, 'xai');
    assert.equal(served.code, 1);
    assert.deepEqual(served.stderr, ['credential-unavailable']);
    assert.deepEqual(fx.tokenCalls, [], 'no refresh request is sent');

    const relogin2 = nativeGrant('xai', 'relogin2');
    writeAuthEntry(fx, 'xai', relogin2);
    const recovery = fx.migration('xai');
    recovery.resume();
    assert.equal(statusJson(recovery).state, 'NATIVE');
    assert.deepEqual(authEntry('xai'), relogin2);
    assert.deepEqual(ownerClaims(fx), ['anthropic']);
    assertAnthropicUntouched();
  });

  it('(d) an intentionally absent entry stays absent', async () => {
    await cutOver(fx, 'xai');
    writeAuthEntry(fx, 'xai', undefined);
    // The commit backup now records an absent entry (as when Pi had no xai login at commit).
    writePiAuthBackup(fx.authJsonPath, 'xai', 'tb-a2-absent');

    const migration = fx.migration('xai');
    migration.rollback();

    assert.equal(Object.hasOwn(readJson(fx.authJsonPath), 'xai'), false);
    assert.equal(statusJson(migration).state, 'NATIVE');
    assert.deepEqual(ownerClaims(fx), ['anthropic']);
    assertAnthropicUntouched();
  });

  it('(e) an invalid native entry: native-entry-invalid, claim kept, and the gate refuses at once', async () => {
    await cutOver(fx, 'xai');
    writeAuthEntry(fx, 'xai', { type: 'oauth', access: 'broken' });

    const refused = refusal(() => fx.migration('xai').rollback());
    assert.equal(refused.message, 'native-entry-invalid');
    assert.equal(refused.exitCode, 3);
    assert.deepEqual(ownerClaims(fx), ['anthropic', 'xai']);
    const served = await gate(fx, 'xai');
    assert.notEqual(served.code, 0);
    assert.ok(served.stderr.includes('placeholder-missing'), served.stderr.join('\n'));
    assertAnthropicUntouched();
  });

  it('(f) a crash at S5 leaves handback pending; resume cleans it', async () => {
    await cutOver(fx, 'kimi-coding');
    const crashing = fx.migration('kimi-coding', {
      afterStep: (point) => { if (point === 'S5') throw new Error('crash at S5'); },
    });
    assert.throws(() => crashing.rollback(), /crash at S5/);
    const pending = statusJson(fx.migration('kimi-coding'));
    assert.equal(pending.state, 'NATIVE');
    assert.ok(detail(pending).handback, 'handback is observable only after a crash');

    const migration = fx.migration('kimi-coding');
    migration.resume();
    const status = statusJson(migration);
    assert.equal(detail(status).handback, undefined);
    assert.equal(typeof (detail(status).lastRollback as { cleanedAt?: unknown })?.cleanedAt, 'number');
    assertAnthropicUntouched();
  });

  it('(g) openrouter: QLB copies deleted, claim removed, VALIDATED; re-stage → commit reaches QLB_OWNED', async () => {
    await cutOver(fx, 'openrouter');
    const migration = fx.migration('openrouter');
    migration.rollback();
    const status = statusJson(migration);

    assert.equal(status.state, 'VALIDATED');
    assert.equal(detail(status).rolledBackFrom, 'post-commit');
    assert.equal(status.resumeAction, 'noop');
    assert.deepEqual(ownerClaims(fx), ['anthropic']);
    assert.throws(() => platformKeychain.getSync(qlbKeychainService('openrouter', 'default'), QLB_KEYCHAIN_ACCOUNT));

    await cutOver(fx, 'openrouter');
    assert.equal(statusJson(fx.migration('openrouter')).state, 'QLB_OWNED');
    assert.equal((await gate(fx, 'openrouter')).code, 0);
    assertAnthropicUntouched();
  });

  for (const provider of ['xai', 'kimi-coding', 'openrouter'] as const) {
    it(`(h) ${provider} pre-commit rollback from VALIDATED: NATIVE, Pi auth.json untouched, QLB item gone`, async () => {
      const before = readJson(fx.authJsonPath);
      const migration = fx.migration(provider);
      await stageAndRehearse(migration);
      migration.rollback();

      assert.equal(statusJson(migration).state, 'NATIVE');
      assert.deepEqual(readJson(fx.authJsonPath), before);
      assert.deepEqual(ownerClaims(fx), ['anthropic']);
      assert.throws(() => platformKeychain.getSync(qlbKeychainService(provider, 'default'), QLB_KEYCHAIN_ACCOUNT));
      assertAnthropicUntouched();
    });
  }

  it('(i) resume from a staged VALIDATED completes the commit', async () => {
    const migration = fx.migration('xai');
    const validated = await stageAndRehearse(migration);
    assert.equal(validated.resumeAction, 'rehearsal succeeded; complete commit');
    migration.resume();
    assert.equal(statusJson(migration).state, 'QLB_OWNED');
    assert.deepEqual(ownerClaims(fx), ['anthropic', 'xai']);
    assertAnthropicUntouched();
  });

  it('(j) stage overwrites an occupied QLB item and pre-commit rollback deletes it', async () => {
    const service = qlbKeychainService('xai', 'default');
    platformKeychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, JSON.stringify({ unrelated: 'pre-existing' }));
    const migration = fx.migration('xai');
    migration.stage();
    assert.doesNotMatch(platformKeychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), /pre-existing/, 'stage overwrote it');
    migration.rollback();
    assert.throws(() => platformKeychain.getSync(service, QLB_KEYCHAIN_ACCOUNT), 'pre-commit rollback deleted it');
    assert.equal(existsSync(piAuthBackupPath(fx.authJsonPath, 'xai')), false);
    assertAnthropicUntouched();
  });

  it('builds every runbook rollback end state from the shared scenarios', async () => {
    for (const scenario of ROLLBACK_SCENARIOS) {
      fx.close();
      fx = createDrillFixture();
      const status = await scenario.run(fx);
      const stateDetail = detail(status);
      switch (scenario.branch) {
        case 'post-commit-single-grant':
          assert.equal(status.state, 'NATIVE', scenario.name);
          assert.equal(status.resumeAction, 'nothing to roll back', scenario.name);
          assert.equal(typeof (stateDetail.lastRollback as { cleanedAt?: unknown })?.cleanedAt, 'number', scenario.name);
          assert.equal(stateDetail.handback, undefined, scenario.name);
          break;
        case 'post-commit-openrouter':
          assert.equal(status.state, 'VALIDATED', scenario.name);
          assert.equal(stateDetail.rolledBackFrom, 'post-commit', scenario.name);
          assert.equal(status.resumeAction, 'noop', scenario.name);
          break;
        case 'pre-commit':
          assert.equal(status.state, 'NATIVE', scenario.name);
          assert.equal(stateDetail.rolledBackFrom, 'pre-commit', scenario.name);
          break;
        case 'refusal':
          assert.equal(stateDetail.intent, 'rollback', scenario.name);
          assert.ok(stateDetail.rollbackDecision, scenario.name);
          break;
      }
      assertAnthropicUntouched();
    }
  });
});
