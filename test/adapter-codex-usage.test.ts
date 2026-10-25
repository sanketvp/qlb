import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CODEX_USAGE_FALLBACK_URL,
  CODEX_USAGE_WHAM_URL,
  MAX_ROLLOUT_FILES,
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

async function withRolloutDir(test: (authPath: string, writeRollout: (name: string, lines: unknown[], mtimeMs: number) => Promise<void>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'qlb-codex-rollout-'));
  const authPath = join(directory, 'auth.json');
  const sessions = join(directory, 'sessions', '2026', '10', '24');
  await mkdir(sessions, { recursive: true });
  await writeFile(authPath, '{}');
  try {
    await test(authPath, async (name, lines, mtimeMs) => {
      const path = join(sessions, `rollout-${name}.jsonl`);
      await writeFile(path, `${lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`);
      await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function rolloutMeta(id: string): unknown {
  return { type: 'session_meta', payload: { creator_account_id: id } };
}

function rolloutLimits(usedPercent: number): unknown {
  return { type: 'token_count', payload: { rate_limits: { primary: { used_percent: usedPercent } } } };
}

const unknownFetch = async (): Promise<Response> => response(200, { unfamiliar: true });

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

  it('uses the newest active-account rollout file', async () => {
    await withRolloutDir(async (authPath, writeRollout) => {
      await writeRollout('old', [rolloutMeta(accountId), rolloutLimits(10)], 1_000);
      await writeRollout('new', [rolloutMeta(accountId), rolloutLimits(90)], 2_000);
      const result = await probeCodexUsage({ auth, authPath, fetchFn: unknownFetch });
      assert.equal(result.source, 'codex-rollout');
      assert.deepEqual(result.windows, [{ bucket: 'primary', usedPct: 90 }]);
    });
  });

  it('attributes rollouts from session_meta and ignores missing or foreign accounts', async () => {
    await withRolloutDir(async (authPath, writeRollout) => {
      await writeRollout('active', [rolloutMeta(accountId), rolloutLimits(31)], 1_000);
      await writeRollout('foreign', [rolloutMeta('other-account'), rolloutLimits(99)], 3_000);
      await writeRollout('missing', [rolloutLimits(88)], 2_000);
      const result = await probeCodexUsage({ auth, authPath, fetchFn: unknownFetch });
      assert.deepEqual(result.windows, [{ bucket: 'primary', usedPct: 31 }]);
    });
    await withRolloutDir(async (authPath, writeRollout) => {
      await writeRollout('missing-only', [rolloutLimits(88)], 1_000);
      const result = await probeCodexUsage({ auth, authPath, fetchFn: unknownFetch });
      assert.equal(result.source, 'unknown');
    });
  });

  it('uses the final rate_limits event in a rollout file and tolerates a partial trailing line', async () => {
    await withRolloutDir(async (authPath, writeRollout) => {
      await writeRollout('updates', [
        rolloutMeta(accountId),
        ...Array.from({ length: 256 }, () => ({ type: 'message', payload: { text: 'x'.repeat(4_096) } })),
        rolloutLimits(10),
        rolloutLimits(73),
        '{"payload":',
      ], 1_000);
      const result = await probeCodexUsage({ auth, authPath, fetchFn: unknownFetch });
      assert.deepEqual(result.windows, [{ bucket: 'primary', usedPct: 73 }]);
    });
  });

  it('bounds rollout files while streaming large non-rate-limit content', async () => {
    await withRolloutDir(async (authPath, writeRollout) => {
      await writeRollout('old-usable', [rolloutMeta(accountId), rolloutLimits(42)], 1_000);
      for (let index = 0; index < MAX_ROLLOUT_FILES; index += 1) {
        await writeRollout(`new-${index}`, [rolloutMeta('other-account'), { type: 'message', payload: { text: 'x'.repeat(4_096) } }], 2_000 + index);
      }
      const result = await probeCodexUsage({ auth, authPath, fetchFn: unknownFetch });
      assert.equal(result.source, 'unknown');
    });
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
