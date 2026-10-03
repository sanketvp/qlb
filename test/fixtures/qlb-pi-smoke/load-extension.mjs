// Loads the real extensions/qlb-pi/index.ts default export the way Pi does
// (jiti + Pi's own package aliases) against a fake ExtensionAPI that already has
// an `anthropic` provider registered (stands in for anthropic-pool).
// Prints one JSON line: { calls, poolStillRegistered, events }.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const G = process.env.PI_GLOBAL_ROOT;
const EXT = process.env.QLB_PI_EXTENSION;
const { createJiti } = await import(pathToFileURL(join(G, 'node_modules', 'jiti', 'lib', 'jiti.mjs')).href);
const piAi = join(G, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'compat.js');
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    '@earendil-works/pi-ai/compat': piAi,
    '@earendil-works/pi-ai': piAi,
    '@earendil-works/pi-tui': join(G, 'node_modules', '@earendil-works', 'pi-tui', 'dist', 'index.js'),
    '@earendil-works/pi-coding-agent': join(G, 'dist', 'index.js'),
  },
});
const factory = await jiti.import(EXT, { default: true });

const calls = [];
const POOL = { pool: true, api: 'anthropic-messages', streamSimple: () => { throw new Error('pool used'); } };
const providers = new Map([['anthropic', POOL]]);
const pi = {
  unregisterProvider: (name) => { calls.push(`unregister:${name}`); providers.delete(name); },
  registerProvider: (name, config) => { calls.push(`register:${name}`); providers.set(name, config); },
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
console.log(JSON.stringify({ calls, poolStillRegistered: provider === POOL, events }));
process.exit(0);
