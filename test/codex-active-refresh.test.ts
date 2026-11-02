import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CodexProcessCheckFailed,
  accessFingerprint,
  activeCodexRenewers,
  classifyActiveCodexExpiry,
  holdersFor,
  listOrFail,
} from '../src/codex-active';
import type { CodexAuthDocument } from '../src/codex-auth';
import type { CodexProcess } from '../src/codex-sessions';
import { openStore } from '../src/store';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const A = 'user-a:account-a';
const B = 'user-b:account-b';
const C = 'user-c:account-c';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function document(expiresAt: number | null, access = 'fixture-access-a'): CodexAuthDocument {
  return {
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-a', chatgpt_account_id: 'account-a' } }),
      access_token: expiresAt === null ? 'not-a-jwt' : jwt({ exp: Math.floor(expiresAt / 1_000), sub: access }),
      refresh_token: 'fixture-refresh-a',
      account_id: 'account-a',
    },
    last_refresh: '2026-10-30T12:00:00.000Z',
  };
}

function process(pid: number, offsetMs: number): CodexProcess {
  return {
    pid,
    lstart: new Date(NOW + offsetMs).toUTCString().replace('GMT', '').trim(),
    host: 'codex',
  };
}

function harness(list: () => Promise<CodexProcess[]>) {
  const root = mkdtempSync('/tmp/qlb-codex-active-');
  const journalDir = join(root, 'journal');
  mkdirSync(journalDir);
  const store = openStore(join(root, 'qlb.db'));
  const deps = { dbPath: store.dbPath, journalDir, list };
  return {
    store,
    deps,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function observe(h: ReturnType<typeof harness>, identity: string, at: number): void {
  h.store.recordCodexObservation({ identity, lineageFp: `sha256:${identity}`, by: 'qlb-active', now: at });
}

function switchRow(h: ReturnType<typeof harness>, from: string, to: string, at: number): void {
  h.store.recordSwitch({
    provider: 'openai-codex', fromAccount: from, toAccount: to, trigger: 'manual', outcome: 'ok', ts: at, publishedAt: at,
  });
}

describe('codex active refresh helpers', () => {
  it('classifyActiveCodexExpiry: 6 min ⇒ usable, 3 min ⇒ near-expiry, −1 s ⇒ expired, no exp ⇒ unknown', () => {
    assert.deepEqual(classifyActiveCodexExpiry(document(NOW + 6 * 60_000), NOW), {
      state: 'usable', expiresAt: NOW + 6 * 60_000, leftMs: 6 * 60_000,
    });
    assert.deepEqual(classifyActiveCodexExpiry(document(NOW + 3 * 60_000), NOW), {
      state: 'near-expiry', expiresAt: NOW + 3 * 60_000, leftMs: 3 * 60_000,
    });
    assert.deepEqual(classifyActiveCodexExpiry(document(NOW - 1_000), NOW), {
      state: 'expired', expiresAt: NOW - 1_000, leftMs: -1_000,
    });
    assert.deepEqual(classifyActiveCodexExpiry(document(null), NOW), {
      state: 'unknown', expiresAt: null, leftMs: null,
    });
  });

  it('no switch rows and no observations + a running codex ⇒ every process is a renewer', async () => {
    const processes = [process(101, -30_000), process(102, 30_000)];
    const h = harness(async () => processes);
    try {
      assert.deepEqual(await activeCodexRenewers(h.deps, A), processes);
    } finally { h.close(); }
  });

  it('only a not-published failed row ⇒ every process is a renewer', async () => {
    const processes = [process(111, -30_000), process(112, 30_000)];
    const h = harness(async () => processes);
    try {
      h.store.recordSwitch({
        provider: 'openai-codex', fromAccount: A, toAccount: B, trigger: 'manual', outcome: 'failed',
        detail: 'not-published', ts: NOW, publishedAt: null,
      });
      assert.deepEqual(await activeCodexRenewers(h.deps, A), processes);
    } finally { h.close(); }
  });

  it('only a refused row with no source account ⇒ every process is a renewer', async () => {
    const processes = [process(121, -30_000), process(122, 30_000)];
    const h = harness(async () => processes);
    try {
      h.store.recordSwitch({
        provider: 'openai-codex', fromAccount: null, toAccount: B, trigger: 'manual', outcome: 'refused', ts: NOW,
      });
      assert.deepEqual(await activeCodexRenewers(h.deps, A), processes);
    } finally { h.close(); }
  });

  it('only a null-identity observation ⇒ every process is a renewer', async () => {
    const processes = [process(131, -30_000), process(132, 30_000)];
    const h = harness(async () => processes);
    try {
      h.store.recordCodexObservation({ identity: null, lineageFp: null, by: 'qlb-active', now: NOW });
      assert.deepEqual(await activeCodexRenewers(h.deps, A), processes);
    } finally { h.close(); }
  });

  it('history naming a different account uses renewers instead of the fallback', async () => {
    const processes = [process(141, -30_000), process(142, 30_000)];
    const h = harness(async () => processes);
    try {
      observe(h, B, NOW);
      assert.deepEqual(await activeCodexRenewers(h.deps, A), []);
    } finally { h.close(); }
  });

  it('one observation and no switch rows ⇒ processes started before it renew the observed identity', async () => {
    const before = process(201, -20_000);
    const after = process(202, 20_000);
    const h = harness(async () => [before, after]);
    try {
      observe(h, A, NOW);
      assert.deepEqual((await activeCodexRenewers(h.deps, A)).map(({ pid }) => pid), [201, 202]);
    } finally { h.close(); }
  });

  it('observations of B then A and no switch rows ⇒ a process started between them renews A only once A is observed', async () => {
    const between = process(301, 5_000);
    const h = harness(async () => [between]);
    try {
      observe(h, B, NOW);
      assert.deepEqual(await activeCodexRenewers(h.deps, A), []);
      observe(h, A, NOW + 10_000);
      assert.deepEqual((await activeCodexRenewers(h.deps, A)).map(({ pid }) => pid), [301]);
    } finally { h.close(); }
  });

  it('activeCodexRenewers returns exactly the processes of the active identity’s eras (A→B→A→C fixture)', async () => {
    const processes = [process(401, -5_000), process(402, 5_000), process(403, 15_000), process(404, 25_000)];
    const h = harness(async () => processes);
    try {
      switchRow(h, A, B, NOW);
      switchRow(h, B, A, NOW + 10_000);
      switchRow(h, A, C, NOW + 20_000);
      assert.deepEqual((await activeCodexRenewers(h.deps, A)).map(({ pid }) => pid), [401, 403]);
    } finally { h.close(); }
  });

  it('a process started within ±1 s of a published_at renews both sides', async () => {
    const atBoundary = process(501, 0);
    const h = harness(async () => [atBoundary]);
    try {
      switchRow(h, A, B, NOW);
      assert.deepEqual((await activeCodexRenewers(h.deps, A)).map(({ pid }) => pid), [501]);
      assert.deepEqual((await activeCodexRenewers(h.deps, B)).map(({ pid }) => pid), [501]);
    } finally { h.close(); }
  });

  it('a holder of the old identity only counts as no renewer', async () => {
    const old = process(601, -5_000);
    const h = harness(async () => [old]);
    try {
      switchRow(h, A, B, NOW);
      assert.deepEqual(await activeCodexRenewers(h.deps, B), []);
    } finally { h.close(); }
  });

  it('a list() throw surfaces as CodexProcessCheckFailed from activeCodexRenewers, from holdersFor and from listOrFail', async () => {
    const failure = new Error('fixture process listing unavailable');
    const h = harness(async () => { throw failure; });
    try {
      await assert.rejects(activeCodexRenewers(h.deps, A), CodexProcessCheckFailed);
      await assert.rejects(holdersFor(h.deps, A)(document(NOW + 60_000)), CodexProcessCheckFailed);
      await assert.rejects(listOrFail(h.deps.list)(), CodexProcessCheckFailed);
    } finally { h.close(); }
  });

  it('accessFingerprint changes when only the access token changes and is value-free', () => {
    const first = accessFingerprint(document(NOW + 60_000, 'fixture-access-one'));
    const second = accessFingerprint(document(NOW + 60_000, 'fixture-access-two'));
    assert.match(first, /^sha256-at:[a-f0-9]{64}$/);
    assert.notEqual(first, second);
    assert.equal(first.includes('fixture-access-one'), false);
    assert.equal(second.includes('fixture-access-two'), false);
  });
});
