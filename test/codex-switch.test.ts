import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  checkCodexSwitchPreconditions,
  preflightCodexLive,
  type CodexSwitchDeps,
} from '../src/codex-switch';
import { openStore } from '../src/store';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-switch-'));
  const stashDir = join(root, 'stash');
  mkdirSync(stashDir);
  const store = openStore(join(root, 'qlb.db'));
  const db = (store as unknown as { db: DatabaseSync }).db;
  const deps = (overrides: Partial<CodexSwitchDeps> = {}): CodexSwitchDeps => ({
    store,
    readLive: async () => ({ status: 'ok', doc: {} as never, sha256: 'sha256-file:fixture', inode: 1 }),
    cswapProcesses: () => [],
    now: () => 1_700_000_000_000,
    attempt: 'attempt-fixture',
    ...overrides,
  });
  return { root, stashDir, store, db, deps };
}

function insertSlot(db: DatabaseSync, accountId: string, options: { dead?: boolean; pendingAdopt?: boolean } = {}): void {
  const separator = accountId.indexOf(':');
  db.prepare(`INSERT INTO codex_slots (
    account_id, chatgpt_user_id, chatgpt_account_id, fingerprint, prev_fingerprint,
    dead, pending_adopt, added_at, source
  ) VALUES (?, ?, ?, 'fingerprint', NULL, ?, ?, 1, 'fixture')`).run(
    accountId,
    separator === -1 ? accountId : accountId.slice(0, separator),
    separator === -1 ? accountId : accountId.slice(separator + 1),
    options.dead ? 1 : 0,
    options.pendingAdopt ? 1 : 0,
  );
}

function switchRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return (db.prepare(`SELECT provider, from_account, to_account, trigger, outcome, detail, steps_json, published_at
    FROM switch_log ORDER BY id`).all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
}

describe('Codex switch preflight and preconditions', () => {
  it('refuses a missing, dead or pending-adopt target with one refused row', () => {
    const h = fixture();
    try {
      h.store.setActiveLogin('openai-codex', 'from:account', 'import');
      insertSlot(h.db, 'dead:account', { dead: true });
      insertSlot(h.db, 'pending:account', { pendingAdopt: true });

      const cases = [
        ['missing:account', 'target-missing'],
        ['dead:account', 'target-dead'],
        ['pending:account', 'target-pending-adopt'],
      ] as const;
      for (const [target, reason] of cases) {
        const result = checkCodexSwitchPreconditions(h.deps(), { target, trigger: 'manual' });
        assert.equal(result.kind, 'refused');
        if (result.kind === 'refused') assert.equal(result.reason, reason);
      }

      assert.deepEqual(switchRows(h.db), cases.map(([target, reason]) => ({
        provider: 'openai-codex', from_account: 'from:account', to_account: target,
        trigger: 'manual', outcome: 'refused', detail: reason,
        steps_json: JSON.stringify({ attempt: 'attempt-fixture', via: 'switch' }), published_at: null,
      })));
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('refuses when a C-swap process is alive or the process table cannot be read', () => {
    const h = fixture();
    try {
      insertSlot(h.db, 'target:account');
      const alive = checkCodexSwitchPreconditions(h.deps({ cswapProcesses: () => [{ pid: 1 }] }), {
        target: 'target:account', trigger: 'manual',
      });
      const unreadable = checkCodexSwitchPreconditions(h.deps({ cswapProcesses: () => { throw new Error('fixture'); } }), {
        target: 'target:account', trigger: 'manual',
      });
      assert.deepEqual([alive, unreadable].map((result) => result.kind === 'refused' ? result.reason : result.kind), [
        'cswap-process-alive', 'cswap-process-check-failed',
      ]);
      assert.deepEqual(switchRows(h.db).map((row) => row.detail), ['cswap-process-alive', 'cswap-process-check-failed']);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('an automatic trigger without codex.l13VerifiedAt is refused codex-l13-unverified', () => {
    const h = fixture();
    try {
      insertSlot(h.db, 'target:account');
      const result = checkCodexSwitchPreconditions(h.deps(), { target: 'target:account', trigger: 'proactive' });
      assert.deepEqual(result.kind === 'refused' ? result.reason : result.kind, 'codex-l13-unverified');
      assert.deepEqual(switchRows(h.db).map((row) => row.detail), ['codex-l13-unverified']);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('a manual trigger does not need the l13 receipt', () => {
    const h = fixture();
    try {
      insertSlot(h.db, 'target:account');
      assert.deepEqual(checkCodexSwitchPreconditions(h.deps(), { target: 'target:account', trigger: 'manual' }), { kind: 'go' });
      assert.equal(switchRows(h.db).length, 0);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('preflight writes nothing for a missing or unreadable file', async () => {
    const h = fixture();
    try {
      h.store.setConfig('fixture.config', 'unchanged');
      const configBefore = h.db.prepare('SELECT key, value FROM config ORDER BY key').all();
      const rowsBefore = switchRows(h.db);
      const stashBefore = readdirSync(h.stashDir);

      assert.deepEqual(await preflightCodexLive(h.deps({ readLive: async () => ({ status: 'missing' }) })), {
        kind: 'refused', reason: 'codex-logged-out', write: false,
      });
      assert.deepEqual(await preflightCodexLive(h.deps({ readLive: async () => ({ status: 'unreadable', code: 'EACCES' }) })), {
        kind: 'refused', reason: 'codex-auth-unreadable', write: false,
      });
      assert.deepEqual(switchRows(h.db), rowsBefore);
      assert.deepEqual(h.db.prepare('SELECT key, value FROM config ORDER BY key').all(), configBefore);
      assert.deepEqual(readdirSync(h.stashDir), stashBefore);
    } finally {
      h.store.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});
