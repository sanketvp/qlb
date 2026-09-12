import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  DEFAULT_AUDIT_LIMIT,
  formatAudit,
  listAuditDecisions,
  toAuditDecision,
} from '../src/audit';
import { openStore, type Store } from '../src/store';

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

function seedDecision(
  store: Store,
  opts: {
    ts: number;
    account?: string | null;
    mode?: string;
    snapshot?: unknown;
    snapshotRaw?: string;
  },
): number {
  return store.recordDecision({
    ts: opts.ts,
    requested_model: 'claude-sonnet-5',
    account_id: opts.account === undefined ? 'acc' : opts.account,
    mode: opts.mode ?? 'headroom',
    reason: 'ok',
    snapshot_json:
      opts.snapshotRaw ??
      JSON.stringify(opts.snapshot ?? { provider: 'anthropic', strategy: 'headroom' }),
  });
}

describe('audit — listAuditDecisions', () => {
  it('returns 3 fixture decisions newest-first and honors limit=2', () => {
    const store = openStore(':memory:');
    try {
      seedDecision(store, {
        ts: 1_000,
        account: 'oldest',
        snapshot: { provider: 'anthropic', strategy: 'headroom' },
      });
      seedDecision(store, {
        ts: 2_000,
        account: 'middle',
        snapshot: { provider: 'openai-codex', strategy: 'spread' },
      });
      seedDecision(store, {
        ts: 3_000,
        account: 'newest',
        snapshot: { provider: 'xai', strategy: 'failover' },
      });

      const all = listAuditDecisions(store, 3);
      assert.equal(all.length, 3);
      assert.deepEqual(
        all.map((d) => d.account),
        ['newest', 'middle', 'oldest'],
      );
      assert.deepEqual(
        all.map((d) => d.timestamp),
        [3_000, 2_000, 1_000],
      );
      assert.deepEqual(
        all.map((d) => d.provider),
        ['xai', 'openai-codex', 'anthropic'],
      );
      assert.deepEqual(
        all.map((d) => d.strategy),
        ['failover', 'spread', 'headroom'],
      );

      const limited = listAuditDecisions(store, 2);
      assert.equal(limited.length, 2);
      assert.deepEqual(
        limited.map((d) => d.account),
        ['newest', 'middle'],
      );
    } finally {
      store.close();
    }
  });

  it('defaults to limit 20', () => {
    assert.equal(DEFAULT_AUDIT_LIMIT, 20);
    const store = openStore(':memory:');
    try {
      for (let i = 0; i < 25; i++) {
        seedDecision(store, { ts: 1_000 + i, account: `acc-${i}` });
      }
      const rows = listAuditDecisions(store);
      assert.equal(rows.length, 20);
      assert.equal(rows[0].account, 'acc-24');
      assert.equal(rows[19].account, 'acc-5');
    } finally {
      store.close();
    }
  });

  it('tie-breaks equal timestamps by id DESC', () => {
    const store = openStore(':memory:');
    try {
      const first = seedDecision(store, { ts: 5_000, account: 'first-same-ts' });
      const second = seedDecision(store, { ts: 5_000, account: 'second-same-ts' });
      assert.ok(second > first);
      const rows = listAuditDecisions(store);
      assert.deepEqual(
        rows.map((d) => d.account),
        ['second-same-ts', 'first-same-ts'],
      );
    } finally {
      store.close();
    }
  });
});

describe('audit — empty store', () => {
  it('pure function: human contains "no decisions", JSON is []', () => {
    const store = openStore(':memory:');
    try {
      const rows = listAuditDecisions(store);
      assert.deepEqual(rows, []);
      assert.match(formatAudit(rows, false), /no decisions/);
      assert.equal(formatAudit(rows, true), '[]');
    } finally {
      store.close();
    }
  });

  it('CLI: empty store prints "no decisions" / [] and exits 0', () => {
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    const env = isolatedEnv(dbPath);
    const human = runCli(['audit', '--db', dbPath], env);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /no decisions/);

    const json = runCli(['audit', '--json', '--db', dbPath], env);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), []);
  });
});

describe('audit — snapshot_json provider/strategy', () => {
  it('reads strategy from snapshot when present, else falls back to mode', () => {
    const store = openStore(':memory:');
    try {
      seedDecision(store, {
        ts: 2,
        account: 'from-snap',
        mode: 'headroom',
        snapshot: { provider: 'anthropic', strategy: 'round-robin' },
      });
      seedDecision(store, {
        ts: 1,
        account: 'from-mode',
        mode: 'failover',
        snapshot: { provider: 'xai' },
      });
      const rows = listAuditDecisions(store);
      assert.equal(rows[0].strategy, 'round-robin');
      assert.equal(rows[0].provider, 'anthropic');
      assert.equal(rows[1].strategy, 'failover');
      assert.equal(rows[1].provider, 'xai');
    } finally {
      store.close();
    }
  });

  it('does not throw on malformed snapshot_json; provider degrades to null', () => {
    const store = openStore(':memory:');
    try {
      const id = seedDecision(store, {
        ts: 1,
        account: 'broken',
        mode: 'spread',
        snapshotRaw: 'not-json{',
      });
      const row = store.listRecentDecisions(1)[0];
      assert.equal(row.id, id);
      const mapped = toAuditDecision(row);
      assert.equal(mapped.provider, null);
      assert.equal(mapped.strategy, 'spread');
      assert.equal(mapped.account, 'broken');
    } finally {
      store.close();
    }
  });
});

describe('audit — CLI fixture ordering + limit', () => {
  it('lists 3 seeded decisions newest-first and --limit 2 keeps the two newest', () => {
    const dir = tmp();
    const dbPath = join(dir, 'qlb.db');
    const store = openStore(dbPath);
    try {
      seedDecision(store, { ts: 1_000, account: 'oldest', snapshot: { provider: 'anthropic' } });
      seedDecision(store, { ts: 2_000, account: 'middle', snapshot: { provider: 'anthropic' } });
      seedDecision(store, { ts: 3_000, account: 'newest', snapshot: { provider: 'anthropic' } });
    } finally {
      store.close();
    }
    const env = isolatedEnv(dbPath);
    const all = runCli(['audit', '--json', '--db', dbPath], env);
    assert.equal(all.status, 0, all.stderr);
    const body = JSON.parse(all.stdout) as Array<{ account: string; timestamp: number }>;
    assert.deepEqual(
      body.map((d) => d.account),
      ['newest', 'middle', 'oldest'],
    );

    const limited = runCli(['audit', '--limit', '2', '--json', '--db', dbPath], env);
    assert.equal(limited.status, 0, limited.stderr);
    const two = JSON.parse(limited.stdout) as Array<{ account: string }>;
    assert.deepEqual(
      two.map((d) => d.account),
      ['newest', 'middle'],
    );
  });
});
