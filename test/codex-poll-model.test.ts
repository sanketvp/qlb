import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { pollOpenAiCodex, type CodexAutoDeps } from '../src/auto/openai-codex';
import type { CodexAuthDocument } from '../src/codex-auth';
import type { CodexSwitchDeps } from '../src/codex-switch';
import { openStore } from '../src/store';
import type { BucketReading } from '../src/types';

type R1Case = { rule: 'r1'; input: { kind: 'held' | 'tick'; now: number; heldUntil: number | null; interval: number }; expected: { probe: boolean; heldUntil: number | null } };
type R4Step = { now: number; held: boolean };
type R4Case = { rule: 'r4'; input: { initialHeldUntil: number | null; interval: number; steps: R4Step[] }; expected: { heldUntil: number | null } };
type R2Case = { rule: 'r2'; input: { kind: 'codex-won' | 'failure' | 'success'; failures: number; readings: boolean; seedAt: number; attemptedAt: number }; expected: { failures: number; backoffUntil: number | null; readings: boolean; lastStatus: string; lastAttemptAt: number } };
type Hold = { accountId: string; sinceMs: number };
type R3Case = { rule: 'r3'; input: { activeAccount: string; raw: string }; expected: { parsed: Hold | null } };
type Case = R1Case | R2Case | R3Case | R4Case;

const cases = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/codex-poll-model-cases.json'), 'utf8')) as Case[];
const PROVIDER = 'openai-codex';
const ACCOUNT = 'fixture-user:fixture-account';

