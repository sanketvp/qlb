import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { collectCandidates } from '../src/candidates';
import { loadPlugins } from '../src/plugins';
import { formatRefresh, refreshCommand, runRefresh } from '../src/refresh';
import { openStore } from '../src/store';
import type { AccountSnapshot, Adapter } from '../src/types';
import { explainWhy } from '../src/why';

function bucketSnapshot(provider: string, accountId = `${provider}-acct`) {
  return {
    accountId,
    provider,
    label: accountId,
    buckets: {
      requests: {
        usedPct: 1,
        source: 'poll' as const,
        confidence: 'authoritative' as const,
        fetchedAt: 1,
      },
    },
  };
}

function goodAdapter(id: string, displayName: string, counter: { n: number }) {
  return {
    id,
    displayName,
    fetchSnapshots() {
      counter.n += 1;
      return Promise.resolve([bucketSnapshot(id)]);
    },
  };
}

describe('qlb refresh', () => {
  it('T1: without --allow-probe does not call adapters', async () => {
    const counter = { n: 0 };
    const spy = goodAdapter('spy', 'Spy', counter);
    const report = await runRefresh([spy], { allowProbe: false });
    assert.equal(report.probed, false);
    assert.deepEqual(report.results, []);
    assert.equal(counter.n, 0);
  });

  it('T2: isolating reject and sync throw does not abort later adapters', async () => {
    const good = { n: 0 };
    const rejecting = { n: 0 };
    const syncThrow = { n: 0 };
    const good2 = { n: 0 };
    const adapters = [
      goodAdapter('good', 'Good', good),
      {
        id: 'rejecting',
        displayName: 'Rejecting',
        fetchSnapshots() {
          rejecting.n += 1;
          return Promise.reject(new Error('reject-boom'));
        },
      },
      {
        id: 'sync-throw',
        displayName: 'Sync Throw',
        fetchSnapshots() {
          syncThrow.n += 1;
          throw new Error('sync-boom');
        },
      },
      goodAdapter('good2', 'Good Two', good2),
    ];

    const report = await runRefresh(adapters, { allowProbe: true });
    assert.equal(report.probed, true);
    assert.equal(report.results.length, 4);
    assert.equal(report.results[0]?.provider, 'good');
    assert.equal(report.results[0]?.ok, true);
    assert.equal(report.results[0]?.status, 'ok');
    assert.equal(report.results[1]?.provider, 'rejecting');
    assert.equal(report.results[1]?.ok, false);
    assert.equal(report.results[1]?.status, 'error');
    assert.match(report.results[1]?.error ?? '', /reject-boom/);
    assert.equal(report.results[2]?.provider, 'sync-throw');
    assert.equal(report.results[2]?.ok, false);
    assert.equal(report.results[2]?.status, 'error');
    assert.match(report.results[2]?.error ?? '', /sync-boom/);
    assert.equal(report.results[3]?.provider, 'good2');
    assert.equal(report.results[3]?.ok, true);
    assert.equal(report.results[3]?.status, 'ok');
    assert.equal(good.n, 1);
    assert.equal(rejecting.n, 1);
    assert.equal(syncThrow.n, 1);
    assert.equal(good2.n, 1);
  });

  it('T3: snapshot-level error is a failed result, not a throw', async () => {
    const report = await runRefresh(
      [
        {
          id: 'broken',
          displayName: 'Broken',
          fetchSnapshots() {
            return Promise.resolve([
              {
                accountId: 'acct',
                provider: 'broken',
                label: 'Broken',
                buckets: {},
                error: 'no creds',
              },
            ]);
          },
        },
      ],
      { allowProbe: true },
    );
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0]?.ok, false);
    assert.equal(report.results[0]?.status, 'error');
    assert.equal(report.results[0]?.accounts, 1);
    assert.match(report.results[0]?.error ?? '', /no creds/);
  });

  it('T4: formatRefresh glyphs/summary and JSON round-trip keys', async () => {
    const report = await runRefresh(
      [
        goodAdapter('xai', 'xAI', { n: 0 }),
        {
          id: 'openai-codex',
          displayName: 'Codex',
          fetchSnapshots() {
            return Promise.reject(new Error('unavailable'));
          },
        },
      ],
      { allowProbe: true },
    );
    const text = formatRefresh(report);
    assert.match(text, /\[OK\]/);
    assert.match(text, /\[FAIL\]/);
    assert.match(text, /Probed 2 provider\(s\): 1 ok, 0 partial, 0 no-data, 0 no-probe, 1 failed/);
    const parsed = JSON.parse(JSON.stringify(report)) as { probed?: unknown; results?: unknown };
    assert.equal(parsed.probed, true);
    assert.ok(Array.isArray(parsed.results));
    assert.ok('probed' in parsed);
    assert.ok('results' in parsed);
  });

  it('T5: refreshCommand --allow-probe isolates failures and exits 0', async () => {
    const good = { n: 0 };
    const rejecting = { n: 0 };
    const syncThrow = { n: 0 };
    const noData = { n: 0 };
    const good2 = { n: 0 };
    const adapters = [
      goodAdapter('good', 'Good', good),
      {
        id: 'rejecting',
        displayName: 'Rejecting',
        fetchSnapshots() {
          rejecting.n += 1;
          return Promise.reject(new Error('reject-boom'));
        },
      },
      {
        id: 'sync-throw',
        displayName: 'Sync Throw',
        fetchSnapshots() {
          syncThrow.n += 1;
          throw new Error('sync-boom');
        },
      },
      {
        id: 'nodata',
        displayName: 'No Data',
        fetchSnapshots() {
          noData.n += 1;
          return Promise.resolve([
            {
              accountId: 'nd',
              provider: 'nodata',
              label: 'No Data',
              buckets: {},
            },
          ]);
        },
      },
      goodAdapter('good2', 'Good Two', good2),
    ];

    const lines: string[] = [];
    const code = await refreshCommand(adapters, { allowProbe: true, json: false }, {
      log: (line) => {
        lines.push(line);
      },
    });
    assert.equal(code, 0);
    assert.equal(good.n, 1);
    assert.equal(rejecting.n, 1);
    assert.equal(syncThrow.n, 1);
    assert.equal(noData.n, 1);
    assert.equal(good2.n, 1);
    const text = lines.join('\n');
    assert.match(text, /\[OK\]\s+good \(Good\): 1 account\(s\)/);
    assert.match(text, /\[OK\]\s+good2 \(Good Two\): 1 account\(s\)/);
    assert.match(text, /\[FAIL\]\s+rejecting \(Rejecting\): reject-boom/);
    assert.match(text, /\[FAIL\]\s+sync-throw \(Sync Throw\): sync-boom/);
    assert.match(text, /\[NONE\]\s+nodata \(No Data\): authenticated, no gauge/);
    assert.match(text, /Probed 5 provider\(s\): 2 ok, 0 partial, 1 no-data, 0 no-probe, 2 failed/);

    const jsonLines: string[] = [];
    const jsonCode = await refreshCommand(adapters, { allowProbe: true, json: true }, {
      log: (line) => {
        jsonLines.push(line);
      },
    });
    assert.equal(jsonCode, 0);
    const parsed = JSON.parse(jsonLines.join('\n')) as {
      probed: boolean;
      results: Array<{ status: string }>;
    };
    assert.equal(parsed.probed, true);
    assert.equal(parsed.results.length, 5);
    assert.deepEqual(
      parsed.results.map((result) => result.status),
      ['ok', 'error', 'error', 'no-data', 'ok'],
    );
  });

  it('T6: refreshCommand without --allow-probe is a no-op exit 0', async () => {
    const counter = { n: 0 };
    const spy = goodAdapter('spy', 'Spy', counter);
    const lines: string[] = [];
    const code = await refreshCommand([spy], { allowProbe: false, json: false }, {
      log: (line) => {
        lines.push(line);
      },
    });
    assert.equal(code, 0);
    assert.equal(counter.n, 0);
    assert.match(lines.join('\n'), /no probes run/);

    const jsonLines: string[] = [];
    const jsonCode = await refreshCommand([spy], { allowProbe: false, json: true }, {
      log: (line) => {
        jsonLines.push(line);
      },
    });
    assert.equal(jsonCode, 0);
    assert.equal(counter.n, 0);
    assert.deepEqual(JSON.parse(jsonLines.join('\n')), { probed: false, results: [] });
  });

  it('mixed ok/error accounts classified partial in text and json', async () => {
    const adapter: Adapter = {
      id: 'mixed',
      displayName: 'Mixed',
      fetchSnapshots() {
        return Promise.resolve([
          bucketSnapshot('mixed', 'ok-acct'),
          {
            accountId: 'bad-acct',
            provider: 'mixed',
            label: 'bad-acct',
            buckets: {},
            error: 'auth failed',
          },
        ]);
      },
    };
    const report = await runRefresh([adapter], { allowProbe: true });
    assert.equal(report.results[0]?.status, 'partial');
    assert.equal(report.results[0]?.ok, false);
    assert.equal(report.results[0]?.accountsOk, 1);
    assert.equal(report.results[0]?.accountsFailed, 1);
    assert.equal(report.results[0]?.errors[0]?.accountId, 'bad-acct');
    const text = formatRefresh(report);
    assert.match(text, /\[PART\]/);
    assert.match(text, /bad-acct: auth failed/);
    assert.match(text, /1 partial/);
    const json = JSON.parse(JSON.stringify(report)) as {
      results: Array<{ status: string; errors: unknown[] }>;
    };
    assert.equal(json.results[0]?.status, 'partial');
    assert.ok(Array.isArray(json.results[0]?.errors));
  });

  it('cached-after-failure account counted failed, buckets retained', async () => {
    const snap: AccountSnapshot = {
      accountId: 'cached',
      provider: 'caf',
      label: 'cached',
      buckets: {
        requests: {
          usedPct: 12,
          source: 'poll',
          confidence: 'authoritative',
          fetchedAt: 1,
        },
      },
      probe: { outcome: 'cached-after-failure', detail: 'HTTP 503' },
    };
    const report = await runRefresh(
      [
        {
          id: 'caf',
          displayName: 'CAF',
          fetchSnapshots: () => Promise.resolve([snap]),
        },
      ],
      { allowProbe: true },
    );
    assert.equal(report.results[0]?.status, 'error');
    assert.equal(report.results[0]?.accountsFailed, 1);
    assert.equal(report.results[0]?.snapshots[0]?.buckets.requests?.usedPct, 12);
    assert.match(report.results[0]?.errors[0]?.error ?? '', /probe failed: HTTP 503; cached reading retained/);
  });

  it('all accounts cached-after-failure → error', async () => {
    const report = await runRefresh(
      [
        {
          id: 'all-caf',
          displayName: 'All CAF',
          fetchSnapshots: () =>
            Promise.resolve([
              {
                accountId: 'a',
                provider: 'all-caf',
                label: 'a',
                buckets: { requests: { usedPct: 1, source: 'poll' as const, confidence: 'authoritative' as const, fetchedAt: 1 } },
                probe: { outcome: 'cached-after-failure' as const, detail: 'timeout' },
              },
              {
                accountId: 'b',
                provider: 'all-caf',
                label: 'b',
                buckets: { requests: { usedPct: 2, source: 'poll' as const, confidence: 'authoritative' as const, fetchedAt: 1 } },
                probe: { outcome: 'cached-after-failure' as const, detail: 'timeout' },
              },
            ]),
        },
      ],
      { allowProbe: true },
    );
    assert.equal(report.results[0]?.status, 'error');
    assert.equal(report.results[0]?.ok, false);
    assert.equal(report.results[0]?.accountsFailed, 2);
    assert.equal(report.results[0]?.accountsOk, 0);
  });

  it('codex valid credentials → no-probe not ok', async () => {
    const report = await runRefresh(
      [
        {
          id: 'openai-codex',
          displayName: 'Codex',
          probes: false,
          fetchSnapshots: () =>
            Promise.resolve([
              {
                accountId: 'codex-default',
                provider: 'openai-codex',
                label: 'codex-default',
                buckets: {},
              },
            ]),
        },
      ],
      { allowProbe: true },
    );
    assert.equal(report.results[0]?.status, 'no-probe');
    assert.equal(report.results[0]?.ok, false);
    assert.match(formatRefresh(report), /no probe available/);
  });

  it('codex invalid credentials → error, not no-probe', async () => {
    const report = await runRefresh(
      [
        {
          id: 'openai-codex',
          displayName: 'Codex',
          probes: false,
          fetchSnapshots: () =>
            Promise.resolve([
              {
                accountId: 'codex-default',
                provider: 'openai-codex',
                label: 'codex-default',
                buckets: {},
                error: 'no valid Codex credentials',
              },
            ]),
        },
      ],
      { allowProbe: true },
    );
    assert.equal(report.results[0]?.status, 'error');
    assert.notEqual(report.results[0]?.status, 'no-probe');
  });

  it('plugin adapter declaring probes:false is reported no-probe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-plugin-noprobe-'));
    writeFileSync(
      join(dir, 'silent.js'),
      `
        module.exports = {
          id: 'silent',
          displayName: 'Silent',
          probes: false,
          async fetchSnapshots() {
            return [{ accountId: 's', provider: 'silent', label: 's', buckets: {} }];
          }
        };
      `,
    );
    const plugins = loadPlugins(dir);
    assert.equal(plugins[0]?.probes, false);
    const report = await runRefresh(plugins, { allowProbe: true });
    assert.equal(report.results[0]?.status, 'no-probe');
  });

  it('plugin probes non-boolean warns and is treated as probing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-plugin-badprobes-'));
    writeFileSync(
      join(dir, 'weird.js'),
      `
        module.exports = {
          id: 'weird',
          displayName: 'Weird',
          probes: 'yes',
          async fetchSnapshots() {
            return [{
              accountId: 'w',
              provider: 'weird',
              label: 'w',
              buckets: { daily: { usedPct: 1, source: 'poll', confidence: 'authoritative', fetchedAt: 1 } }
            }];
          }
        };
      `,
    );
    const warnings: string[] = [];
    const plugins = loadPlugins(dir, (msg) => warnings.push(msg));
    assert.match(warnings.join('\n'), /probes must be boolean/);
    assert.equal(plugins[0]?.probes, undefined);
    const report = await runRefresh(plugins, { allowProbe: true });
    assert.equal(report.results[0]?.status, 'ok');
  });

  it('adapter without probe field treated as fetched', async () => {
    const report = await runRefresh(
      [
        {
          id: 'plain',
          displayName: 'Plain',
          fetchSnapshots: () => Promise.resolve([bucketSnapshot('plain')]),
        },
      ],
      { allowProbe: true },
    );
    assert.equal(report.results[0]?.status, 'ok');
    assert.equal(report.results[0]?.ok, true);
    assert.equal(report.results[0]?.snapshots[0]?.probe, undefined);
  });
});

