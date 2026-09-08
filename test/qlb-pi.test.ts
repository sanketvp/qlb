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
import {
  accountColorIndex,
  buildFooterLines,
  EMPTY_HEALTH,
  formatHealthText,
  formatUsage,
  parseDoctorJson,
  pickBuckets,
  shortLabel,
} from '../extensions/qlb-pi/footer';

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

describe('qlb-pi footer helpers', () => {
  it('colors anthropic account-N by stable slot index', () => {
    assert.equal(accountColorIndex('account-1'), 0);
    assert.equal(accountColorIndex('account-4'), 3);
    assert.equal(accountColorIndex('xai-default', ['kimi-default', 'xai-default']), 1);
  });

  it('shortens email labels to the local part', () => {
    assert.equal(shortLabel('sanket.patel@gmail.com'), 'sanket.patel');
    assert.equal(shortLabel('Grok (xAI)'), 'Grok (xAI)');
  });

  it('formats preferred usage buckets compactly', () => {
    const usage = formatUsage([
      { key: '7d:Fable', usedPct: 4 },
      { key: '7d', usedPct: 33.4 },
      { key: '5h', usedPct: 12 },
    ]);
    assert.equal(usage, '5h 12% · 7d 33%');
    assert.deepEqual(
      pickBuckets([{ key: 'weekly', usedPct: 68 }, { key: '5h', usedPct: 3 }]).map((b) => b.key),
      ['5h', 'weekly'],
    );
  });

  it('parses native-sync doctor checks into a drift summary', () => {
    const parsed = parseDoctorJson(JSON.stringify({
      overall: 'WARN',
      checks: [
        { name: 'sqlite', level: 'PASS', message: 'ok' },
        { name: 'native-sync:account-1', level: 'PASS', message: 'matches' },
        { name: 'native-sync:xai-default', level: 'WARN', message: 'native drifted' },
      ],
    }));
    assert.equal(parsed.nativeSyncPass, 1);
    assert.equal(parsed.nativeSyncWarn, 1);
    assert.equal(parsed.nativeSyncFail, 0);
    assert.equal(parsed.overall, 'WARN');
    assert.equal(parsed.driftMessage, 'native drifted');
    const health = formatHealthText({
      ...EMPTY_HEALTH,
      ownedStores: 5,
      accountCount: 8,
      ...parsed,
    });
    assert.equal(health.warn, true);
    assert.equal(health.text, 'qlb · 5 owned · 8 accts · 1 drift');
  });

  it('always returns exactly 2 lines and degrades when width is small', () => {
    const identity = (s: string) => s;
    const wide = buildFooterLines({
      width: 80,
      account: {
        accountId: 'account-3',
        label: 'sanket.patel@gmail.com',
        model: 'claude-sonnet-5',
        index: 2,
        buckets: [{ key: '5h', usedPct: 20 }, { key: '7d', usedPct: 20 }],
      },
      health: { ...EMPTY_HEALTH, ownedStores: 5, accountCount: 8, overall: 'PASS' },
      model: 'claude-sonnet-5',
      paintAccount: identity,
      paintDim: identity,
      paintWarn: identity,
      truncate: (text, width) => text.slice(0, width),
      visible: (text) => text.length,
    });
    assert.equal(wide.length, 2);
    assert.match(wide[0], /★ sanket.patel/);
    assert.match(wide[0], /5h 20%/);
    assert.match(wide[1], /sync ok/);

    const narrow = buildFooterLines({
      width: 12,
      account: {
        accountId: 'account-3',
        label: 'sanket.patel@gmail.com',
        model: 'claude-sonnet-5',
        index: 2,
        buckets: [{ key: '5h', usedPct: 20 }, { key: '7d', usedPct: 20 }],
      },
      health: { ...EMPTY_HEALTH, ownedStores: 5, accountCount: 8, overall: 'WARN', nativeSyncWarn: 1 },
      model: 'claude-sonnet-5',
      paintAccount: identity,
      paintDim: identity,
      paintWarn: identity,
      truncate: (text, width) => text.slice(0, width),
      visible: (text) => text.length,
    });
    assert.equal(narrow.length, 2);
    assert.ok(narrow[0].length <= 12);
    assert.ok(narrow[1].length <= 12);

    const empty = buildFooterLines({
      width: 0,
      account: null,
      health: EMPTY_HEALTH,
      model: 'claude-sonnet-5',
      paintAccount: identity,
      paintDim: identity,
      paintWarn: identity,
      truncate: (text, width) => text.slice(0, width),
      visible: (text) => text.length,
    });
    assert.deepEqual(empty, ['', '']);
  });
});
