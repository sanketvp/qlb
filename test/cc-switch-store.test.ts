import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { activeAnthropicMarker, enrichAccounts, formatDashboard } from '../src/dashboard';
import { openStore } from '../src/store';

type ClaudeDecision = {
  leftHeadroom: number | string | null;
  leftRecoveryAt: number | string | null;
  leftTrigger: number | string | null;
};

type ClaudeSwitchInput = {
  now: number;
  fromAccount: string;
  toAccount: string;
  trigger: string;
  setBy: 'manual' | 'auto' | 'journal';
  attempt: string;
  outgoingKind: string | null;
  bindingJson: string | null;
  stepsJson: string | null;
  publishedAt: number | null;
  injected: boolean;
  detail: string | null;
  republish: boolean;
  decision: ClaudeDecision;
  beforeCommit?: () => void;
};

type ClaudeStore = ReturnType<typeof openStore>;

function openClaudeStore(): ClaudeStore {
  return openStore(join(mkdtempSync(join(tmpdir(), 'qlb-cc-switch-store-')), 'qlb.db'));
}

function db(store: ClaudeStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function insertSlots(store: ClaudeStore): void {
  db(store).prepare(`INSERT INTO claude_slots (account_id, slot_num, org_uuid, config_json, added_at)
    VALUES ('from', 1, 'org-modustech', '{}', 1), ('to', 2, 'org-tiyopay', '{}', 1)`).run();
}

function input(overrides: Partial<ClaudeSwitchInput> = {}): ClaudeSwitchInput {
  return {
    now: 1_000,
    fromAccount: 'from',
    toAccount: 'to',
    trigger: 'proactive',
    setBy: 'auto',
    attempt: 'attempt-1',
    outgoingKind: 'own-bytes',
    bindingJson: '{"binding":"fixture"}',
    stepsJson: '{"started":[6,7,8]}',
    publishedAt: 900,
    injected: true,
    detail: 'fixture detail',
    republish: false,
    decision: { leftHeadroom: 42, leftRecoveryAt: 2_000, leftTrigger: 'proactive' },
    ...overrides,
  };
}

function configValues(store: ClaudeStore): Record<string, string> {
  return Object.fromEntries((db(store).prepare('SELECT key, value FROM config ORDER BY key').all() as Array<{ key: string; value: string }>)
    .map(({ key, value }) => [key, value]));
}

describe('Claude switch commit primitive', () => {
  it('commitClaudeSwitch writes active_login, last_active_at on the target row only, cooldown, the S45 keys and one ok row with the attempt in one transaction', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      const id = store.commitClaudeSwitch(input());
      assert.equal(id, 1);
      assert.deepEqual(store.getActiveLogin('anthropic'), {
        provider: 'anthropic', accountId: 'to', since: 1_000, setBy: 'auto',
      });
      assert.deepEqual(
        (db(store).prepare('SELECT account_id, last_active_at FROM claude_slots ORDER BY account_id').all() as object[]).map((row) => ({ ...row })),
        [{ account_id: 'from', last_active_at: null }, { account_id: 'to', last_active_at: 1_000 }],
      );
      for (const [key, value] of Object.entries({
        'auto.anthropic.lastSwitchFrom': 'from',
        'auto.anthropic.lastSwitchTo': 'to',
        'auto.anthropic.leftHeadroom': '42',
        'auto.anthropic.leftRecoveryAt': '2000',
        'auto.anthropic.leftTrigger': 'proactive',
        'cooldown.anthropic': '301000',
      })) assert.equal(store.getConfig(key), value, key);
      assert.deepEqual(
        { ...(db(store).prepare(`SELECT provider, from_account, to_account, trigger, outcome, outgoing_kind, binding_json,
          steps_json, published_at, committed_at, injected, detail FROM switch_log`).get() as object) },
        {
          provider: 'anthropic', from_account: 'from', to_account: 'to', trigger: 'proactive', outcome: 'ok',
          outgoing_kind: 'own-bytes', binding_json: '{"binding":"fixture"}',
          steps_json: '{"started":[6,7,8],"attempt":"attempt-1"}', published_at: 900, committed_at: 1_000,
          injected: 1, detail: 'fixture detail',
        },
      );
    } finally {
      store.close();
    }
  });

  it('a manual switch deletes auto.anthropic.lastSwitchTo', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      store.setConfig('auto.anthropic.lastSwitchTo', 'stale');
      store.commitClaudeSwitch(input({ trigger: 'manual', setBy: 'manual' }));
      assert.equal(store.getConfig('auto.anthropic.lastSwitchTo'), null);
    } finally {
      store.close();
    }
  });

  it('marks the active QLB slot ID directly during cutover', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      store.commitClaudeSwitch(input());
      const dashboard = formatDashboard(enrichAccounts([
        { accountId: 'from', provider: 'anthropic', label: '● stale-cache-active', buckets: {} },
        { accountId: 'to', provider: 'anthropic', label: 'active-slot', buckets: {} },
      ], {
        ownershipForProvider: () => 'QLB_OWNED',
        overrideForAccount: () => null,
        claudeCutoverPhase: 'cutover',
        activeAccountForProvider: (provider, accounts) => {
          const active = store.getActiveLogin(provider)?.accountId;
          return active === null || active === undefined
            ? undefined
            : activeAnthropicMarker(store.getAnthropicSlotStatusIdentity(active), accounts);
        },
      }));

      assert.match(dashboard, /^✓  stale-cache-active  anthropic/m);
      assert.match(dashboard, /^✓  ● active-slot  anthropic/m);
    } finally {
      store.close();
    }
  });

  it('dashboard keeps B marked after a successful switch to B and a failed switch back', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      store.setActiveLogin('anthropic', 'from', 'manual', 10);
      store.commitClaudeSwitch(input({ trigger: 'manual', setBy: 'manual' }));
      store.recordSwitch({
        ts: 1_100, provider: 'anthropic', fromAccount: 'to', toAccount: 'from', trigger: 'manual', outcome: 'failed', detail: 'fixture failure',
      });

      const dashboard = formatDashboard(enrichAccounts([
        { accountId: 'org-modustech', provider: 'anthropic', label: '● modustech', buckets: {} },
        { accountId: 'org-tiyopay', provider: 'anthropic', label: 'tiyopay', buckets: {} },
      ], {
        ownershipForProvider: () => 'QLB_OWNED',
        overrideForAccount: () => null,
        claudeCutoverPhase: 'cutover',
        activeAccountForProvider: (provider, accounts) => {
          const active = store.getActiveLogin(provider)?.accountId;
          return active === null || active === undefined
            ? undefined
            : activeAnthropicMarker(store.getAnthropicSlotStatusIdentity(active), accounts);
        },
      }));

      assert.match(dashboard, /^✓  modustech  anthropic/m);
      assert.match(dashboard, /^✓  ● tiyopay  anthropic/m);
      assert.deepEqual(store.getActiveLogin('anthropic'), {
        provider: 'anthropic', accountId: 'to', since: 1_000, setBy: 'manual',
      });
    } finally {
      store.close();
    }
  });

  it('null decision values delete their keys', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      for (const key of ['auto.anthropic.leftHeadroom', 'auto.anthropic.leftRecoveryAt', 'auto.anthropic.leftTrigger']) {
        store.setConfig(key, 'stale');
      }
      store.commitClaudeSwitch(input({ decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null } }));
      for (const key of ['auto.anthropic.leftHeadroom', 'auto.anthropic.leftRecoveryAt', 'auto.anthropic.leftTrigger']) {
        assert.equal(store.getConfig(key), null, key);
      }
    } finally {
      store.close();
    }
  });

  it('setBy journal is accepted and stamped', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      store.commitClaudeSwitch(input({ setBy: 'journal' }));
      assert.equal(store.getActiveLogin('anthropic')?.setBy, 'journal');
    } finally {
      store.close();
    }
  });

  it('republish writes the row with from == to and detail republish and leaves cooldown and every auto.anthropic key untouched', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      const seeded = {
        'cooldown.anthropic': 'old-cooldown',
        'auto.anthropic.lastSwitchFrom': 'old-from',
        'auto.anthropic.lastSwitchTo': 'old-to',
        'auto.anthropic.leftHeadroom': 'old-headroom',
        'auto.anthropic.leftRecoveryAt': 'old-recovery',
        'auto.anthropic.leftTrigger': 'old-trigger',
      };
      for (const [key, value] of Object.entries(seeded)) store.setConfig(key, value);
      store.setActiveLogin('anthropic', 'to', 'manual', 900);
      db(store).prepare('UPDATE claude_slots SET last_active_at = ? WHERE account_id = ?').run(800, 'to');
      store.commitClaudeSwitch(input({ fromAccount: 'to', toAccount: 'to', republish: true, detail: 'not-used' }));
      for (const [key, value] of Object.entries(seeded)) assert.equal(store.getConfig(key), value, key);
      assert.deepEqual(store.getActiveLogin('anthropic'), { provider: 'anthropic', accountId: 'to', since: 900, setBy: 'manual' });
      assert.equal((db(store).prepare("SELECT last_active_at FROM claude_slots WHERE account_id = 'to'").get() as { last_active_at: number }).last_active_at, 800);
      assert.deepEqual(
        { ...(db(store).prepare('SELECT from_account, to_account, detail FROM switch_log').get() as object) },
        { from_account: 'to', to_account: 'to', detail: 'republish' },
      );
    } finally {
      store.close();
    }
  });

  it('a throw from beforeCommit leaves no row, no active_login change and no config change', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      store.setActiveLogin('anthropic', 'from', 'manual', 10);
      store.setConfig('sentinel', 'unchanged');
      const beforeConfig = configValues(store);
      assert.throws(() => store.commitClaudeSwitch(input({ beforeCommit: () => { throw new Error('before commit'); } })), /before commit/);
      assert.equal(Number((db(store).prepare('SELECT COUNT(*) AS count FROM switch_log').get() as { count: number }).count), 0);
      assert.deepEqual(store.getActiveLogin('anthropic'), {
        provider: 'anthropic', accountId: 'from', since: 10, setBy: 'manual',
      });
      assert.deepEqual(configValues(store), beforeConfig);
    } finally {
      store.close();
    }
  });

  it('commitClaudeSwitch rejects a missing target slot and rolls back every switch effect', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      db(store).prepare('DELETE FROM claude_slots WHERE account_id = ?').run('to');
      store.setActiveLogin('anthropic', 'from', 'manual', 10);
      store.setConfig('sentinel', 'unchanged');
      const beforeActive = store.getActiveLogin('anthropic');
      const beforeConfig = configValues(store);
      assert.throws(() => store.commitClaudeSwitch(input()), /Claude switch target slot not found/);
      assert.equal(Number((db(store).prepare('SELECT COUNT(*) AS count FROM switch_log').get() as { count: number }).count), 0);
      assert.deepEqual(store.getActiveLogin('anthropic'), beforeActive);
      assert.deepEqual(configValues(store), beforeConfig);
      assert.deepEqual(
        (db(store).prepare('SELECT account_id, last_active_at FROM claude_slots ORDER BY account_id').all() as object[]).map((row) => ({ ...row })),
        [{ account_id: 'from', last_active_at: null }],
      );
    } finally {
      store.close();
    }
  });

  it('a failure inside the transaction writes none of it', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      store.setActiveLogin('anthropic', 'from', 'manual', 10);
      store.setConfig('sentinel', 'unchanged');
      const beforeActive = store.getActiveLogin('anthropic');
      const beforeConfig = configValues(store);
      db(store).exec(`CREATE TEMP TRIGGER fail_claude_switch BEFORE INSERT ON switch_log
        BEGIN SELECT RAISE(ABORT, 'switch row failure'); END`);
      assert.throws(() => store.commitClaudeSwitch(input()), /switch row failure/);
      assert.equal(Number((db(store).prepare('SELECT COUNT(*) AS count FROM switch_log').get() as { count: number }).count), 0);
      assert.deepEqual(store.getActiveLogin('anthropic'), beforeActive);
      assert.deepEqual(configValues(store), beforeConfig);
      assert.deepEqual(
        (db(store).prepare('SELECT account_id, last_active_at FROM claude_slots ORDER BY account_id').all() as object[]).map((row) => ({ ...row })),
        [{ account_id: 'from', last_active_at: null }, { account_id: 'to', last_active_at: null }],
      );
    } finally {
      store.close();
    }
  });

  it('recordClaudeSwitchRefusal writes one refused row with the reason and attempt and no other change', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      const beforeConfig = configValues(store);
      const id = store.recordClaudeSwitchRefusal({
        from: 'from', to: 'to', trigger: 'manual', reason: 'target-missing', injected: true, attempt: 'refused-attempt', now: 1_100,
      });
      assert.equal(id, 1);
      assert.deepEqual(
        { ...(db(store).prepare('SELECT provider, from_account, to_account, trigger, outcome, detail, steps_json, injected, committed_at FROM switch_log').get() as object) },
        {
          provider: 'anthropic', from_account: 'from', to_account: 'to', trigger: 'manual', outcome: 'refused',
          detail: 'target-missing', steps_json: '{"attempt":"refused-attempt"}', injected: 1, committed_at: null,
        },
      );
      assert.equal(store.getActiveLogin('anthropic'), null);
      assert.deepEqual(configValues(store), beforeConfig);
      assert.deepEqual(
        (db(store).prepare('SELECT account_id, last_active_at FROM claude_slots ORDER BY account_id').all() as object[]).map((row) => ({ ...row })),
        [{ account_id: 'from', last_active_at: null }, { account_id: 'to', last_active_at: null }],
      );
    } finally {
      store.close();
    }
  });

  it('recordClaudeSwitchRefusal round-trips active-login-unset with a null from account and its injected timestamp', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      store.recordClaudeSwitchRefusal({
        from: null, to: 'to', trigger: 'manual', reason: 'active-login-unset', injected: false, attempt: 'unset-attempt', now: 1_234,
      });
      assert.deepEqual(
        { ...(db(store).prepare('SELECT from_account, to_account, detail, ts FROM switch_log').get() as object) },
        { from_account: null, to_account: 'to', detail: 'active-login-unset', ts: 1_234 },
      );
    } finally {
      store.close();
    }
  });

  it('findCommittedSwitchByAttempt finds the committed row and returns null for an unknown attempt', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      const id = store.commitClaudeSwitch(input());
      assert.deepEqual(store.findCommittedSwitchByAttempt('anthropic', 'attempt-1'), {
        id, ts: 1_000, provider: 'anthropic', fromAccount: 'from', toAccount: 'to', trigger: 'proactive', outcome: 'ok',
        detail: 'fixture detail', stepsJson: '{"started":[6,7,8],"attempt":"attempt-1"}', openSessionsJson: null,
        publishedAt: 900, committedAt: 1_000,
      });
      assert.equal(store.findCommittedSwitchByAttempt('anthropic', 'unknown'), null);
    } finally {
      store.close();
    }
  });

  it('a refused row and a rolled-back row carrying the attempt are not found (null) while a committed row with the same attempt is', () => {
    const store = openClaudeStore();
    try {
      insertSlots(store);
      store.recordClaudeSwitchRefusal({
        from: 'from', to: 'to', trigger: 'manual', reason: 'refused', injected: false, attempt: 'refused-only', now: 2_100,
      });
      store.recordSwitch({
        ts: 2_000, provider: 'anthropic', fromAccount: 'from', toAccount: 'to', trigger: 'manual', outcome: 'rolled-back',
        stepsJson: JSON.stringify({ attempt: 'rolled-back-only' }),
      });
      assert.equal(store.findCommittedSwitchByAttempt('anthropic', 'refused-only'), null);
      assert.equal(store.findCommittedSwitchByAttempt('anthropic', 'rolled-back-only'), null);

      const id = store.commitClaudeSwitch(input());
      store.recordClaudeSwitchRefusal({
        from: 'from', to: 'to', trigger: 'manual', reason: 'later refusal', injected: false, attempt: 'attempt-1', now: 3_100,
      });
      store.recordSwitch({
        ts: 3_000, provider: 'anthropic', fromAccount: 'from', toAccount: 'to', trigger: 'manual', outcome: 'rolled-back',
        stepsJson: JSON.stringify({ attempt: 'attempt-1' }),
      });
      assert.deepEqual(store.findCommittedSwitchByAttempt('anthropic', 'attempt-1'), {
        id, ts: 1_000, provider: 'anthropic', fromAccount: 'from', toAccount: 'to', trigger: 'proactive', outcome: 'ok',
        detail: 'fixture detail', stepsJson: '{"started":[6,7,8],"attempt":"attempt-1"}', openSessionsJson: null,
        publishedAt: 900, committedAt: 1_000,
      });
    } finally {
      store.close();
    }
  });
});
