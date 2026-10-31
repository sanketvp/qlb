import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { QLB_RUNTIME_AUTH_SENTINEL, registerOpenAICodexProvider, type OpenAICodexBuiltin } from '../extensions/qlb-pi/providers/openai-codex';
import { GateFailure, validatePiOwnerDocument } from '../src/pi-gate';
import { resolvePiPackageRoot } from '../src/pi-integration';

const ROOT = join(__dirname, '..', '..');
const PI_GLOBAL_ROOT = process.env.QLB_TEST_PI_ROOT ?? resolvePiPackageRoot() ?? '/nonexistent-pi';
const piAvailable = existsSync(join(PI_GLOBAL_ROOT, 'node_modules', 'jiti', 'lib', 'jiti.mjs'));

const loader = String.raw`
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PI_GLOBAL_ROOT;
const { createJiti } = await import(pathToFileURL(join(root, 'node_modules', 'jiti', 'lib', 'jiti.mjs')).href);
const piRequire = createRequire(join(root, 'package.json'));
const piAi = join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist');
const piAgentCore = join(root, 'node_modules', '@earendil-works', 'pi-agent-core', 'dist', 'index.js');
const piTui = join(root, 'node_modules', '@earendil-works', 'pi-tui', 'dist', 'index.js');
const piCodingAgent = join(root, 'dist', 'index.js');
const typebox = piRequire.resolve('typebox');
const typeboxCompile = piRequire.resolve('typebox/compile');
const typeboxValue = piRequire.resolve('typebox/value');
// Exact Pi 1.4.0 extension alias table: dist/core/extensions/loader.js:63-81.
// Pi exposes only these pi-ai entrypoints; provider-specific subpaths are not aliases.
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': piCodingAgent,
  '@earendil-works/pi-agent-core': piAgentCore,
  '@earendil-works/pi-tui': piTui,
  '@earendil-works/pi-ai/providers/all': join(piAi, 'providers', 'all.js'),
  '@earendil-works/pi-ai/compat': process.env.PI_COMPAT_OVERRIDE || join(piAi, 'compat.js'),
  '@earendil-works/pi-ai/models': join(piAi, 'models.js'),
  '@earendil-works/pi-ai/oauth': join(piAi, 'oauth.js'),
  '@earendil-works/pi-ai': join(piAi, 'compat.js'),
  '@mariozechner/pi-coding-agent': piCodingAgent,
  '@mariozechner/pi-agent-core': piAgentCore,
  '@mariozechner/pi-tui': piTui,
  '@mariozechner/pi-ai/providers/all': join(piAi, 'providers', 'all.js'),
  '@mariozechner/pi-ai/compat': process.env.PI_COMPAT_OVERRIDE || join(piAi, 'compat.js'),
  '@mariozechner/pi-ai/models': join(piAi, 'models.js'),
  '@mariozechner/pi-ai/oauth': join(piAi, 'oauth.js'),
  '@mariozechner/pi-ai': join(piAi, 'compat.js'),
  typebox,
  'typebox/compile': typeboxCompile,
  'typebox/value': typeboxValue,
  '@sinclair/typebox': typebox,
  '@sinclair/typebox/compile': typeboxCompile,
  '@sinclair/typebox/value': typeboxValue,
} });
const factory = await jiti.import(process.env.QLB_PI_EXTENSION, { default: true });
const names = ['anthropic', 'xai', 'kimi-coding', 'openrouter', 'openai-codex'];
const oauth = { resolve: 0, refresh: 0 };
const authJson = { reads: 0, writes: 0 };
const native = new Map(names.map((name) => [name, {
  native: true, api: name, streamSimple: (...streamArgs) => {
    if (name === 'anthropic' && process.env.AUTH_401 === '1') {
      const apiKey = streamArgs[2]?.apiKey;
      return (async function* () {
        if (apiKey === 'fixture-anthropic-access') {
          yield { type: 'error', reason: 'error', error: { errorMessage: '401 unauthorized' } };
        } else {
          yield { type: 'done' };
        }
      })();
    }
    throw new Error('native used');
  },
  ...(name === 'openai-codex' ? { auth: { oauth: {
    toAuth() { oauth.resolve += 1; return { apiKey: 'native' }; },
    refresh() { oauth.refresh += 1; return {}; },
  } } } : {}),
}]));
const providers = new Map(native);
const calls = [];
const listeners = new Map();
const runtimeApiKeys = process.env.PREEXISTING_ANTHROPIC_KEY ? { anthropic: process.env.PREEXISTING_ANTHROPIC_KEY } : {};
const pi = {
  unregisterProvider(name) { calls.push('unregister:' + name); providers.delete(name); },
  registerProvider(name, config) {
    const id = typeof name === 'string' ? name : name.id;
    // Pi's name/config registration merges omitted fields from the built-in;
    // a native Provider object replaces it wholesale.
    const provider = typeof name === 'string' ? { ...native.get(id), ...config } : name;
    calls.push('register:' + id); providers.set(id, provider);
  },
  on(event, handler) {
    const handlers = listeners.get(event) || [];
    handlers.push(handler);
    listeners.set(event, handlers);
  }, registerCommand() {}, registerShortcut() {},
};
await factory(pi);
const lifecycleContext = { ui: { setStatus() {} }, modelRegistry: { runtime: {
  setRuntimeApiKey(provider, key) { runtimeApiKeys[provider] = key; if (process.env.RUNTIME_KEY_CALLS_VOID !== '1') return Promise.resolve(); },
  removeRuntimeApiKey(provider) { delete runtimeApiKeys[provider]; if (process.env.RUNTIME_KEY_CALLS_VOID !== '1') return Promise.resolve(); },
} } };
for (const handler of listeners.get('session_start') || []) await handler({}, lifecycleContext);
if (process.env.RELOAD_INERT === '1') {
  process.env.QLB_PI_REHEARSAL = '0';
  const reloadListeners = new Map();
  const reloadPi = { ...pi, on(event, handler) {
    const handlers = reloadListeners.get(event) || [];
    handlers.push(handler);
    reloadListeners.set(event, handlers);
  } };
  const reloaded = await jiti.import(process.env.QLB_PI_EXTENSION, { default: true });
  await reloaded(reloadPi);
  for (const handler of reloadListeners.get('session_start') || []) await handler({}, lifecycleContext);
}
const events = [];
if (process.env.CALL_ANTHROPIC === '1') {
  const stream = providers.get('anthropic').streamSimple(
    { id: 'claude-sonnet-5', api: 'anthropic-messages', provider: 'anthropic' }, { messages: [] }, {},
  );
  for await (const event of stream) events.push(event);
}
if (process.env.CALL_CODEX === '1') {
  const codex = providers.get('openai-codex');
  if (codex.auth?.oauth) {
    // A merged native OAuth provider resolves the shadow-retained auth.json
    // before the extension stream can invoke the QLB gate.
    authJson.reads += 1;
    codex.auth.oauth.toAuth();
    codex.auth.oauth.refresh(); authJson.writes += 1;
  }
  const stream = codex.streamSimple(
    { id: 'gpt-5', api: 'openai-codex-responses', provider: 'openai-codex' }, { messages: [] }, {},
  );
  for await (const event of stream) events.push(event);
}
console.log(JSON.stringify({ calls, replaced: Object.fromEntries(names.map((name) => [name, providers.get(name) !== native.get(name)])), codexModelCount: providers.get('openai-codex')?.getModels?.().length ?? 0, oauth, authJson, runtimeApiKeys, events }));
`;

