import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatRefresh, refreshCommand, runRefresh } from '../src/refresh';

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
    assert.match(text, /Probed 2 provider\(s\): 1 ok, 0 no-data, 1 failed/);
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
    assert.match(text, /Probed 5 provider\(s\): 2 ok, 1 no-data, 2 failed/);

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
});
