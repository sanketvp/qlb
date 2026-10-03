import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  activeCcSecurityArgs as srcArgs,
  getActiveClaudeCodeAccess,
  SECURITY_BIN as SRC_SECURITY_BIN,
} from '../src/cswap-native-read';
import {
  activeCcSecurityArgs,
  conflictMessage,
  consumeAccessSource,
  CONSUME_ERRORS,
  CSWAP_ACTIVE_ID,
  decidePiMode,
  fingerprintAccess,
  parseConsumeStatus,
  readActiveClaudeAccess,
  readOwnerFileState,
  redactEvent,
  redactSecrets,
  SECURITY_BIN,
  type ActiveAccess,
  type ConsumeJournal,
  type OwnerFileState,
  type PiMode,
} from '../extensions/qlb-pi/consume';
import {
  registerConflictProvider,
  registerConsumeProvider,
  type Builtin,
  type ConsumeDeps,
  type EventSink,
  type ModelLike,
  type ProviderApi,
} from '../extensions/qlb-pi/consume-provider';

const FUTURE = 4102444800000;
const REFRESH_SENTINEL = 'REFRESH-SENTINEL-must-never-leak';

function blob(accessToken: unknown, expiresAt: unknown = FUTURE): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: REFRESH_SENTINEL, expiresAt },
  });
}

describe('qlb-pi consume reader parity with src/cswap-native-read', () => {
  it('uses the identical allowlisted read-only argv', () => {
    assert.equal(SECURITY_BIN, SRC_SECURITY_BIN);
    assert.deepEqual(activeCcSecurityArgs('someone'), srcArgs('someone'));
    assert.ok(!activeCcSecurityArgs('someone').some((a) => /add-|delete-|-i$/.test(a)));
  });

  const cases: Array<[string, () => string]> = [
    ['valid', () => blob('acc-1')],
    ['valid with trailing newline', () => `${blob('acc-2')}\n`],
    ['missing access', () => blob('')],
    ['non-string access', () => blob(42)],
    ['missing expiry', () => blob('acc-3', 'soon')],
    ['expired', () => blob('acc-4', 1)],
    ['not json', () => `not-json ${REFRESH_SENTINEL}`],
    ['runner throws', () => { throw new Error(`boom ${REFRESH_SENTINEL}`); }],
  ];
  for (const [name, produce] of cases) {
    it(`agrees on: ${name}`, () => {
      const runner = () => produce();
      let srcResult: { access: string; fingerprint: string } | Error;
      let extResult: ActiveAccess | Error;
      try {
        const r = getActiveClaudeCodeAccess({ runner, env: { USER: 'u' } });
        srcResult = { access: r.access, fingerprint: r.fingerprint };
      } catch (err) {
        srcResult = err as Error;
      }
      try {
        extResult = readActiveClaudeAccess({ runner, env: { USER: 'u' } });
      } catch (err) {
        extResult = err as Error;
      }
      assert.equal(srcResult instanceof Error, extResult instanceof Error, 'success/failure must match');
      if (extResult instanceof Error) {
        assert.ok(Object.values(CONSUME_ERRORS).includes(extResult.message as never));
        assert.doesNotMatch(extResult.message, new RegExp(REFRESH_SENTINEL));
      } else {
        assert.deepEqual(extResult, srcResult);
        assert.equal(Object.keys(extResult).sort().join(','), 'access,fingerprint');
      }
    });
  }
});

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
    return journal === 'unknown' && marker ? 'conflict' : 'inert';
  };

  it('matches the fail-closed table across all 54 inputs', () => {
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

  it('pins the security-relevant cells explicitly', () => {
    const m = (rehearsal: string | undefined, owner: OwnerFileState, journal: ConsumeJournal, marker = false) =>
      decidePiMode({ rehearsal, owner, journal, marker });
    assert.equal(m(undefined, 'absent', 'CONSUMED'), 'consume');
    assert.equal(m(undefined, 'valid', 'CONSUMED'), 'conflict');
    assert.equal(m(undefined, 'valid', 'unknown'), 'conflict');
    assert.equal(m(undefined, 'malformed', 'NATIVE'), 'conflict');
    assert.equal(m('1', 'absent', 'CONSUMED'), 'conflict');
    assert.equal(m(undefined, 'absent', 'unknown'), 'inert');
    // consume enabled but status unreadable: never fall back to anthropic-pool
    assert.equal(m(undefined, 'absent', 'unknown', true), 'conflict');
    assert.equal(m(undefined, 'absent', 'NATIVE', true), 'inert');
    assert.equal(m('0', 'valid', 'CONSUMED', true), 'inert');
    assert.equal(
      conflictMessage({ rehearsal: undefined, owner: 'absent', journal: 'unknown', marker: true }),
      CONSUME_ERRORS.stateUnknown,
    );
    assert.equal(
      conflictMessage({ rehearsal: undefined, owner: 'valid', journal: 'CONSUMED', marker: false }),
      CONSUME_ERRORS.conflict,
    );
  });

  it('classifies owner files and consume status output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-pi-owner-'));
    assert.equal(readOwnerFileState(join(dir, 'missing.json')), 'absent');
    writeFileSync(join(dir, 'ok.json'), '{"accounts":[]}');
    assert.equal(readOwnerFileState(join(dir, 'ok.json')), 'valid');
    writeFileSync(join(dir, 'bad.json'), '{not json');
    assert.equal(readOwnerFileState(join(dir, 'bad.json')), 'malformed');
    writeFileSync(join(dir, 'array.json'), '[]');
    assert.equal(readOwnerFileState(join(dir, 'array.json')), 'malformed');
    mkdirSync(join(dir, 'dir.json'));
    assert.equal(readOwnerFileState(join(dir, 'dir.json')), 'malformed');

    assert.equal(parseConsumeStatus(0, '{"state":"CONSUMED"}'), 'CONSUMED');
    assert.equal(parseConsumeStatus(0, '{"state":"NATIVE"}'), 'NATIVE');
    assert.equal(parseConsumeStatus(1, '{"state":"CONSUMED"}'), 'unknown');
    assert.equal(parseConsumeStatus(0, 'garbage'), 'unknown');
    assert.equal(parseConsumeStatus(0, '{"state":"QLB_OWNED"}'), 'unknown');
  });
});

