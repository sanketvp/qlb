import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createOpenRouterStream,
  registerOpenRouterSource,
  type GateRun,
  type OpenRouterTransport,
} from '../extensions/qlb-pi/providers/openrouter';
import openRouterGate, { read as readOpenRouterGate } from '../src/gate/openrouter';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { OPENROUTER_CREDITS_URL, probeOpenRouterUsage } from '../src/usage/openrouter';

class Events implements AsyncIterable<unknown> {
  readonly values: unknown[] = [];
  ended = false;

  push(value: unknown): void { this.values.push(value); }
  end(): void { this.ended = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> { yield* this.values; }
}

function model(): { id: string; api: string; provider: string } {
  return { id: 'z-ai/glm-5.3', api: 'openai-completions', provider: 'openrouter' };
}

function ownedOwner(): string {
  return JSON.stringify({ providers: { openrouter: { mode: 'qlb', since: 1 } } });
}

function readAll(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  return (async () => {
    const values: unknown[] = [];
    for await (const value of stream) values.push(value);
    return values;
  })();
}

describe('qlb-pi OpenRouter source', () => {
  it('obtains one ephemeral key through qlb gate and delegates only to the built-in transport', async () => {
    const outputs: Events[] = [];
    const calls: string[][] = [];
    const run: GateRun = async (args, env) => {
      calls.push(args);
      assert.equal(env.QLB_PI_TOKEN_CALL, '1');
      return { code: 0, stdout: JSON.stringify({ token: 'fixture-openrouter-key', accountId: 'default', source: 'keychain' }), stderr: '' };
    };
    let sentKey: unknown;
    const transport: OpenRouterTransport = (_model, _context, options) => {
      sentKey = options?.apiKey;
      const events = new Events();
      events.push({ type: 'done', reason: 'stop' });
      events.end();
      return events;
    };
    const stream = createOpenRouterStream({ run, transport, createStream: () => {
      const output = new Events();
      outputs.push(output);
      return output;
    } });

    const result = stream(model(), { messages: [] });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [['gate', 'openrouter', '--json']]);
    assert.equal(sentKey, 'fixture-openrouter-key');
    assert.deepEqual(await readAll(result), [{ type: 'done', reason: 'stop' }]);
    assert.equal(outputs[0]?.ended, true);
  });

  it('fails closed when qlb gate fails or returns a malformed envelope', async () => {
    for (const result of [
      { code: 1, stdout: '', stderr: 'credential-unavailable' },
      { code: 0, stdout: JSON.stringify({ token: '', accountId: 'default', source: 'keychain' }), stderr: '' },
    ]) {
      let transports = 0;
      const stream = createOpenRouterStream({
        run: async () => result,
        transport: () => { transports += 1; return new Events(); },
        createStream: () => new Events(),
      });
      const output = stream(model(), { messages: [] });
      await new Promise((resolve) => setImmediate(resolve));
      const [event] = await readAll(output) as Array<{ error?: { errorMessage?: string } }>;
      assert.equal(transports, 0);
      assert.equal(event?.error?.errorMessage, 'QLB unavailable for openrouter — run qlb doctor (unknown)');
      assert.equal(JSON.stringify(event).includes('fixture-openrouter-key'), false);
    }
  });

  it('registers only an owned provider and replaces a malformed owner with a fail-closed source', async () => {
    const calls: string[] = [];
    let config: { streamSimple: ReturnType<typeof createOpenRouterStream> } | undefined;
    const pi = {
      unregisterProvider: (name: string) => calls.push(`unregister:${name}`),
      registerProvider: (name: string, next: { streamSimple: ReturnType<typeof createOpenRouterStream> }) => {
        calls.push(`register:${name}`);
        config = next;
      },
    };
    const deps = {
      ownerPath: '/fixture/qlb-owner.json',
      readOwner: () => ownedOwner(),
      run: async () => ({ code: 0, stdout: JSON.stringify({ token: 'fixture-openrouter-key', accountId: 'default', source: 'keychain' }), stderr: '' }),
      transport: () => new Events(),
      createStream: () => new Events(),
    };

    assert.equal(registerOpenRouterSource(pi, deps), true);
    assert.deepEqual(calls, ['unregister:openrouter', 'register:openrouter']);
    assert.ok(config);

    calls.length = 0;
    assert.equal(registerOpenRouterSource(pi, { ...deps, readOwner: () => undefined }), false);
    assert.deepEqual(calls, []);

    assert.equal(registerOpenRouterSource(pi, { ...deps, readOwner: () => '{' }), true);
    assert.deepEqual(calls, ['unregister:openrouter', 'register:openrouter']);
    const output = config!.streamSimple(model(), { messages: [] });
    await new Promise((resolve) => setImmediate(resolve));
    const [event] = await readAll(output) as Array<{ error?: { errorMessage?: string } }>;
    assert.equal(event?.error?.errorMessage, 'QLB unavailable for openrouter — run qlb doctor (owner-file-malformed)');
  });
});

describe('OpenRouter gate and usage', () => {
  it('reads only the QLB-owned default credential and never refreshes', () => {
    const keychain = new MockKeychain();
    keychain.setSync(
      qlbKeychainService('openrouter', 'default'),
      QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify({ type: 'api-key', access: 'fixture-openrouter-key' }),
    );

    assert.deepEqual(readOpenRouterGate({ keychain }), {
      token: 'fixture-openrouter-key', accountId: 'default', source: 'keychain',
    });
    assert.deepEqual(openRouterGate.read({ keychain }), {
      token: 'fixture-openrouter-key', accountId: 'default', source: 'keychain',
    });
    assert.throws(() => readOpenRouterGate({ keychain: new MockKeychain() }), /credential unavailable/);
  });

  it('probes credits through an injected fetch and returns metadata rather than the body', async () => {
    const requests: Array<{ input: string; authorization: string | null }> = [];
    const result = await probeOpenRouterUsage({
      resolve: () => ({ token: 'fixture-openrouter-key', accountId: 'default', source: 'keychain' }),
      fetchFn: async (input, init) => {
        requests.push({ input, authorization: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify({ data: { total_credits: 100, total_usage: 25 } }), { status: 200 });
      },
    });

    assert.deepEqual(requests, [{ input: OPENROUTER_CREDITS_URL, authorization: 'Bearer fixture-openrouter-key' }]);
    assert.deepEqual(result, { status: 200, source: 'credits', keys: ['data'], usedPct: 25 });
    assert.equal(JSON.stringify(result).includes('fixture-openrouter-key'), false);
  });

  it('does not make a network request when its QLB-owned credential is unavailable', async () => {
    let calls = 0;
    const result = await probeOpenRouterUsage({
      resolve: () => { throw new Error('credential unavailable'); },
      fetchFn: async () => { calls += 1; return new Response('{}'); },
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, { status: null, source: 'unknown', keys: [] });
  });
});
