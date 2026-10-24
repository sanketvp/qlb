import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { redactError, redactJson, redactSecrets } from '../src/redact';

const REDACTED = '[redacted]';

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('redaction', () => {
  it('redacts supplied secrets and their SHA-256 fingerprints', () => {
    const secret = 'fixture-secret-value';
    const result = redactSecrets(`token=${secret} fingerprint=${fingerprint(secret)}`, [secret]);

    assert.equal(result.includes(secret), false);
    assert.equal(result.includes(fingerprint(secret)), false);
    assert.equal(result, `token=${REDACTED} fingerprint=${REDACTED}`);
  });

  it('redacts token-shaped values in a 2 KB body without requiring their values', () => {
    const anthropic = 'sk-ant-oat-abcdefghijklmnopqrstuvwxyz0123456789';
    const openrouter = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.fixture-signature';
    const body = `${'x'.repeat(1800)} ${anthropic} ${openrouter} ${jwt} ${'y'.repeat(180)} `;
    assert.ok(Buffer.byteLength(body) >= 2048);

    const result = redactSecrets(body, []);
    for (const token of [anthropic, openrouter, jwt]) assert.equal(result.includes(token), false);
    assert.equal((result.match(/\[redacted\]/g) ?? []).length, 3);
  });

  it('redacts Error messages and nested JSON without mutating the input', () => {
    const secret = 'sk-ant-ort-fixture-secret-0123456789';
    const input = {
      response: { access_token: secret, nested: [{ message: `failed: ${secret}` }] },
      nonSecret: 'kept',
    };

    const json = redactJson(input, [secret]);
    const error = redactError(new Error(`request failed: ${secret}`), [secret]);

    assert.equal(json.includes(secret), false);
    assert.equal(error.includes(secret), false);
    assert.equal(input.response.access_token, secret, 'input must not be mutated');
    assert.deepEqual(JSON.parse(json), {
      response: { access_token: REDACTED, nested: [{ message: `failed: ${REDACTED}` }] },
      nonSecret: 'kept',
    });
  });
});
