import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { resolvePiPackageRoot } from '../src/pi-integration';
import { qlbUnavailable, type PiProvider } from '../extensions/qlb-pi/active-access';
import { CONSUME_ERRORS } from '../extensions/qlb-pi/consume';
import { createAnthropicSource } from '../extensions/qlb-pi/providers/anthropic';
import { createOpenAICodexSource, gateCause } from '../extensions/qlb-pi/providers/openai-codex';
import { runExecutingCommand } from '../src/app';
import { beginCutover, transition } from '../src/lifecycle';
import { discoverCommands, resolveCommand, type CommandContext } from '../src/registry';
import { openStore } from '../src/store';

const ROOT = join(__dirname, '..', '..');
const PI_GLOBAL_ROOT = process.env.QLB_TEST_PI_ROOT ?? resolvePiPackageRoot() ?? '/nonexistent-pi';
const piAvailable = existsSync(join(PI_GLOBAL_ROOT, 'node_modules', 'jiti', 'lib', 'jiti.mjs'));

const PROVIDERS = ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter'] as const;
type Provider = (typeof PROVIDERS)[number];

const CAUSES = [
  // Missing command is the spawn ENOENT path, not a synthetic gate response.
  { name: 'missing binary', cause: 'missing-binary', code: 1, stderr: undefined },
  // Gate failures written to stderr. store-open-failed, owner-file-malformed,
  // identity-mismatch and refresh-failed come from src/pi-gate.ts and
  // src/gate/anthropic.ts; auth-json-unstable and
  // codex-token-expired-renewer-idle are AC13 causes the Pi allowlist accepts
  // (extensions/qlb-pi/active-access.ts) but no src/ path emits yet (D-P8-3).
  { name: 'unreadable DB', cause: 'store-open-failed', code: 1, stderr: 'store-open-failed' },
  { name: 'malformed owner file', cause: 'owner-file-malformed', code: 1, stderr: 'owner-file-malformed' },
  { name: 'identity mismatch', cause: 'identity-mismatch', code: 3, stderr: 'identity-mismatch' },
  { name: 'unstable auth.json', cause: 'auth-json-unstable', code: 1, stderr: 'auth-json-unstable' },
  { name: 'refresh failure', cause: 'refresh-failed', code: 1, stderr: 'refresh-failed' },
  // Lifecycle admission happens outside command execution, so its prefix is real CLI output.
  { name: 'phase=pre-cutover', cause: 'phase=pre-cutover', code: 3, stderr: 'qlb gate: refused: phase=pre-cutover' },
  { name: 'undo-in-progress', cause: 'undo-in-progress', code: 3, stderr: 'qlb gate: refused: undo-in-progress' },
  { name: 'codex-token-expired-renewer-idle', cause: 'codex-token-expired-renewer-idle', code: 1, stderr: 'codex-token-expired-renewer-idle' },
  // S30 guard refusal. runPiGate writes this bare code; it must not collapse to unknown.
  { name: 'token call refused', cause: 'token-call-refused', code: 3, stderr: 'token-call-refused' },
] as const;

/**
 * Every fixed refusal stderr code emitted by src/pi-gate.ts and src/gate/*.ts.
 * phase=* values are allowlisted by safeCause's lifecycle regex, not the set.
 * Single-consume failures that are not GateFailure stay credential-unavailable
 * inside failureCode, so they are represented by that code only.
 */
