import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveConfig } from '../src/config';
import {
  activeCcSecurityArgs,
  canSkipJournal,
  classifyConsumeQuota,
  conflictMessage,
  consumeAccessSource,
  consumeMarkerPath,
  CONSUME_ERRORS,
  CONSUME_QUOTA_MAX_AGE_MS,
  CSWAP_ACTIVE_ID,
  decidePiMode,
  fingerprintAccess,
  parseConsumeStatus,
  readActiveClaudeAccess,
  readConsumeQuotaReadings,
  readOwnerFileState,
  SECURITY_BIN,
  type ConsumeJournal,
  type ConsumeQuotaReading,
  type CswapActiveAccess,
  type OwnerFileState,
  type PiMode,
} from '../extensions/qlb-pi/consume';
import {
  registerConflictProvider,
  registerConsumeProvider,
  type AnthropicNativeProvider,
  type Builtin,
  type ConsumeDeps,
  type EventSink,
  type ModelLike,
  type ProviderApi,
} from '../extensions/qlb-pi/consume-provider';
import { QLB_RUNTIME_AUTH_SENTINEL } from '../extensions/qlb-pi/providers/openai-codex';

const FUTURE = 4_102_444_800_000;
const NOW = 1_700_000_000_000;
const REFRESH_SENTINEL = 'REFRESH-SENTINEL-must-never-leak';

interface Sink extends EventSink {
  events: unknown[];
  ended: boolean;
}

function sink(): Sink {
  const output: Sink = {
    events: [],
    ended: false,
    push(event) { output.events.push(event); },
    end() { output.ended = true; },
  };
  return output;
}

const model: ModelLike = {
  id: 'claude-sonnet-5', api: 'anthropic-messages', provider: 'anthropic',
};

describe('qlb-pi mode decision', () => {
  const expected = (
    rehearsal: string | undefined,
    owner: OwnerFileState,
    journal: ConsumeJournal,
    marker: boolean,
  ): PiMode => {
    if (rehearsal === '0') return 'inert';
    if (rehearsal === '1' || owner !== 'absent') {
      if (owner === 'malformed') return 'conflict';
      return journal === 'NATIVE' ? 'owned' : 'conflict';
    }
    if (journal === 'CONSUMED') return 'consume';
    return marker ? 'conflict' : 'inert';
  };

  it('matches the fail-closed table across all inputs', () => {
    const seen = new Set<PiMode>();
    for (const rehearsal of [undefined, '0', '1']) {
      for (const owner of ['absent', 'valid', 'malformed'] as const) {
        for (const journal of ['CONSUMED', 'NATIVE', 'unknown'] as const) {
          for (const marker of [false, true]) {
            const mode = decidePiMode({ rehearsal, owner, journal, marker });
            seen.add(mode);
            assert.equal(mode, expected(rehearsal, owner, journal, marker), `${rehearsal}/${owner}/${journal}/${marker}`);
          }
        }
      }
    }
    assert.deepEqual([...seen].sort(), ['conflict', 'consume', 'inert', 'owned']);
  });

  it('preserves conflict causes and journal classification', () => {
    const mode = (journal: ConsumeJournal, marker = false) =>
      decidePiMode({ rehearsal: undefined, owner: 'absent', journal, marker });
    assert.equal(mode('CONSUMED'), 'consume');
    assert.equal(mode('unknown', true), 'conflict');
    assert.equal(mode('NATIVE', true), 'conflict');
    assert.equal(
      conflictMessage({ rehearsal: undefined, owner: 'absent', journal: 'unknown', marker: true }),
      CONSUME_ERRORS.stateUnknown,
    );
    assert.equal(
      conflictMessage({ rehearsal: undefined, owner: 'absent', journal: 'NATIVE', marker: true }),
      CONSUME_ERRORS.stateInconsistent,
    );
    assert.equal(parseConsumeStatus(0, '{"state":"CONSUMED"}'), 'CONSUMED');
    assert.equal(parseConsumeStatus(0, '{"state":"NATIVE"}'), 'NATIVE');
    assert.equal(parseConsumeStatus(1, '{"state":"CONSUMED"}'), 'unknown');
    assert.equal(parseConsumeStatus(0, 'garbage'), 'unknown');
    assert.equal(parseConsumeStatus(0, '{"state":"QLB_OWNED"}'), 'unknown');
  });

  it('consults the journal unless QLB was never used', () => {
    for (const rehearsal of [undefined, '0', '1']) {
      for (const owner of ['absent', 'valid', 'malformed'] as const) {
        for (const marker of [false, true]) {
          for (const dbExists of [false, true]) {
            assert.equal(
              canSkipJournal({ rehearsal, owner, marker, dbExists }),
              rehearsal === undefined && owner === 'absent' && !marker && !dbExists,
            );
          }
        }
      }
    }
  });

  it('classifies owner files without treating unreadable input as absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-pi-owner-'));
    assert.equal(readOwnerFileState(join(dir, 'missing.json')), 'absent');
    writeFileSync(join(dir, 'valid.json'), '{"accounts":[]}');
    assert.equal(readOwnerFileState(join(dir, 'valid.json')), 'valid');
    writeFileSync(join(dir, 'invalid.json'), '{not json');
    assert.equal(readOwnerFileState(join(dir, 'invalid.json')), 'malformed');
    writeFileSync(join(dir, 'array.json'), '[]');
    assert.equal(readOwnerFileState(join(dir, 'array.json')), 'malformed');
    mkdirSync(join(dir, 'directory.json'));
    assert.equal(readOwnerFileState(join(dir, 'directory.json')), 'malformed');
  });
});

