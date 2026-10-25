import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  executeToken,
  tokenCallAllowed,
  type TokenCommandDeps,
} from '../src/commands/token';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import { resolve as resolveKimi } from '../src/token/kimi-coding';
import { resolve as resolveOpenRouter } from '../src/token/openrouter';
import { resolve as resolveXai } from '../src/token/xai';

function fakePiScript(): { root: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-token-guard-'));
  const root = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const script = join(root, 'dist', 'bundle', 'host.js');
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
  writeFileSync(script, '#!/usr/bin/env node\n');
  chmodSync(script, 0o755);
  return { root: realpathSync(root), script: realpathSync(script) };
}

function allowedDeps(script: string, root: string): TokenCommandDeps {
  return {
    guard: (env) => tokenCallAllowed(env, {
      parent: () => ({ comm: '/usr/local/bin/node', command: `/usr/local/bin/node ${script}` }),
      piPackageRoot: () => root,
      isTty: () => false,
    }),
  };
}

describe('qlb token', () => {
  it('resolves only the QLB-owned default credential for each supported provider', () => {
    const keychain = new MockKeychain();
    keychain.setSync(qlbKeychainService('xai', 'default'), 'default', JSON.stringify({ access: 'fake-xai-access', refresh: 'fake-xai-refresh', expires: 123 }));
    keychain.setSync(qlbKeychainService('kimi-coding', 'default'), 'default', JSON.stringify({ access: 'fake-kimi-access', refresh: 'fake-kimi-refresh', expires: 456 }));
    keychain.setSync(qlbKeychainService('openrouter', 'default'), 'default', JSON.stringify({ type: 'api-key', access: 'fake-openrouter-key' }));

    assert.deepEqual(resolveXai({ keychain }), { token: 'fake-xai-access', accountId: 'default', expiresAt: 123, source: 'keychain' });
    assert.deepEqual(resolveKimi({ keychain }), { token: 'fake-kimi-access', accountId: 'default', expiresAt: 456, source: 'keychain' });
    assert.deepEqual(resolveOpenRouter({ keychain }), { token: 'fake-openrouter-key', accountId: 'default', source: 'keychain' });
  });

  it('requires the Pi marker, Node direct parent, Pi dist script, and a non-TTY', () => {
    const { root, script } = fakePiScript();
    const parent = () => ({ comm: 'node', command: `node ${script}` });
    const base = { parent, piPackageRoot: () => root, isTty: () => false };

    assert.equal(tokenCallAllowed({ QLB_PI_TOKEN_CALL: '1' }, base), true);
    assert.equal(tokenCallAllowed({}, base), false);
    assert.equal(tokenCallAllowed({ QLB_PI_TOKEN_CALL: '1' }, { ...base, parent: () => ({ comm: 'node', command: 'node /tmp/not-pi.js' }) }), false);
    assert.equal(tokenCallAllowed({ QLB_PI_TOKEN_CALL: '1' }, { ...base, parent: () => ({ comm: 'python3', command: `python3 ${script}` }) }), false);
    assert.equal(tokenCallAllowed({ QLB_PI_TOKEN_CALL: '1' }, { ...base, isTty: () => true }), false);
  });

  it('writes a credential only after S30 passes and refuses all other providers silently', async () => {
    const { root, script } = fakePiScript();
    const output: string[] = [];
    const errors: string[] = [];
    const ctx = {
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
      env: { QLB_PI_TOKEN_CALL: '1' },
      config: {} as never,
      loadConfig: () => ({} as never),
      home: '/tmp/qlb-token-test',
      registerSecret: () => undefined,
    };
    const deps: TokenCommandDeps = {
      ...allowedDeps(script, root),
      resolve: () => ({ token: 'fake-command-access', accountId: 'default', source: 'keychain' }),
    };

    assert.equal(await executeToken(['xai'], ctx, deps), 0);
    assert.deepEqual(output, ['fake-command-access']);
    assert.equal(await executeToken(['anthropic'], ctx, deps), 3);
    assert.deepEqual(errors, []);
    assert.deepEqual(output, ['fake-command-access']);
  });
});
