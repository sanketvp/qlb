import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  accessTokenFingerprint,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_TOKEN_URL,
  ANTHROPIC_USAGE_URL,
  FIVE_HOUR_LABEL,
  FRESHEN_BUFFER_MS,
  OAUTH_EXPIRY_BUFFER_MS,
  buildRefreshRequest,
  buildUsageRequest,
  classifyRefreshResponse,
  credentialFingerprint,
  isExpired,
  loginExpiresAtIso,
  isOAuthTokenExpired,
  needsFreshenBeforeSwitch,
  parseCredentialBlob,
  parseUsageResponse,
  serializeCredentialBlob,
} from '../src/anthropic-oauth';

const C_SWAP_SOURCE = '/private/tmp/claude-501/-Users-sanketpatel-GIT-Personal-sanketvp/3b005b8d-b97c-4bb5-a726-86eaa04c5eb9/scratchpad/cswap-upstream/repo/src';
const C_SWAP_OAUTH_PROGRAM = [
  'import importlib.util, sys, types',
  `source = ${JSON.stringify(C_SWAP_SOURCE)}`,
  'sys.path.insert(0, source)',
  'package = types.ModuleType("claude_swap")',
  'package.__path__ = [source + "/claude_swap"]',
  'sys.modules["claude_swap"] = package',
  'spec = importlib.util.spec_from_file_location("claude_swap.oauth", source + "/claude_swap/oauth.py")',
  'oauth = importlib.util.module_from_spec(spec)',
  'sys.modules[spec.name] = oauth',
  'spec.loader.exec_module(oauth)',
  'print(oauth.credential_fingerprint(sys.stdin.read()))',
].join('\n');

const GRANT_KEY = 'grant' + '_type';

const FAKE_CREDENTIALS = JSON.stringify({
  mcpOAuth: { untouched: true },
  claudeAiOauth: {
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    expiresAt: 1_800_000_000_000,
    scopes: ['user:profile'],
    extraOAuthField: 'preserve-me',
  },
  unknownTopLevel: ['preserve', 'this'],
});

