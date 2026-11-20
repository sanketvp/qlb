import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  isPiRpcParent,
  nodeExecutableFromLsof,
  piRpcCallAllowed,
} from '../src/pi-rpc-guard';
import type { PiRpcParent } from '../src/pi-rpc-guard';

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1]);
const MACH_O_64 = Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 1]);
const PI_SIGNALS = { PI_CODING_AGENT: 'true', AI_AGENT: 'pi' };
const CODE_INJECTING_FORMS = [
  '-r /tmp/preload.js', '-r/tmp/preload.js', '--require /tmp/preload.js', '--require=/tmp/preload.js',
  '-e process.exit(0)', '-eprocess.exit(0)', '--eval process.exit(0)', '--eval=process.exit(0)',
  '-p process.version', '-pprocess.version', '--print process.version', '--print=process.version',
  '--import /tmp/preload.mjs', '--import=/tmp/preload.mjs',
  '--loader /tmp/loader.mjs', '--loader=/tmp/loader.mjs',
  '--experimental-loader /tmp/loader.mjs', '--experimental-loader=/tmp/loader.mjs',
  '-i', '--interactive', '-',
];

interface PiFixture {
  tempDir: string;
  root: string;
  distEntry: string;
  bundleEntry: string;
}

function writeExecutable(name: string, contents: Buffer | string, mode = 0o755): string {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-pi-rpc-bin-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return realpathSync(path);
}

function writePiPackage(entries: Array<'dist' | 'bundle'> = ['dist', 'bundle'], name = '@earendil-works/pi-coding-agent'): PiFixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'qlb-pi-rpc-guard-'));
  const root = join(tempDir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name }));
  const distEntry = join(root, 'dist', 'rpc-entry.js');
  const bundleEntry = join(root, 'dist', 'bundle', 'rpc-entry.js');
  if (entries.includes('dist')) writeFileSync(distEntry, 'setInterval(() => {}, 1000);\n');
  if (entries.includes('bundle')) writeFileSync(bundleEntry, 'setInterval(() => {}, 1000);\n');
  return {
    tempDir,
    root: realpathSync(root),
    distEntry: entries.includes('dist') ? realpathSync(distEntry) : distEntry,
    bundleEntry: entries.includes('bundle') ? realpathSync(bundleEntry) : bundleEntry,
  };
}

function titleParent(textExecutable: string, ucomm = 'node'): PiRpcParent {
  return { comm: 'pi-rpc', ucomm, command: 'pi-rpc', textExecutable };
}

function argvParent(command: string, extra: Partial<PiRpcParent> = {}): PiRpcParent {
  return { comm: 'node', command, ...extra };
}

function allowed(parent: PiRpcParent | null, root: string | null, env: NodeJS.ProcessEnv = {}): boolean {
  return piRpcCallAllowed(
    { QLB_PI_TOKEN_CALL: '1', ...env },
    { parent: () => parent, piPackageRoot: () => root, isTty: () => false },
  );
}

