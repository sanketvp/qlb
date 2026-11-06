import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveConfig } from '../src/config';
import { QLB_RUNTIME_AUTH_SENTINEL } from '../extensions/qlb-pi/providers/openai-codex';
import { redactEvent, redactSecrets } from '../src/redact';
import {
  activeCcSecurityArgs as srcArgs,
  getActiveClaudeCodeAccess,
  SECURITY_BIN as SRC_SECURITY_BIN,
} from '../src/cswap-native-read';

import {
  canSkipJournal,
  conflictMessage,
  CONSUME_ERRORS,
  CSWAP_ACTIVE_ID,
  decidePiMode,
  activeCcSecurityArgs,
  fingerprintAccess,
  parseConsumeStatus,
  consumeMarkerPath,
  readActiveClaudeAccess,
  readOwnerFileState,
  SECURITY_BIN,
  type CswapActiveAccess,
  type ConsumeJournal,
  type OwnerFileState,
  type PiMode,
} from '../extensions/qlb-pi/consume';
import {
  registerConflictProvider,
  registerConsumeProvider,
  type AnthropicNativeProvider,
  type EventSink,
  type ModelLike,
  type ProviderApi,
} from '../extensions/qlb-pi/consume-provider';

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
      let extResult: CswapActiveAccess | Error;
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
    return marker ? 'conflict' : 'inert';
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
    // mid-enable / mid-disable (or a crashed one): fail closed, not inert
    assert.equal(m(undefined, 'absent', 'NATIVE', true), 'conflict');
    assert.equal(
      conflictMessage({ rehearsal: undefined, owner: 'absent', journal: 'NATIVE', marker: true }),
      CONSUME_ERRORS.stateInconsistent,
    );
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

  it('skips the consume-status spawn only when QLB was never used (no database)', () => {
    for (const rehearsal of [undefined, '0', '1']) {
      for (const owner of ['absent', 'valid', 'malformed'] as const) {
        for (const marker of [false, true]) {
          for (const dbExists of [false, true]) {
            const skip = canSkipJournal({ rehearsal, owner, marker, dbExists });
            assert.equal(
              skip,
              rehearsal === undefined && owner === 'absent' && !marker && !dbExists,
              `${rehearsal}/${owner}/${marker}/${dbExists}`,
            );
          }
        }
      }
    }
    // A deleted marker with an existing database must still consult the journal.
    assert.equal(canSkipJournal({ rehearsal: undefined, owner: 'absent', marker: false, dbExists: true }), false);
  });

  it('a malformed owner file is reported as the owner-file problem', () => {
    assert.equal(
      conflictMessage({ rehearsal: undefined, owner: 'malformed', journal: 'unknown', marker: false }),
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

describe('consume marker path parity with the CLI', () => {
  it('resolves the marker beside the same database the CLI uses', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-pi-marker-'));
    const custom = join(home, 'custom.json');
    writeFileSync(custom, JSON.stringify({ dbPath: '~/elsewhere/q.db' }));
    const bad = join(home, 'bad.json');
    writeFileSync(bad, '{not json');
    const arr = join(home, 'arr.json');
    writeFileSync(arr, '[]');
    mkdirSync(join(home, '.qlb'), { recursive: true });
    const cases: NodeJS.ProcessEnv[] = [
      {},
      { QLB_DB_PATH: join(home, 'db', 'q.db') },
      { QLB_DB_PATH: '~/tilde/q.db' },
      { QLB_DB_PATH: '' },
      { QLB_CONFIG_PATH: custom },
      { QLB_CONFIG_PATH: custom, QLB_DB_PATH: join(home, 'env-wins', 'q.db') },
      { QLB_CONFIG_PATH: bad },
      { QLB_CONFIG_PATH: arr },
      { QLB_CONFIG_PATH: join(home, 'missing.json') },
    ];
    for (const env of cases) {
      const cli = resolveConfig({ argv: [], env, home, warn: () => undefined });
      assert.equal(
        consumeMarkerPath(env, home),
        join(dirname(cli.dbPath), 'consume-anthropic.json'),
        JSON.stringify(env),
      );
    }
    writeFileSync(join(home, '.qlb', 'config.json'), JSON.stringify({ dbPath: join(home, 'cfg', 'q.db') }));
    assert.equal(consumeMarkerPath({}, home), join(home, 'cfg', 'consume-anthropic.json'));
    assert.equal(
      join(dirname(resolveConfig({ argv: [], env: {}, home, warn: () => undefined }).dbPath), 'consume-anthropic.json'),
      join(home, 'cfg', 'consume-anthropic.json'),
    );
  });
});


const model: ModelLike = {
  id: 'claude-sonnet-5', api: 'anthropic-messages', provider: 'anthropic',
};

const FUTURE = 4102444800000;
const REFRESH_SENTINEL = 'REFRESH-SENTINEL-must-never-leak';

function blob(accessToken: unknown, expiresAt: unknown = FUTURE): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: REFRESH_SENTINEL, expiresAt },
  });
}

