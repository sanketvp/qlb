import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { DEFAULT_AUDIT_LIMIT, toAuditDecision } from '../src/audit';
import { snapshotsFromStore, resolveFromSnapshots } from '../src/resolve';
import { openStore, type Store } from '../src/store';
import type { BucketReading } from '../src/types';

const support = join(__dirname, '..', '..', 'test', 'support');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildV4Store } = require(join(support, 'v4-fixture.cjs')) as {
  buildV4Store: (path: string, rows?: Array<Record<string, unknown>>) => string;
};

const temps: string[] = [];
after(() => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const cliPath = join(__dirname, '..', 'src', 'cli.js');

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-audit-'));
  temps.push(dir);
  return dir;
}

function isolatedEnv(dbPath: string): NodeJS.ProcessEnv {
  const root = join(dbPath, '..');
  mkdirSync(join(root, 'migrate'), { recursive: true });
  return {
    ...process.env,
    QLB_PLUGINS_DIR: join(root, 'plugins'),
    QLB_DB_PATH: dbPath,
    QLB_ANTHROPIC_POOL_PATH: join(root, 'missing-anthropic.json'),
    QLB_PI_AUTH_JSON_PATH: join(root, 'missing-pi-auth.json'),
    QLB_CODEX_AUTH_JSON_PATH: join(root, 'missing-codex-auth.json'),
    QLB_KIMI_CREDENTIALS_FILE: join(root, 'missing-kimi.md'),
    QLB_OPENROUTER_KEYCHAIN_SERVICE: 'qlb-test-missing-openrouter',
    QLB_CONFIG_PATH: join(root, 'config.json'),
    QLB_PROXY_INFO_PATH: join(root, 'proxy.json'),
    QLB_CLAUDE_CODE_CREDENTIALS_PATH: join(root, 'cc-creds'),
  };
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
    };
  }
}

function reading(usedPct: number): BucketReading {
  return {
    usedPct,
    source: 'poll',
    confidence: 'authoritative',
    fetchedAt: Date.now(),
  };
}

function seedAccount(store: Store, id: string, provider: string, buckets: Record<string, BucketReading>): void {
  store.upsertAccount(id, provider, id);
  for (const [bucket, value] of Object.entries(buckets)) {
    store.upsertSnapshot(id, bucket, value);
  }
}

const PROXY_MODES = [
  'proxy_error',
  'proxy_auth_reject',
  'policy_unmapped',
  'native_resync',
  'proxy_upstream_error',
  'proxy',
] as const;

function proxyShape(mode: (typeof PROXY_MODES)[number]): {
  mode: string;
  reason: string;
  snapshot_json: string;
  requested_model: string;
} {
  switch (mode) {
    case 'proxy_error':
      return { mode, reason: 'boom', snapshot_json: JSON.stringify({ status: 500 }), requested_model: '' };
    case 'proxy_auth_reject':
      return { mode, reason: 'missing', snapshot_json: JSON.stringify({ status: 401 }), requested_model: '' };
    case 'policy_unmapped':
      return { mode, reason: 'unmapped virtual model', snapshot_json: JSON.stringify({ status: 400 }), requested_model: 'virt' };
    case 'native_resync':
      return { mode, reason: 'drift', snapshot_json: JSON.stringify({ provider: 'anthropic' }), requested_model: 'claude-sonnet-5' };
    case 'proxy_upstream_error':
      return { mode, reason: 'unreachable', snapshot_json: JSON.stringify({ status: 502, ms: 1 }), requested_model: 'claude-sonnet-5' };
    case 'proxy':
      return { mode, reason: 'proxied 200 1ms via acc', snapshot_json: JSON.stringify({ status: 200, ms: 1, accountId: 'acc' }), requested_model: 'claude-sonnet-5' };
  }
}

function entrySet(dir: string): string[] {
  return readdirSync(dir).filter((name) => name !== 'migrate').sort();
}

