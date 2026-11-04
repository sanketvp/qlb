import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { statusAnthropicLoginExpiry } from '../src/app';
import { readAnthropicStoreSnapshots } from '../src/anthropic-usage-view';
import { formatDashboard, type DashboardAccount } from '../src/dashboard';
import { openStore } from '../src/store';

const cliPath = join(__dirname, '..', 'src', 'cli.js');
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const WINDOW_END = NOW_MS + 7 * 86_400_000;

type Fixture = { root: string; dbPath: string; env: NodeJS.ProcessEnv };
type CliResult = { status: number; stdout: string; stderr: string };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qlb-status-json-fields-'));
  mkdirSync(join(root, 'plugins'));
  const dbPath = join(root, 'qlb.db');
  return {
    root,
    dbPath,
    env: {
      QLB_TEST_MODE: '1',
      QLB_HOME: root,
      HOME: root,
      QLB_DB_PATH: dbPath,
      QLB_PLUGINS_DIR: join(root, 'plugins'),
      QLB_CONFIG_PATH: join(root, 'config.json'),
      QLB_ANTHROPIC_POOL_PATH: join(root, 'missing-anthropic.json'),
      QLB_PI_AUTH_JSON_PATH: join(root, 'missing-pi-auth.json'),
      QLB_CODEX_AUTH_JSON_PATH: join(root, 'missing-codex-auth.json'),
      QLB_KIMI_CREDENTIALS_FILE: join(root, 'missing-kimi.md'),
      QLB_CLAUDE_CODE_CREDENTIALS_PATH: join(root, 'missing-claude-credentials'),
      QLB_CSWAP_SEQUENCE_PATH: join(root, 'missing-sequence.json'),
      QLB_CSWAP_USAGE_PATH: join(root, 'missing-usage.json'),
    },
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cliPath, ...args], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function initialize(f: Fixture): ReturnType<typeof openStore> {
  return openStore(f.dbPath);
}

function insertClaudeSlot(
  dbPath: string,
  accountId: string,
  slotNum: number,
  threshold: number | null = null,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`INSERT INTO claude_slots
      (account_id, slot_num, email, config_json, fingerprint, threshold, dead, added_at, archived_at)
      VALUES (?, ?, ?, '{}', ?, ?, 0, ?, NULL)`)
      .run(accountId, slotNum, `${accountId}@example.test`, `sha256:${accountId}`, threshold, NOW_MS);
  } finally {
    db.close();
  }
}

function insertLifecycle(dbPath: string, state = 'cutover'): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('INSERT INTO lifecycle (state, began_at, cutover_at, window_end) VALUES (?, ?, ?, ?)')
      .run(state, NOW_MS, NOW_MS, WINDOW_END);
  } finally {
    db.close();
  }
}

function oauthExpiry(expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      refreshTokenExpiresAt: expiresAt,
    },
  });
}

