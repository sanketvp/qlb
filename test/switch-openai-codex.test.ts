import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import {
  createSwitchOpenAiCodexCommand,
  type SwitchOpenAiCodexCommandDeps,
} from '../src/commands/switch-openai-codex';
import { resolveCodexAuthPath } from '../src/commands/codex-import-active';
import { switchCodex, type CodexSwitchDeps, type CodexSwitchResult } from '../src/codex-switch';
import { discoverCommands, type CommandContext } from '../src/registry';

const DISABLED = "qlb switch openai-codex is not enabled yet: it turns on together with QLB's background checks (C8).";
const FENCE = 'Codex switch recovery needs you (slot-split): log in to Codex with the account you want (codex login), then run qlb codex import-active. QLB finishes the recovery at its next check.';

function context(): { ctx: CommandContext; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const home = '/tmp/qlb-switch-openai-codex-command';
  return {
    stdout, stderr,
    ctx: {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
      env: { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: join(home, 'qlb') },
      config: defaultConfig(home), loadConfig: () => defaultConfig(home), home,
      registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    },
  };
}

function result(overrides: Partial<CodexSwitchResult> = {}): CodexSwitchResult {
  const { from = 'a:account', ...rest } = overrides;
  return { outcome: 'ok', from, switchId: 71, watch: { state: 'pending', until: 1_700_000_300_000 }, ...rest };
}

function subject(overrides: Partial<SwitchOpenAiCodexCommandDeps> = {}) {
  const store = { getCodexActiveLogin: () => 'a:account', close: () => {} };
  return createSwitchOpenAiCodexCommand({
    enabled: true,
    openStore: () => store as never,
    makeSwitchDeps: async () => ({}) as CodexSwitchDeps,
    switchCodex: async () => result(),
    listCodexOldAccountSessions: async () => [],
    codexOldAccountLine: (_from, session) => `old ${session.pid}`,
    now: () => 1_700_000_000_000,
    ...overrides,
  });
}

