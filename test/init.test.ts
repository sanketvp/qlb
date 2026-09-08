import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { initializeQlb } from '../src/diagnostics';

describe('qlb init', () => {
  it('detects all five credential sources and writes a starter config', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-init-test-'));
    const config = defaultConfig(home);
    // Parent credential directories are intentionally represented by temp paths.
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, 'DEV_vault', '04-Security'), { recursive: true });
    writeFileSync(config.anthropicPoolPath, JSON.stringify({ accounts: [{ credentials: { access: 'fake' } }] }));
    writeFileSync(config.piAuthJsonPath, JSON.stringify({ xai: { access: 'fake' } }));
    writeFileSync(config.codexAuthJsonPath, JSON.stringify({ tokens: { access_token: 'fake' } }));
    writeFileSync(config.kimiCredentialsFile, 'sk-kimi-FAKE123');

    const report = initializeQlb(config, () => 'fake-openrouter-key');
    assert.equal(report.overall, 'PASS');
    assert.equal(report.configWritten, true);
    assert.equal(report.providers.length, 5);
    assert.ok(report.providers.every((provider) => provider.level === 'PASS'));

    const starter = JSON.parse(readFileSync(config.configPath, 'utf8')) as Record<string, string>;
    assert.equal(starter.anthropicPoolPath, config.anthropicPoolPath);
    assert.equal(starter.openrouterKeychainService, config.openrouterKeychainService);
    assert.equal(starter.dbPath, config.dbPath);
  });

  it('reports actionable setup instructions and does not overwrite an existing config', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-init-missing-test-'));
    const config = defaultConfig(home);
    mkdirSync(join(home, '.qlb'), { recursive: true });
    writeFileSync(config.configPath, '{"keep":true}\n');

    const report = initializeQlb(config, () => { throw new Error('not found'); });
    assert.equal(report.overall, 'WARN');
    assert.equal(report.configWritten, false);
    assert.ok(report.providers.every((provider) => provider.message.includes('set QLB_')));
    assert.equal(readFileSync(config.configPath, 'utf8'), '{"keep":true}\n');
  });
});