describe('consume marker path parity with the CLI', () => {
  it('resolves the marker beside the CLI database', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-pi-marker-'));
    const custom = join(home, 'custom.json');
    writeFileSync(custom, JSON.stringify({ dbPath: '~/elsewhere/q.db' }));
    mkdirSync(join(home, '.qlb'), { recursive: true });
    const cases: NodeJS.ProcessEnv[] = [
      {},
      { QLB_DB_PATH: join(home, 'db', 'q.db') },
      { QLB_DB_PATH: '~/tilde/q.db' },
      { QLB_CONFIG_PATH: custom },
      { QLB_CONFIG_PATH: custom, QLB_DB_PATH: join(home, 'env-wins', 'q.db') },
    ];
    for (const env of cases) {
      const cli = resolveConfig({ argv: [], env, home, warn: () => undefined });
      assert.equal(consumeMarkerPath(env, home), join(dirname(cli.dbPath), 'consume-anthropic.json'));
    }
  });
});

function blob(accessToken: unknown, expiresAt: unknown = FUTURE): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: REFRESH_SENTINEL, expiresAt },
  });
}

function reading(over: Partial<ConsumeQuotaReading> = {}): ConsumeQuotaReading {
  return {
    usedPct: 10,
    source: 'provider-poll',
    confidence: 'authoritative',
    fetchedAt: NOW,
    ...over,
  };
}

describe('qlb-pi consume reader', () => {
  it('uses the allowlisted read-only Keychain argv', () => {
    assert.equal(SECURITY_BIN, '/usr/bin/security');
    assert.deepEqual(activeCcSecurityArgs('someone'), [
      'find-generic-password', '-a', 'someone', '-w', '-s', 'Claude Code-credentials',
    ]);
    assert.equal(activeCcSecurityArgs('someone').some((arg) => /add-|delete-|-i$/.test(arg)), false);
  });

  it('returns only the access token and refuses an expired login', () => {
    const valid = readActiveClaudeAccess({
      runner: () => blob('access-token'),
      env: { USER: 'qlb-test' },
      nowMs: NOW,
    });
    assert.deepEqual(Object.keys(valid).sort(), ['access', 'fingerprint']);
    assert.equal(valid.access, 'access-token');
    assert.equal(valid.fingerprint, fingerprintAccess('access-token'));
    assert.throws(
      () => readActiveClaudeAccess({
        runner: () => blob('access-token', NOW - 1),
        env: { USER: 'qlb-test' },
        nowMs: NOW,
      }),
      (err: unknown) => err instanceof Error && err.message === CONSUME_ERRORS.expired,
    );
    assert.throws(
      () => readActiveClaudeAccess({
        runner: () => { throw new Error(`boom ${REFRESH_SENTINEL}`); },
        env: { USER: 'qlb-test' },
      }),
      (err: unknown) => err instanceof Error
        && err.message === CONSUME_ERRORS.unreadable
        && !err.message.includes(REFRESH_SENTINEL),
    );
  });
});