function access(value: string): ActiveAccess {
  return { access: value, fingerprint: fingerprintAccess(value) };
}

function sequence(values: string[]): { read: () => ActiveAccess; reads: () => number } {
  let n = 0;
  return {
    read: () => {
      const v = values[Math.min(n, values.length - 1)]!;
      n += 1;
      return access(v);
    },
    reads: () => n,
  };
}

describe('qlb-pi consume 401 reread source', () => {
  it('A→B: one reread, retry sends exactly B', async () => {
    const seq = sequence(['A', 'B', 'C']);
    const src = consumeAccessSource(seq.read);
    assert.equal(src.readAccess(), 'A');
    assert.deepEqual(await src.resync(), { resynced: true, reason: 'cswap-active access fingerprint changed' });
    assert.equal(src.readAccess(), 'B');
    assert.equal(seq.reads(), 2);
    assert.deepEqual(src.sent(), ['A', 'B']);
  });

  it('A→A: reread unchanged, no retry value change', async () => {
    const seq = sequence(['A', 'A']);
    const src = consumeAccessSource(seq.read);
    src.readAccess();
    assert.equal((await src.resync()).resynced, false);
    assert.equal(seq.reads(), 2);
  });

  it('reread failure reports not resynced', async () => {
    let n = 0;
    const src = consumeAccessSource(() => {
      n += 1;
      if (n > 1) throw new Error('gone');
      return access('A');
    });
    src.readAccess();
    assert.deepEqual(await src.resync(), { resynced: false, reason: 'cswap-active reread failed' });
  });
});

// ---- provider factory through a fake Pi API -------------------------------------

interface Sink extends EventSink {
  events: unknown[];
  ended: boolean;
}

function sink(): Sink {
  const s: Sink = {
    events: [],
    ended: false,
    push(e) { s.events.push(e); },
    end() { s.ended = true; },
  };
  return s;
}

type StreamSimple = (model: ModelLike, context: unknown, options?: Record<string, unknown>) => unknown;

function fakePi(): ProviderApi & { providers: Map<string, StreamSimple>; poolCalls: () => number } {
  let poolCalls = 0;
  const providers = new Map<string, StreamSimple>();
  // Pre-existing provider (anthropic-pool): any call through it is a fail-open defect.
  providers.set('anthropic', () => {
    poolCalls += 1;
    return sink();
  });
  return {
    providers,
    poolCalls: () => poolCalls,
    unregisterProvider: (name) => { providers.delete(name); },
    registerProvider: (name, config) => { providers.set(name, config.streamSimple); },
  };
}

