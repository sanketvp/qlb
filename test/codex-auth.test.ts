import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  accessExpiry,
  codexFingerprint,
  codexIdentity,
  codexSlotIdFromAccessToken,
  idTokenClaimNames,
  authTime,
  needsRefresh,
  parseCodexAuth,
  readCodexAuthStable,
  readCodexAuthStableWithStat,
  writeCodexAuthAtomic,
} from '../src/codex-auth';
import { redactSecrets } from '../src/redact';

const fs: typeof import('node:fs') = require('node:fs');

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

  it('accepts token documents without an account ID as valid rather than wiped', async () => {
    for (const accountId of [null, undefined]) {
      const document = validDocument();
      const tokens = document.tokens as Record<string, unknown>;
      if (accountId === undefined) delete tokens.account_id;
      else tokens.account_id = accountId;
      const text = JSON.stringify(document);

      const parsed = parseCodexAuth(text);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error('expected valid fake fixture');
      assert.equal(parsed.doc.tokens.account_id, accountId);

      const stable = await readCodexAuthStable('/fake/auth.json', {
        intervalMs: 0,
        sleep: async () => {},
        readFile: async () => text,
      });
      assert.equal(stable.status, 'ok');
    }
  });

  it('drops a non-string last_refresh while preserving other unknown fields', () => {
    const doc = parseValid({ last_refresh: 12_345, unknown_top_level: true });
    assert.equal(doc.last_refresh, undefined);
    assert.equal(doc.unknown_top_level, true);
  });

  it('returns the S29 composite identity only from the namespaced claim and gives stored account ID precedence', () => {
    const doc = parseValid();
    assert.equal(codexIdentity(doc), 'user-1:stored-account');

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

  it('slot id from a Pi grant uses the grant accountId before the claim', () => {
    const access = jwt({
      'https://api.openai.com/auth': {
        chatgpt_user_id: 'pi-user',
        chatgpt_account_id: 'claim-account',
      },
    });
    assert.equal(codexSlotIdFromAccessToken(access, 'grant-account'), 'pi-user:grant-account');
  });

  it('slot id from a Pi grant falls back to the chatgpt_account_id claim', () => {
    const access = jwt({
      'https://api.openai.com/auth': {
        chatgpt_user_id: 'pi-user',
        chatgpt_account_id: 'claim-account',
      },
    });
    assert.equal(codexSlotIdFromAccessToken(access), 'pi-user:claim-account');
  });

  it('slot id from a Pi grant is null without chatgpt_user_id', () => {
    const access = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'claim-account' },
    });
    assert.equal(codexSlotIdFromAccessToken(access, 'grant-account'), null);
  });

  it('slot id from a Pi grant is null for a non-JWT access token', () => {
    assert.equal(codexSlotIdFromAccessToken('not-a-jwt', 'grant-account'), null);
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

  it('fails closed when refresh metadata is missing, malformed, or future dated', () => {
    const now = 1_700_000_000_000;
    const freshAccessToken = jwt({ exp: Math.floor((now + 60 * 60 * 1_000) / 1_000) });
    for (const lastRefresh of [undefined, new Date(now - 60_000).toUTCString(), new Date(now + 60_000).toISOString()]) {
      const doc = parseValid({
        tokens: {
          id_token: jwt({}),
          access_token: freshAccessToken,
          refresh_token: 'test-refresh-token',
          account_id: 'stored-account',
        },
        last_refresh: lastRefresh,
      });
      assert.equal(needsRefresh(doc, now), true);
    }
  });

  it('fails closed when the access-token expiry cannot be decoded', () => {
    const now = 1_700_000_000_000;
    const recentRefresh = new Date(now - 60_000).toISOString();
    for (const accessToken of ['not-a-jwt', jwt({})]) {
      for (const lastRefresh of [undefined, recentRefresh]) {
        const doc = parseValid({
          tokens: {
            id_token: jwt({}),
            access_token: accessToken,
            refresh_token: 'test-refresh-token',
            account_id: 'stored-account',
          },
          last_refresh: lastRefresh,
        });
        assert.equal(needsRefresh(doc, now), true);
      }
    }
  });

  it('fails closed for unsafe or overflowing JWT expiry values', () => {
    const now = 1_700_000_000_000;
    const recentRefresh = new Date(now - 60_000).toISOString();
    for (const exp of [Number.MAX_SAFE_INTEGER + 1, Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1, 1e308]) {
      const doc = parseValid({
        tokens: {
          id_token: jwt({}),
          access_token: jwt({ exp }),
          refresh_token: 'test-refresh-token',
          account_id: 'stored-account',
        },
        last_refresh: recentRefresh,
      });
      assert.equal(accessExpiry(doc), null);
      assert.equal(needsRefresh(doc, now), true);
    }
  });

  it('fingerprints only the refresh token with the sha256 prefix', () => {
    const fingerprint = codexFingerprint(parseValid());
    assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
  });

  it('returns sorted ID-token claim names and auth_time without exposing claim values', () => {
    const doc = parseValid({
      tokens: {
        id_token: jwt({
          auth_time: 1_710_000_000,
          email: 'fixture-operator@example.test',
          token_like: 'eyJhbGciOiJub25lIn0.fixture-payload.fixture-signature',
        }),
        access_token: jwt({ exp: 2_000_000_000 }),
        refresh_token: 'test-refresh-token',
      },
    });
    assert.deepEqual(idTokenClaimNames(doc), ['auth_time', 'email', 'token_like']);
    assert.equal(authTime(doc), 1_710_000_000);
  });

  it('returns no ID-token claims or auth_time for malformed tokens and non-numeric auth_time', () => {
    for (const payload of [
      undefined,
      { auth_time: '1_710_000_000' },
      { auth_time: null },
    ]) {
      const doc = parseValid({
        tokens: {
          id_token: payload === undefined ? 'not-a-jwt' : jwt(payload),
          access_token: jwt({ exp: 2_000_000_000 }),
          refresh_token: 'test-refresh-token',
        },
      });
      assert.deepEqual(idTokenClaimNames(doc), payload === undefined ? [] : ['auth_time']);
      assert.equal(authTime(doc), undefined);
    }
  });

  it('prints only claim names and auth_time presence from a temporary CODEX_HOME fixture', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'qlb-codex-home-'));
    const authTimeValue = 1_710_000_000;
    const emailValue = 'fixture-operator@example.test';
    const tokenLikeValue = 'eyJhbGciOiJub25lIn0.fixture-payload.fixture-signature';
    const fixtures = [
      {
        idToken: jwt({ auth_time: authTimeValue, email: emailValue, token_like: tokenLikeValue }),
        expected: '{"claimNames":["auth_time","email","token_like"],"hasAuthTime":true}\n',
      },
      {
        idToken: jwt({ email: emailValue }),
        expected: '{"claimNames":["email"],"hasAuthTime":false}\n',
      },
      {
        idToken: 'not-a-jwt',
        expected: '{"claimNames":[],"hasAuthTime":false}\n',
      },
    ];
    try {
      for (const fixture of fixtures) {
        await writeFile(join(codexHome, 'auth.json'), JSON.stringify(validDocument({
          tokens: {
            id_token: fixture.idToken,
            access_token: jwt({ exp: 2_000_000_000 }),
            refresh_token: 'test-refresh-token',
          },
        })), 'utf8');
        const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(__dirname, '..', 'src', 'cli.js'), 'codex', 'probe-claims', '--json'], {
          encoding: 'utf8',
          env: { ...process.env, CODEX_HOME: codexHome, HOME: codexHome },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, fixture.expected);
        assert.equal(result.stderr, '');
        const fullOutput = `${result.stdout}${result.stderr}`;
        assert.equal(redactSecrets(fullOutput, []), fullOutput, 'output contains a token-shaped value');
        for (const value of [String(authTimeValue), emailValue, tokenLikeValue]) {
          assert.equal(fullOutput.includes(value), false, `output exposed fixture claim value: ${value}`);
        }
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('writes through fsutil, returning its inode after fstat observes mode 0600 before rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qlb-codex-auth-'));
    const path = join(dir, 'auth.json');
    const originalFstat = fs.fstatSync;
    const originalRename = fs.renameSync;
    const calls: string[] = [];
    let observedMode: number | undefined;
    fs.fstatSync = ((fd: number) => {
      calls.push('fstat');
      const metadata = originalFstat(fd);
      observedMode = metadata.mode & 0o777;
      return metadata;
    }) as typeof fs.fstatSync;
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      calls.push('rename');
      assert.equal(observedMode, 0o600);
      return originalRename(...args);
    }) as typeof fs.renameSync;
    try {
      const doc = parseValid({ unknown_top_level: { retained: true } });
      const inode = await writeCodexAuthAtomic(path, doc);
      const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(written.unknown_top_level, { retained: true });
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(inode, (await stat(path)).ino);
      assert.deepEqual(calls, ['fstat', 'rename']);
      assert.deepEqual(await readdir(dir), ['auth.json']);
    } finally {
      fs.fstatSync = originalFstat;
      fs.renameSync = originalRename;
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

  it('writes through a symlinked auth.json without replacing the link', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qlb-codex-auth-'));
    const path = join(dir, 'auth.json');
    const target = join(dir, 'actual-auth.json');
    try {
      await writeFile(target, 'old', 'utf8');
      await symlink(target, path);
      const doc = parseValid();
      await writeCodexAuthAtomic(path, doc);
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), doc);
      assert.equal((await stat(path)).ino, (await stat(target)).ino);
      assert.equal((await lstat(path)).isSymbolicLink(), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns missing and unreadable reads immediately rather than reporting Codex is writing', async () => {
    let missingReads = 0;
    let missingSleeps = 0;
    const missing = await readCodexAuthStable('/fake/auth.json', {
      intervalMs: 0,
      retries: 5,
      sleep: async () => { missingSleeps += 1; },
      readFile: async () => {
        missingReads += 1;
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
    });
    assert.deepEqual(missing, { status: 'missing' });
    assert.equal(missingReads, 1);
    assert.equal(missingSleeps, 0);

    let unreadableReads = 0;
    const unreadable = await readCodexAuthStable('/fake/auth.json', {
      intervalMs: 0,
      retries: 5,
      sleep: async () => { throw new Error('should not sleep'); },
      readFile: async () => {
        unreadableReads += 1;
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    });
    assert.deepEqual(unreadable, { status: 'unreadable', code: 'EACCES' });
    assert.equal(unreadableReads, 1);
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

  it('stable read with stat returns the inode and file hash of the bytes it parsed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qlb-codex-auth-'));
    const path = join(dir, 'auth.json');
    const text = JSON.stringify(validDocument());
    try {
      await writeFile(path, text, 'utf8');
      const result = await readCodexAuthStableWithStat(path, { delayMs: 0 });
      assert.equal(result.status, 'ok');
      if (result.status !== 'ok') throw new Error('expected stable auth document');
      assert.equal(result.inode, (await stat(path)).ino);
      assert.equal(result.sha256, `sha256-file:${createHash('sha256').update(text, 'utf8').digest('hex')}`);
      assert.deepEqual(result.doc, parseValid());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('equal bytes under two different inodes are not stable', async () => {
    const text = JSON.stringify(validDocument());
    const inodes = [101, 102, 103, 104];
    const result = await readCodexAuthStableWithStat('/fake/auth.json', {
      attempts: 2,
      delayMs: 0,
      openRead: async () => ({ text, ino: inodes.shift() ?? 104 }),
    });
    assert.deepEqual(result, { status: 'unstable' });
  });

  it('a truncated read retries and then reports unstable', async () => {
    let reads = 0;
    const result = await readCodexAuthStableWithStat('/fake/auth.json', {
      attempts: 3,
      delayMs: 0,
      openRead: async () => {
        reads += 1;
        return { text: '{', ino: 101 };
      },
    });
    assert.deepEqual(result, { status: 'unstable' });
    assert.equal(reads, 6);
  });

  it('EACCES and EIO report unreadable with the code', async () => {
    for (const code of ['EACCES', 'EIO']) {
      const result = await readCodexAuthStableWithStat('/fake/auth.json', {
        delayMs: 0,
        openRead: async () => { throw Object.assign(new Error(code), { code }); },
      });
      assert.deepEqual(result, { status: 'unreadable', code });
    }
  });

  it('the file hash is not the refresh-token fingerprint', async () => {
    const text = JSON.stringify(validDocument());
    const result = await readCodexAuthStableWithStat('/fake/auth.json', {
      delayMs: 0,
      openRead: async () => ({ text, ino: 101 }),
    });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') throw new Error('expected stable auth document');
    assert.notEqual(result.sha256, codexFingerprint(parseValid()));
    assert.match(result.sha256, /^sha256-file:[a-f0-9]{64}$/);
  });
});
