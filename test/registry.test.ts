import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadProviderStub } from '../src/provider-loader';
import { builtInAdapters } from '../src/adapters';
import {
  KNOWN_PROVIDER_NAMES,
  discoverChecks,
  discoverCommands,
} from '../src/registry';
import {
  createCommandContext,
  dispatchCommand,
  listCommandNames,
  prepareCommandArgv,
  runExecutingCommand,
} from '../src/cli';

describe('registries', () => {
  it('loads source modules when discovery is explicitly given the ts-node extension', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qlb-registry-ts-'));
    writeFileSync(join(directory, 'source-check.ts'), 'export default null\n');
    writeFileSync(join(directory, 'compiled-check.js'), 'module.exports = null\n');
    const loaded: string[] = [];

    const checks = discoverChecks(directory, ['.ts'], (path) => {
      loaded.push(path);
      return { default: { name: 'source:check' } };
    });

    assert.deepEqual(checks, [{ name: 'source:check' }]);
    assert.deepEqual(loaded, [join(directory, 'source-check.ts')]);
  });

  it('refuses invalid provider stub names before path construction or require', () => {
    for (const name of ['../x', 'a/b', 'A']) {
      let joined = false;
      let required = false;
      assert.throws(() => loadProviderStub(name, '/provider-modules', {
        joinPath: () => { joined = true; return '/unexpected'; },
        requireModule: () => { required = true; return {}; },
      }), /unknown provider/);
      assert.equal(joined, false, `${name} reached join()`);
      assert.equal(required, false, `${name} reached require()`);
    }
  });

  it('allows only registry-owned provider names', () => {
    const loaded = loadProviderStub('anthropic', '/provider-modules', {
      joinPath: (...parts) => parts.join('/'),
      requireModule: (path) => ({ path }),
    });
    assert.deepEqual(loaded, { path: '/provider-modules/anthropic' });
    assert.throws(() => loadProviderStub('unknown', '/provider-modules'), /unknown provider/);
  });

  it('keeps provider stub names aligned with built-in adapter ids', () => {
    assert.deepEqual(
      [...KNOWN_PROVIDER_NAMES].sort(),
      builtInAdapters.map((adapter) => adapter.id).sort(),
    );
  });

  it('cleans dist-test registry output before compiling tests', () => {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      scripts: { test: string };
    };
    assert.match(packageJson.scripts.test, /clean-registry-output\.cjs dist-test\/src/);
  });

  it('discovers and dispatches executing fragments by their longest command prefix', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qlb-registry-command-'));
    writeFileSync(
      join(directory, 'short.js'),
      "module.exports = { default: { name: 'fixture', execute(args, ctx) { ctx.stdout(`short:${args.join(',')}`); return 11; } } };\n",
    );
    writeFileSync(
      join(directory, 'long.js'),
      "module.exports = { default: { name: 'fixture deploy', execute(args, ctx) { ctx.stdout(`long:${args.join(',')}`); return args[0] === '--help' ? 0 : 37; } } };\n",
    );
    const commands = discoverCommands(directory, ['.js']);
    const output: string[] = [];
    const context = { ...createCommandContext(), stdout: (line: string) => output.push(line) };

    assert.deepEqual(JSON.parse(JSON.stringify(listCommandNames(commands))), ['fixture', 'fixture deploy']);
    assert.equal(
      await dispatchCommand(['node', 'qlb', 'fixture', 'deploy', '--target', 'temporary'], commands, context),
      37,
    );
    assert.deepEqual(output, ['long:--target,temporary']);
    assert.equal(await dispatchCommand(['node', 'qlb', 'fixture', 'deploy', '--help'], commands, context), 0);
    assert.deepEqual(output, ['long:--target,temporary', 'long:--help']);
  });

  it('redacts credential-like environment values at executing-command error boundaries', async () => {
    const secret = 'opaque-refresh-abc123XYZ';
    const output: string[] = [];
    const context = createCommandContext();
    context.env = { QLB_TEST_REFRESH_TOKEN: secret };
    context.stderr = (line: string) => output.push(line);

    assert.equal(await runExecutingCommand({
      command: { name: 'fixture', execute: () => { throw new Error(`failed: ${secret}`); } },
      args: [],
    }, context), 1);
    assert.match(output[0], /\[redacted\]/);
    assert.doesNotMatch(output[0], new RegExp(secret));
  });

  it('redacts secrets registered by executing handlers at their error boundary', async () => {
    const secret = 'opaque-runtime-abc123XYZ';
    const output: string[] = [];
    const context = createCommandContext();
    context.env = {};
    context.stderr = (line: string) => output.push(line);

    assert.equal(await runExecutingCommand({
      command: {
        name: 'fixture',
        execute: (_args, ctx) => {
          ctx.registerSecret(secret);
          throw new Error(`failed: ${secret}`);
        },
      },
      args: [],
    }, context), 1);
    assert.match(output[0], /\[redacted\]/);
    assert.doesNotMatch(output[0], new RegExp(secret));
  });

  it('does not treat short or non-credential environment values as executing-command secrets', async () => {
    const shortSecret = 'short';
    const nonCredentialValue = 'opaque-home-abc123XYZ';
    const output: string[] = [];
    const context = createCommandContext();
    context.env = { QLB_TEST_TOKEN: shortSecret, HOME: nonCredentialValue };
    context.stderr = (line: string) => output.push(line);

    assert.equal(await runExecutingCommand({
      command: { name: 'fixture', execute: () => { throw new Error(`failed: ${shortSecret}, ${nonCredentialValue}`); } },
      args: [],
    }, context), 1);
    assert.match(output[0], new RegExp(shortSecret));
    assert.match(output[0], new RegExp(nonCredentialValue));
    assert.doesNotMatch(output[0], /\[redacted\]/);
  });

  it('keeps legacy argv-rewrite fragments unchanged', () => {
    assert.deepEqual(
      prepareCommandArgv(['node', 'qlb', 'legacy', 'fragment', '--json'], [
        { name: 'legacy fragment', run: (args) => ['legacy', '--flag', ...args] },
      ]),
      ['node', 'qlb', 'legacy', '--flag', '--json'],
    );
  });

  it('removes stale registry output before a build', () => {
    const dist = mkdtempSync(join(tmpdir(), 'qlb-registry-dist-'));
    const stale = join(dist, 'commands', 'stale.js');
    mkdirSync(join(dist, 'commands'), { recursive: true });
    mkdirSync(join(dist, 'checks'), { recursive: true });
    writeFileSync(stale, 'stale');
    writeFileSync(join(dist, 'checks', 'stale.js'), 'stale');

    execFileSync(process.execPath, ['scripts/clean-registry-output.cjs', dist], { cwd: join(__dirname, '..', '..') });

    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(join(dist, 'checks', 'stale.js')), false);
  });
});
