// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — autoswitch.py

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideAutoswitch, type AutoswitchAccount } from '../src/autoswitch';
import { codexAutoTick, type CodexAutoDeps } from '../src/auto/openai-codex';
import type { CodexActiveDeps, CodexActiveInput } from '../src/codex-active';
import type { CodexAuthDocument } from '../src/codex-auth';
import type { CodexSwitchDeps } from '../src/codex-switch';
import { bucketClass } from '../src/scoring';

const NOW = 1_700_000_000_000;
function accounts(activeUsed: number | null): AutoswitchAccount[] {
  return [
    { accountId: '1', buckets: { primary: { usedPct: activeUsed } } },
    { accountId: '2', buckets: { primary: { usedPct: 20 } } },
  ];
}

describe('autoswitch Codex gate — S15 / AC28 engine inputs', () => {
  for (const [name, overrides] of [
    ['proactive', { accounts: accounts(95) }],
    ['consume-first', { accounts: accounts(20), requestedTrigger: 'consume-first' }],
    ['at-limit', { accounts: accounts(100) }],
    ['failover', { accounts: accounts(null), unhealthyTicks: 2 }],
    ['parked', { accounts: [
      { accountId: '1', buckets: { primary: { usedPct: 100 } } },
      { accountId: '2', buckets: { primary: { usedPct: 100, resetAt: NOW + 1000 } } },
    ] }],
  ] as const) {
    it(`refuses ${name} until the L13 receipt exists`, () => {
      assert.deepEqual(decideAutoswitch({
        nowMs: NOW,
        provider: 'openai-codex',
        activeAccountId: '1',
        ...overrides,
      }), { kind: 'stay', reason: 'codex-l13-unverified', unhealthyTicks: name === 'failover' ? 3 : 0 });
    });
  }

  it('classifies a header-only Codex usage pair like autoswitch', () => {
    // Spec §4.4.4 line 666: primary is 5h and secondary is weekly.
    assert.equal(bucketClass('primary'), '5h');
    assert.equal(bucketClass('secondary'), 'weekly');

    const secondaryReset = NOW + 60 * 60 * 1000;
    const result = decideAutoswitch({
      nowMs: NOW,
      provider: 'openai-codex',
      codexL13VerifiedAtMs: NOW - 1,
      activeAccountId: '1',
      settings: { threshold: 90, weeklyThreshold: 70 },
      accounts: [
        { accountId: '1', buckets: { primary: { usedPct: 91, resetAt: NOW + 3 * 60 * 60 * 1000 }, secondary: { usedPct: 90, resetAt: secondaryReset } } },
        { accountId: '2', buckets: { primary: { usedPct: 10 }, secondary: { usedPct: 10 } } },
      ],
    });
    assert.equal(result.kind, 'switch');
    if (result.kind === 'switch') assert.equal(result.leftRecoveryAtMs, secondaryReset);
  });

  it('uses Codex secondary as the consume-first weekly reset', () => {
    const result = decideAutoswitch({
      nowMs: NOW,
      provider: 'openai-codex',
      codexL13VerifiedAtMs: NOW - 1,
      activeAccountId: '1',
      settings: { strategy: 'consume-first' },
      accounts: [
        { accountId: '1', buckets: { primary: { usedPct: 20 }, secondary: { usedPct: 20, resetAt: NOW + 2 * 60 * 60 * 1000 } } },
        { accountId: '2', buckets: { primary: { usedPct: 10 }, secondary: { usedPct: 10, resetAt: NOW + 60 * 60 * 1000 } } },
      ],
    });
    assert.equal(result.kind, 'switch');
    if (result.kind === 'switch') {
      assert.equal(result.targetId, '2');
      assert.equal(result.reason, 'consume-first');
    }
  });

  it('allows automatic Codex switching after the L13 receipt', () => {
    const result = decideAutoswitch({
      nowMs: NOW,
      provider: 'openai-codex',
      codexL13VerifiedAtMs: NOW - 1,
      activeAccountId: '1',
      accounts: accounts(100),
    });
    assert.equal(result.kind, 'switch');
  });
});

function jwt(exp: number): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
}

function document(expiresAt: number, lastRefresh = NOW): CodexAuthDocument {
  return {
    tokens: {
      id_token: 'fixture-id-token', access_token: jwt(Math.floor(expiresAt / 1_000)),
      refresh_token: 'fixture-refresh-token', account_id: 'account-a',
    },
    last_refresh: new Date(lastRefresh).toISOString(),
  };
}

