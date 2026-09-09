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
  buildExpandPanelLines,
  buildFooterLines,
  EMPTY_HEALTH,
  EXPAND_SHORTCUT,
  formatAllUsage,
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
    const painters = {
      paintAccount: identity,
      paintDim: identity,
      paintWarn: identity,
      paintAccent: identity,
      truncate: (text: string, width: number) => text.slice(0, width),
      visible: (text: string) => text.length,
    };
    const session = {
      sessionId: '01a07d63-7a10-717c-8fa1-587b5bb7dc3e',
      repo: 'qlb',
      branch: 'main',
      contextPercent: 12.4,
    };
    const account = {
      accountId: 'account-3',
      label: 'sanket.patel@gmail.com',
      model: 'claude-sonnet-5',
      index: 2,
      buckets: [{ key: '5h', usedPct: 20 }, { key: '7d', usedPct: 20 }],
    };
    const wide = buildFooterLines({
      width: 120,
      session,
      account,
      health: { ...EMPTY_HEALTH, ownedStores: 5, accountCount: 8, overall: 'PASS' },
      model: 'claude-sonnet-5',
      ...painters,
    });
    assert.equal(wide.length, 2);
    assert.match(wide[0], /sid:01a07d63-7a10-717c-8fa1-587b5bb7dc3e/);
    assert.match(wide[0], /qlb/);
    assert.match(wide[0], /main/);
    assert.match(wide[0], /12%ctx/);
    assert.match(wide[0], /claude-sonnet-5/);
    assert.match(wide[1], /★ sanket.patel/);
    assert.match(wide[1], /5h 20%/);
    assert.match(wide[1], /sync ok/);
    assert.match(wide[1], /5 owned/);

    const narrow = buildFooterLines({
      width: 12,
      session,
      account,
      health: { ...EMPTY_HEALTH, ownedStores: 5, accountCount: 8, overall: 'WARN', nativeSyncWarn: 1 },
      model: 'claude-sonnet-5',
      ...painters,
    });
    assert.equal(narrow.length, 2);
    assert.ok(narrow[0].length <= 12);
    assert.ok(narrow[1].length <= 12);
    assert.match(narrow[0], /sid:/);

    const empty = buildFooterLines({
      width: 0,
      session,
      account: null,
      health: EMPTY_HEALTH,
      model: 'claude-sonnet-5',
      ...painters,
    });
    assert.deepEqual(empty, ['', '']);
  });

  it('keeps usage numbers on line 2 ahead of account counts when width is tight', () => {
    const identity = (s: string) => s;
    const mid = buildFooterLines({
      width: 42,
      session: {
        sessionId: 'abc',
        repo: 'qlb',
        branch: 'main',
        contextPercent: null,
      },
      account: {
        accountId: 'account-1',
        label: 'sanket.patel@gmail.com',
        model: 'claude-sonnet-5',
        index: 0,
        buckets: [{ key: '5h', usedPct: 12 }, { key: '7d', usedPct: 33 }],
      },
      health: {
        ...EMPTY_HEALTH,
        ownedStores: 5,
        accountCount: 8,
        nativeSyncWarn: 1,
        overall: 'WARN',
      },
      model: 'claude-sonnet-5',
      paintAccount: identity,
      paintDim: identity,
      paintWarn: identity,
      paintAccent: identity,
      truncate: (text, width) => text.slice(0, width),
      visible: (text) => text.length,
    });
    assert.equal(mid.length, 2);
    assert.match(mid[0], /sid:abc/);
    assert.match(mid[0], /ctx\?/);
    assert.match(mid[1], /5h 12%/);
    assert.match(mid[1], /1 drift/);
    assert.equal(mid[1].includes('8 accts'), false);
  });

  it('keeps per-account native-sync drift from doctor JSON', () => {
    const parsed = parseDoctorJson(JSON.stringify({
      overall: 'WARN',
      checks: [
        { name: 'native-sync:account-1', level: 'PASS', message: 'matches' },
        { name: 'native-sync:xai-default', level: 'WARN', message: 'native drifted' },
        { name: 'native-sync:kimi-default', level: 'FAIL', message: 'unreadable' },
      ],
    }));
    assert.equal(parsed.drifts?.length, 3);
    assert.deepEqual(parsed.drifts?.map((d) => d.accountId), [
      'account-1',
      'xai-default',
      'kimi-default',
    ]);
    assert.equal(parsed.drifts?.[1]?.level, 'WARN');
    assert.equal(parsed.drifts?.[2]?.level, 'FAIL');
  });

  it('formats every usage bucket, not just the compact pair', () => {
    assert.equal(
      formatAllUsage([
        { key: '7d:Fable', usedPct: 21 },
        { key: '7d', usedPct: 31 },
        { key: '5h', usedPct: 41 },
      ]),
      '5h 41% · 7d 31% · 7d:Fable 21%',
    );
  });

  it('renders the expand panel with all providers, drift, and decisions', () => {
    const identity = (s: string) => s;
    const lines = buildExpandPanelLines({
      width: 100,
      data: {
        ownershipByProvider: {
          anthropic: 'QLB_OWNED',
          xai: 'QLB_OWNED',
          'kimi-coding': 'QLB_OWNED',
          'openai-codex': 'QLB_OWNED',
          openrouter: 'QLB_OWNED',
        },
        accounts: [
          {
            accountId: 'account-3',
            provider: 'anthropic',
            label: 'sanket.patel@gmail.com',
            ownership: 'QLB_OWNED',
            buckets: [{ key: '5h', usedPct: 41 }, { key: '7d', usedPct: 31 }],
          },
          {
            accountId: 'xai-default',
            provider: 'xai',
            label: 'Grok (xAI)',
            ownership: 'QLB_OWNED',
            buckets: [{ key: 'tokens', usedPct: 0 }],
          },
        ],
        decisions: [
          {
            id: 855,
            ts: Date.parse('2026-09-09T12:03:09Z'),
            session: '',
            accountId: 'account-3',
            model: 'claude-fable-5-1',
            mode: 'headroom',
            reason: 'headroom score 29.4',
          },
        ],
      },
      health: {
        ...EMPTY_HEALTH,
        overall: 'WARN',
        nativeSyncWarn: 1,
        drifts: [
          { accountId: 'account-1', level: 'PASS', message: 'matches' },
          { accountId: 'xai-default', level: 'WARN', message: 'native drifted' },
        ],
      },
      selectedAccountId: 'account-3',
      shortcut: EXPAND_SHORTCUT,
      paintAccount: identity,
      paintDim: identity,
      paintWarn: identity,
      paintAccent: identity,
      truncate: (text, width) => text.slice(0, width),
    });
    const text = lines.join('\n');
    assert.match(text, /qlb details/);
    assert.match(text, /ctrl\+alt\+q/);
    assert.match(text, /anthropic  QLB_OWNED/);
    assert.match(text, /xai  QLB_OWNED/);
    assert.match(text, /kimi-coding  QLB_OWNED/);
    assert.match(text, /openai-codex  QLB_OWNED/);
    assert.match(text, /openrouter  QLB_OWNED/);
    assert.match(text, /★ sanket.patel/);
    assert.match(text, /5h 41%/);
    assert.match(text, /xai-default  WARN  native drifted/);
    assert.equal(text.includes('account-1  PASS'), false);
    assert.match(text, /#855/);
    assert.match(text, /claude-fable-5-1/);
    assert.match(text, /headroom score 29.4/);
  });

  it('shows a fail-open message when expand data cannot be loaded', () => {
    const identity = (s: string) => s;
    const lines = buildExpandPanelLines({
      width: 40,
      data: null,
      paintAccount: identity,
      paintDim: identity,
      paintWarn: identity,
      paintAccent: identity,
      truncate: (text, width) => text.slice(0, width),
    });
    assert.deepEqual(lines, ['unable to load QLB details']);
  });
});
