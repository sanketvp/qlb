import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/config';
import {
  canSkipJournal,
  conflictMessage,
  consumeMarkerPath,
  CONSUME_ERRORS,
  CSWAP_ACTIVE_ID,
  decidePiMode,
  parseConsumeStatus,
  readOwnerFileState,
  type ConsumeJournal,
  type OwnerFileState,
  type PiMode,
} from '../extensions/qlb-pi/consume';
import {
  registerConflictProvider,
  registerUnavailableConsumeProvider,
  type AnthropicNativeProvider,
  type EventSink,
  type ModelLike,
  type ProviderApi,
} from '../extensions/qlb-pi/consume-provider';
import { QLB_RUNTIME_AUTH_SENTINEL } from '../extensions/qlb-pi/providers/openai-codex';

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

    registerUnavailableConsumeProvider(pi, {
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
