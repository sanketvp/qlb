import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  faultInjectionEnabled,
  injectionDetail,
  parseInjectFlag,
} from '../src/fault-injection';
import { runAutoCommand } from '../src/commands/auto';
import { createSwitchAnthropicCommand } from '../src/commands/switch-anthropic';
import type { CommandContext } from '../src/registry';

function usageContext(enabled: boolean): { ctx: CommandContext; stderr: string[] } {
  const stderr: string[] = [];
  const ctx: CommandContext = {
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
    env: enabled ? { QLB_FAULT_INJECTION: '1' } : {},
    config: {} as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); },
    home: '/nonexistent-qlb-usage-test',
    registerSecret: () => undefined,
    deliverSecret: () => undefined,
    knownSecrets: () => [],
  };
  return { ctx, stderr };
}

describe('fault injection flags', () => {
  it('--inject fail-step 8 with QLB_FAULT_INJECTION=1 parses to step 8 and strips the flag', () => {
    const parsed = parseInjectFlag(['account-a', '--inject', 'fail-step', '8', '--json'], {
      QLB_FAULT_INJECTION: '1',
    });

    assert.deepEqual(parsed, {
      rest: ['account-a', '--json'],
      inject: { kind: 'fail-step', step: 8 },
    });
  });

  it('the flag without the env is a usage error', () => {
    assert.deepEqual(
      parseInjectFlag(['--inject', 'fail-step', '7'], {}),
      { usage: 'usage: --inject <fail-step <7|8|9>|usage-5xx anthropic|breaker-rows anthropic> requires QLB_FAULT_INJECTION=1' },
    );
    assert.equal(faultInjectionEnabled({}), false);
  });

  it('every injection form without the env has the same usage error', () => {
    const expected = { usage: 'usage: --inject <fail-step <7|8|9>|usage-5xx anthropic|breaker-rows anthropic> requires QLB_FAULT_INJECTION=1' };
    assert.deepEqual(parseInjectFlag(['--inject', 'fail-step', '7'], {}), expected);
    assert.deepEqual(parseInjectFlag(['--inject', 'usage-5xx', 'anthropic'], {}), expected);
    assert.deepEqual(parseInjectFlag(['--inject', 'breaker-rows', 'anthropic'], {}), expected);
  });

  it('a bad step with the env set does not mention the env', () => {
    const parsed = parseInjectFlag(['--inject', 'fail-step', '6'], { QLB_FAULT_INJECTION: '1' });

    assert.ok('usage' in parsed);
    assert.doesNotMatch(parsed.usage, /QLB_FAULT_INJECTION/);
  });

  it('a repeated --inject is a usage error', () => {
    assert.ok(
      'usage' in parseInjectFlag(
        ['--inject', 'fail-step', '8', '--inject', 'fail-step', '9'],
        { QLB_FAULT_INJECTION: '1' },
      ),
    );
  });

  it('--inject=fail-step is a usage error', () => {
    assert.ok('usage' in parseInjectFlag(['--inject=fail-step', '8'], { QLB_FAULT_INJECTION: '1' }));
  });

  it('--inject usage-5xx anthropic parses with the env', () => {
    assert.deepEqual(
      parseInjectFlag(['account-a', '--inject', 'usage-5xx', 'anthropic', '--json'], { QLB_FAULT_INJECTION: '1' }),
      { rest: ['account-a', '--json'], inject: { kind: 'usage-5xx', provider: 'anthropic' } },
    );
  });

  it('--inject breaker-rows anthropic parses with the env', () => {
    assert.deepEqual(
      parseInjectFlag(['account-a', '--inject', 'breaker-rows', 'anthropic', '--json'], { QLB_FAULT_INJECTION: '1' }),
      { rest: ['account-a', '--json'], inject: { kind: 'breaker-rows', provider: 'anthropic' } },
    );
  });

  it('--inject usage-5xx openai-codex is a usage error', () => {
    assert.deepEqual(
      parseInjectFlag(['--inject', 'usage-5xx', 'openai-codex'], { QLB_FAULT_INJECTION: '1' }),
      { usage: 'usage: --inject <fail-step <7|8|9>|usage-5xx anthropic|breaker-rows anthropic>' },
    );
  });

  it('no flag parses to null and leaves args unchanged', () => {
    const args = ['account-a', '--json'];

    assert.deepEqual(parseInjectFlag(args, { QLB_FAULT_INJECTION: '1' }), {
      rest: args,
      inject: null,
    });
  });

  it('injectionDetail spells fault-injection:fail-step-<n>', () => {
    assert.equal(injectionDetail({ kind: 'fail-step', step: 9 }), 'fault-injection:fail-step-9');
  });

  it('injectionDetail spells fault-injection:usage-5xx and fault-injection:breaker-rows', () => {
    assert.equal(injectionDetail({ kind: 'usage-5xx', provider: 'anthropic' }), 'fault-injection:usage-5xx');
    assert.equal(injectionDetail({ kind: 'breaker-rows', provider: 'anthropic' }), 'fault-injection:breaker-rows');
  });

  describe('per-command usage text (TC-5)', () => {
    const notUsed = async (): Promise<never> => { throw new Error('must not run past flag parsing'); };

    it('switch anthropic usage lists only fail-step', async () => {
      const command = createSwitchAnthropicCommand({ openStore: notUsed as never });
      const disabled = usageContext(false);
      assert.equal(await command.execute!(['account-b', '--inject', 'fail-step', '7'], disabled.ctx), 2);
      assert.deepEqual(disabled.stderr, ['usage: --inject fail-step <7|8|9> requires QLB_FAULT_INJECTION=1']);

      const enabled = usageContext(true);
      assert.equal(await command.execute!(['account-b', '--inject', 'fail-step', '6'], enabled.ctx), 2);
      assert.deepEqual(enabled.stderr, ['usage: --inject fail-step <7|8|9>']);
    });

    it('auto usage lists only usage-5xx and breaker-rows', async () => {
      const deps = { acquireFlock: notUsed, runAuto: notUsed } as never;
      const disabled = usageContext(false);
      assert.equal(await runAutoCommand(['--once', '--inject', 'usage-5xx', 'anthropic'], disabled.ctx, deps), 2);
      assert.deepEqual(disabled.stderr, ['usage: --inject <usage-5xx anthropic|breaker-rows anthropic> requires QLB_FAULT_INJECTION=1']);

      const enabled = usageContext(true);
      assert.equal(await runAutoCommand(['--once', '--inject', 'usage-5xx', 'openai-codex'], enabled.ctx, deps), 2);
      assert.deepEqual(enabled.stderr, ['usage: --inject <usage-5xx anthropic|breaker-rows anthropic>']);
    });

    it('the accepted forms change only the text, not what parses', () => {
      const env = { QLB_FAULT_INJECTION: '1' };
      assert.deepEqual(
        parseInjectFlag(['--inject', 'usage-5xx', 'anthropic'], env, ['fail-step']),
        { rest: [], inject: { kind: 'usage-5xx', provider: 'anthropic' } },
      );
      assert.deepEqual(
        parseInjectFlag(['--inject', 'fail-step', '9'], env, ['usage-5xx', 'breaker-rows']),
        { rest: [], inject: { kind: 'fail-step', step: 9 } },
      );
    });
  });
});