const MODEL: ModelLike = { id: 'claude-sonnet-5', api: 'anthropic-messages', provider: 'anthropic' };

function authError(token: string): Record<string, unknown> {
  return {
    type: 'error',
    reason: 'error',
    error: { errorMessage: `401 unauthorized for ${token} fp=${fingerprintAccess(token)}` },
  };
}

function fakeBuiltin(reject: Set<string>): { builtin: Builtin; keys: string[]; payloads: unknown[] } {
  const keys: string[] = [];
  const payloads: unknown[] = [];
  const builtin: Builtin = (_model, _context, options) => {
    const key = String(options.apiKey);
    keys.push(key);
    return (async function* () {
      const onPayload = options.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
      payloads.push(await onPayload({ original: true }, _model));
      if (reject.has(key)) {
        yield authError(key);
        return;
      }
      yield { type: 'text_delta', delta: 'hi' };
      yield { type: 'done', reason: 'stop' };
    })();
  };
  return { builtin, keys, payloads };
}

async function run(pi: ReturnType<typeof fakePi>): Promise<Sink> {
  const stream = pi.providers.get('anthropic')!(MODEL, {}, {}) as Sink;
  for (let i = 0; i < 200 && !stream.ended; i++) await delay(5);
  assert.ok(stream.ended, 'stream must end');
  return stream;
}

function deps(over: Partial<ConsumeDeps> & { read: () => ActiveAccess }): {
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
      shapePayload: (p) => ({ shaped: p }),
      recordOutcome: (e) => { audit.push(e); },
      ...over,
    },
  };
}

describe('qlb-pi consume provider (fake Pi with pre-existing anthropic provider)', () => {
  it('401 with rotated credential: two reads, retry with B, recovered 401 hidden, pool never used', async () => {
    const pi = fakePi();
    const seq = sequence(['A', 'B']);
    const fake = fakeBuiltin(new Set(['A']));
    const d = deps({ read: seq.read });
    registerConsumeProvider(pi, fake.builtin, d.deps);
    const out = await run(pi);
    assert.equal(seq.reads(), 2);
    assert.deepEqual(fake.keys, ['A', 'B']);
    assert.deepEqual(fake.payloads, [{ shaped: { original: true } }, { shaped: { original: true } }]);
    assert.equal(out.events.some((e) => (e as { type?: string }).type === 'error'), false);
    assert.equal((out.events.at(-1) as { type?: string }).type, 'done');
    assert.equal(pi.poolCalls(), 0);
    assert.deepEqual(d.audit.map((e) => e.kind ?? e.outcome), ['consume_reread', 'ok']);
    assert.equal(d.audit[1]!.accountId, CSWAP_ACTIVE_ID);
    assert.equal(d.audit[1]!.retriedAfterConsumeReread, true);
  });

  it('401 with unchanged credential: no retry, 401 surfaced with token and fingerprint redacted', async () => {
    const pi = fakePi();
    const seq = sequence(['A', 'A']);
    const fake = fakeBuiltin(new Set(['A']));
    const d = deps({ read: seq.read });
    registerConsumeProvider(pi, fake.builtin, d.deps);
    const out = await run(pi);
    assert.equal(seq.reads(), 2);
    assert.deepEqual(fake.keys, ['A']);
    const text = JSON.stringify(out.events) + JSON.stringify(d.audit);
    assert.match(text, /401/);
    assert.doesNotMatch(text, /for A /);
    assert.equal(text.includes(fingerprintAccess('A')), false);
    assert.equal(text.includes(REFRESH_SENTINEL), false);
  });

  it('second 401 after retry reads nothing more', async () => {
    const pi = fakePi();
    const seq = sequence(['A', 'B', 'C']);
    const fake = fakeBuiltin(new Set(['A', 'B', 'C']));
    registerConsumeProvider(pi, fake.builtin, deps({ read: seq.read }).deps);
    await run(pi);
    assert.equal(seq.reads(), 2);
    assert.deepEqual(fake.keys, ['A', 'B']);
  });

  it('journal no longer CONSUMED or owner file appearing: fixed error, zero reads, zero upstream', async () => {
    for (const [over, message] of [
      [{ consumeJournal: async () => 'NATIVE' as const }, CONSUME_ERRORS.disabled],
      [{ consumeJournal: async () => 'unknown' as const }, CONSUME_ERRORS.stateUnknown],
      [{ ownerState: () => 'valid' as const }, CONSUME_ERRORS.conflict],
      [{ ownerState: () => 'malformed' as const }, CONSUME_ERRORS.conflict],
    ] as const) {
      const pi = fakePi();
      const seq = sequence(['A']);
      const fake = fakeBuiltin(new Set());
      registerConsumeProvider(pi, fake.builtin, deps({ read: seq.read, ...over }).deps);
      const out = await run(pi);
      assert.equal(seq.reads(), 0);
      assert.deepEqual(fake.keys, []);
      assert.equal(pi.poolCalls(), 0);
      assert.equal((out.events[0] as { error: { errorMessage: string } }).error.errorMessage, message);
    }
  });

  it('Keychain read failure: fixed message, no upstream call', async () => {
    const pi = fakePi();
    const fake = fakeBuiltin(new Set());
    registerConsumeProvider(pi, fake.builtin, deps({
      read: () => { throw new Error(CONSUME_ERRORS.expired); },
    }).deps);
    const out = await run(pi);
    assert.deepEqual(fake.keys, []);
    assert.equal(out.events.length, 1);
    assert.equal((out.events[0] as { error: { errorMessage: string } }).error.errorMessage, CONSUME_ERRORS.expired);
  });

  it('unexpected errors never cross a sink verbatim', async () => {
    const pi = fakePi();
    const fake = fakeBuiltin(new Set());
    const d = deps({
      read: () => access('A'),
      consumeJournal: async () => { throw new Error(`spawn failed ${REFRESH_SENTINEL}`); },
    });
    registerConsumeProvider(pi, fake.builtin, d.deps);
    const out = await run(pi);
    const text = JSON.stringify(out.events) + JSON.stringify(d.audit);
    assert.equal(text.includes(REFRESH_SENTINEL), false);
    assert.match(text, /cswap-active request failed/);
  });

  it('conflict provider replaces the pre-existing provider and only returns the error', async () => {
    const pi = fakePi();
    registerConflictProvider(pi, sink);
    const out = await run(pi);
    assert.equal(pi.poolCalls(), 0);
    assert.equal(out.events.length, 1);
    assert.equal((out.events[0] as { error: { errorMessage: string } }).error.errorMessage, CONSUME_ERRORS.conflict);
  });
});

