import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { externalLoginCheck, LineageLog, type ExternalLoginInput } from '../src/lineage-log';
import { openStore } from '../src/store';

describe('external-login evidence (AC18 fixture part)', () => {
  it('records hard Claude evidence only for an unrelated oracle-owned lineage with a moved login expiry', () => {
    assert.equal(externalLoginCheck({
      provider: 'anthropic', successor: false, oracleOwnAccount: true, loginExpiryMoved: true,
    }), 'hard');
    assert.equal(externalLoginCheck({
      provider: 'anthropic', successor: false, loginExpiryMoved: true,
    }), 'soft');
    assert.equal(externalLoginCheck({
      provider: 'anthropic', successor: true, oracleOwnAccount: true, loginExpiryMoved: true,
    }), 'none');
  });

  it('does not count a normal Claude Code rotation with an injected holder observation or a QLB POST', () => {
    assert.equal(externalLoginCheck({
      provider: 'anthropic',
      successor: false,
      holderObservation: { aliveBefore: true, aliveAfter: false },
    }), 'none');
    assert.equal(externalLoginCheck({
      provider: 'anthropic', successor: false, oracleOwnAccount: true,
    }), 'none');
    assert.equal(externalLoginCheck({ provider: 'anthropic', successor: false, qlbPost: true }), 'none');
  });

  it('returns soft only for an unattributed, holder-free, non-QLB rotation', () => {
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

  it('records changed Codex auth_time as hard evidence', () => {
    assert.equal(externalLoginCheck({ provider: 'openai-codex', successor: false, authTimeChanged: true }), 'hard');
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

      assert.equal(check({ provider: 'anthropic', oracleOwnAccount: true, loginExpiryMoved: true }), 'hard');
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
