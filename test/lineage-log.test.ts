import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LineageLog } from '../src/lineage-log';
import { openStore } from '../src/store';

describe('lineage log (AC50)', () => {
  it('follows persisted A → B → C chains, never hash order', () => {
    const store = openStore(':memory:');
    try {
      const lineage = new LineageLog(store);
      lineage.recordTransition({
        provider: 'anthropic', accountId: 'account-a', fromFp: 'A', toFp: 'B', cause: 'post', by: 'qlb', evidence: 'post',
      });
      lineage.recordTransition({
        provider: 'anthropic', accountId: 'account-a', fromFp: 'B', toFp: 'C', cause: 'resync', by: 'qlb', evidence: 'oracle',
      });

      assert.equal(lineage.isSuccessor('anthropic', 'account-a', 'A', 'C'), true);
      assert.equal(lineage.isSuccessor('anthropic', 'account-a', 'C', 'A'), false);
      assert.equal(lineage.isSuccessor('anthropic', 'account-a', 'A', 'unrelated'), false);
      assert.equal(lineage.isSuccessor('anthropic', 'account-a', 'A', 'A'), false);
    } finally {
      store.close();
    }
  });

  it('treats the current slot prev fingerprint as one successor hop', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-lineage-prev-')), 'qlb.db');
    const initial = openStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO claude_slots (account_id, config_json, fingerprint, prev_fingerprint, dead, added_at) VALUES (?, '{}', ?, ?, 0, 1)").run('account-a', 'B', 'A');
    db.close();

    const store = openStore(path);
    try {
      assert.equal(new LineageLog(store).isSuccessor('anthropic', 'account-a', 'A', 'B'), true);
    } finally {
      store.close();
    }
  });

  it('keeps the graph across a store restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-lineage-')), 'qlb.db');
    const first = openStore(path);
    new LineageLog(first).recordTransition({
      provider: 'anthropic', accountId: 'account-a', fromFp: 'A', toFp: 'B', cause: 'post', by: 'qlb', evidence: 'post',
    });
    first.close();

    const restarted = openStore(path);
    try {
      assert.equal(new LineageLog(restarted).isSuccessor('anthropic', 'account-a', 'A', 'B'), true);
    } finally {
      restarted.close();
    }
  });
});
