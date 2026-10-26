import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  composeOpenRouterModels,
  createOpenRouterStream,
  readOpenRouterModelsJson,
  registerOpenRouterSource,
  type GateRun,
  type OpenRouterTransport,
} from '../extensions/qlb-pi/providers/openrouter';
import openRouterGate, { read as readOpenRouterGate } from '../src/gate/openrouter';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { OPENROUTER_CREDITS_URL, probeOpenRouterUsage } from '../src/usage/openrouter';
import { piIntegrationChecks } from '../src/pi-integration';

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
      { code: 1, stdout: '', stderr: 'store-open-failed' },
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
      const cause = result.code === 0 ? 'unknown' : 'store-open-failed';
      assert.equal(event?.error?.errorMessage, `QLB unavailable for openrouter — run qlb doctor (${cause})`);
      assert.equal(JSON.stringify(event).includes('fixture-openrouter-key'), false);
    }
  });

  it('keeps models.json OpenRouter models, overrides, and provider baseUrl in the gated catalog', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-openrouter-models-'));
    const modelsJson = join(root, 'models.json');
    writeFileSync(modelsJson, `{
      // Pi accepts JSONC models.json files.
      "providers": { "openrouter": {
        "baseUrl": "https://regional.openrouter.example/api/v1",
        "models": [{ "id": "custom", "name": "Custom", "contextWindow": 1000, "maxTokens": 100, }],
        "modelOverrides": { "builtin": { "name": "Overridden", "contextWindow": 200 } },
      } },
    }`);
    const models = composeOpenRouterModels([
      {
        id: 'builtin', name: 'Builtin', api: 'openai-completions', provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1', reasoning: false, input: ['text'],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100, maxTokens: 10,
      },
    ], readOpenRouterModelsJson(modelsJson));

    assert.deepEqual(models.map((entry) => ({
      id: entry.id, name: entry.name, baseUrl: entry.baseUrl, contextWindow: entry.contextWindow, api: entry.api,
    })), [
      { id: 'builtin', name: 'Overridden', baseUrl: 'https://regional.openrouter.example/api/v1', contextWindow: 200, api: 'openai-completions' },
      { id: 'custom', name: 'Custom', baseUrl: 'https://regional.openrouter.example/api/v1', contextWindow: 1000, api: 'openai-completions' },
    ]);
  });

  it('keeps the fail-closed registration when a provider registration rejects asynchronously', async () => {
    const configs: Array<{ models: unknown[] }> = [];
    const pi = {
      unregisterProvider: () => {},
      registerProvider: (_name: string, config: any) => {
        configs.push(config);
        return configs.length === 1 ? Promise.resolve() : Promise.reject(new Error('deferred validation failed'));
      },
    };
    const registered = await registerOpenRouterSource(pi, {
      ownerPath: '/fixture/qlb-owner.json', readOwner: () => ownedOwner(),
      models: [{ id: 'valid', api: 'openai-completions', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }],
      transport: () => new Events(), createStream: () => new Events(),
    });

    assert.equal(registered, true);
    assert.deepEqual(configs.map((config) => config.models), [[], [{ id: 'valid', api: 'openai-completions', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }]]);
  });

  it('registers an owned provider for the OpenAI API family and normalizes every chat model through the gate', async () => {
    const calls: string[] = [];
    let config: any;
    const pi = {
      unregisterProvider: (name: string) => { calls.push(`unregister:${name}`); },
      registerProvider: (name: string, next: { streamSimple: ReturnType<typeof createOpenRouterStream> }) => {
        calls.push(`register:${name}`);
        config = next;
      },
    };
    let gateCalls = 0;
    const deps = {
      ownerPath: '/fixture/qlb-owner.json',
      models: [
        { id: 'openai-model', api: 'openai-completions', provider: 'openrouter' },
        { id: 'anthropic-model', api: 'anthropic-messages', provider: 'openrouter' },
      ],
      readOwner: () => ownedOwner(),
      run: async () => {
        gateCalls += 1;
        return { code: 0, stdout: JSON.stringify({ token: 'fixture-openrouter-key', accountId: 'default', source: 'keychain' }), stderr: '' };
      },
      transport: () => new Events(),
      createStream: () => new Events(),
    };

    assert.equal(await registerOpenRouterSource(pi, deps), true);
    assert.deepEqual(calls, ['unregister:openrouter', 'register:openrouter', 'register:openrouter']);
    assert.ok(config);
    assert.equal(config.api, 'openai-completions');
    assert.deepEqual(config.models.map((entry: { api: string }) => entry.api), ['openai-completions', 'openai-completions']);
    config.streamSimple(config.models[1], { messages: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gateCalls, 1);

    calls.length = 0;
    assert.equal(await registerOpenRouterSource(pi, { ...deps, readOwner: () => undefined }), false);
    assert.deepEqual(calls, []);

    assert.equal(await registerOpenRouterSource(pi, { ...deps, readOwner: () => '{' }), true);
    assert.deepEqual(calls, ['unregister:openrouter', 'register:openrouter']);
    const output = config!.streamSimple(model(), { messages: [] });
    await new Promise((resolve) => setImmediate(resolve));
    const [event] = await readAll(output) as Array<{ error?: { errorMessage?: string } }>;
    assert.equal(event?.error?.errorMessage, 'QLB unavailable for openrouter — run qlb doctor (owner-file-malformed)');
    assert.equal(config.api, 'openai-completions');
  });

  it('removes caller authorization headers before applying the QLB gate credential', async () => {
    let sent: Record<string, unknown> | undefined;
    const stream = createOpenRouterStream({
      run: async () => ({ code: 0, stdout: JSON.stringify({ token: 'fixture-openrouter-key', accountId: 'default', source: 'keychain' }), stderr: '' }),
      transport: (_model, _context, options) => {
        sent = options;
        const output = new Events();
        output.end();
        return output;
      },
      createStream: () => new Events(),
    });

    stream(model(), {}, { headers: { Authorization: 'stored-native-key', 'x-api-key': 'stored-native-key', keep: 'yes' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent?.apiKey, 'fixture-openrouter-key');
    assert.deepEqual(sent?.headers, { keep: 'yes' });
  });
});

describe('Pi deployed extension drift', () => {
  it('reports a changed nested provider module', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-pi-provider-drift-'));
    const extensionDir = join(root, 'agent', 'extensions', 'qlb-pi');
    const redactDir = join(root, 'agent', 'src');
    mkdirSync(join(root, 'agent', 'extensions'), { recursive: true });
    mkdirSync(redactDir, { recursive: true });
    cpSync(join(process.cwd(), 'extensions', 'qlb-pi'), extensionDir, { recursive: true });
    cpSync(join(process.cwd(), 'src', 'redact.ts'), join(redactDir, 'redact.ts'));
    writeFileSync(join(extensionDir, 'providers', 'openrouter.ts'), 'changed\n');
    writeFileSync(join(extensionDir, 'providers', 'stale.ts'), 'stale\n');

    const checks = piIntegrationChecks({
      extensionDir,
      pi: { root: join(root, 'pi-package'), unresolved: false },
    });
    const extension = checks.find((check) => check.name === 'pi:extension');
    assert.equal(extension?.level, 'WARN');
    assert.match(extension?.message ?? '', /providers\/openrouter\.ts/);
    assert.match(extension?.message ?? '', /providers\/stale\.ts/);
    assert.equal((extension?.detail as { fix?: string } | undefined)?.fix, 'qlb pi deploy');
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
        assert.ok(init?.signal);
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