const AUDITED_GATE_REFUSAL_CODES = [
  'unknown-provider',
  'token-call-refused',
  'store-open-failed',
  'lifecycle-refused',
  'lifecycle-unreadable',
  'cutover-begin-in-progress',
  'undo-in-progress',
  'cswap-process-alive',
  'cswap-process-check-failed',
  'owner-file-malformed',
  'provider-not-applicable',
  'owner-entry-missing',
  'anthropic-pool-present',
  'placeholder-missing',
  'missing-provider-gate',
  'credential-unavailable',
  'phase=pre-cutover',
  'phase=undoing',
  'phase=rolled-back',
  'phase=aborted',
  'no-credentials',
  'credential-expiry-unusable',
  'token-expired',
  'refresh-failed',
  'invalid-client',
  'foreign-credential',
  'relogin-needed',
  'locks-held',
  'identity-mismatch',
  'refresh-deferred-degraded-read',
  'refresh-deferred-unattributable',
  'refresh-deferred-live-read-error',
  'refresh-deferred-live-unattributed-newer',
  'refresh-deferred-live-moved',
  'refresh-deferred-slot-write-failed',
  'refresh-deferred-unexpected',
  'store-unmirrored',
  'gate-context-unset',
  'active-login-unset',
  'active-slot-missing',
  'keychain-unavailable',
  'active-login-stale',
  'smoke-no-retry',
  'smoke-token-expired',
  'smoke-token-expiry-unknown',
  'not-implemented',
] as const;

const UNLISTED_STDERR = [
  '',
  'unknown',
  'raw failure detail must not escape',
  '/Users/someone/.qlb/credentials-linux.json',
  'sk-ant-api03-fixture-secret',
  'token-call-refused\n/tmp/secret',
  'qlb gate: refused: /tmp/secret',
  'phase=cutting-over',
  'phase=retired',
  'phase=not-a-phase',
  'refresh-deferred-not-a-real-reason',
  'smoke-token-expired extra',
  'QLB_PI_TOKEN_CALL=1',
  'Bearer fixture-token',
] as const;

function doctorCause(provider: PiProvider, cause: string): string {
  const message = qlbUnavailable(provider, cause).error.errorMessage;
  const prefix = `QLB unavailable for ${provider} — run qlb doctor (`;
  assert.equal(message, `${prefix}${message.slice(prefix.length, -1)})`);
  return message.slice(prefix.length, -1);
}

function causeCode(error: unknown): string {
  const cause = (error as { causeCode?: unknown } | null)?.causeCode;
  return typeof cause === 'string' ? cause : 'unknown';
}