describe('consume quota verdict', () => {
  it('allows a missing reading', () => {
    assert.equal(classifyConsumeQuota(undefined, NOW), 'unknown');
    assert.equal(classifyConsumeQuota([], NOW), 'unknown');
    assert.equal(classifyConsumeQuota(null, NOW), 'unknown');
  });

  it('allows a stale or non-authoritative reading, including one that says 100%', () => {
    const staleExhausted = reading({
      usedPct: 100,
      fetchedAt: NOW - CONSUME_QUOTA_MAX_AGE_MS - 1,
    });
    assert.equal(classifyConsumeQuota([staleExhausted], NOW), 'unknown');
    assert.equal(classifyConsumeQuota([
      reading({ usedPct: 100, source: 'external-cache' }),
      reading({ usedPct: 100, confidence: 'stale' }),
      reading({ usedPct: 100, source: 'provider-headers', confidence: 'advisory' }),
    ], NOW), 'unknown');
    assert.equal(classifyConsumeQuota([
      reading({ fetchedAt: NOW - CONSUME_QUOTA_MAX_AGE_MS }),
    ], NOW), 'fresh');
  });

  it('refuses only a fresh provider reading at or above 100%', () => {
    assert.equal(classifyConsumeQuota([reading({ usedPct: 100 })], NOW), 'exhausted');
    assert.equal(classifyConsumeQuota([reading({ usedPct: 140, source: 'provider-headers' })], NOW), 'exhausted');
    assert.equal(classifyConsumeQuota([
      reading({ usedPct: 20 }),
      reading({ usedPct: 100, fetchedAt: NOW - 1_000 }),
    ], NOW), 'exhausted');
    assert.equal(classifyConsumeQuota([reading({ usedPct: 99.9 })], NOW), 'fresh');
  });
});

function quotaDb(rows: Array<{ accountId: string; usedPct: number; fetchedAt: number; source?: string; confidence?: string }>, activeAccountId?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'qlb-pi-quota-')), 'qlb.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE snapshots (
    account_id TEXT, bucket TEXT, used_pct REAL, fetched_at INTEGER, source TEXT, confidence TEXT
  )`);
  db.exec(`CREATE TABLE active_login (
    provider TEXT, account_id TEXT, since INTEGER, set_by TEXT
  )`);
  const insert = db.prepare(
    `INSERT INTO snapshots (account_id, bucket, used_pct, fetched_at, source, confidence)
     VALUES (?, '5h', ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(row.accountId, row.usedPct, row.fetchedAt, row.source ?? 'provider-poll', row.confidence ?? 'authoritative');
  }
  if (activeAccountId !== undefined) {
    db.prepare(`INSERT INTO active_login (provider, account_id, since, set_by) VALUES ('anthropic', ?, 1, 'test')`)
      .run(activeAccountId);
  }
  db.close();
  return path;
}

describe('consume quota database reader', () => {
  it('ignores other slots and a missing database', () => {
    assert.deepEqual(readConsumeQuotaReadings(join(tmpdir(), 'qlb-no-such-quota.db')), []);
    const path = quotaDb([
      { accountId: 'other-slot', usedPct: 100, fetchedAt: NOW },
    ], 'other-slot-not-active');
    const ignored = readConsumeQuotaReadings(path);
    assert.equal(classifyConsumeQuota(ignored, NOW), 'unknown');
  });

  it('reads a stale active-login row as unknown and a fresh exhausted row as exhausted', () => {
    const stale = quotaDb([
      { accountId: 'active-slot', usedPct: 100, fetchedAt: NOW - CONSUME_QUOTA_MAX_AGE_MS - 1 },
    ], 'active-slot');
    assert.equal(classifyConsumeQuota(readConsumeQuotaReadings(stale), NOW), 'unknown');
    const fresh = quotaDb([
      { accountId: 'active-slot', usedPct: 100, fetchedAt: NOW },
      { accountId: 'other-slot', usedPct: 0, fetchedAt: NOW },
    ], 'active-slot');
    assert.equal(classifyConsumeQuota(readConsumeQuotaReadings(fresh), NOW), 'exhausted');
    const direct = quotaDb([
      { accountId: CSWAP_ACTIVE_ID, usedPct: 100, fetchedAt: NOW, source: 'provider-headers' },
    ]);
    assert.equal(classifyConsumeQuota(readConsumeQuotaReadings(direct), NOW), 'exhausted');
  });
});