const fakeQlb = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'consume' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ state: process.env.CONSUME_MODE === '1' ? 'CONSUMED' : 'NATIVE' }));
  process.exit(0);
}
const provider = args[0] === 'gate' && args[2] === '--json' ? args[1] : undefined;
if (!['anthropic', 'xai', 'kimi-coding', 'openrouter', 'openai-codex'].includes(provider)) process.exit(3);
if (process.env.QLB_PI_TOKEN_CALL !== '1') process.exit(4);
if (process.env.GATE_CALL_LOG) fs.appendFileSync(process.env.GATE_CALL_LOG, provider + '\n');
if (process.env.GATE_ARGS_LOG) fs.appendFileSync(process.env.GATE_ARGS_LOG, JSON.stringify(args) + '\n');
const finishGate = () => {
  if (process.env.GATE_FAIL === '1') {
    process.stderr.write(process.env.GATE_CAUSE || 'store-open-failed');
    process.exit(3);
  }
  const retry = args.indexOf('--retry-after-401') !== -1;
  const accountId = retry && process.env.RETRY_ACCOUNT ? process.env.RETRY_ACCOUNT : 'user:slot';
  process.stdout.write(JSON.stringify({ token: 'fixture-' + provider + (retry ? '-refreshed' : '-access'), accountId, chatgptAccountId: 'bare-account', source: 'fixture' }));
};
const delayMs = Number(process.env.GATE_DELAY_MS || '0');
if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(finishGate, delayMs);
else finishGate();
`;

function load(owner?: string, gateFail = false, callCodex = false, perProviderOwner?: string, ownerIsDirectory = false, deployedLayout = false, callAnthropic = false, gateCause?: string, rehearsal = false, gateDelayMs = 0, options: {
  preexistingAnthropicKey?: string;
  consumeMode?: boolean;
  runtimeKeyCallsVoid?: boolean;
  streamSimpleOnly?: boolean;
  reloadInert?: boolean;
  auth401?: boolean;
  retryAccount?: string;
} = {}): {
  calls: string[];
  replaced: Record<string, boolean>;
  oauth: { resolve: number; refresh: number };
  authJson: { reads: number; writes: number };
  runtimeApiKeys: Record<string, string>;
  codexModelCount: number;
  events: Array<{ type?: string; error?: { errorMessage?: string } }>;
  gateCalls: string[];
  gateArgs: string[][];
  outcomes: Array<Record<string, unknown>>;
  stderr: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'qlb-pi-wiring-'));
  const agent = join(home, '.pi', 'agent');
  mkdirSync(agent, { recursive: true });
  const ownerPath = join(agent, 'qlb-owner.json');
  if (ownerIsDirectory) mkdirSync(ownerPath);
  else if (owner !== undefined) writeFileSync(ownerPath, owner);
  if (perProviderOwner !== undefined) writeFileSync(join(agent, 'qlb-owner-openai-codex.json'), perProviderOwner);
  const extension = deployedLayout
    ? join(agent, 'extensions', 'qlb-pi', 'index.ts')
    : join(ROOT, 'extensions', 'qlb-pi', 'index.ts');
  if (deployedLayout) {
    // This is exactly the standalone layout `qlb pi deploy` publishes.
    cpSync(join(ROOT, 'extensions', 'qlb-pi'), dirname(extension), { recursive: true });
    mkdirSync(join(agent, 'src'), { recursive: true });
    cpSync(join(ROOT, 'src', 'redact.ts'), join(agent, 'src', 'redact.ts'));
    cpSync(join(ROOT, 'src', 'pi-owner-document.ts'), join(agent, 'src', 'pi-owner-document.ts'));
  }
  const runner = join(home, 'fake-qlb.cjs');
  const gateLog = join(home, 'gate-calls');
  const gateArgsLog = join(home, 'gate-args');
  const outcomesLog = join(home, '.qlb', 'outcomes.jsonl');
  const entry = join(home, 'load.mjs');
  const compatOverride = join(home, 'compat-stream-simple-only.mjs');
  if (options.consumeMode) {
    const dbPath = join(home, 'qlb', 'qlb.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, '');
  }
  if (options.streamSimpleOnly || options.auth401) {
    const compat = join(PI_GLOBAL_ROOT, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'compat.js');
    const fakeAnthropicApi = options.auth401
      ? `const response = (stopReason, errorMessage) => ({ role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-5', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now() });\nexport function anthropicMessagesApi() { return { streamSimple(_model, _context, options) { return (async function* () { if (options?.apiKey === 'fixture-anthropic-access') yield { type: 'error', reason: 'error', error: response('error', '401 unauthorized') }; else yield { type: 'done', reason: 'stop', message: response('stop') }; })(); } }; }\n`
      : `export function anthropicMessagesApi() { return { streamSimple: actual.anthropicMessagesApi().streamSimple }; }\n`;
    // The extension obtains its builtin transport from Pi compat, not the
    // registered provider map. Override compat so the 401 test neither calls
    // the real transport nor accidentally tests an unrelated error path.
    writeFileSync(compatOverride, `import * as actual from ${JSON.stringify(compat)};\nexport * from ${JSON.stringify(compat)};\n${fakeAnthropicApi}`);
  }
  writeFileSync(runner, fakeQlb);
  writeFileSync(entry, loader);
  const result = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      QLB_HOME: join(home, 'qlb'),
      QLB_TEST_MODE: '1',
      USER: 'qlb-test',
      PI_GLOBAL_ROOT,
      QLB_PI_EXTENSION: extension,
      QLB_CLI: runner,
      GATE_CALL_LOG: gateLog,
      GATE_ARGS_LOG: gateArgsLog,
      ...(options.auth401 ? { AUTH_401: '1' } : {}),
      ...(options.retryAccount ? { RETRY_ACCOUNT: options.retryAccount } : {}),
      ...(gateFail ? { GATE_FAIL: '1' } : {}),
      ...(gateCause ? { GATE_CAUSE: gateCause } : {}),
      ...(gateDelayMs > 0 ? { GATE_DELAY_MS: String(gateDelayMs) } : {}),
      ...(rehearsal ? { QLB_PI_REHEARSAL: '1' } : {}),
      ...(options.preexistingAnthropicKey ? { PREEXISTING_ANTHROPIC_KEY: options.preexistingAnthropicKey } : {}),
      ...(options.consumeMode ? { CONSUME_MODE: '1', QLB_DB_PATH: join(home, 'qlb', 'qlb.db') } : {}),
      ...(options.runtimeKeyCallsVoid ? { RUNTIME_KEY_CALLS_VOID: '1' } : {}),
      ...(options.streamSimpleOnly || options.auth401 ? { PI_COMPAT_OVERRIDE: compatOverride } : {}),
      ...(options.reloadInert ? { RELOAD_INERT: '1' } : {}),
      ...(callCodex ? { CALL_CODEX: '1' } : {}),
      ...(callAnthropic ? { CALL_ANTHROPIC: '1' } : {}),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    ...JSON.parse(result.stdout.trim().split('\n').pop() ?? ''),
    gateCalls: existsSync(gateLog) ? readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean) : [],
    outcomes: existsSync(outcomesLog) ? readFileSync(outcomesLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [],
    gateArgs: existsSync(gateArgsLog) ? readFileSync(gateArgsLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) : [],
    stderr: result.stderr,
  } as ReturnType<typeof load>;
}

