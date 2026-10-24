import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CODEX_CLIENT_ID,
  applyRefresh,
  buildRefreshRequest,
  buildUsageRequest,
  refreshReasonFor,
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
    const request = buildRefreshRequest('test refresh + / token', 'forced');
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

  it('maps all refresh triggers to Codex refresh reasons', () => {
    const cases = [
      ['proactive-expiry', 'proactive_expiry'],
      ['scheduled', 'scheduled'],
      ['unauthorized', 'unauthorized_recovery'],
      ['force', 'forced'],
    ] as const;

    for (const [trigger, reason] of cases) {
      assert.equal(refreshReasonFor(trigger), reason);
      assert.equal(
        JSON.parse(buildRefreshRequest('test refresh + / token', refreshReasonFor(trigger)).body ?? '')
          .refresh_reason,
        reason,
      );
    }
    assert.notEqual(refreshReasonFor('proactive-expiry'), 'forced');
    assert.notEqual(refreshReasonFor('scheduled'), 'forced');
    assert.notEqual(refreshReasonFor('unauthorized'), 'forced');
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

  it('redacts credentials when a request descriptor is JSON serialized', () => {
    const refresh = buildRefreshRequest('fake-refresh-secret', 'forced');
    const usage = buildUsageRequest('fake-access-secret', 'test-account-id');

    assert.equal(JSON.stringify(refresh).includes('fake-refresh-secret'), false);
    assert.equal(JSON.stringify(usage).includes('fake-access-secret'), false);
    assert.match(JSON.stringify(refresh), /\[redacted\]/);
    assert.match(JSON.stringify(usage), /Bearer \[redacted\]/);
  });

  it('rejects the store sentinel instead of using it as tokens.account_id', () => {
    assert.throws(() => buildUsageRequest('test-access-token', 'codex-default'));
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

  it('accepts partial successful token responses', () => {
    assert.deepEqual(classifyRefreshResponse(200, JSON.stringify({
      access_token: 'test-access-token',
      refresh_token: 'test-rotated-refresh-token',
    })), {
      kind: 'ok',
      tokens: {
        access_token: 'test-access-token',
        refresh_token: 'test-rotated-refresh-token',
      },
    });
    assert.deepEqual(classifyRefreshResponse(200, JSON.stringify({
      id_token: 'test-id-token',
      access_token: 'test-access-token',
    })), {
      kind: 'ok',
      tokens: {
        id_token: 'test-id-token',
        access_token: 'test-access-token',
      },
    });
    assert.deepEqual(classifyRefreshResponse(200, JSON.stringify({
      refresh_token: 'test-rotated-refresh-token',
    })), {
      kind: 'ok',
      tokens: { refresh_token: 'test-rotated-refresh-token' },
    });
  });

  it('rejects successful responses with no non-empty token fields', () => {
    for (const body of [
      JSON.stringify({ id_token: '', access_token: '', refresh_token: '' }),
      JSON.stringify([]),
      JSON.stringify('x'),
      JSON.stringify({}),
    ]) {
      assert.deepEqual(classifyRefreshResponse(200, body), {
        kind: 'transient',
        reason: 'invalid_success_response',
      });
    }
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

  it('keeps a provider reason from a 401 response', () => {
    assert.deepEqual(classifyRefreshResponse(401, JSON.stringify({
      error: { code: 'refresh_token_reused' },
    })), {
      kind: 'dead',
      reason: 'refresh_token_reused',
    });
    assert.deepEqual(classifyRefreshResponse(401, JSON.stringify({ code: 'invalid_grant' })), {
      kind: 'dead',
      reason: 'invalid_grant',
    });
  });

  it('marks bare HTTP 401 and HTTP 400 invalid_grant dead', () => {
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

  it('applies partial rotations without mutating the input document', () => {
    const doc = {
      tokens: {
        id_token: 'old-id',
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        account_id: 'account-1',
      },
      last_refresh: '2000-01-01T00:00:00.000Z',
    };
    const tokens = {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
    };
    const result = applyRefresh(doc, tokens, new Date('2026-10-24T12:34:56.000Z'));

    assert.deepEqual(result, {
      tokens: {
        id_token: 'old-id',
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        account_id: 'account-1',
      },
      last_refresh: '2026-10-24T12:34:56.000Z',
    });
    assert.deepEqual(doc, {
      tokens: {
        id_token: 'old-id',
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        account_id: 'account-1',
      },
      last_refresh: '2000-01-01T00:00:00.000Z',
    });
  });

  it('applies a refresh-token-only successful rotation without losing other tokens', () => {
    const result = applyRefresh({
      tokens: {
        id_token: 'old-id',
        access_token: 'old-access',
        refresh_token: 'old-refresh',
      },
    }, { refresh_token: 'new-refresh' }, new Date('2026-10-24T12:34:56.000Z'));

    assert.deepEqual(result.tokens, {
      id_token: 'old-id',
      access_token: 'old-access',
      refresh_token: 'new-refresh',
    });
  });

  it('does not overwrite a stored token with an undefined own property', () => {
    const result = applyRefresh({
      tokens: { refresh_token: 'old-refresh' },
    }, {
      refresh_token: undefined,
    }, new Date('2026-10-24T12:34:56.000Z'));

    assert.deepEqual(result, {
      tokens: { refresh_token: 'old-refresh' },
      last_refresh: '2026-10-24T12:34:56.000Z',
    });
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

  it('does not parse windows from non-success statuses', () => {
    const body = JSON.stringify({ rate_limits: { primary: { used_percent: 10 } } });
    assert.deepEqual(parseUsage(403, body), { kind: 'http_error', status: 403 });
    assert.deepEqual(parseUsage(500, body), { kind: 'http_error', status: 500 });
  });

  it('uses a numeric Retry-After header when the 429 body has none and bounds it', () => {
    assert.deepEqual(parseUsage(429, '{}', { 'Retry-After': '30' }), {
      kind: 'rate-limited',
      retryAfter: 30,
    });
    assert.deepEqual(parseUsage(429, JSON.stringify({ retry_after: -1 })), {
      kind: 'rate-limited',
      retryAfter: 0,
    });
    assert.deepEqual(parseUsage(429, '{}', { 'retry-after': '999999' }), {
      kind: 'rate-limited',
      retryAfter: 86_400,
    });
  });

  it('clamps used percentage and retains window minutes', () => {
    assert.deepEqual(parseUsage(200, JSON.stringify({
      primary: { used_percent: 101, window_minutes: 15 },
      secondary: { used_percent: -1 },
    })), [
      { bucket: 'primary', usedPct: 100, clamped: true, windowMin: 15 },
      { bucket: 'secondary', usedPct: 0, clamped: true },
    ]);
  });

  it('bounds metadata for unknown usage shapes', () => {
    const body = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [
      `${String(index).padStart(2, '0')}-${'x'.repeat(70)}`,
      index,
    ]));
    const result = parseUsage(200, JSON.stringify(body));
    assert.equal(Array.isArray(result), false);
    assert.deepEqual(result, {
      kind: 'unknown',
      status: 200,
      topLevelKeys: Object.keys(body).slice(0, 20).map((key) => key.slice(0, 64)),
    });
  });
});
