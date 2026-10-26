import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { registerOpenAICodexProvider, type OpenAICodexBuiltin } from '../extensions/qlb-pi/providers/openai-codex';
import { resolvePiPackageRoot } from '../src/pi-integration';

const ROOT = join(__dirname, '..', '..');
const PI_GLOBAL_ROOT = process.env.QLB_TEST_PI_ROOT ?? resolvePiPackageRoot() ?? '/nonexistent-pi';
const piAvailable = existsSync(join(PI_GLOBAL_ROOT, 'node_modules', 'jiti', 'lib', 'jiti.mjs'));

const loader = String.raw`
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PI_GLOBAL_ROOT;
const { createJiti } = await import(pathToFileURL(join(root, 'node_modules', 'jiti', 'lib', 'jiti.mjs')).href);
const compat = join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'compat.js');
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-ai/compat': compat,
  '@earendil-works/pi-ai': compat,
  '@earendil-works/pi-tui': join(root, 'node_modules', '@earendil-works', 'pi-tui', 'dist', 'index.js'),
  '@earendil-works/pi-coding-agent': join(root, 'dist', 'index.js'),
} });
const factory = await jiti.import(process.env.QLB_PI_EXTENSION, { default: true });
const names = ['xai', 'kimi-coding', 'openrouter', 'openai-codex'];
const native = new Map(names.map((name) => [name, { native: true, api: name, streamSimple: () => { throw new Error('native used'); } }]));
const providers = new Map(native);
const calls = [];
const pi = {
  unregisterProvider(name) { calls.push('unregister:' + name); providers.delete(name); },
  registerProvider(name, config) { calls.push('register:' + name); providers.set(name, config); },
  on() {}, registerCommand() {}, registerShortcut() {},
};
await factory(pi);
const events = [];
if (process.env.CALL_CODEX === '1') {
  const stream = providers.get('openai-codex').streamSimple(
    { id: 'gpt-5', api: 'openai-codex-responses', provider: 'openai-codex' }, { messages: [] }, {},
  );
  for await (const event of stream) events.push(event);
}
console.log(JSON.stringify({ calls, replaced: Object.fromEntries(names.map((name) => [name, providers.get(name) !== native.get(name)])), events }));
`;

const fakeQlb = String.raw`
const args = process.argv.slice(2);
if (args.join(' ') !== 'gate openai-codex --json') process.exit(3);
if (process.env.GATE_FAIL === '1') {
  process.stderr.write('store-open-failed');
  process.exit(3);
}
process.stdout.write(JSON.stringify({ token: 'fixture-codex-access', accountId: 'user:slot', chatgptAccountId: 'bare-account', source: 'fixture' }));
`;

function load(owner?: string, gateFail = false, callCodex = false): {
  calls: string[];
  replaced: Record<string, boolean>;
  events: Array<{ error?: { errorMessage?: string } }>;
} {
  const home = mkdtempSync(join(tmpdir(), 'qlb-pi-wiring-'));
  const agent = join(home, '.pi', 'agent');
  mkdirSync(agent, { recursive: true });
  if (owner !== undefined) writeFileSync(join(agent, 'qlb-owner.json'), owner);
  const runner = join(home, 'fake-qlb.cjs');
  const entry = join(home, 'load.mjs');
  writeFileSync(runner, fakeQlb);
  writeFileSync(entry, loader);
  const result = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USER: 'qlb-test',
      PI_GLOBAL_ROOT,
      QLB_PI_EXTENSION: join(ROOT, 'extensions', 'qlb-pi', 'index.ts'),
      QLB_CLI: runner,
      ...(gateFail ? { GATE_FAIL: '1' } : {}),
      ...(callCodex ? { CALL_CODEX: '1' } : {}),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop() ?? '') as ReturnType<typeof load>;
}

describe('qlb-pi provider wiring', { skip: piAvailable ? false : 'global Pi install not found' }, () => {
  it('registers every v2-owned non-Anthropic source and leaves unowned native providers alone', () => {
    const owner = JSON.stringify({ providers: {
      xai: { mode: 'qlb', since: 1 },
      'kimi-coding': { mode: 'qlb', since: 1 },
      openrouter: { mode: 'qlb', since: 1 },
      'openai-codex': { mode: 'qlb', since: 1 },
    } });
    const owned = load(owner);
    assert.deepEqual(owned.replaced, { xai: true, 'kimi-coding': true, openrouter: true, 'openai-codex': true });

    const inert = load();
    assert.deepEqual(inert.replaced, { xai: false, 'kimi-coding': false, openrouter: false, 'openai-codex': false });
  });

  it('fails closed once for an unavailable Codex gate without reaching a transport', () => {
    const result = load(JSON.stringify({ providers: { 'openai-codex': { mode: 'qlb', since: 1 } } }), true, true);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.error?.errorMessage, 'QLB unavailable for openai-codex — run qlb doctor (unknown)');
  });
});

describe('OpenAI Codex registration adapter', () => {
  it('forwards the gate credential and bare ChatGPT account id, never caller credentials', async () => {
    let options: Record<string, unknown> | undefined;
    const events: unknown[] = [];
    const pi = {
      unregisterProvider() {},
      registerProvider(_name: string, config: { streamSimple: (model: { id: string }, context: unknown, options?: Record<string, unknown>) => unknown }) {
        const stream = config.streamSimple({ id: 'gpt-5' }, {}, { headers: { Authorization: 'native', 'ChatGPT-Account-Id': 'composite' } });
        assert.equal(stream, sink);
      },
    };
    const sink = { push(event: unknown) { events.push(event); }, end() {} };
    const builtin: OpenAICodexBuiltin = async function* (_model, _context, next) {
      options = next;
      yield { type: 'done' };
    };
    registerOpenAICodexProvider(pi, builtin, {
      createStream: () => sink,
      runGate: async () => ({ code: 0, stdout: JSON.stringify({ token: 'fixture-codex-access', accountId: 'user:slot', chatgptAccountId: 'bare-account', source: 'fixture' }) }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(options?.apiKey, 'fixture-codex-access');
    assert.deepEqual(options?.headers, { Authorization: 'Bearer fixture-codex-access', 'ChatGPT-Account-Id': 'bare-account' });
    assert.deepEqual(events, [{ type: 'done' }]);
  });

  it('emits one unavailable event and makes zero transport calls when the gate fails', async () => {
    let transports = 0;
    const events: unknown[] = [];
    let registered: { streamSimple: (model: { id: string }, context: unknown, options?: Record<string, unknown>) => unknown } | undefined;
    const pi = {
      unregisterProvider() {},
      registerProvider(_name: string, config: typeof registered) { registered = config; },
    };
    const sink = { push(event: unknown) { events.push(event); }, end() {} };
    registerOpenAICodexProvider(pi, () => {
      transports += 1;
      return (async function* () {})();
    }, {
      createStream: () => sink,
      runGate: async () => ({ code: 3, stdout: '' }),
    });
    registered!.streamSimple({ id: 'gpt-5' }, {}, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transports, 0);
    assert.equal(events.length, 1);
    assert.equal((events[0] as { error: { errorMessage: string } }).error.errorMessage,
      'QLB unavailable for openai-codex — run qlb doctor (unknown)');
  });
});
