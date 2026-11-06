import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { loadPlugins } from '../src/plugins';
import { resolveFromSnapshots } from '../src/resolve';

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
        QLB_CSWAP_SEQUENCE_PATH: join(root, 'missing-sequence.json'),
        QLB_CSWAP_USAGE_PATH: join(root, 'missing-usage.json'),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { accounts: Array<{ provider: string }> };
    assert.ok(output.accounts.some((account) => account.provider === 'mistral'));
    assert.match(result.stderr, /skipping plugin broken\.js/);
  });

  it('demotes plugin quota readings to non-actionable display evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-plugin-authority-test-'));
    const pluginsDir = join(root, 'plugins');
    mkdirSync(pluginsDir);
    writeFileSync(join(pluginsDir, 'anthropic.js'), `
      module.exports = {
        id: 'anthropic', displayName: 'Plugin Anthropic',
        async fetchSnapshots() {
          return [{ accountId: 'plugin', provider: 'anthropic', label: 'plugin', buckets: {
            '5h': { usedPct: 10, source: 'provider-poll', confidence: 'authoritative', fetchedAt: Date.now() },
            '7d': { usedPct: 10, source: 'provider-poll', confidence: 'authoritative', fetchedAt: Date.now() }
          }}];
        }
      };
    `);
    const [adapter] = loadPlugins(pluginsDir);
    assert.ok(adapter);
    const snapshots = await adapter.fetchSnapshots();
    assert.equal(snapshots[0]?.buckets['5h']?.source, 'plugin');
    assert.equal(snapshots[0]?.buckets['5h']?.confidence, 'authoritative');
    const decision = resolveFromSnapshots({ model: 'claude-sonnet-5', snapshots });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.error, 'UNAVAILABLE');
  });
});