async function waitUntil(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe('piRpcCallAllowed', () => {
  it('accepts a macOS pi-rpc title when ucomm, the Node text executable, Pi signals, and an RPC entry agree', () => {
    const fixture = writePiPackage(['dist']);
    const node = writeExecutable('node', ELF);
    assert.equal(allowed(titleParent(node), fixture.root, PI_SIGNALS), true);
    assert.equal(allowed(titleParent(writeExecutable('node', MACH_O_64), 'nodejs'), fixture.root, PI_SIGNALS), true);
    assert.equal(allowed({
      comm: 'pi-rpc\n',
      ucomm: ' Node ',
      command: ' pi-rpc ',
      textExecutable: `${node}\n`,
    }, fixture.root, PI_SIGNALS), true);
  });

  it('accepts the title overwrite when only dist/bundle/rpc-entry.js exists', () => {
    const fixture = writePiPackage(['bundle']);
    assert.equal(allowed(titleParent(writeExecutable('node', ELF)), fixture.root, PI_SIGNALS), true);
  });

  it('accepts a Node symlink whose real path is a Node executable', () => {
    const fixture = writePiPackage(['dist']);
    const realNode = writeExecutable('node', ELF);
    const linkDir = mkdtempSync(join(tmpdir(), 'qlb-pi-rpc-link-'));
    const link = join(linkDir, 'node');
    symlinkSync(realNode, link);
    assert.equal(allowed(titleParent(link), fixture.root, PI_SIGNALS), true);
  });

  it('accepts un-overwritten argv for dist/rpc-entry.js and dist/bundle/rpc-entry.js', () => {
    const fixture = writePiPackage();
    const node = writeExecutable('node', ELF);
    assert.equal(allowed(argvParent(`node ${fixture.distEntry}`), fixture.root), true);
    assert.equal(allowed(argvParent(`nodejs ${fixture.bundleEntry}`, { comm: 'nodejs' }), fixture.root), true);
    assert.equal(allowed(argvParent(`${node} ${fixture.distEntry}`, {
      comm: '/usr/local/bin/node',
      ucomm: 'node',
      textExecutable: node,
    }), fixture.root), true);
    assert.equal(allowed(argvParent(`node --max-old-space-size=64 --inspect=127.0.0.1:0 ${fixture.bundleEntry} --mode rpc`), fixture.root), true);
    assert.equal(allowed(argvParent(`node ${fixture.distEntry}`), fixture.root, { NODE_OPTIONS: '--max-old-space-size=64' }), true);
  });

  it('accepts a quoted RPC entry path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qlb pi rpc '));
    const root = join(tempDir, 'pi');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
    const script = join(root, 'dist', 'rpc-entry.js');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const resolvedRoot = realpathSync(root);
    const resolvedScript = realpathSync(script);
    assert.equal(allowed(argvParent(`node "${resolvedScript}"`), resolvedRoot), true);
  });

  it('uses locatePi when the package root is not injected', () => {
    const fixture = writePiPackage(['dist']);
    const node = writeExecutable('node', ELF);
    assert.equal(piRpcCallAllowed({
      QLB_PI_TOKEN_CALL: '1',
      QLB_PI_PACKAGE_ROOT: fixture.root,
      ...PI_SIGNALS,
    }, {
      parent: () => titleParent(node),
      isTty: () => false,
    }), true);
    assert.equal(piRpcCallAllowed({
      QLB_PI_TOKEN_CALL: '1',
      QLB_PI_PACKAGE_ROOT: join(fixture.tempDir, 'missing'),
      ...PI_SIGNALS,
    }, {
      parent: () => titleParent(node),
      isTty: () => false,
    }), false);
  });

  it('rejects a pi-rpc title when ucomm is missing or is not node', () => {
    const fixture = writePiPackage(['dist']);
    const node = writeExecutable('node', ELF);
    assert.equal(allowed({ comm: 'pi-rpc', command: 'pi-rpc', textExecutable: node }, fixture.root, PI_SIGNALS), false);
    for (const ucomm of ['python3', 'pi-rpc', 'bash', 'node-evil', '']) {
      assert.equal(allowed(titleParent(node, ucomm), fixture.root, PI_SIGNALS), false, ucomm);
    }
  });

  it('rejects a pi-rpc title whose text executable is not a Node binary', () => {
    const fixture = writePiPackage(['dist']);
    const python = writeExecutable('python3', ELF);
    const scriptNode = writeExecutable('node', '#!/bin/sh\n');
    const unexecutable = writeExecutable('node', ELF, 0o644);
    const missing = join(fixture.tempDir, 'missing-node');
    const realNode = writeExecutable('node', ELF);
    const linkDir = mkdtempSync(join(tmpdir(), 'qlb-pi-rpc-bad-link-'));
    const link = join(linkDir, 'node');
    symlinkSync(python, link);

    assert.equal(allowed(titleParent(python), fixture.root, PI_SIGNALS), false);
    assert.equal(allowed(titleParent(scriptNode), fixture.root, PI_SIGNALS), false);
    assert.equal(allowed(titleParent(unexecutable), fixture.root, PI_SIGNALS), false);
    assert.equal(allowed(titleParent(missing), fixture.root, PI_SIGNALS), false);
    assert.equal(allowed(titleParent(link), fixture.root, PI_SIGNALS), false);
    assert.equal(allowed(titleParent(realNode), null, PI_SIGNALS), false);
  });

  it('rejects a pi-rpc title without both Pi env signals', () => {
    const fixture = writePiPackage(['dist']);
    const parent = titleParent(writeExecutable('node', ELF));
    assert.equal(allowed(parent, fixture.root), false);
    assert.equal(allowed(parent, fixture.root, { PI_CODING_AGENT: 'true' }), false);
    assert.equal(allowed(parent, fixture.root, { AI_AGENT: 'pi' }), false);
    assert.equal(allowed(parent, fixture.root, { PI_CODING_AGENT: '1', AI_AGENT: 'pi' }), false);
    assert.equal(allowed(parent, fixture.root, { PI_CODING_AGENT: 'true', AI_AGENT: 'codex' }), false);
  });

  it('rejects a missing Pi package root, a foreign package, and a missing RPC entry', () => {
    const node = writeExecutable('node', ELF);
    const parent = titleParent(node);
    const missing = writePiPackage([], 'not-pi');
    const empty = writePiPackage([]);
    mkdirSync(join(empty.root, 'dist', 'rpc-entry.js'));
    assert.equal(allowed(parent, null, PI_SIGNALS), false);
    assert.equal(allowed(parent, missing.root, PI_SIGNALS), false);
    assert.equal(allowed(parent, empty.root, PI_SIGNALS), false);
    assert.equal(allowed(parent, join(empty.tempDir, 'absent'), PI_SIGNALS), false);
    assert.equal(isPiRpcParent(null, empty.root, { ...PI_SIGNALS, QLB_PI_TOKEN_CALL: '1' }), false);
  });

  it('rejects an RPC entry that resolves outside the package', () => {
    const fixture = writePiPackage([]);
    const outside = join(fixture.tempDir, 'outside.js');
    writeFileSync(outside, 'setInterval(() => {}, 1000);\n');
    symlinkSync(outside, fixture.distEntry);
    const node = writeExecutable('node', ELF);
    assert.equal(allowed(titleParent(node), fixture.root, PI_SIGNALS), false);
    assert.equal(allowed(argvParent(`node ${fixture.distEntry}`), fixture.root), false);
  });

  it('rejects spoofed titles and argv that is not the RPC entry', () => {
    const fixture = writePiPackage();
    const node = writeExecutable('node', ELF);
    const cli = join(fixture.root, 'dist', 'cli.js');
    const runtime = join(fixture.root, 'dist', 'bundle', 'cli-runtime.js');
    writeFileSync(cli, 'setInterval(() => {}, 1000);\n');
    writeFileSync(runtime, 'setInterval(() => {}, 1000);\n');
    const spoofs: PiRpcParent[] = [
      { comm: 'pi', ucomm: 'node', command: 'pi', textExecutable: node },
      { comm: 'pi-rpc-evil', ucomm: 'node', command: 'pi-rpc-evil', textExecutable: node },
      { comm: 'node', ucomm: 'node', command: 'pi-rpc', textExecutable: node },
      { comm: 'pi-rpc', ucomm: 'node', command: `node ${fixture.distEntry}`, textExecutable: node },
      { comm: 'pi-rpc', ucomm: 'node', command: 'pi-rpc --mode rpc', textExecutable: node },
      argvParent(`node ${cli}`),
      argvParent(`node ${runtime}`),
      argvParent(`node /tmp/other.js ${fixture.distEntry}`),
      argvParent(`node ${fixture.distEntry.replace(/^\//, '')}`),
      argvParent(`${writeExecutable('python3', ELF)} ${fixture.distEntry}`, { comm: 'node' }),
    ];
    for (const parent of spoofs) {
      assert.equal(allowed(parent, fixture.root, PI_SIGNALS), false, parent.command);
    }
  });

  it('rejects every code-injecting Node option on an otherwise valid RPC command', () => {
    const fixture = writePiPackage(['dist']);
    for (const form of CODE_INJECTING_FORMS) {
      assert.equal(allowed(argvParent(`node ${form} ${fixture.distEntry}`), fixture.root), false, form);
    }
    assert.equal(allowed(argvParent(`node --heap-prof-name ${fixture.distEntry} -e process.exit(0)`), fixture.root), false);
    assert.equal(allowed(argvParent(`node ${fixture.distEntry} --import /tmp/preload.mjs`), fixture.root), false);
    assert.equal(allowed(argvParent(`node ${fixture.distEntry}`), fixture.root, { NODE_OPTIONS: '-r /tmp/preload.js' }), false);
    assert.equal(allowed(titleParent(writeExecutable('node', ELF)), fixture.root, { ...PI_SIGNALS, NODE_OPTIONS: '--import=/tmp/preload.mjs' }), false);
    assert.equal(allowed(argvParent(`node ${fixture.distEntry}`), fixture.root, { NODE_OPTIONS: '"' }), false);
  });

  it('rejects a Node argv whose ucomm or text executable disagrees', () => {
    const fixture = writePiPackage(['dist']);
    const node = writeExecutable('node', ELF);
    const other = writeExecutable('node', ELF);
    assert.equal(allowed(argvParent(`node ${fixture.distEntry}`, { ucomm: 'python3' }), fixture.root), false);
    assert.equal(allowed(argvParent(`${node} ${fixture.distEntry}`, { textExecutable: other }), fixture.root), false);
    assert.equal(allowed(argvParent(`${node} ${fixture.distEntry}`, { textExecutable: node }), fixture.root), true);
  });

  it('refuses a TTY and any marker other than QLB_PI_TOKEN_CALL=1', () => {
    const fixture = writePiPackage(['dist']);
    const parent = argvParent(`node ${fixture.distEntry}`);
    const deps = { parent: () => parent, piPackageRoot: () => fixture.root, isTty: () => false };
    assert.equal(piRpcCallAllowed({ QLB_PI_TOKEN_CALL: '1' }, { ...deps, isTty: () => true }), false);
    assert.equal(piRpcCallAllowed({}, deps), false);
    assert.equal(piRpcCallAllowed({ QLB_PI_TOKEN_CALL: 'true' }, deps), false);
    assert.equal(piRpcCallAllowed({ QLB_PI_TOKEN_CALL: '0' }, deps), false);
    assert.equal(piRpcCallAllowed({ QLB_PI_TOKEN_CALL: '1 ' }, deps), false);
  });

  it('fails closed without logging when a dependency throws or the parent is absent', () => {
    const calls: string[] = [];
    const methods = ['log', 'error', 'warn', 'info', 'debug'] as const;
    const originals = methods.map((method) => console[method]);
    for (const method of methods) {
      console[method] = ((...args: unknown[]) => {
        calls.push(args.map(String).join(' '));
      }) as typeof console.log;
    }
    try {
      assert.equal(piRpcCallAllowed({ QLB_PI_TOKEN_CALL: '1', FIXTURE_VALUE: 'do-not-print' }, {
        isTty: () => { throw new Error('tty failed'); },
        parent: () => { throw new Error('parent failed'); },
        piPackageRoot: () => { throw new Error('root failed'); },
      }), false);
      assert.equal(piRpcCallAllowed({ QLB_PI_TOKEN_CALL: '1', FIXTURE_VALUE: 'do-not-print' }, {
        isTty: () => false,
        parent: () => { throw new Error('ps failed'); },
        piPackageRoot: () => '/nope',
      }), false);
      assert.equal(allowed(null, '/nope'), false);
      assert.deepEqual(calls, []);
    } finally {
      methods.forEach((method, index) => {
        console[method] = originals[index] as typeof console.log;
      });
    }
  });

  it('does not log or write credential output from the guard module', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'pi-rpc-guard.ts'), 'utf8');
    assert.equal(/\bconsole\./.test(source), false);
    assert.equal(/\bdeliverSecret\b/.test(source), false);
    assert.equal(/\bprocess\.(stdout|stderr)\.write\b/.test(source), false);
  });

  it('fails closed when the live parent is read and the package root is not a Pi package', () => {
    assert.equal(piRpcCallAllowed({ QLB_PI_TOKEN_CALL: '1', ...PI_SIGNALS }, {
      isTty: () => false,
      piPackageRoot: () => null,
    }), false);
  });
});

