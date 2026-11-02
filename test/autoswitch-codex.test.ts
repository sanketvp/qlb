// Ported from claude-swap 0.28.0 (MIT, Copyright (c) realiti4) — autoswitch.py

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideAutoswitch, type AutoswitchAccount } from '../src/autoswitch';
import { codexAutoTick, type CodexAutoDeps } from '../src/auto/openai-codex';
import { CodexProcessCheckFailed, type CodexActiveDeps, type CodexActiveInput, type CodexActiveOutcome } from '../src/codex-active';
import type { CodexAuthDocument } from '../src/codex-auth';
import type { CodexSwitchDeps } from '../src/codex-switch';
import { bucketClass } from '../src/scoring';
import { openStore } from '../src/store';

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

function jwt(exp: number, claims: Record<string, unknown> = {}): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp, ...claims })).toString('base64url')}.sig`;
}

function document(expiresAt: number, lastRefresh = NOW): CodexAuthDocument {
  return {
    tokens: {
      id_token: jwt(Math.floor(expiresAt / 1_000), { 'https://api.openai.com/auth': { chatgpt_user_id: 'user-a', chatgpt_account_id: 'account-a' } }), access_token: jwt(Math.floor(expiresAt / 1_000)),
      refresh_token: 'fixture-refresh-token', account_id: 'account-a',
    },
    last_refresh: new Date(lastRefresh).toISOString(),
  };
}

function autoHarness(overrides: Partial<CodexAutoDeps> = {}) {
  const records: Array<{ accountId: string; result: { status: string; readings?: Record<string, unknown>; http429?: boolean; retryAfterS?: number } }> = [];
  const snapshots: Record<string, Record<string, unknown>> = { 'user-a:account-a': {} };
  const polls: Record<string, { pollIntervalS?: number; nextDueAt?: number; heldUntil?: number | null; backoffUntil?: number | null; last429At?: number | null }> = {};
  const configs: Record<string, string> = {};
  let activeId: string | null = 'user-a:account-a';
  let now = NOW;
  const store = {
    getCodexActiveLogin: () => activeId,
    getAllSnapshots: (accountId: string) => snapshots[accountId] ?? {},
    recordUsagePollResult: (_provider: string, accountId: string, result: { status: string; readings?: Record<string, unknown>; http429?: boolean; retryAfterS?: number }) => {
      records.push({ accountId, result });
      if (result.readings) snapshots[accountId] = result.readings;
      if (result.http429) polls[accountId] = { ...polls[accountId], last429At: Math.floor(now / 1000), backoffUntil: Math.floor(now / 1000) + (result.retryAfterS ?? 30) };
    },
    listUsagePolls: () => polls,
    writeUsagePollPlans: (_provider: string, plans: Record<string, { nextDueAt: number; pollIntervalS: number }>) => {
      for (const [accountId, plan] of Object.entries(plans)) polls[accountId] = { ...polls[accountId], ...plan };
      return Object.keys(plans).length;
    },
    setUsagePollHeldUntil: (_provider: string, accountId: string, heldUntil: number | null) => { polls[accountId] = { ...polls[accountId], heldUntil }; },
    getAutoswitchSettings: () => ({ threshold: 90, weeklyThreshold: null }),
    getConfig: (key: string) => configs[key] ?? null,
    setConfig: (key: string, value: string) => { configs[key] = value; },
  };
  let liveDocument = document(NOW + 10 * 60_000);
  const active = {
    store,
    readLive: async () => ({ status: 'ok', doc: liveDocument }),
  } as unknown as CodexAutoDeps['active'];
  const deps: CodexAutoDeps = {
    active,
    switch: {} as CodexSwitchDeps,
    now: () => now,
    probeUsage: async () => ({ status: 200, source: 'wham', keys: [], windows: [] }),
    refreshActive: async () => ({ status: 'noop', document: liveDocument }),
    activeRenewers: async () => [],
    reconcileRecovery: async () => undefined,
    runDueWatches: async () => undefined,
    ...overrides,
  };
  return {
    deps, records, snapshots, polls, configs,
    setLiveDocument: (next: CodexAuthDocument) => { liveDocument = next; },
    setActiveId: (next: string | null) => { activeId = next; },
    setNow: (next: number) => { now = next; },
  };
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

  it('does not record when refresh adopts another active account mid-tick', async () => {
    const h = autoHarness({
      refreshActive: async () => {
        h.setActiveId('user-b:account-b');
        return { status: 'drift', accountId: 'user-b:account-b' };
      },
    });
    h.setLiveDocument(document(NOW + 3 * 60_000));

    await codexAutoTick(h.deps);

    assert.equal(h.records.length, 0);
  });

  it('does not record when the active account changes during the usage request', async () => {
    const h = autoHarness({
      probeUsage: async () => {
        h.setActiveId('user-b:account-b');
        return { status: 200, source: 'wham', keys: [], windows: [{ bucket: 'primary', usedPct: 20 }] };
      },
    });

    await codexAutoTick(h.deps);

    assert.equal(h.records.length, 0);
  });

  it('recovers a 401 even when rollout fallback windows are available', async () => {
    const calls: CodexActiveInput[] = [];
    const h = autoHarness({
      probeUsage: async () => ({ status: 401, source: 'codex-rollout', keys: [], windows: [{ bucket: 'primary', usedPct: 20 }] }),
      refreshActive: async (_deps, input) => {
        calls.push(input);
        return { status: 'noop', document: document(NOW + 10 * 60_000) };
      },
    });

    await codexAutoTick(h.deps);

    assert.equal(calls[0]?.trigger, 'unauthorized');
    assert.notEqual(h.records.at(-1)?.result.status, 'ok');
  });

  const stoppedOutcomes: CodexActiveOutcome[] = [
    { status: 'held', pids: [1], document: document(NOW + 10 * 60_000), action: 'noop' },
    { status: 'dead', reason: 'refresh-token-rejected' },
    { status: 'drift', accountId: 'user-b:account-b' },
  ];
  for (const outcome of stoppedOutcomes) {
    it(`ends the tick without a usage probe for refresh ${outcome.status}`, async () => {
      let probes = 0;
      const h = autoHarness({
        probeUsage: async () => { probes += 1; return { status: 200, source: 'wham', keys: [] }; },
        refreshActive: async () => outcome,
      });
      h.setLiveDocument(document(NOW + 3 * 60_000));

      await codexAutoTick(h.deps);

      assert.equal(probes, 0);
      if (outcome.status === 'held') assert.ok((h.polls['user-a:account-a']?.heldUntil ?? 0) > NOW / 1000);
    });
  }

  it('treats a process-list failure as no action this tick', async () => {
    const h = autoHarness({
      activeRenewers: async () => { throw new CodexProcessCheckFailed(); },
    });
    h.setLiveDocument(document(NOW - 1));

    await codexAutoTick(h.deps);

    assert.equal(h.records.length, 0);
  });

  it('retains the idle hold start across ticks until the engine cap expires', async () => {
    const h = autoHarness({ activeRenewers: async () => [{ pid: 1 }] });
    h.setLiveDocument(document(NOW - 1));
    const first = await codexAutoTick(h.deps);
    h.polls['user-a:account-a'] = {};
    h.setNow(NOW + 31 * 60_000);
    const second = await codexAutoTick(h.deps);

    assert.equal(second.idleHoldSinceMs, first.idleHoldSinceMs);
    const decision = decideAutoswitch({
      nowMs: NOW + 31 * 60_000, provider: 'openai-codex', codexL13VerifiedAtMs: NOW - 1,
      activeAccountId: 'user-a:account-a', accounts: [{ accountId: 'user-a:account-a', buckets: {} }], activeCredentialExpired: true,
      idleHoldSinceMs: second.idleHoldSinceMs,
    });
    assert.ok(decision.kind !== 'stay' || decision.reason !== 'active-idle');
  });

  it('does not probe an active account before its usage poll is due', async () => {
    let probes = 0;
    const h = autoHarness({ probeUsage: async () => { probes += 1; return { status: 200, source: 'wham', keys: [] }; } });
    h.polls['user-a:account-a'] = { nextDueAt: NOW / 1000 + 60, pollIntervalS: 300 };

    await codexAutoTick(h.deps);

    assert.equal(probes, 0);
  });

  it('records a 429 with Retry-After as a rate limit and schedules its backoff', async () => {
    const h = autoHarness({ probeUsage: async () => ({ status: 429, source: 'unknown', keys: [], retryAfterS: 120 }) });

    await codexAutoTick(h.deps);

    assert.equal(h.records.at(-1)?.result.status, 'http-429');
    assert.equal(h.records.at(-1)?.result.http429, true);
    assert.equal(h.records.at(-1)?.result.retryAfterS, 120);
    assert.ok((h.polls['user-a:account-a']?.backoffUntil ?? 0) > NOW / 1000);
  });

  it('updates only held_until when storing a Codex renewer hold', () => {
    const store = openStore(':memory:');
    try {
      store.recordUsagePollResult('openai-codex', 'user-a:account-a', { attemptedAt: 10, status: 'ok', readings: {} });
      store.writeUsagePollPlans('openai-codex', { 'user-a:account-a': { nextDueAt: 20, pollIntervalS: 30 } });
      const before = store.listUsagePolls('openai-codex')['user-a:account-a'];
      store.setUsagePollHeldUntil('openai-codex', 'user-a:account-a', 40);
      const after = store.listUsagePolls('openai-codex')['user-a:account-a'];

      assert.equal(after?.heldUntil, 40);
      assert.deepEqual({ ...after, heldUntil: null }, { ...before, heldUntil: null });
    } finally {
      store.close();
    }
  });
});
