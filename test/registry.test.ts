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

  it('redacts short secrets registered by handlers on copied contexts', async () => {
    const secret = 'short';
    const output: string[] = [];
    const context = {
      ...createCommandContext(),
      env: {},
      stderr: (line: string) => output.push(line),
    };

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

  it('redacts registered short secrets but not short credential-like environment values', async () => {
    const registeredSecret = 'tiny';
    const envValue = 'short';
    const nonCredentialValue = 'opaque-home-abc123XYZ';
    const output: string[] = [];
    const context = createCommandContext();
    context.env = { QLB_TEST_TOKEN: envValue, HOME: nonCredentialValue };
    context.stderr = (line: string) => output.push(line);

    assert.equal(await runExecutingCommand({
      command: {
        name: 'fixture',
        execute: (_args, ctx) => {
          ctx.registerSecret(registeredSecret);
          throw new Error(`failed: ${registeredSecret}, ${envValue}, ${nonCredentialValue}`);
        },
      },
      args: [],
    }, context), 1);
    assert.match(output[0], /\[redacted\]/);
    assert.doesNotMatch(output[0], new RegExp(registeredSecret));
    assert.match(output[0], new RegExp(envValue));
    assert.match(output[0], new RegExp(nonCredentialValue));
  });

  it('preserves structured stdout for benign short, numeric, and boolean-like environment values', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const longToken = 'opaque-github-token-abc123XYZ';
    const message = JSON.stringify({
      author: 'Ada',
      booleans: ['true', 'false', 'yes', 'no', 'on', 'off'],
      dead: false,
      expiresAt: 1761320001234,
      count: 10,
      ttl: 3600,
    });
    const context = createCommandContext();
    context.env = {
      GIT_AUTHOR_NAME: 'Ada',
      AUTH_TRUE: 'true',
      AUTH_FALSE: 'false',
      AUTH_YES: 'yes',
      AUTH_NO: 'no',
      AUTH_ON: 'on',
      AUTH_OFF: 'off',
      TOKEN_TTL: '3600',
      GITHUB_TOKEN: longToken,
    };
    context.stdout = (line: string) => stdout.push(line);
    context.stderr = (line: string) => stderr.push(line);

    assert.equal(await runExecutingCommand({
      command: {
        name: 'fixture',
        execute: (_args, ctx) => {
          ctx.stdout(message);
          ctx.stderr(`token: ${longToken}`);
          return 0;
        },
      },
      args: [],
    }, context), 0);
    assert.deepEqual(stdout, [message]);
    assert.doesNotThrow(() => JSON.parse(stdout[0]));
    assert.match(stderr[0], /\[redacted\]/);
    assert.doesNotMatch(stderr[0], new RegExp(longToken));
  });

  it('redacts substring-matched credential environment values on stdout, stderr, and JSON', async () => {
    const values = {
      pgpassword: 'fixture-pgpassword-abc123',
      npmAuthToken: 'fixture-npm-authtoken-abc123',
      authorization: 'Basic dXNlcjpwYXNzd29yZA==',
      httpAuthorization: 'Basic Zml4dHVyZTpwdw==',
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const context = createCommandContext();
    context.env = {
      PGPASSWORD: values.pgpassword,
      NPM_CONFIG__AUTHTOKEN: values.npmAuthToken,
      AUTHORIZATION: values.authorization,
      HTTP_AUTHORIZATION: values.httpAuthorization,
    };
    context.stdout = (line: string) => stdout.push(line);
    context.stderr = (line: string) => stderr.push(line);

    assert.equal(await runExecutingCommand({
      command: {
        name: 'fixture',
        execute: (_args, ctx) => {
          ctx.stdout(`values: ${Object.values(values).join(', ')}`);
          ctx.stdout(JSON.stringify(values));
          ctx.stderr(`values: ${Object.values(values).join(', ')}`);
          return 0;
        },
      },
      args: [],
    }, context), 0);

    for (const value of Object.values(values)) {
      assert.ok(stdout.every((line) => !line.includes(value)));
      assert.ok(stderr.every((line) => !line.includes(value)));
    }
    assert.equal(stdout[0], `values: ${Object.values(values).map(() => '[redacted]').join(', ')}`);
    assert.deepEqual(JSON.parse(stdout[1]), Object.fromEntries(Object.keys(values).map((key) => [key, '[redacted]'])));
    assert.equal(stderr[0], stdout[0]);
  });

  it('keeps the redaction marker intact for registered marker-substring secrets', async () => {
    const secret = 'fixture-runtime-secret-abc123';
    const stdout: string[] = [];
    const context = { ...createCommandContext(), env: {}, stdout: (line: string) => stdout.push(line) };

    assert.equal(await runExecutingCommand({
      command: {
        name: 'fixture',
        execute: (_args, ctx) => {
          ctx.registerSecret('red');
          ctx.registerSecret(secret);
          ctx.stdout(JSON.stringify({ secret, status: 'red' }));
          return 0;
        },
      },
      args: [],
    }, context), 0);
    assert.equal(stdout[0], '{"secret":"[redacted]","status":"[redacted]"}');
    assert.doesNotThrow(() => JSON.parse(stdout[0]));
  });

  it('redacts executing-command output and errors through dispatchCommand', async () => {
    const secret = 'opaque-runtime-abc123XYZ';
    const stdout: string[] = [];
    const stderr: string[] = [];
    const context = {
      ...createCommandContext(),
      env: {},
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    };

    assert.equal(await dispatchCommand(['node', 'qlb', 'fixture'], [{
      name: 'fixture',
      execute: (_args, ctx) => {
        ctx.registerSecret(secret);
        ctx.stdout(`output: ${secret}`);
        throw new Error(`failed: ${secret}`);
      },
    }], context), 1);
    assert.match(stdout[0], /\[redacted\]/);
    assert.doesNotMatch(stdout[0], new RegExp(secret));
    assert.match(stderr[0], /\[redacted\]/);
    assert.doesNotMatch(stderr[0], new RegExp(secret));
  });

  it('rejects duplicate command names and names both modules', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qlb-registry-duplicate-'));
    writeFileSync(join(directory, 'first.js'), "module.exports = { default: { name: 'fixture', run(args) { return args; } } };\n");
    writeFileSync(join(directory, 'second.js'), "module.exports = { default: { name: 'fixture', run(args) { return args; } } };\n");

    assert.throws(
      () => discoverCommands(directory, ['.js']),
      /duplicate command name "fixture" in first\.js and second\.js/,
    );
  });

  it('converts invalid executing-command exit codes to the documented error exit', async () => {
    const output: string[] = [];
    for (const value of [undefined, -1, 1.5, 256, Number.NaN, '1']) {
      const context = createCommandContext();
      context.stderr = (line: string) => output.push(line);
      assert.equal(await runExecutingCommand({
        command: { name: 'fixture', execute: () => value as number },
        args: [],
      }, context), 1);
    }
    assert.equal(output.length, 6);
    assert.ok(output.every((line) => line.includes('invalid exit code (expected integer 0-255)')));
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
