import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONSUME_ERRORS, CSWAP_ACTIVE_ID } from '../extensions/qlb-pi/consume';
import {
  registerUnavailableConsumeProvider,
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
