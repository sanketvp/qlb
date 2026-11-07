// Loads the real extensions/qlb-pi/index.ts default export the way Pi does
// (jiti + Pi's own package aliases) against a fake ExtensionAPI that already has
// an `anthropic` provider registered (stands in for anthropic-pool).
// Prints one JSON line of captured runtime effects.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function readCount(path) {
  if (!path) return 0;
  try {
    return Number(readFileSync(path, 'utf8')) || 0;
  } catch {
    return 0;
  }
}

function readOutcomes() {
  try {
    const text = readFileSync(join(homedir(), '.qlb', 'outcomes.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => {
      const parsed = JSON.parse(line);
      const { ts: _ts, ...rest } = parsed;
      void _ts;
      return rest;
    });
  } catch {
    return [];
  }
}

const G = process.env.PI_GLOBAL_ROOT;
const EXT = process.env.QLB_PI_EXTENSION;
const { createJiti } = await import(pathToFileURL(join(G, 'node_modules', 'jiti', 'lib', 'jiti.mjs')).href);
const piAi = join(G, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'compat.js');
const fakeCompat = join(homedir(), 'fake-compat.mjs');
writeFileSync(fakeCompat, `import { readFileSync, writeFileSync } from 'node:fs';

function bump(path) {
  if (!path) return;
  let n = 0;
  try { n = Number(readFileSync(path, 'utf8')) || 0; } catch { /* first call */ }
  writeFileSync(path, String(n + 1));
}

export * from '${pathToFileURL(piAi).href}';

export function anthropicMessagesApi() {
  const thrower = (kind) => () => {
    bump(process.env.SMOKE_TRANSPORT_COUNTER);
    throw new Error('compat ' + kind + ' used');
  };
  return { stream: thrower('stream'), streamSimple: thrower('streamSimple') };
}
`);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    '@earendil-works/pi-ai/providers/all': join(G, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js'),
    '@earendil-works/pi-ai/compat': fakeCompat,
    '@earendil-works/pi-ai': piAi,
    '@earendil-works/pi-tui': join(G, 'node_modules', '@earendil-works', 'pi-tui', 'dist', 'index.js'),
    '@earendil-works/pi-coding-agent': join(G, 'dist', 'index.js'),
  },
});
const factory = await jiti.import(EXT, { default: true });

const calls = [];
const POOL = { pool: true, api: 'anthropic-messages', streamSimple: () => { throw new Error('pool used'); } };
const XAI = { native: true, api: 'openai-responses', streamSimple: () => { throw new Error('native xAI used'); } };
const providers = new Map([['anthropic', POOL], ['xai', XAI]]);
const pi = {
  unregisterProvider: (name) => { calls.push(`unregister:${name}`); providers.delete(name); },
  registerProvider: (nameOrProvider, config) => {
    const name = typeof nameOrProvider === 'string' ? nameOrProvider : nameOrProvider.id;
    const provider = typeof nameOrProvider === 'string' ? config : nameOrProvider;
    calls.push(`register:${name}`);
    providers.set(name, provider);
  },
  on: () => {},
  registerCommand: () => {},
  registerShortcut: () => {},
};
await factory(pi);

const events = [];
const provider = providers.get('anthropic');
if (process.env.SMOKE_CALL === '1' && provider && !provider.pool) {
  const stream = provider.streamSimple(
    { id: 'claude-sonnet-5', api: 'anthropic-messages', provider: 'anthropic' },
    { messages: [] },
    {},
  );
  for await (const event of stream) events.push(event);
}
console.log(JSON.stringify({
  calls,
  poolStillRegistered: provider === POOL,
  xaiStillRegistered: providers.get('xai') === XAI,
  events,
  outcomes: readOutcomes(),
  qlbCalls: readCount(process.env.SMOKE_COUNTER),
  gateCalls: readCount(process.env.SMOKE_GATE_COUNTER),
  transportCalls: readCount(process.env.SMOKE_TRANSPORT_COUNTER),
  securityCalls: readCount(process.env.SMOKE_SECURITY_COUNTER),
}));
process.exit(0);
