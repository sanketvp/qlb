import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runPiGate } from '../src/pi-gate';
import { beginCutover } from '../src/lifecycle';
import { openStore, openStoreConnection } from '../src/store';

describe('qlb gate evidence concurrency (S54)', () => {
  it('uses the store busy timeout and records both concurrent calls without SQLITE_BUSY', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'qlb-gate-concurrency-')), 'qlb.db');
    const store = openStore(dbPath);
    beginCutover(store);
    store.close();
    const gate = (provider: 'xai' | 'kimi-coding') => runPiGate(provider, {
      dbPath,
      env: { QLB_PI_TOKEN_CALL: '1' },
      deliver: () => undefined,
      guard: () => true,
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      provider: { read: () => ({ token: `fixture-${provider}`, accountId: `${provider}-default`, source: 'fixture' }) },
    });

    assert.deepEqual(await Promise.all([gate('xai'), gate('kimi-coding')]), [0, 0]);

    const db = openStoreConnection(dbPath, true);
    try {
      const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      assert.equal(timeout.timeout, 5_000);
      const rows = db.prepare("SELECT key FROM config WHERE key IN ('pi.xai.lastServedAt', 'pi.kimi-coding.lastServedAt') ORDER BY key").all() as Array<{ key: string }>;
      assert.deepEqual(rows.map((row) => row.key), ['pi.kimi-coding.lastServedAt', 'pi.xai.lastServedAt']);
    } finally {
      db.close();
    }
  });
});
