import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ClaudeConfigFileError,
  InMemoryCredentialBackend,
  mergeSharedCredentialFields,
  readClaudeConfig,
  rewriteCredentialsFileIfPresent,
  sharedCredentialFields,
  spliceOauthAccount,
  writeLiveClaudeCredentials,
} from '../src/cc-credentials';
import { claudePaths } from '../src/cc-paths';

function fixtureHome(): string {
  return mkdtempSync(join(tmpdir(), 'qlb-cc-credentials-'));
}

function oauth(access: string, refresh: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh } });
}

describe('Claude Code credentials', () => {
  it('keeps only allowlisted machine-shared fields from the live credential', () => {
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: 'live-access' },
      mcpOAuth: { connection: 'live' },
      trustedDeviceToken: 'live-device',
      futureField: 'live-only',
    });
    const target = JSON.stringify({
      claudeAiOauth: { accessToken: 'target-access' },
      mcpOAuth: { connection: 'stale' },
      trustedDeviceToken: 'target-device',
      futureField: 'target-only',
    });
    const shared = sharedCredentialFields(live);
    assert.deepEqual(shared, { mcpOAuth: { connection: 'live' } });
    const composed = JSON.parse(mergeSharedCredentialFields(target, shared!));
    assert.deepEqual(composed.mcpOAuth, { connection: 'live' });
    assert.equal(composed.trustedDeviceToken, 'target-device');
    assert.equal(composed.futureField, 'target-only');
  });

  it('splices oauthAccount atomically while preserving unrelated config', () => {
    const home = fixtureHome();
    const path = join(home, '.claude.json');
    writeFileSync(path, JSON.stringify({ keep: { nested: true }, oauthAccount: { accountUuid: 'old' } }));
    spliceOauthAccount(path, { accountUuid: 'new', emailAddress: 'fixture@example.invalid' });
    assert.deepEqual(readClaudeConfig(path), {
      keep: { nested: true },
      oauthAccount: { accountUuid: 'new', emailAddress: 'fixture@example.invalid' },
    });
  });

  it('refuses an unparseable config instead of replacing it', () => {
    const home = fixtureHome();
    const path = join(home, '.claude.json');
    writeFileSync(path, '{not json');
    assert.throws(() => spliceOauthAccount(path, { accountUuid: 'new' }), ClaudeConfigFileError);
    assert.equal(readFileSync(path, 'utf8'), '{not json');
  });

  it('rewrites an existing credentials file beside a private QLB temp but never creates it', async () => {
    const home = fixtureHome();
    const configHome = join(home, '.claude');
    mkdirSync(configHome);
    const paths = claudePaths({ home, env: {} });
    assert.equal(rewriteCredentialsFileIfPresent(paths.credentialsPath, oauth('a', 'r')), false);
    assert.equal(existsSync(paths.credentialsPath), false);

    writeFileSync(paths.credentialsPath, oauth('old', 'old'));
    assert.equal(rewriteCredentialsFileIfPresent(paths.credentialsPath, oauth('a', 'r')), true);
    assert.equal(readFileSync(paths.credentialsPath, 'utf8'), oauth('a', 'r'));
    assert.deepEqual(readdirSync(configHome).filter((entry) => entry.includes('.tmp')), []);
    assert.equal(statSync(paths.credentialsPath).mode & 0o777, 0o600);
  });

  it('writes the injected Keychain backend then refreshes only the fixture credentials file', async () => {
    const home = fixtureHome();
    const configHome = join(home, '.claude');
    mkdirSync(configHome);
    const paths = claudePaths({ home, env: {} });
    writeFileSync(paths.credentialsPath, oauth('old', 'old'));
    const backend = new InMemoryCredentialBackend();

    await writeLiveClaudeCredentials(oauth('new', 'new'), {
      paths,
      backend,
      account: 'fixture-user',
    });

    assert.equal(await backend.get(paths.keychainService, 'fixture-user'), oauth('new', 'new'));
    assert.equal(readFileSync(paths.credentialsPath, 'utf8'), oauth('new', 'new'));
  });
});
