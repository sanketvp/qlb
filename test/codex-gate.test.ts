import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CODEX_GATE_CONFIG_KEY,
  runCodexGate,
  type CodexGateDeps,
  type CodexGateHttpResponse,
  type G0Capture,
} from '../src/codex-gate';
import { openStore } from '../src/store';

/**
 * Automated tests mock the HTTP call layer and never fire real requests to
 * Anthropic / OpenAI / ChatGPT / Codex backends. The REAL gate must be run
 * manually via `qlb gate codex` when actually needed (it consumes a handful
 * of Codex quota by design).
 */

const G0_OK: G0Capture = {
  ok: true,
  path: '/v1/responses',
  bodyShape: {
    model: 'gpt-5.4',
    hasInput: true,
    hasInstructions: true,
    stream: true,
    store: false,
    keys: ['model', 'input', 'instructions', 'stream', 'store'],
  },
};

function okSse(): CodexGateHttpResponse {
  return {
    status: 200,
    headers: { 'x-codex-primary-used-percent': '10' },
    body: [
      'event: response.created',
      'data: {}',
      '',
      'event: response.output_text.delta',
      'data: {"delta":"pong"}',
      '',
      'event: response.completed',
      'data: {}',
      '',
    ].join('\n'),
  };
}

function deps(overrides: Partial<CodexGateDeps> = {}): CodexGateDeps {
  return {
    whichCodex: async () => '/opt/homebrew/bin/codex',
    getCodexVersion: async () => 'codex-cli 0.153.4',
    captureG0: async () => G0_OK,
    sendCodexRequest: async () => okSse(),
    now: () => 1_725_000_000_000,
    ...overrides,
  };
}

describe('codex gate state machine — §4.9.2a (mocked HTTP)', () => {
  it('records GO when G1 is 3/3 successful and persists to config', async () => {
    const store = openStore(':memory:');
    const labels: string[] = [];
    const result = await runCodexGate(
      store,
      deps({
        sendCodexRequest: async (_body, label) => {
          labels.push(label);
          return okSse();
        },
      }),
    );
    assert.equal(result.verdict, 'GO');
    assert.equal(result.path, 'path1');
    assert.equal(result.codexVersion, 'codex-cli 0.153.4');
    assert.equal(result.timestamp, 1_725_000_000_000);
    assert.equal(labels.length, 3);
    const g1 = result.steps.find((s) => s.step === 'G1');
    assert.equal(g1?.passed, true);
    const g2 = result.steps.find((s) => s.step === 'G2');
    assert.equal(g2?.skipped, true);
    const g3 = result.steps.find((s) => s.step === 'G3');
    assert.equal(g3?.skipped, true);
    const g4 = result.steps.find((s) => s.step === 'G4');
    assert.equal(g4?.passed, true);

    const stored = store.getConfig(CODEX_GATE_CONFIG_KEY);
    assert.ok(stored);
    const parsed = JSON.parse(stored) as { verdict: string };
    assert.equal(parsed.verdict, 'GO');
    store.close();
  });

  it('records NO-GO when G1 HTTP calls fail, without treating skip-G2 as success', async () => {
    const store = openStore(':memory:');
    const result = await runCodexGate(
      store,
      deps({
        sendCodexRequest: async () => ({
          status: 401,
          headers: {},
          body: '{"detail":"unauthorized"}',
        }),
      }),
    );
    assert.equal(result.verdict, 'NO-GO');
    assert.equal(result.path, undefined);
    const g1 = result.steps.find((s) => s.step === 'G1');
    assert.equal(g1?.passed, false);
    const stored = store.getConfig(CODEX_GATE_CONFIG_KEY);
    assert.ok(stored);
    assert.equal(JSON.parse(stored).verdict, 'NO-GO');
    store.close();
  });

  it('G2 attemptG2 result is recorded without faking success when skipped', async () => {
    const store = openStore(':memory:');
    const result = await runCodexGate(
      store,
      deps({
        attemptG2: async () => ({
          passed: true,
          detail: 'tool round-trip echoed qlb-gate-ok',
        }),
      }),
    );
    const g2 = result.steps.find((s) => s.step === 'G2');
    assert.equal(g2?.passed, true);
    assert.equal(g2?.skipped, undefined);
    assert.equal(result.verdict, 'GO');
    store.close();
  });
});
