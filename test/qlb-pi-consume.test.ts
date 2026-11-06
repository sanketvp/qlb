import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveConfig } from '../src/config';

import {
  canSkipJournal,
  conflictMessage,
  CONSUME_ERRORS,
  CSWAP_ACTIVE_ID,
  decidePiMode,
  parseConsumeStatus,
  consumeMarkerPath,
  readOwnerFileState,
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

const model: ModelLike = {
  id: 'claude-sonnet-5', api: 'anthropic-messages', provider: 'anthropic',
};

describe('qlb-pi consume provider', () => {
  it('matches the fail-closed mode table', () => {
    for (const rehearsal of [undefined, '0', '1']) for (const owner of ['absent', 'valid', 'malformed'] as const) for (const journal of ['CONSUMED', 'NATIVE', 'unknown'] as const) for (const marker of [false, true]) {
      const expected = rehearsal === '0' ? 'inert' : owner === 'malformed' || rehearsal === '1' || owner === 'valid'
        ? journal === 'NATIVE' && owner !== 'malformed' ? 'owned' : 'conflict'
        : journal === 'CONSUMED' ? 'consume' : marker ? 'conflict' : 'inert';
      assert.equal(decidePiMode({ rehearsal, owner, journal, marker }), expected);
    }
  });

  it('classifies owner files, status, and marker paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-pi-'));
    assert.equal(readOwnerFileState(join(home, 'missing')), 'absent');
    writeFileSync(join(home, 'valid'), '{"accounts":[]}');
    assert.equal(readOwnerFileState(join(home, 'valid')), 'valid');
    writeFileSync(join(home, 'bad'), '{');
    assert.equal(readOwnerFileState(join(home, 'bad')), 'malformed');
    mkdirSync(join(home, 'dir'));
    assert.equal(readOwnerFileState(join(home, 'dir')), 'malformed');
    assert.equal(parseConsumeStatus(0, '{"state":"NATIVE"}'), 'NATIVE');
    assert.equal(parseConsumeStatus(0, 'bad'), 'unknown');
    const env = { QLB_DB_PATH: join(home, 'db', 'q.db') };
    assert.equal(consumeMarkerPath(env, home), join(dirname(resolveConfig({ argv: [], env, home, warn: () => undefined }).dbPath), 'consume-anthropic.json'));
  });
  it('keeps every incomplete consume transition out of the native pool', () => {
    for (const journal of ['unknown', 'NATIVE'] as const) {
      assert.equal(decidePiMode({ rehearsal: undefined, owner: 'absent', journal, marker: true }), 'conflict');
    }
    assert.equal(decidePiMode({ rehearsal: undefined, owner: 'valid', journal: 'CONSUMED', marker: false }), 'conflict');
    assert.equal(decidePiMode({ rehearsal: undefined, owner: 'absent', journal: 'CONSUMED', marker: false }), 'consume');
    assert.equal(canSkipJournal({ rehearsal: undefined, owner: 'absent', marker: false, dbExists: false }), true);
    assert.equal(canSkipJournal({ rehearsal: undefined, owner: 'absent', marker: false, dbExists: true }), false);
    assert.equal(parseConsumeStatus(1, '{"state":"CONSUMED"}'), 'unknown');
    assert.equal(conflictMessage({ rehearsal: undefined, owner: 'absent', journal: 'unknown', marker: true }), CONSUME_ERRORS.stateUnknown);
  });

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
});
