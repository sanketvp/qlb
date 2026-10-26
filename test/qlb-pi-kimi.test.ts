import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('preserves a lifecycle refusal cause from the QLB gate', async () => {
    const source = createKimiCodingSource({
      gate: async () => ({ code: 3, stdout: '', stderr: 'qlb gate: refused: phase=pre-cutover' }),
    });
    await assert.rejects(source.read(), /phase=pre-cutover/);
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
        assert.deepEqual(options?.headers, {
          'X-Trace': 'preserved',
          Authorization: 'Bearer kimi-test-access',
        });
        return (async function* () { yield { type: 'done' }; })();
      },
      gate: async () => {
        gates += 1;
        return { code: 0, stdout: JSON.stringify({ token: 'kimi-test-access', accountId: 'default', source: 'keychain' }), stderr: '' };
      },
    });
    assert.deepEqual(calls, ['unregister:kimi-coding']);
    assert.ok(registered);

    registered!.streamSimple({ id: 'k3', api: 'openai-completions', provider: 'kimi-coding' }, {}, {
      headers: {
        Authorization: 'Bearer qlb-managed',
        authorization: 'Bearer native-login',
        'X-Trace': 'preserved',
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gates, 1);
    assert.deepEqual(output?.events, [{ type: 'done' }]);
    assert.equal(output?.ended, true);
  });

  it('rechecks ownership before every request and does not fall through after rollback', async () => {
    let owned = true;
    let gates = 0;
    let transportCalls = 0;
    let registered: { streamSimple: (model: { id: string }, context: unknown) => unknown } | undefined;
    const outputs: Array<{ events: unknown[]; ended: boolean; push(event: unknown): void; end(): void }> = [];
    registerKimiCodingProvider({
      unregisterProvider: () => undefined,
      registerProvider: (_name, config) => { registered = config as never; },
    }, {
      owned: () => owned,
      createStream: () => {
        const output = { events: [] as unknown[], ended: false, push(event: unknown) { this.events.push(event); }, end() { this.ended = true; } };
        outputs.push(output);
        return output;
      },
      gate: async () => {
        gates += 1;
        return { code: 0, stdout: JSON.stringify({ token: 'kimi-test-access', accountId: 'default', source: 'keychain' }), stderr: '' };
      },
      builtin: () => {
        transportCalls += 1;
        return (async function* () { yield { type: 'done' }; })();
      },
    });
    assert.ok(registered);

    registered!.streamSimple({ id: 'k3' }, {});
    await new Promise((resolve) => setImmediate(resolve));
    owned = false;
    registered!.streamSimple({ id: 'k3' }, {});
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(gates, 1);
    assert.equal(transportCalls, 1);
    assert.equal((outputs[1]!.events[0] as { error?: { errorMessage?: string } }).error?.errorMessage, 'QLB unavailable for kimi-coding — run qlb doctor (unknown)');
    assert.equal(outputs[1]!.ended, true);
  });

  it('ends an aborted pending gate request as aborted and terminates its gate process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-kimi-abort-'));
    const fixture = join(dir, 'gate.js');
    const started = join(dir, 'started');
    const terminated = join(dir, 'terminated');
    writeFileSync(fixture, `
      const { writeFileSync } = require('node:fs');
      writeFileSync(${JSON.stringify(started)}, '');
      process.on('SIGTERM', () => {
        writeFileSync(${JSON.stringify(terminated)}, '');
        process.exit(0);
      });
      setInterval(() => {}, 1_000);
    `);
    const previousCli = process.env.QLB_CLI;
    process.env.QLB_CLI = fixture;
    try {
      let registered: { streamSimple: (model: { id: string }, context: unknown, options?: Record<string, unknown>) => unknown } | undefined;
      let output: { events: unknown[]; ended: boolean; push(event: unknown): void; end(): void } | undefined;
      registerKimiCodingProvider({
        unregisterProvider: () => undefined,
        registerProvider: (_name, config) => { registered = config as never; },
      }, {
        owned: () => true,
        createStream: () => {
          output = { events: [] as unknown[], ended: false, push(event: unknown) { this.events.push(event); }, end() { this.ended = true; } };
          return output;
        },
      });
      assert.ok(registered);

      const controller = new AbortController();
      registered.streamSimple({ id: 'k3' }, {}, { signal: controller.signal });
      // A loaded CI runner can take well over 500ms to start a node child; wait up to 10s.
      for (let tries = 0; !existsSync(started) && tries < 1_000; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(existsSync(started), true);
      controller.abort();
      // The stream ends on the gate child's close event, which can land after the child
      // writes its terminated marker, so wait for both.
      for (let tries = 0; !(existsSync(terminated) && output?.ended) && tries < 1_000; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(existsSync(terminated), true);
      assert.equal(output?.ended, true);
      assert.equal((output?.events[0] as { reason?: string }).reason, 'aborted');
      assert.equal((output?.events[0] as { error?: { stopReason?: string; errorMessage?: string } }).error?.stopReason, 'aborted');
      assert.equal((output?.events[0] as { error?: { errorMessage?: string } }).error?.errorMessage, 'Request was aborted');
      assert.equal(output?.events.some((event) => (event as { error?: { errorMessage?: string } }).error?.errorMessage?.includes('QLB unavailable')), false);
    } finally {
      if (previousCli === undefined) delete process.env.QLB_CLI;
      else process.env.QLB_CLI = previousCli;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the request abort signal to the QLB gate', async () => {
    let gateSignal: AbortSignal | undefined;
    let registered: { streamSimple: (model: { id: string }, context: unknown, options?: Record<string, unknown>) => unknown } | undefined;
    registerKimiCodingProvider({
      unregisterProvider: () => undefined,
      registerProvider: (_name, config) => { registered = config as never; },
    }, {
      owned: () => true,
      createStream: () => ({ push: () => undefined, end: () => undefined }),
      gate: async (signal) => {
        gateSignal = signal;
        return { code: 0, stdout: JSON.stringify({ token: 'kimi-test-access', accountId: 'default', source: 'keychain' }), stderr: '' };
      },
      builtin: () => (async function* () { yield { type: 'done' }; })(),
    });
    const controller = new AbortController();
    registered!.streamSimple({ id: 'k3' }, {}, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gateSignal, controller.signal);
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
