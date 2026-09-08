import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyHttpStatus,
  classifyProviderStreamEvent,
} from '../extensions/qlb-pi/outcome';
import { shapeAnthropicOAuthPayload } from '../extensions/qlb-pi/request-shaping';
import {
  CLAUDE_CODE_ENTRYPOINT,
  MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX,
  PI_DEFAULT_PROMPT_PREFIX,
  PI_DEFAULT_PROMPT_TERMINATOR,
} from '../extensions/qlb-pi/constants';

describe('qlb-pi audit outcome classification', () => {
  it('treats 2xx HTTP statuses as ok and everything else as failed', () => {
    assert.equal(classifyHttpStatus(200), 'ok');
    assert.equal(classifyHttpStatus(201), 'ok');
    assert.equal(classifyHttpStatus(299), 'ok');
    assert.equal(classifyHttpStatus(400), 'failed');
    assert.equal(classifyHttpStatus(401), 'failed');
    assert.equal(classifyHttpStatus(429), 'failed');
    assert.equal(classifyHttpStatus(500), 'failed');
    assert.equal(classifyHttpStatus(0), 'failed');
    assert.equal(classifyHttpStatus(undefined), 'failed');
    assert.equal(classifyHttpStatus('200'), 'failed');
  });

  it('records provider stream error events as failed, including the 400 third-party body', () => {
    const classified = classifyProviderStreamEvent({
      type: 'error',
      reason: 'error',
      error: {
        stopReason: 'error',
        errorMessage:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}',
      },
    });
    assert.ok(classified);
    assert.equal(classified.outcome, 'failed');
    assert.match(classified.error ?? '', /Third-party apps now draw from your extra usage/);
  });

  it('records a successful done event as ok', () => {
    const classified = classifyProviderStreamEvent({
      type: 'done',
      reason: 'stop',
      message: { stopReason: 'stop' },
    });
    assert.deepEqual(classified, { outcome: 'ok' });
  });

  it('records done-with-error and aborted streams as failed', () => {
    assert.equal(
      classifyProviderStreamEvent({
        type: 'done',
        reason: 'error',
        message: { stopReason: 'error', errorMessage: 'boom' },
      })?.outcome,
      'failed',
    );
    assert.equal(
      classifyProviderStreamEvent({
        type: 'done',
        message: { stopReason: 'aborted' },
      })?.outcome,
      'failed',
    );
  });

  it('ignores intermediate deltas so they cannot mark a request ok', () => {
    assert.equal(classifyProviderStreamEvent({ type: 'start' }), null);
    assert.equal(classifyProviderStreamEvent({ type: 'text_delta', delta: 'hi' }), null);
    assert.equal(classifyProviderStreamEvent(null), null);
  });
});

describe('qlb-pi OAuth request shaping (parity with anthropic-pool)', () => {
  const piSystem =
    `${PI_DEFAULT_PROMPT_PREFIX}\n\nBe helpful.\n${PI_DEFAULT_PROMPT_TERMINATOR}`;

  it('prepends the Claude Code billing header and de-fingerprints the Pi system prompt', () => {
    const shaped = shapeAnthropicOAuthPayload({
      model: 'claude-sonnet-4-5',
      stream: true,
      messages: [{ role: 'user', content: 'hello world this is a test message' }],
      system: [{ type: 'text', text: piSystem }],
    }) as {
      system: Array<{ type: string; text: string }>;
      messages: unknown[];
    };

    assert.equal(shaped.system[0]?.text.startsWith('x-anthropic-billing-header:'), true);
    assert.match(shaped.system[0].text, new RegExp(`cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}`));
    assert.match(shaped.system[0].text, /cc_version=/);
    assert.match(shaped.system[0].text, /cch=/);

    const joined = shaped.system.map((b) => b.text).join('\n');
    assert.match(joined, new RegExp(MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX));
    assert.equal(joined.includes('operating inside pi, a coding agent harness'), false);
  });

  it('leaves non-Anthropic payloads untouched', () => {
    const payload = { foo: 1 };
    assert.equal(shapeAnthropicOAuthPayload(payload), payload);
  });
});