describe('nodeExecutableFromLsof', () => {
  it('selects the one Node text executable and ignores pid, fd, and library mappings', () => {
    const node = writeExecutable('node', ELF);
    const library = writeExecutable('libsystem.dylib', ELF);
    const output = `p4242\nftxt\nn${node}\nftxt\nn${library}\n`;
    assert.equal(nodeExecutableFromLsof(output), realpathSync(node));
    assert.equal(nodeExecutableFromLsof(`p4242\nn${node}\nn${node}\n`), realpathSync(node));
  });

  it('rejects empty, relative, unexpected, non-node, and ambiguous text mappings', () => {
    const node = writeExecutable('node', ELF);
    const other = writeExecutable('node', MACH_O_64);
    const python = writeExecutable('python3', ELF);
    assert.equal(nodeExecutableFromLsof(''), null);
    assert.equal(nodeExecutableFromLsof('p4242\n'), null);
    assert.equal(nodeExecutableFromLsof('p4242\nnnode\n'), null);
    assert.equal(nodeExecutableFromLsof(`cpi-rpc\nn${node}\n`), null);
    assert.equal(nodeExecutableFromLsof(`p4242\nn${python}\n`), null);
    assert.equal(nodeExecutableFromLsof(`p4242\nn${node}\nn${other}\n`), null);
  });
});