function access(value: string): CswapActiveAccess {
  return { access: value, fingerprint: fingerprintAccess(value) };
}

function sequence(values: string[]): { read: () => CswapActiveAccess; reads: () => number } {
  let n = 0;
  return {
    read: () => {
      const value = values[Math.min(n, values.length - 1)]!;
      n += 1;
      return access(value);
    },
    reads: () => n,
  };
}

function fakePi(): ProviderApi & { providers: Map<string, AnthropicNativeProvider>; poolCalls: () => number } {
  let poolCalls = 0;
  const providers = new Map<string, AnthropicNativeProvider>();
  providers.set('anthropic', {
    id: 'anthropic',
    name: 'anthropic-pool',
    auth: { apiKey: {
      name: 'pool',
      async check() { return { type: 'api_key', source: 'pool' }; },
      async resolve() { return { auth: { apiKey: 'pool' }, source: 'pool' }; },
    } },
    getModels: () => [],
    stream: () => { poolCalls += 1; return sink(); },
    streamSimple: () => { poolCalls += 1; return sink(); },
  });
  return {
    providers,
    poolCalls: () => poolCalls,
    unregisterProvider(name) { providers.delete(name); },
    registerProvider(provider) { providers.set(provider.id, provider); },
  };
}

function authError(token: string): Record<string, unknown> {
  return {
    type: 'error',
    reason: 'error',
    error: { errorMessage: `401 unauthorized for ${token} fp=${fingerprintAccess(token)}` },
  };
}

function fakeBuiltin(reject: Set<string>): { builtin: Builtin; keys: string[] } {
  const keys: string[] = [];
  const builtin: Builtin = (_model, _context, options) => {
    const key = String(options.apiKey);
    keys.push(key);
    return (async function* () {
      const onPayload = options.onPayload as ((payload: unknown, payloadModel: unknown) => Promise<unknown>) | undefined;
      if (onPayload) await onPayload({ original: true }, _model);
      if (reject.has(key)) {
        yield authError(key);
        return;
      }
      yield { type: 'text_delta', delta: 'hi' };
      yield { type: 'done', reason: 'stop' };
    })();
  };
  return { builtin, keys };
}

async function finish(stream: Sink): Promise<Sink> {
  for (let i = 0; i < 200 && !stream.ended; i++) await delay(5);
  assert.equal(stream.ended, true);
  return stream;
}

function providerDeps(over: Partial<ConsumeDeps> & { read: () => CswapActiveAccess }): {
  deps: ConsumeDeps;
  audit: Array<Record<string, unknown>>;
} {
  const audit: Array<Record<string, unknown>> = [];
  return {
    audit,
    deps: {
      createStream: sink,
      consumeJournal: async () => 'CONSUMED',
      ownerState: () => 'absent',
      readAccess: over.read,
      shapePayload: (payload) => ({ shaped: payload }),
      recordOutcome: (entry) => { audit.push(entry); },
      ...over,
    },
  };
}