describe('qlb-pi gate refusal causes', () => {
  it('the real qlb gate lifecycle refusal line parses to its cause in Pi (TC-15)', async () => {
    // Pi's gate parsers strip `qlb gate: refused: ` and accept only a bare
    // allowlisted code, so the dispatcher must not append operator guidance.
    // Both stores refuse at dispatch, before any credential is read.
    for (const { phase, cause } of [
      { phase: 'undoing', cause: 'undo-in-progress' },
      { phase: 'pre-cutover', cause: 'phase=pre-cutover' },
    ] as const) {
      const home = mkdtempSync(join(tmpdir(), 'qlb-gate-refusal-'));
      const dbPath = join(home, '.qlb', 'qlb.db');
      const store = openStore(dbPath);
      try {
        if (phase === 'undoing') {
          beginCutover(store, 1);
          assert.equal(transition(store, 'cutover', 2).ok, true);
          assert.equal(transition(store, 'undoing', 3).ok, true);
        }
      } finally { store.close(); }
      const match = resolveCommand(['gate', 'anthropic', '--json'], discoverCommands());
      assert.ok(match);
      assert.equal(match.command.name, 'gate');
      const stdout: string[] = [];
      const stderr: string[] = [];
      const ctx: CommandContext = {
        stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
        env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home },
        config: { dbPath } as CommandContext['config'], loadConfig: () => { throw new Error('not used'); }, home,
        registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
      };

      assert.equal(await runExecutingCommand(match, ctx), 3, phase);
      assert.deepEqual(stdout, [], phase);
      assert.deepEqual(stderr, [`qlb gate: refused: ${cause}`], phase);
      assert.equal(gateCause(stderr.join('\n')), cause, phase);
    }
  });

  it('maps an exit-3 guard refusal through both provider readers to token-call-refused', async () => {
    const anthropic = createAnthropicSource({
      runGate: async () => ({ code: 3, stdout: '', stderr: 'token-call-refused' }),
    });
    const codex = createOpenAICodexSource({
      runGate: async () => ({ code: 3, stdout: '', stderr: 'qlb gate: refused: token-call-refused\n' }),
    });
    await assert.rejects(anthropic.read(), (error: unknown) => {
      assert.equal(causeCode(error), 'token-call-refused');
      assert.equal(doctorCause('anthropic', causeCode(error)), 'token-call-refused');
      return true;
    });
    await assert.rejects(codex.read(), (error: unknown) => {
      assert.equal(causeCode(error), 'token-call-refused');
      assert.equal(doctorCause('openai-codex', causeCode(error)), 'token-call-refused');
      return true;
    });
  });

  it('keeps every audited gate and smoke refusal code and collapses unlisted stderr', () => {
    for (const code of AUDITED_GATE_REFUSAL_CODES) {
      assert.equal(gateCause(code), code, code);
      assert.equal(gateCause(`qlb gate: refused: ${code}`), code, code);
      assert.equal(doctorCause('anthropic', gateCause(code)), code, code);
      assert.equal(doctorCause('openai-codex', code), code, code);
    }
    for (const raw of UNLISTED_STDERR) {
      const parsed = gateCause(raw);
      assert.equal(doctorCause('anthropic', parsed), 'unknown', raw);
      assert.equal(doctorCause('openai-codex', raw), 'unknown', raw);
      const message = qlbUnavailable('anthropic', raw).error.errorMessage;
      assert.equal(message.includes('sk-ant'), false, raw);
      assert.equal(message.includes('/Users'), false, raw);
      assert.equal(message.includes('/tmp'), false, raw);
      assert.equal(message.includes('fixture-token'), false, raw);
      assert.equal(message.includes('QLB_PI_TOKEN_CALL'), false, raw);
    }
  });

  it('collapses empty exit-3 stderr to unknown without reading a credential', async () => {
    const source = createAnthropicSource({
      runGate: async () => ({ code: 3, stdout: '{"token":"must-not-leak"}', stderr: '' }),
    });
    await assert.rejects(source.read(), (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      assert.equal(message, 'QLB gate anthropic unavailable');
      assert.equal(causeCode(error), 'unknown');
      assert.equal(doctorCause('anthropic', causeCode(error)), 'unknown');
      assert.equal(`${message} ${causeCode(error)}`.includes('must-not-leak'), false);
      return true;
    });
  });
});

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
const compat = process.env.PI_COMPAT_OVERRIDE;
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': piCodingAgent,
  '@earendil-works/pi-agent-core': piAgentCore,
  '@earendil-works/pi-tui': piTui,
  '@earendil-works/pi-ai/providers/all': join(piAi, 'providers', 'all.js'),
  '@earendil-works/pi-ai/compat': compat,
  '@earendil-works/pi-ai/models': join(piAi, 'models.js'),
  '@earendil-works/pi-ai/oauth': join(piAi, 'oauth.js'),
  '@earendil-works/pi-ai': compat,
  '@mariozechner/pi-coding-agent': piCodingAgent,
  '@mariozechner/pi-agent-core': piAgentCore,
  '@mariozechner/pi-tui': piTui,
  '@mariozechner/pi-ai/providers/all': join(piAi, 'providers', 'all.js'),
  '@mariozechner/pi-ai/compat': compat,
  '@mariozechner/pi-ai/models': join(piAi, 'models.js'),
  '@mariozechner/pi-ai/oauth': join(piAi, 'oauth.js'),
  '@mariozechner/pi-ai': compat,
  typebox,
  'typebox/compile': typeboxCompile,
  'typebox/value': typeboxValue,
  '@sinclair/typebox': typebox,
  '@sinclair/typebox/compile': typeboxCompile,
  '@sinclair/typebox/value': typeboxValue,
} });
const extension = await jiti.import(process.env.QLB_PI_EXTENSION, { default: true });
const names = ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter'];
const native = new Map(names.map((name) => [name, { id: name, native: true, streamSimple() { globalThis.transportCalls.push('native:' + name); return (async function* () {})(); } }]));
const providers = new Map(native);
const registrations = [];
const listeners = new Map();
const pi = {
  unregisterProvider(name) { registrations.push('unregister:' + name); providers.delete(name); },
  registerProvider(name, config) {
    const id = typeof name === 'string' ? name : name.id;
    registrations.push('register:' + id);
    providers.set(id, typeof name === 'string' ? { ...native.get(id), ...config } : name);
  },
  on(event, handler) { const handlers = listeners.get(event) || []; handlers.push(handler); listeners.set(event, handlers); },
  registerCommand() {}, registerShortcut() {},
};
await extension(pi);
const lifecycleContext = { ui: { setStatus() {} }, modelRegistry: { runtime: { setRuntimeApiKey() { return Promise.resolve(); }, removeRuntimeApiKey() { return Promise.resolve(); } } } };
for (const handler of listeners.get('session_start') || []) await handler({}, lifecycleContext);
const provider = process.env.CALL_PROVIDER;
const api = { anthropic: 'anthropic-messages', 'openai-codex': 'openai-codex-responses', xai: 'openai-responses', 'kimi-coding': 'openai-completions', openrouter: 'openai-completions' }[provider];
const stream = providers.get(provider).streamSimple({ id: 'fixture-model', api, provider }, { messages: [] }, {});
const events = [];
for await (const event of stream) events.push(event);
console.log(JSON.stringify({ events, registrations, replaced: providers.get(provider) !== native.get(provider), transportCalls: globalThis.transportCalls, provider }));
`;

const compat = String.raw`
globalThis.transportCalls = [];
function stream() {
  const values = []; let closed = false; let waiter;
  return {
    push(value) { if (closed) return; if (waiter) { const resolve = waiter; waiter = undefined; resolve({ done: false, value }); } else values.push(value); },
    end() { closed = true; if (waiter) { const resolve = waiter; waiter = undefined; resolve({ done: true, value: undefined }); } },
    [Symbol.asyncIterator]() { return { next() { const value = values.shift(); if (value !== undefined) return Promise.resolve({ done: false, value }); if (closed) return Promise.resolve({ done: true, value: undefined }); return new Promise((resolve) => { waiter = resolve; }); } }; },
  };
}
function transport(name) { return { streamSimple() { globalThis.transportCalls.push(name); return (async function* () { yield { type: 'done' }; })(); } }; }
export function createAssistantMessageEventStream() { return stream(); }
export function getModels(provider) { return [{ id: provider + '-fixture', api: 'openai-completions', provider }]; }
export function anthropicMessagesApi() { return transport('anthropic'); }
export function openAICompletionsApi() { return transport('openrouter-or-kimi'); }
export function openAIResponsesApi() { return transport('xai'); }
export function openAICodexResponsesApi() { return transport('openai-codex'); }
`;

function fakeGateSource(): string {
  return String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.join(' ') === 'consume status --provider anthropic --json') {
  process.stdout.write(JSON.stringify({ state: 'NATIVE' }));
  // The gate executable is genuinely absent when streamSimple runs.
  if (process.env.QLB_FAIL_CAUSE === 'missing-binary') fs.unlinkSync(process.argv[1]);
  process.exit(0);
}
const cause = process.env.QLB_FAIL_CAUSE;
const code = Number(process.env.QLB_FAIL_CODE);
const stderr = process.env.QLB_FAIL_STDERR;
if (args.join(' ') !== 'gate ' + process.env.QLB_EXPECTED_PROVIDER + ' --json') process.exit(97);
fs.appendFileSync(process.env.QLB_GATE_LOG, args[1] + '\n');
if (stderr) process.stderr.write(stderr);
process.exit(code);
`;
}

