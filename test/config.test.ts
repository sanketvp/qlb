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
