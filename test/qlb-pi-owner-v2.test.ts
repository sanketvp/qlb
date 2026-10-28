import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createActiveAccessRegistry,
  qlbUnavailable,
  type ActiveAccessSource,
} from '../extensions/qlb-pi/active-access';
import {
  ownerStateForProvider,
  parsePiOwnerFile,
  decidePiMode,
  type CswapActiveAccess,
  type PiOwnerFile,
} from '../extensions/qlb-pi/consume';

describe('qlb-pi owner file v2', () => {
  it('owns only the providers explicitly named by a valid v2 owner file', () => {
    const owner = parsePiOwnerFile(JSON.stringify({
      providers: {
        xai: { mode: 'qlb', since: 1_728_000_000_000 },
        'kimi-coding': { mode: 'qlb', since: 1_728_000_000_001 },
      },
    }));
    assert.equal(owner.kind, 'v2');
    assert.equal(ownerStateForProvider(owner, 'xai'), 'valid');
    assert.equal(ownerStateForProvider(owner, 'kimi-coding'), 'valid');
    assert.equal(ownerStateForProvider(owner, 'anthropic'), 'absent');
    assert.equal(ownerStateForProvider(owner, 'openai-codex'), 'absent');
    assert.equal(ownerStateForProvider(owner, 'openrouter'), 'absent');
  });

  it('keeps a v1 owner file as anthropic-only ownership', () => {
    const owner = parsePiOwnerFile(JSON.stringify({ owner: 'qlb', accounts: [] }));
    assert.equal(owner.kind, 'v1');
    assert.equal(ownerStateForProvider(owner, 'anthropic'), 'valid');
    assert.equal(ownerStateForProvider(owner, 'xai'), 'absent');
  });

  it('treats malformed v2 ownership as a conflict for every provider', () => {
    for (const text of [
      '{',
      '[]',
      JSON.stringify({ providers: { xai: { mode: 'native', since: 1 } } }),
      JSON.stringify({ providers: { xai: { mode: 'qlb', since: 'later' } } }),
      JSON.stringify({ providers: { unknown: { mode: 'qlb', since: 1 } } }),
    ]) {
      const owner = parsePiOwnerFile(text);
      assert.equal(owner.kind, 'malformed', text);
      assert.equal(ownerStateForProvider(owner, 'xai'), 'malformed', text);
      assert.equal(ownerStateForProvider(owner, 'anthropic'), 'malformed', text);
    }
  });

  it('decides modes per provider without activating a provider absent from v2', () => {
    const owner: PiOwnerFile = {
      kind: 'v2',
      providers: { xai: { mode: 'qlb', since: 1 } },
    };
    assert.equal(
      decidePiMode('xai', { rehearsal: undefined, owner: ownerStateForProvider(owner, 'xai'), journal: 'NATIVE', marker: false }),
      'owned',
    );
    assert.equal(
      decidePiMode('anthropic', { rehearsal: undefined, owner: ownerStateForProvider(owner, 'anthropic'), journal: 'NATIVE', marker: false }),
      'inert',
    );
    assert.equal(
      decidePiMode('openrouter', { rehearsal: '0', owner: 'valid', journal: 'NATIVE', marker: false }),
      'inert',
    );
  });

  it('limits rehearsal ownership to Anthropic until each provider is migrated', () => {
    const nativeJournal = { rehearsal: '1', owner: 'absent' as const, journal: 'NATIVE' as const, marker: false };
    assert.equal(decidePiMode('anthropic', nativeJournal), 'owned');
    assert.equal(decidePiMode('openai-codex', nativeJournal), 'inert');
    assert.equal(decidePiMode('xai', nativeJournal), 'inert');
  });
});

describe('qlb-pi active access scaffold', () => {
  it('keeps one source per provider and rejects duplicates', async () => {
    const source: ActiveAccessSource = {
      provider: 'xai',
      read: async () => ({ token: 'opaque-test-value', accountId: 'xai-default', source: 'qlb-gate' }),
    };
    const registry = createActiveAccessRegistry([source]);
    assert.equal(registry.get('xai'), source);
    assert.equal((await registry.read('xai')).accountId, 'xai-default');
    assert.throws(() => registry.register(source), /already registered/);
    await assert.rejects(registry.read('anthropic'), /no active access source/);
  });

  it('makes a value-free, provider-specific fail-closed event', () => {
    const event = qlbUnavailable('openai-codex', 'store-open-failed', { id: 'gpt-5' });
    assert.equal(event.type, 'error');
    assert.equal(event.error.provider, 'openai-codex');
    assert.equal(event.error.model, 'gpt-5');
    assert.equal(event.error.errorMessage, 'QLB unavailable for openai-codex — run qlb doctor (store-open-failed)');
    assert.match(qlbUnavailable('xai', 'token value must not appear').error.errorMessage, /unknown/);
  });

  it('surfaces safe Anthropic gate refusals but refuses arbitrary causes', () => {
    assert.equal(
      qlbUnavailable('anthropic', 'cswap-process-alive').error.errorMessage,
      'QLB unavailable for anthropic — run qlb doctor (cswap-process-alive)',
    );
    assert.equal(
      qlbUnavailable('anthropic', 'arbitrary failure detail').error.errorMessage,
      'QLB unavailable for anthropic — run qlb doctor (unknown)',
    );
  });

  it('never emits a token-shaped cause value', () => {
    const tokenShapedCause = 'sk-' + 'ant-' + 'x'.repeat(40);
    const errorMessage = qlbUnavailable('xai', tokenShapedCause).error.errorMessage;
    assert.equal(errorMessage, 'QLB unavailable for xai — run qlb doctor (unknown)');
    assert.doesNotMatch(errorMessage, new RegExp(tokenShapedCause));
  });

  it('preserves fail-closed lifecycle phase cause codes', () => {
    for (const state of ['pre-cutover', 'undoing', 'rolled-back', 'aborted']) {
      assert.equal(
        qlbUnavailable('anthropic', `phase=${state}`).error.errorMessage,
        `QLB unavailable for anthropic — run qlb doctor (phase=${state})`,
      );
    }
    assert.match(qlbUnavailable('anthropic', 'phase=cutover').error.errorMessage, /\(unknown\)$/);
  });

  it('uses a distinct type for legacy cswap access', () => {
    const access: CswapActiveAccess = { access: 'test-access', fingerprint: 'test-fingerprint' };
    assert.equal(access.access, 'test-access');
  });
});