function autoHarness(overrides: Partial<CodexAutoDeps> = {}) {
  const records: Array<{ accountId: string; result: { status: string; readings?: Record<string, unknown> } }> = [];
  const snapshots: Record<string, Record<string, unknown>> = { 'user-a:account-a': {} };
  const store = {
    getCodexActiveLogin: () => 'user-a:account-a',
    getAllSnapshots: (accountId: string) => snapshots[accountId] ?? {},
    recordUsagePollResult: (_provider: string, accountId: string, result: { status: string; readings?: Record<string, unknown> }) => {
      records.push({ accountId, result });
      if (result.readings) snapshots[accountId] = result.readings;
    },
  };
  let liveDocument = document(NOW + 10 * 60_000);
  const active = {
    store,
    readLive: async () => ({ status: 'ok', doc: liveDocument }),
  } as unknown as CodexActiveDeps;
  const deps: CodexAutoDeps = {
    active,
    switch: {} as CodexSwitchDeps,
    now: () => NOW,
    probeUsage: async () => ({ status: 200, source: 'wham', keys: [], windows: [] }),
    refreshActive: async () => ({ status: 'noop', document: liveDocument }),
    activeRenewers: async () => [],
    reconcileRecovery: async () => undefined,
    runDueWatches: async () => undefined,
    ...overrides,
  };
  return { deps, records, snapshots, setLiveDocument: (next: CodexAuthDocument) => { liveDocument = next; } };
}

describe('C8 Codex poll and refresh', () => {
  it('maps usage primary and secondary windows to authoritative snapshots', async () => {
    const h = autoHarness({
      probeUsage: async () => ({
        status: 200, source: 'wham', keys: [], windows: [
          { bucket: 'primary', usedPct: 12, resetAt: NOW + 60_000 },
          { bucket: 'secondary', usedPct: 34, resetAt: NOW + 120_000 },
        ],
      }),
    });

    const result = await codexAutoTick(h.deps);

    assert.deepEqual(Object.keys(result.readings).sort(), ['primary', 'secondary']);
    assert.equal(result.readings.primary.usedPct, 12);
    assert.equal(result.readings.secondary.usedPct, 34);
    assert.equal(h.records.at(-1)?.result.status, 'ok');
    assert.equal((h.records.at(-1)?.result.readings?.primary as { confidence: string }).confidence, 'authoritative');
  });

  it('refreshes an active near-expiry login before its usage poll', async () => {
    const calls: CodexActiveInput[] = [];
    const h = autoHarness({
      refreshActive: async (_deps, input) => {
        calls.push(input);
        return { status: 'noop', document: document(NOW + 10 * 60_000) };
      },
    });
    h.setLiveDocument(document(NOW + 3 * 60_000));

    await codexAutoTick(h.deps);

    assert.deepEqual(calls, [{ trigger: 'proactive-expiry' }]);
  });

  it('an expired active login with a renewer is unknown and holds', async () => {
    let probes = 0;
    let refreshes = 0;
    const h = autoHarness({
      activeRenewers: async () => [{ pid: 42 }],
      probeUsage: async () => { probes += 1; return { status: 200, source: 'wham', keys: [] }; },
      refreshActive: async () => { refreshes += 1; return { status: 'noop', document: document(NOW) }; },
    });
    h.setLiveDocument(document(NOW - 1_000));

    const result = await codexAutoTick(h.deps);

    assert.equal(result.activeCredentialExpired, true);
    assert.equal(result.idleHoldSinceMs, NOW);
    assert.equal(h.records.at(-1)?.result.status, 'usage-unknown');
    assert.equal(probes, 0);
    assert.equal(refreshes, 0);
  });

  it('uses unauthorized recovery when the usage poll returns 401', async () => {
    const calls: CodexActiveInput[] = [];
    const h = autoHarness({
      probeUsage: async () => ({ status: 401, source: 'unknown', keys: [] }),
      refreshActive: async (_deps, input) => {
        calls.push(input);
        return { status: 'noop', document: document(NOW + 10 * 60_000) };
      },
    });

    await codexAutoTick(h.deps);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.trigger, 'unauthorized');
    assert.equal(typeof (calls[0] as Extract<CodexActiveInput, { trigger: 'unauthorized' }>).accessFp, 'string');
  });

  it('records codex-won without treating the active slot as dead', async () => {
    const h = autoHarness({
      refreshActive: async () => ({
        status: 'codex-won', adopted: true, pids: [42], document: document(NOW + 10 * 60_000),
      }),
    });
    h.setLiveDocument(document(NOW + 3 * 60_000));

    const result = await codexAutoTick(h.deps);

    assert.equal(result.refresh?.status, 'codex-won');
    assert.equal(h.records.at(-1)?.result.status, 'codex-won');
  });

  it('reconciles recovery and runs due watches on every tick', async () => {
    const calls: string[] = [];
    const h = autoHarness({
      reconcileRecovery: async () => { calls.push('reconcile'); },
      runDueWatches: async (_deps, now) => { calls.push(`watches:${now}`); },
    });

    await codexAutoTick(h.deps);

    assert.deepEqual(calls, ['reconcile', `watches:${NOW}`]);
  });
});
