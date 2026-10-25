import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
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
    QLB_HOME: home,
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
    // A7 definitions must be backed by doctor execution, not reconciliation's
    // generic synthetic PASS row when this fixture has no store.
    for (const name of ['auto:anthropic:breaker', 'claude:oauth-client', 'claude:slots', 'codex:slots', 'lifecycle:phase', 'relogin:7d']) {
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
    store.upsertMigration('pi-xai', 'QLB_OWNED');
    store.close();
    const keychain = new MockKeychain();
    keychain.setSync(
      qlbKeychainService('xai', 'xai-default'),
      'fixture xAI account',
      JSON.stringify({ access: 'fixture-access', refresh: 'fixture-refresh', expires: 0, generation: 0 }),
    );

    const report = await doctorQlb(config, {
      command: () => '',
      hostCommand: () => '',
      keychain,
      readNativeCredential: async () => ({
        access: 'fixture-access', refresh: 'fixture-refresh', expires: 0, generation: 0,
      }),
    });
    const nativeSync = report.checks.find((check) => check.name === 'native-sync:xai-default');
    assert.equal(nativeSync?.level, 'PASS');
    const definition = discoverChecks().find((check) =>
      check.prefix != null && nativeSync?.name.startsWith(`${check.prefix}:`),
    );
    assert.equal(definition?.name, 'native-sync');
  });

  it('dispatches multi-word commands by their longest prefix', () => {
    const result = run(['codex', 'gate', '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /qlb codex gate/);
  });
});
