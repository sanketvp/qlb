import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AutoAdmissionRefused, runAuto } from '../src/auto';
import { claudePaths } from '../src/cc-paths';
import { withClaudeSwitchLock } from '../src/cc-locks';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { switchClaude, type ClaudeSwitchDeps } from '../src/cc-switch';
import { runAutoCommand } from '../src/commands/auto';
import { createSwitchAnthropicCommand, type SwitchAnthropicCommandDeps } from '../src/commands/switch-anthropic';
import { defaultConfig } from '../src/config';
import { MockKeychain } from '../src/keychain';
import { assertAdmitted, beginCutover, transition, type LifecycleState } from '../src/lifecycle';
import type { CommandContext, CommandDefinition } from '../src/registry';
import { openStore } from '../src/store';
import { credential as buildCredential, twoSlotFixture } from './support/claude-fixtures';

const NOW = 1_000_000;

type Fixture = {
  command: CommandDefinition;
  ctx: CommandContext;
  stdout: string[];
  stderr: string[];
  lockCalls: () => number;
};

const credential = (tag: string): string => buildCredential(tag, {
  accessToken: `fixture-access-${tag}`,
  refreshToken: `fixture-refresh-${tag}`,
  expiresAt: NOW + 60 * 60_000,
});

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
        const [first, second] = twoSlotFixture(outgoing, credential('b'));
        await slots.createSlot(first);
        await slots.createSlot(second);
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
  it('admits import-journal reconcile and its non-dry-run preview only during cutting-over or cutover', () => {
    for (const state of ['pre-cutover', 'cutting-over', 'cutover', 'undoing', 'rolled-back', 'retired', 'aborted'] as const) {
      const store = openStore(':memory:');
      try {
        setLifecycle(store, state);
        for (const operation of ['import-cswap:reconcile', 'import-cswap:reconcile-preview'] as const) {
          assert.equal(assertAdmitted(store, operation).ok, state === 'cutting-over' || state === 'cutover', `${state} ${operation}`);
        }
      } finally {
        store.close();
      }
    }
  });

  it('auto refused outside cutover and retired', async () => {
    for (const code of ['phase=pre-cutover', 'phase=rolled-back'] as const) {
      let bindingOpened = false;
      const lines: string[] = [];
      await assert.rejects(runAuto({ once: true }, {
        makeLiveBinding: () => {
          bindingOpened = true;
          return {
            store: { setConfig: () => { throw new Error('heartbeat must not write'); } }, close: () => {},
            reconcile: async () => { throw new Error('reconcile must not run'); },
            poll: async () => { throw new Error('poll must not run'); },
            tick: async () => { throw new Error('tick must not run'); },
          };
        },
        assertAdmitted: () => ({ ok: false, code }),
        listCswapProcesses: () => [],
        log: (line) => lines.push(line),
      }), (error: unknown) => error instanceof AutoAdmissionRefused && error.code === code);
      assert.equal(bindingOpened, true);
      assert.deepEqual(lines, []);
    }
  });

  it('auto resume is refused in pre-cutover, cutting-over and undoing', async () => {
    const cases = [
      ['pre-cutover', 'phase=pre-cutover'],
      ['cutting-over', 'phase=cutting-over'],
      ['undoing', 'undo-in-progress'],
    ] as const;
    for (const [state, code] of cases) {
      const subject = await fixture(state);
      assert.equal(await runAutoCommand(['resume', 'anthropic'], subject.ctx), 3, state);
      assert.deepEqual(subject.stderr, [`qlb auto resume: refused: ${code}`], state);
      assert.equal(subject.lockCalls(), 0, state);
    }
  });

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
    const cases = [
      ['undoing', 'undo-in-progress'],
      ['rolled-back', 'phase=rolled-back'],
      ['aborted', 'phase=aborted'],
    ] as const;
    for (const [state, code] of cases) {
      const subject = await fixture(state);
      assert.equal(await execute(subject), 3, state);
      assert.equal(subject.lockCalls(), 0, state);
      assert.deepEqual(subject.stderr, [`qlb switch anthropic: refused: ${code}`], state);
    }
  });

  it('an admission refusal stops before journal reconciliation', async () => {
    let reconcileCalls = 0;
    const subject = await fixture('cutting-over', {
      assertAdmitted: () => ({ ok: false, code: 'phase=pre-cutover' }),
      reconcileJournals: async () => { reconcileCalls += 1; },
    });
    assert.equal(await execute(subject), 3);
    assert.equal(reconcileCalls, 0);
    assert.equal(subject.lockCalls(), 0);
    assert.deepEqual(subject.stderr, ['qlb switch anthropic: refused: phase=pre-cutover']);
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

  it('auto admission precedes reconciliation before polling or switching', async () => {
    const events: string[] = [];
    await runAuto({ once: true }, {
      makeLiveBinding: () => ({
        store: { setConfig: () => {} }, close: () => {},
        reconcile: async () => { events.push('reconcile'); },
        poll: async () => { events.push('poll'); return []; },
        tick: async () => {
          events.push('switch');
          return { decision: { kind: 'stay', reason: 'unknown', unhealthyTicks: 0 } };
        },
      }),
      assertAdmitted: () => { events.push('admitted'); return { ok: true }; },
      listCswapProcesses: () => [], log: () => {},
    });
    assert.deepEqual(events, ['admitted', 'reconcile', 'poll', 'switch']);
  });
});