describe('audit — recorded strategy from resolve', () => {
  it('strategy equals decision.strategy for all-in and cross-provider fallback', () => {
    const store = openStore(':memory:');
    seedAccount(store, 'hot', 'anthropic', {
      '5h': reading(90),
      '7d': reading(90),
    });
    const allIn = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      snapshots: snapshotsFromStore(store, 'anthropic'),
      store,
    });
    assert.equal(allIn.ok, true);
    if (!allIn.ok) return;
    assert.equal(allIn.mode, 'all-in');
    const allInRow = store.listRoutingDecisions(1)[0];
    assert.equal(allInRow.strategy, allIn.strategy);
    assert.equal(allInRow.provider, 'anthropic');

    const fbStore = openStore(':memory:');
    seedAccount(fbStore, 'dead', 'anthropic', {
      '5h': reading(100),
      '7d': reading(100),
    });
    seedAccount(fbStore, 'x', 'xai', {
      tokens: reading(10),
      requests: reading(10),
    });
    const fallback = resolveFromSnapshots({
      model: 'claude-sonnet-5',
      fallback: ['grok-4.6'],
      snapshots: snapshotsFromStore(fbStore),
      store: fbStore,
    });
    assert.equal(fallback.ok, true);
    if (!fallback.ok) return;
    assert.ok(fallback.mode === 'fallback' || fallback.mode === 'fallback-all-in');
    const fbRow = fbStore.listRoutingDecisions(1)[0];
    assert.equal(fbRow.strategy, fallback.strategy);
    assert.equal(fbRow.provider, fallback.provider);
    fbStore.close();
    store.close();
  });
});

describe('audit — filter before LIMIT', () => {
  it('--limit 1 skips newer rows of every non-routing mode', () => {
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    const store = openStore(dbPath);
    let ts = 1_000;
    store.recordDecision({
      ts: ts++,
      requested_model: 'claude-sonnet-5',
      account_id: 'keep',
      mode: 'headroom',
      reason: 'routing',
      snapshot_json: '{}',
      strategy: 'headroom',
      provider: 'anthropic',
    });
    for (const mode of PROXY_MODES) {
      const shape = proxyShape(mode);
      store.recordDecision({
        ts: ts++,
        requested_model: shape.requested_model,
        account_id: null,
        mode: shape.mode,
        reason: shape.reason,
        snapshot_json: shape.snapshot_json,
      });
    }
    store.close();
    const env = isolatedEnv(dbPath);
    const result = runCli(['audit', '--limit', '1', '--json', '--db', dbPath], env);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as Array<{ account: string | null; strategy: string | null }>;
    assert.equal(body.length, 1);
    assert.equal(body[0]?.account, 'keep');
  });

  it('default limit truncates 21 rows to 20', () => {
    assert.equal(DEFAULT_AUDIT_LIMIT, 20);
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    const store = openStore(dbPath);
    for (let i = 0; i < 21; i++) {
      store.recordDecision({
        ts: 1_000 + i,
        requested_model: 'claude-sonnet-5',
        account_id: `acc-${i}`,
        mode: 'headroom',
        reason: 'ok',
        snapshot_json: '{}',
        strategy: 'headroom',
        provider: 'anthropic',
      });
    }
    store.close();
    const env = isolatedEnv(dbPath);
    const result = runCli(['audit', '--json', '--db', dbPath], env);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as Array<{ account: string }>;
    assert.equal(body.length, 20);
    assert.equal(body[0]?.account, 'acc-20');
    assert.equal(body[19]?.account, 'acc-1');
  });
});

