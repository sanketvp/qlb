// TB-A1b (T-B plan): the real Pi request path for QLB-owned xai, kimi-coding
// and openrouter. Runs the installed Pi CLI (`pi -p`) in an isolated agent dir
// with the production qlb-pi extension laid out the way `qlb pi deploy`
// installs it, a fake `qlb` on PATH, and each provider's models.json baseUrl
// pointed at a local stub server. This goes through Pi's own provider
// composer, auth resolution and request runtime, which the jiti fixture in
// qlb-pi-default-export.test.ts bypasses. Skipped when Pi is not installed.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { beginCutover } from '../src/lifecycle';
import { resolvePiPackageRoot } from '../src/pi-integration';
import { openStore } from '../src/store';

const ROOT = join(__dirname, '..', '..');
const PI_ROOT = process.env.QLB_TEST_PI_ROOT ?? resolvePiPackageRoot() ?? '/nonexistent-pi';
const PI_CLI = join(PI_ROOT, 'dist', 'cli.js');
const piAvailable = existsSync(PI_CLI);
const FAKE_QLB = join(ROOT, 'test', 'fixtures', 'qlb-pi-owned', 'fake-qlb.js');

type Provider = 'xai' | 'kimi-coding' | 'openrouter';
/** Ids from Pi 1.6.0's built-in catalog; each provider's models.json baseUrl reroutes them. */
const MODELS: Record<Provider, string> = {
  xai: 'grok-4.6',
  'kimi-coding': 'k3',
  openrouter: '~deepseek/deepseek-flash-latest',
};
const PLACEHOLDER = { type: 'oauth', access: 'qlb-managed', refresh: '', expires: 4_102_444_800_000 };
const NATIVE_OPENROUTER_KEY = 'NATIVE-OPENROUTER-KEY';

interface PiRun {
  code: number | null;
  authorizations: Array<string | null>;
  gateCalls: string[][];
  nativeKeyCommandRan: boolean;
  output: string;
}

function nativeEntry(provider: 'xai' | 'kimi-coding') {
  return { type: 'oauth', access: `${provider}-native-access`, refresh: `${provider}-native-refresh`, expires: Date.now() + 3_600_000 };
}

/**
 * One Pi turn on `provider`. `owned` lists the providers the fixture v2 owner
 * document claims; Pi's auth.json holds the placeholder for owned OAuth
 * providers and a native login otherwise.
 */
async function runPi(provider: Provider, owned: Provider[], opts: { refuse?: boolean } = {}): Promise<PiRun> {
  const home = mkdtempSync(join(tmpdir(), 'qlb-pi-owned-'));
  const agentDir = join(home, '.pi', 'agent');
  const extensionDir = join(agentDir, 'extensions', 'qlb-pi');
  mkdirSync(join(agentDir, 'src'), { recursive: true });
  // The layout `qlb pi deploy` installs (src/pi-deploy.ts): the extension, plus
  // the shared sources beside the extensions directory.
  cpSync(join(ROOT, 'extensions', 'qlb-pi'), extensionDir, { recursive: true });
  for (const file of ['redact.ts', 'pi-owner-document.ts']) cpSync(join(ROOT, 'src', file), join(agentDir, 'src', file));

  const auth: Record<string, unknown> = {};
  for (const oauth of ['xai', 'kimi-coding'] as const) auth[oauth] = owned.includes(oauth) ? PLACEHOLDER : nativeEntry(oauth);
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify(auth));
  writeFileSync(join(agentDir, 'qlb-owner.json'), JSON.stringify({
    providers: Object.fromEntries(owned.map((name) => [name, { mode: 'qlb', since: 1 }])),
  }));
  mkdirSync(join(home, '.qlb'), { recursive: true });
  const store = openStore(join(home, '.qlb', 'qlb.db'));
  beginCutover(store);
  store.close();

  const calls = join(home, 'qlb-calls.jsonl');
  writeFileSync(calls, '');
  const keyCommandMarker = join(home, 'native-key-command-ran');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'qlb'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_QLB}" "$@"\n`);
  chmodSync(join(bin, 'qlb'), 0o755);

  const authorizations: Array<string | null> = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      authorizations.push(req.headers.authorization ?? null);
      // A non-retryable error ends the turn after one request.
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"stub"}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const providerConfig: Record<string, unknown> = { baseUrl };
  if (provider === 'openrouter') {
    // Pi's own `!command` key, as on the live Mac (there it runs `security`).
    providerConfig.apiKey = `!${process.execPath} -e "require('fs').writeFileSync(process.argv[1],'1');process.stdout.write('${NATIVE_OPENROUTER_KEY}')" ${keyCommandMarker}`;
  }
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { [provider]: providerConfig } }));

  try {
    const child = spawn(process.execPath, [
      PI_CLI, '-p', '--no-session', '--offline', '--no-extensions', '-e', join(extensionDir, 'index.ts'),
      '--no-mcp', '--no-skills', '-nc', '-na', '-nt', '--model', `${provider}/${MODELS[provider]}`, 'reply ok',
    ], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        OWNED_CALLS: calls,
        OWNED_REFUSE: opts.refuse ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    clearTimeout(timer);
    const qlbCalls = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
    return {
      code,
      authorizations,
      gateCalls: qlbCalls.filter((call) => call[0] === 'gate'),
      nativeKeyCommandRan: existsSync(keyCommandMarker),
      output,
    };
  } finally {
    server.close();
  }
}

describe('TB-A1b: real Pi 1.6.0 request path for QLB-owned providers', { skip: piAvailable ? false : 'Pi is not installed' }, () => {
  for (const provider of ['xai', 'kimi-coding', 'openrouter'] as const) {
    it(`${provider} owned: one gate call per request, and only the gate token reaches the provider`, async () => {
      const run = await runPi(provider, [provider]);
      assert.deepEqual(run.gateCalls, [['gate', provider, '--json']], run.output);
      assert.deepEqual(run.authorizations, [`Bearer GATE-SENTINEL-${provider}`], run.output);
      if (provider === 'openrouter') {
        assert.equal(run.nativeKeyCommandRan, true, 'Pi still resolved its own models.json key');
        assert.equal(run.authorizations.some((value) => value?.includes(NATIVE_OPENROUTER_KEY)), false);
      }
    });

    it(`${provider} owned, gate refuses: the turn fails closed and nothing reaches the provider`, async () => {
      const run = await runPi(provider, [provider], { refuse: true });
      assert.equal(run.gateCalls.length, 1, run.output);
      assert.deepEqual(run.authorizations, [], run.output);
      assert.notEqual(run.code, 0);
      assert.match(run.output, new RegExp(`QLB unavailable for ${provider} — run qlb doctor \\(credential-unavailable\\)`));
    });

    it(`${provider} not claimed: Pi sends its native credential and calls no gate`, async () => {
      const others = (['xai', 'kimi-coding', 'openrouter'] as const).filter((p) => p !== provider);
      const run = await runPi(provider, [...others]);
      assert.deepEqual(run.gateCalls, [], run.output);
      const native = provider === 'openrouter' ? NATIVE_OPENROUTER_KEY : `${provider}-native-access`;
      assert.deepEqual(run.authorizations, [`Bearer ${native}`], run.output);
    });
  }
});