describe('qlb switch openai-codex command (C6-24)', () => {
  it('wiring lists switch openai-codex', () => {
    assert.ok(discoverCommands().some((command) => command.name === 'switch openai-codex'));
  });

  it('the production default prints the not-enabled text, exits 3, and writes nothing', async () => {
    let opened = 0;
    const command = createSwitchOpenAiCodexCommand({ openStore: () => { opened += 1; throw new Error('must not open'); } });
    const run = context();
    assert.equal(await command.execute!(['b:account'], run.ctx), 3);
    assert.equal(opened, 0);
    assert.deepEqual(run.stdout, []);
    assert.deepEqual(run.stderr, [DISABLED]);
  });

  it('enabled: qlb switch openai-codex <B> --json prints outcome ok and exits 0', async () => {
    const run = context();
    assert.equal(await subject().execute!(['b:account', '--json'], run.ctx), 0);
    assert.deepEqual(JSON.parse(run.stdout[0]), {
      outcome: 'ok', from: 'a:account', to: 'b:account', switchId: 71,
      watch: { state: 'pending', until: 1_700_000_300_000 }, lockLostAfterCommit: false, oldAccountPids: [],
    });
  });

  it('enabled: a revert at a foreground tick exits 1 and names the old-account pids', async () => {
    const command = subject({
      switchCodex: async () => result({ outcome: 'reverted-by-codex', watch: { state: 'stopped', reason: 'reverted-by-codex' } }),
      listCodexOldAccountSessions: async () => [{ pid: 42, host: 'codex', identities: ['a:account'], ambiguous: false }],
      codexOldAccountLine: (from, session) => `Codex running on old account ${from}: pid ${session.pid} (codex) — restart`,
    });
    const run = context();
    assert.equal(await command.execute!(['b:account'], run.ctx), 1);
    assert.match(run.stdout.join('\n'), /Codex reverted the switch at /);
    assert.match(run.stdout.join('\n'), /1 sessions on old account/);
    assert.match(run.stdout.join('\n'), /pid 42/);
  });

  it('enabled: a fence exits 3 with the recovery message', async () => {
    const run = context();
    assert.equal(await subject({ switchCodex: async () => result({ outcome: 'refused', reason: 'slot-split', message: FENCE }) })
      .execute!(['b:account'], run.ctx), 3);
    assert.deepEqual(run.stderr, [FENCE]);
  });

  it('enabled: a post-publish unresolved result exits 3 with the recovery message', async () => {
    const run = context();
    assert.equal(await subject({ switchCodex: async () => result({ outcome: 'failed', reason: 'slot-split', message: FENCE }) })
      .execute!(['b:account'], run.ctx), 3);
    assert.deepEqual(run.stderr, [FENCE]);
  });

  it('enabled: an unresolved foreground tick exits 3 with the recovery message', async () => {
    const run = context();
    assert.equal(await subject({ switchCodex: async () => result({ watch: { state: 'unresolved', reason: 'slot-split' } }) })
      .execute!(['b:account'], run.ctx), 3);
    assert.deepEqual(run.stderr, [FENCE]);
  });

  it('uses the engine-recorded source after recovery in text and JSON output', async () => {
    const switchedAfterRecovery = result({ from: 'recovered:account' });
    const text = context();
    assert.equal(await subject({ switchCodex: async () => switchedAfterRecovery }).execute!(['b:account'], text.ctx), 0);
    assert.deepEqual(text.stdout, ['Codex switch recovered:account → b:account: ok', 'QLB keeps checking until 2023-11-14T22:18:20.000Z']);

    const json = context();
    assert.equal(await subject({ switchCodex: async () => switchedAfterRecovery }).execute!(['b:account', '--json'], json.ctx), 0);
    assert.equal(JSON.parse(json.stdout[0]).from, 'recovered:account');
  });

  it('shows the specific admission refusal code', async () => {
    const run = context();
    const command = subject({
      switchCodex,
      makeSwitchDeps: () => ({
        store: { getCodexActiveLogin: () => 'a:account' },
        admitted: () => ({ ok: false, code: 'specific-admission-code' }),
      } as unknown as CodexSwitchDeps),
    });
    assert.equal(await command.execute!(['b:account'], run.ctx), 3);
    assert.deepEqual(run.stdout, ['Codex switch a:account → b:account: refused: specific-admission-code']);
  });

  it('prints safe failed and refused reasons and reports a post-commit lock loss', async () => {
    const failed = context();
    assert.equal(await subject({ switchCodex: async () => result({ outcome: 'failed', reason: 'commit-failed', watch: undefined }) })
      .execute!(['b:account'], failed.ctx), 1);
    assert.deepEqual(failed.stdout, ['Codex switch a:account → b:account: failed: commit-failed']);

    const refused = context();
    assert.equal(await subject({ switchCodex: async () => result({ outcome: 'refused', reason: 'specific-admission-code', watch: undefined }) })
      .execute!(['b:account'], refused.ctx), 3);
    assert.deepEqual(refused.stdout, ['Codex switch a:account → b:account: refused: specific-admission-code']);

    const lockLost = context();
    assert.equal(await subject({ switchCodex: async () => result({ lockLostAfterCommit: true }) }).execute!(['b:account'], lockLost.ctx), 1);
    assert.ok(lockLost.stdout.includes('the switch committed, but its lock was lost afterwards; run qlb status'));
  });

  it('unknown flags exit 2', async () => {
    const run = context();
    assert.equal(await subject().execute!(['b:account', '--unknown'], run.ctx), 2);
  });

  it('--trigger proactive exits 2', async () => {
    const run = context();
    assert.equal(await subject().execute!(['b:account', '--trigger', 'proactive'], run.ctx), 2);
  });

  it('auth path: CODEX_HOME wins, else the configured path, else the default', () => {
    const configured = '/configured/auth.json';
    assert.equal(resolveCodexAuthPath({ CODEX_HOME: '/codex-home' }, { codexAuthJsonPath: configured } as never), '/codex-home/auth.json');
    assert.equal(resolveCodexAuthPath({}, { codexAuthJsonPath: configured } as never), configured);
    assert.equal(resolveCodexAuthPath({}, {} as never), join(process.env.HOME ?? '', '.codex', 'auth.json'));
  });

  it('command output contains no token value', async () => {
    const secret = 'fixture-super-secret-token-value';
    const run = context();
    assert.equal(await subject({ switchCodex: async () => result({ reason: secret, message: undefined }) }).execute!(['b:account', '--json'], run.ctx), 0);
    assert.equal([...run.stdout, ...run.stderr].join('\n').includes(secret), false);
  });
});