describe('qlb-pi consume provider', () => {
  it('fails unavailable without calling the replaced provider', () => {
    let replacedProviderCalls = 0;
    const providers = new Map<string, AnthropicNativeProvider>();
    const previous: AnthropicNativeProvider = {
      id: 'anthropic',
      name: 'anthropic-pool',
      auth: { apiKey: {
        name: 'pool',
        async check() { return { type: 'api_key', source: 'pool' }; },
        async resolve() { return { auth: { apiKey: 'pool' }, source: 'pool' }; },
      } },
      getModels: () => [],
      stream: () => { replacedProviderCalls += 1; return sink(); },
      streamSimple: () => { replacedProviderCalls += 1; return sink(); },
    };
    providers.set('anthropic', previous);
    const pi: ProviderApi = {
      unregisterProvider(name) { providers.delete(name); },
      registerProvider(provider) { providers.set(provider.id, provider); },
    };
    const outcomes: Array<Record<string, unknown>> = [];

    registerConsumeProvider(pi, {
      createStream: sink,
      models: [model],
      recordOutcome(outcome) { outcomes.push(outcome); },
    });

    const output = providers.get('anthropic')!.stream(model, {}) as Sink;
    assert.equal(output.ended, true);
    assert.equal(replacedProviderCalls, 0);
    assert.deepEqual(output.events.map((event) => (event as { error: { errorMessage: string } }).error.errorMessage), [
      CONSUME_ERRORS.quotaUnavailable,
    ]);
    assert.deepEqual(outcomes, [{
      accountId: CSWAP_ACTIVE_ID,
      provider: 'anthropic',
      model: model.id,
      outcome: 'unavailable',
      error: CONSUME_ERRORS.quotaUnavailable,
    }]);
  });

  it('conflict provider replaces the pool with an error-only provider', () => {
    const providers = new Map<string, AnthropicNativeProvider>();
    const pi: ProviderApi = {
      unregisterProvider(name) { providers.delete(name); },
      registerProvider(provider) { providers.set(provider.id, provider); },
    };
    registerConflictProvider(pi, sink, CONSUME_ERRORS.conflict, { models: [model] });
    const output = providers.get('anthropic')!.streamSimple(model, {}) as Sink;
    assert.equal(output.ended, true);
    assert.deepEqual(output.events.map((event) => (event as { error: { errorMessage: string } }).error.errorMessage), [
      CONSUME_ERRORS.conflict,
    ]);
  });

  it('conflict provider registers QLB-managed auth and never resolves stored OAuth', async () => {
    const providers = new Map<string, AnthropicNativeProvider>();
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
    assert.deepEqual(await provider.auth.apiKey.check(), { type: 'api_key', source: 'QLB consume' });
    assert.deepEqual(await provider.auth.apiKey.resolve(), {
      auth: { apiKey: QLB_RUNTIME_AUTH_SENTINEL }, source: 'QLB consume',
    });
  });

  it('a missing Anthropic catalog fails closed without native auth', async () => {
    const providers = new Map<string, AnthropicNativeProvider>();
    const pi: ProviderApi = {
      unregisterProvider(name) { providers.delete(name); },
      registerProvider(provider) { providers.set(provider.id, provider); },
    };
    registerConflictProvider(pi, sink, 'catalog unavailable');
    const provider = providers.get('anthropic')!;
    assert.deepEqual(provider.getModels(), []);
    assert.equal(provider.baseUrl, undefined);
    assert.equal('oauth' in provider.auth, false);
    assert.deepEqual(await provider.auth.apiKey.resolve(), {
      auth: { apiKey: QLB_RUNTIME_AUTH_SENTINEL }, source: 'QLB consume',
    });
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
    assert.equal(out.self, '[circular]', 'true cycles become a stable marker');
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
