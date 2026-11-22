import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { doctorQlb, type DoctorCheck } from '../src/diagnostics';
import { hermesPaths } from '../src/hermes-integration';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import { discoverChecks } from '../src/registry';
import { openStore } from '../src/store';

const cliPath = join(__dirname, '..', 'src', 'cli.js');
const commandsDir = join(__dirname, '..', '..', 'test', 'wiring', 'commands.d');
const checksDir = join(__dirname, '..', '..', 'test', 'wiring', 'checks.d');

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('QLB_') || key.startsWith('HERMES_') || key.startsWith('PI_')) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    QLB_HOME: home,
    QLB_TEST_MODE: '1',
    HERMES_HOME: join(home, '.hermes'),
    QLB_ANTHROPIC_POOL_PATH: join(home, 'missing-anthropic-pool.json'),
    QLB_PI_AUTH_JSON_PATH: join(home, 'missing-pi-auth.json'),
    QLB_CODEX_AUTH_JSON_PATH: join(home, 'missing-codex-auth.json'),
    QLB_KIMI_CREDENTIALS_FILE: join(home, 'missing-kimi-credentials.md'),
    QLB_OPENROUTER_KEYCHAIN_SERVICE: 'qlb-test-wiring-missing-openrouter',
    QLB_DB_PATH: join(home, '.qlb', 'qlb.db'),
    QLB_PLUGINS_DIR: join(home, '.qlb', 'plugins'),
    QLB_PROXY_INFO_PATH: join(home, '.qlb', 'proxy.json'),
    QLB_CLAUDE_CODE_CREDENTIALS_PATH: join(home, '.claude', 'missing-credentials'),
    QLB_CSWAP_SEQUENCE_PATH: join(home, '.claude-swap-backup', 'missing-sequence.json'),
    QLB_CSWAP_USAGE_PATH: join(home, '.claude-swap-backup', 'cache', 'missing-usage.json'),
    QLB_CONFIG_PATH: join(home, '.qlb', 'config.json'),
    QLB_HERMES_PLUGIN_STATUS: join(home, '.qlb', 'hermes-plugin.json'),
    QLB_PI_PACKAGE_ROOT: join(home, 'missing-pi-package'),
  };
}

