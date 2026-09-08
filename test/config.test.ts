import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/config';

describe('configuration precedence', () => {
  it('resolves CLI flag over environment over config file over default', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-config-test-'));
    const configPath = join(home, '.qlb', 'config.json');
    mkdirSync(join(home, '.qlb'));
    writeFileSync(configPath, JSON.stringify({
      anthropicPoolPath: '~/from-file.json',
      piAuthJsonPath: '~/pi-from-file.json',
    }));

    const config = resolveConfig({
      home,
      argv: ['--anthropic-pool-path', '~/from-cli.json'],
      env: {
        QLB_CONFIG_PATH: configPath,
        QLB_ANTHROPIC_POOL_PATH: '~/from-env.json',
        QLB_PI_AUTH_JSON_PATH: '~/pi-from-env.json',
      },
      warn: () => undefined,
    });

    assert.equal(config.anthropicPoolPath, join(home, 'from-cli.json'));
    assert.equal(config.piAuthJsonPath, join(home, 'pi-from-env.json'));
    assert.equal(config.codexAuthJsonPath, join(home, '.codex', 'auth.json'));
    assert.equal(config.defaultStrategy, 'headroom');
  });

  it('resolves defaultStrategy from env/file and rejects unknown names', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-config-strategy-'));
    const configPath = join(home, '.qlb', 'config.json');
    mkdirSync(join(home, '.qlb'));
    writeFileSync(configPath, JSON.stringify({ defaultStrategy: 'spread' }));

    const fromFile = resolveConfig({
      home,
      argv: [],
      env: { QLB_CONFIG_PATH: configPath },
      warn: () => undefined,
    });
    assert.equal(fromFile.defaultStrategy, 'spread');

    const fromEnv = resolveConfig({
      home,
      argv: [],
      env: { QLB_CONFIG_PATH: configPath, QLB_DEFAULT_STRATEGY: 'failover' },
      warn: () => undefined,
    });
    assert.equal(fromEnv.defaultStrategy, 'failover');

    const warnings: string[] = [];
    const invalid = resolveConfig({
      home,
      argv: ['--default-strategy', 'not-a-strategy'],
      env: { QLB_CONFIG_PATH: configPath },
      warn: (m) => warnings.push(m),
    });
    assert.equal(invalid.defaultStrategy, 'headroom');
    assert.ok(warnings.some((w) => /defaultStrategy/.test(w)));
  });

  it('expands both ~/ and ~\\ home prefixes', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-config-home-'));
    const posix = resolveConfig({
      home,
      argv: ['--db-path', '~/posix.db'],
      env: {},
      warn: () => undefined,
    });
    assert.equal(posix.dbPath, join(home, 'posix.db'));

    const win = resolveConfig({
      home,
      argv: ['--db-path', '~\\win.db'],
      env: {},
      warn: () => undefined,
    });
    assert.equal(win.dbPath, join(home, 'win.db'));
  });
});
