import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { refreshXaiIfDue } from '../src/auto/xai';
import { refreshKimiCodingIfDue } from '../src/auto/kimi-coding';
import { GateFailure, runPiGate, type GateCredential } from '../src/pi-gate';

const NOW = 1_730_000_000_000;

function gateCredential(expiresAt: number): GateCredential {
  return { token: 'fixture-access', accountId: 'default', expiresAt, source: 'keychain' };
}

describe('single-account automatic bindings', () => {
  it('does not refresh before the ten-minute auto freshen horizon', async () => {
    let xaiCalls = 0;
    const xai = await refreshXaiIfDue({
      now: () => NOW,
      read: () => gateCredential(NOW + 600_001),
      refresh: async () => { xaiCalls += 1; return gateCredential(NOW + 3_600_000); },
    });
    assert.equal(xai.refreshed, false);
    assert.equal(xaiCalls, 0);

    let kimiCalls = 0;
    const kimi = await refreshKimiCodingIfDue({
      now: () => NOW,
      read: () => gateCredential(NOW + 600_000),
      refresh: async () => { kimiCalls += 1; return gateCredential(NOW + 3_600_000); },
    });
    assert.equal(kimi.refreshed, true);
    assert.equal(kimiCalls, 1);
  });

  it('gate refreshes at sixty seconds and delivers the re-read credential', async () => {
    const db = {
      exec: () => undefined,
      prepare: (sql: string) => ({
        get: () => sql.includes('FROM lifecycle') ? { id: 1, state: 'cutting-over', began_at: NOW } : undefined,
        run: () => undefined,
      }),
      close: () => undefined,
    } as never;
    let refreshed = 0;
    const output: string[] = [];
    const status = await runPiGate('xai', {
      dbPath: ':memory:',
      env: {},
      guard: () => true,
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      now: () => NOW,
      open: () => db,
      provider: {
        read: () => gateCredential(NOW + 60_000),
        refresh: async () => {
          refreshed += 1;
          return { ...gateCredential(NOW + 3_600_000), token: 'winner-access' };
        },
      },
      deliver: (value) => output.push(value),
    });

    assert.equal(status, 0);
    assert.equal(refreshed, 1);
    assert.deepEqual(JSON.parse(output[0]!), { token: 'winner-access', accountId: 'default', source: 'keychain', expiresAt: NOW + 3_600_000 });
  });

  it('fails closed when the sixty-second refresh fails', async () => {
    const db = { close: () => undefined } as never;
    const status = await runPiGate('xai', {
      dbPath: ':memory:', env: {}, guard: () => true, admitted: () => ({ ok: true }), prerequisites: () => undefined, now: () => NOW,
      open: () => db,
      provider: { read: () => gateCredential(NOW + 1), refresh: () => { throw new GateFailure('credential-unavailable'); } },
      deliver: () => assert.fail('must not deliver an expiring credential after refresh fails'),
    });
    assert.equal(status, 1);
  });
});