function run(
  provider: Provider,
  failure: (typeof CAUSES)[number],
  { absentAtStartup = false, malformedOwner = false }: { absentAtStartup?: boolean; malformedOwner?: boolean } = {},
): {
  events: Array<{ error?: { errorMessage?: string } }>;
  registrations: string[];
  replaced: boolean;
  transportCalls: string[];
  gateCalls: string[];
} {
  const home = mkdtempSync(join(tmpdir(), 'qlb-pi-fail-closed-'));
  const agent = join(home, '.pi', 'agent');
  const extensionRoot = join(agent, 'extensions', 'qlb-pi');
  const gateDir = join(home, 'gate-bin');
  const commandMarker = join(home, 'models-command-ran');
  const gateLog = join(home, 'gate-calls');
  mkdirSync(agent, { recursive: true });
  cpSync(join(ROOT, 'extensions', 'qlb-pi'), extensionRoot, { recursive: true });
  mkdirSync(join(agent, 'src'), { recursive: true });
  cpSync(join(ROOT, 'src', 'redact.ts'), join(agent, 'src', 'redact.ts'));
  cpSync(join(ROOT, 'src', 'pi-owner-document.ts'), join(agent, 'src', 'pi-owner-document.ts'));
  writeFileSync(join(agent, 'qlb-owner.json'), malformedOwner
    ? '{not json'
    : JSON.stringify({ providers: Object.fromEntries(PROVIDERS.map((name) => [name, { mode: 'qlb', since: 1 }])) }));
  // The adapter parses this literal configuration but must never execute it.
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { openrouter: { baseUrl: 'https://fixture.invalid', apiKey: `!command touch ${commandMarker}` } } }));
  const entry = join(home, 'load.mjs');
  const compatPath = join(home, 'compat.mjs');
  writeFileSync(entry, loader);
  writeFileSync(compatPath, compat);

  mkdirSync(gateDir);
  const gate = join(gateDir, 'qlb');
  if (!absentAtStartup) {
    writeFileSync(gate, fakeGateSource());
    chmodSync(gate, 0o755);
  }
  const path = gateDir;
  const child = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: path,
      HOME: home,
      QLB_HOME: join(home, 'qlb'),
      QLB_TEST_MODE: '1',
      PI_GLOBAL_ROOT,
      PI_COMPAT_OVERRIDE: compatPath,
      QLB_PI_EXTENSION: join(extensionRoot, 'index.ts'),
      CALL_PROVIDER: provider,
      QLB_EXPECTED_PROVIDER: provider,
      QLB_GATE_LOG: gateLog,
      QLB_FAIL_CAUSE: failure.cause,
      QLB_FAIL_CODE: String(failure.code),
      ...(failure.stderr === undefined ? {} : { QLB_FAIL_STDERR: failure.stderr }),
    },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(commandMarker), false, 'models.json !command must not run');
  return {
    ...JSON.parse(child.stdout.trim()) as Omit<ReturnType<typeof run>, 'gateCalls'>,
    gateCalls: existsSync(gateLog) ? readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

describe('qlb-pi registered streamSimple fail-closed matrix', { skip: piAvailable ? false : 'global Pi install not found' }, () => {
  for (const provider of PROVIDERS) {
    for (const failure of CAUSES) {
      it(`${provider}: ${failure.name}`, () => {
        const result = run(provider, failure);
        assert.equal(result.replaced, true, 'registered provider source was not selected');
        assert.equal(result.events.length, 1);
        assert.equal(
          result.events[0]?.error?.errorMessage,
          `QLB unavailable for ${provider} — run qlb doctor (${failure.cause})`,
        );
        assert.deepEqual(result.transportCalls, []);
        if (failure.cause !== 'missing-binary') assert.deepEqual(result.gateCalls, [provider]);
        if (provider === 'openrouter') {
          assert.ok(result.registrations.includes('register:openrouter'), 'OpenRouter did not use its registered source');
        }
      });
    }
  }

  it('anthropic: missing binary at startup', () => {
    const failure = CAUSES[0];
    const result = run('anthropic', failure, { absentAtStartup: true });
    assert.equal(result.replaced, true, 'registered provider source was not selected');
    assert.equal(result.events.length, 1);
    assert.equal(
      result.events[0]?.error?.errorMessage,
      'QLB unavailable for anthropic — run qlb doctor (missing-binary)',
    );
    assert.deepEqual(result.transportCalls, []);
    assert.deepEqual(result.gateCalls, []);
  });

  it('anthropic: a malformed owner file outranks a missing binary at startup', () => {
    const result = run('anthropic', CAUSES[0], { absentAtStartup: true, malformedOwner: true });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.error?.errorMessage, CONSUME_ERRORS.conflict);
    assert.deepEqual(result.transportCalls, []);
  });
});