describe('qlb-pi consume provider', () => {
  it('allows the request when no quota reading exists', async () => {
    const pi = fakePi();
    const fake = fakeBuiltin(new Set());
    const seq = sequence(['access-a']);
    const wired = providerDeps({ read: seq.read, readQuota: () => [] });
    registerConsumeProvider(pi, fake.builtin, wired.deps);
    const output = await finish(pi.providers.get('anthropic')!.streamSimple(model, {}, {}) as Sink);
    assert.equal(seq.reads(), 1);
    assert.deepEqual(fake.keys, ['access-a']);
    assert.equal(pi.poolCalls(), 0);
    assert.equal((output.events.at(-1) as { type?: string }).type, 'done');
    assert.equal(wired.audit.at(-1)?.quota, 'unknown');
    assert.equal(wired.audit.at(-1)?.outcome, 'ok');
  });

  it('allows the request when the only reading is stale', async () => {
    const pi = fakePi();
    const fake = fakeBuiltin(new Set());
    const seq = sequence(['access-a']);
    const wired = providerDeps({
      read: seq.read,
      readQuota: () => [reading({ usedPct: 100, fetchedAt: Date.now() - CONSUME_QUOTA_MAX_AGE_MS - 1 })],
    });
    registerConsumeProvider(pi, fake.builtin, wired.deps);
    await finish(pi.providers.get('anthropic')!.streamSimple(model, {}, {}) as Sink);
    assert.deepEqual(fake.keys, ['access-a']);
    assert.equal(wired.audit.at(-1)?.quota, 'unknown');
    assert.equal(wired.audit.at(-1)?.outcome, 'ok');
  });

  it('records a fresh non-exhausted reading and still serves', async () => {
    const pi = fakePi();
    const fake = fakeBuiltin(new Set());
    const wired = providerDeps({
      read: () => access('access-a'),
      readQuota: () => [reading({ usedPct: 40, fetchedAt: Date.now() })],
    });
    registerConsumeProvider(pi, fake.builtin, wired.deps);
    await finish(pi.providers.get('anthropic')!.streamSimple(model, {}, {}) as Sink);
    assert.deepEqual(fake.keys, ['access-a']);
    assert.equal(wired.audit.at(-1)?.quota, 'fresh');
    assert.equal(wired.audit.at(-1)?.outcome, 'ok');
  });

  it('treats an unreadable quota lookup as unknown and still serves', async () => {
    const pi = fakePi();
    const fake = fakeBuiltin(new Set());
    const seq = sequence(['access-a']);
    const wired = providerDeps({
      read: seq.read,
      readQuota: () => { throw new Error('sqlite locked'); },
    });
    registerConsumeProvider(pi, fake.builtin, wired.deps);
    await finish(pi.providers.get('anthropic')!.streamSimple(model, {}, {}) as Sink);
    assert.deepEqual(fake.keys, ['access-a']);
    assert.equal(wired.audit.at(-1)?.quota, 'unknown');
    assert.equal(JSON.stringify(wired.audit).includes('sqlite locked'), false);
  });

  it('refuses a fresh exhausted reading before any Keychain read', async () => {
    const pi = fakePi();
    const fake = fakeBuiltin(new Set());
    const seq = sequence(['access-a']);
    const wired = providerDeps({
      read: seq.read,
      readQuota: () => [reading({ usedPct: 100, fetchedAt: Date.now() })],
    });
    registerConsumeProvider(pi, fake.builtin, wired.deps);
    const output = await finish(pi.providers.get('anthropic')!.streamSimple(model, {}, {}) as Sink);
    assert.equal(seq.reads(), 0);
    assert.deepEqual(fake.keys, []);
    assert.equal(pi.poolCalls(), 0);
    assert.equal((output.events[0] as { error: { errorMessage: string } }).error.errorMessage, CONSUME_ERRORS.quotaExhausted);
    assert.deepEqual(wired.audit, [{
      accountId: CSWAP_ACTIVE_ID,
      provider: 'anthropic',
      model: model.id,
      outcome: 'unavailable',
      quota: 'exhausted',
      error: CONSUME_ERRORS.quotaExhausted,
    }]);
  });

  it('keeps owner, journal, and expired-token refusals without an upstream call', async () => {
    for (const [over, message, reads] of [
      [{ consumeJournal: async () => 'NATIVE' as const }, CONSUME_ERRORS.disabled, 0],
      [{ consumeJournal: async () => 'unknown' as const }, CONSUME_ERRORS.stateUnknown, 0],
      [{ ownerState: () => 'valid' as const }, CONSUME_ERRORS.conflict, 0],
      [{ ownerState: () => 'malformed' as const }, CONSUME_ERRORS.conflict, 0],
      [{ read: () => { throw new Error(CONSUME_ERRORS.expired); } }, CONSUME_ERRORS.expired, 0],
    ] as const) {
      const pi = fakePi();
      const fake = fakeBuiltin(new Set());
      const seq = sequence(['access-a']);
      const read = 'read' in over ? over.read : seq.read;
      registerConsumeProvider(pi, fake.builtin, providerDeps({ read, ...over }).deps);
      const output = await finish(pi.providers.get('anthropic')!.streamSimple(model, {}, {}) as Sink);
      assert.equal(seq.reads(), reads, message);
      assert.deepEqual(fake.keys, []);
      assert.equal(pi.poolCalls(), 0);
      assert.equal((output.events[0] as { error: { errorMessage: string } }).error.errorMessage, message);
    }
  });

  it('re-reads the Keychain once after a 401 and does not read a third time', async () => {
    const rotated = fakePi();
    const rotatedSeq = sequence(['access-a', 'access-b', 'access-c']);
    const rotatedFake = fakeBuiltin(new Set(['access-a']));
    const rotatedAudit = providerDeps({ read: rotatedSeq.read });
    registerConsumeProvider(rotated, rotatedFake.builtin, rotatedAudit.deps);
    const rotatedOut = await finish(rotated.providers.get('anthropic')!.streamSimple(model, {}, {}) as Sink);
    assert.equal(rotatedSeq.reads(), 2);
    assert.deepEqual(rotatedFake.keys, ['access-a', 'access-b']);
    assert.equal((rotatedOut.events.at(-1) as { type?: string }).type, 'done');
    assert.equal(rotatedOut.events.some((event) => (event as { type?: string }).type === 'error'), false);
    assert.equal(rotatedAudit.audit.at(-1)?.retriedAfterConsumeReread, true);

    const unchanged = fakePi();
    const unchangedSeq = sequence(['access-a', 'access-a']);
    const unchangedFake = fakeBuiltin(new Set(['access-a']));
    const unchangedAudit = providerDeps({ read: unchangedSeq.read });
    registerConsumeProvider(unchanged, unchangedFake.builtin, unchangedAudit.deps);
    const unchangedOut = await finish(unchanged.providers.get('anthropic')!.streamSimple(model, {}, {}) as Sink);
    assert.equal(unchangedSeq.reads(), 2);
    assert.deepEqual(unchangedFake.keys, ['access-a']);
    const text = JSON.stringify(unchangedOut.events) + JSON.stringify(unchangedAudit.audit);
    assert.match(text, /401/);
    assert.equal(text.includes(fingerprintAccess('access-a')), false);
    assert.equal(text.includes('access-a'), false);
  });
});