describe('status JSON operational fields', () => {
  it('projects ISO/null login expiry and renders the text login expiry', () => {
    const expiryMs = Date.UTC(2027, 0, 2, 3, 4, 5, 678);
    const loginExpiresAt = statusAnthropicLoginExpiry('with-expiry', () => oauthExpiry(expiryMs));
    assert.equal(loginExpiresAt, '2027-01-02T03:04:05Z');
    assert.equal(statusAnthropicLoginExpiry('without-expiry', () => { throw new Error('fixture credential unavailable'); }), null);
    assert.equal(statusAnthropicLoginExpiry('invalid', () => 'not-json'), null);

    const text = formatDashboard([{
      accountId: 'with-expiry',
      provider: 'anthropic',
      label: 'with-expiry@example.test',
      buckets: {},
      loginExpiresAt,
      ownership: 'QLB_OWNED',
      override: null,
      health: 'fail',
      healthGlyph: '✗',
    } as DashboardAccount]);
    assert.match(text, /login expires 2027-01-02T03:04:05Z/);
  });

  it('includes usage error/retry fields only while usage is unavailable and renders the text line', () => {
    const f = fixture();
    const store = initialize(f);
    try {
      store.recordUsagePollResult('anthropic', 'available', {
        attemptedAt: NOW_S,
        status: 'ok',
        readings: {
          '5h': { usedPct: 20, fetchedAt: NOW_MS, source: 'poll', confidence: 'authoritative' },
        },
      });
      store.recordUsagePollResult('anthropic', 'unavailable', {
        attemptedAt: NOW_S,
        status: 'http-429',
        http429: true,
        retryAfterS: 120,
      });
    } finally {
      store.close();
    }
    insertClaudeSlot(f.dbPath, 'available', 1);
    insertClaudeSlot(f.dbPath, 'unavailable', 2);

    const projected = readAnthropicStoreSnapshots(f.dbPath, NOW_S);
    assert.ok(projected);
    const available = projected.snapshots.find((account) => account.accountId === 'available');
    const unavailable = projected.snapshots.find((account) => account.accountId === 'unavailable');
    assert.equal(Object.hasOwn(available ?? {}, 'usageError'), false);
    assert.equal(Object.hasOwn(available ?? {}, 'usageRetryAt'), false);
    assert.equal(unavailable?.usageError, 'http-429');
    assert.equal(unavailable?.usageRetryAt, new Date((NOW_S + 120) * 1000).toISOString());

    const text = formatDashboard([{
      ...unavailable,
      ownership: 'QLB_OWNED',
      override: null,
      health: 'fail',
      healthGlyph: '✗',
    } as DashboardAccount]);
    assert.match(text, new RegExp(`usage: http-429, retry ${new Date((NOW_S + 120) * 1000).toISOString()}`));

    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare("UPDATE usage_polls SET backoff_until = ? WHERE provider = 'anthropic' AND account_id = 'unavailable'")
        .run(NOW_S - 1);
    } finally {
      db.close();
    }
    const afterBackoff = readAnthropicStoreSnapshots(f.dbPath, NOW_S);
    const lapsed = afterBackoff?.snapshots.find((account) => account.accountId === 'unavailable');
    assert.equal(lapsed?.usageError, 'http-429');
    assert.equal(Object.hasOwn(lapsed ?? {}, 'usageRetryAt'), false);
  });

  it('includes lifecycle state/windowEnd, active login, parked, and breaker fields', () => {
    const f = fixture();
    const store = initialize(f);
    try {
      store.setActiveLogin('anthropic', 'claude-a', 'fixture', NOW_MS);
      store.setActiveLogin('openai-codex', 'codex-a', 'fixture', NOW_MS);
      store.setConfig('auto.anthropic.parkedUntil', String(NOW_MS + 60_000));
      store.setConfig('auto.anthropic.suspendedUntil', String(NOW_MS + 120_000));
    } finally {
      store.close();
    }
    insertClaudeSlot(f.dbPath, 'claude-a', 1, 82);
    insertLifecycle(f.dbPath);

    const result = runCli(['status', '--json'], f.env);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as {
      lifecycle: { state: string; windowEnd: string | null };
      activeLogin: Record<string, string | null>;
      parked: string | null;
      breaker: string | null;
      accounts: Array<Record<string, unknown>>;
    };
    assert.deepEqual(body.lifecycle, { state: 'cutover', windowEnd: new Date(WINDOW_END).toISOString() });
    assert.equal(body.activeLogin.anthropic, 'claude-a');
    assert.equal(body.activeLogin['openai-codex'], 'codex-a');
    assert.equal(body.parked, new Date(NOW_MS + 60_000).toISOString());
    assert.equal(body.breaker, new Date(NOW_MS + 120_000).toISOString());
    const claude = body.accounts.find((account) => account.accountId === 'claude-a');
    assert.equal(claude?.loginExpiresAt, null);
    assert.equal(claude?.threshold, 82);
  });

  it('omits expired parked and breaker holds from status JSON', () => {
    const f = fixture();
    const store = initialize(f);
    try {
      store.setConfig('auto.anthropic.parkedUntil', String(Date.now() - 60_000));
      store.setConfig('auto.anthropic.suspendedUntil', String(Date.now() - 60_000));
    } finally {
      store.close();
    }

    const result = runCli(['status', '--json'], f.env);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as { parked: string | null; breaker: string | null };
    assert.equal(body.parked, null);
    assert.equal(body.breaker, null);
  });

  it('does not add login expiry to an unavailable Anthropic placeholder', () => {
    const f = fixture();
    const store = initialize(f);
    store.close();
    insertLifecycle(f.dbPath);

    const result = runCli(['status', '--json'], f.env);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as { accounts: Array<Record<string, unknown>> };
    const placeholder = body.accounts.find((account) => account.accountId === 'anthropic');
    assert.equal(placeholder?.error, 'unavailable');
    assert.equal(Object.hasOwn(placeholder ?? {}, 'loginExpiresAt'), false);
  });

  it('keeps warnings only on stderr while stdout remains one parseable JSON object', () => {
    const f = fixture();
    const store = initialize(f);
    store.close();
    const result = runCli(['status', '--json'], { ...f.env, QLB_CONFIG_PATH: 'relative-status-config.json' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /warning|relative-status-config/);
    const parsed = JSON.parse(result.stdout) as { fetchedAt: number; accounts: Array<Record<string, unknown>> };
    assert.equal(typeof parsed.fetchedAt, 'number');
    assert.ok(Array.isArray(parsed.accounts));
    const anthropic = parsed.accounts.find((account) => account.provider === 'anthropic');
    assert.equal(Object.hasOwn(anthropic ?? {}, 'loginExpiresAt'), false);
    assert.match(result.stderr, /relative-status-config\.json.*relative/);
  });

  it('never writes a token-shaped string to status JSON stdout', () => {
    const f = fixture();
    const store = initialize(f);
    store.close();
    insertClaudeSlot(f.dbPath, 'claude-a', 1);
    insertLifecycle(f.dbPath);
    const token = `sk-ant-oat01-${'a'.repeat(64)}`;
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare(`INSERT INTO usage_polls
        (provider, account_id, last_attempt_at, next_due_at, last_status, consecutive_failures, backoff_until)
        VALUES ('anthropic', 'claude-a', ?, ?, ?, 1, ?)`)
        .run(NOW_S, NOW_S + 300, token, NOW_S + 120);
    } finally {
      db.close();
    }

    const result = runCli(['status', '--json'], f.env);
    assert.equal(result.status, 0, result.stderr);
    JSON.parse(result.stdout);
    assert.doesNotMatch(result.stdout, new RegExp(token));
    assert.match(result.stdout, /\[redacted\]/);
  });
});
