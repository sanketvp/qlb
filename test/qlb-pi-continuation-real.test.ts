// SAN-211 on Pi's real Anthropic transport. pi-ai 1.6 sends a same-session
// follow-up as a message-thread `continue` that drops `system`, and with it the
// billing marker QLB's shaping puts in system[0]. This drives the owned
// extension through Pi's own anthropic-messages streamSimple (no compat fake)
// against a local HTTP recorder and asserts on the bodies that reach the wire.
//
// Needs Pi >= 1.6: older Pi has no message-thread code, and the control case
// below fails there. CI's Pi 1.4.0 leg excludes this file by name, not by skip.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolvePiPackageRoot } from '../src/pi-integration';

const ROOT = join(__dirname, '..', '..');
const PI_GLOBAL_ROOT = process.env.QLB_TEST_PI_ROOT ?? resolvePiPackageRoot() ?? '/nonexistent-pi';
const piAvailable = existsSync(join(PI_GLOBAL_ROOT, 'node_modules', 'jiti', 'lib', 'jiti.mjs'));

// Fixture tokens only ever reach the local recorder. `sk-ant-oat` makes Pi
// treat them as OAuth, which is how QLB-owned Anthropic requests go out.
const OWNED_TOKEN = 'sk-ant-oat01-qlb-test-fixture-owned';
const CONTROL_TOKEN = 'sk-ant-oat01-qlb-test-fixture-control';

const loader = String.raw`
import { createServer } from 'node:http';
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
// Pi's extension alias table, as in qlb-pi-wiring.test.ts, with the real compat.
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': piCodingAgent,
  '@earendil-works/pi-agent-core': piAgentCore,
  '@earendil-works/pi-tui': piTui,
  '@earendil-works/pi-ai/providers/all': join(piAi, 'providers', 'all.js'),
  '@earendil-works/pi-ai/compat': join(piAi, 'compat.js'),
  '@earendil-works/pi-ai/models': join(piAi, 'models.js'),
  '@earendil-works/pi-ai/oauth': join(piAi, 'oauth.js'),
  '@earendil-works/pi-ai': join(piAi, 'compat.js'),
  typebox,
  'typebox/compile': piRequire.resolve('typebox/compile'),
  'typebox/value': piRequire.resolve('typebox/value'),
} });

// The recorder: keeps every request body, answers with a minimal valid
// Anthropic SSE stream whose message id Pi records as the thread reply.
const recorded = [];
let phase = 'none';
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    recorded.push({ phase, path: req.url, body });
    const id = 'msg_recorded_' + recorded.length;
    const events = [
      ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_' + recorded.length });
    res.end(events.map(([event, data]) => 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n').join(''));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

const { builtinProviders } = await jiti.import('@earendil-works/pi-ai/providers/all');
const catalog = builtinProviders().find((provider) => provider.id === 'anthropic');
const catalogModels = catalog.getModels();
const catalogModel = catalogModels.find((model) => model.id.includes('opus')) ?? catalogModels[0];
// supportsMessageThreads defaults to api.anthropic.com only; force it on so
// the recorder sees exactly what Anthropic would.
const model = { ...catalogModel, baseUrl, compat: { ...catalogModel.compat, supportsMessageThreads: true } };

const providers = new Map();
const listeners = new Map();
const pi = {
  unregisterProvider(name) { providers.delete(name); },
  registerProvider(name, config) { providers.set(typeof name === 'string' ? name : name.id, typeof name === 'string' ? config : name); },
  on(event, handler) { listeners.set(event, [...(listeners.get(event) || []), handler]); },
  registerCommand() {}, registerShortcut() {},
};
const factory = await jiti.import(process.env.QLB_PI_EXTENSION, { default: true });
await factory(pi);
const lifecycleContext = { ui: { setStatus() {} }, modelRegistry: { runtime: {
  async setRuntimeApiKey() {}, async removeRuntimeApiKey() {},
} } };
for (const handler of listeners.get('session_start') || []) await handler({}, lifecycleContext);

// Two same-session turns; turn two extends turn one with its real reply.
async function conversation(streamSimple, sessionId, extra) {
  const errors = [];
  const user1 = { role: 'user', content: 'hello from turn one', timestamp: Date.now() };
  let reply;
  for await (const event of streamSimple(model, { systemPrompt: 'You are a test.', messages: [user1] }, { sessionId, ...extra })) {
    if (event.type === 'done') reply = event.message;
    if (event.type === 'error') errors.push(event.error?.errorMessage ?? 'error');
  }
  const user2 = { role: 'user', content: 'turn two', timestamp: Date.now() };
  for await (const event of streamSimple(model, { systemPrompt: 'You are a test.', messages: reply ? [user1, reply, user2] : [user1, user2] }, { sessionId, ...extra })) {
    if (event.type === 'error') errors.push(event.error?.errorMessage ?? 'error');
  }
  return errors;
}

phase = 'owned';
const ownedErrors = await conversation(providers.get('anthropic').streamSimple, 'qlb-owned-session', {});

// Control: Pi's bare transport with QLB's shaping and no opt-out must continue
// the thread, or this Pi cannot show the regression at all.
const { shapeAnthropicOAuthPayload } = await jiti.import(process.env.QLB_REQUEST_SHAPING);
const { anthropicMessagesApi } = await jiti.import('@earendil-works/pi-ai/compat');
phase = 'control';
const controlErrors = await conversation(anthropicMessagesApi().streamSimple, 'control-session', {
  apiKey: process.env.CONTROL_TOKEN,
  onPayload: (payload) => shapeAnthropicOAuthPayload(payload),
});
server.close();
console.log(JSON.stringify({ recorded, ownedErrors, controlErrors }));
`;

