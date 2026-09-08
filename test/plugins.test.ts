import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const cliPath = join(__dirname, '..', 'src', 'cli.js');

describe('custom provider plugins', () => {
  it('loads a valid plugin, warns for a broken plugin, and status still succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-plugin-test-'));
    const pluginsDir = join(root, 'plugins');
    mkdirSync(pluginsDir);
    writeFileSync(join(pluginsDir, 'mistral.js'), `
      module.exports = {
        id: 'mistral',
        displayName: 'Mistral Example',
        async fetchSnapshots() {
          return [{
            accountId: 'mistral-test',
            provider: 'mistral',
            label: 'Mistral Test',
            buckets: { daily: { usedPct: 12, source: 'poll', confidence: 'authoritative', fetchedAt: 1 } }
          }];
        }
      };
    `);
    writeFileSync(join(pluginsDir, 'broken.js'), 'module.exports = { this is not valid JavaScript');

    const result = spawnSync(process.execPath, [cliPath, 'status', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        QLB_PLUGINS_DIR: pluginsDir,
        QLB_DB_PATH: join(root, 'qlb.db'),
        QLB_ANTHROPIC_POOL_PATH: join(root, 'missing-anthropic.json'),
        QLB_PI_AUTH_JSON_PATH: join(root, 'missing-pi-auth.json'),
        QLB_CODEX_AUTH_JSON_PATH: join(root, 'missing-codex-auth.json'),
        QLB_KIMI_CREDENTIALS_FILE: join(root, 'missing-kimi.md'),
        QLB_OPENROUTER_KEYCHAIN_SERVICE: 'qlb-test-missing-openrouter',
        QLB_CONFIG_PATH: join(root, 'missing-config.json'),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { accounts: Array<{ provider: string }> };
    assert.ok(output.accounts.some((account) => account.provider === 'mistral'));
    assert.match(result.stderr, /skipping plugin broken\.js/);
  });
});
