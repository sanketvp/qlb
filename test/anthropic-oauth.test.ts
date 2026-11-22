import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  accessTokenFingerprint,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_TOKEN_URL,
  ANTHROPIC_USAGE_URL,
  FIVE_HOUR_LABEL,
  FRESHEN_BUFFER_MS,
  OAUTH_EXPIRY_BUFFER_MS,
  buildProfileRequest,
  buildRefreshRequest,
  buildUsageRequest,
  classifyRefreshResponse,
  credentialFingerprint,
  isExpired,
  loginExpiryField,
  loginExpiresAtIso,
  isOAuthTokenExpired,
  needsFreshenBeforeSwitch,
  parseCredentialBlob,
  parseProfileResponse,
  parseTokenAccount,
  parseUsageResponse,
  serializeCredentialBlob,
} from '../src/anthropic-oauth';

const C_SWAP_SOURCE = resolve(__dirname, '../../test/oracle/claude-swap-v0.28.0/src');

// claude-swap's own fixtures use `Z` timestamps, which only Python >= 3.11
// `datetime.fromisoformat` accepts, so that is the oracle's contract runtime.
const MIN_ORACLE_PYTHON: readonly [number, number] = [3, 11];
const VERSION_PROBE = 'import sys; print("%d.%d.%d" % sys.version_info[:3])';

type OracleSelection = { python: string; version: string } | { skip: string };