describe('qlb-pi conflict provider', () => {
  it('uses QLB-managed auth and never calls the replaced provider', async () => {
    let poolCalls = 0;
    const providers = new Map<string, AnthropicNativeProvider>();
    const pool: AnthropicNativeProvider = {
      id: 'anthropic',
      name: 'anthropic-pool',
      auth: { apiKey: {
        name: 'pool',
        async check() { return { type: 'api_key', source: 'pool' }; },
        async resolve() { return { auth: { apiKey: 'pool' }, source: 'pool' }; },
      } },
      getModels: () => [],
      stream: () => { poolCalls += 1; return sink(); },
      streamSimple: () => { poolCalls += 1; return sink(); },
    };
    providers.set('anthropic', pool);
    const pi: ProviderApi = {
      unregisterProvider(name) { providers.delete(name); },
      registerProvider(provider) { providers.set(provider.id, provider); },
    };

    registerConflictProvider(pi, sink, CONSUME_ERRORS.conflict, {
      models: [model], baseUrl: 'https://anthropic.example.test',
    });

    const provider = providers.get('anthropic')!;
    assert.equal(provider.baseUrl, 'https://anthropic.example.test');
    assert.deepEqual(provider.getModels(), [model]);
    assert.equal('oauth' in provider.auth, false);
    assert.deepEqual(await provider.auth.apiKey.resolve(), {
      auth: { apiKey: QLB_RUNTIME_AUTH_SENTINEL }, source: 'QLB consume',
    });
    const output = provider.stream(model, {}) as Sink;
    assert.equal(output.ended, true);
    assert.equal(poolCalls, 0);
    assert.equal((output.events[0] as { error: { errorMessage: string } }).error.errorMessage, CONSUME_ERRORS.conflict);
  });

  it('fails closed with no catalog', async () => {
    const providers = new Map<string, AnthropicNativeProvider>();
    const pi: ProviderApi = {
      unregisterProvider(name) { providers.delete(name); },
      registerProvider(provider) { providers.set(provider.id, provider); },
    };
    registerConflictProvider(pi, sink, 'catalog unavailable');
    const provider = providers.get('anthropic')!;
    assert.deepEqual(provider.getModels(), []);
    assert.equal(provider.baseUrl, undefined);
    assert.deepEqual(await provider.auth.apiKey.resolve(), {
      auth: { apiKey: QLB_RUNTIME_AUTH_SENTINEL }, source: 'QLB consume',
    });
    const output = provider.stream(model, {}) as Sink;
    assert.equal((output.events[0] as { error: { errorMessage: string } }).error.errorMessage, 'catalog unavailable');
  });
});
