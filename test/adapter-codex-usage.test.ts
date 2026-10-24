import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CODEX_USAGE_FALLBACK_URL,
  CODEX_USAGE_WHAM_URL,
  probeCodexUsage,
} from '../src/usage/openai-codex';

const accountId = 'acct-fixture';
const auth = {
  tokens: {
    id_token: 'fixture-id-token',
    access_token: 'fixture-access-token',
    refresh_token: 'fixture-refresh-token',
    account_id: accountId,
  },
};

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('Codex usage adapter', () => {
  it('uses WHAM first with the active account headers and reports parsed source metadata', async () => {
    const calls: Array<{ url: string; authorization: string | null; account: string | null }> = [];
    const result = await probeCodexUsage({
      auth,
      fetchFn: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          authorization: headers.get('Authorization'),
          account: headers.get('ChatGPT-Account-Id'),
        });
        return response(200, { primary: { used_percent: 12, window_minutes: 300 } });
      },
    });

    assert.deepEqual(calls, [{
      url: CODEX_USAGE_WHAM_URL,
      authorization: 'Bearer fixture-access-token',
      account: accountId,
    }]);
    assert.equal(result.status, 200);
    assert.equal(result.source, 'wham');
    assert.deepEqual(result.keys, ['primary']);
    assert.deepEqual(result.windows, [{ bucket: 'primary', usedPct: 12, windowMin: 300 }]);
  });

  it('uses the Codex API fallback only after WHAM returns 404 or an unparseable body', async () => {
    const calls: string[] = [];
    const result = await probeCodexUsage({
      auth,
      fetchFn: async (url) => {
        calls.push(String(url));
        return calls.length === 1
          ? response(404, { message: 'not-found' })
          : response(200, { rate_limits: { secondary: { used_percent: 80 } } });
      },
    });

    assert.deepEqual(calls, [CODEX_USAGE_WHAM_URL, CODEX_USAGE_FALLBACK_URL]);
    assert.equal(result.source, 'codex-api');
    assert.deepEqual(result.windows, [{ bucket: 'secondary', usedPct: 80 }]);
  });

  it('uses only an active-account rollout snapshot when neither HTTP response parses', async () => {
    const result = await probeCodexUsage({
      auth,
      fetchFn: async () => response(200, { unfamiliar: true }),
      readRollout: async () => [
        { accountId: 'other-account', body: { rate_limits: { primary: { used_percent: 99 } } } },
        { accountId, body: { rate_limits: { primary: { used_percent: 31 } } } },
      ],
    });

    assert.equal(result.source, 'codex-rollout');
    assert.equal(result.status, 200);
    assert.deepEqual(result.keys, ['rate_limits']);
    assert.deepEqual(result.windows, [{ bucket: 'primary', usedPct: 31 }]);
  });

  it('returns bounded keys rather than a response body when every source is unknown', async () => {
    const bodySecret = 'eyJhbGciOiJub25lIn0.fixture-payload.fixture-signature';
    const result = await probeCodexUsage({
      auth,
      fetchFn: async () => response(200, { mystery: bodySecret }),
      readRollout: async () => [],
    });

    assert.deepEqual(result, { status: 200, source: 'unknown', keys: ['mystery'] });
    assert.equal(JSON.stringify(result).includes(bodySecret), false);
  });
});