function pythonVersion(python: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const out = execFileSync(python, ['-I', '-c', VERSION_PROBE], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim();
    return /^\d+\.\d+\.\d+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

function isSupportedOracleVersion(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > MIN_ORACLE_PYTHON[0] || (major === MIN_ORACLE_PYTHON[0] && minor >= MIN_ORACLE_PYTHON[1]);
}

/** `python3` if it is >= 3.11, else `uv python find >=3.11`, else a skip reason. */
function selectOraclePython(env: NodeJS.ProcessEnv = process.env): OracleSelection {
  const rejected: string[] = [];
  const accept = (python: string): OracleSelection | null => {
    const version = pythonVersion(python, env);
    if (version && isSupportedOracleVersion(version)) return { python, version };
    rejected.push(`${python} (${version ?? 'not runnable'})`);
    return null;
  };
  const fromPath = accept('python3');
  if (fromPath) return fromPath;
  const range = `>=${MIN_ORACLE_PYTHON.join('.')}`;
  let uvPython = '';
  try {
    uvPython = execFileSync('uv', ['python', 'find', range], {
      encoding: 'utf8', env: { ...env, UV_PYTHON_DOWNLOADS: 'never' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim();
  } catch {
    // No uv, or no matching interpreter.
  }
  if (uvPython) {
    const fromUv = accept(uvPython);
    if (fromUv) return fromUv;
  } else {
    rejected.push(`uv python find ${range} (no match)`);
  }
  return { skip: `C-swap oracle needs Python ${range}; tried ${rejected.join(', ')}` };
}

const ORACLE = selectOraclePython();
const ORACLE_SKIP = 'skip' in ORACLE ? ORACLE.skip : false;

// Shared prelude: refuse an old interpreter, block every network path, and
// load the vendored oauth.py as claude_swap.oauth.
const ORACLE_PRELUDE = [
  'import importlib.util, json, socket, sys, types, urllib.request',
  `if sys.version_info < (${MIN_ORACLE_PYTHON.join(', ')}):`,
  `  raise SystemExit("C-swap oracle needs Python >= ${MIN_ORACLE_PYTHON.join('.')}, got " + sys.version)`,
  'def _no_network(*args, **kwargs):',
  '  raise RuntimeError("oracle network access is blocked")',
  'socket.create_connection = _no_network',
  'socket.socket.connect = _no_network',
  'urllib.request.urlopen = _no_network',
  `source = ${JSON.stringify(C_SWAP_SOURCE)}`,
  'sys.path.insert(0, source)',
  'package = types.ModuleType("claude_swap")',
  'package.__path__ = [source + "/claude_swap"]',
  'sys.modules["claude_swap"] = package',
  'spec = importlib.util.spec_from_file_location("claude_swap.oauth", source + "/claude_swap/oauth.py")',
  'oauth = importlib.util.module_from_spec(spec)',
  'sys.modules[spec.name] = oauth',
  'spec.loader.exec_module(oauth)',
];

function runOracle(body: string[], input = ''): string {
  if ('skip' in ORACLE) throw new Error(ORACLE.skip);
  return execFileSync(
    ORACLE.python,
    ['-I', '-B', '-c', [...ORACLE_PRELUDE, ...body].join('\n')],
    { encoding: 'utf8', input, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
}

function runUsageOracle(input: unknown): { result?: Record<string, unknown>; error?: string } {
  return JSON.parse(runOracle([
    'try:',
    '  print(json.dumps({"result": oauth.build_usage_result(json.loads(sys.stdin.read()))}))',
    'except Exception as exc:',
    '  print(json.dumps({"error": type(exc).__name__}))',
  ], JSON.stringify(input))) as { result?: Record<string, unknown>; error?: string };
}

type OraclePost = { url: string; method: string; body: Record<string, unknown>; timeout: number };

// urlopen is stubbed to record the POST and answer a fake success; the
// prelude has already blocked real sockets.
function runRefreshOracle(credentials: string): { error: string | null; posts: OraclePost[] } {
  return JSON.parse(runOracle([
    'posts = []',
    'class _FakeResponse:',
    '  def __enter__(self): return self',
    '  def __exit__(self, *exc): return False',
    '  def read(self): return b\'{"access_token": "fake-oracle-access", "expires_in": 3600}\'',
    'def _record_urlopen(req, timeout=None):',
    '  posts.append({"url": req.full_url, "method": req.get_method(), "body": json.loads(req.data.decode()), "timeout": timeout})',
    '  return _FakeResponse()',
    'urllib.request.urlopen = _record_urlopen',
    'outcome = oauth.try_refresh_oauth_credentials(sys.stdin.read())',
    'print(json.dumps({"error": outcome.error, "posts": posts}))',
  ], credentials)) as { error: string | null; posts: OraclePost[] };
}

function oracleTreatsTrueAsExpired(): boolean {
  return (JSON.parse(runOracle(['print(json.dumps({"expired": oauth.is_oauth_token_expired(True)}))'])) as {
    expired: boolean;
  }).expired;
}

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
  it('selects python3 only when it is >= 3.11, else the interpreter uv finds', () => {
    const bin = mkdtempSync(join(tmpdir(), 'qlb-oracle-python-'));
    const script = (name: string, body: string): string => {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    try {
      const fakePath = { PATH: bin };
      script('python3', 'echo 3.9.6');
      const noOracle = selectOraclePython(fakePath);
      assert.ok('skip' in noOracle, 'a 3.9 python3 and no uv must skip');
      assert.match(noOracle.skip, /needs Python >=3\.11; tried python3 \(3\.9\.6\), uv python find >=3\.11 \(no match\)/);
      const fixture = script('fixture-python3.12', 'echo 3.12.7');
      script('uv', `[ "$1 $2 $3" = "python find >=3.11" ] && echo ${fixture} || exit 2`);
      assert.deepEqual(selectOraclePython(fakePath), { python: fixture, version: '3.12.7' });
      script('python3', 'echo 3.11.0');
      assert.deepEqual(selectOraclePython(fakePath), { python: 'python3', version: '3.11.0' });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('matches the C-swap v0.28 credential fingerprint from the vendored oracle', { skip: ORACLE_SKIP }, () => {
    assert.equal(existsSync(C_SWAP_SOURCE), true, `vendored oracle missing: ${C_SWAP_SOURCE}`);
    const expected = runOracle(['print(oauth.credential_fingerprint(sys.stdin.read()))'], FAKE_CREDENTIALS).trim();
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
    // oauth.py raises ValueError, rather than returning None, for these dates.
    for (const value of [3e14, 1e16]) {
      assert.throws(() => loginExpiresAtIso(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: value } })));
    }
  });

  it('keeps the login-expiry field across a refresh and moves it on an interactive login', () => {
    const beforeRefresh = JSON.stringify({ claudeAiOauth: {
      accessToken: 'fake-before-access', refreshToken: 'fake-before-refresh', expiresAt: 1,
      refreshTokenExpiresAt: 1_791_421_596_865,
    } });
    // C-swap oauth.py:188–196 updates the refresh response fields in-place.
    const afterRefresh = JSON.stringify({ claudeAiOauth: {
      accessToken: 'fake-refreshed-access', refreshToken: 'fake-refreshed-refresh', expiresAt: 2,
      refreshTokenExpiresAt: 1_791_421_596_865,
    } });
    // A fresh interactive login supplies a later login-expiry value.
    const afterInteractiveLogin = JSON.stringify({ claudeAiOauth: {
      accessToken: 'fake-login-access', refreshToken: 'fake-login-refresh', expiresAt: 3,
      refreshTokenExpiresAt: 1_794_877_596_865,
    } });

    const before = loginExpiryField(parseCredentialBlob(beforeRefresh));
    const refreshed = loginExpiryField(parseCredentialBlob(afterRefresh));
    const loggedIn = loginExpiryField(parseCredentialBlob(afterInteractiveLogin));
    assert.deepEqual(before, { field: 'refreshTokenExpiresAt', iso: '2026-10-08T01:06:36Z' });
    assert.deepEqual(refreshed, before);
    assert.deepEqual(loggedIn, { field: 'refreshTokenExpiresAt', iso: '2026-11-17T01:06:36Z' });
    assert.equal(loginExpiresAtIso(afterRefresh), refreshed.iso);
    assert.notEqual(loggedIn.iso, refreshed.iso);
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

  it('applies exact five-minute and ten-minute expiry boundaries', { skip: ORACLE_SKIP }, () => {
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
    // Python bool is an int subclass, so the oracle treats true as epoch 1.
    assert.equal(oracleTreatsTrueAsExpired(), true);
    assert.equal(isOAuthTokenExpired(true, nowMs), true);
    assert.equal(needsFreshenBeforeSwitch(true, nowMs), true);
  });

  it('classifies only a 400, 401, or 403 JSON invalid_grant response as dead', () => {
    const success = classifyRefreshResponse(200, JSON.stringify({
      access_token: 'fake-new-access', expires_in: 3600, refresh_token: 'fake-new-refresh', scope: 'a  b\tc ',
    }));
    assert.deepEqual(success, {
      kind: 'success',
      accessToken: 'fake-new-access',
      refreshToken: 'fake-new-refresh',
      expiresInMs: 3_600_000,
      scopes: ['a', 'b', 'c'],
    });
    // oauth.py accepts an empty token and non-positive durations; an expiry
    // that cannot remain finite in JavaScript is a malformed response here.
    assert.deepEqual(classifyRefreshResponse(200, '{"access_token":"","expires_in":0}'), {
      kind: 'success', accessToken: '', expiresInMs: 0,
    });
    assert.deepEqual(classifyRefreshResponse(200, '{"access_token":"fake","expires_in":-1}'), {
      kind: 'success', accessToken: 'fake', expiresInMs: -1_000,
    });
    assert.deepEqual(classifyRefreshResponse(200, '{"access_token":"fake","expires_in":1e308}'), {
      kind: 'transient',
    });
    assert.equal(classifyRefreshResponse(200, '{"access_token":"fake"}').kind, 'transient');
    for (const row of [
      { status: 400, body: '{"error":"invalid_grant"}', expected: 'dead' },
      { status: 401, body: '{"error":"invalid_grant"}', expected: 'dead' },
      { status: 403, body: '{"error":"invalid_grant"}', expected: 'dead' },
      { status: 400, body: '{"error":"invalid_client"}', expected: 'invalid_client' },
      { status: 401, body: '{"error":"invalid_client"}', expected: 'invalid_client' },
      { status: 403, body: '{"error":"invalid_client"}', expected: 'invalid_client' },
      { status: 404, body: '{"error":"invalid_grant"}', expected: 'transient' },
      { status: 429, body: '{"error":"invalid_grant"}', expected: 'transient' },
      { status: 404, body: '{"error":"invalid_client"}', expected: 'transient' },
      { status: 422, body: '{"error":"invalid_client"}', expected: 'transient' },
      { status: 400, body: '{"error":"other"}', expected: 'transient' },
      { status: 401, body: 'not-json', expected: 'transient' },
      { status: 500, body: '{"error":"invalid_grant"}', expected: 'transient' },
      { status: 200, body: 'not-json', expected: 'transient' },
    ]) {
      assert.equal(classifyRefreshResponse(row.status, row.body).kind, row.expected, `${row.status}: ${row.body}`);
    }
  });

  // S18 disambiguates the upstream preflight at oauth.py:154–167: only a
  // structurally valid OAuth object with a non-empty string token may request.
  it('treats an empty credential object as unreadable', () => {
    assert.equal(buildRefreshRequest('{}').kind, 'transient');
  });

  it('treats a null Claude OAuth object as unreadable', () => {
    assert.equal(buildRefreshRequest(JSON.stringify({ claudeAiOauth: null })).kind, 'transient');
  });

  it('treats a whitespace-only refresh token as permanently absent', () => {
    assert.equal(buildRefreshRequest(JSON.stringify({ claudeAiOauth: { refreshToken: ' \t\n ' } })).kind, 'no_refresh_token');
  });

  it('treats non-string refresh tokens as unreadable', () => {
    for (const refreshToken of [1, {}]) {
      assert.equal(buildRefreshRequest(JSON.stringify({ claudeAiOauth: { refreshToken } })).kind, 'transient');
    }
  });

  // S18 divergence, pinned against the oracle: oauth.py:165-185 POSTs any
  // truthy refreshToken, so a numeric one reaches the token endpoint there.
  it('pins the S18 numeric refresh-token divergence against the oracle', { skip: ORACLE_SKIP }, () => {
    const numericToken = JSON.stringify({ claudeAiOauth: { refreshToken: 1 } });
    const oracle = runRefreshOracle(numericToken);
    assert.equal(oracle.error, null);
    assert.deepEqual(oracle.posts, [{
      url: ANTHROPIC_OAUTH_TOKEN_URL,
      method: 'POST',
      body: { [GRANT_KEY]: 'refresh_token', refresh_token: 1, client_id: ANTHROPIC_OAUTH_CLIENT_ID },
      timeout: 10,
    }]);
    assert.deepEqual(buildRefreshRequest(numericToken), { kind: 'transient' });
  });

  it('describes refresh and usage requests without performing network I/O', { skip: ORACLE_SKIP }, () => {
    const refreshResult = buildRefreshRequest(FAKE_CREDENTIALS);
    assert.equal(refreshResult.kind, 'request');
    if (refreshResult.kind !== 'request') throw new Error('fake credential must produce a refresh request');
    const refresh = refreshResult.request;
    assert.equal(refresh.url, ANTHROPIC_OAUTH_TOKEN_URL);
    assert.equal(refresh.method, 'POST');
    assert.equal(refresh.timeoutMs, 10_000);
    assert.deepEqual(refresh.headers, { 'Content-Type': 'application/json', 'User-Agent': 'claude-swap/1.0' });
    assert.deepEqual(JSON.parse(refresh.body ?? ''), {
      [GRANT_KEY]: 'refresh_token', refresh_token: 'fake-refresh-token', client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    });
    // try_refresh_oauth_credentials treats a complete credential missing the
    // token as permanent, but a malformed/non-object blob as a torn read.
    const noToken = JSON.stringify({ claudeAiOauth: {} });
    for (const [credentials, expected] of [[noToken, 'no_refresh_token'], ['not json', 'transient'], ['[]', 'transient']]) {
      assert.deepEqual(runRefreshOracle(credentials), { error: expected, posts: [] });
      assert.equal(buildRefreshRequest(credentials).kind, expected);
    }
    // S18 classifies non-string tokens as unreadable rather than POSTing them.
    assert.equal(buildRefreshRequest(JSON.stringify({ claudeAiOauth: { refreshToken: true } })).kind, 'transient');
    const timedRequest = buildRefreshRequest(FAKE_CREDENTIALS, 6_000);
    assert.equal(timedRequest.kind, 'request');
    if (timedRequest.kind === 'request') assert.equal(timedRequest.request.timeoutMs, 6_000);
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

  it('describes and parses OAuth profile lookups without network I/O', () => {
    assert.deepEqual(buildProfileRequest('fake-access-token'), {
      url: 'https://api.anthropic.com/api/oauth/profile',
      method: 'GET',
      timeoutMs: 5_000,
      headers: {
        Authorization: 'Bearer fake-access-token',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-swap/1.0',
      },
    });
    assert.deepEqual(parseProfileResponse({
      account: { uuid: ' account-uuid ', email: 'fake@example.test' },
      organization: { uuid: 'org-uuid' },
    }), { uuid: 'account-uuid', email: 'fake@example.test', organizationUuid: 'org-uuid' });
    for (const response of [null, {}, { account: {} }, { account: { uuid: '  ' } }]) {
      assert.equal(parseProfileResponse(response), null);
    }
    assert.deepEqual(parseProfileResponse({ account: { uuid: 'id', email: 1 }, organization: { uuid: 2 } }), {
      uuid: 'id', email: null, organizationUuid: null,
    });
    assert.deepEqual(parseTokenAccount({
      account: { uuid: 'id', email_address: 'token@example.test' },
      organization: { uuid: 'org-id' },
    }), { uuid: 'id', email: 'token@example.test', organizationUuid: 'org-id' });
  });

  it('parses C-swap-shaped 5h, 7d, and per-model 7d usage buckets', { skip: ORACLE_SKIP }, () => {
    assert.equal(FIVE_HOUR_LABEL, '5h');
    const input = {
      five_hour: { utilization: 12.5, resets_at: '2099-01-01T00:00:00+00:00' },
      seven_day: { utilization: 34, resets_at: '2099-01-08T00:00:00+00:00' },
      limits: [
        { percent: 56, resets_at: '2099-01-08T00:00:00+00:00', scope: { model: { display_name: 'seven_day_fable' } } },
        { percent: 70, resets_at: '2099-01-09T00:00:00+00:00', scope: { model: { display_name: 'fable' } } },
        { percent: 'ignored', scope: { model: { display_name: 'Invalid' } } },
      ],
    };
    const oracle = runUsageOracle(input);
    assert.equal(oracle.error, undefined);
    assert.deepEqual(parseUsageResponse(input), {
      buckets: {
        '5h': { usedPct: 12.5, resetsAt: '2099-01-01T00:00:00+00:00' },
        '7d': { usedPct: 34, resetsAt: '2099-01-08T00:00:00+00:00' },
        // C-swap retains both distinct display names and their own resets.
        '7d:seven_day_fable': { usedPct: 56, resetsAt: '2099-01-08T00:00:00+00:00' },
        '7d:fable': { usedPct: 70, resetsAt: '2099-01-09T00:00:00+00:00' },
      },
    });
    const scoped = oracle.result?.scoped as Array<Record<string, unknown>>;
    assert.deepEqual(scoped.map(({ name, resets_at }) => ({ name, resets_at })), [
      { name: 'seven_day_fable', resets_at: '2099-01-08T00:00:00+00:00' },
      { name: 'fable', resets_at: '2099-01-09T00:00:00+00:00' },
    ]);
  });

  it('keeps the binding scoped window when duplicate display names collide', () => {
    const firstBinding = {
      limits: [
        { percent: 95, resets_at: '2099-01-08T00:00:00+00:00', scope: { surface: 'chat', model: { display_name: 'Fable' } } },
        { percent: 20, resets_at: '2099-01-09T00:00:00+00:00', scope: { surface: 'code', model: { display_name: 'Fable' } } },
      ],
    };
    assert.deepEqual(parseUsageResponse(firstBinding), {
      buckets: { '7d:Fable': { usedPct: 95, resetsAt: '2099-01-08T00:00:00+00:00' } },
    });
  });

  it('keeps the binding scoped window when duplicate display names arrive in reverse order', () => {
    const lastBinding = {
      limits: [
        { percent: 20, resets_at: '2099-01-09T00:00:00+00:00', scope: { surface: 'code', model: { display_name: 'Fable' } } },
        { percent: 95, resets_at: '2099-01-08T00:00:00+00:00', scope: { surface: 'chat', model: { display_name: 'Fable' } } },
      ],
    };
    assert.deepEqual(parseUsageResponse(lastBinding), {
      buckets: { '7d:Fable': { usedPct: 95, resetsAt: '2099-01-08T00:00:00+00:00' } },
    });
  });

  it('keeps valid usage windows when another oracle window has non-numeric utilization', { skip: ORACLE_SKIP }, () => {
    for (const utilization of [null, '12']) {
      const input = { five_hour: { utilization }, seven_day: { utilization: 34 } };
      const oracle = runUsageOracle(input);
      assert.equal((oracle.result?.five_hour as Record<string, unknown>).pct, utilization);
      assert.equal((oracle.result?.seven_day as Record<string, unknown>).pct, 34);
      assert.deepEqual(parseUsageResponse(input), { buckets: { '7d': { usedPct: 34 } } });
    }
  });

  it('rejects reset timestamps whenever the oracle format_reset rejects the response', { skip: ORACLE_SKIP }, () => {
    for (const input of [
      { five_hour: { utilization: 1, resets_at: 'later' } },
      { five_hour: { utilization: 1, resets_at: '2099-01-01' } },
      { seven_day: { utilization: 1, resets_at: 1 } },
      { limits: [{ percent: 1, resets_at: 'later', scope: { model: { display_name: 'Fable' } } }] },
    ]) {
      const oracle = runUsageOracle(input);
      assert.ok(oracle.error, `oracle should reject ${JSON.stringify(input)}`);
      assert.throws(() => parseUsageResponse(input));
    }
    // A missing utilization is still structurally malformed, like h5["utilization"].
    assert.throws(() => parseUsageResponse({ five_hour: { resets_at: '2099-01-01T00:00:00Z' } }));
  });
});
