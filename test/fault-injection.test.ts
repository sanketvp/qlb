import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  faultInjectionEnabled,
  injectionDetail,
  parseInjectFlag,
} from '../src/fault-injection';

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
});
