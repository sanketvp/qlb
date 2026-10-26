import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  claudeConfigHome,
  claudePaths,
  credentialsPath,
  globalConfigPath,
  keychainServiceName,
} from '../src/cc-paths';

function fixtureHome(): string {
  return mkdtempSync(join(tmpdir(), 'qlb-cc-paths-'));
}

describe('Claude Code paths', () => {
  it('uses the default profile when CLAUDE_CONFIG_DIR is unset', () => {
    const home = fixtureHome();
    assert.equal(claudeConfigHome({ home, env: {} }), join(home, '.claude'));
    assert.equal(credentialsPath({ home, env: {} }), join(home, '.claude', '.credentials.json'));
    assert.equal(globalConfigPath({ home, env: {} }), join(home, '.claude.json'));
    assert.equal(keychainServiceName({ home, env: {} }), 'Claude Code-credentials');
  });

  it('uses a configured profile for all Claude Code files and its suffixed Keychain service', () => {
    const home = fixtureHome();
    const profile = join(home, 'fixture-profile');
    const paths = claudePaths({ home, env: { CLAUDE_CONFIG_DIR: profile } });
    assert.equal(paths.configHome, profile);
    assert.equal(paths.credentialsPath, join(profile, '.credentials.json'));
    assert.equal(paths.globalConfigPath, join(profile, '.claude.json'));
    assert.match(paths.keychainService, /^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  it('NFC-normalizes the configured profile only for its Keychain service hash', () => {
    const home = fixtureHome();
    const nfdProfile = join(home, 'cafe\u0301');
    const nfcProfile = nfdProfile.normalize('NFC');
    const expectedSuffix = createHash('sha256').update(nfcProfile, 'utf8').digest('hex').slice(0, 8);

    assert.equal(keychainServiceName({ env: { CLAUDE_CONFIG_DIR: nfdProfile } }), `Claude Code-credentials-${expectedSuffix}`);
    assert.equal(claudeConfigHome({ env: { CLAUDE_CONFIG_DIR: nfdProfile } }), nfdProfile);
  });

  it('matches Claude Code 2.1.299 legacy-global selection', () => {
    const home = fixtureHome();
    const configHome = join(home, '.claude');
    mkdirSync(configHome);
    const legacy = join(configHome, '.config.json');
    const global = join(home, '.claude.json');

    writeFileSync(legacy, '{}');
    assert.equal(globalConfigPath({ home, env: {} }), legacy);

    writeFileSync(legacy, '');
    writeFileSync(global, '{}');
    assert.equal(globalConfigPath({ home, env: {} }), global);

    chmodSync(legacy, 0o400);
    assert.equal(globalConfigPath({ home, env: {} }), global);
  });
});
