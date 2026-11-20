/**
 * Pi 1.5.2 sets process.title to "pi" / "pi-rpc", and libuv overwrites the ps
 * argv buffer. Interactive `pi` is allowed when `ucomm` is node/nodejs: macOS
 * `ps ucomm`, or the Linux `/proc/<pid>/exe` basename that `parentProcess()`
 * stores in `ucomm`. A snapshot whose `ucomm` is the title, with node proved
 * only by a separate `executable` field, fails closed.
 *
 * `pi-rpc` is allowed only when `piRpcCallAllowed` agrees: `PI_CODING_AGENT=true`,
 * `AI_AGENT=pi`, `dist/rpc-entry.js` or `dist/bundle/rpc-entry.js`, `ucomm` of
 * node/nodejs, and a real `textExecutable`. `ucomm: "pi-rpc"` is refused.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import { tokenCallAllowed } from '../src/commands/token';
import { beginCutover } from '../src/lifecycle';
import { runPiGate } from '../src/pi-gate';
import { openStore } from '../src/store';

const CALLED = { QLB_PI_TOKEN_CALL: '1' };
const PI_SIGNALS = { PI_CODING_AGENT: 'true', AI_AGENT: 'pi' };
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1]);

type TitleParent = {
  comm: string;
  command: string;
  ucomm: string;
  /** Observed `/proc/pid/exe` or lsof txt path. Not a guard field. */
  executable: string;
};

type RpcParent = {
  comm: string;
  command: string;
  ucomm: string;
  textExecutable: string;
};

type TitleReport = {
  snapshot: TitleParent;
  production: boolean;
  injected: boolean;
  checkerStatus: number | null;
  checkerStdout: string;
  checkerStderr: string;
};

function titleParent(parent: TitleParent): () => TitleParent {
  return () => parent;
}

function writeNamedExecutable(name: 'node' | 'nodejs'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'qlb-token-title-bin-')), name);
  writeFileSync(path, ELF);
  chmodSync(path, 0o755);
  return realpathSync(path);
}

function fakePiPackage(): { root: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-token-title-'));
  const root = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const script = join(root, 'dist', 'bundle', 'cli.js');
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
  writeFileSync(script, '#!/usr/bin/env node\n');
  chmodSync(script, 0o755);
  return { root: realpathSync(root), script: realpathSync(script) };
}

function fakePiRpcPackage(entry: 'rpc-entry.js' | 'bundle/rpc-entry.js'): string {
  const { root } = fakePiPackage();
  const entryPath = join(root, 'dist', entry);
  mkdirSync(join(entryPath, '..'), { recursive: true });
  writeFileSync(entryPath, 'setInterval(() => {}, 1000);\n');
  return root;
}

function rpcParent(parent: RpcParent): () => RpcParent {
  return () => parent;
}

function nodeBacked(title: 'pi' | 'pi-rpc', root: string, identity: { ucomm: string; executable: string } = {
  ucomm: 'node',
  executable: process.execPath,
}) {
  return {
    parent: titleParent({ comm: title, command: title, ...identity }),
    piPackageRoot: () => root,
    isTty: () => false,
  };
}

function fixturePath(name: string): string {
  const path = join(__dirname, '..', '..', 'test', 'fixtures', 'process-title', name);
  assert.equal(existsSync(path), true, path);
  return path;
}

function runTitleProbe(title: 'pi' | 'pi-rpc'): TitleReport {
  const { root, script } = fakePiPackage();
  copyFileSync(fixturePath('title-probe.js'), script);
  chmodSync(script, 0o755);
  const tokenModule = join(__dirname, '..', 'src', 'commands', 'token.js');
  assert.equal(existsSync(tokenModule), true, tokenModule);
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, title], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      QLB_PROBE_PI_ROOT: root,
      QLB_TITLE_CHECKER: fixturePath('check-parent.js'),
      QLB_TOKEN_MODULE: tokenModule,
    },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as TitleReport;
}

function fixtureDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'qlb-title-gate-')), 'qlb.db');
  const store = openStore(path);
  beginCutover(store);
  store.close();
  return path;
}

