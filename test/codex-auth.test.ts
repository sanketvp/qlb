import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  accessExpiry,
  codexFingerprint,
  codexIdentity,
  needsRefresh,
  parseCodexAuth,
  readCodexAuthStable,
  writeCodexAuthAtomic,
} from '../src/codex-auth';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function validDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const idToken = jwt({
    'https://api.openai.com/auth': {
      chatgpt_user_id: 'user-1',
      chatgpt_account_id: 'claim-account',
      email: 'person@example.test',
    },
  });
  return {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken,
      access_token: jwt({ exp: 2_000_000_000 }),
      refresh_token: 'test-refresh-token',
      account_id: 'stored-account',
    },
    last_refresh: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function parseValid(overrides: Record<string, unknown> = {}) {
  const result = parseCodexAuth(JSON.stringify(validDocument(overrides)));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('expected valid fake fixture');
  return result.doc;
}

describe('codex auth.json helpers', () => {
  it('parses valid documents and preserves unknown fields for round-trip', () => {
    const doc = parseValid({ unknown_top_level: { keep: ['this'] } });
    assert.deepEqual(doc.unknown_top_level, { keep: ['this'] });
    assert.equal(doc.tokens.account_id, 'stored-account');
  });

  it('returns typed errors for malformed, absent, and wiped token documents', () => {
    const malformed = parseCodexAuth('{');
    assert.deepEqual(malformed, { ok: false, error: 'unparseable' });

    const absent = parseCodexAuth(JSON.stringify({ auth_mode: 'chatgpt' }));
    assert.deepEqual(absent, { ok: false, error: 'tokens-absent' });

    const wiped = parseCodexAuth(JSON.stringify({ tokens: {} }));
    assert.deepEqual(wiped, { ok: false, error: 'tokens-empty', status: 'wiped' });
  });

  it('extracts identity only from the namespaced claim and gives stored account ID precedence', () => {
    const doc = parseValid();
    assert.deepEqual(codexIdentity(doc), {
      chatgpt_user_id: 'user-1',
      account_id: 'stored-account',
    });

    const noClaims = parseValid({
      tokens: {
        id_token: jwt({ sub: 'not-an-identity' }),
        access_token: jwt({ exp: 2_000_000_000 }),
        refresh_token: 'test-refresh-token',
        account_id: 'stored-account',
      },
    });
    assert.equal(codexIdentity(noClaims), null);
  });

  it('reads access expiry and applies five-minute and eight-day refresh thresholds', () => {
    const now = 1_700_000_000_000;
    const fresh = parseValid({
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor((now + 301_000) / 1_000) }),
        refresh_token: 'test-refresh-token',
        account_id: 'stored-account',
      },
      last_refresh: new Date(now - 7 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    assert.equal(accessExpiry(fresh), Math.floor((now + 301_000) / 1_000) * 1_000);
    assert.equal(needsRefresh(fresh, now), false);

    const nearExpiry = parseValid({
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor((now + 300_000) / 1_000) }),
        refresh_token: 'test-refresh-token',
        account_id: 'stored-account',
      },
      last_refresh: new Date(now - 7 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    assert.equal(needsRefresh(nearExpiry, now), true);

    const staleRefresh = parseValid({
      last_refresh: new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    assert.equal(needsRefresh(staleRefresh, now), true);
  });

  it('fingerprints only the refresh token with the sha256 prefix', () => {
    const fingerprint = codexFingerprint(parseValid());
    assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
  });

  it('writes atomically at mode 0600 with no temporary file and preserves unknown fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qlb-codex-auth-'));
    const path = join(dir, 'auth.json');
    try {
      const doc = parseValid({ unknown_top_level: { retained: true } });
      await writeCodexAuthAtomic(path, doc);
      const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(written.unknown_top_level, { retained: true });
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      await assert.rejects(stat(`${path}.qlb-tmp`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes concurrently without leaving temporary files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qlb-codex-auth-'));
    const path = join(dir, 'auth.json');
    const docs = Array.from({ length: 8 }, (_, index) => parseValid({
      unknown_top_level: { writer: index },
      last_refresh: `2026-01-0${index + 1}T00:00:00.000Z`,
    }));
    try {
      await Promise.all(docs.map((doc) => writeCodexAuthAtomic(path, doc)));
      const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      assert.ok(docs.some((doc) => isDeepStrictEqual(written, doc)));
      const temporaryFiles = (await readdir(dir)).filter((name) =>
        name.startsWith(`${basename(path)}.qlb-tmp-`),
      );
      assert.deepEqual(temporaryFiles, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not follow a symlink at the old predictable temporary path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qlb-codex-auth-'));
    const path = join(dir, 'auth.json');
    const victim = join(dir, 'victim');
    try {
      await writeFile(victim, 'unchanged', 'utf8');
      await symlink(victim, `${path}.qlb-tmp`);
      const doc = parseValid();
      await writeCodexAuthAtomic(path, doc);
      assert.equal(await readFile(victim, 'utf8'), 'unchanged');
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), doc);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports wiped stable documents and retries truncated reads five times before unstable', async () => {
    const wiped = await readCodexAuthStable('/fake/auth.json', {
      intervalMs: 0,
      sleep: async () => {},
      readFile: async () => JSON.stringify({ tokens: {} }),
    });
    assert.deepEqual(wiped, {
      status: 'wiped',
      error: { ok: false, error: 'tokens-empty', status: 'wiped' },
    });

    let reads = 0;
    const unstable = await readCodexAuthStable('/fake/auth.json', {
      intervalMs: 0,
      retries: 5,
      sleep: async () => {},
      readFile: async () => {
        reads += 1;
        return '{';
      },
    });
    assert.deepEqual(unstable, { status: 'unstable' });
    assert.equal(reads, 10);
  });

  it('accepts matching reads after a changing pair settles', async () => {
    const first = JSON.stringify(validDocument({ last_refresh: '2026-01-01T00:00:00.000Z' }));
    const second = JSON.stringify(validDocument({ last_refresh: '2026-01-02T00:00:00.000Z' }));
    const values = [first, second, second, second];
    const stable = await readCodexAuthStable('/fake/auth.json', {
      intervalMs: 0,
      sleep: async () => {},
      readFile: async () => values.shift() ?? second,
    });
    assert.equal(stable.status, 'ok');
    if (stable.status === 'ok') assert.equal(stable.doc.last_refresh, '2026-01-02T00:00:00.000Z');
  });
});
