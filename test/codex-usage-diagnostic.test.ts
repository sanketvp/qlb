import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
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

  it('keeps command JSON stable and rejects invalid arguments', () => {
    const lines: string[] = [];
    assert.equal(runCodexUsageDiagnostic(['--bad'], (line) => lines.push(line), (line) => lines.push(line)), 1);
    assert.deepEqual(lines, ['usage: qlb codex usage-diagnostic [--json]']);
  });
});
