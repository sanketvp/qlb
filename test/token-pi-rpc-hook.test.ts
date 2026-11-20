/**
 * `tokenCallAllowed` must accept a Pi RPC parent only by calling `piRpcCallAllowed`
 * before the node-comm checks. A title, a Node `ucomm`, or a package root is not
 * enough: the RPC guard still requires Pi's env signals, an RPC entry, and the
 * lsof text executable.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { tokenCallAllowed } from '../src/commands/token';

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1]);
const MARKER = { QLB_PI_TOKEN_CALL: '1' };
const PI_SIGNALS = { PI_CODING_AGENT: 'true', AI_AGENT: 'pi' };

type RpcSnapshot = {
  comm: string;
  command: string;
  ucomm?: string;
  textExecutable?: string;
  executable?: string;
};

function writeNamedExecutable(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-token-rpc-bin-'));
  const path = join(dir, name);
  writeFileSync(path, ELF);
  chmodSync(path, 0o755);
  return realpathSync(path);
}

function writePiPackage(entry: 'rpc-entry.js' | 'bundle/cli.js'): string {
  const root = join(
    mkdtempSync(join(tmpdir(), 'qlb-token-rpc-pkg-')),
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
  );
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
  writeFileSync(join(root, 'dist', entry), 'setInterval(() => {}, 1000);\n');
  return realpathSync(root);
}

describe('tokenCallAllowed piRpcCallAllowed', () => {
  it('accepts an injected pi-rpc parent only when the S30 RPC guard agrees', () => {
    const node = writeNamedExecutable('node');
    const root = writePiPackage('rpc-entry.js');
    const cliOnly = writePiPackage('bundle/cli.js');
    const entry = join(root, 'dist', 'rpc-entry.js');
    const allowed = {
      comm: 'pi-rpc',
      ucomm: 'node',
      command: 'pi-rpc',
      textExecutable: node,
    };
    const call = (
      parent: RpcSnapshot,
      packageRoot: string,
      env: NodeJS.ProcessEnv = { ...MARKER, ...PI_SIGNALS },
      isTty = false,
    ): boolean => tokenCallAllowed(env, {
      parent: () => parent,
      piPackageRoot: () => packageRoot,
      isTty: () => isTty,
    });

    assert.equal(call(allowed, root), true);

    assert.equal(call(allowed, root, MARKER), false, 'PI_CODING_AGENT and AI_AGENT');
    assert.equal(call(allowed, root, { ...MARKER, PI_CODING_AGENT: 'true' }), false, 'AI_AGENT');
    assert.equal(call(allowed, root, { ...MARKER, AI_AGENT: 'pi' }), false, 'PI_CODING_AGENT');
    assert.equal(call(allowed, cliOnly), false, 'dist/rpc-entry.js');
    assert.equal(call({ comm: 'pi-rpc', ucomm: 'node', command: 'pi-rpc' }, root), false, 'lsof text executable');
    assert.equal(call({
      comm: 'pi-rpc',
      ucomm: 'node',
      command: 'pi-rpc',
      executable: node,
    }, root), false, 'executable is not the lsof text executable');
    assert.equal(call({ ...allowed, ucomm: 'pi-rpc' }, root), false, 'ucomm overwritten to the title');
    assert.equal(call({ ...allowed, ucomm: 'bash', textExecutable: writeNamedExecutable('bash') }, root), false, 'non-node executable');
    assert.equal(call({ ...allowed, comm: 'pi-rpc-evil', command: 'pi-rpc-evil' }, root), false, 'arbitrary title');
    assert.equal(call(allowed, root, { ...MARKER, ...PI_SIGNALS }, true), false, 'TTY');
    for (const marker of ['', '0', 'true', 'yes']) {
      assert.equal(call(allowed, root, { ...PI_SIGNALS, QLB_PI_TOKEN_CALL: marker }), false, marker);
    }
    assert.equal(call(allowed, root, {}), false, 'missing marker');

    for (const form of ['-e process.exit(0)', '-r /tmp/preload.js', '--import /tmp/preload.mjs', '--loader /tmp/loader.mjs']) {
      assert.equal(call({
        comm: 'node',
        ucomm: 'node',
        command: `node ${form} ${entry}`,
        textExecutable: node,
      }, root), false, form);
    }
    assert.equal(call(allowed, root, { ...MARKER, ...PI_SIGNALS, NODE_OPTIONS: '--import=/tmp/preload.mjs' }), false, 'NODE_OPTIONS');
  });

  it('does not let a live non-RPC parent satisfy the hook when no parent is injected', () => {
    const root = writePiPackage('rpc-entry.js');
    assert.equal(tokenCallAllowed({ ...MARKER, ...PI_SIGNALS }, {
      piPackageRoot: () => root,
      isTty: () => false,
    }), false);
  });
});
