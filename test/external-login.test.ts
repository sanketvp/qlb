import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { externalLoginCheck, LineageLog, type ExternalLoginInput } from '../src/lineage-log';
import { openStore } from '../src/store';

describe('external-login evidence (AC18 fixture part)', () => {
  it('records hard Claude evidence only for an unrelated oracle-owned lineage with verified L41 and a moved login expiry', () => {
    assert.equal(externalLoginCheck({
      provider: 'anthropic', successor: false, oracleOwnAccount: true, l41Verified: true, loginExpiryMoved: true,
    }), 'hard');
    assert.equal(externalLoginCheck({
      provider: 'anthropic', successor: false, oracleOwnAccount: true, loginExpiryMoved: true,
    }), 'soft');
    assert.equal(externalLoginCheck({
      provider: 'anthropic', successor: false, loginExpiryMoved: true,
    }), 'soft');
    assert.equal(externalLoginCheck({
      provider: 'anthropic', successor: true, oracleOwnAccount: true, loginExpiryMoved: true,
    }), 'none');
  });

  it('attributes transitions to an injected live holder or a QLB POST', () => {
    assert.equal(externalLoginCheck({
      provider: 'anthropic',
      successor: false,
      holderObservation: { aliveBefore: true, aliveAfter: false },
    }), 'none');
    assert.equal(externalLoginCheck({
      provider: 'anthropic',
      successor: false,
      oracleOwnAccount: true,
      l41Verified: true,
      loginExpiryMoved: true,
      holderObservation: { aliveBefore: false, aliveAfter: true },
    }), 'none');
    assert.equal(externalLoginCheck({ provider: 'anthropic', successor: false, qlbPost: true }), 'none');
  });

  it('returns soft only for an unattributed, holder-free, non-QLB rotation', () => {
    assert.equal(externalLoginCheck({
      provider: 'anthropic',
      successor: false,
      oracleOwnAccount: true,
    }), 'soft');
    assert.equal(externalLoginCheck({
      provider: 'anthropic',
      successor: false,
      holderObservation: { aliveBefore: false, aliveAfter: false },
    }), 'soft');
    assert.equal(externalLoginCheck({
      provider: 'openai-codex',
      successor: false,
      holderObservation: { aliveBefore: true, aliveAfter: false },
    }), 'none');
    assert.equal(externalLoginCheck({ provider: 'openai-codex', successor: false }), 'soft');
  });

  it('classifies Codex auth_time evidence as hard only under verified L40, otherwise retaining the S65 soft/attributed distinctions', () => {
    assert.equal(externalLoginCheck({ provider: 'openai-codex', successor: false, authTimeChanged: true }), 'soft');
    assert.equal(externalLoginCheck({
      provider: 'openai-codex', successor: false, l40Verified: true, authTimeChanged: true,
    }), 'hard');
    assert.equal(externalLoginCheck({
      provider: 'openai-codex', successor: true, l40Verified: true, authTimeChanged: true,
    }), 'none');
    assert.equal(externalLoginCheck({
      provider: 'openai-codex', successor: false, l40Verified: true, authTimeChanged: true,
      holderObservation: { aliveBefore: false, aliveAfter: true },
    }), 'none');
  });

  it('classifies a persisted-to-slot lineage chain as a managed rotation', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-external-login-composed-prev-')), 'qlb.db');
    const initial = openStore(path);
    new LineageLog(initial).recordTransition({
      provider: 'anthropic', accountId: 'account-a', fromFp: 'A', toFp: 'B', cause: 'post', by: 'qlb', evidence: 'post',
    });
    initial.close();

    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO claude_slots (account_id, config_json, fingerprint, prev_fingerprint, dead, added_at) VALUES (?, '{}', ?, ?, 0, 1)").run('account-a', 'C', 'B');
    db.close();

    const store = openStore(path);
    try {
      const lineage = new LineageLog(store);
      assert.equal(lineage.externalLoginCheck({
        provider: 'anthropic', accountId: 'account-a', previousFingerprint: 'A', observedFingerprint: 'C',
      }), 'none');
    } finally {
      store.close();
    }
  });

  it('retains external-login classifications after a process restart using only lineage_log state', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qlb-external-login-')), 'qlb.db');
    const initial = openStore(path);
    new LineageLog(initial).recordTransition({
      provider: 'anthropic', accountId: 'account-a', fromFp: 'A', toFp: 'B', cause: 'post', by: 'qlb', evidence: 'post',
    });
    initial.close();

    const restarted = openStore(path);
    try {
      const lineage = new LineageLog(restarted);
      const check = (input: Omit<ExternalLoginInput, 'successor'>) => lineage.externalLoginCheck({
        ...input,
        accountId: 'account-a',
        previousFingerprint: 'B',
        observedFingerprint: 'C',
      });

      assert.equal(check({
        provider: 'anthropic', oracleOwnAccount: true, l41Verified: true, loginExpiryMoved: true,
      }), 'hard');
      assert.equal(check({
        provider: 'anthropic', holderObservation: { aliveBefore: true, aliveAfter: false },
      }), 'none');
      assert.equal(check({ provider: 'anthropic', qlbPost: true }), 'none');
      assert.equal(check({
        provider: 'anthropic', holderObservation: { aliveBefore: false, aliveAfter: false },
      }), 'soft');
    } finally {
      restarted.close();
    }
  });
});
