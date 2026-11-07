import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readCodexUsageDiagnostic, runCodexUsageDiagnostic } from '../src/codex-usage-diagnostic';
import { openStore } from '../src/store';

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('Codex usage diagnostic', () => {
  it('returns an explicit no-record state without creating a database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-codex-diagnostic-')), 'missing.db');
    assert.deepEqual(readCodexUsageDiagnostic(1_700_000_000_000, path), {
      provider: 'openai-codex', recorded: false, attemptedAt: null, networkDispatchAttempted: null,
      classification: null, entitlementEvidence: null, httpStatus: null, endpoint: null,
      fallbackAttempted: null, parserShape: null, backoffUntil: null,
      authoritativeWindowObserved: false, stale: true,
    });
    assert.equal(existsSync(path), false);
  });

  it('reads only finite persisted metadata without changing the database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-codex-diagnostic-')), 'qlb.db');
    const store = openStore(path);
    try {
      store.recordUsagePollResult('openai-codex', 'account', {
        attemptedAt: 1_700_000_000, status: 'usage-unknown',
        codexDiagnostic: {
          classification: 'forbidden-or-provider-ineligible', httpStatus: 403, endpoint: 'wham',
          fallbackAttempted: false, parserShape: 'not-applicable', entitlementEvidence: 'provider-forbidden-or-ineligible',
        },
      });
    } finally { store.close(); }
    const before = hash(path);
    const output = readCodexUsageDiagnostic(1_700_000_000_000, path);
    assert.equal(hash(path), before);
    assert.deepEqual(output, {
      provider: 'openai-codex', recorded: true, attemptedAt: 1_700_000_000,
      networkDispatchAttempted: true, classification: 'forbidden-or-provider-ineligible',
      entitlementEvidence: 'provider-forbidden-or-ineligible', httpStatus: 403, endpoint: 'wham',
      fallbackAttempted: false, parserShape: 'not-applicable', backoffUntil: 1_700_000_030,
      authoritativeWindowObserved: false, stale: false,
    });
  });

  it('clears a diagnostic when a later Codex poll has none', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-codex-diagnostic-')), 'qlb.db');
    const store = openStore(path);
    try {
      store.recordUsagePollResult('openai-codex', 'account', {
        attemptedAt: 10, status: 'usage-unknown',
        codexDiagnostic: {
          classification: 'rate-limited', httpStatus: 429, endpoint: 'wham',
          fallbackAttempted: false, parserShape: 'not-applicable', entitlementEvidence: 'unknown',
        },
      });
      store.recordUsagePollResult('openai-codex', 'account', { attemptedAt: 20, status: 'usage-unknown' });
    } finally { store.close(); }

    assert.equal(readCodexUsageDiagnostic(20_000, path).recorded, false);
  });

  it('emits documented JSON and text for a persisted diagnostic', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-codex-diagnostic-')), 'qlb.db');
    const store = openStore(path);
    try {
      store.recordUsagePollResult('openai-codex', 'account', {
        attemptedAt: 1_700_000_000, status: 'usage-unknown',
        codexDiagnostic: {
          classification: 'rate-limited', httpStatus: 429, endpoint: 'wham',
          fallbackAttempted: false, parserShape: 'not-applicable', entitlementEvidence: 'unknown',
        },
      });
    } finally { store.close(); }

    const json: string[] = [];
    const errors: string[] = [];
    assert.equal(runCodexUsageDiagnostic(['--json'], (line) => json.push(line), (line) => errors.push(line), path), 0);
    assert.deepEqual(JSON.parse(json[0] ?? ''), {
      provider: 'openai-codex', recorded: true, attemptedAt: 1_700_000_000,
      networkDispatchAttempted: true, classification: 'rate-limited', entitlementEvidence: 'unknown',
      httpStatus: 429, endpoint: 'wham', fallbackAttempted: false, parserShape: 'not-applicable',
      backoffUntil: 1_700_000_030, authoritativeWindowObserved: false, stale: true,
    });
    assert.deepEqual(errors, []);

    const text: string[] = [];
    assert.equal(runCodexUsageDiagnostic([], (line) => text.push(line), (line) => errors.push(line), path), 0);
    assert.deepEqual(text, ['codex usage diagnostic: attemptedAt=1700000000 dispatch=true classification=rate-limited entitlement=unknown http=429 endpoint=wham fallback=false parser=not-applicable backoff=1700000030 authoritative=false stale=true']);
  });

  it('rejects invalid command arguments', () => {
    const lines: string[] = [];
    assert.equal(runCodexUsageDiagnostic(['--bad'], (line) => lines.push(line), (line) => lines.push(line)), 1);
    assert.deepEqual(lines, ['usage: qlb codex usage-diagnostic [--json]']);
  });
});
