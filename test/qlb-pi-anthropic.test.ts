import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAnthropicSource,
  type GateRunner,
} from '../extensions/qlb-pi/providers/anthropic';

function gateResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: 'fixture-access-token',
    accountId: 'claude-slot-a',
    expiresAt: 1_800_000_000_000,
    source: 'qlb-gate',
    ...overrides,
  });
}

function runner(result: { code?: number; stdout?: string; stderr?: string } = {}): {
  run: GateRunner;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    run: async (provider) => {
      calls.push(provider);
      return { code: result.code ?? 0, stdout: result.stdout ?? gateResponse(), stderr: result.stderr };
    },
  };
}

describe('qlb-pi Anthropic source', () => {
  it('calls only the anthropic gate and preserves its structured access result', async () => {
    const gate = runner();
    const source = createAnthropicSource({ runGate: gate.run });

    assert.equal(source.provider, 'anthropic');
    assert.deepEqual(await source.read(), {
      token: 'fixture-access-token',
      accountId: 'claude-slot-a',
      expiresAt: 1_800_000_000_000,
      source: 'qlb-gate',
    });
    assert.deepEqual(gate.calls, ['anthropic']);
  });

  it('fails closed for a failed, malformed, or incomplete gate result without exposing gate output', async () => {
    const cases = [
      runner({ code: 3, stdout: '{"token":"must-not-leak"}' }).run,
      runner({ stdout: 'not-json' }).run,
      runner({ stdout: gateResponse({ accountId: '' }) }).run,
      runner({ stdout: gateResponse({ source: undefined }) }).run,
      runner({ stdout: gateResponse({ expiresAt: Number.POSITIVE_INFINITY }) }).run,
    ];

    for (const runGate of cases) {
      await assert.rejects(
        createAnthropicSource({ runGate }).read(),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : '';
          assert.match(message, /^QLB gate anthropic unavailable$/);
          assert.doesNotMatch(message, /must-not-leak/);
          return true;
        },
      );
    }
  });

  it('retains a stable gate failure cause without exposing gate output', async () => {
    const source = createAnthropicSource({
      runGate: runner({ code: 3, stdout: '{"token":"must-not-leak"}', stderr: 'owner-entry-missing\n' }).run,
    });
    await assert.rejects(source.read(), (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : '', 'QLB gate anthropic unavailable');
      assert.equal((error as { causeCode?: unknown }).causeCode, 'owner-entry-missing');
      return true;
    });
  });

  it('fails closed when the injected process boundary rejects', async () => {
    const source = createAnthropicSource({
      runGate: async () => { throw new Error('process detail must not escape'); },
    });
    await assert.rejects(source.read(), (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : '', 'QLB gate anthropic unavailable');
      return true;
    });
  });
});