describe('audit — legacy v4', () => {
  it('legacy v4 rows show derived strategy with strategySource=derived and providerSource', () => {
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    buildV4Store(dbPath, [
      {
        ts: 2,
        requested_model: 'claude-sonnet-5',
        account_id: 'from-accounts',
        account_provider: 'anthropic',
        mode: 'all-in',
        reason: 'ok',
        snapshot_json: '{}',
      },
      {
        ts: 1,
        requested_model: 'grok-4.6',
        account_id: null,
        mode: 'failover',
        reason: 'ok',
        snapshot_json: JSON.stringify({ provider: 'xai' }),
      },
    ]);
    const env = isolatedEnv(dbPath);
    const result = runCli(['audit', '--json', '--db', dbPath], env);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as Array<{
      strategy: string | null;
      strategySource: string;
      provider: string | null;
      providerSource: string;
    }>;
    assert.equal(body.length, 2);
    assert.equal(body[0]?.strategy, 'headroom');
    assert.equal(body[0]?.strategySource, 'derived');
    assert.equal(body[0]?.provider, 'anthropic');
    assert.equal(body[0]?.providerSource, 'accounts');
    assert.equal(body[1]?.strategy, 'failover');
    assert.equal(body[1]?.strategySource, 'derived');
    assert.equal(body[1]?.provider, 'xai');
    assert.equal(body[1]?.providerSource, 'snapshot');
  });

  it('audit on a v4 fixture never adds columns or changes user_version', () => {
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    buildV4Store(dbPath, [
      {
        ts: 1,
        requested_model: 'claude-sonnet-5',
        mode: 'headroom',
        reason: 'ok',
        snapshot_json: '{}',
      },
    ]);
    const beforeCols = new DatabaseSync(dbPath, { readOnly: true });
    const names = (beforeCols.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((c) => c.name);
    const version = (beforeCols.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    beforeCols.close();
    assert.ok(!names.includes('strategy'));
    assert.equal(version, 4);

    const env = isolatedEnv(dbPath);
    const result = runCli(['audit', '--json', '--db', dbPath], env);
    assert.equal(result.status, 0, result.stderr);

    const after = new DatabaseSync(dbPath, { readOnly: true });
    const afterNames = (after.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((c) => c.name);
    const afterVersion = (after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    after.close();
    assert.deepEqual(afterNames, names);
    assert.equal(afterVersion, 4);
  });
});

describe('audit — read-only contract', () => {
  it('missing db path prints empty result and directory entry set unchanged', () => {
    const dir = tmp();
    const dbPath = join(dir, 'nope.db');
    const before = entrySet(dir);
    const env = isolatedEnv(dbPath);
    const human = runCli(['audit', '--db', dbPath], env);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /no decisions/);
    const json = runCli(['audit', '--json', '--db', dbPath], env);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), []);
    assert.deepEqual(entrySet(dir), before);
    assert.equal(existsSync(dbPath), false);
  });

  it('existing db: bytes, mode, user_version and entry set (minus -wal/-shm) unchanged', () => {
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    const store = openStore(dbPath);
    store.recordDecision({
      ts: 1,
      requested_model: 'claude-sonnet-5',
      account_id: 'a',
      mode: 'headroom',
      reason: 'ok',
      snapshot_json: '{}',
      strategy: 'headroom',
      provider: 'anthropic',
    });
    store.close();
    const bytes = readFileSync(dbPath);
    const mode = statSync(dbPath).mode;
    const versionDb = new DatabaseSync(dbPath, { readOnly: true });
    const version = (versionDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    versionDb.close();
    const beforeEntries = entrySet(dir).filter((n) => !n.endsWith('-wal') && !n.endsWith('-shm'));

    const env = isolatedEnv(dbPath);
    const result = runCli(['audit', '--json', '--db', dbPath], env);
    assert.equal(result.status, 0, result.stderr);

    assert.deepEqual(readFileSync(dbPath), bytes);
    assert.equal(statSync(dbPath).mode, mode);
    const afterVersion = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal((afterVersion.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, version);
    afterVersion.close();
    const afterEntries = entrySet(dir).filter((n) => !n.endsWith('-wal') && !n.endsWith('-shm'));
    assert.deepEqual(afterEntries, beforeEntries);
  });

  it('active WAL writer with uncommitted BEGIN IMMEDIATE + concurrent audit sees committed rows, exit 0', () => {
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    const store = openStore(dbPath);
    store.recordDecision({
      ts: 1,
      requested_model: 'claude-sonnet-5',
      account_id: 'committed',
      mode: 'headroom',
      reason: 'ok',
      snapshot_json: '{}',
      strategy: 'headroom',
      provider: 'anthropic',
    });
    store.close();

    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA busy_timeout = 5000');
    writer.exec('BEGIN IMMEDIATE');
    try {
      const env = isolatedEnv(dbPath);
      const result = runCli(['audit', '--json', '--db', dbPath], env);
      assert.equal(result.status, 0, result.stderr);
      const body = JSON.parse(result.stdout) as Array<{ account: string }>;
      assert.ok(body.some((d) => d.account === 'committed'));
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it('-wal present, -shm absent → rows from WAL visible', () => {
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    const store = openStore(dbPath);
    store.recordDecision({
      ts: 1,
      requested_model: 'claude-sonnet-5',
      account_id: 'wal-row',
      mode: 'headroom',
      reason: 'ok',
      snapshot_json: '{}',
      strategy: 'headroom',
      provider: 'anthropic',
    });
    store.close();
    const wal = `${dbPath}-wal`;
    const shm = `${dbPath}-shm`;
    if (!existsSync(wal)) {
      writeFileSync(wal, '');
    }
    if (existsSync(shm)) unlinkSync(shm);
    const env = isolatedEnv(dbPath);
    const result = runCli(['audit', '--json', '--db', dbPath], env);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as Array<{ account: string }>;
    assert.ok(body.some((d) => d.account === 'wal-row'));
  });

  it('unwritable directory → exit 0 or 1 with single stderr line, no stack, no new entries', () => {
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    const store = openStore(dbPath);
    store.recordDecision({
      ts: 1,
      requested_model: 'claude-sonnet-5',
      account_id: 'a',
      mode: 'headroom',
      reason: 'ok',
      snapshot_json: '{}',
    });
    store.close();
    if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
    const env = isolatedEnv(dbPath);
    const before = entrySet(dir);
    chmodSync(dir, 0o555);
    try {
      const result = runCli(['audit', '--json', '--db', dbPath], env);
      assert.ok(result.status === 0 || result.status === 1, `status ${result.status}`);
      if (result.status === 1) {
        const lines = result.stderr.trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 1, result.stderr);
        assert.doesNotMatch(result.stderr, /at /);
        assert.match(result.stderr, /cannot open store read-only|upgrade qlb/);
      }
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.deepEqual(entrySet(dir), before);
  });

  it('--limit 99999999999999999999 exits 1 without stack', () => {
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    const env = isolatedEnv(dbPath);
    const result = runCli(['audit', '--limit', '99999999999999999999', '--db', dbPath], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--limit must be a positive integer/);
    assert.doesNotMatch(result.stderr, /at /);
  });
});

describe('audit — toAuditDecision sources', () => {
  it('recorded columns win over snapshot', () => {
    const store = openStore(':memory:');
    store.recordDecision({
      ts: 1,
      requested_model: 'claude-sonnet-5',
      account_id: 'a',
      mode: 'all-in',
      reason: 'ok',
      snapshot_json: JSON.stringify({ provider: 'xai', strategy: 'spread' }),
      strategy: 'headroom',
      provider: 'anthropic',
    });
    const row = store.listRoutingDecisions(1)[0];
    const mapped = toAuditDecision(row);
    assert.equal(mapped.strategy, 'headroom');
    assert.equal(mapped.strategySource, 'recorded');
    assert.equal(mapped.provider, 'anthropic');
    assert.equal(mapped.providerSource, 'recorded');
    store.close();
  });
});
