import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listPolicies,
  resolvePolicy,
  setPolicy,
  unmappedErrorBody,
} from '../src/policy';
import { openStore } from '../src/store';

describe('qlb policy lookup — §4.9.2b', () => {
  it('set/get/list round-trip', () => {
    const store = openStore(':memory:');
    const created = setPolicy(store, {
      harness: 'claude-code',
      virtualModel: 'claude-sonnet-5--qlb-high',
      realModel: 'claude-sonnet-5',
      effort: 'high',
      fallback: ['claude-opus-5'],
    });
    assert.equal(created.harness, 'claude-code');
    assert.equal(created.virtualModel, 'claude-sonnet-5--qlb-high');
    assert.equal(created.realModel, 'claude-sonnet-5');
    assert.equal(created.effort, 'high');
    assert.deepEqual(created.fallback, ['claude-opus-5']);
    assert.equal(created.sessionMode, 'header');

    const got = resolvePolicy(store, 'claude-code', 'claude-sonnet-5--qlb-high');
    assert.ok(got);
    assert.deepEqual(got, created);

    setPolicy(store, {
      harness: 'codex',
      virtualModel: 'gpt-5.4--qlb-high',
      realModel: 'gpt-5.4',
      effort: 'high',
    });
    const all = listPolicies(store);
    assert.equal(all.length, 2);
    const onlyClaude = listPolicies(store, 'claude-code');
    assert.equal(onlyClaude.length, 1);
    assert.equal(onlyClaude[0].virtualModel, 'claude-sonnet-5--qlb-high');

    // upsert updates
    setPolicy(store, {
      harness: 'claude-code',
      virtualModel: 'claude-sonnet-5--qlb-high',
      realModel: 'claude-sonnet-5',
      effort: 'max',
      fallback: [],
    });
    const updated = resolvePolicy(store, 'claude-code', 'claude-sonnet-5--qlb-high');
    assert.equal(updated?.effort, 'max');
    assert.deepEqual(updated?.fallback, []);
    store.close();
  });

  it('unmapped lookup returns null', () => {
    const store = openStore(':memory:');
    assert.equal(resolvePolicy(store, 'claude-code', 'no-such-model'), null);
    assert.equal(resolvePolicy(store, 'codex', 'also-missing'), null);
    store.close();
  });

  it('unmapped error bodies match harness shapes', () => {
    const anth = unmappedErrorBody('claude-code', 'X') as {
      type: string;
      error: { type: string; message: string };
    };
    assert.equal(anth.type, 'error');
    assert.equal(anth.error.type, 'invalid_request_error');
    assert.match(anth.error.message, /no policy for model 'X'/);

    const codex = unmappedErrorBody('codex', 'Y') as { detail: string };
    assert.match(codex.detail, /no policy for model 'Y'/);
    assert.match(codex.detail, /harness codex/);
  });
});