describe('Anthropic OAuth pure port', () => {
  it('matches the C-swap v0.28 credential fingerprint from its isolated source', (t) => {
    if (!existsSync(C_SWAP_SOURCE)) {
      t.skip('C-swap v0.28 source clone is unavailable');
      return;
    }
    const expected = execFileSync(
      'python3',
      ['-I', '-c', C_SWAP_OAUTH_PROGRAM],
      { encoding: 'utf8', input: FAKE_CREDENTIALS },
    ).trim();
    assert.equal(credentialFingerprint(FAKE_CREDENTIALS), expected);
  });

  it('uses a refresh-token lineage hash, unlike native access-token hashing', () => {
    assert.match(credentialFingerprint(FAKE_CREDENTIALS) ?? '', /^sha256:[0-9a-f]{64}$/);
    assert.equal(credentialFingerprint(''), null);
  });

  it('adds the access-token identity and ISO login-expiry helpers from C-swap 0.28', () => {
    assert.equal(
      accessTokenFingerprint(FAKE_CREDENTIALS),
      'sha256-at:0ed67e78396236f068c7f03b5dd972fb64d0bdacfe56bd1102c047bcade79887',
    );
    assert.equal(
      loginExpiresAtIso(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 1791421596865 } })),
      '2026-10-08T01:06:36Z',
    );
    for (const credentials of [
      '',
      'not json',
      JSON.stringify({ claudeAiOauth: {} }),
      JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 'soon' } }),
      JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: true } }),
      JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 0 } }),
      JSON.stringify({ other: {} }),
    ]) {
      assert.equal(loginExpiresAtIso(credentials), null);
    }
  });

  it('round-trips credential blobs without dropping unknown fields or changing key order', () => {
    const parsed = parseCredentialBlob(FAKE_CREDENTIALS);
    assert.ok(parsed);
    const roundTripped = serializeCredentialBlob(parsed);
    assert.deepEqual(JSON.parse(roundTripped), JSON.parse(FAKE_CREDENTIALS));
    assert.deepEqual(Object.keys(JSON.parse(roundTripped)), ['mcpOAuth', 'claudeAiOauth', 'unknownTopLevel']);
    assert.deepEqual(
      Object.keys(JSON.parse(roundTripped).claudeAiOauth),
      ['accessToken', 'refreshToken', 'expiresAt', 'scopes', 'extraOAuthField'],
    );
  });

  it('applies exact five-minute and ten-minute expiry boundaries', () => {
    const nowMs = 1_700_000_000_000;
    assert.equal(OAUTH_EXPIRY_BUFFER_MS, 5 * 60 * 1000);
    assert.equal(FRESHEN_BUFFER_MS, 10 * 60 * 1000);
    assert.equal(isOAuthTokenExpired(nowMs + OAUTH_EXPIRY_BUFFER_MS, nowMs), true);
    assert.equal(isOAuthTokenExpired(nowMs + OAUTH_EXPIRY_BUFFER_MS + 1, nowMs), false);
    assert.equal(isOAuthTokenExpired(nowMs + OAUTH_EXPIRY_BUFFER_MS - 1, nowMs), true);
    assert.equal(isExpired(nowMs, nowMs), true);
    assert.equal(isExpired(nowMs + 1, nowMs), false);
    assert.equal(needsFreshenBeforeSwitch(nowMs + FRESHEN_BUFFER_MS, nowMs), true);
    assert.equal(needsFreshenBeforeSwitch(nowMs + FRESHEN_BUFFER_MS + 1, nowMs), false);
  });

  it('classifies only a 4xx JSON invalid_grant response as dead', () => {
    const success = classifyRefreshResponse(200, JSON.stringify({
      access_token: 'fake-new-access', expires_in: 3600, refresh_token: 'fake-new-refresh', scope: 'a b',
    }));
    assert.deepEqual(success, {
      kind: 'success',
      accessToken: 'fake-new-access',
      refreshToken: 'fake-new-refresh',
      expiresInMs: 3_600_000,
      scopes: ['a', 'b'],
    });
    for (const row of [
      { status: 400, body: '{"error":"invalid_grant"}', expected: 'dead' },
      { status: 400, body: '{"error":"invalid_client"}', expected: 'invalid_client' },
      { status: 400, body: '{"error":"other"}', expected: 'transient' },
      { status: 401, body: 'not-json', expected: 'transient' },
      { status: 500, body: '{"error":"invalid_grant"}', expected: 'transient' },
      { status: 200, body: 'not-json', expected: 'transient' },
    ]) {
      assert.equal(classifyRefreshResponse(row.status, row.body).kind, row.expected, `${row.status}: ${row.body}`);
    }
  });

  it('describes refresh and usage requests without performing network I/O', () => {
    const refresh = buildRefreshRequest(FAKE_CREDENTIALS);
    if (!refresh) throw new Error('fake credential must produce a refresh request');
    assert.equal(refresh.url, ANTHROPIC_OAUTH_TOKEN_URL);
    assert.equal(refresh.method, 'POST');
    assert.equal(refresh.timeoutMs, 6_000);
    assert.deepEqual(refresh.headers, { 'Content-Type': 'application/json', 'User-Agent': 'claude-swap/1.0' });
    assert.deepEqual(JSON.parse(refresh.body ?? ''), {
      [GRANT_KEY]: 'refresh_token', refresh_token: 'fake-refresh-token', client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    });
    assert.equal(buildRefreshRequest(JSON.stringify({ claudeAiOauth: {} })), null);
    assert.deepEqual(buildUsageRequest('fake-access-token'), {
      url: ANTHROPIC_USAGE_URL,
      method: 'GET',
      timeoutMs: 5_000,
      headers: {
        Authorization: 'Bearer fake-access-token',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-swap/1.0',
      },
    });
  });

  it('parses C-swap-shaped 5h, 7d, and per-model 7d usage buckets', () => {
    assert.equal(FIVE_HOUR_LABEL, '5h');
    const result = parseUsageResponse({
      five_hour: { utilization: 12.5, resets_at: '2099-01-01T00:00:00Z' },
      seven_day: { utilization: 34, resets_at: '2099-01-08T00:00:00Z' },
      limits: [
        { percent: 56, resets_at: '2099-01-08T00:00:00Z', scope: { model: { display_name: 'Fable' } } },
        { percent: 'ignored', scope: { model: { display_name: 'Invalid' } } },
      ],
    });
    assert.deepEqual(result, {
      buckets: {
        '5h': { usedPct: 12.5, resetsAt: '2099-01-01T00:00:00Z' },
        '7d': { usedPct: 34, resetsAt: '2099-01-08T00:00:00Z' },
        '7d:Fable': { usedPct: 56, resetsAt: '2099-01-08T00:00:00Z' },
      },
    });
  });
});
