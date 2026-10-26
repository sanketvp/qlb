import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KIMI_USAGE_URL,
  probeKimiCodingUsage,
} from '../src/usage/kimi-coding';
import {
  createKimiCodingSource,
  registerKimiCodingProvider,
} from '../extensions/qlb-pi/providers/kimi-coding';

describe('qlb-pi Kimi Coding source', () => {
  it('uses the per-request QLB gate result and rejects malformed gate output', async () => {
    const source = createKimiCodingSource({
      gate: async () => ({
        code: 0,
        stdout: JSON.stringify({ token: 'kimi-test-access', accountId: 'default', source: 'keychain' }),
        stderr: '',
      }),
    });
    assert.deepEqual(await source.read(), {
      token: 'kimi-test-access', accountId: 'default', source: 'keychain',
    });

    const malformed = createKimiCodingSource({
      gate: async () => ({ code: 0, stdout: '{', stderr: '' }),
    });
    await assert.rejects(malformed.read(), /unknown/);
  });

  it('registers only when owned and sends each request through the gate', async () => {
    const calls: string[] = [];
    let registered: { api: string; streamSimple: (model: { id: string; api: string; provider: string }, context: unknown, options?: Record<string, unknown>) => { events: unknown[]; ended: boolean } } | undefined;
    const pi = {
      unregisterProvider: (name: string) => calls.push(`unregister:${name}`),
      registerProvider: (_name: string, config: typeof registered) => { registered = config; },
    };
    let gates = 0;
    let output: { events: unknown[]; ended: boolean; push(event: unknown): void; end(): void } | undefined;
    registerKimiCodingProvider(pi as never, {
      owned: () => true,
      createStream: () => {
        output = { events: [], ended: false, push(event: unknown) { this.events.push(event); }, end() { this.ended = true; } };
        return output;
      },
      builtin: (_model, _context, options) => {
        assert.equal(options?.apiKey, 'kimi-test-access');
        return (async function* () { yield { type: 'done' }; })();
      },
      gate: async () => {
        gates += 1;
        return { code: 0, stdout: JSON.stringify({ token: 'kimi-test-access', accountId: 'default', source: 'keychain' }), stderr: '' };
      },
    });
    assert.deepEqual(calls, ['unregister:kimi-coding']);
    assert.ok(registered);

    registered!.streamSimple({ id: 'k3', api: 'openai-completions', provider: 'kimi-coding' }, {}, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gates, 1);
    assert.deepEqual(output?.events, [{ type: 'done' }]);
    assert.equal(output?.ended, true);
  });

  it('fails closed when the gate refuses and leaves an unowned provider untouched', async () => {
    const calls: string[] = [];
    registerKimiCodingProvider({
      unregisterProvider: (name: string) => calls.push(`unregister:${name}`),
      registerProvider: (name: string) => calls.push(`register:${name}`),
    }, { owned: () => false });
    assert.deepEqual(calls, []);

    let registered: { streamSimple: (model: { id: string }, context: unknown) => unknown } | undefined;
    let output: { events: unknown[]; ended: boolean; push(event: unknown): void; end(): void } | undefined;
    registerKimiCodingProvider({
      unregisterProvider: () => undefined,
      registerProvider: (_name, config) => { registered = config as never; },
    }, {
      owned: () => true,
      createStream: () => {
        output = { events: [], ended: false, push(event: unknown) { this.events.push(event); }, end() { this.ended = true; } };
        return output;
      },
      gate: async () => ({ code: 1, stdout: '', stderr: 'store-open-failed' }),
    });
    registered!.streamSimple({ id: 'k3' }, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((output?.events[0] as { error?: { errorMessage?: string } }).error?.errorMessage, 'QLB unavailable for kimi-coding — run qlb doctor (store-open-failed)');
    assert.equal(output?.ended, true);
  });

  it('probes the documented bearer endpoint through an injected fetch', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const result = await probeKimiCodingUsage({
      access: 'kimi-test-access',
      fetchFn: async (url, init) => {
        request = { url, init };
        return new Response('{"usage":{}}', { status: 200 });
      },
    });
    assert.equal(request?.url, KIMI_USAGE_URL);
    assert.deepEqual(request?.init?.headers, { Authorization: 'Bearer kimi-test-access' });
    assert.deepEqual(result, { status: 200, source: 'kimi-api', keys: ['usage'] });
  });
});
