import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createOpenAICodexSource,
  openAICodexHeaders,
  registerOpenAICodexProvider,
  type GateRunner,
} from '../extensions/qlb-pi/providers/openai-codex';

const compositeId = 'chatgpt-user:codex-account';
const chatgptAccountId = 'codex-account';

function gateResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: 'fixture-access-token',
    accountId: compositeId,
    chatgptAccountId,
    expiresAt: 1_800_000_000_000,
    source: 'qlb-gate',
    ...overrides,
  });
}

function runner(result: { code?: number; stdout?: string } = {}): {
  run: GateRunner;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    run: async (provider) => {
      calls.push(provider);
      return { code: result.code ?? 0, stdout: result.stdout ?? gateResponse() };
    },
  };
}

describe('qlb-pi OpenAI Codex source', () => {
  it('calls only the openai-codex gate and preserves its structured access result', async () => {
    const gate = runner();
    const source = createOpenAICodexSource({ runGate: gate.run });

    assert.equal(source.provider, 'openai-codex');
    assert.deepEqual(await source.read(), {
      token: 'fixture-access-token',
      accountId: compositeId,
      chatgptAccountId,
      expiresAt: 1_800_000_000_000,
      source: 'qlb-gate',
    });
    assert.deepEqual(gate.calls, ['openai-codex']);
  });

  it('uses the bare chatgptAccountId for ChatGPT-Account-Id, never the composite QLB slot id', async () => {
    const source = createOpenAICodexSource({ runGate: runner().run });
    const headers = openAICodexHeaders(await source.read());

    assert.deepEqual(headers, {
      Authorization: 'Bearer fixture-access-token',
      'ChatGPT-Account-Id': chatgptAccountId,
    });
    assert.notEqual(headers['ChatGPT-Account-Id'], compositeId);
  });

  it('surfaces each safe gate failure cause once and never invokes transport', async () => {
    const causes = [
      'missing-binary',
      'store-open-failed',
      'owner-file-malformed',
      'identity-mismatch',
      'auth-json-unstable',
      'refresh-failed',
      'phase=pre-cutover',
      'undo-in-progress',
      'codex-token-expired-renewer-idle',
    ];

    for (const cause of causes) {
      let transports = 0;
      const events: unknown[] = [];
      let registered: { streamSimple: (model: { id: string }, context: unknown) => unknown } | undefined;
      registerOpenAICodexProvider({
        unregisterProvider() {},
        registerProvider(provider) { registered = provider; },
      }, () => {
        transports += 1;
        return (async function* () {})();
      }, {
        createStream: () => ({ push(event: unknown) { events.push(event); }, end() {} }),
        runGate: async () => cause === 'missing-binary'
          ? Promise.reject(Object.assign(new Error('not displayed'), { code: 'ENOENT' }))
          : { code: 1, stdout: '', stderr: cause },
      });

      registered!.streamSimple({ id: 'gpt-5' }, {});
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(transports, 0, cause);
      assert.equal(events.length, 1, cause);
      assert.equal((events[0] as { error: { errorMessage: string } }).error.errorMessage,
        `QLB unavailable for openai-codex — run qlb doctor (${cause})`);
    }
  });

  it('maps an unparseable gate cause to unknown and never invokes transport', async () => {
    let transports = 0;
    const events: unknown[] = [];
    let registered: { streamSimple: (model: { id: string }, context: unknown) => unknown } | undefined;
    registerOpenAICodexProvider({
      unregisterProvider() {},
      registerProvider(provider) { registered = provider; },
    }, () => {
      transports += 1;
      return (async function* () {})();
    }, {
      createStream: () => ({ push(event: unknown) { events.push(event); }, end() {} }),
      runGate: async () => ({ code: 1, stdout: '', stderr: 'raw failure detail must not escape' }),
    });

    registered!.streamSimple({ id: 'gpt-5' }, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transports, 0);
    assert.equal(events.length, 1);
    assert.equal((events[0] as { error: { errorMessage: string } }).error.errorMessage,
      'QLB unavailable for openai-codex — run qlb doctor (unknown)');
  });

  it('fails closed for a failed, malformed, or incomplete gate result', async () => {
    const cases = [
      runner({ code: 3, stdout: '{"token":"must-not-leak"}' }).run,
      runner({ stdout: 'not-json' }).run,
      runner({ stdout: gateResponse({ chatgptAccountId: undefined }) }).run,
      runner({ stdout: gateResponse({ accountId: '' }) }).run,
    ];

    for (const runGate of cases) {
      await assert.rejects(
        createOpenAICodexSource({ runGate }).read(),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : '';
          assert.match(message, /^QLB gate openai-codex unavailable$/);
          assert.doesNotMatch(message, /must-not-leak/);
          return true;
        },
      );
    }
  });
});
