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
    watchLabel = 'com.sanket.qlb-hermes-watch',
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
          QLB_WATCH_LABEL: watchLabel,
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
    assert.match(config?.message ?? '', /providers \(is not a mapping\)/);
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

  it('still fails hermes:config when config.yaml exists but cannot be read', () => {
    // A directory at the config path: readFileSync throws EISDIR, as it would for EACCES.
    const checks = checksFor('unreadable-config', (_home, hermesHome) => {
      mkdirSync(join(hermesHome, 'config.yaml'));
    });
    assert.equal(checks.some((c) => c.name === 'hermes:integration'), false);
    const config = checks.find((c) => c.name === 'hermes:config');
    assert.equal(config?.level, 'FAIL');
    assert.match(config?.message ?? '', /cannot read/);
  });

  it('treats a config that mentions QLB only in comments as off', () => {
    const checks = checksFor('comment-only', (_home, hermesHome) => {
      writeFileSync(
        join(hermesHome, 'config.yaml'),
        '# previously routed through qlb-anthropic\nmodel:\n  provider: anthropic  # was custom:qlb-anthropic\n',
      );
    });
    assert.deepEqual(checks.map((c) => [c.name, c.level]), [['hermes:integration', 'WARN']]);
  });

  it('recognises QLB provider settings but not incidental mentions', () => {
    const { yamlNamesQlbProvider } = require(MODULE) as { yamlNamesQlbProvider: (yaml: string) => boolean };
    assert.equal(yamlNamesQlbProvider('providers:\n  qlb-anthropic:\n    api: x\n'), true);
    assert.equal(yamlNamesQlbProvider('providers:\n  qlb-codex: {}\n'), true);
    assert.equal(yamlNamesQlbProvider('providers: {qlb-anthropic: {}}\n'), true);
    assert.equal(yamlNamesQlbProvider('providers:\n  "qlb-codex":\n    api: x\n'), true);
    assert.equal(yamlNamesQlbProvider('model:\n  provider: custom:qlb-anthropic\n'), true);
    assert.equal(yamlNamesQlbProvider('# qlb-anthropic: old\nmodel:\n  provider: anthropic\n'), false);
    assert.equal(yamlNamesQlbProvider('model:\n  provider: anthropic # custom:qlb-codex\n'), false);
    assert.equal(yamlNamesQlbProvider('notes:\n  last: removed the qlb-anthropic route\n'), false);
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

  it('keeps checks on for a flow-style primary route, then reports missing provider entries', () => {
    const checks = checksFor('flow-route', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'model: {provider: custom:qlb-anthropic}\n');
    });
    assert.equal(checks.some((c) => c.name === 'hermes:integration'), false);
    assert.equal(checks.find((c) => c.name === 'hermes:config')?.level, 'FAIL');
  });

  it('parses YAML provider traces rather than matching text', () => {
    const { yamlNamesQlbProvider } = require(MODULE) as { yamlNamesQlbProvider: (yaml: string) => boolean };
    assert.equal(yamlNamesQlbProvider('notes: "removed qlb-anthropic: yesterday"\n'), false);
    assert.equal(yamlNamesQlbProvider('notes: |\n  qlb-codex: x\n'), false);
    assert.equal(yamlNamesQlbProvider('a: 1\r\n# qlb-anthropic: old\r\n'), false);
    assert.equal(yamlNamesQlbProvider('{"qlb-codex": {}}'), true);
    assert.equal(yamlNamesQlbProvider('providers: {qlb-anthropic: null}'), true);
    assert.equal(yamlNamesQlbProvider('model: {provider: " custom:qlb-codex "}'), true);
    assert.equal(yamlNamesQlbProvider('providers: [unclosed'), true);
  });

  it('passes full flow-style providers when the plugin is installed', () => {
    const checks = checksFor('flow-providers', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), [
        'providers: {qlb-anthropic: {api: http://127.0.0.1:47391, transport: anthropic_messages, key_cmd: token, session_affinity_header: x-qlb-session}, qlb-codex: {api: http://127.0.0.1:47391/v1, transport: codex_responses, key_cmd: token, session_affinity_header: x-qlb-session}}',
        'model: {provider: custom:qlb-anthropic}',
        '',
      ].join('\n'));
      installPlugin(hermesHome);
    });
    assert.equal(checks.find((c) => c.name === 'hermes:config')?.level, 'PASS');
  });

  it('validates quoted provider keys by content', () => {
    const checks = checksFor('quoted-providers', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), QLB_PROVIDERS.replace(/  qlb-(anthropic|codex):/g, '  "qlb-$1":') + 'model:\n  provider: custom:qlb-anthropic\n');
      installPlugin(hermesHome);
    });
    const config = checks.find((c) => c.name === 'hermes:config');
    assert.equal(config?.level, 'PASS');
    assert.doesNotMatch(config?.message ?? '', /entry absent/);
  });

  it('distinguishes empty and non-mapping provider entries from absent entries', () => {
    const empty = checksFor('empty-entry', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'providers:\n  qlb-anthropic: {}\n  qlb-codex: {}\n');
    }).find((c) => c.name === 'hermes:config');
    assert.match(empty?.message ?? '', /qlb-anthropic\.api/);
    assert.doesNotMatch(empty?.message ?? '', /qlb-anthropic \(entry absent\)/);

    const scalar = checksFor('scalar-entry', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'providers:\n  qlb-anthropic: x\n  qlb-codex: {}\n');
    }).find((c) => c.name === 'hermes:config');
    assert.match(scalar?.message ?? '', /qlb-anthropic \(entry is not a mapping\)/);
  });

  it('fails parse errors and does not treat them as an integration that is off', () => {
    const withPlugin = checksFor('unparseable-plugin', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'providers: [unclosed');
      installPlugin(hermesHome);
    });
    assert.match(withPlugin.find((c) => c.name === 'hermes:config')?.message ?? '', /cannot parse/);

    const alone = checksFor('unparseable-alone', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'providers: [unclosed');
    });
    assert.equal(alone.some((c) => c.name === 'hermes:integration'), false);
  });

  it('accepts a CRLF config', () => {
    const checks = checksFor('crlf-providers', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), `${QLB_PROVIDERS.replace(/\n/g, '\r\n')}model:\r\n  provider: custom:qlb-anthropic\r\n`);
      installPlugin(hermesHome);
    });
    assert.equal(checks.find((c) => c.name === 'hermes:config')?.level, 'PASS');
  });

  it('keeps checks on when only a QLB script or watch agent remains', () => {
    const script = checksFor('script-only', (_home, hermesHome) => {
      const scripts = join(hermesHome, 'scripts');
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(scripts, 'qlb-proxy-token'), '');
    });
    assert.equal(script.some((c) => c.name === 'hermes:integration'), false);

    const label = 'com.example.qlb-hermes-watch';
    const watch = checksFor('watch-only', (home) => {
      const agents = join(home, 'Library', 'LaunchAgents');
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, `${label}.plist`), '<plist/>');
    }, undefined, label);
    assert.equal(watch.some((c) => c.name === 'hermes:integration'), false);
  });

  it('handles a large blank-line config promptly', () => {
    const started = Date.now();
    checksFor('large-config', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), `${'\n'.repeat(60_000)}x: 1\n`);
      installPlugin(hermesHome);
    });
    assert.ok(Date.now() - started < 1_000);
  });
});