function run(args: string[], env = isolatedEnv(mkdtempSync(join(tmpdir(), 'qlb-wiring-home-')))): { status: number; stdout: string; stderr: string } {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env }),
      stderr: '',
    };
  } catch (error) {
    const err = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

function entries(dir: string): string[] {
  return readdirSync(dir).sort();
}

/** Run an in-process doctor with HOME (and USERPROFILE) pointing at an empty temp dir. */
async function withEmptyHome<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = mkdtempSync(join(tmpdir(), 'qlb-wiring-empty-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('command and diagnostic wiring', () => {
  it('lists exactly the registered command fragments', () => {
    const result = run(['--list-commands', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), entries(commandsDir));
  });

  it('lists exactly the registered diagnostic fragments', () => {
    const result = run(['doctor', '--list-checks', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), entries(checksDir));
  });

  it('runs exactly the registered diagnostics', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-wiring-home-'));
    const env = isolatedEnv(home);
    const listed = run(['doctor', '--list-checks', '--json'], env);
    const report = run(['doctor', '--json'], env);
    assert.ok(report.status === 0 || report.status === 1, report.stderr);
    const registered = discoverChecks();
    const checks = (JSON.parse(report.stdout) as { checks: Array<{ name: string }> }).checks;
    const emitted = checks.map(({ name }) => {
      const definition = registered.find((check) =>
        check.name === name || (check.prefix != null && name.startsWith(`${check.prefix}:`)),
      );
      assert.ok(definition, `unregistered diagnostic emitted: ${name}`);
      return definition.name;
    });
    assert.deepEqual(emitted, JSON.parse(listed.stdout));
    // These definitions must be backed by doctor execution, not reconciliation's
    // generic synthetic PASS row when this fixture has no store.
    for (const name of ['auto:anthropic:breaker', 'claude:active', 'claude:oauth-client', 'claude:slots', 'codex:slots', 'lifecycle:phase', 'relogin:7d']) {
      const check = (JSON.parse(report.stdout) as { checks: Array<{ name: string; level: string; message: string }> }).checks
        .find((row) => row.name === name);
      assert.ok(check, `missing executed A7 diagnostic: ${name}`);
      assert.notEqual(check.message, 'not applicable on this host');
      assert.notEqual(check.level, 'PASS');
    }
  });

  it('keeps a QLB-owned account mapped to the native-sync prefix diagnostic', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-wiring-owned-home-'));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.upsertAccount('xai-default', 'xai', 'fixture xAI account');
    store.upsertMigration('pi-xai', 'QLB_OWNED', JSON.stringify({
      accounts: [{ id: 'xai-default', provider: 'xai', label: 'fixture xAI account', fingerprint: 'fixture' }],
    }));
    store.close();
    const keychain = new MockKeychain();
    keychain.setSync(
      qlbKeychainService('xai', 'xai-default'),
      'fixture xAI account',
      JSON.stringify({ access: 'fixture-access', refresh: 'fixture-refresh', expires: 0, generation: 0 }),
    );

    const report = await withEmptyHome(() => doctorQlb(config, {
      command: () => '',
      hostCommand: () => '',
      keychain,
      readNativeCredential: async () => ({
        access: 'fixture-access', refresh: 'fixture-refresh', expires: 0, generation: 0,
      }),
      hermes: { paths: hermesPaths({ HERMES_HOME: join(home, '.hermes') }, home) },
      pi: { agentDir: join(home, '.pi', 'agent'), pi: { root: null } },
    }));
    const nativeSync = report.checks.find((check) => check.name === 'native-sync:xai-default');
    assert.equal(nativeSync?.level, 'PASS');
    const definition = discoverChecks().find((check) =>
      check.prefix != null && nativeSync?.name.startsWith(`${check.prefix}:`),
    );
    assert.equal(definition?.name, 'native-sync');
  });

  it('runs the in-process Hermes and Pi checks only against injected paths', { skip: process.platform === 'win32' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-wiring-injected-'));
    const config = defaultConfig(join(root, 'qlb-home'));
    const hermesHome = join(root, 'hermes-home');
    const paths = {
      ...hermesPaths({ HERMES_HOME: hermesHome }, join(root, 'hermes-user')),
      pluginStatus: join(root, 'status', 'td-s6-plugin-status.json'),
    };
    mkdirSync(join(paths.checkout, 'venv', 'bin'), { recursive: true });
    mkdirSync(paths.pluginDir, { recursive: true });
    mkdirSync(join(root, 'status'), { recursive: true });
    writeFileSync(paths.config, [
      'model:',
      '  provider: custom:qlb-anthropic',
      'providers:',
      '  qlb-anthropic:',
      '    api: http://127.0.0.1:47391',
      '    transport: anthropic_messages',
      '    key_cmd: ~/.hermes/scripts/qlb-proxy-token',
      '    session_affinity_header: x-qlb-session',
      '  qlb-codex:',
      '    api: http://127.0.0.1:47391/v1',
      '    transport: codex_responses',
      '    key_cmd: ~/.hermes/scripts/qlb-proxy-token',
      '    session_affinity_header: x-qlb-session',
      '',
    ].join('\n'));
    writeFileSync(join(paths.pluginDir, '__init__.py'), '');
    // Present for existsSync only; running it for real would fail the probe.
    writeFileSync(paths.python, '#!/bin/sh\nexit 1\n');
    chmodSync(paths.python, 0o755);
    const calls: Array<{ cmd: string; cwd?: string; env: Record<string, string> }> = [];
    const run = (cmd: string, _args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): string => {
      calls.push({ cmd, cwd: opts.cwd, env: opts.env ?? {} });
      if (cmd !== paths.python) throw new Error('fixture: qlb policy list unavailable');
      writeFileSync(opts.env?.QLB_HERMES_PLUGIN_STATUS ?? join(root, 'wrong-status.json'), JSON.stringify({
        ok: true, reason: 'td-s6-fixture-patched', written_at: Math.floor(Date.now() / 1000), plugin_version: '9.9.9-td-s6',
      }));
      return JSON.stringify([{ seam: 'agent.anthropic_credentials.anthropic_route_is_oauth', ok: true, params: ['base_url', 'credential', 'provider'] }]);
    };
    const launcher = join(root, 'bin', 'pi');
    const agentDir = join(root, 'pi-agent');
    mkdirSync(join(agentDir, 'extensions', 'qlb-pi'), { recursive: true });

    const report = await withEmptyHome(() => doctorQlb(config, {
      command: () => '',
      hostCommand: () => '',
      keychain: new MockKeychain(),
      hermes: { paths, run, probeSeams: true },
      pi: { agentDir, pi: { root: null, launcher, unresolved: true } },
    }));

    const seamCalls = calls.filter((call) => call.cmd === paths.python);
    assert.equal(seamCalls.length, 1);
    assert.equal(seamCalls[0]?.cwd, paths.checkout);
    assert.equal(seamCalls[0]?.env.HERMES_HOME, paths.home);
    assert.equal(seamCalls[0]?.env.QLB_HERMES_PLUGIN_STATUS, paths.pluginStatus);
    const row = (name: string): DoctorCheck | undefined => report.checks.find((check) => check.name === name);
    assert.equal(row('hermes:seam:anthropic_route_is_oauth')?.level, 'PASS');
    assert.equal(row('hermes:plugin')?.level, 'PASS');
    assert.match(row('hermes:plugin')?.message ?? '', /plugin v9\.9\.9-td-s6 td-s6-fixture-patched/);
    assert.equal(row('pi:extension')?.level, 'WARN');
    assert.ok(row('pi:extension')?.message.includes(launcher), row('pi:extension')?.message ?? 'no pi:extension row');
  });

  it('dispatches multi-word commands by their longest prefix', () => {
    const result = run(['codex', 'gate', '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /qlb codex gate/);
  });
});