describe('qlb-pi provider wiring', { skip: piAvailable ? false : 'global Pi install not found' }, () => {
  it('registers every v2-owned provider through a replacement source and leaves unowned native providers alone', () => {
    const owner = JSON.stringify({ providers: {
      anthropic: { mode: 'qlb', since: 1 },
      xai: { mode: 'qlb', since: 1 },
      'kimi-coding': { mode: 'qlb', since: 1 },
      openrouter: { mode: 'qlb', since: 1 },
      'openai-codex': { mode: 'qlb', since: 1 },
    } });
    const owned = load(owner);
    assert.deepEqual(owned.replaced, {
      anthropic: true, xai: true, 'kimi-coding': true, openrouter: true, 'openai-codex': true,
    });

    assert.ok(owned.codexModelCount > 0, 'an owned Codex provider keeps Pi\'s catalog');

    const inert = load();
    assert.deepEqual(inert.replaced, {
      anthropic: false, xai: false, 'kimi-coding': false, openrouter: false, 'openai-codex': false,
    });
  });

  it('an operator --api-key for anthropic survives session start in inert and owned mode', () => {
    const operatorKey = 'sk-ant-api-test';
    assert.equal(load(undefined, false, false, undefined, false, false, false, undefined, false, 0, {
      preexistingAnthropicKey: operatorKey,
    }).runtimeApiKeys.anthropic, operatorKey);
    assert.equal(load(JSON.stringify({ providers: { anthropic: { mode: 'qlb', since: 1 } } }), false, false, undefined, false, false, false, undefined, false, 0, {
      preexistingAnthropicKey: operatorKey,
    }).runtimeApiKeys.anthropic, operatorKey);
  });

  it('consume mode keeps the QLB sentinel after session start', () => {
    const result = load(undefined, false, false, undefined, false, false, false, undefined, false, 0, { consumeMode: true });
    assert.equal(result.runtimeApiKeys.anthropic, QLB_RUNTIME_AUTH_SENTINEL);
  });

  it('a reload that goes inert leaves no anthropic runtime key', () => {
    const result = load(undefined, false, false, undefined, false, false, false, undefined, false, 0, {
      consumeMode: true, reloadInert: true,
    });
    assert.equal('anthropic' in result.runtimeApiKeys, false);
  });

  it('runtime key calls that return void do not throw', () => {
    const result = load(undefined, false, false, undefined, false, false, false, undefined, false, 0, {
      consumeMode: true, reloadInert: true, runtimeKeyCallsVoid: true,
    });
    assert.equal('anthropic' in result.runtimeApiKeys, false);
  });

  it('registers owned Anthropic with streamSimple when Pi has no stream', () => {
    const result = load(JSON.stringify({ providers: { anthropic: { mode: 'qlb', since: 1 } } }), false, false, undefined, false, false, false, undefined, false, 0, {
      streamSimpleOnly: true,
    });
    assert.equal(result.replaced.anthropic, true);
  });

  it('uses the owned Anthropic gate source and emits the common unavailable event on gate failure', () => {
    const owner = JSON.stringify({ providers: {
      anthropic: { mode: 'qlb', since: 1 },
      xai: { mode: 'qlb', since: 1 },
      'kimi-coding': { mode: 'qlb', since: 1 },
      openrouter: { mode: 'qlb', since: 1 },
      'openai-codex': { mode: 'qlb', since: 1 },
    } });
    const result = load(owner, true, false, undefined, false, false, true);
    assert.deepEqual(result.gateCalls, ['anthropic']);
    assert.deepEqual(result.events.map((event) => event.error?.errorMessage), [
      'QLB unavailable for anthropic — run qlb doctor (store-open-failed)',
    ]);
  });

  it('fails closed in Anthropic rehearsal without an owner entry, with the same gate cause as other owned providers', () => {
    const result = load(undefined, true, false, undefined, false, false, true, 'owner-entry-missing', true);
    assert.deepEqual(result.gateCalls, ['anthropic']);
    assert.deepEqual(result.events.map((event) => event.error?.errorMessage), [
      'QLB unavailable for anthropic — run qlb doctor (owner-entry-missing)',
    ]);
  });

  it('waits for an Anthropic gate refresh beyond the default QLB process timeout', () => {
    const owner = JSON.stringify({ providers: { anthropic: { mode: 'qlb', since: 1 } } });
    const result = load(owner, true, false, undefined, false, false, true, undefined, false, 16_000);
    assert.deepEqual(result.gateCalls, ['anthropic']);
    assert.deepEqual(result.events.map((event) => event.error?.errorMessage), [
      'QLB unavailable for anthropic — run qlb doctor (store-open-failed)',
    ]);
  });

  it('re-runs the Anthropic gate with the failed token fingerprint after a 401', () => {
    const owner = JSON.stringify({ providers: { anthropic: { mode: 'qlb', since: 1 } } });
    const result = load(owner, false, false, undefined, false, false, true, undefined, false, 0, { auth401: true });
    const fp = `sha256-at:${createHash('sha256').update('fixture-anthropic-access', 'utf8').digest('hex')}`;
    assert.deepEqual(result.gateCalls, ['anthropic', 'anthropic']);
    assert.deepEqual(result.gateArgs, [
      ['gate', 'anthropic', '--json'],
      ['gate', 'anthropic', '--json', '--retry-after-401', fp],
    ]);
    assert.deepEqual(result.events.map((event) => event.type), ['done']);
  });

  it('a 401 resync that returns another account surfaces the original 401 and records no outcome', () => {
    const owner = JSON.stringify({ providers: { anthropic: { mode: 'qlb', since: 1 } } });
    const result = load(owner, false, false, undefined, false, false, true, undefined, false, 0, { auth401: true, retryAccount: 'user:other' });
    const fp = `sha256-at:${createHash('sha256').update('fixture-anthropic-access', 'utf8').digest('hex')}`;
    assert.deepEqual(result.gateArgs, [
      ['gate', 'anthropic', '--json'],
      ['gate', 'anthropic', '--json', '--retry-after-401', fp],
    ]);
    assert.deepEqual(result.events.map((event) => event.type), ['error']);
    assert.match(result.events[0]?.error?.errorMessage ?? '', /401/);
    assert.deepEqual(result.outcomes, []);
  });

  it('does not infer a Codex owner from a shared Anthropic-only v2 document or legacy v1 document', () => {
    const sharedAnthropicOnly = load(JSON.stringify({ providers: { anthropic: { mode: 'qlb', since: 1 } } }));
    assert.equal(sharedAnthropicOnly.replaced['openai-codex'], false);

    const legacyV1 = load(JSON.stringify({ owner: 'qlb', accounts: [] }));
    assert.equal(legacyV1.replaced['openai-codex'], false);
  });

  it('fails closed for schema-invalid or unreadable shared Codex owner documents', () => {
    const malformedOwners = [
      '{}',
      JSON.stringify({ foo: 1 }),
      JSON.stringify({ owner: 5 }),
      JSON.stringify({ accounts: 'x' }),
      JSON.stringify({ owner: 'qlb' }),
      JSON.stringify({ providers: { 'openai-codex': null } }),
      JSON.stringify({ providers: { 'openai-codex': { mode: 'qlb' } } }),
      JSON.stringify({ providers: { anthropic: { mode: 'bad' } } }),
      JSON.stringify({ providers: { openai_codxe: { mode: 'qlb', since: 1 } } }),
      JSON.stringify({ providers: {}, owner: 5 }),
      '{not json',
      '[]',
      '1',
    ];
    for (const owner of malformedOwners) {
      const result = load(owner);
      assert.equal(result.replaced['openai-codex'], true, owner);
      assert.match(result.stderr, /^\[qlb-pi\] refusing native openai-codex fallback: malformed shared owner file .+\.pi\/agent\/qlb-owner\.json\n$/);
    }

    const unreadable = load(undefined, false, false, undefined, true);
    assert.equal(unreadable.replaced['openai-codex'], true);
    assert.match(unreadable.stderr, /^\[qlb-pi\] refusing native openai-codex fallback: malformed shared owner file .+\.pi\/agent\/qlb-owner\.json\n$/);
  });

  it('loads from a qlb pi deploy-shaped layout and replaces owned Codex', () => {
    const result = load(JSON.stringify({ providers: {
      'openai-codex': { mode: 'qlb', since: 1 },
    } }), false, false, undefined, false, true);
    assert.equal(result.replaced['openai-codex'], true);
  });

  it('keeps the deployed extension import closure inside the deployed layout', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-pi-closure-'));
    const agent = join(home, '.pi', 'agent');
    const extensionRoot = join(agent, 'extensions', 'qlb-pi');
    const redactor = join(agent, 'src', 'redact.ts');
    const ownerDocument = join(agent, 'src', 'pi-owner-document.ts');
    cpSync(join(ROOT, 'extensions', 'qlb-pi'), extensionRoot, { recursive: true });
    mkdirSync(dirname(redactor), { recursive: true });
    cpSync(join(ROOT, 'src', 'redact.ts'), redactor);
    cpSync(join(ROOT, 'src', 'pi-owner-document.ts'), ownerDocument);

    const seen = new Set<string>();
    const visit = (path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      const source = readFileSync(path, 'utf8');
      const imports = source.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm);
      for (const match of imports) {
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) continue;
        if (specifier.startsWith('../../src/')) {
          assert.ok(['../../src/redact.js', '../../src/pi-owner-document.js'].includes(specifier));
        }
        const jsPath = resolve(dirname(path), specifier);
        const resolved = existsSync(jsPath) ? jsPath : jsPath.replace(/\.js$/, '.ts');
        assert.equal(existsSync(resolved), true, `${path} imports missing ${specifier}`);
        assert.ok(resolved.startsWith(`${extensionRoot}/`) || resolved === redactor || resolved === ownerDocument,
          `${path} imports outside deployed layout: ${specifier}`);
        visit(resolved);
      }
    };
    visit(join(extensionRoot, 'index.ts'));
  });

  it('rejects unknown owner provider keys for the gate and fails closed for Codex', () => {
    const unknownProvider = { providers: { openai_codxe: { mode: 'qlb', since: 1 } } };
    assert.throws(() => validatePiOwnerDocument(unknownProvider), (error: unknown) =>
      error instanceof GateFailure && error.code === 'owner-file-malformed');
    const result = load(JSON.stringify(unknownProvider));
    assert.equal(result.replaced['openai-codex'], true);
    assert.match(result.stderr, /malformed shared owner file/);
  });

  it('registers Codex from the shadow-retaining per-provider owner artifact migration writes', () => {
    const migrationOwner = JSON.stringify({
      owner: 'qlb', stagedAt: 1, committedAt: 2, exportSeq: 0,
      qlbAccountIds: ['codex-default'], stores: ['pi-openai-codex'],
      accounts: [{ id: 'codex-default', provider: 'openai-codex', label: 'fixture', fingerprint: 'sha256:fixture' }],
      nativeStrategy: 'shadow-retain', authJsonKey: 'openai-codex',
    });
    const owned = load(undefined, false, false, migrationOwner);
    assert.equal(owned.replaced['openai-codex'], true);
  });

  it('does not merge Pi OAuth or touch shadow-retained auth.json after QLB takes Codex', () => {
    const result = load(undefined, false, true, JSON.stringify({
      owner: 'qlb', accounts: [{ provider: 'openai-codex' }],
    }));
    assert.equal(result.oauth.resolve, 0);
    assert.equal(result.oauth.refresh, 0);
    assert.deepEqual(result.authJson, { reads: 0, writes: 0 });
    assert.deepEqual(result.runtimeApiKeys, { 'openai-codex': 'qlb-managed' });
  });

  it('fails closed once for an unavailable Codex gate without reaching a transport', () => {
    const result = load(JSON.stringify({ providers: { 'openai-codex': { mode: 'qlb', since: 1 } } }), true, true);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.error?.errorMessage, 'QLB unavailable for openai-codex — run qlb doctor (store-open-failed)');
  });
});

