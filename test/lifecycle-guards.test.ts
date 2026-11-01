import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { claudePaths } from '../src/cc-paths';
import { withClaudeSwitchLock } from '../src/cc-locks';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { AdmissionRefused, switchClaude, type ClaudeSwitchDeps } from '../src/cc-switch';
import { createSwitchAnthropicCommand, type SwitchAnthropicCommandDeps } from '../src/commands/switch-anthropic';
import { defaultConfig } from '../src/config';
import { MockKeychain } from '../src/keychain';
import { beginCutover, transition, type LifecycleState } from '../src/lifecycle';
import type { CommandContext, CommandDefinition } from '../src/registry';
import { openStore } from '../src/store';

const NOW = 1_000_000;

type Fixture = {
  command: CommandDefinition;
  ctx: CommandContext;
  stdout: string[];
  stderr: string[];
  lockCalls: () => number;
};

function credential(tag: string): string {
  return JSON.stringify({ claudeAiOauth: {
    accessToken: `fixture-access-${tag}`,
    refreshToken: `fixture-refresh-${tag}`,
    expiresAt: NOW + 60 * 60_000,
  } });
}

function setLifecycle(store: ReturnType<typeof openStore>, state: LifecycleState): void {
  if (state === 'pre-cutover') return;
  beginCutover(store, NOW);
  if (state === 'cutting-over') return;
  if (state === 'aborted') {
    assert.equal(transition(store, 'aborted', NOW).ok, true);
    return;
  }
  assert.equal(transition(store, 'cutover', NOW).ok, true);
  if (state === 'cutover') return;
  if (state === 'retired') {
    assert.equal(transition(store, 'retired', NOW).ok, true);
    return;
  }
  assert.equal(transition(store, 'undoing', NOW).ok, true);
  if (state === 'undoing') return;
  assert.equal(transition(store, 'rolled-back', NOW).ok, true);
}

async function fixture(
  state: LifecycleState,
  overrides: Partial<SwitchAnthropicCommandDeps> = {},
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'qlb-lifecycle-guards-'));
  const home = join(root, 'home');
  const env = { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: join(root, 'qlb') };
  const config = defaultConfig(home);
  mkdirSync(home, { recursive: true });
  const store = openStore(config.dbPath);
  setLifecycle(store, state);

  const paths = claudePaths({ home, env });
  mkdirSync(paths.configHome, { recursive: true });
  writeFileSync(paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } })}\n`);
  const backend = new MockKeychain();
  const outgoing = credential('a');
  await backend.set(paths.keychainService, 'fixture-user', outgoing);
  store.setActiveLogin('anthropic', 'account-a', 'manual', NOW);

  let calls = 0;
  const switchLock: typeof withClaudeSwitchLock = (fn, options) => {
    calls += 1;
    return withClaudeSwitchLock(fn, options);
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: CommandContext = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env,
    config,
    loadConfig: () => config,
    home,
    registerSecret: () => {},
    deliverSecret: () => {},
    knownSecrets: () => [],
  };
  const command = createSwitchAnthropicCommand({
    openStore: () => store,
    makeSwitchDeps: async (_ctx, commandStore, warn) => {
      const repository = SqliteClaudeSlotRepository.open(commandStore.dbPath);
      const slots = new ClaudeSlots({ backend, repository, stashDir: join(root, 'unclaimed'), now: () => NOW });
      try {
        await slots.createSlot({
          accountId: 'account-a', credential: outgoing, email: 'a@example.test', orgUuid: 'org-a',
          configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }), source: 'cswap-import',
        });
        await slots.createSlot({
          accountId: 'account-b', credential: credential('b'), email: 'b@example.test', orgUuid: 'org-b',
          configJson: JSON.stringify({ oauthAccount: { accountUuid: 'account-b' } }), source: 'cswap-import',
        });
        return {
          deps: {
            store: commandStore as ClaudeSwitchDeps['store'],
            slots,
            live: { backend, paths, account: 'fixture-user' },
            readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
            resolveProfile: async () => null,
            consume: { postRefresh: async () => ({ status: 500, body: '' }) },
            env,
            home,
            now: () => NOW,
            by: 'qlb-cli',
            attempt: `lifecycle-${state}`,
            journalOwner: { pid: process.pid, lstart: 'fixture' },
            locks: { switch: switchLock },
            warn,
          },
          close: () => repository.close(),
        };
      } catch (error) {
        repository.close();
        throw error;
      }
    },
    switchClaude,
    ...overrides,
  });
  return { command, ctx, stdout, stderr, lockCalls: () => calls };
}

async function execute(subject: Fixture, args = ['account-b']): Promise<number> {
  return subject.command.execute!(args, subject.ctx);
}

describe('Claude switch lifecycle guards (K5-8)', () => {
  it('switch anthropic is refused in pre-cutover before any lock', async () => {
    const subject = await fixture('pre-cutover');
    assert.equal(await execute(subject), 3);
    assert.equal(subject.lockCalls(), 0);
    assert.deepEqual(subject.stderr, ['qlb switch anthropic: refused: phase=pre-cutover']);
  });

  it('switch anthropic --trigger manual succeeds in cutting-over', async () => {
    const subject = await fixture('cutting-over');
    assert.equal(await execute(subject, ['account-b', '--trigger', 'manual']), 0, `${subject.stdout.join('\n')}\n${subject.stderr.join('\n')}`);
    assert.equal(subject.lockCalls(), 1);
  });

  it('switch anthropic manual succeeds in cutover and retired', async () => {
    for (const state of ['cutover', 'retired'] as const) {
      const subject = await fixture(state);
      assert.equal(await execute(subject), 0, `${state}: ${subject.stdout.join('\n')}\n${subject.stderr.join('\n')}`);
      assert.equal(subject.lockCalls(), 1, state);
    }
  });

  it('switch anthropic manual is refused in undoing, rolled-back and aborted', async () => {
    for (const state of ['undoing', 'rolled-back', 'aborted'] as const) {
      const subject = await fixture(state);
      assert.equal(await execute(subject), 3, state);
      assert.equal(subject.lockCalls(), 0, state);
    }
  });

  it('an admission refusal stops before journal reconciliation', async () => {
    const events: string[] = [];
    const subject = await fixture('cutting-over', {
      assertAdmitted: () => ({ ok: false, code: 'phase=pre-cutover' }),
      bootstrap: async (hooks) => {
        try {
          await hooks?.assertAdmitted?.();
        } catch (error) {
          assert.ok(error instanceof AdmissionRefused);
          events.push('admission-refused');
          throw error;
        }
        await hooks?.reconcileJournals?.();
      },
      reconcileJournals: async () => { events.push('reconcile'); },
    });
    assert.equal(await execute(subject), 3);
    assert.deepEqual(events, ['admission-refused']);
    assert.equal(subject.lockCalls(), 0);
  });

  it('admission precedes journal reconciliation', async () => {
    const events: string[] = [];
    const subject = await fixture('cutting-over', {
      assertAdmitted: () => { events.push('admitted'); return { ok: true }; },
      reconcileJournals: async () => { events.push('reconcile'); },
    });
    assert.equal(await execute(subject), 0, `${subject.stdout.join('\n')}\n${subject.stderr.join('\n')}`);
    assert.deepEqual(events, ['admitted', 'reconcile']);
  });
});