describe('redaction helper', () => {
  it('redacts nested message fields, arrays, and bare string events', () => {
    const tok = 'tok-nested-9';
    const fp = fingerprintAccess(tok);
    const event = {
      type: 'error',
      message: { errorMessage: `bad ${tok}`, content: [{ text: `fp ${fp}` }, `raw ${tok}`] },
      error: { details: { inner: { why: `${tok}/${fp}` } } },
    };
    const out = JSON.stringify(redactEvent(event, [tok]));
    assert.equal(out.includes(tok), false);
    assert.equal(out.includes(fp), false);
    assert.equal(redactEvent(`bare ${tok}`, [tok]), 'bare [redacted]');
    assert.equal(JSON.stringify(event).includes(tok), true, 'input must not be mutated');
  });

  it('fails closed on deep nesting and redacts shared and cyclic references in an independent copy', () => {
    const tok = 'tok-deep-7';
    const fp = fingerprintAccess(tok);
    let deep: Record<string, unknown> = { leak: `${tok} ${fp}` };
    for (let i = 0; i < 200; i++) deep = { next: deep };
    assert.equal(JSON.stringify(redactEvent(deep, [tok])).includes(tok), false);

    const shared = { why: `shared ${tok}` };
    const event: Record<string, unknown> = { a: shared, b: [shared], c: { d: shared } };
    event.self = event;
    const out = redactEvent(event, [tok]) as Record<string, unknown>;
    assert.notEqual(out, event);
    assert.notEqual(out.a, shared);
    assert.equal(out.self, out, 'cycles map to the clone, not the original');
    const { self: _self, ...rest } = out;
    void _self;
    const text = JSON.stringify(rest);
    assert.equal(text.includes(tok), false);
    assert.equal(text.includes(fp), false);
    assert.equal(shared.why, `shared ${tok}`, 'input must not be mutated');
  });

  it('removes both the value and its fingerprint', () => {
    const fp = fingerprintAccess('tok-123');
    assert.equal(redactSecrets(`a tok-123 b ${fp} c`, ['tok-123']), 'a [redacted] b [redacted] c');
  });
});
