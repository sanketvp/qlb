import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createXaiAccessSource,
  createXaiGate,
  registerXaiProvider,
  type XaiBuiltin,
  type XaiEventSink,
  type XaiProviderApi,
} from '../extensions/qlb-pi/providers/xai';

function sink(): XaiEventSink & { events: unknown[]; ended: boolean } {
  const output = {
    events: [] as unknown[],
    ended: false,
    push(event: unknown) { output.events.push(event); },
    end() { output.ended = true; },
  };
  return output;
}

type RegisteredProvider = {
  api: string;
  streamSimple: (model: { id: string; api?: unknown; provider?: unknown }, context: unknown, options?: Record<string, unknown>) => unknown;
};

function fakePi(): XaiProviderApi & { providers: Map<string, RegisteredProvider> } {
  const providers = new Map<string, RegisteredProvider>();
  providers.set('xai', {
    api: 'openai-responses',
    streamSimple: () => { throw new Error('native fallback used'); },
  });
  return {
    providers,
    unregisterProvider(name) { providers.delete(name); },
    registerProvider(name, config) { providers.set(name, config); },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('qlb-pi xai provider source', () => {
  it('runs qlb gate xai --json and keeps the gate envelope narrow', async () => {
    let calls = 0;
    const gate = createXaiGate(async (args) => {
      assert.deepEqual(args, ['gate', 'xai', '--json']);
      return {
        code: 0,
        stdout: JSON.stringify({
          token: 'fixture-xai-access',
          accountId: 'default',
          expiresAt: 4_102_444_800_000,
          source: 'keychain',
          refresh: 'must-not-cross-the-source-boundary',
        }),
      };
    });
    const source = createXaiAccessSource(async () => {
      calls += 1;
      return gate();
    });
    assert.deepEqual(await source.read(), {
      token: 'fixture-xai-access',
      accountId: 'default',
      expiresAt: 4_102_444_800_000,
      source: 'keychain',
    });
    assert.equal(calls, 1);
  });

  it('replaces the native provider, obtains access through qlb gate, and forwards only that access to the xAI transport', async () => {
    const pi = fakePi();
    const output = sink();
    const keys: unknown[] = [];
    const headers: unknown[] = [];
    const builtin: XaiBuiltin = (_model, _context, options) => {
      keys.push(options.apiKey);
      headers.push(options.headers);
      return (async function* () {
        yield { type: 'text_delta', delta: 'ok' };
      })();
    };

    registerXaiProvider(pi, builtin, {
      createStream: () => output,
      gate: async () => ({ token: 'fixture-xai-access', accountId: 'default', source: 'keychain' }),
    });
    const registered = pi.providers.get('xai')!;
    // Pi dispatches extension streamSimple only when the model and registration APIs match.
    assert.equal(registered.api, 'openai-responses');
    const stream = registered.streamSimple({ id: 'grok-4.6', api: 'openai-responses', provider: 'xai' }, {}, {
      headers: { Authorization: 'fixture-stored-credential', 'x-request-id': 'fixture-request' },
    }) as typeof output;
    await flush();

    assert.equal(stream, output);
    assert.deepEqual(keys, ['fixture-xai-access']);
    assert.deepEqual(headers, [{ 'x-request-id': 'fixture-request' }]);
    assert.deepEqual(output.events, [{ type: 'text_delta', delta: 'ok' }]);
    assert.equal(output.ended, true);
  });

  it('fails closed when qlb gate rejects and never calls the native transport', async () => {
    const pi = fakePi();
    const output = sink();
    let called = false;
    const builtin: XaiBuiltin = () => {
      called = true;
      return (async function* () {})();
    };

    registerXaiProvider(pi, builtin, {
      createStream: () => output,
      gate: async () => { throw new Error('fixture-xai-access must not leak'); },
    });
    pi.providers.get('xai')!.streamSimple({ id: 'grok-4.6', api: 'openai-responses', provider: 'xai' }, {}, {});
    await flush();

    assert.equal(called, false);
    assert.equal(output.ended, true);
    assert.equal((output.events[0] as { error: { errorMessage: string } }).error.errorMessage,
      'QLB unavailable for xai — run qlb doctor (unknown)');
    assert.equal(JSON.stringify(output.events).includes('fixture-xai-access'), false);
  });

  it('shows a safe gate cause instead of discarding gate stderr', async () => {
    const pi = fakePi();
    const output = sink();
    const gate = createXaiGate(async () => ({
      code: 3,
      stdout: '',
      stderr: 'provider-not-applicable\n',
    } as never));

    registerXaiProvider(pi, () => (async function* () {})(), {
      createStream: () => output,
      gate,
    });
    pi.providers.get('xai')!.streamSimple({ id: 'grok-4.6', api: 'openai-responses' }, {}, {});
    await flush();

    assert.equal((output.events[0] as { error: { errorMessage: string } }).error.errorMessage,
      'QLB unavailable for xai — run qlb doctor (provider-not-applicable)');
    assert.equal(output.ended, true);
  });

  it('passes Pi cancellation to the gate and fails closed on cancellation', async () => {
    const pi = fakePi();
    const output = sink();
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let builtinCalled = false;

    registerXaiProvider(pi, () => {
      builtinCalled = true;
      return (async function* () {})();
    }, {
      createStream: () => output,
      gate: async (signal?: AbortSignal) => {
        received = signal;
        await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('cancelled');
      },
    });
    pi.providers.get('xai')!.streamSimple(
      { id: 'grok-4.6', api: 'openai-responses' },
      {},
      { signal: controller.signal },
    );
    controller.abort();
    await flush();

    assert.equal(received, controller.signal);
    assert.equal(builtinCalled, false);
    assert.equal(output.ended, true);
  });

  it('does not relabel a transport exception as a QLB gate failure', async () => {
    const pi = fakePi();
    const output = sink();
    registerXaiProvider(pi, () => (async function* () {
      yield { type: 'text_delta', delta: 'before-error' };
      throw new Error('transport failure');
    })(), {
      createStream: () => output,
      gate: async () => ({ token: 'fixture-xai-access', accountId: 'default', source: 'keychain' }),
    });
    pi.providers.get('xai')!.streamSimple({ id: 'grok-4.6', api: 'openai-responses' }, {}, {});
    await flush();

    assert.deepEqual(output.events, [{ type: 'text_delta', delta: 'before-error' }]);
    assert.equal(output.ended, true);
  });
});
