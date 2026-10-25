import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { describe, it } from 'node:test';

import { createCommandContext, dispatchCommand } from '../src/cli';
import { defaultConfig, resolveConfig } from '../src/config';
import { qlbHomeDir } from '../src/home';

function under(path: string, home: string): boolean {
  const rel = relative(home, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
  const old = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
  Object.assign(process.env, updates);
  for (const [key, value] of Object.entries(updates)) if (value === undefined) delete process.env[key];
  try { return run(); } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('QLB_HOME test-mode paths', () => {
  it('uses QLB_HOME for default config paths only in test mode', () => {
    const home = '/tmp/qlb-home-test';
    const env = { QLB_TEST_MODE: '1', QLB_HOME: home };
    const resolved = resolveConfig({ env, argv: [] });
    const defaults = withEnv(env, () => defaultConfig());
    for (const config of [defaults, resolved]) {
      for (const path of [
        config.dbPath, config.configPath, config.pluginsDir, config.proxyInfoPath,
        config.claudeCodeCredentialsPath, config.codexAuthJsonPath, config.piAuthJsonPath,
      ]) {
        assert.equal(under(path, home), true, `${path} must be under QLB_HOME`);
        assert.equal(under(path, homedir()), false, `${path} must not be under os.homedir()`);
      }
    }
  });

  it('passes QLB_HOME to executing command contexts in test mode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-command-home-'));
    let receivedHome: string | undefined;

    await withEnv({ QLB_TEST_MODE: '1', QLB_HOME: home }, async () => {
      const context = createCommandContext();
      await dispatchCommand(
        ['node', 'qlb', 'fixture'],
        [{ name: 'fixture', execute: (_args, ctx) => { receivedHome = ctx.home; return 0; } }],
        context,
      );
      assert.equal(context.home, home);
    });

    assert.equal(receivedHome, home);
  });

  it('uses homedir() only in the test-mode home resolver', () => {
    const root = join(__dirname, '..', '..');
    const matches = execFileSync('grep', ['-rn', 'homedir()', 'src'], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);

    assert.deepEqual(matches.filter((line) => !line.startsWith('src/home.ts:')), []);
  });

  it('ignores QLB_HOME when test mode is unset', () => {
    assert.equal(qlbHomeDir({ QLB_HOME: '/tmp/qlb-home-test' }), homedir());
  });
});
