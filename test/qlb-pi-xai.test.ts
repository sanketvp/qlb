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

function fakePi(): XaiProviderApi & { providers: Map<string, (model: { id: string; provider?: unknown }, context: unknown, options?: Record<string, unknown>) => unknown> } {
  const providers = new Map<string, (model: { id: string; provider?: unknown }, context: unknown, options?: Record<string, unknown>) => unknown>();
  providers.set('xai', () => { throw new Error('native fallback used'); });
  return {
    providers,
    unregisterProvider(name) { providers.delete(name); },
    registerProvider(name, config) { providers.set(name, config.streamSimple); },
  };
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
    const builtin: XaiBuiltin = (_model, _context, options) => {
      keys.push(options.apiKey);
      return (async function* () {
        yield { type: 'text_delta', delta: 'ok' };
      })();
    };

    registerXaiProvider(pi, builtin, {
      createStream: () => output,
      gate: async () => ({ token: 'fixture-xai-access', accountId: 'default', source: 'keychain' }),
    });
    const stream = pi.providers.get('xai')!({ id: 'grok-code-fast-1', provider: 'xai' }, {}, {}) as typeof output;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(stream, output);
    assert.deepEqual(keys, ['fixture-xai-access']);
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
    pi.providers.get('xai')!({ id: 'grok-code-fast-1', provider: 'xai' }, {}, {});
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(called, false);
    assert.equal(output.ended, true);
    assert.equal((output.events[0] as { error: { errorMessage: string } }).error.errorMessage,
      'QLB unavailable for xai — run qlb doctor (unknown)');
    assert.equal(JSON.stringify(output.events).includes('fixture-xai-access'), false);
  });
});
