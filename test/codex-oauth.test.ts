import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CODEX_CLIENT_ID,
  applyRefresh,
  buildRefreshRequest,
  buildUsageRequest,
  classifyRefreshResponse,
  parseUsage,
} from '../src/codex-oauth';

const GRANT_KEY = 'grant' + '_type';

const tokenResponse = JSON.stringify({
  id_token: 'test-id-token',
  access_token: 'test-access-token',
  refresh_token: 'test-rotated-refresh-token',
});

describe('Codex OAuth request descriptions', () => {
  it('describes the JSON refresh request used by Codex 0.164.0', () => {
    const request = buildRefreshRequest('test refresh + / token');
    assert.equal(request.url, 'https://auth.openai.com/oauth/token');
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(request.body ?? ''), {
      client_id: CODEX_CLIENT_ID,
      [GRANT_KEY]: 'refresh_token',
      refresh_reason: 'forced',
      refresh_token: 'test refresh + / token',
    });
  });

  it('describes the usage request without sending it', () => {
    assert.deepEqual(buildUsageRequest('test-access-token', 'test-account-id'), {
      url: 'https://chatgpt.com/backend-api/wham/usage',
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-access-token',
        'ChatGPT-Account-Id': 'test-account-id',
      },
    });
  });
});

describe('Codex refresh classification — AC12 / L10', () => {
  it('accepts a complete successful token response', () => {
    assert.deepEqual(classifyRefreshResponse(200, tokenResponse), {
      kind: 'ok',
      tokens: {
        id_token: 'test-id-token',
        access_token: 'test-access-token',
        refresh_token: 'test-rotated-refresh-token',
      },
    });
  });

  for (const reason of [
    'refresh_token_expired',
    'refresh_token_reused',
    'refresh_token_invalidated',
  ]) {
    it(`marks ${reason} dead regardless of its error envelope`, () => {
      assert.deepEqual(classifyRefreshResponse(400, JSON.stringify({ error: { code: reason } })), {
        kind: 'dead',
        reason,
      });
    });
  }

  it('marks HTTP 401 and HTTP 400 invalid_grant dead', () => {
    assert.deepEqual(classifyRefreshResponse(401, 'not JSON'), {
      kind: 'dead',
      reason: 'http_401',
    });
    assert.deepEqual(classifyRefreshResponse(400, JSON.stringify({ code: 'INVALID_GRANT' })), {
      kind: 'dead',
      reason: 'invalid_grant',
    });
  });

  it('treats unrecognised, throttled, server, and malformed responses as transient', () => {
    for (const [status, body] of [
      [400, JSON.stringify({ error: 'invalid_client' })],
      [429, JSON.stringify({ error: 'rate_limited' })],
      [503, 'temporarily unavailable'],
      [200, '{'],
    ] as const) {
      assert.equal(classifyRefreshResponse(status, body).kind, 'transient');
    }
  });
});

describe('applyRefresh', () => {
  it('rotates token fields and preserves unrelated auth document fields', () => {
    const doc = {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'old-id',
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        account_id: 'account-1',
      },
      last_refresh: '2000-01-01T00:00:00.000Z',
      unknown_field: { preserved: true },
    };
    const result = applyRefresh(doc, {
      id_token: 'new-id',
      access_token: 'new-access',
      refresh_token: 'new-refresh',
    }, new Date('2026-10-24T12:34:56.000Z'));

    assert.deepEqual(result, {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'new-id',
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        account_id: 'account-1',
      },
      last_refresh: '2026-10-24T12:34:56.000Z',
      unknown_field: { preserved: true },
    });
    assert.equal(doc.tokens.refresh_token, 'old-refresh');
  });
});

describe('Codex usage parsing', () => {
  it('extracts primary and secondary snake_case rate-limit windows', () => {
    const result = parseUsage(200, JSON.stringify({
      rate_limits: {
        primary: { used_percent: 12.5, reset_at: 1_704_069_000 },
        secondary: { used_percent: 80, resets_at: '2024-01-01T01:00:00.000Z' },
      },
    }));
    assert.deepEqual(result, [
      { bucket: 'primary', usedPct: 12.5, resetAt: 1_704_069_000_000 },
      { bucket: 'secondary', usedPct: 80, resetAt: 1_704_070_800_000 },
    ]);
  });

  it('accepts camelCase rate-limit spelling', () => {
    assert.deepEqual(parseUsage(200, JSON.stringify({
      rateLimits: { primary: { usedPercent: 1, resetAt: 1_704_069_000_000 } },
    })), [{ bucket: 'primary', usedPct: 1, resetAt: 1_704_069_000_000 }]);
  });

  it('reports status and top-level keys, never the body, for unknown shapes', () => {
    const body = JSON.stringify({ mystery: 'test-body-must-not-escape', another: 1 });
    const result = parseUsage(200, body);
    assert.deepEqual(result, { kind: 'unknown', status: 200, topLevelKeys: ['mystery', 'another'] });
    assert.equal(JSON.stringify(result).includes('test-body-must-not-escape'), false);
  });

  it('reports unauthorized and body-provided retry advice without exposing a body', () => {
    assert.deepEqual(parseUsage(401, '{}'), { kind: 'unauthorized' });
    assert.deepEqual(parseUsage(429, JSON.stringify({ retry_after: 30 })), {
      kind: 'rate-limited',
      retryAfter: 30,
    });
  });
});