const fakeQlb = String.raw`
const args = process.argv.slice(2);
if (args[0] === 'consume' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ state: 'NATIVE' }));
  process.exit(0);
}
if (args[0] !== 'gate' || args[1] !== 'anthropic' || args[2] !== '--json' || process.env.QLB_PI_TOKEN_CALL !== '1') process.exit(3);
process.stdout.write(JSON.stringify({ token: process.env.OWNED_TOKEN, accountId: 'user:slot', source: 'fixture' }));
`;

interface Recorded {
  phase: 'owned' | 'control';
  path: string;
  body: { system?: Array<{ text?: string }>; thread?: { type?: string }; messages?: unknown[] };
}

function run(): { recorded: Recorded[]; ownedErrors: string[]; controlErrors: string[] } {
  const home = mkdtempSync(join(tmpdir(), 'qlb-pi-continuation-'));
  const agent = join(home, '.pi', 'agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'qlb-owner.json'), JSON.stringify({ providers: { anthropic: { mode: 'qlb', since: 1 } } }));
  const runner = join(home, 'fake-qlb.cjs');
  const entry = join(home, 'load.mjs');
  writeFileSync(runner, fakeQlb);
  writeFileSync(entry, loader);
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      QLB_HOME: join(home, 'qlb'),
      QLB_TEST_MODE: '1',
      USER: 'qlb-test',
      PI_GLOBAL_ROOT,
      QLB_PI_EXTENSION: join(ROOT, 'extensions', 'qlb-pi', 'index.ts'),
      QLB_REQUEST_SHAPING: join(ROOT, 'extensions', 'qlb-pi', 'request-shaping.ts'),
      QLB_CLI: runner,
      OWNED_TOKEN,
      CONTROL_TOKEN,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop() ?? '');
}

const BILLING = /^x-anthropic-billing-header:/;

describe('qlb-pi owned Anthropic on Pi\'s real message-thread transport', { skip: piAvailable ? false : 'global Pi install not found' }, () => {
  it('both same-session requests reach the wire with the billing marker in system[0] and no thread continuation (SAN-211)', () => {
    const { recorded, ownedErrors, controlErrors } = run();
    assert.deepEqual(ownedErrors, []);
    assert.deepEqual(controlErrors, []);

    const control = recorded.filter((entry) => entry.phase === 'control');
    assert.equal(control.length, 2, 'control sent two requests');
    assert.equal(
      control[1].body.thread?.type, 'continue',
      `control: this Pi (${PI_GLOBAL_ROOT}) did not continue the thread, so it cannot show SAN-211; it needs Pi >= 1.6`,
    );
    assert.equal(control[1].body.system, undefined, 'control: a continue drops system');

    const owned = recorded.filter((entry) => entry.phase === 'owned');
    assert.equal(owned.length, 2, 'owned path sent two requests');
    for (const [index, { path, body }] of owned.entries()) {
      assert.match(path, /^\/v1\/messages/, `owned request ${index + 1} path`);
      assert.ok(Array.isArray(body.system), `owned request ${index + 1} must carry system (it went out with thread=${JSON.stringify(body.thread)})`);
      assert.match(body.system[0]?.text ?? '', BILLING, `owned request ${index + 1} system[0]`);
      assert.notEqual(body.thread?.type, 'continue', `owned request ${index + 1} must not continue a thread`);
    }
    // Stronger: no thread is created either, so no later request can continue one.
    for (const [index, { body }] of owned.entries()) {
      assert.equal('thread' in body, false, `owned request ${index + 1} must not use a message thread`);
    }
    assert.equal(owned[1].body.messages?.length, 3, 'owned request 2 resends the full conversation');
  });
});