describe('piRpcCallAllowed live parent', () => {
  it('accepts a live node process whose command is the package RPC entry', { timeout: 15_000 }, async () => {
    const fixture = writePiPackage(['dist']);
    const other = writePiPackage(['dist']);
    const child = spawn(process.execPath, [fixture.distEntry], {
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin' },
    });
    child.on('error', () => undefined);
    try {
      const ok = await waitUntil(() => child.pid !== undefined && piRpcCallAllowed(
        { QLB_PI_TOKEN_CALL: '1' },
        { parentPid: child.pid, piPackageRoot: () => fixture.root, isTty: () => false },
      ));
      assert.equal(ok, true);
      assert.equal(child.pid !== undefined && piRpcCallAllowed(
        { QLB_PI_TOKEN_CALL: '1' },
        { parentPid: child.pid, piPackageRoot: () => other.root, isTty: () => false },
      ), false);
      assert.equal(child.pid !== undefined && piRpcCallAllowed(
        {},
        { parentPid: child.pid, piPackageRoot: () => fixture.root, isTty: () => false },
      ), false);
    } finally {
      child.kill('SIGKILL');
      child.unref();
      rmSync(fixture.tempDir, { recursive: true, force: true });
      rmSync(other.tempDir, { recursive: true, force: true });
    }
  });
});