const cliPath = join(__dirname, '..', 'src', 'cli.js');

function isolatedEnv(root: string, dbPath: string, pluginsDir: string): NodeJS.ProcessEnv {
  mkdirSync(join(root, 'migrate'), { recursive: true });
  return {
    ...process.env,
    QLB_PLUGINS_DIR: pluginsDir,
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

describe('qlb refresh observation recording', () => {
  it('empty probe records a failed observation so why does not keep the stale winner', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-refresh-obs-'));
    const pluginsDir = join(root, 'plugins');
    mkdirSync(pluginsDir);
    writeFileSync(
      join(pluginsDir, 'empty-anthropic.js'),
      `
        module.exports = {
          id: 'anthropic',
          displayName: 'Empty Anthropic',
          async fetchSnapshots() { return []; }
        };
      `,
    );
    const dbPath = join(root, 'qlb.db');
    const prior = JSON.stringify({
      at: '2026-01-01T00:00:00.000Z',
      source: 'resolve',
      generation: 3,
      persisted: true,
      outcome: 'ok',
      accounts: [{
        accountId: 'acct-a',
        provider: 'anthropic',
        label: 'acct-a',
        buckets: {
          '5h': { usedPct: 10, source: 'poll', confidence: 'authoritative', fetchedAt: 1 },
          '7d': { usedPct: 10, source: 'poll', confidence: 'authoritative', fetchedAt: 1 },
        },
      }],
    });
    const store = openStore(dbPath);
    store.setConfig('observed:anthropic', prior);
    store.close();

    const env = isolatedEnv(root, dbPath, pluginsDir);
    const result = runCli(['refresh', '--allow-probe', '--json'], env);
    assert.equal(result.status, 0, result.stderr);

    const after = openStore(dbPath);
    let recorded: {
      generation: number;
      outcome: string;
      error?: string;
      accounts: unknown[];
    };
    try {
      const raw = after.getConfig('observed:anthropic');
      assert.ok(raw);
      recorded = JSON.parse(raw!) as typeof recorded;
      assert.ok(recorded.generation > 3, `generation should advance, got ${recorded.generation}`);
      assert.equal(recorded.outcome, 'failed');
      assert.ok(typeof recorded.error === 'string' && recorded.error.length > 0);
      assert.deepEqual(recorded.accounts, []);
    } finally {
      after.close();
    }

    const why = runCli(['why', '--model', 'claude-sonnet-5', '--json'], env);
    assert.equal(why.status, 0, why.stderr);
    const body = JSON.parse(why.stdout) as {
      accountId: string | null;
      observations: Array<{ status: string; generation: number | null; error?: string; detail?: string }>;
    };
    assert.notEqual(body.accountId, 'acct-a');
    const failed = body.observations.filter((o) => o.status === 'failed');
    assert.ok(failed.length > 0);
    assert.match(failed[0]?.detail ?? '', /last observation FAILED at .+ \(gen \d+\):/);
    assert.match(why.stdout, /last observation FAILED at/);
  });

  it('cached-after-failure refresh is recalled as failed and why cannot select it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-refresh-caf-'));
    const pluginsDir = join(root, 'plugins');
    mkdirSync(pluginsDir);
    writeFileSync(
      join(pluginsDir, 'caf-anthropic.js'),
      `
        module.exports = {
          id: 'anthropic',
          displayName: 'CAF Anthropic',
          async fetchSnapshots() {
            return [{
              accountId: 'acct-caf',
              provider: 'anthropic',
              label: 'acct-caf',
              buckets: {
                '5h': { usedPct: 10, source: 'poll', confidence: 'authoritative', fetchedAt: 1 },
                '7d': { usedPct: 10, source: 'poll', confidence: 'authoritative', fetchedAt: 1 },
              },
              probe: { outcome: 'cached-after-failure', detail: 'HTTP 503' },
            }];
          }
        };
      `,
    );
    const dbPath = join(root, 'qlb.db');
    const env = isolatedEnv(root, dbPath, pluginsDir);
    const result = runCli(['refresh', '--allow-probe', '--json'], env);
    assert.equal(result.status, 0, result.stderr);

    const store = openStore(dbPath);
    try {
      const recalled = await collectCandidates({
        adapters: [{ id: 'anthropic', displayName: 'A', fetchSnapshots: async () => [] }],
        store,
        models: ['claude-sonnet-5'],
        probe: false,
      });
      assert.ok(recalled.observations.some((o) => o.status === 'failed'));
      assert.equal(recalled.snapshots.length, 0);
      const why = explainWhy({
        model: 'claude-sonnet-5',
        snapshots: recalled.snapshots,
        observations: recalled.observations,
        store,
      });
      assert.notEqual(why.accountId, 'acct-caf');
    } finally {
      store.close();
    }
  });

  it('partial refresh keeps the healthy account selectable and labels the failed one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-refresh-partial-'));
    const pluginsDir = join(root, 'plugins');
    mkdirSync(pluginsDir);
    writeFileSync(
      join(pluginsDir, 'partial-anthropic.js'),
      `
        module.exports = {
          id: 'anthropic',
          displayName: 'Partial Anthropic',
          async fetchSnapshots() {
            const buckets = {
              '5h': { usedPct: 10, source: 'poll', confidence: 'authoritative', fetchedAt: 1 },
              '7d': { usedPct: 10, source: 'poll', confidence: 'authoritative', fetchedAt: 1 },
            };
            return [
              { accountId: 'healthy', provider: 'anthropic', label: 'healthy', buckets },
              {
                accountId: 'sick',
                provider: 'anthropic',
                label: 'sick',
                buckets,
                probe: { outcome: 'cached-after-failure', detail: 'HTTP 503' },
              },
            ];
          }
        };
      `,
    );
    const dbPath = join(root, 'qlb.db');
    const env = isolatedEnv(root, dbPath, pluginsDir);
    const result = runCli(['refresh', '--allow-probe', '--json'], env);
    assert.equal(result.status, 0, result.stderr);

    const store = openStore(dbPath);
    try {
      const recalled = await collectCandidates({
        adapters: [{ id: 'anthropic', displayName: 'A', fetchSnapshots: async () => [] }],
        store,
        models: ['claude-sonnet-5'],
        probe: false,
      });
      const why = explainWhy({
        model: 'claude-sonnet-5',
        snapshots: recalled.snapshots,
        observations: recalled.observations,
        store,
      });
      assert.equal(why.accountId, 'healthy');
      const sick = why.losers.find((l) => l.accountId === 'sick');
      assert.ok(sick);
      assert.equal(sick!.reason, 'unavailable');
      assert.match(sick!.detail, /HTTP 503|probe failed|failed/);
    } finally {
      store.close();
    }
  });
});