describe('Anthropic gate timeout', () => {
  it('passes the bounded-refresh budget only to the Anthropic gate call', () => {
    const source = readFileSync(join(ROOT, 'extensions', 'qlb-pi', 'index.ts'), 'utf8');
    assert.match(source, /const ANTHROPIC_GATE_TIMEOUT_MS = 45_000;/);
    assert.match(source, /runQlb\(\s*\["gate", provider, "--json", \.\.\.\(retryAfter401Fp === undefined \? \[\] : \["--retry-after-401", retryAfter401Fp\]\)\],\s*ANTHROPIC_GATE_TIMEOUT_MS,/);
  });
});

describe('OpenAI Codex registration adapter', () => {
  it('retains a non-empty owned catalog and forwards one request to the injected transport', async () => {
    let options: Record<string, unknown> | undefined;
    let transportCalls = 0;
    const events: unknown[] = [];
    const pi = {
      unregisterProvider() {},
      registerProvider(config: { getModels(): readonly { id: string }[]; streamSimple: (model: { id: string }, context: unknown, options?: Record<string, unknown>) => unknown }) {
        assert.ok(config.getModels().length > 0);
        const stream = config.streamSimple({ id: 'gpt-5' }, {}, { headers: { Authorization: 'native', 'ChatGPT-Account-Id': 'composite' } });
        assert.equal(stream, sink);
      },
    };
    const sink = { push(event: unknown) { events.push(event); }, end() {} };
    const builtin: OpenAICodexBuiltin = async function* (_model, _context, next) {
      transportCalls += 1;
      options = next;
      yield { type: 'done' };
    };
    registerOpenAICodexProvider(pi, builtin, {
      createStream: () => sink,
      models: [{ id: 'gpt-5' }],
      runGate: async () => ({ code: 0, stdout: JSON.stringify({ token: 'fixture-codex-access', accountId: 'user:slot', chatgptAccountId: 'bare-account', source: 'fixture' }) }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transportCalls, 1);
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
      registerProvider(config: typeof registered) { registered = config; },
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
