import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    qlbBinName = 'no-such-qlb',
    probeSeams = false,
  ): DoctorCheck[] {
    const home = join(tmp, name);
    const hermesHome = join(home, '.hermes');
    mkdirSync(join(hermesHome, 'hermes-agent'), { recursive: true });
    build(home, hermesHome);
    const out = execFileSync(
      process.execPath,
      ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(MODULE)}).hermesIntegrationChecks({ probeSeams: ${probeSeams} })))`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          HERMES_HOME: hermesHome,
          QLB_HERMES_PLUGIN_STATUS: join(home, '.qlb', 'hermes-plugin.json'),
          QLB_BIN: join(home, qlbBinName),
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

  it('uses the registered hermes:seam fallback when a live seam probe throws', { skip: process.platform === 'win32' }, () => {
    const checks = checksFor('seam-probe-throws', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), QLB_PROVIDERS);
      installPlugin(hermesHome);
      const python = join(hermesHome, 'hermes-agent', 'venv', 'bin', 'python');
      mkdirSync(join(hermesHome, 'hermes-agent', 'venv', 'bin'), { recursive: true });
      writeFileSync(python, '#!/bin/sh\nexit 1\n');
      chmodSync(python, 0o755);
    }, undefined, undefined, 'no-such-qlb', true);
    const seam = checks.find((check) => check.name === 'hermes:seam');
    assert.equal(seam?.level, 'WARN');
    assert.match(seam?.message ?? '', /seam probe failed/);
    assert.equal(checks.some((check) => check.name === 'hermes:seam:anthropicMessagesApi'), false);
  });

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
    assert.ok(Date.now() - started < 2_000);
  });

  it('fails a providers section that is not a mapping', () => {
    const checks = checksFor('providers-scalar', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), 'providers: none\nmodel:\n  provider: custom:qlb-anthropic\n');
      installPlugin(hermesHome);
    });
    const config = checks.find((c) => c.name === 'hermes:config');
    assert.equal(config?.level, 'FAIL');
    assert.match(config?.message ?? '', /providers \(is not a mapping\)/);
  });

  it('keeps the last of repeated keys, as Hermes (PyYAML) does, instead of failing the parse', () => {
    const checks = checksFor('duplicate-keys', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'),
        `${QLB_PROVIDERS}model:\n  provider: anthropic\n  provider: custom:qlb-anthropic\n`);
      installPlugin(hermesHome);
    });
    const config = checks.find((c) => c.name === 'hermes:config');
    assert.equal(config?.level, 'PASS', config?.message ?? 'no hermes:config check');
  });

  it('fails a qlb-codex api that is not a URL ending in /v1, including non-string values', () => {
    for (const [name, api] of [['codex-api-number', '1'], ['codex-api-bool', 'true'], ['codex-api-slash', 'http://127.0.0.1:47391/v1/']]) {
      const checks = checksFor(name, (_home, hermesHome) => {
        writeFileSync(join(hermesHome, 'config.yaml'),
          `${QLB_PROVIDERS.replace('api: http://127.0.0.1:47391/v1', `api: ${api}`)}model:\n  provider: custom:qlb-anthropic\n`);
        installPlugin(hermesHome);
      });
      const config = checks.find((c) => c.name === 'hermes:config');
      assert.equal(config?.level, 'FAIL', `${name}: ${config?.message}`);
      assert.match(config?.message ?? '', /qlb-codex\.api must end in \/v1/);
    }
  });

  it('resolves YAML merge keys the way Hermes (PyYAML) does', () => {
    const checks = checksFor('merge-keys', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), [
        'qlb-providers: &qlb-providers',
        '  qlb-anthropic: {api: http://127.0.0.1:47391, transport: anthropic_messages, key_cmd: token, session_affinity_header: x-qlb-session}',
        '  qlb-codex: {api: http://127.0.0.1:47391/v1, transport: codex_responses, key_cmd: token, session_affinity_header: x-qlb-session}',
        'providers:',
        '  <<: *qlb-providers',
        'model: {provider: custom:qlb-anthropic}',
        '',
      ].join('\n'));
      installPlugin(hermesHome);
    });
    const config = checks.find((c) => c.name === 'hermes:config');
    assert.equal(config?.level, 'PASS', config?.message ?? 'no hermes:config check');
  });

  const darwinOnly = { skip: process.platform !== 'darwin' };

  function writeProxyPlist(home: string, port: string): void {
    const agents = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'com.sanket.qlb-proxy.plist'), `<plist><array><string>--port</string><string>${port}</string></array></plist>`);
  }

  function proxySupervisor(name: string, api: string): DoctorCheck | undefined {
    return checksFor(name, (home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'),
        `${QLB_PROVIDERS.replace('api: http://127.0.0.1:47391\n', `api: ${api}\n`)}model:\n  provider: custom:qlb-anthropic\n`);
      installPlugin(hermesHome);
      writeProxyPlist(home, '47391');
    }).find((c) => c.name === 'hermes:proxy-supervisor');
  }

  it('fails hermes:proxy-supervisor when the launchd port differs from the Hermes api port', darwinOnly, () => {
    const check = proxySupervisor('proxy-port-mismatch', 'http://127.0.0.1:5000');
    assert.equal(check?.level, 'FAIL');
    assert.match(check?.message ?? '', /47391/);
    assert.match(check?.message ?? '', /5000/);
  });

  it('passes hermes:proxy-supervisor when the ports match', darwinOnly, () => {
    assert.equal(proxySupervisor('proxy-port-match', 'http://127.0.0.1:47391')?.level, 'PASS');
  });

  it('compares the effective port when the api spells out the scheme default port', darwinOnly, () => {
    const check = proxySupervisor('proxy-port-default', 'http://127.0.0.1:80');
    assert.equal(check?.level, 'FAIL');
    assert.match(check?.message ?? '', /47391/);
    assert.match(check?.message ?? '', /80/);
  });

  describe('hermes:models', () => {
    const STUB_POLICIES = '{"policies":[{"harness":"codex","virtualModel":"gpt-5.6","realModel":"gpt-5.6"},{"harness":"claude-code","virtualModel":"claude-opus-5-5","realModel":"claude-opus-5-5"}]}';

    function modelsCheck(name: string, config: string): DoctorCheck | undefined {
      return checksFor(name, (home, hermesHome) => {
        writeFileSync(join(hermesHome, 'config.yaml'), config);
        installPlugin(hermesHome);
        const stub = join(home, 'qlb-stub');
        writeFileSync(stub, `#!/bin/sh\ncat <<'EOF'\n${STUB_POLICIES}\nEOF\n`);
        chmodSync(stub, 0o755);
      }, undefined, undefined, 'qlb-stub').find((c) => c.name === 'hermes:models');
    }

    it('warns naming only the QLB models missing from the picker', { skip: process.platform === 'win32' }, () => {
      const config = QLB_PROVIDERS.replace(
        '    transport: anthropic_messages\n',
        '    transport: anthropic_messages\n    models:\n      claude-opus-5-5: {}\n',
      ) + 'model:\n  provider: custom:qlb-anthropic\n';
      const check = modelsCheck('models-missing', config);
      assert.equal(check?.level, 'WARN', check?.message ?? 'no hermes:models check');
      assert.match(check?.message ?? '', /qlb-codex\/gpt-5\.6/);
      assert.doesNotMatch(check?.message ?? '', /qlb-anthropic\/claude-opus-5-5/);
    });

    it('passes when every served model is listed', { skip: process.platform === 'win32' }, () => {
      const config = QLB_PROVIDERS
        .replace('    transport: anthropic_messages\n', '    transport: anthropic_messages\n    models:\n      claude-opus-5-5: {}\n')
        .replace('    transport: codex_responses\n', '    transport: codex_responses\n    models:\n      gpt-5.6: {}\n')
        + 'model:\n  provider: custom:qlb-anthropic\n';
      const check = modelsCheck('models-all', config);
      assert.equal(check?.level, 'PASS', check?.message ?? 'no hermes:models check');
    });
  });

  it('warns on hermes:config when QLB entries are intact but the primary route bypasses QLB', () => {
    const checks = checksFor('route-bypass', (_home, hermesHome) => {
      writeFileSync(join(hermesHome, 'config.yaml'), `${QLB_PROVIDERS}model:\n  provider: anthropic\n`);
      installPlugin(hermesHome);
    });
    const config = checks.find((c) => c.name === 'hermes:config');
    assert.equal(config?.level, 'WARN');
    assert.match(config?.message ?? '', /custom:qlb-anthropic/);
  });
});
