import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { redactError, redactEvent, redactJson, redactSecrets } from '../src/redact';

const REDACTED = '[redacted]';

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const sk = 'sk-' + 'ant-' + 'a'.repeat(40);
const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(24) + '.' + 'c'.repeat(24);
const unsignedJwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(24) + '.';

function bearer(last: string): string {
  return 'Bearer ' + 'a'.repeat(24) + last;
}

describe('redaction', () => {
  it('redacts supplied secrets and their SHA-256 fingerprints', () => {
    const secret = 'fixture-' + 'secret-value';
    const result = redactSecrets(`token=${secret} fingerprint=${fingerprint(secret)}`, [secret]);

    assert.equal(result.includes(secret), false);
    assert.equal(result.includes(fingerprint(secret)), false);
    assert.equal(result, `token=${REDACTED} fingerprint=${REDACTED}`);
  });

  it('redacts longest supplied values before their prefixes and their fingerprints', () => {
    const prefix = 'prefix-';
    const full = prefix + 'value-' + 'a'.repeat(24);
    const result = redactSecrets(`${prefix} ${full} ${fingerprint(full)}`, [prefix, full]);

    assert.equal(result.includes(prefix), false);
    assert.equal(result.includes(full), false);
    assert.equal(result.includes(fingerprint(full)), false);
    assert.equal((result.match(/\[redacted\]/g) ?? []).length, 3);
  });

  it('redacts token-shaped values in a 2 KB body without requiring their values (AC41 2 KB body)', () => {
    const bodyTokens = [sk, 'sk-' + 'or-v1-' + 'b'.repeat(40), jwt];
    const body = `${'x'.repeat(1800)} ${bodyTokens.join(' ')} ${'y'.repeat(180)} `;
    assert.ok(Buffer.byteLength(body) >= 2048);

    const result = redactSecrets(body, []);
    for (const token of bodyTokens) assert.equal(result.includes(token), false);
    assert.equal((result.match(/\[redacted\]/g) ?? []).length, 3);
  });

  it('redacts unsigned JWTs with an empty signature segment', () => {
    const result = redactSecrets(`token=${unsignedJwt}`, []);

    assert.equal(result.includes(unsignedJwt), false);
    assert.equal(result, `token=${REDACTED}`);
  });

  it('redacts xAI keys and tokens ending in every supported punctuation character', () => {
    const xai = 'xai-' + 'A'.repeat(40);
    const values = [sk + '-', 'key_' + sk + '-', jwt + '-', ...['~', '-', '.', '+', '/', '='].map(bearer), xai];

    const result = redactSecrets(values.join(' '), []);
    for (const value of values) assert.equal(result.includes(value), false, value.slice(0, 8));
    assert.equal((result.match(/\[redacted\]/g) ?? []).length, values.length);
  });

  it('redacts stream events by pattern even with no supplied secret', () => {
    const event = { error: `${sk}-` };
    const result = JSON.stringify(redactEvent(event, []));

    assert.equal(result.includes(sk), false);
  });

  it('preserves live event keys and primitive value types while redacting string values', () => {
    const raw = 'raw-secret-value';
    const event = {
      usage: { tokens: 12, total_tokens: 3, cached: false, empty: null },
      toolCall: { arguments: { token: 'abc', password: 'p', apiKey: 'k', cookie: 'c' } },
      raw,
      content: sk,
    };

    const result = redactEvent(event, [raw]) as typeof event;
    assert.deepEqual(result.usage, { tokens: 12, total_tokens: 3, cached: false, empty: null });
    assert.deepEqual(result.toolCall.arguments, { token: 'abc', password: 'p', apiKey: 'k', cookie: 'c' });
    assert.equal(result.raw, REDACTED);
    assert.equal(result.content, REDACTED);
  });

  it('redacts persisted property names and preserves collisions without dropping values', () => {
    const secret = 'fixture-' + 'secret-key';
    const tokenKey = 'sk-' + 'key-' + 'k'.repeat(40);
    const result = redactJson({ [secret]: 1, [tokenKey]: 2 }, [secret]);
    const parsed = JSON.parse(result) as Record<string, number>;

    assert.equal(result.includes(secret), false);
    assert.equal(result.includes(tokenKey), false);
    assert.deepEqual(parsed, { [REDACTED]: 1, [`${REDACTED}#2`]: 2 });
  });

  it('preserves own __proto__ fields without changing the clone prototype', () => {
    const input = JSON.parse('{"__proto__":{"type":"error"},"type":"ok"}') as Record<string, unknown>;
    const parsed = JSON.parse(redactJson(input, [])) as Record<string, unknown>;

    assert.equal(Object.hasOwn(parsed, '__proto__'), true);
    assert.deepEqual(parsed.__proto__, { type: 'error' });
    assert.equal(parsed.type, 'ok');
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  });

  it('redacts sensitive key variants case-insensitively without invoking accessors or get traps', () => {
    const secret = 'opaque-' + 'value';
    const input = {
      token: secret,
      accessToken: secret,
      refresh_token: secret,
      'id-token': secret,
      apiKey: secret,
      api_key: secret,
      secret,
      clientSecret: secret,
      password: secret,
      authorization: secret,
      cookie: secret,
      'set-cookie': secret,
      'x-api-key': secret,
      get getter() {
        throw new Error('must not run');
      },
      get returnedSecret() {
        return secret;
      },
    };
    const guarded = new Proxy({ token: secret }, {
      get() {
        throw new Error('must not run');
      },
    });

    const parsed = JSON.parse(redactJson({ input, guarded }, [])) as Record<string, unknown>;
    assert.deepEqual(parsed.input, {
      token: REDACTED,
      accessToken: REDACTED,
      refresh_token: REDACTED,
      'id-token': REDACTED,
      apiKey: REDACTED,
      api_key: REDACTED,
      secret: REDACTED,
      clientSecret: REDACTED,
      password: REDACTED,
      authorization: REDACTED,
      cookie: REDACTED,
      'set-cookie': REDACTED,
      'x-api-key': REDACTED,
      getter: REDACTED,
      returnedSecret: REDACTED,
    });
    assert.deepEqual(parsed.guarded, { token: REDACTED });
    assert.equal(redactError({ token: secret }, []), '{"token":"[redacted]"}');
  });

  it('memoizes shared DAG clones while marking true cycles', () => {
    let node: Record<string, unknown> = { value: 'leaf' };
    for (let index = 0; index < 40; index += 1) node = { a: node, b: node };

    const started = Date.now();
    const clone = redactEvent(node, []) as Record<string, unknown>;
    assert.ok(Date.now() - started < 1_000, '40-level DAG must not expand per path');
    let cursor = clone;
    for (let index = 0; index < 40; index += 1) {
      assert.strictEqual(cursor.a, cursor.b, `level ${index} must reuse its shared clone`);
      cursor = cursor.a as Record<string, unknown>;
    }
  });

  it('drops functions including toJSON and copies shared values while marking true cycles', () => {
    const secret = 'fixture-' + 'secret-value';
    const shared = { value: `safe ${secret}` };
    const input: Record<string, unknown> = {
      a: shared,
      b: shared,
      callback() {
        return secret;
      },
      toJSON() {
        return secret;
      },
    };
    input.self = input;

    const result = redactJson(input, [secret]);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    assert.equal(result.includes(secret), false);
    assert.deepEqual(parsed.a, { value: `safe ${REDACTED}` });
    assert.deepEqual(parsed.b, { value: `safe ${REDACTED}` });
    assert.equal(parsed.self, '[circular]');
    assert.equal('callback' in parsed, false);
    assert.equal('toJSON' in parsed, false);
  });

  it('handles unreadable and primitive Error message descriptors without throwing', () => {
    const unreadable = new Error('ignored');
    Object.defineProperty(unreadable, 'message', { get() { throw new Error('must not run'); } });
    const numeric = new Error('ignored');
    Object.defineProperty(numeric, 'message', { value: 42 });

    assert.equal(redactError(unreadable, []), '[unreadable]');
    assert.equal(redactError(numeric, []), '42');
  });

  it('redacts Error messages and emits a single escaped line', () => {
    const secret = 'sk-' + 'ant-' + 'z'.repeat(40);
    const error = redactError(new Error(`request\nfailed\r${secret}\u0007`), [secret]);

    assert.equal(error.includes(secret), false);
    assert.equal(error.includes('\n'), false);
    assert.equal(error.includes('\r'), false);
    assert.equal(error.includes('\u0007'), false);
    assert.match(error, /request\\nfailed\\r\[redacted\]\\u0007/);
  });
});
