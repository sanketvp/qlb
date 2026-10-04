import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import type { DoctorCheck } from '../src/diagnostics';

const MODULE = join(__dirname, '..', 'src', 'hermes-integration.js');

const QLB_PROVIDERS = [
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
].join('\n');

describe('hermes integration checks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qlb-hermes-integration-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  // The module resolves its paths from HERMES_HOME / the home directory at import time, so each
  // case runs it in a child process against its own fixture home.
  function checksFor(
    name: string,
    build: (home: string, hermesHome: string) => void,
    launchdLabel = 'com.sanket.qlb-proxy',
  ): DoctorCheck[] {
    const home = join(tmp, name);
    const hermesHome = join(home, '.hermes');
    mkdirSync(join(hermesHome, 'hermes-agent'), { recursive: true });
    build(home, hermesHome);
    const out = execFileSync(
      process.execPath,
      ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(MODULE)}).hermesIntegrationChecks()))`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          HERMES_HOME: hermesHome,
          QLB_HERMES_PLUGIN_STATUS: join(home, '.qlb', 'hermes-plugin.json'),
          QLB_BIN: join(home, 'no-such-qlb'),
          QLB_LAUNCHD_LABEL: launchdLabel,
        },
      },
    );
    return JSON.parse(out) as DoctorCheck[];
  }

  function installPlugin(hermesHome: string): void {
    const dir = join(hermesHome, 'plugins', 'model-providers', 'qlb');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '__init__.py'), '');
  }

  it('reports one WARN, not a failure, when Hermes exists but QLB was never set up for it', () => {
    const checks = checksFor('absent', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: anthropic\nproviders:\n  other:\n    api: https://example.test\n');
    });
    assert.deepEqual(checks.map((c) => [c.name, c.level]), [['hermes:integration', 'WARN']]);
    assert.match(checks[0].message, /not set up/);
  });

  it('still fails hermes:config when the plugin is installed but the provider entries are gone', () => {
    const checks = checksFor('entries-lost', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: anthropic\n');
      installPlugin(hermesHome);
    });
    assert.equal(checks.some((c) => c.name === 'hermes:integration'), false);
    const config = checks.find((c) => c.name === 'hermes:config');
    assert.equal(config?.level, 'FAIL');
    assert.match(config?.message ?? '', /qlb-anthropic \(entry absent\), qlb-codex \(entry absent\)/);
  });

  it('still fails hermes:plugin when the provider entries are present but the plugin is missing', () => {
    const checks = checksFor('plugin-lost', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), QLB_PROVIDERS);
    });
    assert.equal(checks.some((c) => c.name === 'hermes:integration'), false);
    assert.equal(checks.find((c) => c.name === 'hermes:plugin')?.level, 'FAIL');
  });

  it('reports the same WARN for a Hermes checkout that has no config and no QLB artifact', () => {
    const checks = checksFor('never-run', () => {});
    assert.deepEqual(checks.map((c) => [c.name, c.level]), [['hermes:integration', 'WARN']]);
  });

  it('still fails hermes:config when the config is unreadable but the plugin is installed', () => {
    const checks = checksFor('no-config-plugin', (_home, hermesHome) => installPlugin(hermesHome));
    assert.equal(checks.some((c) => c.name === 'hermes:integration'), false);
    const config = checks.find((c) => c.name === 'hermes:config');
    assert.equal(config?.level, 'FAIL');
    assert.match(config?.message ?? '', /cannot read/);
  });

  it('still fails hermes:config for provider entries present in a shape the validator cannot read', () => {
    const checks = checksFor('inline-entries', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'providers:\n  qlb-anthropic: {}\n  qlb-codex: {}\n');
    });
    assert.equal(checks.some((c) => c.name === 'hermes:integration'), false);
    assert.equal(checks.find((c) => c.name === 'hermes:config')?.level, 'FAIL');
    assert.equal(checks.find((c) => c.name === 'hermes:plugin')?.level, 'FAIL');
  });

  it('still fails when only a leftover model.provider route names QLB', () => {
    const checks = checksFor('leftover-route', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: custom:qlb-anthropic\n');
    });
    assert.equal(checks.some((c) => c.name === 'hermes:integration'), false);
    assert.equal(checks.find((c) => c.name === 'hermes:config')?.level, 'FAIL');
  });

  it('runs the full checks when only the proxy supervisor plist remains, under a custom label', () => {
    const label = 'com.example.qlb-proxy';
    const checks = checksFor('custom-label', (home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: anthropic\n');
      const agents = join(home, 'Library', 'LaunchAgents');
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, `${label}.plist`), '<plist/>');
    }, label);
    assert.equal(checks.some((c) => c.name === 'hermes:integration'), false);
    assert.equal(checks.find((c) => c.name === 'hermes:config')?.level, 'FAIL');
  });
});