describe('tokenCallAllowed process.title overwrite', () => {
  it('allows an interactive macOS process.title of pi when the process is node', () => {
    const { root } = fakePiPackage();
    const mac = { ucomm: 'node', executable: process.execPath };

    assert.equal(tokenCallAllowed(CALLED, nodeBacked('pi', root, mac)), true,
      'interactive macOS process.title=pi (comm=pi, command=pi, ucomm=node) must pass S30');

    assert.equal(tokenCallAllowed({ QLB_PI_TOKEN_CALL: '1', QLB_PI_PACKAGE_ROOT: root }, {
      parent: titleParent({ comm: 'pi', command: 'pi', ...mac }),
      isTty: () => false,
    }), true);

    assert.equal(tokenCallAllowed(CALLED, nodeBacked('pi', root, {
      ucomm: 'nodejs',
      executable: process.execPath,
    })), true);

    assert.equal(tokenCallAllowed(CALLED, nodeBacked('pi', root, {
      ucomm: 'pi',
      executable: process.execPath,
    })), false, 'ucomm must prove Node; a separate executable field fails closed');
  });

  it('allows an RPC macOS process.title of pi-rpc when the process is node', () => {
    const node = writeNamedExecutable('node');
    const nodejs = writeNamedExecutable('nodejs');
    const root = fakePiRpcPackage('rpc-entry.js');
    const bundleRoot = fakePiRpcPackage('bundle/rpc-entry.js');
    const env = { ...CALLED, ...PI_SIGNALS };
    const allowed: RpcParent = {
      comm: 'pi-rpc',
      command: 'pi-rpc',
      ucomm: 'node',
      textExecutable: node,
    };
    const call = (parent: RpcParent, packageRoot: string, callEnv: NodeJS.ProcessEnv = env): boolean => tokenCallAllowed(callEnv, {
      parent: rpcParent(parent),
      piPackageRoot: () => packageRoot,
      isTty: () => false,
    });

    assert.equal(call(allowed, root), true,
      'RPC macOS process.title=pi-rpc must pass when ucomm and textExecutable are node');
    assert.equal(tokenCallAllowed({ ...env, QLB_PI_PACKAGE_ROOT: root }, {
      parent: rpcParent(allowed),
      isTty: () => false,
    }), true);
    assert.equal(call({ ...allowed, ucomm: 'nodejs', textExecutable: nodejs }, root), true);
    assert.equal(call({ ...allowed, textExecutable: node }, bundleRoot), true);

    assert.equal(call({ ...allowed, ucomm: 'pi-rpc' }, root), false,
      'ucomm overwritten to pi-rpc fails closed even when textExecutable is Node');
    assert.equal(call(allowed, fakePiPackage().root), false, 'dist/rpc-entry.js');
    assert.equal(call(allowed, root, CALLED), false, 'PI_CODING_AGENT and AI_AGENT');
  });

  it('records that process.title overwrites ps argv while the executable stays node', () => {
    for (const title of ['pi', 'pi-rpc'] as const) {
      const report = runTitleProbe(title);
      assert.equal(report.checkerStatus, 0, report.checkerStderr);
      assert.equal(report.snapshot.comm, title);
      assert.equal(report.snapshot.command, title);
      assert.equal(report.snapshot.command.includes('node'), false, report.snapshot.command);
      assert.match(basename(report.snapshot.executable), /^node(?:js)?$/);
      if (process.platform === 'darwin') {
        assert.match(report.snapshot.ucomm, /^node(?:js)?$/);
      } else {
        assert.equal(report.snapshot.ucomm, title);
      }
    }
  });

  it('accepts a live process.title of pi through the production parent check', () => {
    const report = runTitleProbe('pi');
    assert.equal(report.production, true, JSON.stringify(report));
    assert.equal(report.injected, true, JSON.stringify(report));
    assert.match(basename(report.snapshot.executable), /^node(?:js)?$/);
  });

  it('refuses a live pi-rpc title when ps ucomm is the title and textExecutable is absent', () => {
    const report = runTitleProbe('pi-rpc');
    assert.equal(report.production, false, JSON.stringify(report));
    assert.equal(report.injected, false, JSON.stringify(report));
    if (process.platform !== 'darwin') assert.equal(report.snapshot.ucomm, 'pi-rpc');
  });

  it('still allows an un-overwritten node parent running a script inside Pi dist', () => {
    const { root, script } = fakePiPackage();
    assert.equal(tokenCallAllowed(CALLED, {
      parent: titleParent({
        comm: 'node',
        command: `node ${script}`,
        ucomm: 'node',
        executable: process.execPath,
      }),
      piPackageRoot: () => root,
      isTty: () => false,
    }), true);
  });

  it('rejects a pi title when QLB_PI_TOKEN_CALL is unset or not 1', () => {
    const { root } = fakePiPackage();
    const deps = nodeBacked('pi', root);
    assert.equal(tokenCallAllowed({}, deps), false);
    for (const marker of ['', '0', 'true', 'yes', '2']) {
      assert.equal(tokenCallAllowed({ QLB_PI_TOKEN_CALL: marker }, deps), false, marker);
    }
    assert.equal(tokenCallAllowed({}, nodeBacked('pi-rpc', root)), false);
  });

  it('rejects a pi title when stdin or stdout is a TTY', () => {
    const { root, script } = fakePiPackage();
    // Production isTty is `stdin.isTTY === true || stdout.isTTY === true`.
    assert.equal(tokenCallAllowed(CALLED, { ...nodeBacked('pi', root), isTty: () => true }), false);
    assert.equal(tokenCallAllowed(CALLED, { ...nodeBacked('pi-rpc', root), isTty: () => true }), false);
    assert.equal(tokenCallAllowed(CALLED, {
      parent: titleParent({
        comm: 'node',
        command: `node ${script}`,
        ucomm: 'node',
        executable: process.execPath,
      }),
      piPackageRoot: () => root,
      isTty: () => true,
    }), false);
  });

  it('rejects a spoofed pi title when ucomm and the executable are not node', () => {
    const { root } = fakePiPackage();
    const spoofs = [
      { ucomm: 'bash', executable: '/bin/bash' },
      { ucomm: 'python3', executable: '/usr/bin/python3' },
      { ucomm: 'curl', executable: '/usr/bin/curl' },
    ];
    for (const title of ['pi', 'pi-rpc'] as const) {
      for (const spoof of spoofs) {
        assert.equal(tokenCallAllowed(CALLED, nodeBacked(title, root, spoof)), false, `${title} ${spoof.ucomm}`);
      }
      assert.equal(tokenCallAllowed(CALLED, {
        parent: () => ({ comm: title, command: title }),
        piPackageRoot: () => root,
        isTty: () => false,
      }), false, `${title} missing node proof`);
      assert.equal(tokenCallAllowed(CALLED, nodeBacked(title, root, { ucomm: '', executable: '' })), false, title);
    }
    assert.equal(tokenCallAllowed(CALLED, {
      parent: titleParent({ comm: 'pi', command: 'pi-rpc', ucomm: 'node', executable: process.execPath }),
      piPackageRoot: () => root,
      isTty: () => false,
    }), false);
    assert.equal(tokenCallAllowed(CALLED, {
      parent: titleParent({
        comm: 'pi',
        command: 'pi -e process.exit(0)',
        ucomm: 'node',
        executable: process.execPath,
      }),
      piPackageRoot: () => root,
      isTty: () => false,
    }), false);
  });

  it('rejects a pi title when the Pi package root is null or missing', () => {
    const missing = mkdtempSync(join(tmpdir(), 'qlb-token-title-missing-'));
    const parent = titleParent({
      comm: 'pi',
      command: 'pi',
      ucomm: 'node',
      executable: process.execPath,
    });
    assert.equal(tokenCallAllowed(CALLED, {
      parent,
      piPackageRoot: () => null,
      isTty: () => false,
    }), false);
    assert.equal(tokenCallAllowed({ QLB_PI_TOKEN_CALL: '1', QLB_PI_PACKAGE_ROOT: missing }, {
      parent,
      isTty: () => false,
    }), false);
    assert.equal(tokenCallAllowed(CALLED, {
      parent: titleParent({
        comm: 'pi-rpc',
        command: 'pi-rpc',
        ucomm: 'node',
        executable: process.execPath,
      }),
      piPackageRoot: () => null,
      isTty: () => false,
    }), false);
  });

  it('rejects an un-overwritten node command that injects code or leaves Pi dist', () => {
    const { root, script } = fakePiPackage();
    const refusedForms = [
      '-r /tmp/preload.js', '-r/tmp/preload.js', '--require /tmp/preload.js', '--require=/tmp/preload.js',
      '-e process.exit(0)', '-eprocess.exit(0)', '--eval process.exit(0)', '--eval=process.exit(0)',
      '-p process.version', '-pprocess.version', '--print process.version', '--print=process.version',
      '--import /tmp/preload.mjs', '--import=/tmp/preload.mjs',
      '--loader /tmp/loader.mjs', '--loader=/tmp/loader.mjs',
      '--experimental-loader /tmp/loader.mjs', '--experimental-loader=/tmp/loader.mjs',
      '-i', '--interactive',
    ];
    for (const form of refusedForms) {
      assert.equal(tokenCallAllowed(CALLED, {
        parent: titleParent({
          comm: 'node',
          command: `node ${form} ${script}`,
          ucomm: 'node',
          executable: process.execPath,
        }),
        piPackageRoot: () => root,
        isTty: () => false,
      }), false, form);
    }

    const outside = [
      'node /tmp/not-pi.js',
      `node /tmp/other.js ${script}`,
      `node ${join(root, 'package.json')}`,
      'node bundle/cli.js',
    ];
    for (const command of outside) {
      assert.equal(tokenCallAllowed(CALLED, {
        parent: titleParent({ comm: 'node', command, ucomm: 'node', executable: process.execPath }),
        piPackageRoot: () => root,
        isTty: () => false,
      }), false, command);
    }
    assert.equal(tokenCallAllowed(CALLED, {
      parent: titleParent({
        comm: 'python3',
        command: `python3 ${script}`,
        ucomm: 'python3',
        executable: '/usr/bin/python3',
      }),
      piPackageRoot: () => root,
      isTty: () => false,
    }), false);
  });

  it('runPiGate refuses anthropic when the process.title guard rejects', async () => {
    const { root } = fakePiPackage();
    const output: string[] = [];
    let read = false;
    const result = await runPiGate('anthropic', {
      dbPath: fixtureDb(),
      env: {},
      deliver: (value) => output.push(value),
      guard: (env) => tokenCallAllowed(env, nodeBacked('pi', root)),
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      cswapProcesses: () => [],
      provider: {
        read: () => {
          read = true;
          return { token: 'fixture-secret', accountId: 'anthropic-default', source: 'fixture' };
        },
      },
    });
    assert.equal(result, 3);
    assert.equal(read, false);
    assert.deepEqual(output, []);

    const spoofed: string[] = [];
    let spoofRead = false;
    const spoofedResult = await runPiGate('anthropic', {
      dbPath: fixtureDb(),
      env: CALLED,
      deliver: (value) => spoofed.push(value),
      guard: (env) => tokenCallAllowed(env, {
        ...nodeBacked('pi', root, { ucomm: 'bash', executable: '/bin/bash' }),
        isTty: () => false,
      }),
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      cswapProcesses: () => [],
      provider: {
        read: () => {
          spoofRead = true;
          return { token: 'fixture-secret', accountId: 'anthropic-default', source: 'fixture' };
        },
      },
    });
    assert.equal(spoofedResult, 3);
    assert.equal(spoofRead, false);
    assert.deepEqual(spoofed, []);

    const tty: string[] = [];
    let ttyRead = false;
    const ttyResult = await runPiGate('anthropic', {
      dbPath: fixtureDb(),
      env: CALLED,
      deliver: (value) => tty.push(value),
      guard: (env) => tokenCallAllowed(env, { ...nodeBacked('pi', root), isTty: () => true }),
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      cswapProcesses: () => [],
      provider: {
        read: () => {
          ttyRead = true;
          return { token: 'fixture-secret', accountId: 'anthropic-default', source: 'fixture' };
        },
      },
    });
    assert.equal(ttyResult, 3);
    assert.equal(ttyRead, false);
    assert.deepEqual(tty, []);
  });

  it('runPiGate proceeds past the guard for an allowed macOS pi parent', async () => {
    const { root } = fakePiPackage();
    const expiresAt = Date.now() + 3_600_000;
    const output: string[] = [];
    let read = false;
    const result = await runPiGate('anthropic', {
      dbPath: fixtureDb(),
      env: CALLED,
      deliver: (value) => output.push(value),
      guard: (env) => tokenCallAllowed(env, nodeBacked('pi', root)),
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      cswapProcesses: () => [],
      provider: {
        read: () => {
          read = true;
          return { token: 'fixture-secret', accountId: 'anthropic-default', source: 'fixture', expiresAt };
        },
      },
    });
    assert.equal(read, true, 'anthropic gate returned before provider.read because the macOS pi parent was rejected');
    assert.equal(result, 0);
    assert.deepEqual(JSON.parse(output[0]!), {
      token: 'fixture-secret',
      accountId: 'anthropic-default',
      source: 'fixture',
      expiresAt,
    });
  });
});