function jwt(exp: number): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.sig`;
}

function document(nowMs: number, expiresAtMs: number): CodexAuthDocument {
  return {
    tokens: { id_token: jwt(Math.floor(expiresAtMs / 1_000)), access_token: jwt(Math.floor(expiresAtMs / 1_000)), refresh_token: 'fixture-token', account_id: 'fixture-account' },
    last_refresh: new Date(nowMs).toISOString(),
  };
}

function autoHarness(nowMs: number, raw = '') {
  const polls: Record<string, { pollIntervalS?: number; heldUntil?: number | null; nextDueAt?: number }> = {};
  const configs: Record<string, string> = { 'auto.openai-codex.idleHoldSince': raw };
  const snapshots: Record<string, Record<string, BucketReading>> = { [ACCOUNT]: {} };
  let probes = 0;
  const store = {
    getCodexActiveLogin: () => ACCOUNT,
    getAllSnapshots: (accountId: string) => snapshots[accountId] ?? {},
    recordUsagePollResult: () => {},
    listUsagePolls: () => polls,
    writeUsagePollPlans: () => 0,
    compareAndSetUsagePollHeldUntil: (_provider: string, accountId: string, expectedHeldUntil: number | null, heldUntil: number | null) => {
      const current = polls[accountId]?.heldUntil ?? null;
      if (current !== expectedHeldUntil) return false;
      polls[accountId] = { ...polls[accountId], heldUntil };
      return true;
    },
    getAutoswitchSettings: () => ({ threshold: 90, weeklyThreshold: null }),
    getConfig: (key: string) => configs[key] ?? null,
    setConfig: (key: string, value: string) => { configs[key] = value; },
  };
  const active = {
    store,
    authPath: '/fixture/auth.json',
    readLive: async () => ({ status: 'ok' as const, doc: document(nowMs, nowMs + 10 * 60_000), sha256: 'fixture', inode: 1 }),
  } as unknown as CodexAutoDeps['active'];
  const deps: CodexAutoDeps = {
    active,
    switch: {} as CodexSwitchDeps,
    now: () => nowMs,
    probeUsage: async () => { probes += 1; return { status: 200, source: 'wham', keys: [], windows: [] }; },
    refreshActive: async () => ({ status: 'noop', document: document(nowMs, nowMs + 10 * 60_000) }),
    activeRenewers: async () => [],
    reconcileRecovery: async () => undefined,
    runDueWatches: async () => undefined,
  };
  return { deps, polls, configs, setExpired: () => { active.readLive = async () => ({ status: 'ok', doc: document(nowMs, nowMs - 1), sha256: 'fixture', inode: 1 }); }, setNearExpiry: () => { active.readLive = async () => ({ status: 'ok', doc: document(nowMs, nowMs + 3 * 60_000), sha256: 'fixture', inode: 1 }); }, setRenewer: () => { deps.activeRenewers = async () => [{ pid: 1 }]; }, setHeldRefresh: () => { deps.refreshActive = async () => ({ status: 'held', pids: [1], document: document(nowMs, nowMs + 10 * 60_000), action: 'noop' }); }, probes: () => probes };
}

async function runR1(item: R1Case) {
  const h = autoHarness(item.input.now * 1_000);
  h.polls[ACCOUNT] = { pollIntervalS: item.input.interval, heldUntil: item.input.heldUntil };
  if (item.input.kind === 'held') {
    h.setNearExpiry();
    h.setHeldRefresh();
  }
  await pollOpenAiCodex(h.deps);
  return { probe: h.probes() > 0, heldUntil: h.polls[ACCOUNT]?.heldUntil ?? null };
}

async function runR4(item: R4Case) {
  const h = autoHarness(item.input.steps[0]!.now * 1_000);
  h.polls[ACCOUNT] = { pollIntervalS: item.input.interval, heldUntil: item.input.initialHeldUntil };
  h.setNearExpiry();
  h.setHeldRefresh();
  for (const step of item.input.steps) {
    h.deps.now = () => step.now * 1_000;
    if (step.held) await pollOpenAiCodex(h.deps);
    else {
      h.deps.refreshActive = async () => ({ status: 'noop', document: document(step.now * 1_000, step.now * 1_000 + 10 * 60_000) });
      await pollOpenAiCodex(h.deps);
      h.setHeldRefresh();
      h.setNearExpiry();
    }
  }
  return { heldUntil: h.polls[ACCOUNT]?.heldUntil ?? null };
}

function reading(at: number): Record<string, BucketReading> {
  return { primary: { usedPct: 10, fetchedAt: at * 1_000, source: 'poll', confidence: 'authoritative' } };
}

function seedStore(item: R2Case) {
  const store = openStore(':memory:');
  const accountId = `model-${item.input.seedAt}`;
  if (item.input.readings) store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: item.input.seedAt, status: 'ok', readings: reading(item.input.seedAt) });
  for (let n = 1; n <= item.input.failures; n += 1) {
    store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: item.input.seedAt + n, status: 'failure' });
  }
  return { store, accountId };
}

function runR2(item: R2Case) {
  const { store, accountId } = seedStore(item);
  if (item.input.kind === 'success') {
    store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: item.input.attemptedAt, status: 'ok', readings: reading(item.input.attemptedAt) });
  } else {
    store.recordUsagePollResult(PROVIDER, accountId, { attemptedAt: item.input.attemptedAt, status: item.input.kind });
  }
  const row = store.listUsagePolls(PROVIDER)[accountId];
  const actual = {
    failures: row?.consecutiveFailures ?? 0,
    backoffUntil: row?.backoffUntil ?? null,
    readings: Object.keys(store.getAllSnapshots(accountId)).length > 0,
    lastStatus: row?.lastStatus ?? '',
    lastAttemptAt: row?.lastAttemptAt ?? 0,
  };
  store.close();
  return actual;
}

async function runR3(item: R3Case) {
  const nowMs = 2_000_000_000_000;
  const h = autoHarness(nowMs, item.input.raw);
  h.setExpired();
  h.setRenewer();
  const result = await pollOpenAiCodex(h.deps);
  const actual = result.idleHoldSinceMs === nowMs
    ? null
    : result.idleHoldSinceMs === null ? null : { accountId: item.input.activeAccount, sinceMs: result.idleHoldSinceMs };
  return { parsed: actual };
}

test('Lean Codex poll model agrees with production seams', async () => {
  const counts: Record<string, number> = { r1: 0, r2: 0, r3: 0, r4: 0 };
  const coverage = { heldLeaseFloor: 0, heldLeaseInterval: 0, firstFailure: 0, cappedBackoff: 0, codexWonNewRow: 0, foreignAccountHold: 0, multiTickStaleHold: 0, multiTickExpiry: 0 };
  const mismatches: Array<{ item: Case; actual: unknown }> = [];
  for (const item of cases) {
    counts[item.rule] += 1;
    if (item.rule === 'r1' && item.input.kind === 'held') {
      if (item.input.interval <= 60) coverage.heldLeaseFloor += 1;
      else coverage.heldLeaseInterval += 1;
    }
    if (item.rule === 'r2') {
      if (item.input.kind === 'failure' && item.input.failures === 0 && !item.input.readings) coverage.firstFailure += 1;
      if (item.input.kind === 'failure' && item.input.failures + 1 >= 6) coverage.cappedBackoff += 1;
      if (item.input.kind === 'codex-won' && item.input.failures === 0 && !item.input.readings) coverage.codexWonNewRow += 1;
    }
    if (item.rule === 'r3' && item.input.raw.includes('other-user:other-account')) coverage.foreignAccountHold += 1;
    if (item.rule === 'r4') {
      if (item.input.steps.some((step) => step.held && item.input.initialHeldUntil !== null && step.now < item.input.initialHeldUntil)) coverage.multiTickStaleHold += 1;
      if (item.input.steps.some((step) => step.now === item.input.initialHeldUntil)) coverage.multiTickExpiry += 1;
    }
    const actual = item.rule === 'r1' ? await runR1(item) : item.rule === 'r2' ? runR2(item) : item.rule === 'r3' ? await runR3(item) : await runR4(item);
    if (JSON.stringify(actual) !== JSON.stringify(item.expected)) mismatches.push({ item, actual });
  }
  console.log(`codex-poll Lean differential: r1=${counts.r1} r2=${counts.r2} r3=${counts.r3} r4=${counts.r4} mismatches=${mismatches.length} coverage=${JSON.stringify(coverage)}`);
  assert.deepEqual(coverage, { heldLeaseFloor: 40, heldLeaseInterval: 40, firstFailure: 1, cappedBackoff: 190, codexWonNewRow: 1, foreignAccountHold: 85, multiTickStaleHold: 80, multiTickExpiry: 80 });
  assert.deepEqual(mismatches.slice(0, 5), [], JSON.stringify(mismatches.slice(0, 5), null, 2));
});
